/**
 * **上游排队**错误的共享解析（Qoder 业务码 `10605`）。
 *
 * ## 为什么单独成模块
 *
 * 排队的**识别**发生在两处，而**解析逻辑必须只有一份**（否则必然漂移）：
 *
 * | 位置 | 场景 |
 * |---|---|
 * | `core/sse.ts` 的 `translateChunk` | HTTP **200** + 流内 `{code:"10605",…}` 帧 |
 * | 适配器的 HTTP 分支 | HTTP **4xx** + 排队 JSON 体 |
 *
 * 放在 `core/` 而不是某个适配器里：适配器 import 核心层是单向的，
 * 反向依赖会成环。
 *
 * ## 关键结构：`message` 是「一个 JSON 字符串」
 *
 * ```json
 * {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
 * ```
 *
 * 必须**二次解析** —— 客户端 `lFc()` 正是为此递归遍历
 * `data`/`result`/`message`/`body`，遇到字符串再 `JSON.parse`。
 * **只读顶层 `code` 永远拿不到排队参数**（这是参考实现第一版修复漏掉 SSE
 * 通道的根因）。我们的真实报文就是这一形态，所以这条是硬要求。
 *
 * ## 客户端权威实现（参考实现 obf 产物取证）
 *
 * - 排队码 `mRA="10605"` → `model_queued`；认证码 `MF="105"` → `auth_error`
 *   —— **互相独立**，绝不能合并；
 * - 延迟优先序（`kJa()`/`EV()`/`IRA()`）：`retry_after_ms` → `retryAfterMs`
 *   → `retryAfterSeconds × 1000` → 兜底 `Retry-After` 响应头；
 * - 决策（`W7c()`）：**有延迟就精确等它**，没有才退回指数退避。
 */

/** Qoder 的排队业务码（客户端 obf 产物里的 `mRA`）。 */
export const QUEUE_BUSINESS_CODE = '10605'

/**
 * Qoder 的**额度当天耗尽**业务码（`Billing daily count exceeded`）。
 *
 * ## 为什么必须与排队**分开**处理
 *
 * 参考实现记录过一模一样的坑：它原先被归成 **`server`**，而 `server` 在
 * harness 的 `DEFAULT_RETRYABLE_CODES` 里 → **白重试 5 次（≈15.5 秒）**。
 *
 * ⚠️ 语义差异是本质的，不是风格问题：
 * - `10605` 排队：**暂时**受阻 —— 等若干秒即可通过；
 * - `110` 额度：**当天耗尽** —— 立刻重试、等 15 秒重试、等 30 分钟重试，
 *   结果都一样（故**必须立即失败**，并把真实原因如实告诉用户）。
 */
export const BILLING_BUSINESS_CODE = '110'

/** 业务码是否命中**排队**（兼容字符串与数字两种编码）。 */
export function isQueueBusinessCode(code: unknown): boolean {
  return code === QUEUE_BUSINESS_CODE || code === Number(QUEUE_BUSINESS_CODE)
}

/** 业务码是否命中**额度用尽**（兼容字符串与数字两种编码）。 */
export function isBillingBusinessCode(code: unknown): boolean {
  return code === BILLING_BUSINESS_CODE || code === Number(BILLING_BUSINESS_CODE)
}

/**
 * 从错误体里提取**额度类**文案（码值之外的兜底判据）。
 *
 * ⚠️ **为什么要文案兜底**：`110` 这个码值在参考实现的客户端产物里**没有硬编码**
 * （搜 `X="110"` 与 `daily count exceeded` 均未命中），说明它由服务端下发。
 * 若上游哪天改用别的码值表达同一语义，只认码就会漏判 —— 故两者都认。
 *
 * ⚠️ 关键词必须**窄**：`balance` / `quota` 这类泛词会误伤正常内容
 * （例如模型正文里恰好讨论「余额」）。故只认明确的英文错误短语。
 */
export function looksLikeBillingError(text: string): boolean {
  return /billing\s+daily\s+count\s+exceeded|daily\s+count\s+exceeded|billing_error/i.test(text)
}

/** 排队错误里我们关心的字段（参考实现 `PJa()` 的裁剪版）。 */
export interface QueueInfo {
  isQueued?: boolean
  modelKey?: string
  queueCount?: number
  queueType?: string
  serviceAvailable?: boolean
  retryAfterSeconds?: number
  waitTime?: number
  /** 毫秒口径的延迟（客户端 `kJa()` 优先取这个）。 */
  retry_after_ms?: number
  retryAfterMs?: number
}

/** 只接受有限数字（与客户端的 `RE()` 同口径）。 */
function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 递归展开时要跟进的键。
 *
 * 前四个（`data`/`result`/`message`/`body`）逐字对齐参考实现的 `lFc()`。
 *
 * ⚠️ **`error` 是我们刻意加上的第五个**（对参考实现的**超集**，不改变它的语义）：
 * `translateChunk` 有两个错误分支，而 OpenAI 标准那一支的形态是
 * `{"error":{"message":"…"}}` —— 排队参数若被上游塞进 `error.message`（标准形状的
 * 外壳 + 内层排队 JSON），只按前四个键就**展开不到它** ⇒ 那一支会静静地退回 `server`
 * ⇒ 又变回「白重试 5 次」。
 *
 * 参考实现没踩到这个坑是因为它那条链路里 Qoder 的信封形态固定走顶层 `message`；
 * 我们的两个分支要共用同一份判据，所以键集必须是并集。
 *
 * 多这一个键**不会放大误判**：能成为候选的前提是该节点带 `isQueued` /
 * `serviceAvailable` 这类**排队专有**字段，普通错误体根本进不了候选集。
 */
const NESTED_KEYS = ['data', 'result', 'message', 'body', 'error'] as const

/**
 * 把错误体（或错误帧的 `message`）展开成一串节点，**字符串会尝试二次解析**。
 *
 * 广度优先，带 `seen` 去重（对象可能被自引用或有共享子对象，不去重会死循环）。
 * 解析不了的字符串**静默忽略** —— 它只是普通文案，不是内嵌 JSON。
 */
function expandNodes(body: unknown): Array<Record<string, unknown>> {
  let root: unknown = body
  if (typeof body === 'string') {
    try {
      root = JSON.parse(body)
    } catch {
      return []
    }
  }
  if (root === null || typeof root !== 'object') return []

  const seen = new Set<unknown>()
  const nodes: Array<Record<string, unknown>> = []
  const queue: unknown[] = [root]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === null || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    const record = node as Record<string, unknown>
    nodes.push(record)
    for (const key of NESTED_KEYS) {
      const value = record[key]
      if (value !== null && typeof value === 'object') queue.push(value)
      else if (typeof value === 'string' && value.length > 0) {
        try {
          queue.push(JSON.parse(value))
        } catch {
          // 非 JSON（普通错误文案），忽略。
        }
      }
    }
  }
  return nodes
}

/**
 * 从一段响应体（或错误帧的 `message`）里解析**排队信息**；不是排队则 undefined。
 *
 * ## ⚠️ 两种入参形态都必须支持（踩过的坑）
 *
 * 1. **外层整体**：`{"code":"10605","message":"{…}"}` —— HTTP 4xx 形态；
 * 2. **内层消息**：`{"isQueued":true,…,"retryAfterSeconds":30}` —— SSE 错误帧形态。
 *
 * ⚠️ **内层没有 `code` 字段**！若要求「必须命中 code 才算排队」，形态 2 会被判成
 * undefined —— 参考实现第一版就这么写的，实测导致 SSE 通道修复**静默失效**
 * （探针显示 `sleep 次数 = 0`，错误照旧抛 `server`）。
 *
 * 故判据改为：**命中 `code=10605`，或直接出现排队字段（`isQueued` /
 * `serviceAvailable`）** 即视为排队。
 *
 * ## ⚠️ 不能要求 `isQueued === true`
 *
 * 瞬时排队（服务端可立即处理）实测为
 * `isQueued:false, serviceAvailable:true, waitTime:0, retryAfterSeconds:2`
 * —— 用户报告「一次重试就能成功」，正是这一形态。若要求 `true`，
 * 它会落到兜底退避（参考实现写单测时实测到了：期望 2000ms 实际 1000ms）。
 *
 * @param body - 响应体原文、已解析对象，或错误帧的 `message` 字符串。
 * @returns 排队信息；既没命中 `10605` 也没有排队字段时 undefined。
 */
export function parseQueueError(body: unknown): QueueInfo | undefined {
  const nodes = expandNodes(body)
  if (nodes.length === 0) return undefined

  // 取第一个含排队标志的节点（客户端 `dFc()`/`PJa()` 同口径）。
  const info = nodes.find((node) => node.isQueued !== undefined || node.serviceAvailable !== undefined)
  if (info === undefined) return undefined

  // 业务码命中 **或** 含排队标志即视为排队。
  const codeHit = nodes.some((node) => isQueueBusinessCode(node.code))
  if (!codeHit && info.isQueued === undefined) return undefined

  const out: QueueInfo = {}
  if (typeof info.isQueued === 'boolean') out.isQueued = info.isQueued
  if (typeof info.modelKey === 'string' && info.modelKey.length > 0) out.modelKey = info.modelKey
  if (typeof info.queueType === 'string' && info.queueType.length > 0) out.queueType = info.queueType
  if (typeof info.serviceAvailable === 'boolean') out.serviceAvailable = info.serviceAvailable
  for (const key of ['queueCount', 'retryAfterSeconds', 'waitTime', 'retry_after_ms', 'retryAfterMs'] as const) {
    const value = readFiniteNumber(info[key])
    if (value !== undefined) out[key] = Math.trunc(value)
  }
  return out
}

/**
 * 一条错误体是否命中**额度当天耗尽**。
 *
 * 判据 = 业务码 `110` **或** 明确的额度文案（见 {@link looksLikeBillingError}）。
 * 任一命中即算 —— 上游换码值时不至于漏判。
 *
 * ⚠️ 与 {@link parseQueueError} 的**顺序**：先判排队。两者理论上互斥
 * （排队体不含 billing 文案），但真实故障里见过同一个信封同时带 `code:10605`
 * 与其它噪声字段，先认排队更安全。
 */
export function isBillingErrorBody(body: unknown): boolean {
  const nodes = expandNodes(body)
  if (nodes.some((node) => isBillingBusinessCode(node.code))) return true
  if (typeof body === 'string' && looksLikeBillingError(body)) return true
  return nodes.some((node) => typeof node.message === 'string' && looksLikeBillingError(node.message))
}

/**
 * 排队延迟的**封顶**（毫秒）。防止一个畸形/恶意的 `retryAfterSeconds` 把资源锁死。
 *
 * ## ⚠️ 与参考实现的一处**有意偏离**（10 秒 → 30 分钟）
 *
 * 参考实现的 `QUEUE_MAX_DELAY_MS` 是 **10 秒**，理由是「避免一次阻塞 30 秒让 UI
 * 长期停在运行中且无法区分排队与卡死」。**那个理由在我们的链路里不成立** ——
 * 因为它那条链路是「在请求内部 `sleep` 后重试」（进程真的挂在那里等），
 * 而我们不 sleep：`retryAfterMs` 交给 `router.penaltyMsFor()` 变成**账号冷却**，
 * 请求立刻带着明确原因返回给用户，界面不会停在「运行中」。
 *
 * 所以把 10 秒照搬过来会**重新引入本次要修的缺陷**：上游明说等 30 秒，
 * 我们 10 秒就放行 ⇒ 账号被重新选中 ⇒ 再撞同一个队列。
 * 取 30 分钟与 `router.RETRY_AFTER_CAP_MS` 同档，全仓库只有一个「封顶」概念。
 */
export const QUEUE_MAX_DELAY_MS = 30 * 60 * 1000

/**
 * 算出本次排队该等多久（毫秒）；无法判定时返回 undefined（交调用方退避）。
 *
 * 取值优先序：`retry_after_ms` → `retryAfterMs` → `retryAfterSeconds × 1000`，
 * 命中即用并**封顶** {@link QUEUE_MAX_DELAY_MS}。
 *
 * ⚠️ **非法值一律忽略而不是当 0**：客户端 `W7c()` 对非有限/负值直接判 fail。
 * 当 0 会变成「立即重试」的忙循环，把机会瞬间烧掉。
 *
 * ⚠️ **`0` 与 `undefined` 是两件事**：上游明说「立刻可重试」时 `0` 是对的，
 * 调用方必须用 `=== undefined` 判空 —— 写成 falsy 判据会把「立即解除」
 * 换成默认退避，让本可立刻重试的请求白等。
 */
export function queueDelayMs(info: QueueInfo | undefined): number | undefined {
  if (info === undefined) return undefined
  const ms = readFiniteNumber(info.retry_after_ms) ?? readFiniteNumber(info.retryAfterMs)
  const fromSeconds = readFiniteNumber(info.retryAfterSeconds)
  const raw = ms ?? (fromSeconds === undefined ? undefined : fromSeconds * 1000)
  if (raw === undefined || raw < 0) return undefined
  return Math.min(Math.trunc(raw), QUEUE_MAX_DELAY_MS)
}

/**
 * 给用户看的**人话**排队说明（**不要把裸 JSON 丢出去**）。
 *
 * 用户报障时看到的就是那坨
 * `{"isQueued":true,…,"subCode":"RESOURCE_LIMIT"}` —— 它既没说「排队」，
 * 也没说「等多久」，而 `RESOURCE_LIMIT` 这个子码更是**误导**：它是**容量**
 * 限制，不是**额度**限制（用户的合理反应是去查额度，而额度其实是好的）。
 *
 * @param info - {@link parseQueueError} 的结果。
 * @param delayMs - {@link queueDelayMs} 的结果（可能因封顶而小于上游值）。
 */
export function describeQueueError(info: QueueInfo, delayMs: number | undefined): string {
  const parts: string[] = ['上游排队中']
  if (typeof info.queueType === 'string' && info.queueType !== '') parts[0] = `上游排队中（${info.queueType} 队列）`
  if (delayMs !== undefined && delayMs > 0) {
    parts.push(`约 ${Math.round(delayMs / 1000)} 秒后重试`)
  } else {
    parts.push('稍后重试')
  }
  // ⚠️ 明确否定「额度」这个误读 —— 用户已经因为 RESOURCE_LIMIT 这个名字
  // 去查了一次额度，别让他再查第二次。
  parts.push('这是容量排队，不是你的额度用尽')
  return `${parts.join('，')}。`
}
