/**
 * TRAE 协议里的 **JSON 安全读取**与 **凭据形状**。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae.ts`。
 * 本模块只放**可单测的纯函数**，与网络 I/O 分离 —— 这样协议细节能被单测直接覆盖，
 * 不需要 mock fetch。
 */

import { createHash } from 'node:crypto'

// ── JSON 安全读取 ──

/**
 * 从 JSON 安全读取字符串字段（兼容后端把数字返回成 number）。
 *
 * ⚠️ 不要写成 `String(source[key] ?? '')`：那会把 `null` 变成 `"null"`、
 * 把整个对象变成 `"[object Object]"`，于是「字段缺失」被伪装成一个合法字符串。
 */
export function readStringField(source                         , key        )         {
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 从 JSON 安全读取数字字段（兼容字符串形态的数字）。
 *
 * ⚠️ 只接受**纯数字串**（正则严格匹配）：`Number('')` 是 `0`、`Number('  ')` 是 `0`、
 * `Number('0x10')` 是 `16` —— 宽松转换会把一堆「不是数字」的东西变成数字。
 */
export function readNumberField(source                         , key        )                     {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/**
 * 从 JSON 安全读取布尔字段。
 *
 * 只有**明确**的布尔语义才返回值：字段缺失返回 `undefined`。
 *
 * ⚠️ 「上游没说」与「上游说 false」是**两回事** —— 调用方据此决定是否过滤
 * （见 `isTraeModelCallable`：`undefined` 一律放行，`false` 才拦）。
 * 不接受任意 truthy 值：空字符串在 JS 里是 falsy，把它当成 `false`
 * 会是一个没有依据的断言。
 */
export function readBooleanField(source                         , key        )                      {
  const value = source[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true') return true
  if (value === 0 || value === 'false') return false
  return undefined
}

/** 宽松解析 JSON 对象字符串；非对象（数组 / 标量 / 非法 JSON）返回 undefined。 */
export function parseJsonObject(raw        )                                      {
  try {
    const parsed          = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed                           
  } catch {
    return undefined
  }
}

// ── 凭据形状 ──

/**
 * 持久化的 TRAE 凭据。
 *
 * 字段名与参考实现的 `TraeCredential` 对齐（snake_case，与 Go 端 `auth.Auth` 结构一致）。
 *
 * ## 两个必须持久化的设备标识
 *
 * - `machine_id`：32 位 hex 字符串（设备指纹）。**不可每次重新生成** ——
 *   上游按 `machine_id` 标识设备，换值可能触发风控或要求重新登录。
 * - `device_id`：32 位 hex 字符串（`openssl rand -hex 16` 的产物）。
 *   ⚠️ **每个账号必须有自己的 device_id**：同一天内两个账号共用同一个
 *   device_id 会让签到互斥（第二个账号报「该设备已签到」）。
 *   ⚠️ 空值会让签到报 **9004**。
 *
 * 本期凭据以**手工粘贴**为主：用户至少要提供 `access_token`；`uid` 可从
 * `GetUserInfo` 补，`machine_id` / `device_id` 由本插件按账号 id 确定性派生
 * （见 `trae-identity.ts`），因此用户**不必**手工填这两项。
 */
                                 
                                                             
                      
                                        
                       
     
                        
    
                                                           
                                      
                             
     
                     
     
                      
    
                                 
                                                 
     
             
                   
                   
     
                                                                      
    
              
    
                                                                
                                                   
                                                             
                     
    
                                                  
                         
     
                
                                                                 
                
                                                
                    
                                         
                   
                      
                        
 

/**
 * 从**我们的** `AccountCredentials`（扁平、任意字段）组装 TRAE 凭据。
 *
 * 我们的账号存储是扁平的 `AccountCredentials`（`token` / `refreshToken` /
 * `expiresAt` + 任意私有字段），而协议函数要的是结构化的 `TraeCredential`。
 * 这一层就是两者的桥。
 *
 * ## 字段映射与派生
 *
 * - `access_token` ← `token`（**用户手工粘贴的就是它**）
 * - `refresh_token` ← `refreshToken`
 * - `expires_at` ← `expiresAt`（毫秒数 → 字符串）
 * - `uid` ← `uid`（手工可填；缺失时由 `GetUserInfo` 补，见适配器）
 * - `machine_id` / `device_id` ← 凭证里的同名字段；缺失时**由调用方派生**
 *   （按账号 id 确定性派生，重启不变）——见 `trae-identity.ts`
 *
 * @param raw 我们的扁平凭证
 * @param fallback 缺失字段的兜底（派生出来的 machine_id / device_id）
 */
export function toTraeCredential(
  raw                         ,
  fallback                                         ,
)                 {
  const accessToken = typeof raw.token === 'string' ? raw.token : ''
  const refreshToken = typeof raw.refreshToken === 'string' ? raw.refreshToken : ''
  const expiresAt = typeof raw.expiresAt === 'number' && Number.isFinite(raw.expiresAt)
    ? String(raw.expiresAt)
    : typeof raw.expiresAt === 'string'
      ? raw.expiresAt
      : undefined
  const uid = typeof raw.uid === 'string' ? raw.uid : ''
  const storedMachine = typeof raw.machine_id === 'string' ? raw.machine_id : ''
  const storedDevice = typeof raw.device_id === 'string' ? raw.device_id : ''
  const nickname = typeof raw.nickname === 'string' ? raw.nickname : undefined
  const phone = typeof raw.phone === 'string' ? raw.phone : undefined
  const email = typeof raw.email === 'string' ? raw.email : undefined
  const enterpriseId = typeof raw.enterprise_id === 'string' ? raw.enterprise_id : undefined
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresAt === undefined || expiresAt === '' ? {} : { expires_at: expiresAt }),
    uid,
    ...(nickname === undefined || nickname === '' ? {} : { nickname }),
    ...(phone === undefined || phone === '' ? {} : { phone }),
    ...(email === undefined || email === '' ? {} : { email }),
    machine_id: storedMachine !== '' ? storedMachine : fallback.machineId,
    device_id: storedDevice !== '' ? storedDevice : fallback.deviceId,
    ...(enterpriseId === undefined || enterpriseId === '' ? {} : { enterprise_id: enterpriseId }),
  }
}

// ── 过期判定 ──

/**
 * 解析凭据的绝对过期时刻（毫秒）。
 *
 * 兼容三种形态：毫秒时间戳 / 秒级时间戳 / ISO 8601。
 * 后备来源：`expires_at` 为空时回退解析 `access_token` 这个 JWT 的 `exp`。
 */
export function traeCredentialExpiresAtMs(credential                )                     {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      // ⚠️ 用位数判毫秒 vs 秒，而不是「大于当前时间」之类的相对判据 ——
      // 后者在时钟漂移时会给出错的结论，而位数是格式事实。
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtExpiresAtMs(credential.access_token)
}

/**
 * 从 JWT 里读出 `exp`（毫秒）；不是 JWT 或没有 `exp` 时返回 undefined。
 *
 * ⚠️ **不校验签名**：这里只是读一个用来判过期的数字，签名由上游校验。
 * 校验签名需要密钥，而插件没有（也不该有）——所以这个值只用于「要不要提前续期」，
 * 绝不能用于任何安全决策。
 */
export function jwtExpiresAtMs(token        )                     {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')
    const payload          = JSON.parse(json)
    if (typeof payload !== 'object' || payload === null) return undefined
    const exp = (payload                           ).exp
    if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) return exp * 1000
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 凭据是否已过期。
 *
 * ⚠️ **无法解析过期时间时不判定过期**（返回 `false`）：手写粘贴的 token 可能是
 * 不透明的（非 JWT）、也可能上游压根不给过期时间。把它当成「已过期」会让
 * 每一个这样的账号都被无谓地判死；当成「未过期」则最多是多试一次、
 * 由上游的 401 给出真结论 —— 后者是更安全的默认。
 */
export function isTraeExpired(credential                , now         = Date.now())          {
  const expiresAt = traeCredentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : now >= expiresAt
}

/** 凭据是否携带可静默续期的 refresh_token。 */
export function isTraeRefreshable(credential                )          {
  return credential.refresh_token.length > 0
}

// ── ExchangeToken / GetUserInfo 响应解析 ──

/** ExchangeToken 响应体的 `Result` 部分。 */
                                     
                     
                      
                                                     
                       
                
                             
                                 
                         
 

/**
 * 解析 ExchangeToken 响应。
 *
 * 上游形状：`{ Result: { Token, TokenExpireAt, TokenExpireDuration, RefreshToken, RefreshExpireAt } }`
 * 同时兼容 `result` 小写与 camelCase 字段（网关层有过大小写不一致的记录）。
 */
export function parseTraeExchangeResponse(data                         )                                 {
  const result = data.Result ?? data.result
  if (typeof result !== 'object' || result === null) return undefined
  const r = result                           
  const accessToken = readStringField(r, 'Token') || readStringField(r, 'token') || readStringField(r, 'accessToken')
  const refreshToken = readStringField(r, 'RefreshToken') || readStringField(r, 'refreshToken')
  if (accessToken.length === 0) return undefined
  return {
    accessToken,
    refreshToken,
    tokenExpireAt: readNumberField(r, 'TokenExpireAt') ?? readNumberField(r, 'tokenExpireAt') ?? 0,
    tokenExpireDuration: readNumberField(r, 'TokenExpireDuration') ?? readNumberField(r, 'tokenExpireDuration') ?? 0,
    refreshExpireAt: readNumberField(r, 'RefreshExpireAt') ?? readNumberField(r, 'refreshExpireAt') ?? 0,
  }
}

/** GetUserInfo 响应体的 `Result` 部分。 */
                                     
             
                    
                      
                                          
               
                                              
               
 

/**
 * 解析 GetUserInfo 响应。
 *
 * 上游形状：`{ Result: { UserID, ScreenName, EnterpriseID, NonPlainTextMobile } }`
 *
 * ⚠️ 字段名是 **`NonPlainTextMobile` / `NonPlainTextEmail`**（不是 `Mobile` /
 * `Phone` / `Email`）—— 参考实现实测 `GetUserInfo` **只下发这两个脱敏形态**。
 */
export function parseTraeUserInfoResponse(data                         )                                 {
  const result = data.Result ?? data.result
  if (typeof result !== 'object' || result === null) return undefined
  const r = result                           
  const uid = readStringField(r, 'UserID') || readStringField(r, 'userId') || readStringField(r, 'uid')
  if (uid.length === 0) return undefined
  return {
    uid,
    screenName: readStringField(r, 'ScreenName') || readStringField(r, 'screenName') || uid,
    enterpriseId: readStringField(r, 'EnterpriseID') || readStringField(r, 'enterpriseId') || '',
    phone: readStringField(r, 'NonPlainTextMobile') || readStringField(r, 'nonPlainTextMobile'),
    email: readStringField(r, 'NonPlainTextEmail') || readStringField(r, 'nonPlainTextEmail'),
  }
}

/**
 * 由 ExchangeToken 结果 + 用户信息组装凭据。
 *
 * `expires_at` 取值顺序（对齐参考实现）：
 * 1. `tokenExpireAt`（绝对值，可能是秒或毫秒，按量级判定）；
 * 2. `tokenExpireDuration`（相对秒数，以当前时刻为基准）；
 * 3. 都拿不到则留空（由 JWT `exp` 兜底）。
 */
export function buildTraeCredential(
  exchange                    ,
  userInfo                    ,
  session                                         ,
  nowMs         = Date.now(),
)                 {
  let expiresAt        
  if (exchange.tokenExpireAt > 1e12) {
    expiresAt = String(exchange.tokenExpireAt)
  } else if (exchange.tokenExpireAt > 0) {
    expiresAt = String(exchange.tokenExpireAt * 1000)
  } else if (exchange.tokenExpireDuration > 0) {
    expiresAt = String(nowMs + exchange.tokenExpireDuration * 1000)
  } else {
    const exp = jwtExpiresAtMs(exchange.accessToken)
    expiresAt = exp === undefined ? '' : String(exp)
  }
  return {
    access_token: exchange.accessToken,
    refresh_token: exchange.refreshToken,
    ...(expiresAt === '' ? {} : { expires_at: expiresAt }),
    uid: userInfo.uid,
    ...(userInfo.screenName === '' ? {} : { nickname: userInfo.screenName }),
    ...(userInfo.phone === '' ? {} : { phone: userInfo.phone }),
    ...(userInfo.email === '' ? {} : { email: userInfo.email }),
    machine_id: session.machineId,
    device_id: session.deviceId,
    ...(userInfo.enterpriseId === '' ? {} : { enterprise_id: userInfo.enterpriseId }),
  }
}

// ── 设备身份派生 ──

/**
 * 按账号 id **确定性派生** machine_id（32 hex）。
 *
 * ## 为什么是派生而不是随机
 *
 * TRAE 用 `machine_id` 标识设备，参考实现的既定约束是「登录时生成后**绝不重新生成**」
 * （换值可能触发风控或要求重新登录）。而本期的凭据是**手工粘贴**的 ——
 * 没有一个「登录时刻」来生成并保存它。
 *
 * 派生的结果由账号 id **唯一决定**，因此：重启后仍是同一个值、
 * 同一账号在多台机器上一致、也不需要用户手工填一个 32 位 hex。
 *
 * 代价：它不是真实设备的指纹（我们本来就伪造不了真实 IDE 的设备身份）。
 * 对「不重新生成、保持稳定」这个**唯一被上游观测到的性质**而言，派生完全够用。
 *
 * ⚠️ **必须截断到 32 位 hex**：`sha256().digest('hex')` 给的是 **64** 字符，
 * 与协议格式不符（TRAE 的 device_id 是 `openssl rand -hex 16` 的产物，
 * 16 字节 → 32 hex 字符）。
 */
export function deriveMachineId(accountId        )         {
  return createHash('sha256').update(`trae:machine:${accountId}`, 'utf8').digest('hex').slice(0, 32)
}

/**
 * 按账号 id **确定性派生**签到设备号（32 hex）。
 *
 * ⚠️ **各账号必须互不相同** —— 同一天两个账号共用同一个 device_id 会被
 * 「该设备已签到」拦截（第二个账号报已签到）。因为派生输入含账号 id，
 * 天然满足这一点。
 *
 * 与 {@link deriveMachineId} 用**不同的 salt**：两个值在上游是不同用途
 * （一个标识设备、一个标识签到设备），复用同一个值会让「轮换签到设备号」
 * 连带影响机器指纹。
 */
export function deriveDeviceId(accountId        )         {
  return createHash('sha256').update(`trae:device:${accountId}`, 'utf8').digest('hex').slice(0, 32)
}

/**
 * 由「基础 device_id + 代次」派生**签到专用**的设备号（hex32）。
 *
 * ## 为什么需要轮换
 *
 * 业务码 **9074**（"too many users, retry later"）的限流范围是
 * **device_id 而非账号**：参考实现实测同一个账号在某个 id 上签到返回 9074 后，
 * 换一个**全新派生**的 id 立刻就能签到成功。因此命中 9074 时不该是死局 ——
 * 把代次 +1 派生一个新设备号即可绕开。
 *
 * ## 为什么是「派生」而不是「重新随机」
 *
 * 派生的结果由 `(device_id, generation)` **唯一决定**，因此：同一代次在任意
 * 进程 / 重启后都得到同一个值，无需持久化新 id 本身；只需持久化一个整数代次。
 *
 * `generation <= 0` 时**原样返回**基础 id（既有账号行为完全不变）。
 *
 * @param baseDeviceId 派生或粘贴来的 device_id
 * @param generation 轮换代次（0 = 用原始 id）
 */
export function deriveCheckinDeviceId(baseDeviceId        , generation        )         {
  if (!Number.isFinite(generation) || generation <= 0) return baseDeviceId
  return createHash('sha256')
    .update(`${baseDeviceId}#gen${Math.floor(generation)}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
}


//# sourceURL=src/vendor/trae/trae-identity.ts