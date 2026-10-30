/**
 * 错误分类：把「HTTP 状态 + 上游 body + 文案」压成稳定的 `ErrorKind`。
 *
 * **为什么要单独一层**：路由器只按 `ErrorKind` 决策（换号 / 重试 / 放弃），
 * 永远不解析错误文案。新增 Agent 时，如果上游有私有错误码，只在适配器的
 * `detectError()` 里加一条规则，**核心路由代码一行都不用动**。
 */

import type { ErrorKind, FailureInfo } from './types.js'

/** 上游文案里表示「额度/余额/积分不足」的词。 */
const QUOTA_PATTERNS: RegExp[] = [
  /\binsufficient[\s_-]+(?:quota|balance|credits?|funds?)\b/i,
  /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached|used\s+up)\b/i,
  /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i,
  /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted|insufficient)\b/i,
  /\bout[\s_-]+of[\s_-]+(?:credits?|budget|funds)\b/i,
  /\bno[\s_-]+(?:credits?|quota|balance)\b/i,
  /\bbilling[\s_-]+(?:hard[\s_-]+)?limit\b/i,
  /(?:余额|额度|积分|点数)(?:不足|不够|已用尽|已耗尽|已用完)/,
  /(?:欠费|超出(?:额度|配额))/,
]

/** 上游文案里表示「限流」的词（区别于额度耗尽）。 */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /\brate[\s_-]*limit(?:ed|s)?\b/i,
  /\btoo[\s_-]+many[\s_-]+requests\b/i,
  /\brequests?\s+per\s+(?:minute|second|hour|day)\b/i,
  /(?:请求|访问)(?:过于)?频繁/,
  /限流/,
]

/**
 * 渠道校验拒绝（`11-128`）。
 *
 * 两个入口都要认：
 *   1. **文案**：`Illegal API invocation from an unapproved channel` —— 上游给的是
 *      同一句英文 `msg`，与 code 是否被解析出来无关；
 *   2. **业务码**：`11-128`。⚠️ 原始报文里的连字符**不一定是 ASCII `-`**
 *      （实测出现过 U+2011 一类的非断行连字符），所以用字符类而不是字面量；
 *      另外 `"code":11-128` 这种裸值不是合法 JSON，`JSON.parse` 会失败、
 *      退化成原文 —— 这也要求判据能吃**纯文本**。
 *
 * 它读的是消息内容 / 渠道指纹，与账号、额度、网络都无关。**不能换号**。
 */
const CHANNEL_REJECT_PATTERNS: RegExp[] = [
  /illegal\s+api\s+invocation\s+from\s+an\s+unapproved\s+channel/i,
  /unapproved\s+channel/i,
  /(?:^|[^0-9])11\s*[-\u2010\u2011\u2012\u2013\u2014\u2015\uFF0D]\s*128(?:[^0-9]|$)/,
]

/**
 * 软限流的业务码（WorkBuddy `6004`）。
 *
 * 它可能走 400 也可能走 429，文案里只有「将在 … UTC+8 重置」这种**不含关键词**
 * 的说法。只认 `code: 6004` 这个字段，不做裸数字匹配（请求 id 里可能恰好有 6004）。
 */
const SOFT_RATE_LIMIT_CODE = /["']?code["']?\s*[:=]\s*"?6004\b/i

/** 上游文案里表示「鉴权失效」的词。 */
const AUTH_PATTERNS: RegExp[] = [
  /\binvalid[\s_-]+(?:api[\s_-]*key|token|credential|auth)/i,
  /\b(?:token|key|credential|session)[\s_-]+(?:expired|revoked|invalid|malformed)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bauthentication[\s_-]+(?:fail|error|required)/i,
  /\bnot[\s_-]+signed[\s_-]+in\b/i,
  /\blogin[\s_-]+required\b/i,
  /(?:登录|登陆)(?:已)?(?:过期|失效)/,
  /(?:凭证|令牌|密钥)(?:无效|失效|过期)/,
]

/**
 * 上游文案里表示**风控拦截**的词。
 *
 * ## 为什么要单独一类（而不是并进 `auth`）
 *
 * 风控和鉴权失效在**处置上**确实都是「换号 + 长冷却」，但**在界面上不能混**：
 * DSH 的 `failureMessage()` 对 `code === 'AUTH'` 是**硬编码覆盖**的 ——
 *
 * ```js
 * return code === "AUTH" ? t("message.failure.auth") : message;
 * ```
 *
 * 也就是说只要我们把 kind 报成 `auth`，上游那句「检测到异常请求，请完成验证」
 * 会被**整句丢掉**，用户看到的永远是「API 密钥无效」—— 而这跟密钥一点关系都没有，
 * 用户会跑去重新登录、重新贴 token，全是白费。
 *
 * （`QUOTA` 同样被覆盖成 `message.failure.quota`，`RATE_LIMIT` 则保留原文。）
 *
 * 所以风控必须有**自己的** kind：既能触发换号，又能让上游原话透到界面上。
 *
 * ## 关键词必须窄
 *
 * 宁可漏判（落到 `bad_request`，用户手动换号），也不要误伤：把正常业务报错
 * 判成风控会让账号被无谓地锁 30 分钟。故只认**明确的拦截语义**，
 * 不认 `error` / `denied` / `blocked` 这类泛词。
 */
const RISK_CONTROL_PATTERNS: RegExp[] = [
  /\brisk[\s_-]*(?:control|detected|triggered|engine)\b/i,
  /\b(?:abnormal|unusual|suspicious)[\s_-]+(?:request|activity|traffic|behaviou?r|login)\b/i,
  /\b(?:access|request)[\s_-]+(?:denied|rejected)[\s_-]+by[\s_-]+(?:risk|security)/i,
  // `flagged for abuse` 是 OpenAI / Anthropic 系最典型的风控措辞。
  /\bflagged[\s_-]+(?:for[\s_-]+)?(?:abuse|violation|suspicious|review)\b/i,
  /\b(?:account|user)[\s_-]+(?:has[\s_-]+been[\s_-]+)?(?:banned|suspended|disabled|restricted|frozen)\b/i,
  /\b(?:captcha|verification)[\s_-]+(?:required|challenge|needed)\b/i,
  /\b(?:complete|solve)[\s_-]+(?:the[\s_-]+)?(?:captcha|verification|challenge)\b/i,
  /\bdevice[\s_-]+(?:fingerprint|verification|anomal)/i,
  /\b(?:forbidden|blocked)[\s_-]+(?:by|due[\s_-]+to)[\s_-]+(?:risk|security|policy)/i,
  // 中文：上游国内平台多用这套措辞。
  // ⚠️ 中文不能像英文那样靠词边界，只能让「主体」和「动作」**各自可独立命中** ——
  // 写成 `(?:账号)(?:被)?(?:封禁)` 会漏掉「您的账号已被限制」这种中间夹字的形态。
  /(?:触发|命中|检测到)(?:了)?(?:风控|安全策略|风险控制)/,
  /(?:风控|风险)(?:拦截|校验|验证|限制)/,
  /(?:异常|可疑)(?:请求|访问|行为|登录|流量|操作)/,
  /(?:访问|请求)(?:被)?(?:拒绝|受限|拦截)/,
  // 主体 + 任意少量字符 + 动作：覆盖「账号已被限制」「账户被冻结」等。
  /(?:账号|账户|帐号)[^。，,;；]{0,6}(?:封禁|封停|限制|冻结|禁用|异常)/,
  /(?:需要|请完成)(?:验证|人机验证|滑块验证|短信验证)/,
  /(?:设备|环境)(?:异常|指纹|校验)/,
]

/** 按顺序逐个试，命中即返回。 */
function matchAny(patterns: RegExp[], text: string): boolean {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true
  }
  return false
}

/**
 * 这段文本看起来像不像**风控拦截**。
 *
 * 单独导出：流式路径（`core/sse.ts` 的 `classifyStreamError`）不走 `classify()`，
 * 但它必须用**同一套文案表**判定，否则两条路径会漂移 ——
 * 「非流式认得出风控、流式认不出」是最难查的那种不一致。
 */
export function looksLikeRiskControl(text: string): boolean {
  if (text === '') return false
  return matchAny(RISK_CONTROL_PATTERNS, text)
}

/** 把任意 body 压成一段可搜索的文本（截断，避免把整个 body 拖进日志）。 */
export function flattenBody(body: unknown, limit = 2000): string {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body.slice(0, limit)
  try {
    return JSON.stringify(body).slice(0, limit)
  } catch {
    return String(body).slice(0, limit)
  }
}

/**
 * 从 HTTP 状态码 + 上游 body 判定 `ErrorKind`。
 *
 * 判定顺序刻意如此：
 *   1. 状态码是**硬事实**，先按它定基线；
 *   2. 401/403 再细看文案 —— 有的上游把「额度耗尽」也报 403；
 *   3. 429 再细看文案 —— 有的上游把「余额不足」报 429；
 *   4. 4xx/5xx 之外的（0 = 传输层失败）一律 `network`。
 *
 * ## 风控的位置（2026-10-27 新增）
 *
 * `risk_control` 在**每个分支里都排在额度之后、其它之前**。理由：
 *   - 额度耗尽是「这个号今天没钱了」，风控是「这个号被盯上了」，两者都要换号，
 *     但额度判据更硬（有明确的码/文案），所以先认额度。
 *   - 风控必须**早于** `auth` 判定：403 里的风控若落到 `auth`，DSH 会把
 *     上游原话整句覆盖成「API 密钥无效」（见 `RISK_CONTROL_PATTERNS` 的注释）。
 *   - 风控必须**早于** 400 的 `bad_request` 兜底：否则「异常请求」会被判成
 *     「请求本身有问题」，于是**不换号**，用户就卡在这个号上一直失败。
 *
 * @param status - HTTP 状态码；0 表示请求没能到对端。
 * @param body - 已解析的 body（或原始文本）。
 * @param headers - 响应头（读 `retry-after` / `x-request-id`）。
 */
export function classify(status: number, body: unknown, headers?: Headers): ErrorKind {
  const detail = flattenBody(body)
  if (status === 0) return 'network'
  // ⚠️ 渠道校验必须**排在所有状态码分支之前**：11-128 走 400，报文里同时带着
  // 「请求被拦截，请重新发送」，会被风控表误判成 `risk_control` —— 于是换号 +
  // 30 分钟冷却 + 4 次判死，一次内容指纹就能把整个账号池逐个标失效。
  // 它读的是**消息内容/渠道指纹**，跟账号无关，换号只会白烧请求。
  if (matchAny(CHANNEL_REJECT_PATTERNS, detail)) return 'channel_reject'
  if (status === 401) {
    // 401 也可能夹着风控文案（少数上游用 401 表达「环境异常」）。
    if (matchAny(RISK_CONTROL_PATTERNS, detail)) return 'risk_control'
    return 'auth'
  }
  if (status === 403) {
    if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
    // ⚠️ 必须在 `return 'auth'` **之前**：否则风控被 DSH 显示成「API 密钥无效」。
    if (matchAny(RISK_CONTROL_PATTERNS, detail)) return 'risk_control'
    return 'auth'
  }
  if (status === 404) return 'not_found'
  if (status === 408 || status === 504) return 'network'
  if (status === 429) {
    if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
    if (matchAny(RISK_CONTROL_PATTERNS, detail)) return 'risk_control'
    return 'rate_limit'
  }
  if (status === 402) return 'quota'
  if (status >= 500) return 'server'
  if (status >= 400) {
    // 400/405/409/413/422 …：请求本身的问题，换账号也一样错。
    // 例外：有些上游把「额度耗尽 / 鉴权失效 / 限流 / 风控」塞在 400 里，所以再看一眼文案。
    // `6004` 是 WorkBuddy 的**软限流**业务码：文案可能只有「将在 … UTC+8 重置」，
    // 不含「限流/频繁」关键词，落到 `bad_request` 就变成「不换号也不重试」。
    if (SOFT_RATE_LIMIT_CODE.test(detail)) return 'rate_limit'
    if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
    // ★ 风控排在 auth 与 rate_limit 之前：它是**账号维度**的，换号有效。
    if (matchAny(RISK_CONTROL_PATTERNS, detail)) return 'risk_control'
    if (matchAny(AUTH_PATTERNS, detail)) return 'auth'
    if (matchAny(RATE_LIMIT_PATTERNS, detail)) return 'rate_limit'
    return 'bad_request'
  }
  // 2xx 里出现的「额度/鉴权/风控」文案（部分上游 200 里塞错误体）也要认。
  if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
  if (matchAny(RISK_CONTROL_PATTERNS, detail)) return 'risk_control'
  if (matchAny(AUTH_PATTERNS, detail)) return 'auth'
  if (matchAny(RATE_LIMIT_PATTERNS, detail)) return 'rate_limit'
  return 'none'
}

/**
 * 从响应头解析 Retry-After（秒数或 HTTP-date）→ 毫秒。
 *
 * ⚠️ **两个必须一致的细节，抄漏任一个都会静默出错**（逐字对齐参考实现
 * `dsh-our-free-model` 的 `retry-after.ts`，那两条都是真实缺陷换来的）：
 *
 * ## 细节 1：`0` 是合法值（「立即解除」）
 *
 * 返回 `0` 表示服务端明说「立刻可以重试」，与 `undefined`（服务端**没声明**）
 * 是两件事。调用方必须用 `=== undefined` 判空 —— 任何 falsy 判据会把「立即解除」
 * 变成「没声明」，再退到保守的兜底（例如退避一小时），让刚被限流的账号白白锁一小时。
 *
 * ## 细节 2：纯数字必须走「秒」分支，负数按无效处理
 *
 * `Date.parse` 对**畸形数字串**会给出「看起来合法」的结果，实测：
 *
 * ```
 * Date.parse('-5')  === 988646400000    // 被当成 ISO 年份 → 2001 年
 * Date.parse('900') === -33765926743000  // 被当成年份 900 → 1970 年前
 * ```
 *
 * 两者都通过 `Number.isFinite`，于是 `at - now` 会是个**巨大负数**，
 * 被 `Math.max(0, …)` 抹成 `0` = 「立即解除」—— **一个畸形的响应头就能让刚被
 * 限流的账号立刻被重新选中，形成无限空转**（参考实现 `opencode-product.ts`
 * 的注释里记着这个坑）。
 *
 * ⚠️ **本仓库真正踩到的是负数那一条**（2026-10-19 从 git 取旧实现实测）：
 * 旧版写成 `Number.isFinite(seconds) && seconds >= 0` —— 有 `>= 0` 守卫，
 * 所以 `'900'` 一直走的是秒分支、**从来不是洞**；只有**负数**（`'-5'` / `'-1'`）
 * 会掉过守卫落到 `Date.parse`，被抹成 `0`。
 *
 * 现在的写法把两件事分开：非负有限数走秒分支，**负数显式返回 `undefined`**
 * （= 服务端没声明），既不落到 `Date.parse`，也不假装「立即解除」。
 * 另外 `Math.round` 改成了 `Math.ceil`：宁可多等 1 毫秒，也不要少等。
 */
export function parseRetryAfter(headers: Headers | undefined, now: number): number | undefined {
  if (headers === undefined) return undefined
  const raw = headers.get('retry-after') ?? headers.get('x-ratelimit-reset-requests')
  if (raw === null || raw === '') return undefined
  // 先按「秒」判：放行非负有限数（`0` 合法，见细节 1）。
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1000) : undefined
  // 到这里才可能是 HTTP-date。`Date.parse` 只在这个分支上跑，见细节 2。
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

/** 从响应头抄一个上游请求 id（排查用）。 */
export function parseRequestId(headers: Headers | undefined): string | undefined {
  if (headers === undefined) return undefined
  for (const name of ['x-request-id', 'x-amzn-requestid', 'request-id', 'cf-ray', 'x-trace-id']) {
    const value = headers.get(name)
    if (value !== null && value !== '') return value
  }
  return undefined
}

/**
 * 从**响应体**里抠「几点重置」，返回距 `now` 的毫秒数。
 *
 * WorkBuddy 的 429 **不带** `Retry-After`（也没有 `X-RateLimit-*`），重置时刻写在
 * 报文里，而且自带时区声明：
 *
 * ```
 * {"code":6004,"msg":"…将在 2026-09-30 02:30:30 UTC+8 重置…"}
 * ```
 *
 * ⚠️ **必须按报文里的 `UTC±N` 换算**，不能按本机时区 —— 本机是 UTC+8 时「碰巧对」，
 * 换一台机器（或上游改成 UTC）就整体偏 8 小时。
 *
 * 认这几种写法（都要求带时区，宁可返回 undefined 也不猜）：
 *   - `2026-09-30 02:30:30 UTC+8`
 *   - `2026-09-30T02:30:30+08:00`
 *   - `2026-09-30 02:30:30 GMT+8`
 *   - `2026-09-30T02:30:30Z`
 *
 * 除了绝对时刻，也认**相对时长**（不少限流器不给时间戳，直接写「多久后重试」）：
 *   - `retry after:0s` / `retry-after: 12s` / `retry after 250ms`
 *   - `请 15 秒后重试`
 */
export function parseResetAtFromBody(body: unknown, now: number): number | undefined {
  const text = flushText(body)
  if (text === '') return undefined
  // 先认 `Z`（纯 UTC，没有偏移可算）。
  const zulu = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z\b/i.exec(text)
  if (zulu !== null) {
    const at = Date.parse(`${zulu[1]}T${zulu[2]}Z`)
    return Number.isFinite(at) ? Math.max(0, at - now) : undefined
  }
  const pattern =
    /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?/i
  const match = pattern.exec(text)
  if (match !== null) {
    const [, date, time, sign, hours, minutes] = match
    const offsetMinutes = (Number(hours) * 60 + Number(minutes ?? '0')) * (sign === '-' ? -1 : 1)
    // `Date.UTC` 按 UTC 解析，再减掉报文声明的偏移 ⇒ 得到真实时刻。
    const utcMs = Date.parse(`${date}T${time}Z`)
    if (!Number.isFinite(utcMs)) return undefined
    const at = utcMs - offsetMinutes * 60_000
    return Math.max(0, at - now)
  }
  return parseRelativeRetry(text)
}

/**
 * 相对时长 → 毫秒。
 *
 * 实测（商汤小浣熊限流器，2026-10-30）：
 *   `[200103] limiter_request_error：request exceed max time, retry after:0s`
 *
 * ⚠️ **`0s` 也抬到 1 秒**：上游那个 0 只是"没算出来"，路由层拿到 0 会把
 * 账号冷却设成 0（`penaltyMsFor` 里 0 是「立即解除」），下一轮立刻又选中它 ——
 * 那就是热循环。1 秒是「不空转」的下限，不是对上游承诺的改写（它本来就没承诺）。
 *
 * 不认没有单位的裸数字（`retry after: 30`）：那句话可能指秒、也可能指毫秒，
 * 猜错就是 30 秒 vs 30 毫秒的差别，宁可返回 undefined 让路由走默认退避。
 */
function parseRelativeRetry(text: string): number | undefined {
  const relative =
    /retry[\s_-]*after\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(ms|毫秒)/i.exec(text) ??
    /retry[\s_-]*after\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|秒)/i.exec(text) ??
    /(\d+(?:\.\d+)?)\s*秒(?:后|之后)\s*(?:再)?(?:重试|尝试)/.exec(text)
  if (relative === null) return undefined
  const amount = Number(relative[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = String(relative[2] ?? 's').toLowerCase()
  const ms = unit === 'ms' || unit === '毫秒' ? amount : amount * 1000
  return Math.max(1000, Math.round(ms))
}

/** 把 body 压成一段文本（对象走 JSON，字符串原样）。 */
function flushText(body: unknown): string {
  if (typeof body === 'string') return body
  if (body === null || body === undefined) return ''
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

/**
 * 这个异常是不是「用户取消了请求」。
 *
 * 判定顺序：信号已 abort 就是取消（最可信，跨运行时一致）；否则看 `name`/`code`
 * （Node 的 fetch 抛 `AbortError` / `ABORT_ERR`，浏览器侧 code 是 20）。
 *
 * ⚠️ 取消**不能**混进 `network`：路由层会把它当成上游故障去换号重试，
 * 用户点「停止」后还要多等 1~2 秒、多打几个真实请求。
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true
    const code = (error as { code?: unknown }).code
    if (code === 'ABORT_ERR' || code === 20) return true
  }
  return false
}

/** 拼一个 `FailureInfo`。 */
export function failureOf(
  kind: ErrorKind,
  message: string,
  options: { status?: number; retryAfterMs?: number; requestId?: string; now?: number } = {},
): FailureInfo {
  const info: FailureInfo = { kind, message, at: options.now ?? Date.now() }
  if (options.status !== undefined) info.status = options.status
  if (options.retryAfterMs !== undefined) info.retryAfterMs = options.retryAfterMs
  if (options.requestId !== undefined) info.requestId = options.requestId
  return info
}

/** 人类可读的错误名（UI 直接显示）。 */
export const ERROR_LABELS: Record<ErrorKind, string> = {
  none: '正常',
  auth: '鉴权失效',
  rate_limit: '触发限流',
  quota: '额度耗尽',
  risk_control: '触发风控',
  server: '上游故障',
  network: '网络异常',
  bad_request: '请求不合法',
  channel_reject: '渠道校验失败',
  not_found: '接口不存在',
  unsupported: '上游不支持',
  aborted: '已取消',
  unknown: '未知错误',
}
