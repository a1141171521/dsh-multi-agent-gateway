/**
 * WorkBuddy / CodeBuddy 系（腾讯）适配器。
 *
 * 事实来源：`dsh-our-free-model` 的 `vendor/channel-pack/src/{product,buddy-adapter,buddy}.ts`
 * （MIT，已逐条核对端点、头名与产品参数）。这里只保留**本插件用得到**的部分：
 *
 *   - 对话：`POST {endpoint}/v2/chat/completions`（标准 OpenAI Chat Completions + SSE）
 *   - 模型：`GET  {endpoint}/v3/config` → `data.agents[].models[]` + `data.models[]`
 *   - 鉴权：`Authorization: Bearer <access_token>`
 *
 * ## 为什么有 5 个自定义头
 *
 * 腾讯这套网关按**客户端身份**做用量归因（后台「使用端」列）。少发任一个，
 * 请求可能仍能通，但后台归因为 `-`，且部分模型线会拒绝：
 *
 *   X-Domain       与 endpoint 必须一致（凭据里的 domain 是登录时的快照，会过期）
 *   X-Product-Code `codebuddy`（国内）/ `workbuddy`（国际）
 *   X-Product      归属名，**不是部署类型**（历史实现发成 SaaS，归因不到产品）
 *   X-IDE-Name / X-IDE-Type / X-IDE-Version  客户端形态
 *   User-Agent     国际版按模型族分档（GPT/Gemini/Claude 与国内系不同形态）
 *
 * ## 这一期**没有**实现的能力（诚实回报，不伪造）
 *
 *   - 每日签到：上游没有公开签到接口 → `supported: false`
 *   - 额度查询：需要积分接口（参考实现里有 `credits.ts`），本期未接 → 返回错误说明
 */

import { BaseAdapter } from './base.js'
import { iterateSse } from '../core/sse.js'
import type { LoginPollResult, LoginStartResult } from '../core/login.js'
import type {
  AccountRecord,
  AdapterContext,
  AgentCapabilities,
  ChatRequest,
  ErrorKind,
  ModelMeta,
  StreamEvent,
} from '../core/types.js'

/** 一个 Buddy 系产品的全部差异配置。 */
export interface BuddyProduct {
  /** 本插件的 agentId。 */
  agentId: 'workbuddy' | 'workbuddy-intl'
  displayName: string
  endpoint: string
  apiDomain: string
  /** 登录时传给 `auth/state` 的 `platform` 查询参数。 */
  platform: string
  productCode: string
  attributionName: string
  clientVersion: string
  userAgent: string
  /** 按模型 id 前缀切换 UA（国际版专用；空 = 一律用 userAgent）。 */
  userAgentByModelFamily: ReadonlyArray<{ match: string; ua: string }>
}

const UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'

/** 国内版（copilot.tencent.com）。 */
export const BUDDY_CN: BuddyProduct = {
  agentId: 'workbuddy',
  displayName: 'WorkBuddy',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  platform: 'ide',
  productCode: 'codebuddy',
  attributionName: 'CodeBuddy',
  clientVersion: '1.106.1',
  userAgent: 'CodeBuddyIDE/1.106.1',
  userAgentByModelFamily: [],
}

/** 国际版（www.workbuddy.ai）。 */
export const BUDDY_INTL: BuddyProduct = {
  agentId: 'workbuddy-intl',
  displayName: 'WorkBuddy International',
  endpoint: 'https://www.workbuddy.ai',
  apiDomain: 'www.workbuddy.ai',
  platform: 'workbuddy-ai',
  productCode: 'workbuddy',
  attributionName: 'WorkBuddy',
  clientVersion: '5.5.2',
  userAgent: UA_INTL,
  userAgentByModelFamily: [
    { match: 'gpt-', ua: UA_INTL },
    { match: 'gemini-', ua: UA_INTL },
    { match: 'claude-', ua: UA_INTL },
    { match: 'glm-', ua: UA_CN },
    { match: 'hy', ua: UA_CN },
    { match: 'kimi-', ua: UA_CN },
    { match: 'minimax-', ua: UA_CN },
  ],
}

export const BUDDY_PRODUCTS: readonly BuddyProduct[] = [BUDDY_CN, BUDDY_INTL]

/**
 * 内置兜底模型表。
 *
 * 只在 `/v3/config` 拉不到时使用。id 与上下文长度都来自参考实现的实测表，
 * **不编造**：这里没有的模型就是没有。
 */
const FALLBACK_MODELS: Record<string, ReadonlyArray<{ id: string; name: string; contextWindow: number; images: boolean }>> = {
  workbuddy: [
    { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, images: true },
    { id: 'hy3', name: 'Hy3', contextWindow: 192_000, images: true },
    { id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, images: true },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, images: true },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, images: true },
    { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, images: true },
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, images: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, images: true },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, images: true },
    { id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1_000_000, images: true },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, images: true },
  ],
  'workbuddy-intl': [
    { id: 'default-model', name: 'Auto', contextWindow: 176_000, images: true },
    { id: 'fast-model', name: 'Fast', contextWindow: 200_000, images: true },
    { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, images: true },
    { id: 'primary-model', name: 'Primary', contextWindow: 272_000, images: true },
    { id: 'deep-model', name: 'Deep', contextWindow: 176_000, images: true },
    { id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1_000_000, images: true },
    { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, images: true },
    { id: 'hy3', name: 'Hy3', contextWindow: 192_000, images: true },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, images: true },
    { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash (SG)', contextWindow: 1_000_000, images: true },
  ],
}

/** 不是真实对话模型的 id（自动选择 / 补全 / 生图）。 */
function isNonChatModel(id: string): boolean {
  if (id === 'auto') return true
  return /^(nes-|completion-)/i.test(id)
}

/** 按模型族挑 UA。 */
export function userAgentFor(product: BuddyProduct, modelId: string): string {
  for (const rule of product.userAgentByModelFamily) {
    if (modelId.startsWith(rule.match)) return rule.ua
  }
  return product.userAgent
}

/**
 * 从 `/v3/config` 响应解析可对话模型。
 *
 * 三处来源按优先级合并：`data.agents[].models[]`（主对话清单）→ `data.models[]`
 * （其余可用模型）→ `productFeaturesConfig.ModelTrialBanner.banners[].targetModelId`
 * （只由试用横幅下发的模型）。解析失败返回空数组，调用方回退内置表。
 */
export function parseModelsFromConfig(body: unknown): ModelMeta[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return []
  const record = data as Record<string, unknown>

  const metaById = new Map<string, Record<string, unknown>>()
  if (Array.isArray(record.models)) {
    for (const item of record.models) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (typeof entry.id === 'string') metaById.set(entry.id, entry)
    }
  }

  const ids: string[] = []
  const push = (id: unknown): void => {
    if (typeof id !== 'string' || id === '' || isNonChatModel(id)) return
    if (!ids.includes(id)) ids.push(id)
  }

  if (Array.isArray(record.agents)) {
    for (const agent of record.agents) {
      if (typeof agent !== 'object' || agent === null) continue
      const models = (agent as Record<string, unknown>).models
      if (Array.isArray(models)) for (const id of models) push(id)
    }
  }
  for (const id of metaById.keys()) push(id)

  const features = record.productFeaturesConfig
  if (typeof features === 'object' && features !== null) {
    const banner = (features as Record<string, unknown>).ModelTrialBanner
    if (typeof banner === 'object' && banner !== null) {
      const banners = (banner as Record<string, unknown>).banners
      if (Array.isArray(banners)) {
        for (const item of banners) {
          if (typeof item !== 'object' || item === null) continue
          push((item as Record<string, unknown>).targetModelId)
        }
      }
    }
  }

  return ids.map((id) => {
    const meta = metaById.get(id) ?? {}
    const contextWindow = typeof meta.maxInputTokens === 'number' ? meta.maxInputTokens : undefined
    const images = meta.supportsImages === true
    const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : id
    return {
      id,
      name,
      agentId: '',
      agentName: '',
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(images ? { inputModalities: ['text', 'image'] as ('text' | 'image')[] } : {}),
      ...(meta.reasoning === undefined ? {} : { reasoning: true }),
    }
  })
}

/** 一次请求要带的头（凭证 + 身份归因）。 */
export function buddyHeaders(product: BuddyProduct, token: string, modelId: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'x-domain': product.apiDomain,
    'x-product-code': product.productCode,
    'x-product': product.attributionName,
    'x-agent-purpose': 'conversation',
    'x-ide-name': product.attributionName,
    'x-ide-type': product.attributionName,
    'x-ide-version': product.clientVersion,
    'user-agent': userAgentFor(product, modelId),
  }
}

/** 从 `{code, data, message}` 信封里取 data。 */
function unwrapData(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return null
  return data as Record<string, unknown>
}

/** 把上游响应压成一句话（错误展示用，截断 200 字）。 */
function summarize(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200)
  try {
    const text = JSON.stringify(body)
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return ''
  }
}

/** `expires_in` / `expiresAt` / `expires_at` 都认；解析不出返回 undefined。 */
function parseExpiresAt(data: Record<string, unknown>): number | undefined {
  for (const key of ['expiresAt', 'expires_at']) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') {
      if (/^\d+$/.test(value)) {
        const number = Number(value)
        return number > 1_000_000_000_000 ? number : number * 1000
      }
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  for (const key of ['expiresIn', 'expires_in']) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Date.now() + value * 1000
  }
  return undefined
}

/** 从 JWT 的 `exp` 读过期时刻（不验签，只用于展示与续期调度）。 */
function jwtExpiryMs(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null) return undefined
    const exp = (payload as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

const CAPABILITIES: AgentCapabilities = {  checkIn: false,
  quota: false,
  models: true,
  tasks: false,
  chat: true,
  reasoning: true,
  source: 'static',
  notes: {
    checkIn: '上游没有公开的每日签到接口',
    quota: '本期未接入积分接口（参考实现里有 credits.ts）',
    tasks: '上游没有活动任务接口',
  },
}

/** WorkBuddy / WorkBuddy International 适配器。 */
export class BuddyAdapter extends BaseAdapter {
  private readonly product: BuddyProduct

  constructor(product: BuddyProduct) {
    super({
      id: product.agentId,
      name: product.displayName,
      doc: product.endpoint,
      credentialHint: '粘贴 access_token（Bearer）。免费额度见上游账号页。',
      capabilities: CAPABILITIES,
      implemented: true,
    })
    this.product = product
  }

  /** 端点：配置里填了 `apiBaseUrl` 就用它（接自有反代），否则用内置产品地址。 */
  private baseUrl(ctx: AdapterContext): string {
    const configured = ctx.config.upstream.apiBaseUrl.trim()
    return (configured !== '' ? configured : this.product.endpoint).replace(/\/+$/, '')
  }

  private tokenOf(record: AccountRecord): string {
    const token = record.credentials.token
    return typeof token === 'string' ? token : ''
  }

  /** 模型目录：`GET /v3/config`。失败回退内置表，但**不假装成功**。 */
  async getModelMetaList(record: AccountRecord, ctx: AdapterContext): Promise<ModelMeta[]> {
    const token = this.tokenOf(record)
    const url = `${this.baseUrl(ctx)}/v3/config`
    let parsed: ModelMeta[] = []
    try {
      const send = ctx.fetch ?? fetch
      const response = await send(url, {
        method: 'GET',
        headers: buddyHeaders(this.product, token, ''),
      })
      if (response.ok) {
        const body: unknown = await response.json()
        parsed = parseModelsFromConfig(body)
      } else {
        ctx.log.debug(`/v3/config 返回 ${response.status}，回退内置模型表`)
      }
    } catch (error) {
      ctx.log.debug(`/v3/config 拉取失败，回退内置模型表：${error instanceof Error ? error.message : String(error)}`)
    }

    const source =
      parsed.length > 0
        ? parsed
        : (FALLBACK_MODELS[this.product.agentId] ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            agentId: this.id,
            agentName: this.name,
            contextWindow: item.contextWindow,
            ...(item.images ? { inputModalities: ['text', 'image'] as ('text' | 'image')[] } : {}),
          }))

    // 归属字段由核心层统一填，这里只保证 id/name/窗口/能力。
    return source.map((meta) => ({ ...meta, agentId: this.id, agentName: this.name }))
  }

  // ── 登录（external-link-v2 轮询式） ────────────────────────────────
  //
  // 流程（参考实现 buddy-oauth.ts，MIT）：
  //   ① POST /v2/plugin/auth/state?platform=<platform> → {state, authUrl}
  //   ② 用户在浏览器打开 authUrl 完成登录
  //   ③ GET  /v2/plugin/auth/token?state=<state> → token（未完成时 error code 11217）
  //
  // 宿主只在用户点「刷新登录状态」时问一次 ③，所以这里**不起定时器**。

  /** ① 拿 authUrl 与 state。 */
  async beginLogin(ctx: AdapterContext): Promise<LoginStartResult> {
    const url = `${this.baseUrl(ctx)}/v2/plugin/auth/state?platform=${encodeURIComponent(this.product.platform)}`
    const send = ctx.fetch ?? fetch
    const response = await send(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-domain': this.product.apiDomain,
        'x-no-authorization': 'true',
        'x-no-user-id': 'true',
        'x-no-enterprise-id': 'true',
        'x-no-department-info': 'true',
        'user-agent': this.product.userAgent,
      },
    })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`auth/state HTTP ${response.status}：${summarize(body)}`)
    }
    const data = unwrapData(body)
    const state = typeof data?.state === 'string' ? data.state : ''
    const authUrl = typeof data?.authUrl === 'string' ? data.authUrl : ''
    if (state === '' || authUrl === '') throw new Error('auth/state 响应缺少 state / authUrl')
    ctx.log.info(`[${this.name}] 已生成登录链接，请在浏览器打开`)
    // 5 分钟：与参考实现的登录超时一致
    return { authUrl, expiresInSec: 300, state }
  }

  /**
   * ③ 问一次 token。
   *
   * `11217` = token 尚未就绪（用户还没登录完），属正常中间态。
   */
  async pollLogin(state: unknown, ctx: AdapterContext): Promise<LoginPollResult> {
    // `state` 可能是字符串（beginLogin 里直接返回上游的 state）也可能是对象
    const session = state as { state?: string } | string | undefined
    const key = typeof session === 'string' ? session : typeof session?.state === 'string' ? session.state : ''
    if (key === '') return { status: 'failed', message: '登录会话状态丢失，请重新发起' }
    const url = `${this.baseUrl(ctx)}/v2/plugin/auth/token?state=${encodeURIComponent(key)}`
    const send = ctx.fetch ?? fetch
    let response: Response
    try {
      response = await send(url, {
        method: 'GET',
        headers: { 'x-no-authorization': 'true', 'user-agent': this.product.userAgent },
      })
    } catch (error) {
      return { status: 'pending', message: `网络错误，稍后再试：${error instanceof Error ? error.message : String(error)}` }
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.status !== 200) {
      const code = Number((body as { code?: unknown } | null)?.code)
      // 11217：token 尚未就绪，继续等用户
      if (code === 11217) return { status: 'pending', message: '还没检测到登录，请先在浏览器完成登录' }
      return { status: 'failed', message: `auth/token HTTP ${response.status}：${summarize(body)}` }
    }
    const data = unwrapData(body)
    if (data === null) return { status: 'pending', message: '还没检测到登录，请先在浏览器完成登录' }
    const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
    if (accessToken === '') return { status: 'pending', message: '还没检测到登录，请先在浏览器完成登录' }
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
    const expiresAt = parseExpiresAt(data) ?? jwtExpiryMs(accessToken)
    return {
      status: 'ready',
      message: '登录成功',
      credentials: {
        token: accessToken,
        ...(refreshToken === '' ? {} : { refreshToken }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      },
    }
  }

  /** 校验：能拿到 `/v3/config` 200 就算凭证可用。 */
  async validateCredentials(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<{ ok: boolean; message?: string; kind?: ErrorKind }> {
    const token = this.tokenOf(record)
    if (token === '') return { ok: false, message: '没有 access_token，请先填凭证', kind: 'auth' }
    try {
      const send = ctx.fetch ?? fetch
      const response = await send(`${this.baseUrl(ctx)}/v3/config`, {
        method: 'GET',
        headers: buddyHeaders(this.product, token, ''),
      })
      if (response.ok) return { ok: true, message: '凭证可用（/v3/config 200）' }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `凭证被拒：HTTP ${response.status}`, kind: 'auth' }
      }
      return { ok: false, message: `上游返回 HTTP ${response.status}`, kind: 'unknown' }
    } catch (error) {
      return { ok: false, message: `连接失败：${error instanceof Error ? error.message : String(error)}`, kind: 'network' }
    }
  }

  /** 对话：标准 OpenAI Chat Completions + SSE。 */
  async *requestChatStream(
    payload: ChatRequest,
    record: AccountRecord,
    ctx: AdapterContext,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const token = this.tokenOf(record)
    if (token === '') {
      yield { type: 'error', failure: { kind: 'auth', message: '没有 access_token', at: Date.now() } }
      return
    }
    const url = `${this.baseUrl(ctx)}/v2/chat/completions`
    const body: Record<string, unknown> = {
      ...payload,
      model: payload.model,
      stream: true,
      stream_options: { include_usage: true },
    }
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]

    let response: Response
    try {
      const send = ctx.fetch ?? fetch
      response = await send(url, {
        method: 'POST',
        headers: buddyHeaders(this.product, token, payload.model),
        body: JSON.stringify(body),
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
        // 读不到原文也没关系，状态码足够分类
      }
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // 可能是 HTML 错误页，保留原文
      }
      yield {
        type: 'error',
        failure: {
          kind: this.detectError(response.status, parsed, response.headers),
          message: text.slice(0, 300) || `HTTP ${response.status}`,
          status: response.status,
          at: Date.now(),
        },
      }
      return
    }

    let malformed = 0
    for await (const event of iterateSse(
      response,
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
