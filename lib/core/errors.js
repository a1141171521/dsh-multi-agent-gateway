/**
 * 错误分类：把「HTTP 状态 + 上游 body + 文案」压成稳定的 `ErrorKind`。
 *
 * **为什么要单独一层**：路由器只按 `ErrorKind` 决策（换号 / 重试 / 放弃），
 * 永远不解析错误文案。新增 Agent 时，如果上游有私有错误码，只在适配器的
 * `detectError()` 里加一条规则，**核心路由代码一行都不用动**。
 */

                                                        

/** 上游文案里表示「额度/余额/积分不足」的词。 */
const QUOTA_PATTERNS           = [
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
const RATE_LIMIT_PATTERNS           = [
  /\brate[\s_-]*limit(?:ed|s)?\b/i,
  /\btoo[\s_-]+many[\s_-]+requests\b/i,
  /\brequests?\s+per\s+(?:minute|second|hour|day)\b/i,
  /(?:请求|访问)(?:过于)?频繁/,
  /限流/,
]

/** 上游文案里表示「鉴权失效」的词。 */
const AUTH_PATTERNS           = [
  /\binvalid[\s_-]+(?:api[\s_-]*key|token|credential|auth)/i,
  /\b(?:token|key|credential|session)[\s_-]+(?:expired|revoked|invalid|malformed)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bauthentication[\s_-]+(?:fail|error|required)/i,
  /\bnot[\s_-]+signed[\s_-]+in\b/i,
  /\blogin[\s_-]+required\b/i,
  /(?:登录|登陆)(?:已)?(?:过期|失效)/,
  /(?:凭证|令牌|密钥)(?:无效|失效|过期)/,
]

/** 按顺序逐个试，命中即返回。 */
function matchAny(patterns          , text        )          {
  for (const pattern of patterns) {
    if (pattern.test(text)) return true
  }
  return false
}

/** 把任意 body 压成一段可搜索的文本（截断，避免把整个 body 拖进日志）。 */
export function flattenBody(body         , limit = 2000)         {
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
 * @param status - HTTP 状态码；0 表示请求没能到对端。
 * @param body - 已解析的 body（或原始文本）。
 * @param headers - 响应头（读 `retry-after` / `x-request-id`）。
 */
export function classify(status        , body         , headers          )            {
  const detail = flattenBody(body)
  if (status === 0) return 'network'
  if (status === 401) return 'auth'
  if (status === 403) {
    if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
    return 'auth'
  }
  if (status === 404) return 'not_found'
  if (status === 408 || status === 504) return 'network'
  if (status === 429) {
    if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
    return 'rate_limit'
  }
  if (status === 402) return 'quota'
  if (status >= 500) return 'server'
  if (status >= 400) {
    // 400/405/409/413/422 …：请求本身的问题，换账号也一样错。
    // 例外：有些上游把「额度耗尽 / 鉴权失效 / 限流」塞在 400 里，所以再看一眼文案。
    if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
    if (matchAny(AUTH_PATTERNS, detail)) return 'auth'
    if (matchAny(RATE_LIMIT_PATTERNS, detail)) return 'rate_limit'
    return 'bad_request'
  }
  // 2xx 里出现的「额度/鉴权」文案（部分上游 200 里塞错误体）也要认。
  if (matchAny(QUOTA_PATTERNS, detail)) return 'quota'
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
export function parseRetryAfter(headers                     , now        )                     {
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
export function parseRequestId(headers                     )                     {
  if (headers === undefined) return undefined
  for (const name of ['x-request-id', 'x-amzn-requestid', 'request-id', 'cf-ray', 'x-trace-id']) {
    const value = headers.get(name)
    if (value !== null && value !== '') return value
  }
  return undefined
}

/** 拼一个 `FailureInfo`。 */
export function failureOf(
  kind           ,
  message        ,
  options                                                                               = {},
)              {
  const info              = { kind, message, at: options.now ?? Date.now() }
  if (options.status !== undefined) info.status = options.status
  if (options.retryAfterMs !== undefined) info.retryAfterMs = options.retryAfterMs
  if (options.requestId !== undefined) info.requestId = options.requestId
  return info
}

/** 人类可读的错误名（UI 直接显示）。 */
export const ERROR_LABELS                            = {
  none: '正常',
  auth: '鉴权失效',
  rate_limit: '触发限流',
  quota: '额度耗尽',
  server: '上游故障',
  network: '网络异常',
  bad_request: '请求不合法',
  not_found: '接口不存在',
  unsupported: '上游不支持',
  unknown: '未知错误',
}


//# sourceURL=src/core/errors.ts