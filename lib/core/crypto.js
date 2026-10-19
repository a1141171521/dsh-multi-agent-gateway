/**
 * 凭证加密：AES-256-GCM + scrypt 派生密钥，密钥存在 `<dataDir>/.master-key`。
 *
 * 设计取舍（任务书要求「不硬编码 token，凭证本地加密存储」）：
 *
 *   - **密钥与密文分文件**：`accounts.enc.json` 可以随便备份/同步，`.master-key`
 *     留在本机（权限 0600）。攻击者只拿到其中一个解不开。
 *   - **零第三方依赖**：只用 `node:crypto`。插件不许引入运行时第三方库
 *     （与 DSH 官方插件的纪律一致）。
 *   - **AEAD 而不是 HMAC**：GCM 自带完整性校验，改一个字节就会解密失败，
 *     不会把「被篡改的假 token」当成真 token 发出去。
 *   - **AAD 绑定格式版本**：避免把未来格式的密文当当前格式解。
 *
 * 明确的**边界**：这不是硬件密钥库。能读 `<dataDir>` 的本机进程同样能读密钥，
 * 所以它防的是「配置文件泄露 / 云同步泄露 / 随手 grep 到明文 token」，
 * 不防本机提权。文档里写清楚，不吹。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 密文信封格式版本，进 AAD。 */
const ENVELOPE_VERSION = 1
/**
 * scrypt 参数。
 *
 * ⚠️ `maxmem` 必须显式给：Node 默认上限是 32 MiB，而 scrypt 需要
 * `128 * N * r` 字节 —— N=16384/r=8 就是 16 MiB，留一倍余量最稳。
 * 不给 `maxmem` 时 N=32768 会直接抛 `Invalid scrypt params`（实测踩过）。
 * N=16384 在本机约 15ms，用于「录账号 / 启动解密」这种低频操作完全够。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 }

/** 磁盘上的信封形状。 */
                                 
           
                  
              
                         
            
                     
             
                   
              
 

/** 主密钥文件的内容（JSON，方便人看也方便以后升级）。 */
                         
           
                      
             
                   
 

/**
 * 主密钥管理 + 加解密器。
 *
 * 密钥文件**懒加载**：插件启动时不读盘，第一次真正要用凭证时才读/建，
 * 这样「装了但没配账号」的部署不会平白多一个文件。
 */
export class CredentialVault {
                   keyPath        
          masterKey                = null

  constructor(dataDir        ) {
    this.keyPath = `${dataDir}/.master-key`
  }

  /** 主密钥文件路径（诊断用，UI 上显示给用户看）。 */
  get keyFilePath()         {
    return this.keyPath
  }

  /** 读主密钥；不存在就生成一个（0600）。 */
          key()         {
    if (this.masterKey !== null) return this.masterKey
    if (existsSync(this.keyPath)) {
      const parsed = JSON.parse(readFileSync(this.keyPath, 'utf8'))                 
      const decoded = Buffer.from(parsed.key, 'base64')
      if (decoded.length !== 32) throw new Error(`主密钥长度不对（${decoded.length} 字节，期望 32）：${this.keyPath}`)
      this.masterKey = decoded
      return decoded
    }
    mkdirSync(dirname(this.keyPath), { recursive: true })
    const fresh = randomBytes(32)
    const payload                = { v: ENVELOPE_VERSION, key: fresh.toString('base64'), createdAt: Date.now() }
    writeFileSync(this.keyPath, JSON.stringify(payload, null, 2), { mode: 0o600 })
    try {
      chmodSync(this.keyPath, 0o600)
    } catch {
      // Windows 上 chmod 基本是空操作；失败不影响正确性，只是权限更宽。
    }
    this.masterKey = fresh
    return fresh
  }

  /** 主密钥是否已经存在（UI 用它区分「首次加密」与「沿用已有密钥」）。 */
  hasKey()          {
    return this.masterKey !== null || existsSync(this.keyPath)
  }

  /** 加密一个 JSON 可序列化对象。 */
  seal(value         )                 {
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    const derived = scryptSync(this.key(), salt, SCRYPT.keylen, SCRYPT)
    const cipher = createCipheriv('aes-256-gcm', derived, iv)
    cipher.setAAD(Buffer.from(String(ENVELOPE_VERSION)))
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return {
      v: ENVELOPE_VERSION,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }
  }

  /** 解密。密钥不对 / 密文被改 → 抛错（**不返回半成品**）。 */
  open   (envelope                )    {
    if (envelope === null || typeof envelope !== 'object') throw new Error('密文信封形状不对')
    if (envelope.v !== ENVELOPE_VERSION) {
      throw new Error(`密文信封版本 ${String(envelope.v)} 不是本版本能解的 ${ENVELOPE_VERSION}`)
    }
    const salt = Buffer.from(envelope.salt, 'base64')
    const iv = Buffer.from(envelope.iv, 'base64')
    const tag = Buffer.from(envelope.tag, 'base64')
    if (salt.length === 0 || iv.length !== 12 || tag.length !== 16) throw new Error('密文信封字段长度不对')
    const derived = scryptSync(this.key(), salt, SCRYPT.keylen, SCRYPT)
    const decipher = createDecipheriv('aes-256-gcm', derived, iv)
    decipher.setAAD(Buffer.from(String(ENVELOPE_VERSION)))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))     
  }

  /** 常量时间比较（给「校验主密钥是否正确」这类场景用）。 */
  static equals(left        , right        )          {
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }
}

/**
 * 凭证脱敏：日志/UI 里显示 token 时**只留头尾**。
 *
 * ⚠️ 这条是硬规则：任何日志、任何错误信息、任何 Remote 返回值都不许出现完整 token。
 */
export function redactSecret(value                    )         {
  if (value === undefined || value === '') return ''
  const trimmed = value.trim()
  if (trimmed.length <= 8) return '***'
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`
}

/** 深拷贝一个对象并脱敏所有疑似凭证字段（Remote 回给浏览器前必过一遍）。 */
export function redactDeep(value         , depth = 0)          {
  if (depth > 6) return '[depth-limit]'
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const out                          = {}
  for (const [key, item] of Object.entries(value                           )) {
    if (/token|secret|apikey|api_key|password|cookie|authorization|bearer/i.test(key)) {
      out[key] = typeof item === 'string' ? redactSecret(item) : item === undefined ? undefined : '***'
      continue
    }
    out[key] = redactDeep(item, depth + 1)
  }
  return out
}


//# sourceURL=src/core/crypto.ts