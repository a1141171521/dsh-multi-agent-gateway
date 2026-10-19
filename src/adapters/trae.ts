/**
 * Trae（字节跳动 TRAE IDE / SOLO）适配器。
 *
 * 事实与实现来自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/`：
 * `trae.ts` / `trae-product.ts` / `trae-credits.ts` / `trae-errors.ts` /
 * `trae-adapter.ts` 的协议事实已搬进 `src/vendor/trae/`，本文件只做
 * 「接到我们的适配器接口」。
 *
 * ## 本期做了哪些能力
 *
 * | 能力 | 状态 | 说明 |
 * |---|---|---|
 * | 模型目录 | ✅ | `batch_get_detail_param`，多通道 + 白名单准入 |
 * | 每日签到 | ✅ | status + claim；9074 视为**可重试**并轮换签到设备号 |
 * | 积分余额 | ✅ | `ide_user_ent_usage` |
 * | 流式对话 | ✅ | 自定义 SOLO SSE → 归一化事件 |
 * | 活动任务 | ❌ | 上游没有独立的活动任务体系（capabilities.tasks = false） |
 *
 * ## ⚠️ 凭据请**手工粘贴** —— 本期不做登录
 *
 * 完整的 OAuth 登录流程（回调服务器 + ExchangeToken + GetUserInfo，参考实现
 * `trae-oauth.ts` 那 32KB）**不在本期范围内**。所以本适配器**没有实现**
 * `beginLogin` / `pollLogin` —— 宿主对没有登录能力的适配器是支持的
 * （见 `src/core/login.ts`：`LoginCapability` 是**可选**实现）。
 *
 * 用户的操作路径：在 Trae 官方客户端登录后，把 access token 复制到本插件的
 * 账号页。`capabilities.notes` 里**如实写明**了这一点 —— 不假装有登录。
 *
 * ## 设备身份：派生而不是让用户填
 *
 * TRAE 的对话与签到都要求携带 `machine_id` / `device_id`，而手工粘贴凭据时
 * 没有「登录时刻」来生成并持久化它们。本适配器**按账号 id 确定性派生**
 * （见 `deriveMachineId` / `deriveDeviceId`），因此：
 *
 * - 重启后仍是同一个值（满足「machine_id 绝不重新生成」这条上游观测到的约束）；
 * - 用户不必手工填一个 32 位 hex；
 * - **各账号天然拿到不同的 device_id** —— 这很关键：同一天两个账号共用同一个
 *   `device_id` 会被「该设备已签到」拦截（第二个账号报已签到）。
 */

import { BaseAdapter } from './base.js'
import {
  TRAE_AGENT_HOST,
  TRAE_UG_HOST,
  TRAE_OAUTH_HOST,
  TRAE_CHAT_PATH,
  TRAE_BATCH_MODELS_PATH,
  TRAE_USER_INFO_PATH,
  TRAE_CHECKIN_STATUS_PATH,
  TRAE_CHECKIN_CLAIM_PATH,
  TRAE_ENT_USAGE_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  TRAE_FUNCTION,
  TRAE_FALLBACK_MODELS,
  TRAE_FALLBACK_MAX_OUTPUT_TOKENS,
  TRAE_DEFAULT_MAX_COMPLETION_TOKENS,
  buildTraeBatchModelsBody,
} from '../vendor/trae/trae-product.js'
import {
  deriveDeviceId,
  deriveMachineId,
  isTraeExpired,
  isTraeRefreshable,
  parseTraeExchangeResponse,
  parseTraeUserInfoResponse,
  toTraeCredential,
  type TraeCredential,
} from '../vendor/trae/trae-identity.js'
import { traeCheckinHeaders, traeOAuthHeaders, traeSOLOHeaders } from '../vendor/trae/trae-headers.js'
import {
  isTraeModelCallable,
  parseTraeBatchModelList,
  resolveTraeModelTarget,
  traeDisplayName,
  type TraeRemoteModel,
} from '../vendor/trae/trae-catalog.js'
import { buildOpenAiBody, transformToSOLOBody } from '../vendor/trae/trae-payload.js'
import { TraeSseConverter, isRotatableTraeStreamError } from '../vendor/trae/trae-sse.js'
import {
  checkinGenerationPayload,
  classifyTraeCheckinError,
  isTraeCheckinBusy,
  parseTraeCheckinStatus,
  parseTraeCreditBalance,
  readCheckinGeneration,
  readTraeClaimCode,
} from '../vendor/trae/trae-credits.js'
import { classifyTraeError } from '../vendor/trae/trae-errors.js'
import type {
  AccountCredentials,
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

/** 模型目录缓存键（按账号）。 */
function catalogCacheKey(accountId: string): string {
  return `trae:catalog:${accountId}`
}

/** 签到设备轮换代次的缓存键（按账号）。 */
function checkinGenCacheKey(accountId: string): string {
  return `trae:checkin-gen:${accountId}`
}

/** 模型目录缓存 TTL（毫秒）。 */
const CATALOG_TTL_MS = 10 * 60 * 1000

const CAPABILITIES: AgentCapabilities = {
  checkIn: true,
  quota: true,
  models: true,
  // 上游没有独立于签到之外的活动任务体系：不编一个出来。
  tasks: false,
  chat: true,
  reasoning: true,
  source: 'static',
  notes: {
    checkIn: '每日签到（status + claim）。命中业务码 9074「签到人数过多」时按可重试处理，并轮换签到设备号。',
    quota: '积分余额来自 /trae/api/v2/pay/ide_user_ent_usage，单位是 credits。',
    models: '模型目录来自 batch_get_detail_param（多通道），只保留在对话端点上真正可调用的通道。',
    tasks: '上游没有独立的活动任务接口（签到本身就是唯一的每日领取），这一项不适用。',
    chat: '流式对话走 SOLO 自定义 SSE，已转换成本插件的归一化事件；正文与思维链完整透出。',
    /**
     * ⚠️ 这一条是**如实声明**，不是说明文字。
     *
     * 本期没有实现 OAuth 登录（参考实现的 `trae-oauth.ts` 是一整套回调服务器流程）。
     * 与其让用户对着一个点了没反应的「登录」按钮，不如直接告诉他怎么拿 token。
     */
    login:
      '本期**不含登录流程**：请在 Trae 官方客户端登录后，手工把 access token 粘贴到账号里。' +
      '（token 过期需要重新粘贴；填了 refresh token 的话本插件会尝试自动续期。）',
    credentials:
      '只需要粘贴 access token；设备指纹（machine_id / device_id）由本插件按账号自动派生，各账号互不相同。',
  },
}

/**
 * Trae 适配器。
 *
 * 无构造参数：产品常量只有一套（国际版 TRAE 与 CN 的协议差异本期未验证，
 * **不猜**——猜测的国际化端点只会让用户对着 404 猜原因）。
 */
export class TraeAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'trae',
      name: 'Trae',
      doc: 'https://www.trae.cn/',
      credentialHint:
        '粘贴 Trae 官方客户端登录后的 access token（请求头 Authorization 里 Cloud-IDE-JWT 后面的那串）。',
      capabilities: CAPABILITIES,
      implemented: true,
    })
  }

  // ───────────────────── 凭证 ─────────────────────

  /** 从账号记录里取 TRAE 凭据（含派生出来的设备身份）。 */
  private credentialOf(record: AccountRecord): TraeCredential {
    return toTraeCredential(record.credentials as Record<string, unknown>, {
      machineId: deriveMachineId(record.id),
      deviceId: deriveDeviceId(record.id),
    })
  }

  /** 凭证 → 我们的扁平形状（回写用）。 */
  override async getCredentials(record: AccountRecord): Promise<AccountCredentials> {
    const credential = this.credentialOf(record)
    return {
      ...record.credentials,
      token: credential.access_token,
      uid: credential.uid,
      machine_id: credential.machine_id,
      device_id: credential.device_id,
    }
  }

  /**
   * 校验凭证：问一次上游的 `GetUserInfo`。
   *
   * 为什么用这个端点而不是「本地看看有没有 token」：手工粘贴的 token 很容易
   * 粘错 / 粘到别的东西（`Cloud-IDE-JWT ` 前缀、引号、截断）。
   * `GetUserInfo` 是**最轻的、能证明 token 真的有效**的请求，且顺带补上 uid。
   */
  override async validateCredentials(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<{ ok: boolean; message?: string; kind?: ErrorKind }> {
    const credential = this.credentialOf(record)
    if (credential.access_token.length === 0) {
      return { ok: false, message: '没有 access token，请先粘贴 Trae 的登录 token', kind: 'auth' }
    }
    const userInfo = await this.fetchUserInfo(credential, ctx)
    if (userInfo.ok) {
      const label = userInfo.info.phone !== '' ? userInfo.info.phone : userInfo.info.screenName
      return { ok: true, message: `凭证可用（${label}）` }
    }
    return { ok: false, message: userInfo.message, kind: userInfo.kind }
  }

  /** 取用户信息（失败时返回原因，不抛）。 */
  private async fetchUserInfo(
    credential: TraeCredential,
    ctx: AdapterContext,
  ): Promise<
    | { ok: true; info: { uid: string; screenName: string; phone: string; email: string; enterpriseId: string } }
    | { ok: false; message: string; kind: ErrorKind }
  > {
    const result = await ctx.http(`${TRAE_OAUTH_HOST}${TRAE_USER_INFO_PATH}`, {
      method: 'POST',
      headers: {
        ...traeOAuthHeaders(),
        'X-Cloudide-Token': credential.access_token,
      },
      body: '{}',
      timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
    })
    if (!result.ok) {
      return {
        ok: false,
        message: result.message ?? `GetUserInfo 失败（HTTP ${result.status}）`,
        kind: result.kind === 'none' ? 'auth' : result.kind,
      }
    }
    const body = typeof result.body === 'object' && result.body !== null
      ? (result.body as Record<string, unknown>)
      : undefined
    if (body === undefined) return { ok: false, message: 'GetUserInfo 响应不是对象', kind: 'unknown' }
    const info = parseTraeUserInfoResponse(body)
    if (info === undefined) {
      return { ok: false, message: 'GetUserInfo 响应里没有 UserID（token 可能不是 Trae 的）', kind: 'auth' }
    }
    return { ok: true, info }
  }

  /**
   * 确保凭证是新鲜的，并把补齐的字段回写。
   *
   * ## 做得到的事
   *
   * - **uid 缺失时补上**（问一次 `GetUserInfo`）—— uid 是签到设备身份的派生输入，
   *   缺了就没法构造合法的签到请求；
   * - **token 过期且有 refresh_token 时**用 `ExchangeToken` 换新的，
   *   并经 `ctx.onCredentialsRefreshed` 回写落盘。
   *
   * ## 做不到的事（如实说）
   *
   * 没有 refresh token 时**无法续期** —— 只能请用户重新粘贴。
   * 这一点写进了 `capabilities.notes.login`，不在这里静默吞掉。
   *
   * @returns 可用的凭据；连 token 都没有时返回 undefined
   */
  private async ensureFreshCredential(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<TraeCredential | undefined> {
    let credential = this.credentialOf(record)
    if (credential.access_token.length === 0) return undefined

    // ① uid 缺失 → 补（签到与 X-Uid 头都要它）。
    if (credential.uid.length === 0) {
      const userInfo = await this.fetchUserInfo(credential, ctx)
      if (userInfo.ok) {
        credential = { ...credential, uid: userInfo.info.uid }
        this.persist(record, ctx, {
          uid: userInfo.info.uid,
          ...(userInfo.info.screenName === '' ? {} : { nickname: userInfo.info.screenName }),
          ...(userInfo.info.phone === '' ? {} : { phone: userInfo.info.phone }),
          ...(userInfo.info.email === '' ? {} : { email: userInfo.info.email }),
        })
      } else {
        ctx.log.debug(`补齐 uid 失败：${userInfo.message}`, `account=${record.id}`)
      }
    }

    // ② token 过期且有 refresh token → 换新的。
    if (isTraeExpired(credential) && isTraeRefreshable(credential)) {
      const refreshed = await this.exchangeToken(credential, ctx)
      if (refreshed !== undefined) {
        credential = refreshed
        this.persist(record, ctx, {
          token: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          ...(refreshed.expires_at === undefined ? {} : { expiresAt: Number(refreshed.expires_at) }),
        })
      } else {
        ctx.log.warn('TRAE token 已过期且续期失败，请重新粘贴 token', `account=${record.id}`)
      }
    }

    return credential
  }

  /** 用 refresh_token 换新 token（失败返回 undefined，由调用方决定怎么办）。 */
  private async exchangeToken(
    credential: TraeCredential,
    ctx: AdapterContext,
  ): Promise<TraeCredential | undefined> {
    const result = await ctx.http(`${TRAE_OAUTH_HOST}${TRAE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: traeOAuthHeaders(),
      body: JSON.stringify({
        refresh_token: credential.refresh_token,
        client_id: 'en1oxy7wnw8j9n',
      }),
      timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
    })
    if (!result.ok) {
      ctx.log.debug(`ExchangeToken 失败：HTTP ${result.status}`, result.message ?? '')
      return undefined
    }
    const body = typeof result.body === 'object' && result.body !== null
      ? (result.body as Record<string, unknown>)
      : undefined
    if (body === undefined) return undefined
    const exchange = parseTraeExchangeResponse(body)
    if (exchange === undefined) return undefined
    ctx.log.info('TRAE token 已续期')
    return {
      ...credential,
      access_token: exchange.accessToken,
      // ⚠️ refresh_token **会轮换**：不写回下一次就用旧的了。
      refresh_token: exchange.refreshToken !== '' ? exchange.refreshToken : credential.refresh_token,
    }
  }

  /** 把补齐 / 续期后的字段回写账号库（宿主没接回调时只记日志，不报错）。 */
  private persist(record: AccountRecord, ctx: AdapterContext, patch: AccountCredentials): void {
    // 先改内存里的记录：即使宿主没接回调，本次调用后续步骤也能看到新值。
    Object.assign(record.credentials, patch)
    if (typeof ctx.onCredentialsRefreshed !== 'function') return
    try {
      ctx.onCredentialsRefreshed(record.id, patch)
    } catch (error) {
      ctx.log.debug('凭证回写失败（不影响本次请求）', error instanceof Error ? error.message : String(error))
    }
  }

  // ───────────────────── 模型目录 ─────────────────────

  /**
   * 模型目录：`batch_get_detail_param`（多通道）。
   *
   * ⚠️ **没有账号（= 没有 token）时返回空列表** —— 与 Qoder 适配器同样的取舍：
   * 不登录就一个模型也调不动，列出来只会让用户以为插件坏了。
   *
   * ⚠️ 远端整体失败时退回**兜底目录**（32 条），但把倍率留空（显示「未知倍率」）
   * 而不是编一个 —— 兜底表里没有倍率信息。
   */
  override async getModelMetaList(record: AccountRecord, ctx: AdapterContext): Promise<ModelMeta[]> {
    const credential = this.credentialOf(record)
    if (credential.access_token.length === 0) return []

    const catalog = await this.loadCatalog(record, ctx)
    if (catalog.length === 0) return this.fallbackModelMeta(record)

    const list: ModelMeta[] = []
    for (const model of catalog) {
      // ⚠️ 过硬性过滤：`is_custom_model === true` 的条目必然调不通（流内 4001）。
      // 解析层已经挡过一次，这里再挡一次是因为**目录可能来自缓存 / 兜底表**，
      // 而不同来源的可信度不同。判据是标志的值，不是模型名。
      if (!isTraeModelCallable(model)) continue
      list.push(this.toModelMeta(model))
    }
    return list
  }

  /** 单条远端条目 → `ModelMeta`。 */
  private toModelMeta(model: TraeRemoteModel): ModelMeta {
    const rate = model.creditsRate
    const efforts = this.reasoningOptions(model)
    return {
      id: model.id,
      // 展示名带倍率后缀（`GLM-5.2 · x0.08` / `· 免费`），与参考实现一致。
      name: traeDisplayName(model),
      agentId: this.id,
      agentName: this.name,
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxTokens: model.maxOutputTokens }),
      // ⚠️ 逐模型判定（`display_config.multimodal`），不按 provider 一刀切：
      // 漏报 `image` 会让 DSH 在**附件准入阶段**就把图片拒掉，
      // 而报错把原因指向模型、真实原因却是插件。
      ...(model.multimodal === true ? { inputModalities: ['text', 'image'] as ('text' | 'image')[] } : {}),
      ...(this.hasReasoning(model) ? { reasoning: true } : {}),
      // 思考档位：TRAE 的 wire 值是私有 id（`light` / `high` / `extra_high`），
      // **必须如实报给核心层翻译** —— 客户端只会说 OpenAI 的 8 个规范名，
      // 直接把它们发上去就是 400。不报的话选择器里一个档位行都没有。
      ...(efforts.length === 0 ? {} : { reasoningEfforts: efforts }),
      // 默认档：远端 `default_level` 就是官方客户端的选中项，照实上报
      // （不报的话核心层会用启发式猜一个，与官方行为不一致）。
      ...(this.defaultReasoningOption(model) === undefined
        ? {}
        : { defaultReasoningEffort: this.defaultReasoningOption(model) as string }),
      ...(rate === undefined ? {} : { multiplier: rate, multiplierSource: 'trae:consumption_rate' }),
      // ⚠️ 只有 0 才是真免费。`creditsRate === undefined` 是「上游没说」，不是免费。
      ...(rate === 0 ? { free: true } : {}),
      ...(this.describePricing(model) === undefined ? {} : { description: this.describePricing(model) }),
      updatedAt: Date.now(),
    }
  }

  /**
   * 该模型可选的思考档位（**wire 值原样**）。
   *
   * 判据与参考实现的 `reasoningFor` 一致：`support_thinking !== false` 且 `options` 非空。
   * 空数组 = 远端没声明可用档位（这时**不要**报，选择器不该出档位行）。
   */
  private reasoningOptions(model: TraeRemoteModel): string[] {
    const config = model.reasoningConfig
    if (config === undefined) return []
    if (config.supportThinking === false) return []
    return [...config.options]
  }

  /**
   * 远端声明的默认档（`default_level`）。
   *
   * ⚠️ **必须落在 `options` 内**才作数：参考实现踩过这个坑，DSH 会直接拿
   * `defaultEffort` 发请求，给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`。
   * 不在集合里时返回 undefined，交给核心层的启发式。
   */
  private defaultReasoningOption(model: TraeRemoteModel): string | undefined {
    const declared = model.reasoningConfig?.defaultLevel
    if (typeof declared !== 'string' || declared === '') return undefined
    return this.reasoningOptions(model).includes(declared) ? declared : undefined
  }

  /** 该模型能否声明思考档位（判据与参考实现的 `reasoningFor` 一致）。 */
  private hasReasoning(model: TraeRemoteModel): boolean {
    return this.reasoningOptions(model).length > 0
  }

  /** 描述文字：活动折扣 / 通道归属（有信息才给）。 */
  private describePricing(model: TraeRemoteModel): string | undefined {
    const parts: string[] = []
    const original = model.originalCreditsRate
    if (original !== undefined && model.creditsRate !== undefined && original > model.creditsRate) {
      const ends = model.discountEndsAtSec === undefined
        ? ''
        : `（至 ${new Date(model.discountEndsAtSec * 1000).toISOString().slice(0, 10)}）`
      parts.push(`限时折扣：原价 ×${original} → 现价 ×${model.creditsRate}${ends}`)
    }
    if (model.function !== undefined && model.function.length > 0) {
      parts.push(`通道 ${model.function}`)
    }
    return parts.length === 0 ? undefined : parts.join(' · ')
  }

  /**
   * 拉远端目录（带缓存）。
   *
   * 缓存的意义不只是省一次往返：`getModelMetaList` 会被核心层在列模型 /
   * 解析模型 / 探测时反复调用，每次都打一次上游会让首屏明显变慢，
   * 而且容易被上游当成异常流量。
   */
  private async loadCatalog(record: AccountRecord, ctx: AdapterContext): Promise<TraeRemoteModel[]> {
    const cached = ctx.cache.get<TraeRemoteModel[]>(catalogCacheKey(record.id))
    if (Array.isArray(cached)) return cached

    const credential = await this.ensureFreshCredential(record, ctx)
    if (credential === undefined) return []

    const result = await ctx.http(`${TRAE_AGENT_HOST}${TRAE_BATCH_MODELS_PATH}`, {
      method: 'POST',
      headers: traeSOLOHeaders(credential, false),
      body: JSON.stringify(buildTraeBatchModelsBody()),
      timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
    })
    if (!result.ok) {
      ctx.log.warn(
        `TRAE 模型目录拉取失败（HTTP ${result.status}），本账号本次退回兜底目录`,
        result.message ?? '',
      )
      return []
    }
    const models = parseTraeBatchModelList(result.body)
    if (models.length === 0) {
      ctx.log.warn('TRAE 模型目录解析结果为空（响应里没有白名单通道的条目？）')
      return []
    }
    ctx.cache.set(catalogCacheKey(record.id), models, CATALOG_TTL_MS)
    ctx.log.debug(`TRAE 模型目录已缓存：${models.length} 条`, `account=${record.id}`)
    return models
  }

  /** 兜底目录（远端整体失败时用；不带倍率信息）。 */
  private fallbackModelMeta(record: AccountRecord): ModelMeta[] {
    void record
    return TRAE_FALLBACK_MODELS
      .filter((model) => model.isHidden !== true)
      .map((model) => ({
        id: model.id,
        name: model.name,
        agentId: this.id,
        agentName: this.name,
        contextWindow: model.contextWindow,
        maxTokens: TRAE_FALLBACK_MAX_OUTPUT_TOKENS,
        updatedAt: Date.now(),
      }))
  }

  // ───────────────────── 签到 ─────────────────────

  /**
   * 每日签到。
   *
   * ## 流程（两步，不能省）
   *
   * 1. **查状态** —— 上游的 `claim` 对「今天已签到」是**幂等**的（重复领取同样
   *    返回成功），所以只看 claim 的成功响应**无法区分**「刚领到」与「早就领过」。
   *    先查状态才能如实告诉用户是哪种。
   * 2. **领取** → 成功后**再查一次状态**拿实际所得积分数。
   *
   * ## ⚠️ 为什么领取后要补查状态
   *
   * `claim` 的响应**不含积分数**：参考实现实测它的完整响应就是
   * `{"code":0,"message":"success"}`。早期实现读 `body.credits` 因此恒为 0，
   * 界面显示「领取成功 +0 积分」（用户报障），而 IDE 里明明写着 150。
   * 真实数值只在 **status 端点**的 `credits` 字段里。
   *
   * ## 9074 是「可重试」，不是失败
   *
   * 业务码 9074（「签到人数过多」）的限流范围是 **device_id 而非账号**
   * （参考实现实测：换个新派生的 id 立刻能签成功）。所以命中时：
   *
   * - 把签到设备轮换代次 +1（下次用一个全新的设备号）；
   * - 回报 `retryable: true`，让调度器稍后再来，而不是判死到明天。
   */
  override async checkIn(record: AccountRecord, ctx: AdapterContext): Promise<CheckInResult> {
    const credential = await this.ensureFreshCredential(record, ctx)
    if (credential === undefined) {
      return {
        ok: false,
        supported: true,
        message: '没有 access token，请先粘贴 Trae 的登录 token',
        kind: 'auth',
        at: ctx.now(),
      }
    }
    // ⚠️ uid 是签到设备身份的**派生输入**（`traeCheckinHeaders` 用它算
    // X-Device-Id / X-Market-User-Id）。缺了它派生出的是一套「空账号」身份，
    // 多账号会撞在一起 —— 那正是「该设备已签到」的成因。这里明确报错，
    // 而不是发一个必然被拒的请求。
    if (credential.uid.length === 0) {
      return {
        ok: false,
        supported: true,
        message:
          '凭证缺少 uid，无法构造签到设备身份 —— 上游 GetUserInfo 也没能补齐，请重新粘贴有效的 access token',
        kind: 'auth',
        at: ctx.now(),
      }
    }

    const generation = readCheckinGeneration(ctx.cache.get(checkinGenCacheKey(record.id)))

    // ① 查状态
    const status = await this.queryCheckinStatus(credential, generation, ctx)
    if (!status.ok) {
      return {
        ok: false,
        supported: true,
        message: status.message,
        kind: status.kind,
        at: ctx.now(),
      }
    }
    if (status.value.todayCheckedIn) {
      // 如实说「今天已签到」，而不是报一次虚假的领取成功 +0。
      return {
        ok: true,
        supported: true,
        credits: 0,
        message: `今天已经签到过了（本日签到可得 ${status.value.dailyCredit} 积分，已领取）`,
        at: ctx.now(),
      }
    }
    if (!status.value.active) {
      // `enable: false` = 该账号没有签到活动。**这不是故障**。
      return {
        ok: false,
        supported: true,
        message: '该账号在 Trae 侧没有开启签到活动（不是故障）',
        at: ctx.now(),
      }
    }

    // ② 领取
    const claim = await this.claimCheckin(credential, generation, ctx)
    if (!claim.ok) {
      if (isTraeCheckinBusy(claim.code)) {
        // ⚠️ 9074：设备级限流 → 轮换代次 + 报可重试（见函数注释）。
        // ⚠️ 轮换的**唯一生效点**是 `traeCheckinHeaders(..., generation)`：
        // 代次参与设备号派生，所以下一次请求带的是一个全新的设备身份。
        const next = generation + 1
        ctx.cache.set(checkinGenCacheKey(record.id), checkinGenerationPayload(next))
        ctx.log.info(
          `TRAE 签到命中 9074（签到人数过多），签到设备号已轮换到第 ${next} 代`,
          `account=${record.id}`,
        )
        return {
          ok: false,
          supported: true,
          message: `${claim.message}（已轮换签到设备号，稍后会自动再试）`,
          // ⚠️ 归类 `rate_limit` 而**不是** `unknown`：核心层据此短时降权 + 换号，
          // 正是「这会儿人多」应该得到的处理。报 `unknown` 会退化成普通重试，
          // 而这个账号在同一设备号上短期内不会成功。
          kind: 'rate_limit',
          at: ctx.now(),
        }
      }
      return {
        ok: false,
        supported: true,
        message: claim.message,
        kind: classifyTraeError(claim.status, claim.message),
        at: ctx.now(),
      }
    }

    // ③ 补查状态拿实际所得（claim 响应不含积分数，见函数注释）。
    const after = await this.queryCheckinStatus(credential, generation, ctx)
    const credits = after.ok ? after.value.dailyCredit : 0
    return {
      ok: true,
      supported: true,
      credits,
      message: credits > 0
        ? `签到成功，获得 ${credits} 积分`
        : '签到成功（上游未回报本次所得积分数）',
      at: ctx.now(),
    }
  }

  /** 查一次签到状态。 */
  private async queryCheckinStatus(
    credential: TraeCredential,
    generation: number,
    ctx: AdapterContext,
  ): Promise<
    | { ok: true; value: ReturnType<typeof parseTraeCheckinStatus> }
    | { ok: false; message: string; kind: ErrorKind; status: number }
  > {
    const result = await ctx.http(`${TRAE_UG_HOST}${TRAE_CHECKIN_STATUS_PATH}`, {
      method: 'POST',
      // ⚠️ 代次必须传下去：它参与签到设备号派生（见 `deriveDeviceId15`）。
      headers: traeCheckinHeaders(credential, credential.uid, generation),
      body: '{}',
      timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
    })
    if (!result.ok) {
      return {
        ok: false,
        message: `签到状态查询失败：${result.message ?? `HTTP ${result.status}`}`,
        kind: classifyTraeError(result.status, result.text),
        status: result.status,
      }
    }
    const body = typeof result.body === 'object' && result.body !== null
      ? (result.body as Record<string, unknown>)
      : undefined
    if (body === undefined) {
      return { ok: false, message: '签到状态响应不是对象', kind: 'unknown', status: result.status }
    }
    const code = readTraeClaimCode(body)
    if (code !== 0) {
      const classification = classifyTraeCheckinError(result.status, code)
      return {
        ok: false,
        message: `签到状态查询失败（code=${code}，${classification.type}）`,
        kind: classifyTraeError(result.status, JSON.stringify(body)),
        status: result.status,
      }
    }
    return { ok: true, value: parseTraeCheckinStatus(body) }
  }

  /** 执行一次签到领取。 */
  private async claimCheckin(
    credential: TraeCredential,
    generation: number,
    ctx: AdapterContext,
  ): Promise<
    | { ok: true; code: number; status: number }
    | { ok: false; code: number; status: number; message: string }
  > {
    // ⚠️ body 必须是 `{}` —— 参考实现明确记录：不是 `{"req_source":2}`。
    const result = await ctx.http(`${TRAE_UG_HOST}${TRAE_CHECKIN_CLAIM_PATH}`, {
      method: 'POST',
      // ⚠️ 代次必须传下去：9074 轮换后，**领取**这一步要用的才是新设备号。
      headers: traeCheckinHeaders(credential, credential.uid, generation),
      body: '{}',
      timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
    })
    // ⚠️ **HTTP 非 2xx 也要读业务码**：上游可能用 200 之外的码下发业务错误，
    // 而 9074 这类「可重试」的判定依赖业务码，只看 `result.ok` 会把它当普通失败。
    const body = typeof result.body === 'object' && result.body !== null
      ? (result.body as Record<string, unknown>)
      : undefined
    const code = body === undefined ? -1 : readTraeClaimCode(body)
    const message = body === undefined
      ? (result.message ?? `HTTP ${result.status}`)
      : (typeof body.message === 'string' && body.message !== ''
          ? body.message
          : typeof body.msg === 'string' && body.msg !== ''
            ? body.msg
            : `签到失败（code=${code}）`)
    if (!result.ok) {
      return { ok: false, code: code === 0 ? -1 : code, status: result.status, message }
    }
    if (code !== 0) {
      return { ok: false, code, status: result.status, message }
    }
    return { ok: true, code, status: result.status }
  }

  // ───────────────────── 额度 ─────────────────────

  /**
   * 积分余额。
   *
   * ⚠️ 余额是**多个包之和**（`∑(credits_limit - credits_amount)`），不是单一数字：
   * 上游会同时下发「每月登录赠送」「签到奖励」「免费」等多个额度包，
   * 各自有自己的到期时间。每个包都进 `extra.packages` 供 UI 展开。
   */
  override async getQuota(record: AccountRecord, ctx: AdapterContext): Promise<QuotaSnapshot> {
    const fetchedAt = ctx.now()
    const credential = await this.ensureFreshCredential(record, ctx)
    if (credential === undefined) {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt,
        error: '没有 access token，请先粘贴 Trae 的登录 token',
      }
    }
    const result = await ctx.http(`${TRAE_UG_HOST}${TRAE_ENT_USAGE_PATH}`, {
      method: 'POST',
      // 余额端点与签到同族（同样的客户端头与设备身份），故共用代次。
      headers: traeCheckinHeaders(credential, credential.uid),
      // ⚠️ 余额端点的 body **必须**带 `require_usage: true`——参考实现记录，
      // 少了它上游不下发 `usage`（已用），于是每个包的剩余都会算成满额。
      body: JSON.stringify({ require_usage: true, req_source: 2 }),
      timeoutMs: TRAE_REQUEST_TIMEOUT_MS,
    })
    if (!result.ok) {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt,
        error: `${result.message ?? `HTTP ${result.status}`}`,
      }
    }
    const body = typeof result.body === 'object' && result.body !== null
      ? (result.body as Record<string, unknown>)
      : undefined
    if (body === undefined) {
      return { accountId: record.id, unit: 'credits', fetchedAt, error: '余额响应不是对象' }
    }
    const balance = parseTraeCreditBalance(body)
    if (balance === undefined) {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt,
        error: '上游没有下发任何积分包（该账号可能还没有额度）',
      }
    }
    const total = balance.packages.reduce((sum, pkg) => sum + pkg.total, 0)
    const used = balance.packages.reduce((sum, pkg) => sum + pkg.used, 0)
    return {
      accountId: record.id,
      unit: 'credits',
      remaining: balance.total,
      total,
      used,
      fetchedAt,
      extra: { packages: balance.packages },
    }
  }

  // ───────────────────── 对话 ─────────────────────

  /**
   * 流式对话：OpenAI 载荷 → SOLO 载荷 → 自定义 SSE → 归一化事件。
   *
   * ## ⚠️ 关于「流式正文被冲掉」那条硬规则
   *
   * 我们插件曾有一个真实缺陷：DSH 宿主的 `block-end` 是**覆盖式赋值**，
   * 传空串会把之前所有 `text-delta` 丢掉（症状：「流式有字，一调工具 / 一收尾就变空」）。
   *
   * 本适配器的防线是：**自己攒完整正文**。`TraeSseConverter` 持有
   * `text` / `reasoning` 两份独立缓冲，工具调用另有一套累加状态，
   * 三者互不冲掉（详见 `src/vendor/trae/trae-sse.ts` 的模块注释）。
   * 这里逐事件把增量透出去，收尾时不再依赖任何「增量拼接的语义边界」。
   */
  override async *requestChatStream(
    payload: ChatRequest,
    record: AccountRecord,
    ctx: AdapterContext,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const credential = await this.ensureFreshCredential(record, ctx)
    if (credential === undefined) {
      yield {
        type: 'error',
        failure: {
          kind: 'auth',
          message: '没有 access token，请先粘贴 Trae 的登录 token',
          at: ctx.now(),
        },
      }
      return
    }

    // 解析目标模型：目录里的原始 id + 它所属的通道。
    // ⚠️ 模型**只在列出它的通道里可调用**，发错通道会得到流内 4001。
    const catalog = await this.loadCatalog(record, ctx)
    const target = resolveTraeModelTarget(payload.model, catalog, TRAE_FUNCTION)

    const openaiBody = buildOpenAiBody(payload as unknown as Record<string, unknown>)
    const soloBody = transformToSOLOBody(openaiBody, target.configName, target.channel)
    const bodyText = JSON.stringify(soloBody)

    let response: Response
    try {
      const send = ctx.fetch ?? fetch
      response = await send(`${TRAE_AGENT_HOST}${TRAE_CHAT_PATH}`, {
        method: 'POST',
        headers: traeSOLOHeaders(credential, true),
        body: bodyText,
        signal,
      })
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          kind: 'network',
          message: `连接 Trae 上游失败：${error instanceof Error ? error.message : String(error)}`,
          at: ctx.now(),
        },
      }
      return
    }

    if (!response.ok) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        // 读不到原文也没关系，状态码本身已经能分类。
      }
      yield {
        type: 'error',
        failure: {
          kind: classifyTraeError(response.status, text),
          message: text.slice(0, 300) || `HTTP ${response.status}`,
          status: response.status,
          at: ctx.now(),
        },
      }
      return
    }

    if (response.body === null) {
      yield {
        type: 'error',
        failure: { kind: 'server', message: 'Trae 响应没有 body（不是流式响应？）', at: ctx.now() },
      }
      return
    }

    const converter = new TraeSseConverter()
    const decoder = new TextDecoder('utf-8')
    const reader = response.body.getReader()
    let buffer = ''
    /** 流内错误（`event:error`）：延后到流收尾时如实报出。 */
    let streamFailure: { kind: ErrorKind; message: string } | undefined
    try {
      for (;;) {
        if (signal.aborted) {
          yield { type: 'finish', reason: 'aborted' }
          return
        }
        const { done, value } = await reader.read()
        if (done) break
        // ⚠️ `{stream: true}`：跨 chunk 的 UTF-8 残字节必须由解码器持有，
        // 否则一个中文字被 TCP 切开就会变成乱码（正文里出现「�」）。
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          for (const event of converter.feedLine(line)) {
            if (event.type === 'error') {
              // 不立即中断：先把这个事件透出去，流收尾时再统一收口。
              streamFailure = { kind: event.failure.kind, message: event.failure.message }
              yield event
              continue
            }
            yield event
          }
          newline = buffer.indexOf('\n')
        }
        if (converter.isEnded) break
      }
      // 冲洗解码器与最后一条没有尾随换行的事件。
      buffer += decoder.decode()
      for (const event of converter.finish()) {
        if (event.type === 'error') {
          streamFailure = { kind: event.failure.kind, message: event.failure.message }
          yield event
          continue
        }
        yield event
      }
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          kind: 'network',
          message: `读取 Trae 流失败：${error instanceof Error ? error.message : String(error)}`,
          at: ctx.now(),
        },
      }
      return
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // 释放失败无所谓。
      }
    }

    if (streamFailure !== undefined) {
      ctx.log.warn(`TRAE 流内错误：${streamFailure.message}`, `account=${record.id}`)
      return
    }

    // ⚠️ **一个上游事件都没收到** = 上游静默结束事件流。这是**可重试的瞬时故障**，
    // 不是「模型决定不说话」。如实报错，而不是给用户一个「回复为空」的死胡同。
    if (!converter.sawUpstreamEvent) {
      yield {
        type: 'error',
        failure: {
          kind: 'network',
          message: 'Trae 上游没有下发任何事件就结束了流（可重试）',
          at: ctx.now(),
        },
      }
      return
    }

    if (converter.isEnded && converter.finishReason === undefined) {
      // `done` 没带 finish_reason：不再补发 finish（`finish()` 已经补过 `stop`）。
    }
  }

  // ───────────────────── 错误分类 ─────────────────────

  /**
   * TRAE 的错误分类。
   *
   * ⚠️ 覆盖默认分类器的**唯一理由**是 TRAE 用**业务码**表达额度 / 限流
   * （`1005` Plan 权益不足 / `4008` 积分耗尽 / `4011` 频率超限），
   * 而这些码在 HTTP 200 的响应体里也会出现 —— 通用分类器按状态码走会漏掉它们。
   */
  override detectError(status: number, body: unknown, headers: Headers): ErrorKind {
    const text = typeof body === 'string' ? body : safeStringify(body)
    const kind = classifyTraeError(status, text)
    if (kind !== 'none') return kind
    // 兜底交给通用分类器（它还会看响应头）。
    return super.detectError(status, body, headers)
  }
}

/** JSON.stringify 的不会抛的版本。 */
function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * 续期日志里**绝不打印 token**（硬规则：任何日志不许出现完整凭证）。
 * 账号身份由调用方的 `account=${record.id}` 承担，这里不需要额外标识。
 */

/** 默认输出上限（导出给测试与文档引用）。 */
export const TRAE_MAX_OUTPUT_TOKENS_LIMIT = TRAE_DEFAULT_MAX_COMPLETION_TOKENS

/** 需要换号的流内错误码（导出给测试引用）。 */
export { isRotatableTraeStreamError }
