/**
 * TRAE **自定义 SSE** → 归一化流事件（`StreamEvent`）的转换。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae.ts`
 * （`parseTraeSSELine` / `buildOpenAIChunk`）与 `trae-adapter.ts` 的 `consumeSse`。
 *
 * ## 上游事件格式（非 OpenAI 标准）
 *
 * ```
 * event:output
 * data:{"response":"<增量>","reasoning_content":"<思考增量>","tool_calls":<null|数组>}
 *
 * event:token_usage
 * data:{"prompt_tokens":21,"completion_tokens":142,...}
 *
 * event:done
 * data:{"finish_reason":"stop"}
 *
 * event:error
 * data:{"code":4008,"message":"quota exceeded"}
 * ```
 *
 * ⚠️ 还有 `metadata` / `timing_cost` / `extra_info` 这些事件，本模块**不消费**
 * 但**必须认**（见下面 `sawAnyUpstreamEvent` 的说明）。
 *
 * ## ⚠️ 本模块存在的核心理由：**自己攒完整正文**
 *
 * 我们插件曾有一个真实缺陷：**流式正文被冲掉**。根因是 DSH 宿主
 * `BlockAssembler` 对 `block-end` 的处理是**覆盖式赋值**（`partial.block = chunk.block`），
 * 不是「关闭信号」——传空串会把之前所有 `text-delta` 整个丢掉。症状是
 * 「流式有字，一调工具 / 一收尾就变空」。
 *
 * 因此本模块的纪律是：
 *
 * 1. **文本与思维链各攒一份完整缓冲**（{@link TraeSseConverter.text} /
 *    {@link TraeSseConverter.reasoning}）—— 收尾时能拿到**完整正文**，
 *    不依赖任何「增量拼接的语义边界」；
 * 2. **正文、思维链、工具调用三者互不冲掉**：同一帧里可能同时带
 *    `response` + `reasoning_content` + `tool_calls`（参考实现实测确认），
 *    所以分发用 `if` 守卫、**不用 `continue`**（参考实现踩过：一个 `continue`
 *    把同帧的 `tool_calls` 吞了）；
 * 3. **每个事件都如实透出**，不做「只发最后一段」之类的优化 ——
 *    消费端看到的增量序列与上游一致。
 */

import {
  readNumberField,
  readStringField,
} from './trae-identity.js'
import type { StreamEvent, TokenUsage } from '../../core/types.js'

/** SOLO SSE 事件类型。 */
export type TraeSSEEventType =
  | 'metadata'
  | 'timing_cost'
  | 'output'
  | 'extra_info'
  | 'token_usage'
  | 'done'
  | 'error'

/** 解析后的单条 SOLO 事件。 */
export interface TraeSSEEvent {
  event: TraeSSEEventType | string
  /** 正文增量（`response`）。 */
  response?: string
  /** 思考增量（`reasoning_content`）。 */
  reasoningContent?: string
  /** 工具调用（数组，元素已归一化 `function_call` → `function`）。 */
  toolCalls?: unknown[]
  /** `token_usage` 事件的原始载荷。 */
  usage?: Record<string, unknown>
  /** `done` 事件的 `finish_reason`。 */
  finishReason?: string
  /** `error` 事件的业务码。 */
  errorCode?: number
  /** `error` 事件的文案。 */
  errorMessage?: string
}

/**
 * 归一化 SOLO `tool_calls` 的字段。
 *
 * 上游在流里给的是 `function_call` 形态，而我们的下游统一用 `function`
 * （OpenAI 形态）；同时清掉 SOLO 专属字段（`namespace` / `partial_arguments`，
 * 上游用来做增量拼接的内部字段，透出去没有意义）。
 */
export function normalizeTraeToolCalls(calls: readonly unknown[]): unknown[] {
  return calls.map((call) => {
    if (typeof call !== 'object' || call === null) return call
    const c = { ...(call as Record<string, unknown>) }
    // function_call → function
    if (typeof c.function_call === 'object' && c.function_call !== null) {
      c.function = { ...(c.function_call as Record<string, unknown>) }
      delete c.function_call
    }
    // 清理 SOLO 专属字段
    if (typeof c.function === 'object' && c.function !== null) {
      const fn = c.function as Record<string, unknown>
      delete fn.namespace
      delete fn.partial_arguments
    }
    return c
  })
}

/**
 * 解析一条 SOLO 事件（`event:` 行的值 + `data:` 行的 JSON）。
 *
 * ⚠️ **JSON 解析失败时不丢掉事件本身**：返回 `{ event }`（只有类型、没有载荷）。
 * 这样调用方仍能知道「上游确实开工了」，而不是把一个坏 JSON 当成「流没开始」。
 */
export function parseTraeSSELine(eventName: string, dataLine: string): TraeSSEEvent | undefined {
  const event = eventName.trim()
  if (event.length === 0) return undefined
  if (dataLine.length === 0) return { event }

  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(dataLine)
    if (typeof parsed !== 'object' || parsed === null) return { event }
    raw = parsed as Record<string, unknown>
  } catch {
    return { event }
  }

  const ev: TraeSSEEvent = { event }
  switch (event) {
    case 'output':
      if (typeof raw.response === 'string') ev.response = raw.response
      if (typeof raw.reasoning_content === 'string') ev.reasoningContent = raw.reasoning_content
      if (Array.isArray(raw.tool_calls)) ev.toolCalls = normalizeTraeToolCalls(raw.tool_calls)
      break
    case 'token_usage':
      ev.usage = raw
      break
    case 'done':
      if (typeof raw.finish_reason === 'string') ev.finishReason = raw.finish_reason
      break
    case 'error':
      if (typeof raw.code === 'number') ev.errorCode = raw.code
      if (typeof raw.message === 'string') ev.errorMessage = raw.message
      break
    default:
      break
  }
  return ev
}

/**
 * SOLO 流内错误码 → 该不该换账号重试。
 *
 * ⚠️ 上游**确实**用 HTTP 200 + 流内 `event:error` 下发额度 / 限流错误
 * （参考实现实测 `4001 param is invalid`）。只在 `!response.ok` 的分支里做
 * 换号是不够的 —— 那些错误走的是流内路径，不处理就表现为「不会切换账号」。
 *
 * ⚠️ **只在尚未产出任何内容时才允许换号重发**：已经吐了一半再重放会让上游
 * **重复计费并可能重复执行工具**。
 */
export function isRotatableTraeStreamError(code: number): boolean {
  return code === 1005 || code === 4008 || code === 4011
}

/**
 * 流内错误码 → 归一化 `ErrorKind`。
 *
 * | 码 | 含义 | 归类 |
 * |---|---|---|
 * | 1005 | Plan 权益不足 | `quota`（换号） |
 * | 4008 | `ide_credits` 耗尽 | `quota`（换号） |
 * | 4011 | 频率超限 | `rate_limit`（换号） |
 * | 4001 | `param is invalid`（模型不可调用 / 通道发错） | `bad_request`（**不换号**：换账号也是同一模型被拒） |
 * | 4023 | `the model is unknown` | `bad_request`（同上） |
 * | 3003 | model service unavailable | `server`（可重试） |
 * | 其它 | —— | `unknown` |
 */
export function classifyTraeStreamError(code: number): 'quota' | 'rate_limit' | 'bad_request' | 'server' | 'unknown' {
  switch (code) {
    case 1005:
    case 4008:
      return 'quota'
    case 4011:
      return 'rate_limit'
    // ⚠️ 4001 / 4023 刻意归 `bad_request` 而**不是** `auth`/`quota`：
    // 核心层对 `bad_request` 的语义是「换账号也一样错」，正合这里的实情。
    case 4001:
    case 4023:
      return 'bad_request'
    case 3003:
      return 'server'
    default:
      return 'unknown'
  }
}

/** 工具调用累加状态。 */
interface ToolCallState {
  /** 上游给的 wire index（= 我们 StreamEvent 的 `index`）。 */
  wireIndex: number
  /** 已累积的 arguments 片段。 */
  args: string
  /** 工具 id（上游通常只在首帧给）。 */
  id?: string
  /** 工具名（可能分帧到达）。 */
  name?: string
  /**
   * 是否已发过首个事件。
   *
   * ⚠️ **名称为空前不发任何事件**：DSH 的 `BlockAssembler` 会把没有 `block-end`
   * 的 partial 也组装成 `name:''`，污染会话后让下游端点以 400 拒绝请求。
   * 只跳过收尾的 `block-end` 是不够的 —— 必须从一开始就不发 `block-start`。
   */
  announced: boolean
}

/** 工具名是否可用（非空、非纯空白）。 */
function hasUsableToolName(name: string | undefined): name is string {
  return typeof name === 'string' && name.trim().length > 0
}

/**
 * 有状态的 SOLO SSE 转换器。
 *
 * 用法：把上游 SSE 的**每一行**喂给 {@link feedLine}，取出它返回的事件；
 * 流结束后调 {@link finish}。全程可单测（不需要网络、不需要 mock Response）。
 *
 * ```ts
 * const conv = new TraeSseConverter()
 * for (const line of lines) for (const ev of conv.feedLine(line)) yield ev
 * yield* conv.finish()
 * assert.equal(conv.text, '完整正文')   // ← 回归用例断言的就是这一条
 * ```
 */
export class TraeSseConverter {
  /** 正文完整缓冲。**收尾时用的就是它**，不是「最后一段增量」。 */
  private textBuf = ''
  /** 思维链完整缓冲。与 `textBuf` 独立，互不冲掉。 */
  private reasoningBuf = ''
  /** 跨行累积的 `event:` / `data:`。 */
  private currentEvent = ''
  private currentData = ''
  private readonly toolCalls = new Map<number, ToolCallState>()
  /** 工具块的下标分配器（按首次出现顺序）。 */
  private nextToolIndex = 0
  /**
   * 是否收到过**任何可解析的上游事件**。
   *
   * ⚠️ 上游有时会「会话创建成功、HTTP 200、然后一个事件都不发就结束流」。
   * 这不是「模型决定不说话」而是可重试的瞬时故障，适配器据此如实报错
   * （而不是给用户一个「回复为空」的死胡同）。
   */
  private sawAnyUpstreamEvent = false
  /** 上游 `done` 事件给的终止原因。 */
  private upstreamFinishReason: string | undefined
  /** 是否已收到终止信号（`done` / `error`）。 */
  private ended = false

  /** 完整正文（截至当前已累积的全部文本）。 */
  get text(): string {
    return this.textBuf
  }

  /** 完整思维链。 */
  get reasoning(): string {
    return this.reasoningBuf
  }

  /** 上游是否已经开工（收到过任何可解析事件）。 */
  get sawUpstreamEvent(): boolean {
    return this.sawAnyUpstreamEvent
  }

  /** 是否已有任何用户可见产出（正文 / 思维链 / 已宣告的工具调用）。 */
  get hasProducedOutput(): boolean {
    if (this.textBuf.length > 0 || this.reasoningBuf.length > 0) return true
    for (const state of this.toolCalls.values()) {
      if (state.announced) return true
    }
    return false
  }

  /** 流是否已被终止事件结束。 */
  get isEnded(): boolean {
    return this.ended
  }

  /** 上游给的 finish_reason（缺省 undefined，由调用方决定兜底值）。 */
  get finishReason(): string | undefined {
    return this.upstreamFinishReason
  }

  /**
   * 喂一行 SSE 文本，返回本次解析出的事件（可能 0 到多个）。
   *
   * 行尾的 `\r` 会被容忍（不同上游的行尾不一样）。
   */
  feedLine(rawLine: string): StreamEvent[] {
    const line = rawLine.replace(/\r$/, '')

    // 空行 = 事件分隔符 → 解析累积的 event + data。
    if (line.trim().length === 0) {
      return this.flushEvent()
    }

    const trimmed = line.trim()
    if (trimmed.startsWith('event:')) {
      this.currentEvent = trimmed.slice(6).trim()
      return []
    }
    if (trimmed.startsWith('data:')) {
      // ⚠️ **累积而不是覆盖**：SOLO 的 data 可能跨行拼接
      // （参考实现用 `+=`，覆盖会丢掉前半段 JSON → 整条事件解析失败）。
      this.currentData += trimmed.slice(5)
      return []
    }
    // 注释行（":" 开头）与其他未知行：忽略。
    return []
  }

  /** 流结束时把残留在缓冲里的最后一条事件也吐出来（有的上游不发尾随空行）。 */
  flushPending(): StreamEvent[] {
    return this.flushEvent()
  }

  /**
   * 收尾：发 `finish`（若上游没给就补一个 `stop`）。
   *
   * ⚠️ 即使上游一个事件都没发，也**照常发 finish** —— 是否要报错由适配器
   * 依据 {@link sawUpstreamEvent} 决定。把「空响应」的判定与流的收尾解耦，
   * 是为了让适配器能明确区分「空响应（可重试）」与「模型正常空回复」。
   */
  finish(): StreamEvent[] {
    const events = this.flushEvent()
    if (!this.ended) {
      this.ended = true
      events.push({ type: 'finish', reason: this.upstreamFinishReason ?? 'stop' })
    }
    return events
  }

  /** 解析当前累积的 event + data，并分发。 */
  private flushEvent(): StreamEvent[] {
    if (this.currentEvent.length === 0) {
      // 只有 data 没有 event 的块：上游没声明类型，无法解释，丢弃。
      this.currentData = ''
      return []
    }
    const ev = parseTraeSSELine(this.currentEvent, this.currentData)
    this.currentEvent = ''
    this.currentData = ''
    if (ev === undefined) return []
    // 任何**可解析**的上游事件（含 metadata / timing_cost）都算「上游确实开工了」。
    this.sawAnyUpstreamEvent = true
    return this.dispatch(ev)
  }

  /** 把一条解析后的事件翻译成零到多个 `StreamEvent`。 */
  private dispatch(ev: TraeSSEEvent): StreamEvent[] {
    switch (ev.event) {
      case 'output':
        return this.dispatchOutput(ev)
      case 'token_usage': {
        if (ev.usage === undefined) return []
        return [{ type: 'usage', usage: normalizeTraeUsage(ev.usage) }]
      }
      case 'done': {
        if (ev.finishReason !== undefined) this.upstreamFinishReason = ev.finishReason
        this.ended = true
        // ⚠️ 这里**不**直接发 `finish`：`done` 之前可能还有同批次的
        // `token_usage`，且适配器需要在发出 finish 前把完整正文交给消费端。
        // 统一由 `finish()` 发，避免同一条流出现两个 finish 事件。
        return []
      }
      case 'error': {
        this.ended = true
        const code = ev.errorCode ?? -1
        const message = ev.errorMessage ?? 'unknown error'
        return [{
          type: 'error',
          failure: {
            kind: classifyTraeStreamError(code),
            message: `TRAE 流内错误（code=${code}）：${message}`,
            at: Date.now(),
          },
        }]
      }
      default:
        // `metadata` / `timing_cost` / `extra_info`：不消费，但**认**它们
        // （已经记进 `sawAnyUpstreamEvent`，见 `flushEvent`）。
        return []
    }
  }

  /**
   * 分发 `output` 事件。
   *
   * ⚠️⚠️ **本方法是「正文被冲掉」那个缺陷的正面防线**，三条纪律：
   *
   * 1. **三个分支都用 `if` 守卫，不用 `continue`** —— 参考实现踩过这个坑：
   *    一个 `continue` 会跳过同帧位于其后分支的处理，而**同一帧确实可能同时
   *    携带 `response` + `reasoning_content` + `tool_calls`**（实测复现），
   *    于是工具调用被静默吞掉；
   * 2. **正文与思维链各进各的缓冲**，互不覆盖；
   * 3. **工具调用不因为正文/思维链的存在而被跳过**（反之亦然）。
   */
  private dispatchOutput(ev: TraeSSEEvent): StreamEvent[] {
    const out: StreamEvent[] = []

    // ① 正文增量
    const response = ev.response
    if (response !== undefined && response.length > 0) {
      this.textBuf += response
      out.push({ type: 'text', text: response })
    }

    // ② 思考增量（与正文**独立**累积，绝不互相赋值）
    const reasoning = ev.reasoningContent
    if (reasoning !== undefined && reasoning.length > 0) {
      this.reasoningBuf += reasoning
      out.push({ type: 'reasoning', text: reasoning })
    }

    // ③ 工具调用（与上两者**共存**：不因已产出正文就丢弃工具）
    if (ev.toolCalls !== undefined && ev.toolCalls.length > 0) {
      out.push(...this.dispatchToolCalls(ev.toolCalls))
    }

    return out
  }

  /** 分发工具调用增量。 */
  private dispatchToolCalls(calls: readonly unknown[]): StreamEvent[] {
    const out: StreamEvent[] = []
    for (const call of calls) {
      if (typeof call !== 'object' || call === null) continue
      const c = call as Record<string, unknown>
      const wireIndex = readNumberField(c, 'index') ?? this.nextToolIndex
      let state = this.toolCalls.get(wireIndex)
      if (state === undefined) {
        state = { wireIndex, args: '', announced: false }
        this.toolCalls.set(wireIndex, state)
        this.nextToolIndex = Math.max(this.nextToolIndex, wireIndex + 1)
      }
      // id 通常只在首帧给 —— 记下来，之后每帧都带上（下游的 id 是覆盖式赋值，
      // 少发一帧就会把真 id 冲掉）。
      const id = readStringField(c, 'id')
      if (id.length > 0) state.id = id
      const fn = typeof c.function === 'object' && c.function !== null
        ? (c.function as Record<string, unknown>)
        : undefined
      const name = fn === undefined ? '' : readStringField(fn, 'name')
      if (name.length > 0) state.name = name
      const fragment = fn === undefined ? '' : readStringField(fn, 'arguments')
      state.args += fragment

      if (!state.announced) {
        // ⚠️ 名称为空前**不发任何事件**（见 `ToolCallState.announced` 的说明）。
        if (!hasUsableToolName(state.name)) continue
        state.announced = true
        // 首帧把所有已累积的 arguments 一次发出（它们可能已经在名字到达前攒下了）。
        out.push({
          type: 'tool_call',
          index: state.wireIndex,
          ...(state.id === undefined ? {} : { id: state.id }),
          name: state.name,
          argumentsDelta: state.args,
        })
        continue
      }

      out.push({
        type: 'tool_call',
        index: state.wireIndex,
        ...(state.id === undefined ? {} : { id: state.id }),
        ...(state.name === undefined ? {} : { name: state.name }),
        argumentsDelta: fragment,
      })
    }
    return out
  }
}

/**
 * `token_usage` 载荷 → 归一化 `TokenUsage`。
 *
 * ⚠️ `reasoning_tokens` **计入** `completion_tokens`（参考实现记录）——
 * 所以不要把两者相加，否则输出 token 会被算多一遍。
 */
export function normalizeTraeUsage(raw: Record<string, unknown>): TokenUsage {
  const promptTokens = readNumberField(raw, 'prompt_tokens') ?? 0
  const completionTokens = readNumberField(raw, 'completion_tokens') ?? 0
  const reasoningTokens = readNumberField(raw, 'reasoning_tokens')
  const usage: TokenUsage = {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
  }
  if (promptTokens + completionTokens > 0) usage.totalTokens = promptTokens + completionTokens
  if (reasoningTokens !== undefined && reasoningTokens > 0) usage.reasoningTokens = reasoningTokens
  const cached = readNumberField(raw, 'cached_tokens') ?? readNumberField(raw, 'prompt_cache_hit_tokens')
  if (cached !== undefined && cached > 0) usage.cacheReadTokens = cached
  return usage
}

/**
 * 把一整个 SOLO SSE 行序列聚合成一份结果（**非流式 / 校验用**）。
 *
 * 这是 {@link TraeSseConverter} 的一层薄封装：同一条解析路径，
 * 因此「聚合出来的正文」与「流式透出的正文」必然一致 ——
 * 这正是「正文被冲掉」那条回归要证明的东西。
 */
export interface TraeAggregatedResult {
  content: string
  reasoningContent: string
  toolCalls: StreamEvent[]
  finishReason: string
  usage: TokenUsage | undefined
  error?: { kind: string; message: string }
}

/**
 * 聚合一个完整的 SOLO SSE。
 *
 * @param lines SOLO SSE 的事件行序列
 */
export function aggregateTraeSSE(lines: readonly string[]): TraeAggregatedResult {
  const converter = new TraeSseConverter()
  const toolCalls: StreamEvent[] = []
  let usage: TokenUsage | undefined
  let error: { kind: string; message: string } | undefined

  for (const line of lines) {
    for (const event of converter.feedLine(line)) {
      if (event.type === 'usage') usage = event.usage
      else if (event.type === 'tool_call') toolCalls.push(event)
      else if (event.type === 'error') error = { kind: event.failure.kind, message: event.failure.message }
    }
  }
  for (const event of converter.finish()) {
    if (event.type === 'usage') usage = event.usage
    else if (event.type === 'tool_call') toolCalls.push(event)
    else if (event.type === 'error') error = { kind: event.failure.kind, message: event.failure.message }
  }

  return {
    content: converter.text,
    reasoningContent: converter.reasoning,
    toolCalls,
    finishReason: converter.finishReason ?? 'stop',
    usage,
    ...(error === undefined ? {} : { error }),
  }
}

/**
 * 把 SSE 行序列变成 `StreamEvent` 异步迭代器（**测试与离线回放用**）。
 *
 * 生产路径走的是 `Response.body` 的字节流（见适配器），但两者共用
 * {@link TraeSseConverter}，语义完全一致。
 */
export function* convertTraeSseLines(lines: readonly string[]): Iterable<StreamEvent> {
  const converter = new TraeSseConverter()
  for (const line of lines) {
    for (const event of converter.feedLine(line)) yield event
  }
  for (const event of converter.finish()) yield event
}
