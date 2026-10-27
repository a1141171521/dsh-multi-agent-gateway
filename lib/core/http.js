/**
 * HTTP 层：一次调用 = 一次上游尝试。
 *
 * 只做四件事，但每件都不能省：
 *   1. **超时**（`AbortSignal.timeout` 或外部 signal 合并）—— 上游挂住不能拖死 DSH；
 *   2. **错误分类**（`classify`）—— 路由器唯一的决策输入；
 *   3. **请求 id / Retry-After 提取** —— 排查与退避都要；
 *   4. **凭证脱敏后的日志** —— 硬规则，任何日志不许出现完整 token。
 *
 * 刻意**不做自动重试**：重试是核心层（`router`）的职责，因为它要决定
 * 「换账号」还是「同一个号再来一次」，而这一层看不见账号。
 */

import { classify, flattenBody, parseRequestId, parseRetryAfter } from './errors.js'
import { redactSecret } from './crypto.js'
import { readFileSync } from 'node:fs'
                                                                                 

/**
 * 本插件自己的版本号 —— 给默认 `user-agent` 用。
 *
 * ⚠️ **必须从 `package.json` 读，不能写死**。原先这里是字面量
 * `'dsh-multi-agent-gateway/0.2.1'`，于是每次发版都会漏改一处：
 * 版本号散布在 4 个文件（`package.json` / `package-lock.json` /
 * `plugin.json` / 这里），发版时改前三个、忘第四个是常态，
 * 结果是对上游宣称了一个不存在的版本。发 `0.2.2` 时顺手改成自读。
 *
 * 路径用 `import.meta.url` 相对定位：`src/core/http.ts` 与 `lib/core/http.js`
 * 都在根目录下一层，`../../package.json` 两边都对。
 *
 * 读不到就退回 `0.0.0` 并**不抛错** —— UA 只是礼貌性标识，
 * 不能因为读不到文件就让整条 HTTP 链路起不来。
 */
let cachedVersion                    
export function pluginVersion()         {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed          = JSON.parse(raw)
    const version = typeof parsed === 'object' && parsed !== null
      ? (parsed                         ).version
      : undefined
    cachedVersion = typeof version === 'string' && version !== '' ? version : '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

/** 把两个 signal 合成一个（Node 20+ 有 `AbortSignal.any`，这里留个兜底）。 */
function combineSignals(left                         , right                         )                          {
  if (left === undefined) return right
  if (right === undefined) return left
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([left, right])
  const controller = new AbortController()
  const abort = ()       => controller.abort()
  left.addEventListener('abort', abort, { once: true })
  right.addEventListener('abort', abort, { once: true })
  return controller.signal
}

/** 判断一个异常是不是超时/中止。 */
export function isAbortError(error         )          {
  if (error === null || typeof error !== 'object') return false
  const name = (error                      ).name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * 造一个 `HttpFn`。
 *
 * @param log - 日志器（会打每个请求的方法/主机/状态/耗时；**不含凭证**）。
 * @param defaultTimeoutMs - 缺省超时。
 */
export function createHttp(log        , defaultTimeoutMs = 60000)         {
  const impl         = async (url        , init           = {})                      => {
    const method = init.method ?? 'GET'
    const timeoutMs = init.timeoutMs ?? defaultTimeoutMs
    const started = Date.now()
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // url 不合法时原样打出来，让上游的报错说话。
    }

    let signal                         
    try {
      signal = combineSignals(init.signal, AbortSignal.timeout(timeoutMs))
    } catch {
      signal = init.signal
    }

    const headers                         = { ...(init.headers ?? {}) }
    if (headers['user-agent'] === undefined) headers['user-agent'] = `dsh-multi-agent-gateway/${pluginVersion()}`

    let response          
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(signal === undefined ? {} : { signal }),
        redirect: 'follow',
      })
    } catch (error) {
      const message = isAbortError(error)
        ? `请求超时（${timeoutMs}ms）或已被取消`
        : error instanceof Error
          ? error.message
          : String(error)
      const kind            = 'network'
      log.warn(`${method} ${host} 传输层失败`, message)
      return {
        ok: false,
        status: 0,
        kind,
        headers: new Headers(),
        body: undefined,
        text: '',
        message,
      }
    }

    let text = ''
    try {
      text = init.raw === true ? '' : await response.text()
    } catch (error) {
      text = ''
      log.warn(`${method} ${host} 响应体读取失败`, error instanceof Error ? error.message : String(error))
    }

    let body          = text
    if (init.raw !== true && text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    } else if (text === '') {
      body = undefined
    }

    const kind = classify(response.status, body ?? text, response.headers)
    const retryAfterMs = parseRetryAfter(response.headers, Date.now())
    const requestId = parseRequestId(response.headers)
    const elapsed = Date.now() - started
    const summary = `${method} ${host} -> ${response.status} (${elapsed}ms)`
    if (response.ok && (kind === 'none' || kind === 'not_found')) {
      log.debug(summary)
    } else if (kind === 'not_found') {
      // 能力探测里的 404 是正常结果，不刷 warn。
      log.debug(summary)
    } else {
      const detail = flattenBody(body ?? text, 500)
      log.warn(summary, redactSecret(detail) || '(空响应体)')
    }

    const result             = {
      ok: response.ok,
      status: response.status,
      kind,
      headers: response.headers,
      body,
      text,
    }
    if (requestId !== undefined) result.requestId = requestId
    if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs
    if (!response.ok) result.message = flattenBody(body ?? text, 400) || `HTTP ${response.status}`
    return result
  }
  return impl
}

/**
 * 把 `AccountCredentials` 变成请求头。
 *
 * 三种形态都支持，因为不同 Agent 用不同形态（OpenCode 用 bearer，Qoder 用 cookie）：
 *   - `token` → `Authorization: Bearer <token>`
 *   - `cookie` → `Cookie: <cookie>`
 *   - `headers` → 原样合并（**允许覆盖**，方便个别 Agent 用 `x-api-key`）
 */
export function authHeaders(credentials   
                
                 
                                  
 )                         {
  const headers                         = { accept: 'application/json' }
  if (typeof credentials.token === 'string' && credentials.token !== '') {
    headers.authorization = `Bearer ${credentials.token}`
  }
  if (typeof credentials.cookie === 'string' && credentials.cookie !== '') {
    headers.cookie = credentials.cookie
  }
  if (credentials.headers !== undefined) {
    for (const [key, value] of Object.entries(credentials.headers)) {
      if (typeof value === 'string' && value !== '') headers[key.toLowerCase()] = value
    }
  }
  return headers
}

/** 合并请求头（后者覆盖前者，键统一小写）。 */
export function mergeHeaders(...layers                                           )                         {
  const out                         = {}
  for (const layer of layers) {
    if (layer === undefined) continue
    for (const [key, value] of Object.entries(layer)) out[key.toLowerCase()] = value
  }
  return out
}


//# sourceURL=src/core/http.ts