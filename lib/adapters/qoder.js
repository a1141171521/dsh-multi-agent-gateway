/**
 * Qoder / Qoder CN 适配器。
 *
 * 事实与实现全部来自 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/`：
 * `qoder-wasm.ts` / `qoder-machine.ts` / `qoder-product.ts` / `qoder-envelope.ts` /
 * `qoder.ts` 原样搬进 `src/vendor/qoder/`，本文件只做「接到我们的适配器接口」。
 *
 * ## 为什么必须带 WASM
 *
 * 对话走的是**加密端点**（`api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`），
 * 请求体由 WASM 加密，`Authorization` 也是 WASM 生成的
 * `Bearer COSY.<载荷>.<签名>`。用普通 `Bearer <token>` 会直接
 * `403 Signature invalid (101)`。
 *
 * 公开的 OpenAI 兼容端点（`api2-v2.qoder.sh`）只认**通用名**（`qwen-flash`），
 * 而模型目录里的 key（`qfmodel` …）发过去一律 `Unsupported model` ——
 * 所以走公开通道等于没有模型清单。这也是这里坚持用加密通道的原因。
 *
 * ## 凭证要求
 *
 * 需要三样东西：
 *   - `security_oauth_token`（放进账号的 `token` 字段）
 *   - `uid`：从 token 的 JWT 载荷里解（`user_id` / `uid` / `sub`）
 *   - `machine_id`：本插件按账号 id 确定性派生，重启不变
 *
 * 缺 uid 时 WASM 会产出**签名无效**的请求（上游报 `Signature invalid (101)`），
 * 所以这里在发请求前就明确报错，而不是让用户对着 403 猜。
 */

import { createHash } from 'node:crypto'
import { BaseAdapter } from './base.js'
import { iterateSse } from '../core/sse.js'
import { QoderEncryptedInfer } from '../vendor/qoder/qoder-wasm.js'
import {
  createQoderDeviceSession,
  buildQoderAuthUrl,
  buildQoderPollUrl,
  parseQoderTokenPayload,
} from '../vendor/qoder/qoder.js'
                                                                  
import { unwrapQoderEnvelopeStream } from '../vendor/qoder/qoder-envelope.js'
                                                                         
import { QODER } from '../vendor/qoder/qoder-product.js'
                                                                    
             
                
                 
                    
              
              
            
            
              
                         

/** Qoder CN 的产品常量（与 QODER 的差别只在 host 与目录，见参考实现的注释）。 */
export const QODER_CN               = {
  ...QODER,
  id: 'qodercn',
  displayName: 'Qoder CN',
  authBase: 'https://qoder.com.cn',
  openApiBase: 'https://openapi.qoder.com.cn',
  inferBase: 'https://gateway.qoder.com.cn',
  encryptedInferBase: 'https://gateway.qoder.com.cn',
  defaultCredentialRef: 'QODER_CN_ACCESS_TOKEN',
}

const CAPABILITIES                    = {
  checkIn: false,
  quota: false,
  models: true,
  tasks: false,
  chat: true,
  reasoning: true,
  source: 'static',
  notes: {
    checkIn: '本期未接入签到（参考实现有 qoder-credits.ts）',
    quota: '本期未接入积分查询',
    models: '模型目录来自产品兜底表（加密目录需 WASM 解密，本期未接）',
  },
}

/** 从 JWT 载荷里取用户 id；取不到返回空串。 */
export function uidFromToken(token        )         {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const json = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')
    const payload          = JSON.parse(json)
    if (typeof payload !== 'object' || payload === null) return ''
    const record = payload                           
    for (const key of ['user_id', 'uid', 'userId', 'sub']) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') return value
      if (typeof value === 'number') return String(value)
    }
  } catch {
    // 不是 JWT（或载荷不是 JSON）：交给调用方报错
  }
  return ''
}

/** 按账号 id 派生稳定的设备标识（同一账号每次重启都相同）。 */
export function machineIdOf(accountId        )         {
  const hex = createHash('sha256').update(`qoder:${accountId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 我们自己的消息 → Qoder 的 `QoderInferMessage`。 */
function toInferHistory(messages                        )                                                                                               {
  const history                                           = []
  let systemText                    
  let userText = ''
  for (const message of messages) {
    const content = typeof message.content === 'string' ? message.content : ''
    if (message.role === 'system' || message.role === 'developer') {
      if (systemText === undefined) systemText = content
      continue
    }
    history.push({ role: message.role, content })
    if (message.role === 'user') userText = content
  }
  return {
    userText,
    ...(systemText === undefined ? {} : { systemText }),
    history,
  }
}

/** Qoder / Qoder CN 适配器。 */
export class QoderAdapter extends BaseAdapter {
                   product              
  /** 每个账号一个 WASM 上下文（构造有成本，缓存起来）。 */
                   clients = new Map                             ()

  constructor(product              ) {
    super({
      id: product.id === 'qodercn' ? 'qoder-cn' : 'qoder',
      name: product.displayName,
      doc: product.authBase,
      credentialHint: '粘贴 security_oauth_token（JWT，需含 user_id）。',
      capabilities: CAPABILITIES,
      implemented: true,
    })
    this.product = product
  }

          tokenOf(record               )         {
    const token = record.credentials.token
    return typeof token === 'string' ? token : ''
  }

  // ── 登录（设备码 + PKCE） ──────────────────────────────────────────
  //
  // 流程：打开 `authBase/device/selectAccounts?...` → 用户在浏览器登录 →
  // 用户点「刷新登录状态」→ 宿主问一次 `openApiBase/api/v1/deviceToken/poll`。

  /** ① 生成授权链接（PKCE + nonce 只留在宿主会话里）。 */
  async beginLogin(_ctx                )                            {
    const session = createQoderDeviceSession(machineIdOf(this.id))
    const authUrl = buildQoderAuthUrl(session, this.product)
    return { authUrl, expiresInSec: 300, state: session }
  }

  /** ② 问一次 token：拿到就交给宿主落盘。 */
  async pollLogin(state         , ctx                )                           {
    const session = state                                  
    if (session === undefined || session === null) {
      return { status: 'failed', message: '登录会话状态丢失，请重新发起' }
    }
    let body          = null
    try {
      const send = ctx.fetch ?? fetch
      const response = await send(buildQoderPollUrl(session, this.product), {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': `${this.product.userAgentPrefix}/1.0.0` },
      })
      body = await response.json().catch(() => null)
      if (!response.ok) {
        return { status: 'pending', message: `还没检测到登录（HTTP ${response.status}），请先在浏览器完成登录` }
      }
    } catch (error) {
      return { status: 'pending', message: `网络错误，稍后再试：${error instanceof Error ? error.message : String(error)}` }
    }
    const envelope = body                             
    const payload = parseQoderTokenPayload(envelope?.data ?? body)
    if (payload.accessToken === '') {
      return { status: 'pending', message: '还没检测到登录，请先在浏览器完成登录' }
    }
    return {
      status: 'ready',
      message: '登录成功',
      credentials: {
        token: payload.accessToken,
        ...(payload.refreshToken === undefined || payload.refreshToken === '' ? {} : { refreshToken: payload.refreshToken }),
        ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
      },
      ...(payload.userName === undefined || payload.userName === '' ? {} : { label: payload.userName }),
    }
  }

  /** 模型目录：用产品兜底表（加密目录需另接解密，本期不做）。 */
  async getModelMetaList(_record               , _ctx                )                       {
    return (this.product.fallbackModels ?? []).map((model) => ({
      id: model.id,
      name: model.name,
      agentId: this.id,
      agentName: this.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.supportsImage ? { inputModalities: ['text', 'image']                         } : {}),
      ...(model.supportsThinking ? { reasoning: true } : {}),
    }))
  }

  /** 校验：token 能解出 uid 才算可用（否则 WASM 签名必然无效）。 */
  async validateCredentials(
    record               ,
    _ctx                ,
  )                                                               {
    const token = this.tokenOf(record)
    if (token === '') return { ok: false, message: '没有 security_oauth_token', kind: 'auth' }
    const uid = uidFromToken(token)
    if (uid === '') {
      return {
        ok: false,
        message: 'token 里解不出 user_id —— Qoder 的加密通道需要它，请换成完整的 security_oauth_token',
        kind: 'auth',
      }
    }
    return { ok: true, message: `凭证可用（uid=${uid}，本地校验）` }
  }

  /** 懒建 WASM 客户端。 */
          async clientFor(record               , ctx                )                               {
    const cached = this.clients.get(record.id)
    if (cached !== undefined) return cached
    const token = this.tokenOf(record)
    const uid = uidFromToken(token)
    if (uid === '') throw new Error('token 里解不出 user_id，无法生成签名')
    const client = await QoderEncryptedInfer.create({
      user: { uid, securityOauthToken: token },
      machineId: machineIdOf(record.id),
      metadata: this.product.clientMetadata,
      host: this.product.encryptedInferBase,
    })
    this.clients.set(record.id, client)
    ctx.log.debug(`Qoder WASM 上下文已建立 account=${record.id} uid=${uid}`)
    return client
  }

  /** 对话：WASM 加密请求 → 解密响应流 → 归一化事件。 */
  async *requestChatStream(
    payload             ,
    record               ,
    ctx                ,
    signal             ,
  )                             {
    let client                     
    try {
      client = await this.clientFor(record, ctx)
    } catch (error) {
      yield {
        type: 'error',
        failure: { kind: 'auth', message: error instanceof Error ? error.message : String(error), at: Date.now() },
      }
      return
    }

    const { userText, systemText, history } = toInferHistory(payload.messages)
    let prepared
    try {
      prepared = client.prepareInfer({
        modelKey: payload.model,
        userText,
        ...(systemText === undefined ? {} : { systemText }),
        history,
        ...(payload.max_tokens === undefined ? {} : { maxTokens: payload.max_tokens }),
        ...(typeof payload.reasoning === 'string' ? { reasoningEffort: payload.reasoning } : {}),
      })
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          kind: 'unknown',
          message: `生成加密请求失败：${error instanceof Error ? error.message : String(error)}`,
          at: Date.now(),
        },
      }
      return
    }

    let response          
    try {
      const send = ctx.fetch ?? fetch
      response = await send(prepared.url, {
        method: 'POST',
        // ⚠️ 这里的 headers 必须原样透传：Authorization 是 WASM 签的
        headers: prepared.headers,
        body: prepared.body,
        signal,
      })
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          kind: 'network',
          message: `连接上游失败：${error instanceof Error ? error.message : String(error)}`,
          at: Date.now(),
        },
      }
      return
    }

    if (!response.ok) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        // 读不到原文也没关系
      }
      yield {
        type: 'error',
        failure: {
          kind: this.detectError(response.status, text, response.headers),
          message: text.slice(0, 300) || `HTTP ${response.status}`,
          status: response.status,
          at: Date.now(),
        },
      }
      return
    }

    // 响应体是加密的：先解密成标准 SSE，再走通用解析。
    const plain = unwrapQoderEnvelopeStream(response, 'qoder')
    let malformed = 0
    for await (const event of iterateSse(
      plain,
      (raw) => {
        malformed += 1
        if (malformed <= 3) ctx.log.debug('跳过一条无法解析的 SSE 事件', raw.slice(0, 200))
      },
      signal,
    )) {
      yield event
    }
    if (malformed > 0) ctx.log.warn(`本次流共跳过 ${malformed} 条无法解析的事件`)
  }
}


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\adapters\qoder.ts