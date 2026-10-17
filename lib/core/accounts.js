/**
 * 账号管理：多账号的增删改查、凭证加密落盘、健康状态与额度缓存。
 *
 * 「单 Agent 支持多账号，同一个 Agent 下可添加 N 个账号，独立保存凭证
 * （token/bearer/cookie 等）」这条要求的实现就在这里。
 *
 * 三层数据，职责严格分开：
 *
 *   | 数据 | 存哪 | 丢了会怎样 |
 *   |---|---|---|
 *   | `AccountRecord`（含凭证） | `accounts.enc.json`（整份加密） | **要重新录账号** |
 *   | `AccountHealth` | `state.json`（明文，无敏感信息） | 重算（一开始全是 ok） |
 *   | `QuotaSnapshot` | `state.json` | 下次定时拉取就回来 |
 *
 * 关键不变式：
 *   1. `credentials` **只在内存里是明文**；任何落盘路径都过 `vault.seal`。
 *   2. 任何对外（Remote / 日志 / 工具结果）的返回都过 `redactDeep`。
 *   3. 同一个 Agent 下的 `label` 唯一 —— 否则 UI 上两个「账号1」没法区分。
 */

import { CredentialVault, redactDeep } from './crypto.js'
import { readJsonSafe, writeJsonAtomic } from './store.js'
                                                                                                         

/** 落盘信封：`{ v, accounts: CipherEnvelope }`。 */
                        
           
                   
                                               
 

/** 持久化的非敏感状态（`state.json`）。 */
                                 
           
                   
                           
                                       
                           
                                      
                                
                                                                                   
                                           
                                   
                                      
                                  
 

/** 新建账号时的入参。 */
                               
                 
               
                                 
                   
                       
                     
                     
               
 

/** 可更新字段（凭证单独走 `setCredentials`，避免误清空）。 */
                               
                
                   
                       
                     
                     
               
 

/** id 里的 slug 化：只留 `[a-z0-9-_]`，避免 id 里出现奇怪字符。 */
function slugify(text        )         {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (normalized === '') return 'account'
  // 纯中文 label 的 slug 化结果可能很长，截断一下。
  return normalized.slice(0, 32)
}

/** 健康状态的初始值。 */
export function freshHealth(accountId        )                {
  return { accountId, state: 'ok', failures: 0, penaltyUntil: 0, weight: 0 }
}

export class AccountManager {
                   dir        
                   log        
                   vault                 
                   accountsFile        
                   stateFile        
          accounts                  = []
          state                
          dirty = false
  /** 状态变脏时的回调（runtime 用它挂防抖写盘）。 */
          onDirty                      = null

  constructor(dir        , log        , state                ) {
    this.dir = dir
    this.log = log
    this.vault = new CredentialVault(dir)
    this.accountsFile = `${dir}/accounts.enc.json`
    this.stateFile = `${dir}/state.json`
    this.state = state
  }

  /** 从磁盘装载账号。失败不抛（插件要能起得来），但会记 error。 */
  load()                                                 {
    let raw                          
    try {
      raw = readJsonSafe                          (this.accountsFile, undefined, this.log)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, count: 0, error: `账号文件读取失败：${message}` }
    }
    if (raw === undefined) {
      this.accounts = []
      return { ok: true, count: 0 }
    }
    try {
      const decoded = this.vault.open                 (raw.envelope)
      this.accounts = Array.isArray(decoded) ? decoded : []
      this.log.info(`已装载 ${this.accounts.length} 个账号`, `来自 ${this.accountsFile}`)
      return { ok: true, count: this.accounts.length }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log.error(
        '账号文件解密失败 —— 主密钥（.master-key）与密文不匹配或被篡改，账号需要重新录入',
        message,
      )
      this.accounts = []
      return { ok: false, count: 0, error: `账号文件解密失败：${message}` }
    }
  }

  /** 立刻落盘账号（加密）。 */
          persistAccounts()       {
    const payload               = {
      v: 1,
      updatedAt: Date.now(),
      envelope: this.vault.seal(this.accounts),
    }
    writeJsonAtomic(this.accountsFile, payload)
  }

  /** 状态（非敏感）落盘。 */
  persistState()       {
    this.state.updatedAt = Date.now()
    writeJsonAtomic(this.stateFile, this.state)
    this.dirty = false
  }

  /** 状态文件路径（诊断用）。 */
  get statePath()         {
    return this.stateFile
  }

  /** 账号文件路径（诊断用）。 */
  get accountsPath()         {
    return this.accountsFile
  }

  /** 主密钥文件路径（诊断用）。 */
  get keyPath()         {
    return this.vault.keyFilePath
  }

  /** 是否有未落盘的状态。 */
  get hasPendingState()          {
    return this.dirty
  }

  /**
   * 标记状态需要在下一轮落盘。
   *
   * ⚠️ 只标记**不够** —— 必须有人真的写。`GatewayRuntime` 在构造时挂一个
   * 防抖写入器（`setDirtyHook`），否则「健康状态 / 额度 / 路由游标」会在
   * DSH 重启后全部丢掉（而它们恰恰是路由决策的输入）。
   */
  touchState()       {
    this.dirty = true
    this.onDirty?.()
  }

  /** 挂一个「状态变脏」的回调（只能挂一个，后挂的覆盖先挂的）。 */
  setDirtyHook(hook                     )       {
    this.onDirty = hook
  }

  /** 当前状态的只读快照（写入器用它落盘）。 */
  stateSnapshot()                 {
    return this.state
  }

  // ───────────────────────── 查询 ─────────────────────────

  /** 全部账号（**明文凭证**，只在宿主侧用；对外一定要过 `publicAccounts()`）。 */
  all()                  {
    return this.accounts
  }

  /** 某个 Agent 下的账号。 */
  byAgent(agentId        )                  {
    return this.accounts.filter((account) => account.agentId === agentId)
  }

  /** 按 id 取一个。 */
  get(id        )                            {
    return this.accounts.find((account) => account.id === id)
  }

  /**
   * 参与对话路由的候选账号。
   *
   * 三道门：账号本身 `enabled`、`routeChat !== false`、Agent 在配置里启用。
   * 后面还有一道「健康度」由路由器判。
   */
  routable(agentId        )                  {
    return this.accounts.filter(
      (account) => account.agentId === agentId && account.enabled && account.routeChat !== false,
    )
  }

  /** 脱敏后的账号清单（Remote / 工具结果用）。 */
  publicAccounts(agentId         )                                 {
    const source = agentId === undefined ? this.accounts : this.byAgent(agentId)
    return source.map((account) => ({
      ...(redactDeep(account)                           ),
      health: this.health(account.id),
      quota: this.quota(account.id),
    }))
  }

  // ───────────────────────── 增删改 ─────────────────────────

  /** 新增账号。label 在同一个 Agent 下重复会抛错（UI 上分不清是灾难）。 */
  add(draft              )                {
    const label = draft.label.trim()
    if (label === '') throw new Error('账号标签不能为空')
    if (this.byAgent(draft.agentId).some((account) => account.label === label)) {
      throw new Error(`「${draft.agentId}」下已经有叫「${label}」的账号了，换个名字`)
    }
    const digest = this.uniqueId(draft.agentId, label)
    const now = Date.now()
    const record                = {
      id: digest,
      agentId: draft.agentId,
      label,
      credentials: { ...draft.credentials },
      enabled: draft.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }
    if (draft.autoCheckIn !== undefined) record.autoCheckIn = draft.autoCheckIn
    if (draft.autoTasks !== undefined) record.autoTasks = draft.autoTasks
    if (draft.routeChat !== undefined) record.routeChat = draft.routeChat
    if (draft.note !== undefined && draft.note !== '') record.note = draft.note
    this.accounts.push(record)
    this.state.health[record.id] = freshHealth(record.id)
    this.persistAccounts()
    this.persistState()
    this.log.info(`新增账号 ${record.id}`, `agent=${record.agentId} label=${label}`)
    return record
  }

          uniqueId(agentId        , label        )         {
    const base = `${agentId}:${slugify(label)}`
    if (this.get(base) === undefined) return base
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${base}-${index}`
      if (this.get(candidate) === undefined) return candidate
    }
    throw new Error(`无法为「${label}」生成唯一 id（同名账号太多了）`)
  }

  /** 更新非凭证字段。 */
  update(id        , patch              )                {
    const record = this.get(id)
    if (record === undefined) throw new Error(`账号不存在：${id}`)
    if (patch.label !== undefined) {
      const label = patch.label.trim()
      if (label === '') throw new Error('账号标签不能为空')
      const clash = this.byAgent(record.agentId).some(
        (account) => account.id !== id && account.label === label,
      )
      if (clash) throw new Error(`「${record.agentId}」下已经有叫「${label}」的账号了`)
      record.label = label
    }
    if (patch.enabled !== undefined) record.enabled = patch.enabled
    if (patch.autoCheckIn !== undefined) record.autoCheckIn = patch.autoCheckIn
    if (patch.autoTasks !== undefined) record.autoTasks = patch.autoTasks
    if (patch.routeChat !== undefined) record.routeChat = patch.routeChat
    if (patch.note !== undefined) record.note = patch.note
    record.updatedAt = Date.now()
    this.persistAccounts()
    return record
  }

  /** 换凭证（保留 id / label / 开关）。 */
  setCredentials(id        , credentials                    )                {
    const record = this.get(id)
    if (record === undefined) throw new Error(`账号不存在：${id}`)
    record.credentials = { ...credentials }
    record.updatedAt = Date.now()
    // 换了凭证 = 之前的失效判断作废，重置健康。
    this.state.health[id] = freshHealth(id)
    this.persistAccounts()
    this.persistState()
    this.log.info(`账号 ${id} 的凭证已更新，健康状态已重置`)
    return record
  }

  /** 删除账号，连带清掉它的健康与额度缓存。 */
  remove(id        )          {
    const index = this.accounts.findIndex((account) => account.id === id)
    if (index < 0) return false
    this.accounts.splice(index, 1)
    delete this.state.health[id]
    delete this.state.quota[id]
    this.persistAccounts()
    this.persistState()
    this.log.info(`账号已删除：${id}`)
    return true
  }

  // ───────────────────────── 健康 ─────────────────────────

  /** 取健康状态（缺失则就地建一个）。 */
  health(accountId        )                {
    const existing = this.state.health[accountId]
    if (existing !== undefined) return existing
    const fresh = freshHealth(accountId)
    this.state.health[accountId] = fresh
    return fresh
  }

  /** 记一次成功：清零失败计数、解除降权。 */
  markOk(accountId        , now = Date.now())       {
    const health = this.health(accountId)
    health.state = 'ok'
    health.failures = 0
    health.penaltyUntil = 0
    health.weight = 0
    health.lastOkAt = now
    health.lastAttemptAt = now
    delete health.lastError
    this.touchState()
  }

  /**
   * 记一次失败。
   *
   * @param degradeAfter - 连续失败几次开始降权。
   * @param penaltyMs - 降权时长。
   */
  markFailure(
    accountId        ,
    error                            ,
    degradeAfter        ,
    penaltyMs        ,
    now = Date.now(),
  )       {
    const health = this.health(accountId)
    health.failures += 1
    health.lastAttemptAt = now
    if (error !== undefined) health.lastError = error
    if (health.failures >= degradeAfter) {
      health.state = 'degraded'
      health.penaltyUntil = now + penaltyMs
      // 权重随时间线性衰减到 1；越新的失败排得越后。
      health.weight = Math.min(10, health.failures)
    }
    this.touchState()
  }

  /** 降权到期自动恢复成可用（**自动恢复检测**的第一半）。 */
  recoverExpired(now = Date.now())           {
    const recovered           = []
    for (const health of Object.values(this.state.health)) {
      if (health.penaltyUntil !== 0 && health.penaltyUntil <= now) {
        health.penaltyUntil = 0
        health.weight = Math.max(0, health.weight - 1)
        health.state = health.failures >= 3 ? 'degraded' : 'ok'
        recovered.push(health.accountId)
      }
    }
    if (recovered.length > 0) this.touchState()
    return recovered
  }

  /** 该账号当前可不可用（不在降权窗口里）。 */
  available(accountId        , now = Date.now())          {
    const health = this.state.health[accountId]
    if (health === undefined) return true
    if (health.state === 'invalid') return false
    return health.penaltyUntil === 0 || health.penaltyUntil <= now
  }

  /** 永久判死（例如上游明确说这个号被封了）。 */
  markInvalid(accountId        , error                             )       {
    const health = this.health(accountId)
    health.state = 'invalid'
    health.weight = 99
    if (error !== undefined) health.lastError = error
    this.touchState()
  }

  /** 手工重置某个账号的健康（UI 上的「恢复」按钮）。 */
  resetHealth(accountId        )                {
    const fresh = freshHealth(accountId)
    this.state.health[accountId] = fresh
    this.touchState()
    this.persistState()
    return fresh
  }

  // ───────────────────────── 额度 ─────────────────────────

  /** 取额度快照（没有就是 undefined，UI 要显示「未拉取」而不是 0）。 */
  quota(accountId        )                            {
    return this.state.quota[accountId]
  }

  /** 全部额度快照。 */
  quotas()                                {
    return this.state.quota
  }

  /** 写入额度快照。 */
  setQuota(snapshot               )       {
    this.state.quota[snapshot.accountId] = snapshot
    this.touchState()
  }

  // ───────────────────────── 其它持久状态 ─────────────────────────

  /** 路由游标（轮询策略用）。 */
  cursor(key        )         {
    return this.state.cursors?.[key] ?? 0
  }

  setCursor(key        , value        )       {
    this.state.cursors = this.state.cursors ?? {}
    this.state.cursors[key] = value
    this.touchState()
  }

  /** 某个定时任务上次执行时间。 */
  lastRun(key        )         {
    return this.state.schedule?.[key] ?? 0
  }

  setLastRun(key        , at        )       {
    this.state.schedule = this.state.schedule ?? {}
    this.state.schedule[key] = at
    this.touchState()
  }

  /** 模型缓存读。 */
  cachedModels(agentId        )                        {
    return this.state.models?.[agentId]?.items
  }

  /** 模型缓存写。 */
  cacheModels(agentId        , items           , source         )       {
    this.state.models = this.state.models ?? {}
    this.state.models[agentId] = { fetchedAt: Date.now(), items, ...(source === undefined ? {} : { source }) }
    this.touchState()
  }

  /** 模型缓存的时间戳。 */
  modelsFetchedAt(agentId        )         {
    return this.state.models?.[agentId]?.fetchedAt ?? 0
  }
}


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\core\accounts.ts