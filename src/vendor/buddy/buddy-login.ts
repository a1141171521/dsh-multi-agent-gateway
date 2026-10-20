/**
 * WorkBuddy / CodeBuddy 系（腾讯）的**登录协议层**：URL 装饰、token/account 解析、
 * 凭据组装。
 *
 * 事实来源：`dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/buddy-oauth.ts`
 * 与 `buddy.ts`。这里只放**纯函数**：不持 ctx、不发请求、不碰时钟以外的全局状态。
 * 发请求由 `src/adapters/buddy.ts` 用 `ctx.fetch` 完成。
 *
 * ## ⚠️ 这个文件里最重要的一件事：字段名是 **camelCase**
 *
 * 参考实现的 `parseTokenData`（`buddy.ts:331-344`）读的是 **`accessToken` /
 * `refreshToken` / `expiresIn` / `refreshExpiresIn`**（camelCase），带一条
 * **e2e 实证（2026-09-11）**：「`/v2/plugin/auth/token` 实际只返回
 * `expiresIn` / `refreshExpiresIn`（相对秒数），**没有** `expiresAt`」。
 *
 * 而我们原来的 `pollLogin` 读的是 **`data.access_token`**（snake_case）——
 * 那个形状**只出现在凭据文件里**（`BuddyCredential.access_token`，见参考
 * `buddy.ts:111`），**不是** `auth/token` 的响应形状。两处命名不同的原因：
 * 上游的 `auth/token` 回 camelCase，落盘时由 `buildCredential` 转成 snake_case。
 *
 * 结果：`data.access_token` 恒为 `undefined` ⇒ 恒判「还没检测到登录」⇒
 * **用户授权完成后仍然一直 pending，账号永远加不进来**。这正是用户报的
 * 「workbuddy 授权登录后，并没有加入账号进来」。
 *
 * ☞ 本模块**两种都认**（camelCase 优先，snake_case 兜底）：camelCase 有参考实现
 * 的 e2e 实证；snake_case 是防御性的（万一某个产品/版本回蛇形，不至于又静默 pending）。
 * 但**判据的方向不能反** —— 见 `parseTokenPayload` 的注释。
 */

import { randomUUID } from 'node:crypto'

/** 轮询账户端点：`GET /v2/plugin/login/account?state=...`。 */
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'

/** token 尚未就绪（继续轮询）。 */
export const CODE_TOKEN_NOT_READY = 11217

/** 账户信息尚未完成（继续轮询）。 */
export const CODE_ACCOUNT_NOT_READY = 12151

/** 登录 URL 上追加的产品版本参数名。 */
const SESSION_VERSION_PARAM = 'version'
/** 登录 URL 上追加的会话 id 参数名。 */
const SESSION_ID_PARAM = 'loginSessionId'

/** `auth/token` 解析出的令牌数据（字段名已归一到 camelCase）。 */
export interface BuddyTokenData {
  accessToken: string
  refreshToken: string
  /**
   * 绝对过期时刻（毫秒）。
   *
   * ⚠️ 上游**通常不下发绝对值**，只给相对秒数 `expiresIn`（e2e 实证 2026-09-11）。
   * 故这里可能是 `undefined` —— 调用方应回退到解析 access_token 这个 JWT 的 `exp`
   * （它同样是权威的过期时刻）。**不要**把它当成「永不过期」。
   */
  expiresAt?: number
}

/** `login/account` 解析出的账户数据（字段名照参考实现，不自创）。 */
export interface BuddyAccountData {
  uid: string
  nickname: string
  enterpriseId: string
  accountType: string
}

// ───────────────────────────── 安全读取 ─────────────────────────────

/** 去掉控制字符（含 CR/LF/Tab）并把连续空白折叠为单个空格。 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/**
 * 读字符串字段（兼容后端把数字返回成 number）。
 *
 * ⚠️ 剔除控制字符不是洁癖：参考实现实测 CodeBuddy 的 `scope` 字段有时返回多行文本
 * （`"profile\n    offline_access\n    email"`）。这些换行会被凭据的 JSON 字符串原样
 * 携带，落盘到 YAML 时被当作多行标量，**破坏 JSON 结构** —— 重新读取时 `JSON.parse`
 * 失败，表现为「有效期/昵称等字段丢失」（实际是整个凭据读不出来）。
 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value === 'string') return stripControlChars(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 读数值（兼容数字型字符串）；读不到返回 `undefined`。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/** 收窄成「非 null 的对象」。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** 从 JWT 载荷取字段（不验签，只用于展示与续期调度）。 */
function jwtClaim(token: string, key: string): string {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    const record = asRecord(payload)
    if (record === null) return ''
    const value = record[key]
    return typeof value === 'string' ? stripControlChars(value) : ''
  } catch {
    return ''
  }
}

/** 从 JWT 的 `exp` 读绝对过期时刻（毫秒）。 */
function jwtExpiresAtMs(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    const exp = asRecord(payload)?.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

// ───────────────────────────── URL 装饰 ─────────────────────────────

/**
 * 按产品配置装饰登录 URL。
 *
 * 国际版（`appendSessionParams: true`）需要额外携带：
 *   - `version`        —— 产品版本号（`pluginVersion`）
 *   - `loginSessionId` —— 客户端生成的 UUID，仅用于服务端日志追踪
 *
 * 参考实现的原话：「实测无校验语义，故每次登录生成新值均可」，故这里**每次调用
 * 都产一个新 UUID**（不要在 beginLogin 之外复用它）。
 *
 * ⚠️ **只追加参数，不得重建 URL** —— `platform` / `state` / 路径全部来自服务端
 * `auth/state` 下发的 `authUrl`。用 `URL.searchParams.set` 正是为了这个：
 * 它保留原有的所有查询参数与顺序，不碰路径。
 *
 * ⚠️ `authUrl` 非法（不是合法 URL）时**原样返回**，交由后续流程报错 ——
 * 装饰失败不该把「拿不到登录链接」伪装成「登录链接有问题」。
 *
 * @param authUrl - 服务端下发的登录地址
 * @param product - 产品配置（`appendSessionParams` / `pluginVersion`）
 * @param makeSessionId - 生成会话 id 的注入点（单测用来断言「每次都是新值」）
 */
export function decorateLoginUrl(
  authUrl: string,
  product: { appendSessionParams: boolean; pluginVersion?: string },
  makeSessionId: () => string = randomUUID,
): string {
  if (!product.appendSessionParams) return authUrl
  try {
    const url = new URL(authUrl)
    const version = product.pluginVersion
    if (typeof version === 'string' && version.length > 0) {
      url.searchParams.set(SESSION_VERSION_PARAM, version)
    }
    url.searchParams.set(SESSION_ID_PARAM, makeSessionId())
    return url.toString()
  } catch {
    return authUrl
  }
}

// ───────────────────────────── 响应解析 ─────────────────────────────

/**
 * 从响应信封里取 `data`；**`null` 与缺失一视同仁**（都返回 `null`）。
 *
 * 参考实现的 `responseData` 把 `data === null` 也当成缺失 —— 因为
 * `{"code":11217,"msg":"…"}` 这种信封连 `data` 键都没有，而某些版本会显式发
 * `data: null`。两者语义都是「还没有数据」。
 */
export function responseData(body: unknown): Record<string, unknown> | null {
  const record = asRecord(body)
  if (record === null) return null
  return asRecord(record.data)
}

/** 从响应信封读业务码；非数字返回 0（= 「没有业务码」，不是失败）。 */
export function responseCode(body: unknown): number {
  const value = asRecord(body)?.code
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 从响应信封读人话原因；`msg` 与 `message` 都认。 */
export function responseMessage(body: unknown): string {
  const record = asRecord(body)
  if (record === null) return ''
  const msg = readString(record, 'msg')
  return msg !== '' ? msg : readString(record, 'message')
}

/**
 * 解析 `auth/token` 的 `data`。
 *
 * ## ⚠️ 字段名：camelCase 优先，snake_case 兜底（方向不能反）
 *
 * 参考实现的 e2e 实证（2026-09-11）表明上游回的是 **camelCase**
 * （`accessToken` / `refreshToken` / `expiresIn`）。这里额外认 snake_case 只是
 * 防御：万一某个产品线回蛇形，不至于又退化成「静默 pending」。
 *
 * ⚠️ **手里两个都有时以 camelCase 为准** —— 它是被实证过的那个。
 *
 * 过期时刻的两级回退（顺序与参考实现一致，理由都是实测换来的）：
 *   1. `expiresAt` / `expires_at`（绝对值，实测**通常不下发**）；
 *   2. `expiresIn` / `expires_in`（相对秒数，实测**实际下发的是这个**）
 *      ⇒ 以 access_token 的 JWT `iat` 为基准换算；没有 `iat` 就用当前时刻。
 *   3. 都没有 ⇒ `undefined`，由调用方回退到 JWT 的 `exp`。
 */
export function parseTokenPayload(data: unknown, now: number = Date.now()): BuddyTokenData {
  const record = asRecord(data)
  if (record === null) return { accessToken: '', refreshToken: '' }

  // camelCase 优先（有 e2e 实证），snake_case 兜底（防御）。
  const accessToken = readString(record, 'accessToken') || readString(record, 'access_token')
  const refreshToken = readString(record, 'refreshToken') || readString(record, 'refresh_token')

  const expiresAt = absoluteExpiryOf(record, 'expiresAt', 'expires_at') ?? relativeExpiryOf(record, accessToken, now)

  return {
    accessToken,
    refreshToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/** 绝对过期时刻（毫秒）：兼容 ISO 串 / 秒级 / 毫秒级时间戳。 */
function absoluteExpiryOf(record: Record<string, unknown>, camelKey: string, snakeKey: string): number | undefined {
  const raw = readString(record, camelKey) || readString(record, snakeKey)
  if (raw === '') return undefined
  if (/^\d+$/.test(raw)) {
    const value = Number(raw)
    // > 1e12 视为毫秒，否则视为秒
    return value > 1_000_000_000_000 ? value : value * 1000
  }
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * 相对过期时刻（毫秒）：`expiresIn` 是**相对秒数**（实测实际下发的就是这个）。
 *
 * ⚠️ 基准取 JWT 的 `iat` 而**不是**当前时刻：`expiresIn` 是相对**签发**时刻算的，
 * 用「解析当下」当基准会把有效期算长（网络慢/用户等了很久时误差可观）。
 * 参考实现取 `iat`，缺失才退到 `Date.now()`。
 */
function relativeExpiryOf(record: Record<string, unknown>, accessToken: string, now: number): number | undefined {
  const seconds = readNumber(record, 'expiresIn') ?? readNumber(record, 'expires_in')
  if (seconds === undefined) return undefined
  const issuedAt = jwtNumericClaim(accessToken, 'iat') ?? now
  return issuedAt + seconds * 1000
}

/** 从 JWT 载荷读数值型声明（秒 → 毫秒）。 */
function jwtNumericClaim(token: string, key: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    const value = asRecord(payload)?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析 `login/account` 的 `data`。
 *
 * ⚠️ 字段名照参考实现的 `parseAccountData`（`buddy.ts:353-362`）：
 * `uid` / `nickname` / `enterpriseId` / `type`。**别自创** —— 这是抓包字段名。
 *
 * `accountType` 缺省为 `'personal'`（参考实现的行为：`type` 为空串时给个人版）。
 */
export function parseAccountPayload(data: unknown): BuddyAccountData {
  const record = asRecord(data)
  if (record === null) return { uid: '', nickname: '', enterpriseId: '', accountType: 'personal' }
  const accountType = readString(record, 'type')
  // 企业 id 两种写法都认（与 buddy.ts 的 creditsHeaders 同一策略：只认一种会静默少发头）。
  const enterpriseId = readString(record, 'enterpriseId') || readString(record, 'enterprise_id')
  return {
    uid: readString(record, 'uid'),
    nickname: readString(record, 'nickname'),
    enterpriseId,
    accountType: accountType !== '' ? accountType : 'personal',
  }
}

/**
 * 把 token + account 组装成**本插件**的凭据形状。
 *
 * 本插件的 `AccountCredentials` 用的是 `token` / `refreshToken` / `expiresAt`
 * （见 `src/core/types.ts`），与参考实现的 `access_token` / `expires_at` 不同名
 * —— 转换只发生在这里，协议层内部的命名保持与参考实现一致，便于对照。
 *
 * 昵称回填顺序（参考实现的 e2e 实证 2026-09-11：`login/account` 的 `nickname`
 * **常为空**，真正的昵称只在 access_token 的 JWT 声明里）：
 *   `account.nickname` → JWT `nickname` → JWT `preferred_username` → JWT `name`。
 *
 * uid 同理：`account.uid` 为空时回退到 JWT 的 `sub`。
 */
export function buildCredentials(
  token: BuddyTokenData,
  account: BuddyAccountData,
): {
  token: string
  refreshToken?: string
  expiresAt?: number
  uid?: string
  nickname?: string
  enterpriseId?: string
  accountType?: string
  domain?: string
} {
  const nickname = account.nickname !== ''
    ? account.nickname
    : (jwtClaim(token.accessToken, 'nickname')
      || jwtClaim(token.accessToken, 'preferred_username')
      || jwtClaim(token.accessToken, 'name'))
  const uid = account.uid !== '' ? account.uid : jwtClaim(token.accessToken, 'sub')

  return {
    token: token.accessToken,
    ...(token.refreshToken === '' ? {} : { refreshToken: token.refreshToken }),
    // 绝对值缺失时回退到 JWT 的 exp —— 它同样是权威的过期时刻（参考实现同款回退）。
    ...((token.expiresAt ?? jwtExpiresAtMs(token.accessToken)) === undefined
      ? {}
      : { expiresAt: (token.expiresAt ?? jwtExpiresAtMs(token.accessToken)) as number }),
    ...(uid === '' ? {} : { uid }),
    ...(nickname === '' ? {} : { nickname }),
    ...(account.enterpriseId === '' ? {} : { enterpriseId: account.enterpriseId }),
    ...(account.accountType === '' ? {} : { accountType: account.accountType }),
  }
}

/** 给人看的账号标签：昵称优先，其次 uid，都没有返回空串（调用方回退默认标签）。 */
export function accountLabelOf(credentials: { nickname?: string; uid?: string }): string {
  if (typeof credentials.nickname === 'string' && credentials.nickname !== '') return credentials.nickname
  if (typeof credentials.uid === 'string' && credentials.uid !== '') return credentials.uid
  return ''
}
