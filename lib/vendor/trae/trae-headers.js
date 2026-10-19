/**
 * TRAE 请求头构造。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae.ts`
 * 的「请求头构造」一节。**三套头族，用途完全不同，不要混用**：
 *
 * | 构造器 | 用于 | 关键差异 |
 * |---|---|---|
 * | {@link traeSOLOHeaders} | 对话 + 模型列表 | `Cloud-IDE-JWT` + 一整套 IDE 指纹头 |
 * | {@link traeUgHeaders} | Ug 系列（简化版） | 只有 `Authorization` + `X-User-Region` |
 * | {@link traeCheckinHeaders} | **签到 / 积分** | 约 20 个客户端头 + 确定性设备身份 |
 *
 * ⚠️ 参考实现里有一条实测结论：签到**必须用 `traeCheckinHeaders`**，
 * 简化版 `traeUgHeaders` 是「能构造出来但不保证成功」的形态 ——
 * 真正跑通签到的是 trae-mate 那套完整客户端头。
 */

import { TRAE_APP_ID, TRAE_DEVICE_BRAND, TRAE_IDE_VERSION, TRAE_IDE_VERSION_CODE, TRAE_OS_VERSION, TRAE_USER_AGENT } from './trae-product.js'
import { deriveCheckinDeviceId,                     } from './trae-identity.js'
import { createHash } from 'node:crypto'

/**
 * 构造 SOLO 对话 / 模型列表请求头。
 *
 * ⚠️ **同一个 token 要出现在三个头里**（`Authorization` / `X-Cloudide-Token` /
 * `X-Ide-Token`）——参考实现实测「缺任一个都可能被上游拒绝」，不是冗余。
 *
 * @param stream 是否流式（只影响 `Accept`）
 */
export function traeSOLOHeaders(
  credential                ,
  stream         ,
)                         {
  const headers                         = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': TRAE_USER_AGENT,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Cloudide-Token': credential.access_token,
    'X-Ide-Token': credential.access_token,
    'X-Uid': credential.uid,
    'X-App-Id': TRAE_APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': TRAE_IDE_VERSION,
    'X-Ide-Version-Code': TRAE_IDE_VERSION_CODE,
    'X-App-Version-Code': TRAE_IDE_VERSION_CODE,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'macos',
    'X-OS-Version': TRAE_OS_VERSION,
    'X-Device-Brand': TRAE_DEVICE_BRAND,
    'Request-Traffic-Type': 'prod',
  }
  if (credential.machine_id.length > 0) headers['X-Machine-Id'] = credential.machine_id
  if (credential.device_id.length > 0) headers['X-Device-Id'] = credential.device_id
  return headers
}

/**
 * 构造 Ug（签到 / 积分）**简化**请求头。
 *
 * ⚠️ 本插件实际**不用**它做签到（见 {@link traeCheckinHeaders} 的说明）。
 * 保留它是为了「探测」场景：一次轻量的、不带动辄 20 个头的最小请求。
 *
 * @param checkinDeviceGeneration 签到设备轮换代次（默认 0 = 用凭据原始 device_id）
 */
export function traeUgHeaders(
  credential                ,
  checkinDeviceGeneration = 0,
)                         {
  const headers                         = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': TRAE_USER_AGENT,
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-User-Region': 'CN',
  }
  if (credential.device_id.length > 0) {
    headers['X-Device-Id'] = deriveCheckinDeviceId(credential.device_id, checkinDeviceGeneration)
  }
  return headers
}

/**
 * 构造签到 / 积分专用**完整**请求头（对齐 trae-mate 的 `build_headers`）。
 *
 * ## 与 {@link traeUgHeaders} 的关键区别
 *
 * trae-mate 实际签到成功用的是一套**非常完整的客户端请求头**（约 20 个），
 * 而不仅仅是简化的 Ug 头。具体差异：
 *
 * - `X-Device-Id`：用**基于 user_id 确定性派生的 15 位数字**，
 *   而非 `credential.device_id` 的 32 hex。每个账号独享一套稳定设备身份。
 * - 新增 `X-Market-User-ID` / `X-Lscbd-Aid` / `X-Lgw-Req-Sdk-Type` /
 *   `Package-Type` / `X-Tt-Trace-Id` / `Vscode-Sessionid` 等头
 * - 每次请求生成独立的 `X-Request-Id` 与 `X-Tt-Trace-Id`
 *
 * ## 为什么设备身份按 user_id 派生 15 位数字
 *
 * ⚠️ 早期实现错误地生成了「16 位纯数字」（那是 CodeBuddy 的签到设备号格式），
 * 与 TRAE 协议不符。**TRAE 用 `openssl rand -hex 16`，即 32 hex**。
 *
 * 但签到这条路（trae-mate 的实测口径）用的又是**15 位数字** —— 两者是
 * 上游**两套不同的端点族**，各自认自己的形态。所以这里两种都保留：
 * 对话用 32 hex、签到用 15 位数字。不要「统一」它们。
 *
 * 每个账号基于其 user_id 永远得到同一套设备标识，使多账号签到各自携带独立
 * 设备身份，规避服务端「每设备每天一次」配额。
 *
 * @param userId 账号 user_id（`credential.uid`）
 * @param nonce 随机源（测试注入用；缺省用 `Math.random` + 时间）
 */
export function traeCheckinHeaders(
  credential                ,
  userId        ,
  checkinDeviceGeneration = 0,
  nonce                                     ,
)                         {
  const deviceId = deriveDeviceId15(userId, checkinDeviceGeneration)
  const marketUserId = deriveMarketUserId(userId)
  const sessionId = deriveSessionId(userId)
  const traceId = `00-${nonce?.traceHex ?? randomHex(16)}-01`
  const requestId = nonce?.uuid ?? uuidV4()
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'zh-CN',
    // ⚠️ 这个 UA 与对话用的 `Trae/0.1.52` **不同** —— 签到族认的是
    // VSCode 形态的 UA。照抄 trae-mate 的实测值，不要「统一」。
    'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    Authorization: `Cloud-IDE-JWT ${credential.access_token}`,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': marketUserId,
    'X-User-Region': 'CN',
    'X-Device-Id': deviceId,
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': 'stable_cn',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': TRAE_IDE_VERSION,
    'X-Tt-Trace-Id': traceId,
    'Vscode-Sessionid': sessionId,
    'X-Request-Id': requestId,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
  }
}

/**
 * 构造 OAuth（ExchangeToken / GetUserInfo）请求头。
 *
 * 无签名，仅 UA。`GetUserInfo` 需要额外 `X-Cloudide-Token` 头，由调用方自行添加。
 */
export function traeOAuthHeaders()                         {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': TRAE_USER_AGENT,
  }
}

// ── 签到设备身份确定性派生（对齐 trae-mate `device_map.rs`）──

/**
 * 确定性派生 **15 位数字**设备 ID（基于 user_id + 代次）。
 *
 * ⚠️ **代次参与派生**，这样 9074（设备级限流）时把代次 +1 才真的换到一个
 * 新设备号 —— 否则「轮换」是个空动作（参考实现里那套轮换确实是空转的：
 * 它的 `traeCheckinHeaders` 只吃 userId，代次参数根本没进派生）。
 *
 * `generation <= 0` 时退化成「只用 userId」，与参考实现的原始序列一致。
 */
export function deriveDeviceId15(userId        , generation = 0)         {
  const salt = generation > 0 ? `devid#gen${Math.floor(generation)}` : 'devid'
  return seededDigits(15, userId, salt)
}

/** 确定性派生 Market User ID（UUID v4 形态，基于 user_id）。 */
export function deriveMarketUserId(userId        )         {
  const bs = seededStream(userId, 'market', 16)
  bs[6] = ((bs[6] ?? 0) & 0x0f) | 0x40 // version 4
  bs[8] = ((bs[8] ?? 0) & 0x3f) | 0x80 // variant RFC 4122
  const hex = bs.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 确定性派生 Session ID（64 hex，基于 user_id）。 */
export function deriveSessionId(userId        )         {
  const bytes = seededStream(userId, 'sess', 32)
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * SHA-256 确定性伪随机流。
 *
 * 输入 `(seed, salt)` 永远产生相同的输出序列。
 * 算法：`SHA256(utf8(salt:seed) ++ counterBE32)` 串联直到达到 `nbytes`。
 *
 * ⚠️ **counter 必须是大端 32 位**（与参考实现一致）：换了字节序就是另一套
 * 序列，而设备身份一旦漂移，签到就会被判成「另一台设备」。
 */
function seededStream(seed        , salt        , nbytes        )           {
  const prefix = `${salt}:${seed}`
  const result           = []
  let counter = 0
  while (result.length < nbytes) {
    const counterBuf = Buffer.alloc(4)
    counterBuf.writeUInt32BE(counter >>> 0, 0)
    const digest = createHash('sha256').update(prefix, 'utf8').update(counterBuf).digest()
    for (const byte of digest) {
      result.push(byte)
      if (result.length >= nbytes) break
    }
    counter += 1
  }
  return result.slice(0, nbytes)
}

/** 确定性派生 N 位数字字符串。 */
function seededDigits(n        , seed        , salt        )         {
  return seededStream(seed, salt, n).map((b) => (b % 10).toString()).join('')
}

/** 生成 UUID v4（随机，非确定性）。 */
function uuidV4()         {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** 生成 N 位随机 hex 字符串。 */
function randomHex(n        )         {
  let out = ''
  while (out.length < n) out += Math.floor(Math.random() * 16).toString(16)
  return out.slice(0, n)
}


//# sourceURL=src/vendor/trae/trae-headers.ts