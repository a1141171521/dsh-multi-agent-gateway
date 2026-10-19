/**
 * DSH 插件的 **LLM 适配器**（Provider 侧）。
 *
 * 这是「模型分组 + 倍率标签必须作用在 DSH 对话框原生模型下拉选择器」这条
 * 硬要求的落点。实现依据是 DSH 的真实契约（`@deepseek-ai/dsh-llm` +
 * `dsh-api-session-controller/lib/types/catalog.js` 的 `buildModelCatalog()`）：
 *
 * ```ts
 * // 宿主把每个已注册 provider 变成一个分组：
 * { id: provider.id, name: provider.name, models: [{ id, name, description, reasoning }] }
 * // 客户端 ui-model-selection 用 MenuGroup(label = group.name) 渲染分组标题，
 * // 用 model.name 渲染每一行。
 * ```
 *
 * 所以：
 *
 *   - **分组** = 一个 Agent 注册一个 provider 路由（`multiagent-opencode` …），
 *     `providerInfo().name` 就是分组标题（`OpenCode` / `Qoder` / …）。
 *   - **倍率标签** = 行标签走 `LlmModelInfo.name`，格式 `<Agent> · <模型> (×N)`，
 *     与任务书给的示例 `OpenCode · DeepSeek-R1 (×2)` 完全一致。
 *
 * 三个必须小心的点（踩了就是「模型列表空着」）：
 *   1. `listModels()` **必须**实现 —— 基类默认返回空数组，GUI 就不给选；
 *   2. `resolveModel()` 里 `provider`/`id` 必须与请求的**完全一致**，否则
 *      `normalizeModelInfo` 会抛 `INVALID_MODEL_INFO`；
 *   3. 一个 provider 路由只能有一个 adapter（重复注册抛 `DUPLICATE_ADAPTER`），
 *      所以「未启用的 Agent」干脆不注册那条路由，而不是注册一个空 adapter。
 */

import { formatMultiplier } from '../core/types.js'
import {
  CANONICAL_REASONING_EFFORTS,
  defaultReasoningEffortFor,
  reasoningEffortName,
  reasoningEffortsForDeclared,
  translateReasoningEffort,
} from '../core/reasoning.js'
import type { AccountRecord, AdapterContext, AgentAdapter, ModelMeta, TokenUsage } from '../core/types.js'
import { computeTps } from '../core/request-log.js'
import type { RequestLogEntry } from '../core/request-log.js'
import type { AccountManager } from '../core/accounts.js'
import type { AccountRouter } from '../core/router.js'

// ───────────────────────── DSH 侧类型（结构化声明，不 import 宿主包） ─────────────────────────
//
// 为什么不 `import type { LlmAdapter } from '@deepseek-ai/dsh-llm'`：
// 插件的 `peerDependencies` 里没有也不该有它 —— `dsh-llm` 是宿主自带包，
// 插件运行时拿到的是**宿主那一份实例**。用结构化声明，接口形状对得上即可，
// 版本漂移也不会在装载期变成 `ERR_MODULE_NOT_FOUND`。

/** `LlmProviderInfo`。 */
export interface DshProviderInfo {
  id: string
  name: string
}

/** `LlmModelInfo`（`name` 就是选择器里那行字）。 */
export interface DshModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: string[]
}

/** `LlmResolvedModelInfo`。 */
export interface DshResolvedModelInfo extends DshModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

/** `LlmFailure`。 */
export interface DshFailure {
  message: string
  code: string
  status?: number
  providerRetryAfterMs?: number
  requestId?: string
}

/** `StreamChunk`（联合类型，这里用宽形状即可）。 */
export type DshStreamChunk = Record<string, unknown> & { type: string }

/** 宿主传进来的 `GenerateOptions`（只声明我们读的字段）。 */
export interface DshGenerateOptions {
  provider: string
  model: string
  messages: Array<{ role: string; content?: unknown; [key: string]: unknown }>
  system?: string
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  reasoningEffort?: string
}

/** 创建 LLM 适配器需要的依赖。 */
export interface LlmAdapterDeps {
  /** 该路由对应的 agentId（`multiagent-opencode` → `opencode`）。 */
  agentId: string
  /** 分组标题。也接受**取值函数** —— 配置热更新后分组名可能变了。 */
  displayName: string | (() => string)
  /**
   * 是否在模型名里带 `<Agent> · ` 前缀。
   *
   * 同样接受取值函数：适配器实例是**注册时**建好的，捕获一个布尔值就再也读不到
   * 新配置（实测踩到过 —— 在设置页关掉「带前缀」，下拉里名字纹丝不动）。
   */
  labelWithAgent: boolean | (() => boolean)
  accounts: AccountManager
  router: AccountRouter
  /** 取适配器 + 它的运行上下文。 */
  adapterOf(agentId: string): AgentAdapter | undefined
  contextOf(agentId: string): AdapterContext | undefined
  /** 取（可能有缓存的）模型元数据。 */
  modelsOf(agentId: string, force?: boolean): Promise<ModelMeta[]>
  /**
   * **要暴露给 DSH 的**模型（已按「勾选/免费/全部」策略过滤）。
   *
   * 选择器读的是这个，不是 `modelsOf` —— 否则上游几十个模型会全塞进下拉里。
   * 可选：只给了 `modelsOf` 的调用方退化成「不过滤」（保持老行为，不炸）。
   */
  exposedModelsOf?(agentId: string, force?: boolean): Promise<ModelMeta[]>
  /**
   * 一次对话结束时的采样回调（成功与失败都会调，**只调一次**）。
   *
   * 宿主把它接到 `RequestLog` 上，就是「日志」页与总览 KPI 的数据来源。
   * 刻意做成可选：没有这个回调时适配器行为一个字节都不变。
   */
  onRequest?(sample: Omit<RequestLogEntry, 'ts'>): void
  log: AdapterContext['log']
}

/**
 * 把 `ModelMeta` 渲染成 DSH 选择器里的行标签。
 *
 * 任务书给的格式：`OpenCode · DeepSeek-R1 (×2)`。
 * 倍率取不到时显示什么，是**要不要骗用户**的分界线 —— 这里显示「未知倍率」，
 * 既不省略（省略看不出差别）也不编造。
 */
export function renderModelLabel(meta: ModelMeta, withAgentPrefix: boolean): string {
  const tag = formatMultiplier(meta.multiplier, meta.free)
  const head = withAgentPrefix ? `${meta.agentName} · ${meta.name}` : meta.name
  return `${head} (${tag})`
}

/**
 * 模型元数据 → DSH 模型列表项。
 *
 * `id` 里带 `agentId` 前缀是**刻意的**：同一分组下不同 Agent 不会重名，
 * 而将来若把多个 Agent 合到一个 provider 路由里，id 仍然唯一。
 * `stream()` 里按同样规则反解回 (agentId, upstreamModelId)。
 */
export function encodeModelId(agentId: string, upstreamId: string): string {
  return `${agentId}/${upstreamId}`
}

/** 拆回 `(agentId, upstreamModelId)`。 */
export function decodeModelId(encoded: string): { agentId: string; upstreamId: string } {
  const index = encoded.indexOf('/')
  if (index < 0) return { agentId: '', upstreamId: encoded }
  return { agentId: encoded.slice(0, index), upstreamId: encoded.slice(index + 1) }
}

/**
 * 造一个 DSH `LlmAdapter`。
 *
 * 不继承宿主的 `LlmAdapter` 抽象类：宿主用的是**鸭子类型**（它只读
 * `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream`），
 * 继承反而要 import 宿主包。结构化实现更不容易被版本漂移打断。
 */
export function createLlmAdapter(deps: LlmAdapterDeps): {
  providerInfo(provider: string): DshProviderInfo
  listModels(provider: string): Promise<DshModelInfo[]>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<DshResolvedModelInfo>
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: DshResolvedModelInfo
    stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>
  }>
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>
  providerRetryPolicy(): { mode: 'normal'; maxRetries: number; retryableCodes: string[]; initialDelayMs: number; maxDelayMs: number; jitterRatio: number }
} {
  const { agentId, accounts, router, log } = deps
  /**
   * 每次读取都解析一遍，而不是解构一次就定死。
   *
   * `displayName` / `labelWithAgent` 可能传的是取值函数（配置热更新后要读新值）；
   * 常量形式在这里退化成「每次都得到同一个值」，行为不变。
   */
  const displayNameOf = (): string => (typeof deps.displayName === 'function' ? deps.displayName() : deps.displayName)
  const labelWithAgentOf = (): boolean =>
    typeof deps.labelWithAgent === 'function' ? deps.labelWithAgent() : deps.labelWithAgent

  /** 当前分组**暴露给选择器**的模型列表（已按策略过滤 + 带缓存）。 */
  const models = async (): Promise<ModelMeta[]> => {
    // `exposedModelsOf` 是可选的；没接就退化成「不过滤」（老行为）。
    const list =
      deps.exposedModelsOf === undefined ? await deps.modelsOf(agentId) : await deps.exposedModelsOf(agentId)
    return list
  }

  const info = (provider: string): DshProviderInfo => ({ id: provider, name: displayNameOf() })

  /** 从模型元数据里挑出与 DSH 路由 id 对应的那一条。 */
  const find = async (encoded: string): Promise<{ meta: ModelMeta; upstreamId: string } | undefined> => {
    const decoded = decodeModelId(encoded)
    const list = await models()
    const meta = list.find(
      (item) => item.id === decoded.upstreamId || encodeModelId(item.agentId, item.id) === encoded,
    )
    if (meta === undefined) return undefined
    return { meta, upstreamId: meta.id }
  }

  const resolve = async (provider: string, model: string, _signal?: AbortSignal): Promise<DshResolvedModelInfo> => {
    const hit = await find(model)
    const meta: ModelMeta = hit?.meta ?? {
      id: model,
      name: model,
      agentId,
      agentName: displayNameOf(),
    }
    const out: DshResolvedModelInfo = {
      provider,
      id: model,
      name: renderModelLabel(meta, labelWithAgentOf()),
    }
    if (meta.description !== undefined) out.description = meta.description
    if (meta.contextWindow !== undefined) out.context = { contextWindow: meta.contextWindow }
    if (meta.maxTokens !== undefined) out.defaultMaxTokens = meta.maxTokens
    if (Array.isArray(meta.inputModalities) && meta.inputModalities.length > 0) {
      out.inputModalities = [...meta.inputModalities]
    }
    /**
     * 思考档位行。
     *
     * ⚠️ **判据是「模型声明了哪些档位」，不是 `meta.reasoning`。**
     *
     * 原先这里外层套了 `if (meta.reasoning === true)`，于是**声明了档位但
     * `reasoning` 为假**的模型一个档位行都拿不到 —— 实测 Qoder CN 的
     * `performance` 就是这种：目录 `is_reasoning: false`（所以请求体的
     * `isReasoning` 为假），但 `thinking_config.enabled` 为真、上游**确实**提供
     * 档位选择。参考实现（`qoder-adapter.ts` 的 `resolveModel`）也只看
     * `qoderEffortsFor(entry).length > 0`，从不看 `is_reasoning`。
     *
     * 语义上两者本就独立：
     *   - `reasoning`     —— 「这个模型会不会吐思维链」（`is_reasoning`）；
     *   - `reasoningEfforts` —— 「用户能不能调它的思考强度」（`thinking_config`）。
     * 一个模型可以「不吐思维链但你仍能要求它多想想」，也可以反过来。
     *
     * ⚠️ 两者都没有时**不出档位行**：我们不知道它接受什么，编一组出来就是谎报能力。
     */
    const declared = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []
    const efforts = reasoningEffortsForDeclared(declared)
    if (efforts.length > 0) {
      const rows = efforts.map((id) => ({ id, name: reasoningEffortName(id) }))
      // 默认档：上游声明过就用它（见 `defaultReasoningEffortFor` 的优先级说明）。
      const fallback = defaultReasoningEffortFor(declared, meta.defaultReasoningEffort)
      out.reasoning = {
        efforts: rows,
        ...(fallback === undefined ? {} : { defaultEffort: fallback }),
      }
    }
    return out
  }

  /** 把上游的归一化事件翻成 DSH 的 `StreamChunk`。 */
  async function* pump(options: DshGenerateOptions, signal: AbortSignal): AsyncIterable<DshStreamChunk> {
    const decoded = decodeModelId(options.model)
    const targetAgent = decoded.agentId === '' ? agentId : decoded.agentId
    const upstreamModel = decoded.upstreamId
    const adapter = deps.adapterOf(targetAgent)
    const ctx = deps.contextOf(targetAgent)
    if (adapter === undefined || ctx === undefined) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `「${displayNameOf()}」适配器未装载`, code: 'NO_ADAPTER' } satisfies DshFailure,
        },
      }
      return
    }

    /**
     * 思考档位：把客户端选的**规范名**翻译成模型**真正声明过的** id。
     *
     * ## 为什么必须翻译而不是原样下发
     *
     * 上游会**校验** `reasoning_effort`：值不在模型接受的集合里就是 400，
     * 整轮对话直接失败（参考实现 2026-10-02 实测：非法值让错误信息变成
     * `[400] reasoning_…`）。而档位表来自 models.dev、**会被远端刷新** ——
     * 用户在选择器里选了「高」，刷新后该模型的档位集合变了（或会话恢复出一份
     * 旧选择），线上就会发出一个现在非法的值。
     *
     * ## 三态分流（对应 `translateReasoningEffort` 的四态）
     *
     * - `exact` / `mapped` → **下发**（`mapped` 记一条 debug，将来排查 400 靠它）；
     * - `unexpressible` → **不下发**并记日志：模型没有这一族档位，硬发就是 400。
     *   模型用自己的默认思考行为接管；
     * - `unknown` → **报错**：连名字都不认识（客户端 bug / 拼写错），静默吞掉
     *   等于用户以为设了其实没设。
     *
     * ⚠️ **能力未知时原样放行**（`declared === undefined`）：那是「我们不知道该模型
     * 接受什么」，此时拦下来等于把调用方的显式选择静默丢掉。这与「能力表拿到了、
     * 且明确声明了档位集合」是两种不同的处境 —— 后者的空集合表示**确实没有档位**。
     */
    const requestedEffort = options.reasoningEffort
    let reasoningEffort: string | undefined
    if (typeof requestedEffort === 'string' && requestedEffort !== '') {
      const hit = await find(options.model)
      /**
       * ⚠️ 判据是「**这个字段在不在**」，不是「它的长度」——
       * 两种 `undefined` 的处境必须分开：
       *   - `Array.isArray(...) === false`（字段缺失，例如 models.dev 整个拉失败）
       *     ⇒ 我们**不知道**该模型接受什么 ⇒ **原样放行**。此时拦下来等于把
       *       用户的显式选择静默丢掉。
       *   - `[]`（字段在、但是空的）⇒ 适配器**明确告诉我们**这模型没有档位可选
       *     ⇒ 拦下 `reasoning_effort`（上游会校验，发它没声明过的值 = 400）。
       */
      const declared = hit !== undefined && Array.isArray(hit.meta.reasoningEfforts)
        ? hit.meta.reasoningEfforts
        : undefined
      if (declared === undefined) {
        reasoningEffort = requestedEffort
      } else if (declared.length === 0) {
        deps.log.warn(
          `模型 ${upstreamModel} 没有声明任何思考档位，已忽略请求的档位`,
          `requested=${requestedEffort}（上游对该字段会校验，发它没声明过的值会 400）`,
        )
      } else {
        const translated = translateReasoningEffort(requestedEffort, declared)
        if (translated.kind === 'exact') {
          reasoningEffort = translated.effort
        } else if (translated.kind === 'mapped') {
          reasoningEffort = translated.effort
          deps.log.debug(
            `思考档位 ${requestedEffort} → ${translated.effort}（模型 ${upstreamModel} 的写法不同）`,
            `declared=[${declared.join(', ')}]`,
          )
        } else if (translated.kind === 'unexpressible') {
          deps.log.warn(
            `模型 ${upstreamModel} 表达不了档位「${requestedEffort}」，已忽略`,
            `declared=[${declared.join(', ')}]（关闭族与思考族不互译，故不会就近顶替）`,
          )
        } else {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message:
                  `无法识别的思考档位「${requestedEffort}」。` +
                  `本网关认识：${CANONICAL_REASONING_EFFORTS.join(' / ')}。`,
                code: 'UNKNOWN_REASONING_EFFORT',
              } satisfies DshFailure,
            },
          }
          return
        }
      }
    }

    // DSH 的 messages → OpenAI 兼容 messages。
    const payload = {
      model: upstreamModel,
      messages: toOpenAiMessages(options),
      stream: true,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      // ⚠️ 字段名 `reasoning_effort` 由**实测**确定（参考实现 2026-10-02）：
      // 给上游传非法值时错误信息变成 `[400] reasoning_…`，说明它确实解析并校验
      // 这个字段。**不是** `reasoning`（那是我们内部的布尔开关语义）。
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      ...(options.tools === undefined
        ? {}
        : {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: { name: tool.name, description: tool.description, parameters: tool.parameters },
            })),
          }),
    }

    // ★ 多账号智能路由：一次调用内部自动换号、重试。
    const outcome = await router.execute<{
      events: AsyncIterable<import('../core/types.js').StreamEvent>
    }>(
      targetAgent,
      async (account: AccountRecord) => {
        const stream = adapter.requestChatStream(
          payload,
          account,
          { ...ctx, log: ctx.log.child(account.id) },
          signal,
        )
        // 先取第一个事件：这一步就能知道是不是 401/429/额度耗尽，
        // 从而在「还没往 DSH 吐任何字」的时候换号，用户看不到闪烁。
        const iterator = stream[Symbol.asyncIterator]()
        const first = await iterator.next()
        if (first.done === true) {
          return { ok: false as const, kind: 'unknown' as const, message: '上游没有返回任何事件' }
        }
        const value = first.value
        if (value.type === 'error') {
          return {
            ok: false as const,
            kind: value.failure.kind,
            message: value.failure.message,
            ...(value.failure.status === undefined ? {} : { status: value.failure.status }),
            ...(value.failure.retryAfterMs === undefined ? {} : { retryAfterMs: value.failure.retryAfterMs }),
            ...(value.failure.requestId === undefined ? {} : { requestId: value.failure.requestId }),
          }
        }
        return {
          ok: true as const,
          value: {
            events: (async function* replay(): AsyncIterable<import('../core/types.js').StreamEvent> {
              yield value
              for (;;) {
                const next = await iterator.next()
                if (next.done === true) return
                yield next.value
              }
            })(),
          },
        }
      },
    )

    // ── 采样：把这一轮的耗时 / 首字 / token 记下来（成功失败都记） ──
    const startedAt = Date.now()
    let ttftMs: number | undefined
    let usage: TokenUsage | undefined
    let failureMessage: string | undefined
    let accountId: string | null = null
    let settled = false
    /** 只会真正写一次（生成器可能在多个分支 return）。 */
    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (deps.onRequest === undefined) return
      const durationMs = Date.now() - startedAt
      const sample: Omit<RequestLogEntry, 'ts'> = {
        agentId: targetAgent,
        agentName: displayNameOf(),
        model: upstreamModel,
        accountId,
        ok,
        durationMs,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
        ...(failureMessage === undefined ? {} : { error: failureMessage }),
      }
      const tps = computeTps({
        durationMs,
        ...(ttftMs === undefined ? {} : { ttftMs }),
        ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      })
      deps.onRequest(tps === undefined ? sample : { ...sample, tps })
    }

    if (!outcome.ok) {
      failureMessage = outcome.failure.message
      settle(false)
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: outcome.failure.message,
            code: outcome.failure.kind.toUpperCase(),
            ...(outcome.failure.status === undefined ? {} : { status: outcome.failure.status }),
            ...(outcome.failure.retryAfterMs === undefined ? {} : { providerRetryAfterMs: outcome.failure.retryAfterMs }),
            ...(outcome.failure.requestId === undefined ? {} : { requestId: outcome.failure.requestId }),
          } satisfies DshFailure,
        },
      }
      return
    }

    accountId = outcome.accountId ?? null
    log.debug(
      `路由完成：account=${outcome.accountId} attempts=${outcome.attempts.length}`,
      outcome.attempts.map((item) => `${item.accountId}:${item.kind}`).join(','),
    )

    // ── 事件 → chunk ─────────────────────────────────────────────
    //
    // DSH 的 `BlockAssembler` 按 **index** 收块，四条硬约束（读源码确认，不是猜的）：
    //   · 同一 index 的 blockType 必须一致（text / reasoning / tool-call 各占一块）；
    //   · `tool-call-delta` 的 id 是**覆盖**式赋值（`partial.toolCallId = chunk.id`），
    //     而上游只在首帧给 id ⇒ 我们必须**每帧发同一个 id**，否则真 id 会被冲掉；
    //   · `argumentsDelta` 是**累加**的，必须原样转发；
    //   · 上游可以有**多个并行工具调用**（`tool_calls[i].index` 不同）⇒ 每个占独立块。
    let cursor = 0
    let textBlock = -1
    let reasoningBlock = -1
    /**
     * 已流出的正文与思维链原文。
     *
     * ⚠️ **必须自己攒着** —— `block-end` 不是「关闭」而是**覆盖**：
     * 宿主 `BlockAssembler.push()` 收到 `block-end` 时直接
     * `partial.block = chunk.block`，`assemble()` 又优先返回 `partial.block`，
     * 所以之前发的那一串 `text-delta` **会被整个丢掉**。
     *
     * 症状就是用户看到的那条：「有输出，但一调工具就被覆盖掉」——
     * 流式期间 delta 显示得好好的，回合收尾把文本块冲成一个空串。
     * 宿主自带的适配器（`dsh-llm-deepseek` / `dsh-llm-pi-ai`）在 `block-end`
     * 里带的都是**完整正文**（`text: event.content`），这里与它们对齐。
     */
    let textBuf = ''
    let reasoningBuf = ''
    const toolBlocks = new Map<number, { block: number; id: string; name: string; args: string }>()
    /** 拿一个全新的块下标。 */
    const allocate = (): number => {
      const block = cursor
      cursor += 1
      return block
    }
    /**
     * 收尾该报哪种 finish。
     *
     * ⚠️ **有工具调用时必须报 `tool-calls`** —— 这一条曾让我掉进死循环：
     * 一律报 `stop` 时，DSH 认为本轮已正常结束、**不去执行工具**，
     * 模型下一轮又发同样的工具调用，表现就是「工具调用失败 + 无限循环」。
     * `max-tokens` 同理：上游说 `length` 时不能谎报 `stop`，否则截断被当成正常结束。
     */
    const finishChunk = (upstreamReason?: string): DshStreamChunk => ({
      type: 'finish',
      reason: {
        kind: toolBlocks.size > 0 ? 'tool-calls' : upstreamReason === 'length' ? 'max-tokens' : 'stop',
      },
    })
    try {
      for await (const event of outcome.value.events) {
        // 首字延迟：第一段「用户能看见的内容」到达的时刻。
        // 思维链也算 —— 它同样是用户可见的等待结束点。
        if (ttftMs === undefined && (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_call')) {
          ttftMs = Date.now() - startedAt
        }
        switch (event.type) {
          case 'text': {
            if (textBlock < 0) {
              textBlock = allocate()
              yield { type: 'block-start', index: textBlock, blockType: 'text' }
            }
            textBuf += event.text
            yield { type: 'text-delta', index: textBlock, text: event.text }
            break
          }
          case 'reasoning': {
            // 思维链单独一块，DSH 会话里显示成思考过程。
            if (reasoningBlock < 0) {
              reasoningBlock = allocate()
              yield { type: 'block-start', index: reasoningBlock, blockType: 'reasoning' }
            }
            reasoningBuf += event.text
            yield { type: 'reasoning-delta', index: reasoningBlock, text: event.text }
            break
          }
          case 'tool_call': {
            const upstreamIndex = event.index ?? 0
            let state = toolBlocks.get(upstreamIndex)
            if (state === undefined) {
              state = { block: allocate(), id: '', name: '', args: '' }
              toolBlocks.set(upstreamIndex, state)
              yield { type: 'block-start', index: state.block, blockType: 'tool-call' }
            }
            // 首帧拿真 id；之后每帧都发同一个，别让 DSH 的覆盖式赋值把它抹掉。
            if (state.id === '') state.id = event.id ?? `call_${state.block}`
            if (event.name !== undefined && event.name !== '') state.name = event.name
            state.args += event.argumentsDelta ?? ''
            yield {
              type: 'tool-call-delta',
              index: state.block,
              id: state.id,
              ...(event.name === undefined || event.name === '' ? {} : { name: event.name }),
              argumentsDelta: event.argumentsDelta ?? '',
            }
            break
          }
          case 'usage': {
            usage = event.usage
            yield { type: 'usage', usage: event.usage }
            break
          }
          case 'finish': {
            // 关掉所有开着的块（工具块带上累积的 name/arguments，DSH 侧才拼得回完整调用）。
            for (const state of toolBlocks.values()) {
              yield {
                type: 'block-end',
                index: state.block,
                block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args },
              }
            }
            if (textBlock >= 0) {
              yield { type: 'block-end', index: textBlock, block: { type: 'text', text: textBuf } }
            }
            if (reasoningBlock >= 0) {
              yield { type: 'block-end', index: reasoningBlock, block: { type: 'reasoning', text: reasoningBuf } }
            }
            // 上游给了终止事件 —— 正常收尾。这里必须结算采样，
            // 因为下面马上 `return`，走不到函数底部那次 settle。
            settle(true)
            yield finishChunk(event.reason)
            return
          }
          case 'error': {
            // 这里同样要带上已流出的正文 —— 报错也不能把用户已经看到的话吞掉。
            if (textBlock >= 0) {
              yield { type: 'block-end', index: textBlock, block: { type: 'text', text: textBuf } }
            }
            if (reasoningBlock >= 0) {
              yield { type: 'block-end', index: reasoningBlock, block: { type: 'reasoning', text: reasoningBuf } }
            }
            failureMessage = event.failure.message
            settle(false)
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  message: event.failure.message,
                  code: event.failure.kind.toUpperCase(),
                  ...(event.failure.status === undefined ? {} : { status: event.failure.status }),
                } satisfies DshFailure,
              },
            }
            return
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failureMessage = message
      settle(false)
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } satisfies DshFailure },
      }
      return
    }
    // 上游流没给终止 —— 兜一个，DSH 侧才能收尾。
    // 有工具调用时这里也必须是 `tool-calls`，否则又是「工具不执行 + 死循环」。
    settle(true)
    yield finishChunk()
  }

  return {
    providerInfo: info,
    async listModels(_provider: string): Promise<DshModelInfo[]> {
      const list = await models()
      return list.map((meta) => {
        const info: DshModelInfo = {
          provider: _provider,
          id: encodeModelId(meta.agentId, meta.id),
          name: renderModelLabel(meta, labelWithAgentOf()),
        }
        if (meta.description !== undefined) info.description = meta.description
        if (Array.isArray(meta.inputModalities) && meta.inputModalities.length > 0) {
          info.inputModalities = [...meta.inputModalities]
        }
        return info
      })
    },
    resolveModel: resolve,
    async prepareCall(provider, model, signal) {
      const resolved = await resolve(provider, model, signal)
      return {
        model: resolved,
        stream: (options: DshGenerateOptions) => {
          const controller = new AbortController()
          const signalOut =
            options.signal === undefined
              ? controller.signal
              : typeof AbortSignal.any === 'function'
                ? AbortSignal.any([options.signal, controller.signal])
                : options.signal
          return pump(options, signalOut)
        },
      }
    },
    stream(options: DshGenerateOptions) {
      const controller = new AbortController()
      const signal =
        options.signal === undefined
          ? controller.signal
          : typeof AbortSignal.any === 'function'
            ? AbortSignal.any([options.signal, controller.signal])
            : options.signal
      return pump(options, signal)
    },
    providerRetryPolicy() {
      // 交给 DSH 自己的重试执行器：限流/上游故障值得重试；鉴权与额度错误
      // 已经在插件内部换过号了，再重试同一路由没意义。
      return {
        mode: 'normal',
        maxRetries: 2,
        retryableCodes: ['RATE_LIMIT', 'SERVER', 'NETWORK', 'UNKNOWN', 'EMPTY_RESPONSE'],
        initialDelayMs: 1000,
        maxDelayMs: 30_000,
        jitterRatio: 0.2,
      }
    },
  }
}

/** DSH 的 `GenerateOptions.messages` → OpenAI 兼容 messages。 */
export function toOpenAiMessages(options: DshGenerateOptions): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (typeof options.system === 'string' && options.system !== '') {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    // 已经是 OpenAI 形状的（DSH 的请求消息本来就是 provider 中立的块数组，
    // 这里做一次扁平化；能直接用的就原样透传）。
    if (typeof message.content === 'string') {
      out.push({ role: normalizeRole(message.role), content: message.content, ...carryExtra(message) })
      continue
    }
    const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text))
      .join('')
    const entry: Record<string, unknown> = { role: normalizeRole(message.role), content: text }
    const toolCalls = blocks.filter((block) => block?.type === 'tool-call')
    if (toolCalls.length > 0) {
      entry.tool_calls = toolCalls.map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments },
      }))
    }
    if (typeof message.toolCallId === 'string') {
      entry.tool_call_id = message.toolCallId
    }
    out.push(entry)
  }
  return out
}

/** DSH 的 role → OpenAI role（`developer` 归一到 `system`）。 */
function normalizeRole(role: string): string {
  if (role === 'developer') return 'system'
  return role
}

/**
 * 把消息上已有的额外字段带过去。
 *
 * ⚠️ DSH 的形状是 camelCase（`ToolResultMessage.toolCallId`），OpenAI 是
 * snake_case（`tool_call_id`）—— 少做这一步映射，工具结果就会丢关联 id，
 * 上游会直接 400「tool_call_id is required」（这是最容易漏的一处）。
 */
function carryExtra(message: { [key: string]: unknown }): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  for (const key of ['name', 'tool_calls', 'reasoning_content']) {
    if (message[key] !== undefined) extra[key] = message[key]
  }
  const callId = message.tool_call_id ?? message.toolCallId
  if (typeof callId === 'string' && callId !== '') extra.tool_call_id = callId
  const reasoning = message.reasoning_content ?? message.reasoningContent
  if (typeof reasoning === 'string' && reasoning !== '') extra.reasoning_content = reasoning
  return extra
}
