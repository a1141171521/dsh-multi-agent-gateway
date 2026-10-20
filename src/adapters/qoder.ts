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
import type { QoderDeviceSession } from '../vendor/qoder/qoder.js'
import { unwrapQoderEnvelopeStream } from '../vendor/qoder/qoder-envelope.js'
import {
  QODER_CAMPAIGNS_PATH,
  QODER_CREDITS_TIMEOUT_MS,
  QODER_USAGE_PATH,
  claimableQoderCampaigns,
  hasClaimedQoderBenefit,
  interpretQoderClaim,
  isQoderNotActivated,
  parseQoderCampaigns,
  parseQoderUsage,
  qoderClaimUrl,
  qoderCreditsHeaders,
  qoderTotalRemaining,
} from '../vendor/qoder/qoder-credits.js'
import type { QoderCampaigns } from '../vendor/qoder/qoder-credits.js'
import type { LoginPollResult, LoginStartResult } from '../core/login.js'
import { QODER, isVendorModel } from '../vendor/qoder/qoder-product.js'
import type { QoderProduct, QoderFallbackModel, QoderModelPromotion } from '../vendor/qoder/qoder-product.js'
import { hasQoderCampaignRefreshedToday, QODER_CAMPAIGN_REFRESH_HOUR_UTC8 } from '../core/time.js'
import type {
  AccountRecord,
  AdapterContext,
  AgentCapabilities,
  ChatMessage,
  ChatRequest,
  CheckInResult,
  ErrorKind,
  ModelMeta,
  QuotaSnapshot,
  StreamEvent,
} from '../core/types.js'

/** Qoder CN 的产品常量（与 QODER 的差别只在 host 与目录，见参考实现的注释）。 */
export const QODER_CN: QoderProduct = {
  ...QODER,
  id: 'qodercn',
  displayName: 'Qoder CN',
  authBase: 'https://qoder.com.cn',
  openApiBase: 'https://openapi.qoder.com.cn',
  inferBase: 'https://gateway.qoder.com.cn',
  encryptedInferBase: 'https://gateway.qoder.com.cn',
  defaultCredentialRef: 'QODER_CN_ACCESS_TOKEN',
}

const CAPABILITIES: AgentCapabilities = {
  checkIn: true,
  quota: true,
  models: true,
  tasks: false,
  chat: true,
  reasoning: true,
  source: 'static',
  notes: {
    checkIn:
      '每日领取走 /sash/api/v1/me/campaigns；活动每日 10:00（UTC+8）刷新，' +
      `刷新前查询会如实回报「尚未刷新」并带 coversToday=false（当天稍后自动重试）。刷新时刻：${QODER_CAMPAIGN_REFRESH_HOUR_UTC8}:00 UTC+8`,
    quota: '积分余额取 /sash/api/v2/me/usage 的 addOnQuota.remaining（userQuota 实测恒为 0 的占位）',
    models: '模型目录来自产品兜底表（加密目录需 WASM 解密，本期未接）',
    tasks: 'Qoder 的活动就是每日领取，已并入签到；没有独立的「活动任务」接口',
  },
}

/** 单次积分/活动请求的超时（毫秒）；与 vendor 里的常量同源。 */
const QODER_CREDITS_TIMEOUT_MS_FALLBACK = QODER_CREDITS_TIMEOUT_MS


/**
 * 「今天的活动还没刷新」的提示。
 *
 * ⚠️ 必须与 {@link NOT_ACTIVATED_MESSAGE} 分开：前者「等一会儿就好」（可重试），
 * 后者要用户去官方客户端操作。判错的代价是方向性的 —— 说成「已领取」会让用户
 * 真的错过今天的额度。
 */
const NOT_REFRESHED_MESSAGE =
  `今天的每日活动尚未刷新（每日 ${QODER_CAMPAIGN_REFRESH_HOUR_UTC8}:00（UTC+8）刷新），` +
  '当前看到的是昨天那一轮，请稍后再来领取。'

/**
 * 账号尚未在 Qoder 侧「开通过」时的提示文案。
 *
 * ⚠️ **真实缺陷（参考实现用户报障，2026-09-26）**：经 GitHub 授权新注册的 Qoder
 * 账号尚未在 Qoder 侧开通每日领取，一键签到只说「当前没有可领取的活动」，
 * 用户不知道该怎么办。实测证明**不是设备身份问题**（4 个 uid 经 `runtime-info.exe`
 * 产出的 token/type 完全相同，即身份是设备级），而是该账号确实没有每日领取活动。
 *
 * 文案要**可操作**：看完应知道「去 IDE 登录一次」，而不是面对「没有可领取的活动」
 * 无从下手。
 */
const NOT_ACTIVATED_MESSAGE =
  '该账号尚未在 Qoder 侧开通每日领取（每日 100 Credits）。' +
  '请先用 Qoder 官方客户端登录一次该账号，开通后再回来领取。'

/** 从 JWT 载荷里取用户 id；取不到返回空串。 */
export function uidFromToken(token: string): string {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const json = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')
    const payload: unknown = JSON.parse(json)
    if (typeof payload !== 'object' || payload === null) return ''
    const record = payload as Record<string, unknown>
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
export function machineIdOf(accountId: string): string {
  const hex = createHash('sha256').update(`qoder:${accountId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * 一个模型**实际可选**的思考档位（逐字对齐参考实现 `qoderEffortsFor`）。
 *
 * ## 为什么必须把 `none` 追加进来（而不是在目录表里手写）
 *
 * 「关闭思考」**不在** `thinking_config.enabled.efforts` 里 —— 它由目录的
 * `disabled` 分支表达。官方客户端是在 `gU()` 里**运行时追加**的：
 *
 * ```js
 * gU(A){ let e=…efforts; return A.supports_disabled||A.supportsDisabled||e.includes("none")
 *   ? e : [...e,"none"] }
 * ```
 *
 * 所以这里的规则与本仓库 `vendor/qoder/qoder-product.ts` 的字段注释一致：
 * **`efforts` 表里不要手写 `none`**（那会与 `supportsDisable` 语义重复），
 * 而是在这里按 `supportsDisable` 追加一次。
 *
 * ## 两条必须守住的口径
 *
 * 1. **档位值必须落在上游白名单内**（`['none','low','medium','high','xhigh','max']`），
 *    不在的会被客户端 `ao()` **静默丢弃** —— 也就是说报一个上游不认的档位，
 *    用户选了等于没选，而且没有任何报错。
 * 2. **`supportsThinking` 为假不代表没有档位**：实测 CN 的 `performance` 是
 *    `is_reasoning: false` 但 `thinking_config.enabled` 为真，上游**确实**提供
 *    档位选择。所以这里只按 `efforts` / `supportsDisable` 判断，**不看**
 *    `supportsThinking`（那个字段只决定请求体里的 `isReasoning`）。
 */
export function qoderEffortsOf(model: QoderFallbackModel): string[] {
  const efforts = [...(model.efforts ?? [])]
  if (model.supportsDisable === true && !efforts.includes('none')) efforts.push('none')
  return efforts
}

/**
 * 当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **不要用目录里的 `promotion.active`**：那是「目录下发那一刻」的快照，
 * 客户端长时间不重启就会过期，会让用户在窗口外看到折后价（按折扣价预期、
 * 实际按原价计费）。窗口本身（`windowStart`/`windowEnd`）稳定，按当前时间算。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致），
 * 支持跨零点（如 22:00–08:00）。字段缺失或格式不对时回退到目录的 `active`。
 *
 * 逐字对齐参考实现 `dsh-our-free-model` 的 `promotionActiveNow`。
 */
export function promotionActiveNow(promotion: QoderModelPromotion, now: Date): boolean {
  const { windowStart, windowEnd } = promotion
  if (windowStart === undefined || windowEnd === undefined) return promotion.active === true
  const toMinutes = (hhmm: string): number | undefined => {
    const matched = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
    if (matched === null) return undefined
    const hour = Number(matched[1])
    const minute = Number(matched[2])
    return hour < 24 && minute < 60 ? hour * 60 + minute : undefined
  }
  const start = toMinutes(windowStart)
  const end = toMinutes(windowEnd)
  if (start === undefined || end === undefined) return promotion.active === true

  const utc8 = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes()
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** 某个模型此刻是否正在打折（没有 promotion 就是没打折）。 */
export function isPromotionActive(model: QoderFallbackModel, now: Date): boolean {
  const promo = model.promotion
  if (promo === undefined) return false
  if (promo.beforePromotionPriceFactor === undefined || promo.discountFactor === undefined) return false
  return promotionActiveNow(promo, now)
}

/**
 * 从上游响应里挖出用户 id。
 *
 * 不同端点的字段名不一样，实测：
 *   - `/sash/api/v2/me/usage`      → `qoderUsage.userId`
 *   - `/sash/api/v1/me/campaigns`  → 顶层 `uid`
 *
 * 所以按已知字段名**递归**找，而不是写死某一条路径（上游改层级也不会立刻崩）。
 */
export function findUserId(body: unknown): string {
  const wanted = ['userId', 'user_id', 'uid']
  const visit = (value: unknown, depth: number): string => {
    if (depth > 6 || value === null || typeof value !== 'object') return ''
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 5)) {
        const hit = visit(item, depth + 1)
        if (hit !== '') return hit
      }
      return ''
    }
    const record = value as Record<string, unknown>
    for (const key of wanted) {
      const child = record[key]
      if (typeof child === 'string' && child !== '') return child
      if (typeof child === 'number') return String(child)
    }
    for (const child of Object.values(record)) {
      const hit = visit(child, depth + 1)
      if (hit !== '') return hit
    }
    return ''
  }
  return visit(body, 0)
}

/**
 * 此刻的**生效倍率**。
 *
 * 规则（逐字对齐参考实现的 `qoderDisplayName`）：
 *
 *   - 窗口内：`beforePromotionPriceFactor × discountFactor`（折后价）
 *   - 窗口外：`beforePromotionPriceFactor`（**原价**，不是采集到的折后价）
 *   - 没有 promotion：目录的 `priceFactor`
 *
 * ⚠️ 为什么不能直接用 `priceFactor`：它是**采集那一刻**的价，窗口一切换就失真。
 * 实测 `Qwen3.8-Max` 存的 `0.2` 是窗口内折后价，窗口外应为 `0.5`。
 */
export function effectiveMultiplier(model: QoderFallbackModel, now: Date): number | undefined {
  const promo = model.promotion
  const before = promo?.beforePromotionPriceFactor
  const discount = promo?.discountFactor
  if (promo !== undefined && before !== undefined && discount !== undefined) {
    return isPromotionActive(model, now) ? Number((before * discount).toFixed(4)) : before
  }
  return typeof model.priceFactor === 'number' ? model.priceFactor : undefined
}

/** 我们自己的消息 → Qoder 的 `QoderInferMessage`。 */
function toInferHistory(messages: readonly ChatMessage[]): { userText: string; systemText?: string; history: Array<{ role: string; content: string }> } {
  const history: Array<{ role: string; content: string }> = []
  let systemText: string | undefined
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
  private readonly product: QoderProduct
  /** 每个账号一个 WASM 上下文（构造有成本，缓存起来）。 */
  private readonly clients = new Map<string, QoderEncryptedInfer>()

  constructor(product: QoderProduct) {
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

  private tokenOf(record: AccountRecord): string {
    const token = record.credentials.token
    return typeof token === 'string' ? token : ''
  }

  // ── 登录（设备码 + PKCE） ──────────────────────────────────────────
  //
  // 流程：打开 `authBase/device/selectAccounts?...` → 用户在浏览器登录 →
  // 用户点「刷新登录状态」→ 宿主问一次 `openApiBase/api/v1/deviceToken/poll`。

  /** ① 生成授权链接（PKCE + nonce 只留在宿主会话里）。 */
  async beginLogin(_ctx: AdapterContext): Promise<LoginStartResult> {
    const session = createQoderDeviceSession(machineIdOf(this.id))
    const authUrl = buildQoderAuthUrl(session, this.product)
    return { authUrl, expiresInSec: 300, state: session }
  }

  /** ② 问一次 token：拿到就交给宿主落盘。 */
  async pollLogin(state: unknown, ctx: AdapterContext): Promise<LoginPollResult> {
    const session = state as QoderDeviceSession | undefined
    if (session === undefined || session === null) {
      return { status: 'failed', message: '登录会话状态丢失，请重新发起' }
    }
    let body: unknown = null
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
    const envelope = body as { data?: unknown } | null
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
        /**
         * ⚠️ **`uid` 必须落盘**，它不在 token 里。
         *
         * Qoder 的设备码响应给的是 `dt-...` 这样的**不透明设备令牌**，不是 JWT ——
         * `uidFromToken()` 在它身上永远解不出东西。而加密推理要用 uid 派生
         * `encrypt_user_info`，缺了就签名无效。
         *
         * 参考实现（dsh-our-free-model 的 `qoder.ts`）把 `user_id` 从**设备码响应**
         * 里读出来单独存（`buildQoderCredential` 的 `uid` 字段），并在缺 uid 时
         * **明确报错**而不是发一个必然失败的请求。
         *
         * 早期这里漏存 → 每次对话都报「token 里解不出 user_id」，
         * 而用户明明刚登录成功。
         */
        ...(payload.uid === undefined || payload.uid === '' ? {} : { uid: payload.uid }),
      },
      ...(payload.userName === undefined || payload.userName === '' ? {} : { label: payload.userName }),
    }
  }

  /**
   * 模型目录：用产品兜底表（加密目录需另接解密，本期不做）。
   *
   * ⚠️ **没有账号（= 没有 token）时返回空列表**。这张表是「产品级目录」，
   * 跟账号无关 —— 但不登录就一个模型也调不动。早期没登录也会列 17 个模型，
   * 而且倍率全是「未知倍率」，用户以为是插件坏了（报障原话：
   * 「还没登录账号就拉取到了模型，但是倍率是未知」）。
   * 现在交给界面引导「先登录」，登录后再列。
   *
   * ## ⚠️ 只上报**厂商模型**，档位/路由名要滤掉（用户 2026-10-20 要求）
   *
   * 目录里的 `auto` / `ultimate` / `performance` / `efficient` / `smodel`(Sonus) /
   * `cmodel`(Cantus) 是 **Qoder 自己的档位（tier）与路由名**，不是任何厂商的模型
   * （官方文档把「档位」与「具体模型」分两张表列，倍率逐条对得上）。
   * 它们混在选择器里会让人以为可以直连。
   *
   * ⚠️ **是「不上报」而不是「删掉」**：这些条目仍留在
   * `vendor/qoder/qoder-product.ts` 的表里 —— 那张表同时被
   * `effectiveMultiplier` / `qoderEffortsOf` 等**按 id 查表**的路径使用，
   * 物理删除会让「用户以前勾选过 `smodel`」变成**悬空引用**。
   * 判据与官方依据写在 `QODER_NON_VENDOR_MODEL_IDS` 的注释里。
   *
   * ## 倍率怎么算（**不能直接用 `price_factor`**）
   *
   * `price_factor` 是**采集那一刻的生效价**，会随错峰窗口变化 —— 直接显示它，
   * 窗口切换后就失真了（窗口内看着便宜、实际按原价计费，反之亦然）。
   *
   * 参考实现（dsh-our-free-model 的 `qoderDisplayName` / `promotionActiveNow`）的做法：
   *
   *   - 窗口内：`beforePromotionPriceFactor × discountFactor`（折后价）
   *   - 窗口外：`beforePromotionPriceFactor`（**原价**）
   *   - 没有 promotion 的模型：`priceFactor`
   *
   * 实测关系式 `priceFactor === before × discount` 三条全部吻合 —— 所以
   * `Qwen3.8-Max` 目录里存的 `0.2` 是**22:00–08:00 窗口内的折后价**，
   * 窗口外（白天）正确的倍率是 **×0.5**。用户报的「正确倍率是 x0.5」就是这个。
   *
   * ## 「免费」只认 `price_factor === 0`
   *
   * `is_free` 的含义是「**免费额度模型**」——照样按倍率扣积分，只是额度由免费档供给。
   * 真正零成本的只有 `qfmodel`（Qwen3.8-Flash，`price_factor: 0`）。
   */
  async getModelMetaList(record: AccountRecord, _ctx: AdapterContext): Promise<ModelMeta[]> {
    if (this.tokenOf(record) === '') return []
    const now = new Date()
    return (this.product.fallbackModels ?? [])
      // 档位/路由名不上报（仍留在表里，见上）。两份产品表共用这一处过滤。
      .filter((model) => isVendorModel(model.id))
      .map((model) => {
      const multiplier = effectiveMultiplier(model, now)
      const discounted = isPromotionActive(model, now)
      const efforts = qoderEffortsOf(model)
      return {
        id: model.id,
        name: model.name,
        agentId: this.id,
        agentName: this.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.supportsImage ? { inputModalities: ['text', 'image'] as ('text' | 'image')[] } : {}),
        ...(model.supportsThinking ? { reasoning: true } : {}),
        // 思考档位：**必须报给核心层**，否则选择器里不会出现档位行。
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
        // 默认档：目录里的 `is_default` 就是官方客户端的选中项，照实上报
        // （不报的话核心层会用启发式猜一个，实测会把 `dfmodel` 的 max 猜成 low）。
        ...(model.defaultEffort !== undefined ? { defaultReasoningEffort: model.defaultEffort } : {}),
        ...(multiplier === undefined ? {} : { multiplier, multiplierSource: 'qoder:catalog' }),
        // 只有 0 才是真免费；`is_free` 另作说明，不影响「免费」标签。
        ...(multiplier === 0 ? { free: true } : {}),
        ...(model.isFree === true && multiplier !== 0 ? { description: '免费额度模型（仍按倍率扣积分）' } : {}),
        ...(discounted && model.promotion?.beforePromotionPriceFactor !== undefined
          ? {
              description:
                `${model.isFree === true ? '免费额度模型 · ' : ''}` +
                `错峰折扣中：原价 ×${model.promotion.beforePromotionPriceFactor} → 现价 ×${multiplier}`,
            }
          : {}),
      }
    })
  }

  /**
   * 取 uid：**优先用凭证里存的**，其次尝试从 JWT 解。
   *
   * 为什么这个顺序不能反：Qoder 设备码登录给的是 `dt-...` 不透明令牌，
   * JWT 解析必然失败；真正可靠的来源是登录响应里的 `user_id`（已落盘）。
   *
   * 两种来源都拿不到时返回空串，由调用方走 {@link resolveUid} 兜底。
   */
  private uidOf(record: AccountRecord): string {
    const stored = record.credentials.uid
    if (typeof stored === 'string' && stored !== '') return stored
    return uidFromToken(this.tokenOf(record))
  }

  /**
   * 补齐缺失的 **uid**：问一次上游的用量接口。
   *
   * 为什么要有这条兜底：`uid` 是**登录响应**里的字段，早期版本漏存了它 ——
   * 已经登录过的账号在磁盘上没有 uid，但**并不需要用户重新登录**：
   * `/sash/api/v2/me/usage`（以及 `/sash/api/v1/me/campaigns`）只认
   * `Bearer <device token>`，**不需要 WASM 签名**，响应里带 `userId` / `uid`。
   * （实测 2026-10-19：两个端点都回 200，userId 一致。）
   *
   * 拿到之后由调用方回写凭证，下次直接用，不再重复请求。
   */
  private async resolveUid(record: AccountRecord, ctx: AdapterContext): Promise<string> {
    const token = this.tokenOf(record)
    if (token === '') return ''
    for (const path of ['/sash/api/v2/me/usage', '/sash/api/v1/me/campaigns']) {
      try {
        const result = await ctx.http(`${this.product.openApiBase}${path}`, {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            'cosy-clienttype': this.product.clientMetadata?.client_type ?? '5',
          },
        })
        if (!result.ok) continue
        const uid = findUserId(result.body)
        if (uid !== '') {
          ctx.log.info(`已从上游补齐 uid（${path}）`, `account=${record.id}`)
          return uid
        }
      } catch (error) {
        ctx.log.debug(`补齐 uid 失败（${path}）`, error instanceof Error ? error.message : String(error))
      }
    }
    return ''
  }

  // ───────────────────────────── 积分与每日领取 ─────────────────────────────
  //
  // 事实与端点全部记在 `src/vendor/qoder/qoder-credits.ts` 的文件头（含
  // 「machine 头不必带」这条与参考实现相左的本机实测）。这里只负责：
  //   ① 把 vendor 的纯函数接到 `ctx.http`；② 决定「今天」这一层的语义。

  /**
   * 问一次上游并解析 JSON；失败时给出可读原因。
   *
   * 用 `ctx.http`（带超时/错误分类/凭证脱敏）而不是裸 `fetch`：
   * 这三个端点都在**同一个 openApiBase** 上，超时与错误分类口径要与其它适配器一致。
   */
  private async getJson(
    url: string,
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<{ ok: true; body: unknown } | { ok: false; kind: ErrorKind; message: string; status: number }> {
    const token = this.tokenOf(record)
    let result
    try {
      result = await ctx.http(url, {
        headers: qoderCreditsHeaders(this.product, token),
        timeoutMs: QODER_CREDITS_TIMEOUT_MS_FALLBACK,
      })
    } catch (error) {
      return {
        ok: false,
        kind: 'network',
        message: error instanceof Error ? error.message : String(error),
        status: 0,
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        kind: result.kind,
        message: result.message ?? `HTTP ${result.status}`,
        status: result.status,
      }
    }
    if (typeof result.body !== 'object' || result.body === null) {
      return { ok: false, kind: 'unknown', message: '上游返回的不是 JSON 对象', status: result.status }
    }
    return { ok: true, body: result.body }
  }

  /** 拉活动列表；取不到返回 `{ ok: false }`（**不判定**，由调用方保守处理）。 */
  private async loadCampaigns(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<{ ok: true; parsed: QoderCampaigns } | { ok: false; kind: ErrorKind; message: string }> {
    const response = await this.getJson(`${this.product.openApiBase}${QODER_CAMPAIGNS_PATH}`, record, ctx)
    if (!response.ok) return { ok: false, kind: response.kind, message: response.message }
    const parsed = parseQoderCampaigns(response.body)
    if (parsed === undefined) {
      return { ok: false, kind: 'unknown', message: '活动列表响应形状与预期不符' }
    }
    return { ok: true, parsed }
  }

  /** 拉原始用量响应体；取不到返回 undefined（`undefined` 与「余额 0」严格区分）。 */
  private async loadUsageRaw(record: AccountRecord, ctx: AdapterContext): Promise<unknown> {
    const response = await this.getJson(`${this.product.openApiBase}${QODER_USAGE_PATH}`, record, ctx)
    return response.ok ? response.body : undefined
  }

  /**
   * 每日领取。
   *
   * ## 三条判据（每条都对应一个真实缺陷）
   *
   * **① 幂等看响应体的 `replayed`，不是 HTTP 状态码。**
   * 重复领取同样返回 200，但 `replayed:true`、不含 `benefit`、`claimedAt` 是旧时间。
   * 只看状态码会把「今天已领」误报成「领取成功 +100」。
   *
   * **② 活动每日 10:00（UTC+8）刷新，刷新前看到的 `CLAIMED` 属于昨天。**
   * 所以判「今天已领」必须先确认已刷新；刷新前一律 `coversToday: false` ——
   * 记账层据此**不记账**，当天 10 点后仍会真的去领。
   * 说成「今天已领」是不可逆的方向：用户以为不必再领，于是**整天漏掉 100 积分**。
   *
   * **③ 「未开通」与「今天已领」必须分开。**
   * 活动列表里没有 `CLAIM_BENEFIT` **且** 用量响应缺 `addOnQuota` 字段
   * （注意是**缺失**，不是 0）→ 账号还没在 Qoder 侧开通过，要用户去官方客户端登录一次。
   * 这一条带 `actionRequired: true`（UI 判布尔字段，不判文案）。
   * 判错方向的代价同样是用户真的错过当天额度。
   *
   * ## 取不到上游时**不判定**
   *
   * 活动列表或用量查询失败时，一律 `ok:false` + `kind`（真实失败），
   * 绝不猜成「已领」也绝不猜成「未开通」 —— 前者的代价是漏领，后者是误导用户去重新登录。
   */
  async checkIn(record: AccountRecord, ctx: AdapterContext): Promise<CheckInResult> {
    const at = ctx.now()
    if (this.tokenOf(record) === '') {
      return { ok: false, supported: true, message: '没有 security_oauth_token', kind: 'auth', at }
    }

    const loaded = await this.loadCampaigns(record, ctx)
    if (!loaded.ok) {
      // 取不到活动列表 → 不判定。
      return {
        ok: false,
        supported: true,
        message: `活动列表查询失败：${loaded.message}`,
        kind: loaded.kind,
        at,
      }
    }
    const parsed = loaded.parsed

    // ⚠️ 用 `core/time.ts` 的 UTC+8 判据，**不要**用 `new Date().getHours()`：
    // 活动按 UTC+8 结算，取本机时区会在用户出差/改时区时给出错的「今天」。
    const refreshed = hasQoderCampaignRefreshedToday(at)
    const claimable = claimableQoderCampaigns(parsed)

    // ── 有可领的：逐个领（一个账号可能同时有多个 CLAIM_BENEFIT 活动） ──
    if (claimable.length > 0) {
      let total = 0
      let claimedCount = 0
      let alreadyCount = 0
      let firstError: { kind: ErrorKind; message: string } | undefined

      for (const campaign of claimable) {
        const outcome = await this.claim(record, ctx, campaign.campaignId)
        if (outcome.kind === 'claimed') {
          total += outcome.amount
          claimedCount += 1
        } else if (outcome.kind === 'already-claimed') {
          alreadyCount += 1
        } else if (firstError === undefined) {
          firstError = { kind: outcome.kind_, message: outcome.message }
        }
      }

      if (claimedCount > 0) {
        return {
          ok: true,
          supported: true,
          credits: total,
          message: `领取成功，+${total} 积分`,
          // ⚠️ **成功也要带 `coversToday:false`**（刷新前）：领到的是**昨天那一轮**
          // 的补领 —— 它是一次真实动作（该如实报「领取成功」），但**不证明今天已被
          // 处理**。不带这个字段，记账层会把今天记成已签，于是 10 点刷新后的新额度
          // 再也没人去领 —— 正是本判据要防的那个「每天静默漏 100 积分」。
          // 参考实现把它叫 `stale` 并同样挂在成功分支上。
          ...(refreshed ? {} : { coversToday: false }),
          at,
        }
      }
      if (alreadyCount > 0 && firstError === undefined) {
        // 全都是 `replayed:true` —— 服务端说这一轮已经领过了。
        return {
          ok: true,
          supported: true,
          credits: 0,
          message: refreshed ? '今天已领取' : NOT_REFRESHED_MESSAGE,
          ...(refreshed ? {} : { coversToday: false }),
          at,
        }
      }
      if (firstError !== undefined) {
        // 失败分支**不带** `coversToday`：`ok:false` 本来就永不记账，
        // 标它只会让「没记账」这件事看起来像有别的含义（对齐参考实现）。
        return {
          ok: false,
          supported: true,
          message: `领取失败：${firstError.message}`,
          kind: firstError.kind,
          at,
        }
      }
    }

    // ── 没有可领的：区分「今天已领」/「还没刷新」/「未开通」/「本就没有」 ──
    const claimedBefore = hasClaimedQoderBenefit(parsed)

    if (claimedBefore) {
      if (refreshed) {
        return { ok: true, supported: true, credits: 0, message: '今天已领取', at }
      }
      // 刷新前看到的那条 CLAIMED 属于**昨天** —— 既不是「今天已领」，
      // 也不是「没有可领取的活动」，而是「等一会儿再来」。
      return {
        ok: true,
        supported: true,
        credits: 0,
        message: NOT_REFRESHED_MESSAGE,
        coversToday: false,
        at,
      }
    }

    // 没有已领的、也没有可领的 → 可能是「未开通」。要**两条判据同时满足**才提示，
    // 避免把「活动刚好在刷新中」误报成「未开通」而让用户白跑一趟官方客户端。
    const usageRaw = await this.loadUsageRaw(record, ctx)
    if (isQoderNotActivated(parsed, usageRaw)) {
      return {
        ok: false,
        supported: true,
        message: NOT_ACTIVATED_MESSAGE,
        // 「需要用户去别处操作」——UI 判这个布尔字段（不是判文案）。
        actionRequired: true,
        at,
      }
    }

    // 活动还没刷新时不报「没有可领取的活动」：那会让人以为今天没戏了。
    if (!refreshed) {
      return {
        ok: true,
        supported: true,
        credits: 0,
        message: NOT_REFRESHED_MESSAGE,
        coversToday: false,
        at,
      }
    }

    // 已刷新、已开通，但列表里既没有可领的、也没有已领的痕迹。
    //
    // ⚠️ 这里**必须**带 `coversToday: false`：我们**无法证明**今天这一轮被处理过
    // （服务端可能只是这一刻没下发），记账层据此不记账，当天稍后还会再来看一眼。
    // 参考实现的 `inactive` 同样不计入 `coversToday`（`channel-pack-rpc.ts` 的
    // `computeClaimSummary` 只在 `claimed`/`already-claimed` 两栏里数它）。
    //
    // 方向不能反：记成「今天已处理」而活动稍后才出现 → **整天漏领**；
    // 不记账最多是多查一次（只读请求，无副作用）。
    return {
      ok: true,
      supported: true,
      credits: 0,
      message: '当前没有可领取的活动',
      coversToday: false,
      at,
    }
  }

  /** 领一个活动；把上游结局翻译成我们需要的三态。 */
  private async claim(
    record: AccountRecord,
    ctx: AdapterContext,
    campaignId: string,
  ): Promise<
    | { kind: 'claimed'; amount: number }
    | { kind: 'already-claimed' }
    | { kind: 'unexpected'; kind_: ErrorKind; message: string }
  > {
    const token = this.tokenOf(record)
    const url = qoderClaimUrl(this.product, campaignId)
    let result
    try {
      result = await ctx.http(url, {
        method: 'POST',
        headers: { ...qoderCreditsHeaders(this.product, token), 'content-type': 'application/json' },
        // ⚠️ **空串**，不是 `'{}'`（抓包实测 `content-length: 0`）。
        body: '',
        timeoutMs: QODER_CREDITS_TIMEOUT_MS_FALLBACK,
      })
    } catch (error) {
      return { kind: 'unexpected', kind_: 'network', message: error instanceof Error ? error.message : String(error) }
    }

    if (!result.ok) {
      // 这里**不能**把 200 当成功：幂等判据是响应体的 `replayed`。
      // 非 2xx 时按上游给的错误分类如实回报（401/403 → auth，429 → rate_limit…）。
      return {
        kind: 'unexpected',
        kind_: result.kind,
        message: result.message ?? `HTTP ${result.status}`,
      }
    }

    // 200 也要落到 `interpretQoderClaim` 上：`replayed:true` 才是「今天已领」。
    const outcome = interpretQoderClaim(result.body)
    if (outcome.kind === 'claimed') return { kind: 'claimed', amount: outcome.amount }
    if (outcome.kind === 'already-claimed') return { kind: 'already-claimed' }
    return { kind: 'unexpected', kind_: 'unknown', message: outcome.message }
  }

  /**
   * 积分余额。
   *
   * ⚠️ **`remaining` 取 `addOnQuota.remaining`，不是 `userQuota`。**
   * 实测（2026-10-19，CN 真实账号）：`userQuota = {total:0, used:0, remaining:0}` 是
   * 恒为 0 的占位，真实可用的 858 积分在 `addOnQuota = {total:1000, used:142, remaining:858}`。
   * 只读 `userQuota` 会显示 0 积分（用户会以为额度被清空了）。
   *
   * `addOnQuota` 没下发时回退到 `userQuota`，再没有就用全部包之和 —— 但**不报 0**：
   * 一个包都解析不出来时给 `error`（「查不到」与「余额为 0」必须分开）。
   *
   * `extra` 里原样保留各包与账号信息，供 UI 展开。
   */
  async getQuota(record: AccountRecord, ctx: AdapterContext): Promise<QuotaSnapshot> {
    const at = ctx.now()
    const base: QuotaSnapshot = { accountId: record.id, unit: 'credits', fetchedAt: at }
    if (this.tokenOf(record) === '') {
      return { ...base, error: '没有 security_oauth_token' }
    }

    const response = await this.getJson(`${this.product.openApiBase}${QODER_USAGE_PATH}`, record, ctx)
    if (!response.ok) {
      // 401/403 与网络失败都给可读原因 —— 失败时 UI 要显示原因而不是 0。
      return { ...base, error: `额度查询失败：${response.message}` }
    }

    const body = response.body as Record<string, unknown>
    // 企业版不给额度数字，只给一个外部链接 —— 报 0 会误导用户以为没额度。
    if (body.displayMode === 'enterprise') {
      return {
        ...base,
        error: '企业版账号不提供积分数字，请在 Qoder 控制台查看用量',
        extra: { displayMode: 'enterprise', ...(typeof body.detailUrl === 'string' ? { detailUrl: body.detailUrl } : {}) },
      }
    }

    const usage = parseQoderUsage(body)
    if (usage === undefined) {
      return { ...base, error: '额度响应形状与预期不符（不是「余额为 0」）' }
    }

    // 主口径：addOnQuota（实测真实余额所在）。没有它才回退。
    const primary = usage.addOnQuota ?? usage.userQuota
    const remaining = primary === undefined ? qoderTotalRemaining(usage) : primary.remaining

    return {
      ...base,
      remaining,
      ...(primary === undefined ? {} : { total: primary.total, used: primary.used }),
      extra: {
        // 原样保留，UI 可展开：两个包的口径不同，分开列才不会让人误读。
        ...(usage.userQuota === undefined ? {} : { userQuota: usage.userQuota }),
        ...(usage.addOnQuota === undefined ? {} : { addOnQuota: usage.addOnQuota }),
        ...(usage.dedicated.length === 0 ? {} : { dedicatedResourcePackages: usage.dedicated }),
        ...(usage.userType === undefined ? {} : { userType: usage.userType }),
        ...(usage.expiresAt === undefined ? {} : { expiresAt: usage.expiresAt }),
        ...(usage.isQuotaExceeded === undefined ? {} : { isQuotaExceeded: usage.isQuotaExceeded }),
        /** 主口径来源，便于排查「为什么显示这个数」。 */
        remainingSource: primary === undefined ? '全部资源包之和' : usage.addOnQuota !== undefined ? 'addOnQuota' : 'userQuota',
      },
    }
  }

  /**
   * 校验：token 能解出 uid 才算可用（否则 WASM 签名必然无效）。
   */
  async validateCredentials(
    record: AccountRecord,
    _ctx: AdapterContext,
  ): Promise<{ ok: boolean; message?: string; kind?: ErrorKind }> {
    const token = this.tokenOf(record)
    if (token === '') return { ok: false, message: '没有 security_oauth_token', kind: 'auth' }
    const uid = this.uidOf(record)
    if (uid === '') {
      return {
        ok: false,
        // 说清「重新登录」而不是「解不出 user_id」——后者用户无法自救。
        message: '凭证缺少 uid（Qoder 加密通道必需）—— 请到账号页重新登录一次这个账号',
        kind: 'auth',
      }
    }
    return { ok: true, message: `凭证可用（uid=${uid}，本地校验）` }
  }

  /** 懒建 WASM 客户端。 */
  private async clientFor(record: AccountRecord, ctx: AdapterContext): Promise<QoderEncryptedInfer> {
    const cached = this.clients.get(record.id)
    if (cached !== undefined) return cached
    const token = this.tokenOf(record)
    let uid = this.uidOf(record)
    // 老账号（早期版本漏存 uid）**不用重新登录**：问一次上游补回来，并回写。
    if (uid === '') uid = await this.resolveUid(record, ctx)
    if (uid === '') {
      throw new Error(
        '凭证缺少 uid，加密通道无法签名 —— 上游也没能补齐。请到账号页重新登录一次这个账号',
      )
    }
    // 回写：下次直接命中，不再多打一次上游。
    if (this.uidOf(record) !== uid && typeof ctx.onCredentialsRefreshed === 'function') {
      try {
        ctx.onCredentialsRefreshed(record.id, { uid })
      } catch (error) {
        ctx.log.debug('uid 回写失败（不影响本次请求）', error instanceof Error ? error.message : String(error))
      }
    }
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
    payload: ChatRequest,
    record: AccountRecord,
    ctx: AdapterContext,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    let client: QoderEncryptedInfer
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
    /**
     * 思考档位从哪个字段取。
     *
     * ⚠️ **两个字段都要认**，这不是冗余：
     *   - `reasoning_effort` —— 核心层（`llm/adapter.ts`）翻译并下发时用的名字，
     *     与我们给上游的 OpenAI 兼容字段一致；
     *   - `reasoning` —— 早先的写法，手工构造 `ChatRequest` 的调用方（含测试）
     *     仍在用。
     *
     * 原先只读 `reasoning`，而核心层写的是 `reasoning_effort` ——
     * 后果是**用户在选择器里选了档位，Qoder 这边永远收不到**，
     * 静默按模型默认档跑（正是「模型调用」这条线上最典型的一类缺口：
     * 两端各自都对，接起来没接上）。
     */
    const requestedEffort =
      typeof payload.reasoning_effort === 'string'
        ? payload.reasoning_effort
        : typeof payload.reasoning === 'string'
          ? payload.reasoning
          : undefined
    let prepared
    try {
      prepared = client.prepareInfer({
        modelKey: payload.model,
        userText,
        ...(systemText === undefined ? {} : { systemText }),
        history,
        ...(payload.max_tokens === undefined ? {} : { maxTokens: payload.max_tokens }),
        ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
        /**
         * ⚠️ **`business` 必填 —— 漏了它 `qfmodel` / `dfmodel` 必然失败。**
         *
         * 用户报障（2026-10-20）：「Qoder CN 的模型发消息后没有回复，直接显示已完成；
         * Qoder 平台正常」，并明确纠正我：**「上游没问题，我在 Qoder CN 客户端里
         * 用这两个模型就没问题」**。
         *
         * 他是对的。真因就在这一行：不带 `business` 时服务端把请求路由到**故障节点**
         * `oa_qwen-plus-2025-04-28`，回 `[FAIL]node:... msg:Execution failed`。
         * 注意报错里的节点名是 `qwen-plus` —— 与我们发的 `qfmodel` 对不上，
         * 那正是「被路由到了别的节点」的指纹，而不是「这个模型坏了」。
         *
         * 其余模型（`auto` / `qmodel_38max` / `cmodel`）恰好不受影响，
         * 所以极易误判成「该模型服务端故障」—— 我上一轮就误判了。
         * 参考实现的注释里早就写明了这条，连「IDE 里同一模型完全正常」这句现象都一样。
         *
         * 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
         * —— 服务端按 `business.type` 选路由池，**缺字段会走异常分支**。
         * `agent` / `sec_scan` 等取值都能通，我们取 `agent`（与参考实现一致）。
         */
        business: { type: 'agent' },
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

    let response: Response
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
    //
    // ─────────── usage（token 用量）帧：**不需要 `stream_options`** ───────────
    //
    // 曾经怀疑「token 拿不到是因为没请求 `stream_options.include_usage`」
    // （opencode / buddy 的请求体里都有这个字段）。**2026-10-20 真打上游实测否掉了这个怀疑**：
    //
    // | 模型 | 不带 stream_options | 带 stream_options.include_usage |
    // |---|---|---|
    // | auto / qmodel_38max / cmodel | 200 + **有** usage 帧 | 200 + 有 usage 帧 |
    // | performance / ultimate | 200 + 上游报 Unsupported model | 200 + 同样的报错 |
    // | qfmodel（免费） | 200 + 上游业务 400 | 200 + 同一个 400 |
    //
    // 两点结论：
    //   ① Qoder **接受**这个字段（一律 200，没有一次 400）—— 加它不会坏事；
    //   ② 但它**本就会**下发 `choices: []` + `usage` 的末帧，**没它也有** —— 加上是多余的。
    //
    // 所以**不加**：多一个上游不认的字段就多一份上游改协议时被 400 的风险，
    // 而它一个字节的收益都没有。（真要用，得改 `vendor/qoder/qoder-wasm.ts`
    // 的 `buildQoderInferPayload` —— 那是协议纯函数的写作用域，不在本次改动内。）
    //
    // ⚠️ 真正让 token 丢掉的**不是**这个字段，而是**采样时机**：
    // 实测 `auto` 的帧序是 `… text → finish → usage`，usage 比 finish **晚约 17ms**，
    // 而 `llm/adapter.ts` 原先收到 finish 就 `return` ⇒ 这一帧永远读不到。
    // 修在那边（收尾但不结束，最多再等 250ms）。**别再回头加这个字段。**
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
