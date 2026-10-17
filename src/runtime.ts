/**
 * 运行期总装（GatewayRuntime）。
 *
 * **一句话**：把「账号 / 路由 / 调度 / 任务 / 模型缓存 / 适配器上下文」装成一个对象，
 * 让 DSH 插件入口、Agent 工具、客户端 Remote 三条消费路径**共用同一份状态**。
 *
 * 三条消费路径：
 *   - `index.ts` 的 LLM 适配器用它 `modelsOf()` 拿模型列表、用 `router` 转发对话；
 *   - `tools.ts` 的模型工具用它做账号/额度/签到/任务/路由操作；
 *   - `remote.ts` 的客户端页面用它渲染配置面板。
 *
 * 状态一致性靠一个不变式：**所有写操作都过 `AccountManager`**，
 * 谁都不许绕过它直接改内存或文件。
 */

import { AccountManager, freshHealth, type AccountDraft, type AccountPatch, type PersistedState } from './core/accounts.js'
import { MemoryCache, TokenBucket } from './core/cache.js'
import { createHttp } from './core/http.js'
import { JsonlLog, DebouncedWriter, readJsonSafe } from './core/store.js'
import { AccountRouter } from './core/router.js'
import { Scheduler } from './core/scheduler.js'
import { TaskEngine } from './core/tasks.js'
import { AdapterRegistry } from './core/registry.js'
import { LogRing, createLogger } from './core/logger.js'
import { redactDeep } from './core/crypto.js'
import { ERROR_LABELS } from './core/errors.js'
import { formatMultiplier, selectExposedModels, applyContextWindow } from './core/types.js'
import type {
  AccountCredentials,
  AccountRecord,
  AdapterContext,
  AgentAdapter,
  Logger,
  ModelMeta,
  QuotaSnapshot,
  ResolvedConfig,
  TaskRecord,
} from './core/types.js'

/** 建 runtime 的依赖。 */
export interface RuntimeOptions {
  config: ResolvedConfig
  /** DSH 日志器（可选，没有就退到 console）。 */
  dshLogger?: { debug?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void }
  /** 适配器（默认用内置清单）。 */
  adapters?: AgentAdapter[]
  /** 有这些服务时接上（全可选）。 */
  services?: { settings?: unknown }
}

/** 模型缓存的默认 TTL：5 分钟。够快，也不至于每次渲染都打上游。 */
const MODELS_TTL_MS = 5 * 60_000

/** 分组标题（与 `config.ts` 的 AGENT_DISPLAY_NAMES 保持一致）。 */
const AGENT_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  qoder: 'Qoder',
  'qoder-cn': 'Qoder CN',
  trae: 'Trae',
  workbuddy: 'WorkBuddy',
  'workbuddy-intl': 'WorkBuddy International',
}

export class GatewayRuntime {
  /**
   * 解析后的配置。
   *
   * ⚠️ **不是 `readonly`** —— 宿主改配置时会走 `reconfigure()` 就地把新值换进来。
   * 早先它是只读的，而热更新钩子只重建了定时计划，导致「在设置页改了模型策略、
   * 保存成功、下拉却纹丝不动」这种极难看懂的 bug。
   */
  config: ResolvedConfig
  readonly logger: Logger
  readonly ring = new LogRing(400)
  readonly registry = new AdapterRegistry()
  readonly accounts: AccountManager
  readonly router: AccountRouter
  readonly scheduler: Scheduler
  readonly tasks: TaskEngine
  /** 任务流水（JSONL）。 */
  readonly taskLogStore: JsonlLog
  /** 每个账号一个令牌桶（防上游风控）。 */
  private readonly buckets = new Map<string, TokenBucket>()
  /** 适配器上下文（每个 Agent 一份，缓存的持有者）。 */
  private readonly contexts = new Map<string, AdapterContext>()
  /** 模型列表的内存缓存。 */
  private readonly modelCache = new MemoryCache()
  /** 正在进行的模型拉取（并发去重，避免 UI 连续点几次就打几次上游）。 */
  private readonly modelInflight = new Map<string, Promise<ModelMeta[]>>()
  /** 状态防抖写入器：健康/额度/游标变化频繁，不能每次都同步写盘。 */
  private readonly stateWriter: DebouncedWriter
  /**
   * 挂着的设备码登录会话。
   *
   * ⚠️ **刻意不落盘、也不出宿主进程**：`device_code` 是能换出账号 token 的东西，
   * 它没有理由经过浏览器。服务重启后这些会话自然失效，用户重新点一次即可。
   */
  private readonly loginSessions = new Map<
    string,
    { agentId: string; deviceCode: string; expiresAt: number; label: string; intervalSec: number }
  >()
  private disposed = false

  constructor(options: RuntimeOptions) {
    this.config = options.config
    this.logger = createLogger('gateway', this.ring, options.dshLogger, options.config.verbose)
    this.ring.push({
      at: Date.now(),
      level: 'info',
      scope: 'gateway',
      message: '多 Agent 网关启动中',
      detail: `dataDir=${options.config.dataDir}`,
    })

    const state = readJsonSafe<PersistedState>(
      `${options.config.dataDir}/state.json`,
      { v: 1, updatedAt: 0, health: {}, quota: {} },
      this.logger,
    )
    if (state.v !== 1) {
      state.v = 1
      state.health = state.health ?? {}
      state.quota = state.quota ?? {}
    }

    this.accounts = new AccountManager(options.config.dataDir, this.logger.child('accounts'), state)
    const loaded = this.accounts.load()
    if (!loaded.ok && loaded.error !== undefined) {
      this.ring.push({
        at: Date.now(),
        level: 'error',
        scope: 'accounts',
        message: '账号装载失败 —— 界面上的账号列表会是空的',
        detail: loaded.error,
      })
    }
    // 状态变脏 → 防抖落盘（默认 800ms）。没有这一步，「健康 / 额度 / 游标」
    // 这些高频变化的东西会在 DSH 重启后全部丢掉。
    this.stateWriter = new DebouncedWriter(
      this.accounts.statePath,
      800,
      this.logger.child('state'),
    )
    this.accounts.setDirtyHook(() => this.stateWriter.schedule(() => this.accounts.stateSnapshot()))

    this.registry.registerAll(options.adapters ?? [])
    this.router = new AccountRouter(this.accounts, options.config.gateway, this.logger.child('router'))
    this.taskLogStore = new JsonlLog(`${options.config.dataDir}/task-log.jsonl`, 4000, this.logger.child('tasks'))
    this.tasks = new TaskEngine({
      accounts: this.accounts,
      log: this.logger.child('tasks'),
      adapterOf: (agentId) => this.registry.get(agentId),
      contextOf: (agentId) => this.contextOf(agentId),
      tasksConfigOf: (agentId) => this.agentConfig(agentId).tasks,
      checkInConfigOf: (agentId) => this.agentConfig(agentId).checkIn,
      logStore: this.taskLogStore,
    })
    this.scheduler = new Scheduler({
      logger: this.logger.child('scheduler'),
      getLastRun: (key) => this.accounts.lastRun(key),
      setLastRun: (key, at) => this.accounts.setLastRun(key, at),
      tickMs: 15_000,
      maxFailures: 5,
      cooldownMs: 10 * 60_000,
    })
  }

  /** 某个 Agent 的解析后配置（未知 Agent 会补一份关闭状态的默认值）。 */
  agentConfig(agentId: string) {
    const existing = this.config.agents[agentId]
    if (existing !== undefined) return existing
    return {
      id: agentId,
      name: agentId,
      enabled: false,
      exposeModels: false,
      labelWithAgent: true,
      checkIn: { enabled: false, cron: 'every:86400', startupDelaySec: 60 },
      quota: { enabled: false, cron: 'every:1800', startupDelaySec: 60 },
      tasks: { enabled: false, intervalMinutes: 60, concurrency: 1, maxFailures: 3, retryDelaySec: 30, kinds: [] as never[] },
      upstream: { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '' },
      credits: { unit: 'credits' as const, baselineUsdPerMTok: 1.2, round: 2 },
      requestTimeoutMs: 120_000,
      retry: { maxAttempts: 3, backoffMs: 500, maxBackoffMs: 8000 },
      rateLimitPerMinute: 60,
    }
  }

  /** 取（或建）适配器上下文。 */
  contextOf(agentId: string): AdapterContext | undefined {
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) return undefined
    const existing = this.contexts.get(agentId)
    if (existing !== undefined) return existing
    const config = this.agentConfig(agentId)
    const ctx: AdapterContext = {
      config,
      log: this.logger.child(`agent:${agentId}`),
      http: createHttp(this.logger.child(`http:${agentId}`), config.requestTimeoutMs),
      cache: new MemoryCache(),
      now: () => Date.now(),
      // OAuth 登录态续期后回写账号库（加密落盘）—— 少了这一步，重启后要重新登录。
      onCredentialsRefreshed: (accountId, patch) => {
        const record = this.accounts.get(accountId)
        if (record === undefined) return
        this.accounts.setCredentials(accountId, { ...record.credentials, ...patch })
      },
    }
    this.contexts.set(agentId, ctx)
    return ctx
  }

  // ───────────────────────── OAuth 设备码登录 ─────────────────────────

  /**
   * 发起一次设备码登录。
   *
   * ⚠️ `device_code` **只留在宿主进程内**（`loginSessions`），不回给浏览器 ——
   * 浏览器只需要看到 `user_code` 与授权链接；真正的 token 也永远不会出宿主。
   */
  async loginStart(agentId: string, label?: string): Promise<Record<string, unknown>> {
    const adapter = this.registry.get(agentId) as
      | (AgentAdapter & { startDeviceLogin?: (ctx: AdapterContext) => Promise<unknown> })
      | undefined
    const ctx = this.contextOf(agentId)
    if (adapter === undefined || ctx === undefined) throw new Error(`适配器未装载：${agentId}`)
    if (typeof adapter.startDeviceLogin !== 'function') {
      throw new Error(`「${adapter.name}」适配器没有实现设备码登录`)
    }
    const start = (await adapter.startDeviceLogin(ctx)) as {
      deviceCode: string
      userCode: string
      verificationUrl: string
      expiresInSec: number
      intervalSec: number
    }
    const loginId = `login-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.loginSessions.set(loginId, {
      agentId,
      deviceCode: start.deviceCode,
      expiresAt: Date.now() + start.expiresInSec * 1000,
      label: label !== undefined && label.trim() !== '' ? label.trim() : `${this.agentConfig(agentId).name} 账号`,
      intervalSec: start.intervalSec,
    })
    this.logger.info(`[${agentId}] 已发起设备码登录`, `请打开 ${start.verificationUrl}`)
    return {
      loginId,
      userCode: start.userCode,
      verificationUrl: start.verificationUrl,
      expiresInSec: start.expiresInSec,
      intervalSec: start.intervalSec,
    }
  }

  /**
   * 轮询一次登录结果。
   *
   * 成功时**由宿主**创建 / 更新账号（token 不经过浏览器），返回脱敏后的账号记录。
   */
  async loginPoll(loginId: string): Promise<Record<string, unknown>> {
    const session = this.loginSessions.get(loginId)
    if (session === undefined) {
      return { status: 'expired', message: '这次登录会话不存在了（可能服务重启过），请重新发起' }
    }
    if (Date.now() > session.expiresAt) {
      this.loginSessions.delete(loginId)
      return { status: 'expired', message: '设备码已过期（10 分钟），请重新发起登录' }
    }
    const adapter = this.registry.get(session.agentId) as
      | (AgentAdapter & { pollDeviceLogin?: (code: string, ctx: AdapterContext) => Promise<unknown> })
      | undefined
    const ctx = this.contextOf(session.agentId)
    if (adapter === undefined || ctx === undefined || typeof adapter.pollDeviceLogin !== 'function') {
      this.loginSessions.delete(loginId)
      return { status: 'failed', message: '适配器已卸载' }
    }
    const outcome = (await adapter.pollDeviceLogin(session.deviceCode, ctx)) as {
      status: string
      message: string
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
      orgId?: string
      account?: string
      intervalSec?: number
    }
    if (outcome.status !== 'ready') {
      if (outcome.status === 'expired' || outcome.status === 'denied' || outcome.status === 'failed') {
        this.loginSessions.delete(loginId)
      }
      return {
        status: outcome.status,
        message: outcome.message,
        ...(outcome.intervalSec === undefined ? {} : { intervalSec: outcome.intervalSec }),
      }
    }

    // 成功：写账号。label 优先用登录到的邮箱。
    this.loginSessions.delete(loginId)
    const label = outcome.account !== undefined && outcome.account !== '' ? outcome.account : session.label
    const credentials: AccountCredentials = {
      token: outcome.accessToken ?? '',
      ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
      ...(outcome.expiresAt === undefined ? {} : { expiresAt: outcome.expiresAt }),
      ...(outcome.orgId === undefined ? {} : { orgId: outcome.orgId }),
      ...(outcome.account === undefined ? {} : { account: outcome.account }),
      authKind: 'oauth-device',
    }
    let record = this.accounts.byAgent(session.agentId).find((item) => item.label === label)
    let created = false
    if (record === undefined) {
      record = this.accounts.add({ agentId: session.agentId, label, credentials })
      created = true
    } else {
      record = this.accounts.setCredentials(record.id, { ...record.credentials, ...credentials })
    }
    this.refreshSchedule()
    this.accounts.persistState()
    this.logger.info(
      `${created ? '已登录并新增账号' : '已更新已有账号'}：${record.id}`,
      `账号=${label}${outcome.orgId === undefined ? '' : ` 工作区=${outcome.orgId}`}`,
    )
    return {
      status: 'ready',
      message: created ? `登录成功，已新增账号「${label}」` : `登录成功，已更新账号「${label}」`,
      account: this.publicAccount(record),
    }
  }

  /** 取消一次登录会话。 */
  loginCancel(loginId: string): boolean {
    return this.loginSessions.delete(loginId)
  }

  /** 当前挂着的登录会话数（诊断）。 */
  get pendingLogins(): number {
    return this.loginSessions.size
  }

  /** 该 Agent 是否要参与（配置启用 + 注册表里有实现）。 */
  isAgentActive(agentId: string): boolean {
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) return false
    return this.agentConfig(agentId).enabled
  }

  /** 全部「要上报给 DSH 模型选择器」的 Agent（**顺序就是分组顺序**）。 */
  exposedAgentIds(): string[] {
    return this.registry
      .ids()
      .filter((agentId) => this.isAgentActive(agentId) && this.agentConfig(agentId).exposeModels)
  }

  /** 每个账号的令牌桶。 */
  private bucketOf(accountId: string): TokenBucket {
    let bucket = this.buckets.get(accountId)
    if (bucket === undefined) {
      const account = this.accounts.get(accountId)
      const perMinute = account === undefined ? 60 : this.agentConfig(account.agentId).rateLimitPerMinute
      bucket = new TokenBucket(perMinute)
      this.buckets.set(accountId, bucket)
    }
    return bucket
  }

  /** 等限速令牌（在真正发请求前调用）。 */
  async awaitRateLimit(accountId: string, signal?: AbortSignal): Promise<void> {
    await this.bucketOf(accountId).acquire(accountId, signal)
  }

  // ───────────────────────── 模型 ─────────────────────────

  /**
   * **要上报给 DSH 模型选择器**的模型（已按策略过滤）。
   *
   * 与 `modelsOf` 分开是刻意的：
   *   - `modelsOf` = 上游一共有哪些（设置页的勾选列表需要全量）；
   *   - `exposedModelsOf` = 用户挑出来要暴露的（DSH 的模型下拉只看这个）。
   *
   * 混成一个的话，要么选择器被几十个模型塞满，要么设置页看不到可勾的项。
   */
  async exposedModelsOf(agentId: string, force = false): Promise<ModelMeta[]> {
    const config = this.agentConfig(agentId)
    if (!config.exposeModels) return []
    const all = await this.modelsOf(agentId, force)
    // 先按「免费 / 勾选 / 全部」筛，再套用户设的上下文长度覆盖。
    // 顺序不能反：覆盖是按模型 id 生效的，筛掉的不该白算一遍。
    return applyContextWindow(selectExposedModels(all, config.models), config.contextWindow)
  }

  /**
   * 某 Agent 的模型元数据（带缓存）。
   *
   * 用**哪个账号**去拉？模型目录大多免鉴权，所以：
   *   1. 优先用第一个参与路由的账号（能拿到「这个工作区有什么模型」）；
   *   2. 没有账号就用一个空凭证的临时记录（公开目录照样能拉）。
   *
   * 拉取失败时**返回上一次缓存**（`AccountManager` 里那份），而不是空列表 ——
   * 否则模型选择器会突然空掉，用户以为插件坏了。
   */
  async modelsOf(agentId: string, force = false): Promise<ModelMeta[]> {
    const cacheKey = `models:${agentId}`
    if (!force) {
      const cached = this.modelCache.get<ModelMeta[]>(cacheKey)
      if (cached !== undefined) return cached
    }
    const inflight = this.modelInflight.get(cacheKey)
    if (inflight !== undefined && !force) return inflight

    const job = (async (): Promise<ModelMeta[]> => {
      const adapter = this.registry.get(agentId)
      const ctx = this.contextOf(agentId)
      if (adapter === undefined || ctx === undefined) return []
      const account =
        this.accounts.routable(agentId)[0] ??
        ({
          id: `${agentId}:anonymous`,
          agentId,
          label: '(未配置账号)',
          credentials: {},
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        } satisfies AccountRecord)
      try {
        const list = await adapter.getModelMetaList(account, ctx)
        if (list.length > 0) {
          this.modelCache.set(cacheKey, list, MODELS_TTL_MS)
          this.accounts.cacheModels(
            agentId,
            list as unknown[],
            `${adapter.name} · ${account.id}`,
          )
          this.accounts.persistState()
          this.logger.debug(`已更新「${agentId}」模型列表：${list.length} 个`, `来源账号=${account.id}`)
        } else if (list.length === 0) {
          this.logger.warn(`「${agentId}」模型列表为空（上游与缓存都没拿到）`)
        }
        return list
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.error(`拉取「${agentId}」模型列表失败`, message)
        // 回退到落盘缓存。
        const fallback = this.accounts.cachedModels(agentId)
        if (fallback !== undefined && fallback.length > 0) {
          this.logger.info(`改用落盘缓存：${fallback.length} 个模型`, `缓存时间=${new Date(this.accounts.modelsFetchedAt(agentId)).toLocaleString()}`)
          return fallback as ModelMeta[]
        }
        return []
      } finally {
        this.modelInflight.delete(cacheKey)
      }
    })()
    this.modelInflight.set(cacheKey, job)
    return job
  }

  /** 全部要上报的模型（按 Agent 分组顺序拼接）。 */
  async allModels(force = false): Promise<ModelMeta[]> {
    const out: ModelMeta[] = []
    for (const agentId of this.exposedAgentIds()) {
      out.push(...(await this.modelsOf(agentId, force)))
    }
    return out
  }

  // ───────────────────────── 调度 ─────────────────────────

  /**
   * 生成全部定时 job 并启动调度器。
   *
   * job 是**按账号 × 能力**生成的：一个没有签到能力的上游不会得到签到 job
   * （否则每 24 小时打一次注定失败的请求）。
   */
  start(): void {
    if (this.disposed) return
    this.buildPlan()
    this.scheduler.start()
  }

  /**
   * **热更新**：把新解析出来的配置换进运行中的实例。
   *
   * 由 `apply()` 里的 `loader/volatile-update` 钩子调用。宿主把 volatile 字段做成
   * 「活引用」，所以只要拿**同一个 config 对象**重新 `resolveConfig()` 就能读到新值。
   *
   * 三件事必须一起做，少一件就会出现「保存了但没生效」：
   *   1. 换 config 本身 —— `agentConfig()`（模型策略、上游地址…）读的就是它；
   *   2. **清掉适配器上下文缓存** —— 上下文里揣着旧的 agentConfig 与 http 客户端，
   *      不清的话下一次请求还是按旧配置发；
   *   3. 重建定时计划 —— cron / 开关可能一起改了。
   */
  reconfigure(next: ResolvedConfig): void {
    if (this.disposed) return
    this.config = next
    this.contexts.clear()
    this.buildPlan()
  }

  /** 只重建计划、不动 tick 循环（账号增删后调用）。 */
  refreshSchedule(): void {
    if (this.disposed) return
    this.buildPlan()
  }

  /** 生成定时计划（清空后重建）。 */
  private buildPlan(): void {
    this.scheduler.clear()
    let effective = 0
    for (const agentId of this.registry.ids()) {
      if (!this.isAgentActive(agentId)) continue
      const adapter = this.registry.get(agentId)
      if (adapter === undefined) continue
      const config = this.agentConfig(agentId)
      const accounts = this.accounts.byAgent(agentId).filter((account) => account.enabled)
      const offsetBase = config.checkIn.startupDelaySec

      // ① 每日签到（账号级）
      if (adapter.capabilities.checkIn) {
        for (const [index, account] of accounts.entries()) {
          if (!(account.autoCheckIn ?? config.checkIn.enabled)) continue
          effective += 1
          this.scheduler.register({
            key: `checkin:${agentId}:${account.id}`,
            title: `${adapter.name} · ${account.label} · 每日签到`,
            schedule: config.checkIn.cron,
            accountId: account.id,
            firstRunDelayMs: (offsetBase + index * 5) * 1000,
            run: async () => {
              const outcome = await this.tasks.checkIn(account)
              return outcome.message
            },
          })
        }
      } else {
        this.logger.info(
          `「${adapter.name}」未实现每日签到，不安排签到定时任务`,
          adapter.capabilities.notes?.checkIn ?? '',
        )
      }

      // ② 额度定时拉取（账号级）
      if (adapter.capabilities.quota) {
        for (const [index, account] of accounts.entries()) {
          if (!config.quota.enabled) continue
          effective += 1
          this.scheduler.register({
            key: `quota:${agentId}:${account.id}`,
            title: `${adapter.name} · ${account.label} · 额度拉取`,
            schedule: config.quota.cron,
            accountId: account.id,
            firstRunDelayMs: (config.quota.startupDelaySec + index * 3) * 1000,
            run: async () => {
              const snapshot = await this.fetchQuota(account)
              return snapshot.error ?? `剩余 ${snapshot.remaining ?? '未知'}`
            },
          })
        }
      }

      // ③ 活动任务（Agent 级，批量跑）
      if (adapter.capabilities.tasks && config.tasks.enabled) {
        const enabledAccounts = accounts.filter((account) => account.autoTasks ?? true)
        if (enabledAccounts.length > 0) {
          effective += 1
          this.scheduler.register({
            key: `tasks:${agentId}`,
            title: `${adapter.name} · 活动任务`,
            schedule: `every:${Math.max(300, config.tasks.intervalMinutes * 60)}`,
            firstRunDelayMs: (config.tasks.intervalMinutes * 60 * 0.25 + 90) * 1000,
            run: async (signal) => {
              const outcome = await this.tasks.runBatch(agentId, signal)
              return `${outcome.accounts} 个账号，执行 ${outcome.attempted}，成功 ${outcome.succeeded}，积分 +${outcome.credits}`
            },
          })
        }
      }

      // ④ 模型 / 倍率缓存刷新（Agent 级）
      if (adapter.capabilities.models && config.exposeModels) {
        effective += 1
        this.scheduler.register({
          key: `models:${agentId}`,
          title: `${adapter.name} · 模型与倍率刷新`,
          schedule: 'every:21600',
          firstRunDelayMs: 15_000,
          run: async () => {
            const list = await this.modelsOf(agentId, true)
            const withMult = list.filter((item) => item.multiplier !== undefined).length
            return `${list.length} 个模型，其中 ${withMult} 个有倍率`
          },
        })
      }

      // ⑤ 降权账号自动恢复检测（Agent 级）
      effective += 1
      this.scheduler.register({
        key: `recover:${agentId}`,
        title: `${adapter.name} · 账号降权恢复检测`,
        schedule: `every:${Math.max(60, this.config.gateway.recoverIntervalSec)}`,
        firstRunDelayMs: 120_000,
        run: async () => {
          const results = await this.router.recover([agentId], async (account) => {
            if (!adapter.capabilities.quota) {
              // 没有额度接口就用「凭证是否还有效」当探针（最便宜的那个）。
              const check = await adapter.validateCredentials(account, this.contextOf(agentId) as AdapterContext)
              return check.ok
            }
            const snapshot = await this.fetchQuota(account)
            return snapshot.error === undefined || (snapshot.error !== undefined && snapshot.remaining !== undefined)
          })
          this.accounts.persistState()
          if (results.length === 0) return '没有处于降权状态的账号'
          const restored = results.filter((item) => item.restored).length
          return `检测 ${results.length} 个，恢复 ${restored} 个`
        },
      })
    }
    this.scheduler.start()
    this.logger.info(`定时任务计划已生成：${effective} 条（共 ${this.scheduler.size} 个 job）`)
  }

  /** 停掉一切。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scheduler.stop()
    this.stateWriter.flush()
    try {
      this.accounts.persistState()
    } catch (error) {
      this.logger.warn('退出时状态落盘失败', error instanceof Error ? error.message : String(error))
    }
  }

  // ───────────────────────── 额度 ─────────────────────────

  /** 拉一个账号的额度并写入缓存。 */
  async fetchQuota(account: AccountRecord): Promise<QuotaSnapshot> {
    const adapter = this.registry.get(account.agentId)
    const ctx = this.contextOf(account.agentId)
    if (adapter === undefined || ctx === undefined) {
      return { accountId: account.id, unit: 'unknown', fetchedAt: Date.now(), error: '适配器未装载' }
    }
    try {
      await this.awaitRateLimit(account.id)
      const snapshot = await adapter.getQuota(account, ctx)
      this.accounts.setQuota(snapshot)
      this.accounts.persistState()
      if (snapshot.remaining !== undefined) {
        this.logger.info(
          `[${account.agentId}] ${account.label} 额度：${snapshot.remaining} ${snapshot.unit}`,
          snapshot.total === undefined ? '' : `总额度 ${snapshot.total}，已用 ${snapshot.used ?? 0}`,
        )
      }
      return snapshot
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const snapshot: QuotaSnapshot = {
        accountId: account.id,
        unit: 'unknown',
        fetchedAt: Date.now(),
        error: `额度查询抛错：${message}`,
      }
      this.accounts.setQuota(snapshot)
      return snapshot
    }
  }

  /** 刷新（某些/全部）账号的额度。 */
  async refreshQuotas(agentId?: string): Promise<Array<Record<string, unknown>>> {
    const targets = (agentId === undefined ? this.accounts.all() : this.accounts.byAgent(agentId)).filter(
      (account) => account.enabled,
    )
    const out: Array<Record<string, unknown>> = []
    for (const account of targets) {
      const snapshot = await this.fetchQuota(account)
      out.push({
        accountId: account.id,
        agentId: account.agentId,
        label: account.label,
        unit: snapshot.unit,
        remaining: snapshot.remaining ?? null,
        total: snapshot.total ?? null,
        used: snapshot.used ?? null,
        unlimited: snapshot.unlimited === true,
        error: snapshot.error ?? null,
        fetchedAt: snapshot.fetchedAt,
      })
    }
    return out
  }

  // ───────────────────────── 签到 / 任务 ─────────────────────────

  /** 手动/定时跑签到。 */
  async runCheckIn(options: { agentId?: string; accountId?: string; force?: boolean }): Promise<unknown[]> {
    const targets =
      options.accountId !== undefined
        ? [this.accounts.get(options.accountId)].filter((item): item is AccountRecord => item !== undefined)
        : options.agentId !== undefined
          ? this.accounts.byAgent(options.agentId).filter((account) => account.enabled)
          : this.accounts.all().filter((account) => account.enabled)
    const out: unknown[] = []
    for (const account of targets) {
      const outcome = await this.tasks.checkIn(account, { force: options.force === true })
      out.push({
        accountId: account.id,
        agentId: account.agentId,
        label: account.label,
        ok: outcome.ok,
        supported: outcome.supported,
        credits: outcome.credits,
        message: outcome.message,
      })
    }
    return out
  }

  /** 列出可做任务（不执行）。 */
  async listTasks(agentId?: string): Promise<unknown[]> {
    const out: unknown[] = []
    const targets = agentId === undefined ? this.registry.ids() : [agentId]
    for (const id of targets) {
      const adapter = this.registry.get(id)
      if (adapter === undefined || !adapter.capabilities.tasks) continue
      const accounts = this.accounts.byAgent(id).filter((account) => account.enabled)
      for (const account of accounts) {
        const ctx = this.contextOf(id)
        if (ctx === undefined) continue
        let items: TaskRecord[] = []
        let error: string | undefined
        try {
          items = await adapter.fetchAvailableTasks(account, ctx)
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
        out.push({
          accountId: account.id,
          agentId: id,
          label: account.label,
          tasks: items.map((task) => ({
            id: task.id,
            title: task.title,
            kind: task.kind,
            reward: task.reward ?? null,
            description: task.description ?? null,
          })),
          error: error ?? null,
        })
      }
    }
    return out
  }

  /** 立即跑一轮活动任务。 */
  async runTasks(options: { agentId?: string; accountId?: string }): Promise<unknown> {
    if (options.accountId !== undefined) {
      const account = this.accounts.get(options.accountId)
      if (account === undefined) return { ok: false, error: `账号不存在：${options.accountId}` }
      const outcome = await this.tasks.runForAccount(account)
      return { ok: true, accounts: 1, ...outcome, details: [{ accountId: account.id, message: outcome.message }] }
    }
    const targets =
      options.agentId === undefined
        ? this.registry.ids().filter((id) => this.registry.get(id)?.capabilities.tasks === true)
        : [options.agentId]
    const merged = { accounts: 0, attempted: 0, succeeded: 0, credits: 0, details: [] as Array<{ accountId: string; message: string }> }
    for (const id of targets) {
      const outcome = await this.tasks.runBatch(id)
      merged.accounts += outcome.accounts
      merged.attempted += outcome.attempted
      merged.succeeded += outcome.succeeded
      merged.credits += outcome.credits
      merged.details.push(...outcome.details)
    }
    return { ok: true, ...merged }
  }

  /** 解除某账号的活动任务暂停。 */
  resumeTasks(accountId: string): boolean {
    return this.tasks.resume(accountId)
  }

  /** 任务流水。 */
  taskLog(count = 40): unknown[] {
    return redactDeep(this.tasks.recent(count)) as unknown[]
  }

  // ───────────────────────── 账号（写操作） ─────────────────────────

  /** 新增账号（返回脱敏对象）。 */
  addAccount(draft: AccountDraft): Record<string, unknown> {
    const record = this.accounts.add(draft)
    this.refreshSchedule()
    return this.publicAccount(record)
  }

  /** 改账号。 */
  updateAccount(id: string, patch: AccountPatch): Record<string, unknown> {
    const record = this.accounts.update(id, patch)
    this.refreshSchedule()
    return this.publicAccount(record)
  }

  /** 删账号。 */
  removeAccount(id: string): boolean {
    const ok = this.accounts.remove(id)
    if (ok) this.refreshSchedule()
    return ok
  }

  /** 换凭证。 */
  setCredentials(id: string, credentials: AccountCredentials): Record<string, unknown> {
    const record = this.accounts.setCredentials(id, credentials)
    return this.publicAccount(record)
  }

  /** 测活（真实打一次上游）。 */
  async testAccount(id: string): Promise<unknown> {
    const account = this.accounts.get(id)
    if (account === undefined) return { ok: false, message: `账号不存在：${id}` }
    const adapter = this.registry.get(account.agentId)
    const ctx = this.contextOf(account.agentId)
    if (adapter === undefined || ctx === undefined) return { ok: false, message: '适配器未装载' }
    try {
      const result = await adapter.validateCredentials(account, ctx)
      if (result.ok) this.accounts.markOk(id)
      else this.accounts.markFailure(id, { kind: result.kind ?? 'auth', message: result.message ?? '', at: Date.now() }, 1, 60_000)
      this.accounts.persistState()
      return { ok: result.ok, message: result.message ?? '', kind: result.kind ?? 'none' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), kind: 'unknown' }
    }
  }

  /** 单账号 → 给 UI/工具看的形状（脱敏 + 健康 + 额度 + 任务状态）。 */
  publicAccount(record: AccountRecord): Record<string, unknown> {
    const redacted = redactDeep(record) as Record<string, unknown>
    const credentials = record.credentials
    const hasRefresh = typeof credentials.refreshToken === 'string' && credentials.refreshToken !== ''
    return {
      ...redacted,
      hasToken: typeof credentials.token === 'string' && credentials.token !== '',
      hasCookie: typeof credentials.cookie === 'string' && credentials.cookie !== '',
      /** `oauth-device` = 设备码登录来的（会自动续期）；否则是手工填的 API key。 */
      authKind: credentials.authKind === 'oauth-device' ? 'oauth-device' : 'manual',
      /** 登录态是否会自动续期。 */
      autoRefresh: hasRefresh,
      /** 登录到的账号 / 工作区（设备码登录才有）。 */
      loginAccount: typeof credentials.account === 'string' ? credentials.account : null,
      orgId: typeof credentials.orgId === 'string' ? credentials.orgId : null,
      /** 登录态的过期时间（没有就是 null）。 */
      expiresAt: typeof credentials.expiresAt === 'number' ? credentials.expiresAt : null,
      health: this.accounts.health(record.id),
      quota: this.accounts.quota(record.id) ?? null,
    }
  }

  // ───────────────────────── 快照（UI / 工具） ─────────────────────────

  snapshotAccounts(agentId?: string): unknown[] {
    const source = agentId === undefined ? this.accounts.all() : this.accounts.byAgent(agentId)
    return source.map((record) => this.publicAccount(record))
  }

  snapshotQuotas(agentId?: string): unknown[] {
    const source = agentId === undefined ? this.accounts.all() : this.accounts.byAgent(agentId)
    return source.map((record) => {
      const quota = this.accounts.quota(record.id)
      return {
        accountId: record.id,
        agentId: record.agentId,
        label: record.label,
        unit: quota?.unit ?? 'unknown',
        remaining: quota?.remaining ?? null,
        total: quota?.total ?? null,
        used: quota?.used ?? null,
        unlimited: quota?.unlimited === true,
        error: quota?.error ?? (quota === undefined ? '还没拉取过' : null),
        fetchedAt: quota?.fetchedAt ?? null,
      }
    })
  }

  snapshotRouting(agentId?: string): unknown {
    const agents = agentId === undefined ? this.registry.ids() : [agentId]
    return {
      strategy: this.config.gateway.routing,
      gateway: this.config.gateway,
      agents: agents.map((id) => ({
        agentId: id,
        name: this.agentConfig(id).name,
        active: this.isAgentActive(id),
        accounts: this.accounts.byAgent(id).map((account) => ({
          accountId: account.id,
          label: account.label,
          enabled: account.enabled,
          routeChat: account.routeChat !== false,
          health: this.accounts.health(account.id),
          lastError:
            this.accounts.health(account.id).lastError === undefined
              ? null
              : {
                  ...this.accounts.health(account.id).lastError,
                  label: ERROR_LABELS[this.accounts.health(account.id).lastError?.kind ?? 'unknown'],
                },
        })),
      })),
    }
  }

  snapshotTasks(agentId?: string): unknown[] {
    return this.tasks.snapshot(agentId).map((item) => ({ ...(redactDeep(item) as object) }))
  }

  snapshotSchedule(): unknown[] {
    return this.scheduler.snapshot()
  }

  snapshotLogs(count = 120): unknown[] {
    return redactDeep(this.ring.tail(count)) as unknown[]
  }

  /**
   * UI 的**主快照**：一次调用拿全，避免页面上十几次来回。
   */
  snapshotState(): unknown {
    const routing = this.snapshotRouting() as {
      agents: Array<{ accounts: Array<{ health: { state: string } }> }>
    }
    const degraded = routing.agents
      .flatMap((item) => item.accounts)
      .filter((item) => item.health.state !== 'ok').length
    const agents = this.registry.ids().map((agentId) => {
      const adapter = this.registry.get(agentId)
      const config = this.agentConfig(agentId)
      return {
        agentId,
        name: config.name,
        implemented: adapter !== undefined && (adapter as AgentAdapter & { implemented?: boolean }).implemented === true,
        enabled: this.isAgentActive(agentId),
        exposeModels: config.exposeModels,
        labelWithAgent: config.labelWithAgent,
        capabilities: adapter?.capabilities ?? null,
        accounts: this.accounts.byAgent(agentId).map((record) => this.publicAccount(record)),
        quotas: this.snapshotQuotas(agentId),
        tasks: this.snapshotTasks(agentId),
        jobCount: this.scheduler.snapshot().filter((job) => job.key.endsWith(`:${agentId}`) || job.key.includes(`:${agentId}:`)).length,
        modelCount: (() => {
          const cached = this.modelCache.get<ModelMeta[]>(`models:${agentId}`)
          return cached === undefined ? null : cached.length
        })(),
        docs: adapter !== undefined && 'doc' in adapter ? (adapter as { doc?: string }).doc ?? null : null,
        credentialHint:
          adapter !== undefined && 'credentialHint' in adapter
            ? (adapter as { credentialHint?: string }).credentialHint ?? null
            : null,
      }
    })
    return {
      ok: true,
      version: 1,
      enabled: this.config.enabled,
      dataDir: this.config.dataDir,
      paths: {
        accounts: this.accounts.accountsPath,
        state: this.accounts.statePath,
        key: this.accounts.keyPath,
        taskLog: `${this.config.dataDir}/task-log.jsonl`,
      },
      gateway: this.config.gateway,
      routing: this.snapshotRouting(),
      agents,
      jobs: this.scheduler.snapshot(),
      logs: this.snapshotLogs(80),
      taskLog: this.taskLog(40),
      totals: {
        accounts: this.accounts.all().length,
        enabledAccounts: this.accounts.all().filter((account) => account.enabled).length,
        degraded,
      },
      multiplierLegend:
        '倍率 = max(输入价, 输出价) / 基准价；免费模型标「免费」；价格拿不到时标「未知倍率」。',
      formatExample: `${AGENT_LABELS.opencode} · DeepSeek V4.1 Flash Free (${formatMultiplier(0, true)})`,
    }
  }

  // ───────────────────────── 其它动作 ─────────────────────────

  /** 立刻跑一轮调度（UI 的「立即执行」）。 */
  async tick(): Promise<unknown[]> {
    const results = await this.scheduler.runOnce()
    this.accounts.persistState()
    return results
  }

  /** 立刻跑一轮降权恢复检测。 */
  async recoverNow(): Promise<unknown> {
    const results = []
    for (const agentId of this.registry.ids()) {
      const adapter = this.registry.get(agentId)
      const ctx = this.contextOf(agentId)
      if (adapter === undefined || ctx === undefined) continue
      results.push(
        ...(await this.router.recover([agentId], async (account) => {
          const check = await adapter.validateCredentials(account, ctx)
          return check.ok
        })),
      )
    }
    this.accounts.persistState()
    return { checked: results.length, restored: results.filter((item) => item.restored).length, results }
  }

  /** 重置一个账号的健康。 */
  resetHealth(accountId: string): boolean {
    if (this.accounts.get(accountId) === undefined) return false
    this.accounts.resetHealth(accountId)
    return true
  }

  /** 清空任务流水。 */
  clearTaskLog(): boolean {
    this.tasks.clearLog()
    return true
  }

  /** 给测试用的健康初始化。 */
  static freshHealth = freshHealth
}
