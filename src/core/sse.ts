/**
 * SSE（Server-Sent Events）解析器 + OpenAI 兼容 chunk → 归一化流事件。
 *
 * 「SSE 流式传输稳定，不能中断」这条要求的全部实现要点都在这里：
 *
 *   - **按 `\n\n` 切事件，但允许 `\r\n\r\n`**：不同上游的行尾不一样。
 *   - **跨 chunk 的残片要缓冲**：一个 SSE 事件可能被 TCP 切成三段，
 *     少一个字符都可能把 JSON 截断 → 解析失败 → 流看起来「断了」。
 *   - **`[DONE]` 是终止哨兵**，不是 JSON。
 *   - **心跳/注释行（`:` 开头）跳过**：很多网关用它保活。
 *   - **单个事件解析失败只跳过它**，绝不终止整个流 —— 上游偶尔吐一条坏 JSON
 *     不应该让用户看到「流断了」。
 *   - **`usage` / `finish_reason` 单独提取**：它们在最后一个 chunk 里。
 */

import type { FailureInfo, StreamEvent, TokenUsage } from './types.js'

/** SSE 增量解码器。喂字节片段，吐完整事件的数据字段。 */
export class SseDecoder {
  private buffer = ''

  /**
   * 喂一段文本，返回本次能完整解析出的 `data:` 负载列表。
   *
   * @param chunk - 刚读到的片段。
   */
  push(chunk: string): string[] {
    this.buffer += chunk
    const out: string[] = []
    // 事件分隔：空行。统一成 \n 再切。
    const normalized = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const parts = normalized.split('\n\n')
    // 最后一段可能不完整，留在缓冲里。
    this.buffer = parts.pop() ?? ''
    for (const block of parts) {
      const payload = extractData(block)
      if (payload !== undefined) out.push(payload)
    }
    return out
  }

  /** 流结束时把残留在缓冲里的最后一条事件也吐出来（有的上游不发尾随空行）。 */
  flush(): string[] {
    if (this.buffer.trim() === '') {
      this.buffer = ''
      return []
    }
    const payload = extractData(this.buffer)
    this.buffer = ''
    return payload === undefined ? [] : [payload]
  }
}

/** 从一个 SSE 块里抽 `data:` 负载；纯注释块返回 undefined。 */
function extractData(block: string): string | undefined {
  const lines = block.split('\n')
  const dataLines: string[] = []
  let sawField = false
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue
    sawField = true
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  if (!sawField || dataLines.length === 0) return undefined
  return dataLines.join('\n')
}

/** 一个 OpenAI 兼容的 chunk（只声明我们真正会读的字段）。 */
interface OpenAiChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      thinking?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: unknown[]
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  error?: { message?: string; type?: string; code?: string }
}

/** 思维链字段名在不同上游不一样，这里按优先级取第一个非空的。 */
const REASONING_KEYS = ['reasoning_content', 'reasoning', 'thinking', 'analysis'] as const

/** 从 delta 里抽思维链文本。 */
function reasoningOf(delta: Record<string, unknown> | undefined): string | undefined {
  if (delta === undefined) return undefined
  for (const key of REASONING_KEYS) {
    const value = delta[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** 把 usage 归一化。 */
export function normalizeUsage(raw: OpenAiChunk['usage']): TokenUsage | undefined {
  if (raw === undefined || raw === null) return undefined
  
  const input = num(raw.prompt_tokens)
  const output = num(raw.completion_tokens)
  const usage: TokenUsage = { inputTokens: input, outputTokens: output }
  const total = num(raw.total_tokens)
  if (total > 0 || input + output > 0) usage.totalTokens = total > 0 ? total : input + output
  const reasoning = num(raw.completion_tokens_details?.reasoning_tokens)
  if (reasoning > 0) usage.reasoningTokens = reasoning
  const cached = num(raw.prompt_tokens_details?.cached_tokens) || num(raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens)
  if (cached > 0) usage.cacheReadTokens = cached
  const written = num(raw.cache_creation_input_tokens)
  if (written > 0) usage.cacheWriteTokens = written
  return usage
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * 这个负载是不是**合法 JSON**。
 *
 * 为什么单独有这么个函数：`translateChunk` 对「合法但什么都没带」的 chunk
 * 也返回空数组 —— 比如上游的**第一个** chunk 常常只有
 * `{"choices":[{"delta":{"role":"assistant"}}]}`，它合法、正常、但确实不含内容。
 * 只看「返回空数组」就报「无法解析」，会让每一条流都刷一条假的坏事件警告
 * （实测踩到过）。所以判据必须落在「JSON 能不能解析」上。
 */
export function isParseableJson(payload: string): boolean {
  const trimmed = payload.trim()
  if (trimmed === '') return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/** 把「一个 SSE data 负载」翻译成零到多个归一化流事件。 */
export function translateChunk(payload: string): StreamEvent[] {
  const trimmed = payload.trim()
  if (trimmed === '' || trimmed === '[DONE]') return []
  let parsed: OpenAiChunk
  try {
    parsed = JSON.parse(trimmed) as OpenAiChunk
  } catch {
    // 坏事件跳过，不终止流。上层会把「跳过过」记进统计。
    return []
  }
  const events: StreamEvent[] = []
  if (parsed.error !== undefined && parsed.error !== null) {
    const failure: FailureInfo = {
      kind: 'server',
      message: parsed.error.message ?? '上游在流里返回了 error',
      at: Date.now(),
    }
    events.push({ type: 'error', failure })
    return events
  }
  const choice = parsed.choices?.[0]
  if (choice !== undefined) {
    const delta = choice.delta as Record<string, unknown> | undefined
    const text = typeof delta?.content === 'string' ? delta.content : undefined
    if (text !== undefined && text !== '') events.push({ type: 'text', text })
    const reasoning = reasoningOf(delta)
    if (reasoning !== undefined) events.push({ type: 'reasoning', text: reasoning })
    const toolCalls = (delta?.tool_calls ?? []) as Array<{
      index?: number
      id?: string
      function?: { name?: string; arguments?: string }
    }>
    for (const call of toolCalls) {
      const event: StreamEvent = { type: 'tool_call', index: call.index ?? 0 }
      if (typeof call.id === 'string') event.id = call.id
      if (typeof call.function?.name === 'string' && call.function.name !== '') event.name = call.function.name
      if (typeof call.function?.arguments === 'string') event.argumentsDelta = call.function.arguments
      events.push(event)
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      events.push({ type: 'finish', reason: choice.finish_reason })
    }
  }
  const usage = normalizeUsage(parsed.usage)
  if (usage !== undefined) events.push({ type: 'usage', usage })
  return events
}

/**
 * 把 `Response.body` 变成一个归一化事件异步迭代器。
 *
 * 这是「流式转发」的核心：输入是 `fetch` 的字节流，输出是与上游无关的
 * `StreamEvent`。适配器把它们再翻译成 DSH 的 `StreamChunk`。
 *
 * @param response - 上游响应（必须带 body）。
 * @param onMalformed - 每跳过一个坏事件回调一次（用于日志与「不是静默失败」）。
 * @param signal - 取消信号。
 */
export async function* iterateSse(
  response: Response,
  onMalformed?: (payload: string) => void,
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  if (response.body === null) {
    yield {
      type: 'error',
      failure: { kind: 'server', message: '上游响应没有 body（不是流式响应？）', at: Date.now() },
    }
    return
  }
  const decoder = new TextDecoder('utf-8')
  const sse = new SseDecoder()
  // Node 的 web ReadableStream 支持异步迭代。
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  let sawFinish = false
  try {
    for (;;) {
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: 'aborted' }
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      const payloads = sse.push(text)
      for (const payload of payloads) {
        if (payload.trim() === '[DONE]') {
          if (!sawFinish) {
            yield { type: 'finish', reason: 'stop' }
            sawFinish = true
          }
          continue
        }
        const events = translateChunk(payload)
        // 只有**解析不了**才算坏事件；「合法但空」是正常情况（例如只带 role 的首帧）。
        if (events.length === 0 && payload.trim() !== '' && !isParseableJson(payload)) onMalformed?.(payload)
        for (const event of events) {
          if (event.type === 'finish') sawFinish = true
          yield event
        }
      }
    }
    const tailText = decoder.decode()
    if (tailText !== '') {
      for (const payload of sse.push(tailText)) {
        for (const event of translateChunk(payload)) {
          if (event.type === 'finish') sawFinish = true
          yield event
        }
      }
    }
    for (const payload of sse.flush()) {
      if (payload.trim() === '[DONE]') continue
      for (const event of translateChunk(payload)) {
        if (event.type === 'finish') sawFinish = true
        yield event
      }
    }
    // 上游没给 finish_reason 也要补一个，否则 DSH 侧看不到终止。
    if (!sawFinish) yield { type: 'finish', reason: 'stop' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    yield { type: 'error', failure: { kind: 'network', message: `读取上游流失败：${message}`, at: Date.now() } }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 释放失败无所谓。
    }
  }
}

/** 非流式响应 → 归一化事件（少量上游/探测路径用）。 */
export function* translateNonStream(body: unknown): Iterable<StreamEvent> {
  const parsed = body as OpenAiChunk | undefined
  const choice = parsed?.choices?.[0]
  const message = choice?.message as Record<string, unknown> | undefined
  const reasoning = reasoningOf(message)
  if (reasoning !== undefined) yield { type: 'reasoning', text: reasoning }
  const content = message?.content
  if (typeof content === 'string' && content !== '') yield { type: 'text', text: content }
  const usage = normalizeUsage(parsed?.usage)
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop' }
}
