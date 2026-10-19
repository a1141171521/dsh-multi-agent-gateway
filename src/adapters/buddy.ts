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
 * ## 能力按**产品**区分（这是本文件最容易搞错的地方）
 *
 * 「WorkBuddy」在这个插件里指**两个不同产品**，它们的能力**不一样**：
 *
 * | 能力 | 国内（CodeBuddy，copilot.tencent.com） | 国际（WorkBuddy AI，www.workbuddy.ai） |
 * |---|---|---|
 * | 每日签到 | **有** | **没有**（内核里连 `checkin-status` / `daily-checkin` 的字面量都不存在） |
 * | 积分余额 | 有（`get-user-resource`） | **也有**（同端点、同结构，只有 baseURL 不同） |
 * | 对话 / 模型 | 有 | 有 |
 *
 * ⚠️ 所以 `CAPABILITIES` **不能是一份常量给两个产品共用** —— 那样必然有一边在撒谎。
 * 现在由 {@link capabilitiesFor} 按产品各算一份，实例各持一份（不共用同一个对象，
 * 否则改一个会串到另一个）。
 *
 * ⚠️ 「国际版没有签到」**不等于**「国际版查不到余额」：两者是**彼此独立**的能力
 * （参考实现 2026-09-15 实测结论）。不要因为前者顺手把后者也关掉。
 *
 * ## ⚠️ 国际版 checkIn 的守卫（参考实现自己承认的洞，我们这次先补上）
 *
 * 参考实现里 workbuddy 的「不支持签到」守卫是**本功能上线后才补的**。它原来的代码
 * 会落到 buddy 产品分支、**真去发一个必然失败的签到请求**。客户端从不调用它
 * （能力表写着 false），所以这个洞一直没被触发 —— 但只要有人调一次，就会打一次
 * **真实的上游请求**（用国际版凭据去发国内版端点）。
 *
 * 本实现的守卫在 {@link BuddyAdapter.checkIn} 的**最前面**：国际版**一个上游请求
 * 都不发**就返回 `supported: false`，并有单测断言底层 http 调用次数为 0
 * （`test/adapters/buddy.test.mjs`，用假 ctx 记录每次调用）。
 */

import { BaseAdapter } from './base.js'
import { iterateSse } from '../core/sse.js'
import { unsupportedReason } from './messages.js'
import {
  CHECKIN_ACTIVITY_STATUS_PATH,
  DAILY_CHECKIN_PATH,
  USER_RESOURCE_PATH,
  formatCreditAmount,
  normalizeCreditUnit,
  parseCheckinStatus,
  parseClaimOutcome,
  parseCreditBalance,
} from './buddy-credits.js'
import type { BuddyClaimOutcome } from './buddy-credits.js'
import type { LoginPollResult, LoginStartResult } from '../core/login.js'
import type {
  AccountRecord,
  AdapterContext,
  AgentCapabilities,
  ChatRequest,
  CheckInResult,
  ErrorKind,
  ModelMeta,
  QuotaSnapshot,
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
  /**
   * 该产品**有没有**每日签到接口。
   *
   * 只有国内版有（`checkin-activity-status` / `daily-checkin`）。国际版内核里连
   * 这两个路径的字面量都不存在 —— 置 `false` 的产品，{@link BuddyAdapter.checkIn}
   * **一个上游请求都不发**。
   *
   * ⚠️ **这是一个必填字段而不是可选字段**：可选字段会在「新增第三个产品」时被
   * 静默漏填，而漏填的默认值（无论是 true 还是 false）都是一次错误的能力声明。
   * 必填强制每个产品显式回答这个问题。
   */
  hasDailyCheckin: boolean
}

const UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'

/**
 * `X-Product` 在**签到/余额**端点上发送的值。
 *
 * ⚠️ 语义上是「部署类型」，而 `X-Product` 按对话路径的注释应当是**归属名** ——
 * 参考实现这两条路径不一致，详见 {@link BuddyAdapter} 的 `creditsHeaders` 说明。
 * 这里照抄实测过的那一个取值。
 */
const BUDDY_DEPLOYMENT_TYPE = 'SaaS'

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
  hasDailyCheckin: true,
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
  // 国际版内核里没有签到接口（只有 get-dosage-notify 用量通知）⇒ 不发请求。
  hasDailyCheckin: false,
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

/**
 * 取第一个非空字符串；都没有返回 `undefined`。
 *
 * 用于「同一个含义有几种字段名」的取值（见 `creditsHeaders` 的说明）。
 * 刻意不用 `??`：字段存在但是**空串**时，`??` 会把它当成有值，于是发出一个空头。
 */
function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
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

/**
 * 按**产品**算能力表。
 *
 * ⚠️ 不要把这份表变回「两个产品共用的常量」：国内有签到、国际没有，共用一份
 * 必然有一边在撒谎。这里的差异**只有 `checkIn` 一项**，其余两项产品相同。
 *
 * `quota` 两个产品都是 `true` —— 见 `buddy-credits.ts` 的 `USER_RESOURCE_PATH`
 * 说明：余额查询两边都实现，与签到是**彼此独立**的能力。
 */
export function capabilitiesFor(product: BuddyProduct): AgentCapabilities {
  return {
    checkIn: product.hasDailyCheckin,
    quota: true,
    models: true,
    tasks: false,
    chat: true,
    reasoning: true,
    source: 'static',
    notes: {
      checkIn: product.hasDailyCheckin
        ? '每日签到（POST /v2/billing/meter/daily-checkin）。幂等判据是响应体 code 10001，不是 HTTP 状态码'
        : '该产品没有签到接口（国际版内核里不存在 checkin-status / daily-checkin），调用时不会向上游发任何请求',
      quota: '积分余额（POST /v2/billing/meter/get-user-resource）。取本计费周期口径 CycleCapacityRemain，只累加有效包',
      tasks: '上游没有活动任务接口',
    },
  }
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
      // 能力表按产品算：国内有签到、国际没有（见 capabilitiesFor 的说明）。
      capabilities: capabilitiesFor(product),
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

  /**
   * 签到/余额这类**业务接口**的头族。
   *
   * 头**集合**与参考实现的 `credits.ts` → `checkinHeaders`（第 275–292 行）逐条对齐：
   * `Authorization` / `Accept` / `Content-Type` / `X-Domain` / `X-Product` /
   * `X-Product-Code` / `User-Agent`（+ 可选的 `X-User-Id`、`X-Enterprise-Id`、
   * `X-Tenant-Id`）。**没有多加一个头**。
   *
   * ⚠️ **不含 `X-Device-Token`（图灵盾）**：静态分析曾认为该头是主要门槛，但实测
   * 三种请求头组合调用状态接口全部 200，且完全不带该头的请求真实领取成功
   * （code:0, credit:100）并可见状态翻转。故不引入 native SDK。（参考实现实测结论。）
   *
   * ⚠️ **不含 `X-Agent-Purpose` / `X-IDE-*`**：那三个是**对话**请求的形态头，
   * 参考实现的 `checkinHeaders` 里没有，这里也不加。
   *
   * ## ⚠️ 一个必须说清的**分歧**：`X-Product` 到底发什么
   *
   * 参考实现**自己内部就不一致**，两条路径发了不同的值：
   *
   * | 路径 | 出处 | `X-Product` 的值 |
   * |---|---|---|
   * | 对话 | `buddy-adapter.ts:1787` | `product.attributionName`（`CodeBuddy` / `WorkBuddy`） |
   * | 签到 / 余额 | `credits.ts:281` | `BUDDY_DEPLOYMENT_TYPE` = **`SaaS`** |
   *
   * 而 `buddy-adapter.ts:1781` 的注释明确说：`X-Product` 是**归属名**，
   * 「历史实现发成 `SaaS`（部署类型语义）导致后台归因不到产品」。也就是说
   * **对话路径把这件事修过了，签到路径没修**（`buddy-oauth.ts:375` 也仍是 `SaaS`）。
   *
   * **我们这里照抄 `SaaS`**，理由不是「它更对」，而是它是**唯一被实测验证过能通的
   * 取值** —— `credits.ts` 模块头记录的「真实领取成功（code:0, credit:100）」
   * 那次请求，`X-Product` 发的就是 `SaaS`。而发 `attributionName` 在签到端点上
   * **没有任何实测证据**。
   *
   * 取舍是**不对称**的：照抄 `SaaS` 最坏的结果是后台「使用端」列显示 `-`（纯展示
   * 归因问题）；换成 `attributionName` 若被端点校验，最坏结果是签到与额度**整个不可用**。
   * 本机没有 WorkBuddy 账号，无法验证后者 —— 所以选**有证据的那个**。
   *
   * ☞ 待办（留给 Lead 决定，不在本任务写作用域内）：若将来能用真实账号验证
   * `attributionName` 在签到端点上也通，应把两处统一成归属名，并回报给参考实现。
   */
  private creditsHeaders(record: AccountRecord): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.tokenOf(record)}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-domain': this.product.apiDomain,
      // 见上方「X-Product 到底发什么」：照抄参考实现 credits.ts 的实测取值。
      'x-product': BUDDY_DEPLOYMENT_TYPE,
      'x-product-code': this.product.productCode,
      'user-agent': this.product.userAgent,
    }
    // 账号/企业标识可选（没有就不发）—— 参考实现同样只在这两个字段非空时才带上：
    // 空串头发出去会被网关当成「有值但为空」，反而坏事。
    // ⚠️ 两种命名都认：参考实现用 snake_case（`user_id` / `enterprise_id`），
    //    而本插件其他适配器的习惯是短名（如 Qoder 的 `uid`）。手工粘贴凭据的用户
    //    可能写成任一种，认两种不会错，只认一种会静默少发头。
    const userId = firstNonEmpty(record.credentials.user_id, record.credentials.userId)
    if (userId !== undefined) headers['x-user-id'] = userId
    const enterpriseId = firstNonEmpty(record.credentials.enterprise_id, record.credentials.enterpriseId)
    if (enterpriseId !== undefined) {
      headers['x-enterprise-id'] = enterpriseId
      headers['x-tenant-id'] = enterpriseId
    }
    return headers
  }

  /**
   * 模型目录：`GET /v3/config`。失败回退内置表，但**不假装成功**。
   *
   * ⚠️ **没有 token（= 还没登录）时返回空列表**：内置表是产品级目录，登录前也
   * 拿得到，但一个模型都调不动；列出来只有一堆「未知倍率」，用户会以为已经能用
   * （报障原话：「还没登录账号就拉取到了模型，但是倍率是未知」）。
   */
  async getModelMetaList(record: AccountRecord, ctx: AdapterContext): Promise<ModelMeta[]> {
    const token = this.tokenOf(record)
    if (token === '') return []
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

  // ───────────────────────── 每日签到 ─────────────────────────

  /**
   * 每日签到。
   *
   * 事实来源：`dsh-our-free-model` 的 `vendor/channel-pack/src/credits.ts`（MIT），
   * 端点为对 WorkBuddy 5.5.6 逆向 + 2026-09-14 真实请求实测。
   *
   * 两段式：先查 `checkin-activity-status`（**权威**状态源），再按需 `daily-checkin`。
   * 先查状态能省掉一次无效的领取请求（活动未开 / 今天已领时直接短路）。
   *
   * ⚠️ **第一步就是产品守卫**：没有签到接口的产品在这里返回，**不发任何上游请求**。
   * 理由见文件头「国际版 checkIn 的守卫」—— 少了它就会用国际版凭据去打国内版端点，
   * 必然失败，而且是一次**真实**的上游请求。
   */
  async checkIn(record: AccountRecord, ctx: AdapterContext): Promise<CheckInResult> {
    const at = ctx.now()

    // ① 产品守卫。**必须放在任何网络调用之前**，且不能靠「试一次再判」——
    //    「不支持」是产品事实，不是探测结果。
    if (!this.product.hasDailyCheckin) {
      return {
        ok: false,
        supported: false,
        message: `${unsupportedReason(this.name, '每日签到')}。该产品只在 CodeBuddy（国内版）提供签到，国际版内核里没有签到接口`,
        at,
      }
    }

    const token = this.tokenOf(record)
    if (token === '') {
      return { ok: false, supported: true, message: '没有 access_token，请先填凭证', kind: 'auth', at }
    }

    const base = this.baseUrl(ctx)
    const headers = this.creditsHeaders(record)

    // ② 状态预检。拿不到状态（status === null）**不判定**，继续尝试领取 ——
    //    「不知道」不等于「不能领」，交给领取接口以响应体 code 定夺。
    const statusResult = await ctx.http(`${base}${CHECKIN_ACTIVITY_STATUS_PATH}`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    if (!statusResult.ok) {
      // 状态查询本身失败：如实回报故障，不猜「今天已领」。
      // （404 例外见下：端点不存在 = 该产品没有签到，不是故障。）
      if (statusResult.kind === 'not_found') {
        return {
          ok: false,
          supported: false,
          message: `${unsupportedReason(this.name, '每日签到')}（${CHECKIN_ACTIVITY_STATUS_PATH} 返回 404）`,
          at,
        }
      }
      return {
        ok: false,
        supported: true,
        message: statusResult.message ?? `签到状态查询失败（HTTP ${statusResult.status}）`,
        kind: statusResult.kind,
        at,
      }
    }

    const status = parseCheckinStatus(statusResult.body)
    if (status !== null) {
      if (!status.active) {
        // 「活动没开」有两类语义，这里只报**等一会儿**那类（`actionRequired` 缺省
        // false）。真正「需要用户去别处操作」的情形要在拿到证据后再标，
        // 见 `buddy-credits.ts` 的 `parseClaimOutcome` 说明。
        return {
          ok: false,
          supported: true,
          message: status.activityName !== '' ? `签到活动「${status.activityName}」当前未开启，稍后再试` : '签到活动当前未开启，稍后再试',
          at,
        }
      }
      if (status.todayCheckedIn) {
        // ⚠️ 这是**幂等命中**，不是失败：ok:true。
        // `coversToday` 缺省 true —— WorkBuddy 是普通每日签到，按服务端日结算，
        // 没有「固定时刻刷新」那类歧义（Qoder 才有，见 core/types.ts）。
        const parts = [`今天已签到`]
        if (status.todayCredit > 0) parts.push(`今日已领 ${formatCreditAmount(status.todayCredit)} 积分`)
        if (status.streakDays > 0) parts.push(`连续 ${status.streakDays} 天`)
        return { ok: true, supported: true, credits: 0, message: parts.join('，'), at }
      }
    }

    // ③ 领取。
    const claimResult = await ctx.http(`${base}${DAILY_CHECKIN_PATH}`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    // ⚠️ **不能只看 HTTP 状态码**：重复领取是 400 + code 10001。所以即便 `!ok`
    //    也要解析响应体 —— 幂等判据在 body 里。
    const outcome = parseClaimOutcome(claimResult.body)
    return this.toCheckInResult(outcome, claimResult, at)
  }

  /** 把领取结论翻成 {@link CheckInResult}。 */
  private toCheckInResult(
    outcome: BuddyClaimOutcome,
    response: { ok: boolean; status: number; kind: ErrorKind; message?: string },
    at: number,
  ): CheckInResult {
    switch (outcome.kind) {
      case 'claimed':
        return {
          ok: true,
          supported: true,
          credits: outcome.credit,
          message:
            outcome.credit > 0
              ? `签到成功，+${formatCreditAmount(outcome.credit)} 积分${
                  outcome.streakDays > 0 ? `（连续 ${outcome.streakDays} 天）` : ''
                }`
              : `签到成功${outcome.delayedMessage !== undefined ? `：${outcome.delayedMessage}` : '（本次未读回到账积分数）'}`,
          at,
        }
      case 'already-claimed':
        // 400 + code 10001 落在这里。**这是成功而不是失败** —— 报成失败会让
        // 自动签到把它记为故障并反复重试。
        return { ok: true, supported: true, credits: 0, message: outcome.message, at }
      case 'inactive':
        return {
          ok: false,
          supported: true,
          message: outcome.message,
          ...(outcome.actionRequired === true ? { actionRequired: true } : {}),
          at,
        }
      default: {
        // 真实失败。业务码非 0 且不属于上面几类。
        //
        // ⚠️ 响应体不是 JSON 时（`code: -1`）**优先用 HTTP 层的原因**：凭据过期时
        // 腾讯网关返回的是 **HTML 错误页**而不是 JSON。若照搬解析层的「不是 JSON 对象」，
        // 用户既不知道发生了什么，也看不出该重新登录（参考实现里这条是真实缺陷：
        // 用户看到的就是 `Unexpected token '<'` 那句）。
        const httpFailed = !response.ok
        let message = outcome.message
        if (httpFailed && response.kind === 'auth') {
          message = `凭据已失效（HTTP ${response.status}），请重新登录该账号`
        } else if (httpFailed && outcome.code === -1) {
          message = response.message ?? `领取失败（HTTP ${response.status}）`
        }
        return {
          ok: false,
          supported: true,
          message,
          // 业务码非 0 且不属于上面几类 = 真实失败。kind 优先用 HTTP 层分类，
          // 但 400 会被分类成 `bad_request` —— 那正是「不能换号重试」的语义，
          // 对未知业务码是合适的保守选择。
          kind: response.ok ? 'unknown' : response.kind,
          at,
        }
      }
    }
  }

  // ───────────────────────── 积分余额 ─────────────────────────

  /**
   * 积分余额。
   *
   * ⚠️ **两个产品通用**：`get-user-resource` 在 CodeBuddy 中国版与 WorkBuddy 国际版
   * 都实现，请求头与响应结构完全一致，只有 baseURL 不同。**不要**因为「国际版没有
   * 签到」就顺手把余额也关掉 —— 两者是彼此独立的能力（参考实现 2026-09-15 实测）。
   *
   * 取**本计费周期口径**（`CycleCapacityRemain`）而不是终身口径，只累加**有效**包：
   * 理由见 `buddy-credits.ts` 的 `parseCreditPackage` / `parseCreditBalance`。
   * 这与 IDE 顶部的 "Credits Balance" 一致，用户可直接核对。
   */
  async getQuota(record: AccountRecord, ctx: AdapterContext): Promise<QuotaSnapshot> {
    const at = ctx.now()
    const token = this.tokenOf(record)
    if (token === '') {
      return { accountId: record.id, unit: 'credits', fetchedAt: at, error: '没有 access_token，请先填凭证' }
    }

    const result = await ctx.http(`${this.baseUrl(ctx)}${USER_RESOURCE_PATH}`, {
      method: 'POST',
      headers: this.creditsHeaders(record),
      body: '{}',
    })
    if (!result.ok && result.kind === 'not_found') {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt: at,
        error: `${unsupportedReason(this.name, '额度查询')}（${USER_RESOURCE_PATH} 返回 404）`,
      }
    }
    if (!result.ok) {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt: at,
        error: result.message ?? `额度查询失败（HTTP ${result.status}）`,
      }
    }

    const balance = parseCreditBalance(result.body, at)
    if (balance === null) {
      // 「查不到」与「余额为 0」必须分开：把解析失败显示成 0 积分会误导用户。
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt: at,
        error: '上游返回的积分数据无法解析（可能是响应结构变了）',
      }
    }

    // `extra` 原样保留逐包明细，供 UI 展开。包名与单位都保留**服务端原值**
    // （单位不做归一化 —— 归一化只在「当分组键/展示名用」那一步做）。
    const activeCount = balance.packages.filter((pkg) => pkg.active).length
    return {
      accountId: record.id,
      unit: 'credits',
      remaining: balance.total,
      fetchedAt: at,
      extra: {
        packages: balance.packages,
        expiredTotal: balance.expiredTotal,
        packageCount: balance.packages.length,
        activePackageCount: activeCount,
        // 展示口径的单位（`credit` / `credits` 归一成一个分组键，见 normalizeCreditUnit）。
        displayUnit: normalizeCreditUnit(balance.packages.find((pkg) => pkg.active)?.unit ?? ''),
      },
    }
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
