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

                                                                      
import {
  describeQueueError,
  isBillingErrorBody,
  parseQueueError,
  queueDelayMs,
} from './queue.js'
import { looksLikeRiskControl, parseRetryAfter } from './errors.js'

/** SSE 增量解码器。喂字节片段，吐完整事件的数据字段。 */
export class SseDecoder {
          buffer = ''

  /**
   * 喂一段文本，返回本次能完整解析出的 `data:` 负载列表。
   *
   * @param chunk - 刚读到的片段。
   */
  push(chunk        )           {
    this.buffer += chunk
    const out           = []
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
  flush()           {
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
function extractData(block        )                     {
  const lines = block.split('\n')
  const dataLines           = []
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
                       
             
                
                   
                  
             
                             
                                       
                               
                              
                          
                      
                   
                     
                                                        
        
     
               
                             
                                       
                            
     
                                 
    
           
                          
                              
                         
                                                             
                                                      
                                    
                                    
                                        
   
                                                            
     
                                                   
    
                                                  
                                           
     
                  
                          
                      
               
 

/** 思维链字段名在不同上游不一样，这里按优先级取第一个非空的。 */
const REASONING_KEYS = ['reasoning_content', 'reasoning', 'thinking', 'analysis']         

/** 从 delta 里抽思维链文本。 */
function reasoningOf(delta                                     )                     {
  if (delta === undefined) return undefined
  for (const key of REASONING_KEYS) {
    const value = delta[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** 把 usage 归一化。 */
export function normalizeUsage(raw                      )                         {
  if (raw === undefined || raw === null) return undefined
  
  const input = num(raw.prompt_tokens)
  const output = num(raw.completion_tokens)
  const usage             = { inputTokens: input, outputTokens: output }
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

function num(value         )         {
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
export function isParseableJson(payload        )          {
  const trimmed = payload.trim()
  if (trimmed === '') return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

/**
 * 把「流内错误体」归类成 `FailureInfo` —— **排队 / 额度 / 其它**三分支的唯一落点。
 *
 * ## 为什么必须单独抽出来
 *
 * `translateChunk` 有**两个**错误分支（OpenAI 标准的 `error` 字段、以及网关形态的
 * `model_error` 信封），它们原先都各自硬编码 `kind: 'server'`。排队识别只补一处
 * 就会漏掉另一处 —— 参考实现第一版正是这么翻车的（只修了 HTTP 通道，
 * SSE 通道静默失效，探针显示 `sleep 次数 = 0`）。
 *
 * ## 三分支的语义（都不是风格问题，错了用户就有损失）
 *
 * | 形态 | kind | 为什么 |
 * |---|---|---|
 * | 排队（`10605` / 排队字段） | `rate_limit` | **暂时**受阻，等一会就能过；绝不能说成「额度」 |
 * | 额度当天耗尽（`110` / billing 文案） | `quota` | **等多久都一样**，白重试 5 次是纯损失 |
 * | 风控拦截 | `risk_control` | **账号维度**，要换号 + 长冷却；不能判成 `server` 白重试 |
 * | 其它上游错误 | `server` | 保持原行为不动 |
 *
 * ## ⚠️ 排队为什么是 `rate_limit` 而不是 `server`
 *
 * `server` 在 DSH 的可重试码里 ⇒ **立刻白重试 5 次（≈15.5 秒）**，
 * 完全无视上游说的「等 30 秒」（每次都被同一个队列挡住），最后把裸 JSON 丢给用户。
 *
 * 选 `rate_limit` 而不是新造 kind 的理由：它在 `isRetryable` 里是**可重试**的
 * （排队确实该重试），语义就是「被上游暂时挡住」，且 `penaltyMsFor` 会认
 * `retryAfterMs`。⚠️ 它是**账号级**的短暂受阻，**不应判死账号** ——
 * 那由 `retryAfterMs` 表达，不由 kind 表达。
 *
 * @param raw - 整段 SSE 负载原文（**必须给原文**：排队参数在内层 `message` 字符串里，
 *   而识别 `10605` 要靠**顶层** `code`，两者都在原文中）。
 * @param fallbackMessage - 非排队、非额度时的展示文案（各分支自己那份干净的话）。
 * @param status - HTTP 状态码（有就带上，便于排查）。
 * @param headerDelayMs - 兜底延迟，来自 `Retry-After` 响应头（见 {@link iterateSse}）。
 *   只在**体内没有给延迟**时才用得上（优先序的第 4 档）。
 */

/**
 * 风控拦截的展示文案。
 *
 * ## 为什么要把上游原话带上
 *
 * 风控的处置动作是「换号」，但如果**不告诉用户为什么**，他只会看到「换了个号
 * 就成功了」，完全不知道原账号已被盯上。下次那个号恢复后又被选中，再次失败，
 * 用户会以为是随机故障。
 *
 * 而风控的具体措辞恰恰是**用户唯一能行动的线索**：「请完成验证」要去过验证，
 * 「设备异常」要换设备/环境，「账号被封禁」只能换号。把原话吞掉等于把线索吞掉。
 *
 * 上游原话截断到 300 字符（与 `classifyStreamError` 其它分支同口径），
 * 避免把整段 HTML 错误页糊到界面上。
 */
function describeRiskControl(raw        , fallbackMessage        )         {
  const detail = raw.trim()
  const head = '上游判定这个账号触发了**风控拦截**（不是密钥问题，也不是额度问题）——'
  const tail = '已自动切换其它账号重试；这个号会被冷落一段时间。'
  if (detail === '') return `${head}${tail}`
  return `${head}\n\n上游原话：${detail.slice(0, 300)}\n\n${tail}`
}

function classifyStreamError(
  raw        ,
  fallbackMessage        ,
  status         ,
  headerDelayMs         ,
)              {
  // ① 排队优先：排队体里可能夹带其它噪声字段，先认它最安全。
  const queue = parseQueueError(raw)
  if (queue !== undefined) {
    /**
     * 延迟优先序（参考实现 `kJa()`/`EV()`/`IRA()` 的取证结论）：
     * `retry_after_ms` → `retryAfterMs` → `retryAfterSeconds × 1000`
     * → 兜底 `Retry-After` 响应头。
     *
     * ⚠️ 前三级由 `queueDelayMs` 负责；**第 4 级在这里补**。少了它，一个
     * 「只说了排队、没说等多久」的响应体就会退到 `router` 的默认惩罚，
     * 而服务端其实已经在响应头里写明了时长 —— 那正是本次要修的那类信息丢失。
     * ⚠️ 封顶只在体内取值时做（`queueDelayMs` 内部），头部的值已经过
     * `parseRetryAfter` + `RETRY_AFTER_CAP_MS` 的同一套口径，不再二次封顶。
     */
    const bodyDelayMs = queueDelayMs(queue)
    const delayMs = bodyDelayMs ?? headerDelayMs
    return {
      kind: 'rate_limit',
      message: describeQueueError(queue, delayMs),
      ...(status === undefined ? {} : { status }),
      // ⚠️ `0` 是合法值（「立刻可重试」），所以只在 `undefined` 时省略 ——
      // falsy 判据会把「立即解除」换成默认冷却，让本可立刻重试的请求白等。
      ...(delayMs === undefined ? {} : { retryAfterMs: delayMs }),
      at: Date.now(),
    }
  }

  // ② 额度当天耗尽：不可重试（`quota` 不在 DSH 的可重试码里）。
  if (isBillingErrorBody(raw)) {
    return {
      kind: 'quota',
      message: '上游提示**当天额度已用尽**（等一会儿再试也是同样结果，请明天再来或换一个账号）。',
      ...(status === undefined ? {} : { status }),
      at: Date.now(),
    }
  }

  /**
   * ③ 风控拦截。
   *
   * ## 为什么流式这条路径必须单独认
   *
   * 非流式走的是 `classify()`（按 HTTP 状态 + body），流式走的是这里 —— 两条
   * 路径**各自独立**。只修 `classify()` 的话，风控落在流里就仍然被判成
   * `server`（见下面 ④ 的兜底），于是：
   *   1. `server` 在 DSH 的可重试码里 ⇒ 同一个号白重试 5 次；
   *   2. 账号**不降权** ⇒ 路由器下次还会挑中它，一直撞墙。
   *
   * 判据复用 `classify()` 的同一套文案表（经 `looksLikeRiskControl` 导出），
   * 保证两条路径口径一致。
   */
  if (looksLikeRiskControl(raw)) {
    return {
      kind: 'risk_control',
      message: describeRiskControl(raw, fallbackMessage),
      ...(status === undefined ? {} : { status }),
      at: Date.now(),
    }
  }

  // ④ 其它：保持原行为（`server`），文案用调用方给的那份干净的。
  return {
    kind: 'server',
    message: fallbackMessage,
    ...(status === undefined ? {} : { status }),
    at: Date.now(),
  }
}

/** 把「一个 SSE data 负载」翻译成零到多个归一化流事件。 */
export function translateChunk(payload        , headerDelayMs         )                {
  const trimmed = payload.trim()
  if (trimmed === '' || trimmed === '[DONE]') return []
  let parsed             
  try {
    parsed = JSON.parse(trimmed)               
  } catch {
    // 坏事件跳过，不终止流。上层会把「跳过过」记进统计。
    return []
  }
  // 原文一并传下去：排队参数藏在 `message` 的**内层 JSON 字符串**里，
  // 而顶层 `code` 是识别 `10605` 的关键 —— 只读已解析的部分会丢掉它们。
  return translateParsed(parsed, trimmed, headerDelayMs)
}

/** `translateChunk` 的实体（拿到已解析对象 + 原文 + 头部兜底延迟）。 */
function translateParsed(parsed             , raw        , headerDelayMs         )                {
  const events                = []
  /**
   * ⚠️ **`JSON.parse('null')` 得到的是 `null`，不是对象** ——
   * 而下面每一处都读 `parsed.xxx`，于是 `translateChunk('null')` 会抛
   * `Cannot read properties of null (reading 'error')`。
   *
   * 这条路径是**真的会走到**的：Qoder 信封里的 `body: null` 心跳帧经
   * `innerTextOf` 的 `JSON.stringify(null)` 就是字符串 `'null'`。
   * 目前 `unwrapQoderEnvelopeStream` 用 `classifyInner` 把心跳**提前丢掉**了，
   * 所以没炸；但那是**别人的**保护 —— `translateChunk` 是导出给所有适配器
   * 用的通用函数，任何人直接喂它一帧 `null`（或将来某个上游直接下发
   * `data: null`）就会抛，而这里的异常会一路冒到流消费处、
   * 把「跳过一帧」升级成「整轮对话失败」。
   * 通用解析器不该依赖调用方替它挡住非对象 JSON。
   *
   * 非对象的一律当「合法但空」处理（与 `{}` / `[]` / 裸标量一致）。
   */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  if (parsed.error !== undefined && parsed.error !== null) {
    /**
     * ⚠️ 这里把**整个 payload 原文**交给分类器，而不是只给 `parsed.error.message`。
     *
     * 理由：真实报文里排队参数在内层，而**顶层 `code: '10605'`** 是识别排队的
     * 关键信号（`error` 分支读不到它）。只传 `error.message` 也能靠内层的
     * `isQueued` 字段命中，但少一层保险 —— 统一给原文更稳。
     */
    events.push({
      type: 'error',
      failure: classifyStreamError(raw, parsed.error.message ?? '上游在流里返回了 error', undefined, headerDelayMs),
    })
    return events
  }
  /**
   * ⚠️ **网关形态 / 信封剥离后的错误帧**：既没有 `error`、也没有 `choices`，
   * 只带 `message` + （`statusCodeValue` 或 `stackTrace`），
   * 或信封剥离后统一的 `type: 'model_error'`。
   *
   * ## 不认它就会「静默成功」（真实缺陷，用户报障 2026-10-20）
   *
   * 用户报：**Qoder CN 的模型发消息后没有回复，直接显示「已完成」**；
   * 同一个账号的 Qoder 平台正常。抓原始帧看到上游在 **HTTP 200** 的流里回：
   *
   * ```
   * {"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null",
   *  "statusCodeValue":400,"statusCode":"BAD_REQUEST"}
   * ```
   *
   * `unwrapQoderEnvelopeStream` 把它保真转成 `{code, message, type:'model_error'}`
   * —— 而这里**一个条件都不命中**（没有 `error`、没有 `choices`），
   * 整帧被当成「合法但空的 chunk」丢掉。流随后照常 `finish(stop)`，
   * 于是 DSH 收到的是「成功但零正文」⇒ 界面上就是「已完成，没有回复」。
   *
   * 危害比「报错」大得多：报错用户至少知道要重试；**静默成功会被当成模型真没话说**。
   *
   * 参考实现（`openai-compat.ts`）对同一形态有显式分支，注释里写着
   * 「若只判 `statusCodeValue >= 400`，整帧会被静默丢弃……连报错都没有」。
   * 我们把那段移植过来时漏了这条判据。
   *
   * 判据必须同时覆盖两种来源：
   *   - 信封剥离后的 `type === 'model_error'`（`statusCodeValue` 已被信封吃掉）；
   *   - 直连网关时的 `statusCodeValue >= 400` / 带 `stackTrace`。
   */
  if (parsed.choices === undefined && typeof parsed.message === 'string') {
    const gateway = parsed
    const status = typeof gateway.statusCodeValue === 'number' ? gateway.statusCodeValue : undefined
    const looksLikeError =
      gateway.type === 'model_error'
      || (status !== undefined && status >= 400)
      || gateway.stackTrace !== undefined
    if (looksLikeError) {
      /**
       * ⚠️ **`kind` 不再硬编码成 `server`**（真实报障 2026-10-24）。
       *
       * 用户看到的是 Qoder 的排队报文：
       * ```json
       * {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
       * ```
       * 硬编码成 `server` 有两个后果，都不轻：
       *   1. `server` 在 DSH 的可重试码里 ⇒ **立刻白重试 5 次（≈15.5 秒）**，
       *      完全无视上游说的「等 30 秒」，每次都被同一个队列挡住；
       *   2. `retryAfterMs` 从不设置 ⇒ 路由器只能退到默认冷却，
       *      且用户看到的是一坨**裸 JSON**，看不出「排队」二字。
       *
       * 另一个被一起修掉的是业务码 `110`（当天额度耗尽）：它原先也是 `server`
       * ⇒ 同样白重试 5 次，而**等多久结果都一样**，那是纯损失。
       *
       * 分类的详细依据见 `classifyStreamError` 与 `core/queue.ts`。
       */
      events.push({
        type: 'error',
        failure: classifyStreamError(
          raw,
          // 非排队/非额度时保持原样：拿上游给的 `message` 当文案。
          gateway.message,
          status,
          headerDelayMs,
        ),
      })
      return events
    }
  }
  const choice = parsed.choices?.[0]
  if (choice !== undefined) {
    const delta = choice.delta                                       
    const text = typeof delta?.content === 'string' ? delta.content : undefined
    if (text !== undefined && text !== '') events.push({ type: 'text', text })
    const reasoning = reasoningOf(delta)
    if (reasoning !== undefined) events.push({ type: 'reasoning', text: reasoning })
    const toolCalls = (delta?.tool_calls ?? [])           
                    
                 
                                                      
      
    for (const call of toolCalls) {
      const event              = { type: 'tool_call', index: call.index ?? 0 }
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
  /**
   * ⚠️ **既没有 `choices`、也没有 `error`、也没有 `message` 的帧**，以前会被
   * 当成「合法但空」直接丢掉。绝大多数情况下这是对的（心跳、`[DONE]`、
   * 只有 `usage` 的尾帧），**但有一类必须救回来**：
   *
   * ```json
   * {"code":"RISK_CONTROL","message":"blocked"}   ← 有 message，走上面的分支
   * {"code":"RISK_CONTROL","data":{"blocked":1}}  ← 没有 message，掉到这里
   * {"error_code":"risk_control"}                  ← 同上
   * ```
   *
   * 实测（2026-10-27）：`{"code":"RISK_CONTROL","message":"blocked"}` 因为带
   * `message` 会走上面的网关分支、判成 `server`；但**只要上游把字段换个名字**，
   * 整帧就凭空消失 —— 用户看到的是「回复是空的」，完全不知道发生了什么。
   *
   * 所以这里补一条兜底：**有内容、但认不出是正文**的帧，只要文案像风控，
   * 就报一条明确的错误，而不是静默吞掉。
   *
   * 判据刻意窄：只认风控文案。其它认不出的帧保持原行为（丢弃），
   * 否则会把上游各种无意义的元数据帧都变成错误，把「跳过一帧」升级成「整轮失败」。
   */
  if (events.length === 0 && looksLikeRiskControl(raw)) {
    events.push({ type: 'error', failure: classifyStreamError(raw, '上游返回了风控拦截帧', undefined, headerDelayMs) })
  }
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
  response          ,
  onMalformed                            ,
  signal              ,
)                             {
  if (response.body === null) {
    yield {
      type: 'error',
      failure: { kind: 'server', message: '上游响应没有 body（不是流式响应？）', at: Date.now() },
    }
    return
  }
  const decoder = new TextDecoder('utf-8')
  const sse = new SseDecoder()
  /**
   * 兜底延迟：`Retry-After` 响应头（延迟优先序的第 4 档）。
   *
   * ⚠️ **只在 `translateChunk` 这一层读得到** —— 排队参数在体内（前三档），
   * 而头部在 `Response` 上。两者必须一起交给分类器，否则一个「只说了排队、
   * 没说等多久」的响应会丢掉服务端已经写明的时长。
   *
   * 用 `parseRetryAfter`（`core/errors.ts`）而不是自己 `Number(...)`：
   * 那一个函数已经处理了「纯数字走秒分支 / 负数判无效 / HTTP-date」三件事，
   * 各写一份必然漂移（参考实现 `retry-after.ts` 的模块注释专门讲过这个坑）。
   */
  const headerDelayMs = parseRetryAfter(response.headers, Date.now())
  // Node 的 web ReadableStream 支持异步迭代。
  const reader = (response.body                              ).getReader()
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
        const events = translateChunk(payload, headerDelayMs)
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
        for (const event of translateChunk(payload, headerDelayMs)) {
          if (event.type === 'finish') sawFinish = true
          yield event
        }
      }
    }
    for (const payload of sse.flush()) {
      if (payload.trim() === '[DONE]') continue
      for (const event of translateChunk(payload, headerDelayMs)) {
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
export function* translateNonStream(body         )                        {
  const parsed = body                           
  const choice = parsed?.choices?.[0]
  const message = choice?.message                                       
  const reasoning = reasoningOf(message)
  if (reasoning !== undefined) yield { type: 'reasoning', text: reasoning }
  const content = message?.content
  if (typeof content === 'string' && content !== '') yield { type: 'text', text: content }
  const usage = normalizeUsage(parsed?.usage)
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'stop' }
}


//# sourceURL=src/core/sse.ts