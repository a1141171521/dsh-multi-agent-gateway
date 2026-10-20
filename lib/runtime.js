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

import { AccountManager, freshHealth,                                                           } from './core/accounts.js'
import { MemoryCache, TokenBucket } from './core/cache.js'
import { createHttp } from './core/http.js'
import { JsonlLog, DebouncedWriter, readJsonSafe, writeJsonAtomic } from './core/store.js'
import { checkUpdate, applyUpdate,                                      } from './core/updater.js'
                                                                        
import { fileURLToPath } from 'node:url'
import { AccountRouter } from './core/router.js'
import { Scheduler } from './core/scheduler.js'
import { TaskEngine } from './core/tasks.js'
import { AdapterRegistry } from './core/registry.js'
import { LogRing, createLogger } from './core/logger.js'
import { redactDeep } from './core/crypto.js'
import { ERROR_LABELS } from './core/errors.js'
import { formatMultiplier, selectExposedModels, applyContextWindow } from './core/types.js'
             
                     
                
                 
               
              
         
            
                
                 
              
             
                        
import { RequestLog,                     } from './core/request-log.js'
import {
  PROBE_DEFAULTS,
  mergeProbeCache,
  runProbeBatch,
                        
                    
} from './core/probe.js'

/** 建 runtime 的依赖。 */
                                 
                        
                                   
                                                                                                                                                          
                      
                           
                       
                                   
 

/** 模型缓存的默认 TTL：5 分钟。够快，也不至于每次渲染都打上游。 */
const MODELS_TTL_MS = 5 * 60_000

/** 分组标题（与 `config.ts` 的 AGENT_DISPLAY_NAMES 保持一致）。 */
const AGENT_LABELS                         = {
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
  config                
           logger        
           ring = new LogRing(400)
           registry = new AdapterRegistry()
           accounts                
           router               
           scheduler           
           tasks            
  /** 任务流水（JSONL）。 */
           taskLogStore          
  /** 逐请求采样（日志页 + 总览 KPI 的数据源）。 */
           requestLog            
  /** 模型可用性探测的缓存：`modelId → 结论`。 */
          probes                                   = {}
                   probePath        
  /** 同一时刻只允许一轮探测（两轮并发只会把上游打成 429）。 */
          probing = false
  /**
   * 插件自身的安装目录（`lib/runtime.js` 的上一级）。
   *
   * git 更新只在这里跑：不碰数据目录，也不接受调用方传入路径 ——
   * 让界面能指定目录等于给了一个任意 git 操作的入口。
   */
                   pluginDir = fileURLToPath(new URL('..', import.meta.url))
  /** 每个账号一个令牌桶（防上游风控）。 */
                   buckets = new Map                     ()
  /** 适配器上下文（每个 Agent 一份，缓存的持有者）。 */
                   contexts = new Map                        ()
  /** 模型列表的内存缓存。 */
                   modelCache = new MemoryCache()
  /** 正在进行的模型拉取（并发去重，避免 UI 连续点几次就打几次上游）。 */
                   modelInflight = new Map                              ()
  /** 状态防抖写入器：健康/额度/游标变化频繁，不能每次都同步写盘。 */
                   stateWriter                 
  /**
   * 挂着的设备码登录会话。
   *
   * ⚠️ **刻意不落盘、也不出宿主进程**：`device_code` 是能换出账号 token 的东西，
   * 它没有理由经过浏览器。服务重启后这些会话自然失效，用户重新点一次即可。
   */
                   loginSessions = new Map 
           
                                                                                                  
   ()
          disposed = false

  constructor(options                ) {
    this.config = options.config
    this.logger = createLogger('gateway', this.ring, options.dshLogger, options.config.verbose)
    this.ring.push({
      at: Date.now(),
      level: 'info',
      scope: 'gateway',
      message: '多 Agent 网关启动中',
      detail: `dataDir=${options.config.dataDir}`,
    })

    const state = readJsonSafe                (
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
    this.requestLog = new RequestLog(`${options.config.dataDir}/requests.jsonl`, {
      maxEntries: 2000,
      log: this.logger.child('requests'),
    })
    this.probePath = `${options.config.dataDir}/probes.json`
    this.probes = readJsonSafe                                  (this.probePath, {}, this.logger.child('probe'))
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
  agentConfig(agentId        ) {
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
      tasks: { enabled: false, intervalMinutes: 60, concurrency: 1, maxFailures: 3, retryDelaySec: 30, kinds: []            },
      upstream: { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '' },
      credits: { unit: 'credits'         , baselineUsdPerMTok: 1.2, round: 2 },
      requestTimeoutMs: 120_000,
      retry: { maxAttempts: 3, backoffMs: 500, maxBackoffMs: 8000 },
      rateLimitPerMinute: 60,
    }
  }

  /** 取（或建）适配器上下文。 */
  contextOf(agentId        )                             {
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) return undefined
    const existing = this.contexts.get(agentId)
    if (existing !== undefined) return existing
    const config = this.agentConfig(agentId)
    const ctx                 = {
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
  async loginStart(agentId        , label         )                                   {
    const adapter = this.registry.get(agentId)   
                         
                                                                      
                                                                         
          
                 
    const ctx = this.contextOf(agentId)
    if (adapter === undefined || ctx === undefined) throw new Error(`适配器未装载：${agentId}`)
    const defaultLabel = label !== undefined && label.trim() !== '' ? label.trim() : `${this.agentConfig(agentId).name} 账号`
    const loginId = `login-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    // ① 通用形态（浏览器打开链接 → 用户登录 → 用户点「刷新登录状态」问一次）
    if (typeof adapter.beginLogin === 'function') {
      const start = await adapter.beginLogin(ctx)
      this.loginSessions.set(loginId, {
        agentId,
        mode: 'generic',
        state: start.state,
        expiresAt: Date.now() + start.expiresInSec * 1000,
        label: defaultLabel,
        intervalSec: 0,
      }         )
      this.logger.info(`[${agentId}] 已生成登录链接`, `请打开 ${start.authUrl}`)
      return {
        loginId,
        authUrl: start.authUrl,
        ...(start.userCode === undefined ? {} : { userCode: start.userCode }),
        expiresInSec: start.expiresInSec,
      }
    }

    // ② 设备码形态（OpenCode）
    if (typeof adapter.startDeviceLogin !== 'function') {
      throw new Error(`「${adapter.name}」适配器没有实现登录`)
    }
    const start = (await adapter.startDeviceLogin(ctx))     
                        
                      
                             
                          
                         
     
    this.loginSessions.set(loginId, {
      agentId,
      deviceCode: start.deviceCode,
      expiresAt: Date.now() + start.expiresInSec * 1000,
      label: defaultLabel,
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

  /** 登录成功后的统一落盘：同名标签就换凭证，否则新建。 */
          persistLogin(
    agentId        ,
    label        ,
    credentials                    ,
  )                                              {
    let record                            = this.accounts.byAgent(agentId).find((item) => item.label === label)
    let created = false
    if (record === undefined) {
      record = this.accounts.add({ agentId, label, credentials })
      created = true
    } else {
      record = this.accounts.setCredentials(record.id, { ...record.credentials, ...credentials })
    }
    this.refreshSchedule()
    this.accounts.persistState()
    return { created, record }
  }

  /**
   * 轮询一次登录结果。
   *
   * 成功时**由宿主**创建 / 更新账号（token 不经过浏览器），返回脱敏后的账号记录。
   */
  async loginPoll(loginId        )                                   {
    const session = this.loginSessions.get(loginId)
    if (session === undefined) {
      return { status: 'expired', message: '这次登录会话不存在了（可能服务重启过），请重新发起' }
    }
    if (Date.now() > session.expiresAt) {
      this.loginSessions.delete(loginId)
      return { status: 'expired', message: '设备码已过期（10 分钟），请重新发起登录' }
    }
    const generic = session                                                                
    if (generic.mode === 'generic') {
      const genericAdapter = this.registry.get(session.agentId)   
                                                                                                            
                   
      const genericCtx = this.contextOf(session.agentId)
      if (genericAdapter === undefined || genericCtx === undefined || typeof genericAdapter.pollLogin !== 'function') {
        this.loginSessions.delete(loginId)
        return { status: 'failed', message: '适配器已卸载' }
      }
      let outcome                 
      try {
        outcome = await genericAdapter.pollLogin(generic.state, genericCtx)
      } catch (error) {
        return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
      if (outcome.status !== 'ready') {
        if (outcome.status === 'expired' || outcome.status === 'failed') this.loginSessions.delete(loginId)
        return { status: outcome.status, message: outcome.message ?? '' }
      }
      this.loginSessions.delete(loginId)
      const label = outcome.label !== undefined && outcome.label !== '' ? outcome.label : generic.label
      const { created, record } = this.persistLogin(session.agentId, label, outcome.credentials ?? { token: '' })
      this.logger.info(`${created ? '已登录并新增账号' : '已更新已有账号'}：${record.id}`)
      return {
        status: 'ready',
        message: created ? `登录成功，已新增账号「${label}」` : `登录成功，已更新账号「${label}」`,
        account: this.publicAccount(record),
      }
    }

    const adapter = this.registry.get(session.agentId)   
                                                                                                      
                 
    const ctx = this.contextOf(session.agentId)
    if (adapter === undefined || ctx === undefined || typeof adapter.pollDeviceLogin !== 'function') {
      this.loginSessions.delete(loginId)
      return { status: 'failed', message: '适配器已卸载' }
    }
    const outcome = (await adapter.pollDeviceLogin(session.deviceCode, ctx))     
                    
                     
                          
                           
                        
                    
                      
                          
     
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
    const credentials                     = {
      token: outcome.accessToken ?? '',
      ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
      ...(outcome.expiresAt === undefined ? {} : { expiresAt: outcome.expiresAt }),
      ...(outcome.orgId === undefined ? {} : { orgId: outcome.orgId }),
      ...(outcome.account === undefined ? {} : { account: outcome.account }),
      authKind: 'oauth-device',
    }
    const { created, record } = this.persistLogin(session.agentId, label, credentials)
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
  loginCancel(loginId        )          {
    return this.loginSessions.delete(loginId)
  }

  /** 当前挂着的登录会话数（诊断）。 */
  get pendingLogins()         {
    return this.loginSessions.size
  }

  /**
   * 该 Agent 是否要参与（注册表里有实现 + 已启用 + **这一期露出**）。
   *
   * `visible=false` 的平台（Qoder / Trae 等）与「用户关掉」效果一致：
   * 不注册 provider、不进模型选择器。区别只在于设置页也不显示它。
   */
  isAgentActive(agentId        )          {
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) return false
    const config = this.agentConfig(agentId)
    return config.enabled && config.visible
  }

  /** 全部「要上报给 DSH 模型选择器」的 Agent（**顺序就是分组顺序**）。 */
  exposedAgentIds()           {
    return this.registry
      .ids()
      .filter((agentId) => this.isAgentActive(agentId) && this.agentConfig(agentId).exposeModels)
  }

  /** 每个账号的令牌桶。 */
          bucketOf(accountId        )              {
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
  async awaitRateLimit(accountId        , signal              )                {
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
  async exposedModelsOf(agentId        , force = false)                       {
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
  async modelsOf(agentId        , force = false)                       {
    const cacheKey = `models:${agentId}`
    if (!force) {
      const cached = this.modelCache.get             (cacheKey)
      if (cached !== undefined) return cached
    }
    const inflight = this.modelInflight.get(cacheKey)
    if (inflight !== undefined && !force) return inflight

    const job = (async ()                       => {
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
        }                        )
      try {
        const list = await adapter.getModelMetaList(account, ctx)
        if (list.length > 0) {
          this.modelCache.set(cacheKey, list, MODELS_TTL_MS)
          this.accounts.cacheModels(
            agentId,
            list             ,
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
          return fallback               
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
  async allModels(force = false)                       {
    const out              = []
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
  start()       {
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
  reconfigure(next                )       {
    if (this.disposed) return
    this.config = next
    this.contexts.clear()
    this.buildPlan()
  }

  /** 只重建计划、不动 tick 循环（账号增删后调用）。 */
  refreshSchedule()       {
    if (this.disposed) return
    this.buildPlan()
  }

  /** 生成定时计划（清空后重建）。 */
          buildPlan()       {
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
              const check = await adapter.validateCredentials(account, this.contextOf(agentId)                  )
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
  dispose()       {
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
  async fetchQuota(account               )                         {
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
      const snapshot                = {
        accountId: account.id,
        unit: 'unknown',
        fetchedAt: Date.now(),
        error: `额度查询抛错：${message}`,
      }
      this.accounts.setQuota(snapshot)
      return snapshot
    }
  }

  /**
   * 刷新（某些/全部）账号的额度。
   *
   * 三条筛选语义，`accountId` **优先**：
   *   - `accountId` 给了 → 只刷这一个，且**刻意不看 `enabled`**：用户在界面上点名要刷它，
   *     停用账号也照刷（额度快照是事实，与「能不能参与对话路由」是两件事）；
   *     账号不存在 → 返回**空数组**，不抛错。
   *   - `agentId` 给了 → 该平台全部**启用**账号。
   *   - 都不给 → 全部平台的**启用**账号。
   *
   * ⚠️ 返回项的字段是**冻结契约**（客户端半边正按它渲染），只许加、不许改名或改形状：
   * `{ accountId, agentId, label, unit, remaining|null, total|null, used|null, unlimited, error|null, fetchedAt }`
   */
  async refreshQuotas(
    options                                           = {},
  )                                          {
    const targets =
      options.accountId !== undefined
        ? [this.accounts.get(options.accountId)].filter((item)                        => item !== undefined)
        : options.agentId !== undefined
          ? this.accounts.byAgent(options.agentId).filter((account) => account.enabled)
          : this.accounts.all().filter((account) => account.enabled)
    const out                                 = []
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
  async runCheckIn(options                                                           )                     {
    const targets =
      options.accountId !== undefined
        ? [this.accounts.get(options.accountId)].filter((item)                        => item !== undefined)
        : options.agentId !== undefined
          ? this.accounts.byAgent(options.agentId).filter((account) => account.enabled)
          : this.accounts.all().filter((account) => account.enabled)
    const out            = []
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
        // 界面上要把「等一会儿就好」与「你得先去别处操作」分开显示 ——
        // 前者重试即可，后者一直重试也没用（见 CheckInResult.actionRequired）。
        actionRequired: outcome.actionRequired,
        // 「看到的是刷新前那一轮」时今天并未真正记账，界面要说清它会稍后重试，
        // 否则用户以为「已签到」而实际上什么都没领到。
        coversToday: outcome.coversToday,
        recorded: outcome.recorded,
      })
    }
    return out
  }

  /** 列出可做任务（不执行）。 */
  async listTasks(agentId         )                     {
    const out            = []
    const targets = agentId === undefined ? this.registry.ids() : [agentId]
    for (const id of targets) {
      const adapter = this.registry.get(id)
      if (adapter === undefined || !adapter.capabilities.tasks) continue
      const accounts = this.accounts.byAgent(id).filter((account) => account.enabled)
      for (const account of accounts) {
        const ctx = this.contextOf(id)
        if (ctx === undefined) continue
        let items               = []
        let error                    
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
  async runTasks(options                                          )                   {
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
    const merged = { accounts: 0, attempted: 0, succeeded: 0, credits: 0, details: []                                                  }
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
  resumeTasks(accountId        )          {
    return this.tasks.resume(accountId)
  }

  /** 任务流水。 */
  taskLog(count = 40)            {
    return redactDeep(this.tasks.recent(count))             
  }

  // ───────────────────────── 请求日志 / 模型探测 ─────────────────────────

  /** 分页读请求日志（新的在前）。 */
  requestLogPage(options                                      = {})                                        {
    const page = this.requestLog.list(options)
    return { total: page.total, entries: redactDeep(page.entries)              }
  }

  /** 请求汇总（总览页 KPI）。 */
  requestSummary()                 {
    return this.requestLog.summary()
  }

  /** 清空请求日志。 */
  clearRequestLog()                  {
    this.requestLog.clear()
    return { ok: true }
  }

  // ───────────────────────── 版本更新 ─────────────────────────

  /** 检查有没有新版本（只读；不动工作区）。 */
  async updateStatus()                        {
    return checkUpdate(this.pluginDir)
  }

  /**
   * 一键更新（`git pull --ff-only`）。
   *
   * 成功后**必须重启 DSH** 才生效：宿主在启动时加载 `lib/`，换掉磁盘上的文件
   * 不会让已经加载的模块重新执行。
   */
  async updateApply()                                                       {
    const result = await applyUpdate(this.pluginDir)
    if (result.ok && result.from !== result.to) {
      this.ring.push({
        at: Date.now(),
        level: 'info',
        scope: 'update',
        message: `插件已更新：${result.from} → ${result.to}`,
        detail: '需要重启 DSH 才生效',
      })
    }
    return { ...result, restartRequired: result.ok && result.from !== result.to }
  }

  /** 某个模型的探测结论（没有就是 undefined）。 */
  probeOf(modelId        )                               {
    return this.probes[modelId]
  }

  /** 全部探测结论的只读快照。 */
  probeSnapshot()                                             {
    return this.probes
  }

  /**
   * 对某个 Agent 的模型跑一轮可用性探测。
   *
   * 每个模型发一次**极小**的真实请求（8 token、不带工具），只等首帧。
   * 结论按模型缓存到 `probes.json`，界面上标成徽章。
   *
   * `ids` 省略 = 探测该 Agent 当前上报的全部模型。
   */
  async probeModels(agentId        , options                                      = {})           
               
                  
                               
                  
     {
    if (this.probing) return { ok: false, probed: 0, results: [], error: '已有一轮探测在进行中' }
    const adapter = this.registry.get(agentId)
    if (adapter === undefined) return { ok: false, probed: 0, results: [], error: `没有 ${agentId} 的适配器` }

    // 用哪个账号探？和 `modelsOf` 同一套规则：
    //   1. 参与路由的账号；
    //   2. 全都降权了就用降权的那个（探测本来就是「试试看」）；
    //   3. **一个账号都没有时用匿名占位** —— OpenCode 是免账号通道，
    //      没账号也能直接调免费模型，早期这里直接 return「没有可用账号」，
    //      表现就是「点『测一次』什么都不发生」。匿名占位会被适配器按
    //      `freeTierMode` 自动补上免费层头。
    const { usable, penalized } = this.router.candidates(agentId)
    const fallbackRecord = {
      id: `${agentId}:anonymous`,
      agentId,
      label: '(未配置账号)',
      credentials: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    }                        
    const record = usable[0] ?? penalized[0] ?? fallbackRecord

    const all = await this.modelsOf(agentId, options.force === true)
    const wanted = options.ids === undefined ? all.map((meta) => meta.id) : options.ids
    const known = new Set(all.map((meta) => meta.id))
    const ids = wanted.filter((id) => known.has(id))
    if (ids.length === 0) return { ok: true, probed: 0, results: [] }

    const context = this.contextOf(agentId)
    this.probing = true
    try {
      const results = await runProbeBatch(ids, (modelId) => this.attemptProbe(adapter, record, context, modelId), {
        concurrency: PROBE_DEFAULTS.concurrency,
      })
      this.probes = mergeProbeCache(this.probes, results)
      try {
        writeJsonAtomic(this.probePath, this.probes)
      } catch (error) {
        this.logger.warn('探测结果落盘失败', error instanceof Error ? error.message : String(error))
      }
      this.ring.push({
        at: Date.now(),
        level: 'info',
        scope: 'probe',
        message: `${this.agentConfig(agentId).name} 模型探测完成`,
        detail: results.map((item) => `${item.modelId}=${item.status}`).join(' '),
      })
      return { ok: true, probed: results.length, results }
    } finally {
      this.probing = false
    }
  }

  /**
   * 探测单个模型：发一个 8 token 的流式请求，等到第一段内容或 finish 就收手。
   *
   * 只等首帧而不是等整段生成 —— 探测要回答的是「这个模型对本地放不放行」，
   * 不是「它写得好不好」。
   */
          async attemptProbe(
    adapter              ,
    record               ,
    context                ,
    modelId        ,
  )                        {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_DEFAULTS.timeoutMs)
    const started = Date.now()
    let ttftMs                    
    const payload              = {
      model: modelId,
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      max_tokens: 8,
    }
    try {
      for await (const event of adapter.requestChatStream(payload, record, context, controller.signal)                              ) {
        if (event.type === 'text' || event.type === 'reasoning' || event.type === 'tool_call') {
          if (ttftMs === undefined) ttftMs = Date.now() - started
          break
        }
        if (event.type === 'error') {
          const failure = event.failure
          const status = typeof failure.status === 'number' ? failure.status : undefined
          return { status, text: failure.message ?? '', error: failure.message, ...(ttftMs === undefined ? {} : { ttftMs }) }
        }
        if (event.type === 'finish') break
      }
      // 走到这里说明拿到过内容（或上游正常收尾）—— 只要没抛错就算放行
      return { status: 200, text: 'ok', ...(ttftMs === undefined ? {} : { ttftMs }) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 超时是 abort 触发的，归到「网络层没答复」而不是模型坏了
      return { error: message }
    } finally {
      clearTimeout(timer)
    }
  }

  // ───────────────────────── 账号（写操作） ─────────────────────────

  /** 新增账号（返回脱敏对象）。 */
  addAccount(draft              )                          {
    const record = this.accounts.add(draft)
    this.refreshSchedule()
    return this.publicAccount(record)
  }

  /** 改账号。 */
  updateAccount(id        , patch              )                          {
    const record = this.accounts.update(id, patch)
    this.refreshSchedule()
    return this.publicAccount(record)
  }

  /** 删账号。 */
  removeAccount(id        )          {
    const ok = this.accounts.remove(id)
    if (ok) this.refreshSchedule()
    return ok
  }

  /** 换凭证。 */
  setCredentials(id        , credentials                    )                          {
    const record = this.accounts.setCredentials(id, credentials)
    return this.publicAccount(record)
  }

  /** 测活（真实打一次上游）。 */
  async testAccount(id        )                   {
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
  publicAccount(record               )                          {
    const redacted = redactDeep(record)                           
    const credentials = record.credentials
    const hasRefresh = typeof credentials.refreshToken === 'string' && credentials.refreshToken !== ''
    return {
      ...redacted,
      /**
       * ⚠️ 三个开关返回的是**生效值**，不是「磁盘上存了什么」。
       *
       * 存 `undefined` 时的真实语义：
       *   - `routeChat`：参与对话路由（`accounts.routable` 判的是 `!== false`）；
       *   - `autoCheckIn` / `autoTasks`：跟随 Agent 级配置。
       *
       * 早期这里直接把 `undefined` 传出去，界面把「没存过」画成「关」——
       * 界面和真实行为**正好相反**，用户点一下反而把本来是开的东西关掉。
       * 真机踩到的完整链路：刚登录的 Qoder CN 账号「对话」显示关 → 用户点两下
       * 真的关上了 → 对话报「没有可用账号」→ DSH 显示成「API 密钥无效」。
       */
      routeChat: record.routeChat !== false,
      autoCheckIn: this.tasks.checkInEnabledFor(record),
      autoTasks: this.tasks.enabledFor(record),
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

  snapshotAccounts(agentId         )            {
    const source = agentId === undefined ? this.accounts.all() : this.accounts.byAgent(agentId)
    return source.map((record) => this.publicAccount(record))
  }

  snapshotQuotas(agentId         )            {
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

  snapshotRouting(agentId         )          {
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

  snapshotTasks(agentId         )            {
    return this.tasks.snapshot(agentId).map((item) => ({ ...(redactDeep(item)          ) }))
  }

  snapshotSchedule()            {
    return this.scheduler.snapshot()
  }

  snapshotLogs(count = 120)            {
    return redactDeep(this.ring.tail(count))             
  }

  /**
   * UI 的**主快照**：一次调用拿全，避免页面上十几次来回。
   */
  snapshotState()          {
    const routing = this.snapshotRouting()     
                                                                       
     
    const degraded = routing.agents
      .flatMap((item) => item.accounts)
      .filter((item) => item.health.state !== 'ok').length
    const agents = this.registry.ids().map((agentId) => {
      const adapter = this.registry.get(agentId)
      const config = this.agentConfig(agentId)
      return {
        agentId,
        name: config.name,
        implemented: adapter !== undefined && (adapter                                            ).implemented === true,
        enabled: this.isAgentActive(agentId),
        /** 这一期是否露出（隐藏的平台设置页不显示）。 */
        visible: config.visible,
        exposeModels: config.exposeModels,
        labelWithAgent: config.labelWithAgent,
        capabilities: adapter?.capabilities ?? null,
        accounts: this.accounts.byAgent(agentId).map((record) => this.publicAccount(record)),
        quotas: this.snapshotQuotas(agentId),
        tasks: this.snapshotTasks(agentId),
        jobCount: this.scheduler.snapshot().filter((job) => job.key.endsWith(`:${agentId}`) || job.key.includes(`:${agentId}:`)).length,
        modelCount: (() => {
          const cached = this.modelCache.get             (`models:${agentId}`)
          return cached === undefined ? null : cached.length
        })(),
        /**
         * **实际会进 DSH 选择器**的模型数（= 上游拉回来的 ∩ 上报策略）。
         *
         * 与 `modelCount` 分开是有意的：拉回来 85 个但只上报 2 个时，界面上
         * 「进选择器的模型」必须显示 2 —— 早期两个地方都读 `modelCount`，
         * 于是用户看到「22 个模型进选择器」，而下拉里空空如也。
         */
        exposedCount: (() => {
          if (config.exposeModels !== true) return 0
          const cached = this.modelCache.get             (`models:${agentId}`)
          return cached === undefined ? null : selectExposedModels(cached, config.models).length
        })(),
        docs: adapter !== undefined && 'doc' in adapter ? (adapter                    ).doc ?? null : null,
        credentialHint:
          adapter !== undefined && 'credentialHint' in adapter
            ? (adapter                               ).credentialHint ?? null
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
        requests: `${this.config.dataDir}/requests.jsonl`,
        probes: this.probePath,
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
  async tick()                     {
    const results = await this.scheduler.runOnce()
    this.accounts.persistState()
    return results
  }

  /** 立刻跑一轮降权恢复检测。 */
  async recoverNow()                   {
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
  resetHealth(accountId        )          {
    if (this.accounts.get(accountId) === undefined) return false
    this.accounts.resetHealth(accountId)
    return true
  }

  /** 清空任务流水。 */
  clearTaskLog()          {
    this.tasks.clearLog()
    return true
  }

  /** 给测试用的健康初始化。 */
  static freshHealth = freshHealth
}


//# sourceURL=src/runtime.ts