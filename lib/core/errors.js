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

/** 从响应头解析 Retry-After（秒或 HTTP-date）。 */
export function parseRetryAfter(headers                     , now        )                     {
  if (headers === undefined) return undefined
  const raw = headers.get('retry-after') ?? headers.get('x-ratelimit-reset-requests')
  if (raw === null || raw === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, at - now)
  return undefined
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


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\core\errors.ts