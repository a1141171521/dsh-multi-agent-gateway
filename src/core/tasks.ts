/**
 * 统一活动任务引擎。
 *
 * 「每个 Agent 适配器独立实现自己的活动任务逻辑，由核心定时调度器统一管理」
 * 这条要求的落点：**调度、并发、重试、记账、熔断全在这里，适配器只负责
 * 拉列表 / 执行 / 查状态三个纯函数。**
 *
 * 与「基础每日签到」的分工（任务书明确要求区分两个独立模块）：
 *
 *   | 维度 | 每日签到 | 活动任务 |
 *   |---|---|---|
 *   | 时机 | 每天固定一次 | 按间隔反复跑 |
 *   | 开关 | 账号/Agent 的 `checkIn.enabled` | 账号/Agent 的 `tasks.enabled` |
 *   | 幂等键 | `<agentId>:<accountId>:checkin:<yyyy-mm-dd>` | 同左，日期 + 任务 id |
 *   | 记录 | `check-in` 类型 | `task` 类型，带 credits |
 *
 * ⚠️ 幂等键里的 `<yyyy-mm-dd>` 是**服务端业务日（UTC+8）**，不是 UTC 日
 * （见 `time.ts` 的文件头：两者在每天 00:00–08:00（UTC+8）之间不是同一天，
 * 用 UTC 日会让跨零点变成两次领取）。
 *
 * 幂等键落盘在 `state.json` 的 `schedule` 表里（借 `setLastRun`/`getLastRun`），
 * 所以 **DSH 重启不会把今天的签到漏掉，也不会重复领**。
 */

import type {
  AccountRecord,
  AdapterContext,
  AgentAdapter,
  ErrorKind,
  Logger,
  ResolvedScheduleConfig,
  ResolvedTasksConfig,
  TaskRecord,
  TaskResult,
} from './types.js'
import { AccountManager } from './accounts.js'
import { JsonlLog } from './store.js'
import { Semaphore, sleep } from './cache.js'
import { utc8DateString } from './time.js'

/** 一条任务执行流水（落 JSONL，UI 也能读）。 */
export interface TaskLogRecord {
  at: number
  agentId: string
  accountId: string
  accountLabel: string
  taskId: string
  taskTitle: string
  kind: TaskRecord['kind']
  ok: boolean
  credits?: number
  message?: string
  errorKind?: ErrorKind
  attempt: number
}

/** 某个账号的活动任务状态（UI 面板）。 */
export interface AccountTaskStatus {
  accountId: string
  label: string
  enabled: boolean
  /** 最近一次任务执行。 */
  lastRun?: number
  /** 最近一次结论。 */
  lastMessage?: string
  ok: boolean
  creditsTotal: number
  /** 连续失败次数；达到上限会暂停该账号的自动任务。 */
  failures: number
  paused: boolean
  pausedReason?: string
}

/** 引擎依赖。 */
export interface TaskEngineDeps {
  accounts: AccountManager
  log: Logger
  /** 取适配器。 */
  adapterOf(agentId: string): AgentAdapter | undefined
  /** 取适配器运行上下文。 */
  contextOf(agentId: string): AdapterContext | undefined
  /** 取该 Agent 的任务配置。 */
  tasksConfigOf(agentId: string): ResolvedTasksConfig
  /** 取该 Agent 的签到配置（与活动任务是两套开关）。 */
  checkInConfigOf(agentId: string): ResolvedScheduleConfig
  /** 任务流水（落盘）。 */
  logStore: JsonlLog
  now?(): number
}

/**
 * 一天一次的签到幂等键。
 *
 * ⚠️ 日期取**服务端业务日（UTC+8）**，不是 `toISOString()` 的 UTC 日。
 * 两者在每天 00:00–08:00（UTC+8）之间**不是同一天**，用 UTC 日会得到两个不同的键，
 * 后果是**跨零点重复领取**（00:00 和 08:01 各签一次）——这正是上游风控最敏感的行为。
 * 详见 `time.ts` 的文件头。
 */
export function checkInKey(agentId: string, accountId: string, at: number): string {
  return `checkin:${agentId}:${accountId}:${utc8DateString(at)}`
}

/** 任务幂等键：同一天内同一个任务只领一次。日期口径同 {@link checkInKey}。 */
export function taskKey(agentId: string, accountId: string, taskId: string, at: number): string {
  return `task:${agentId}:${accountId}:${taskId}:${utc8DateString(at)}`
}

export class TaskEngine {
  private readonly deps: TaskEngineDeps
  private readonly now: () => number
  /** 每个账号的活动任务运行状态（进程内）。 */
  private readonly states = new Map<string, AccountTaskStatus>()
  private readonly semaphore: Semaphore

  constructor(deps: TaskEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    // 并发上限取所有 Agent 里最大的那个；批处理时还会按 Agent 的 concurrency 分批收。
    this.semaphore = new Semaphore(this.maxConcurrency())
  }

  private maxConcurrency(): number {
    let max = 1
    for (const account of this.deps.accounts.all()) {
      const config = this.deps.tasksConfigOf(account.agentId)
      if (config.concurrency > max) max = config.concurrency
    }
    return max
  }

  /** 某个账号是否开了自动任务（账号级覆盖 > Agent 级）。 */
  enabledFor(account: AccountRecord): boolean {
    if (account.autoTasks !== undefined) return account.autoTasks
    return this.deps.tasksConfigOf(account.agentId).enabled
  }

  /**
   * 某个账号是否开了自动签到（账号级覆盖 > Agent 级）。
   *
   * ⚠️ 这里**只看开关**，不看适配器能力 —— 上游没有签到接口时由
   * `checkIn()` 返回 `supported: false`，那是「不是故障的结论」，
   * 不该在开关层面被悄悄吞掉（否则用户永远不知道为什么没签到）。
   */
  checkInEnabledFor(account: AccountRecord): boolean {
    if (account.autoCheckIn !== undefined) return account.autoCheckIn
    return this.deps.checkInConfigOf(account.agentId).enabled
  }

  /** 取（或建）账号状态。 */
  private state(account: AccountRecord): AccountTaskStatus {
    const existing = this.states.get(account.id)
    if (existing !== undefined) return existing
    const fresh: AccountTaskStatus = {
      accountId: account.id,
      label: account.label,
      enabled: this.enabledFor(account),
      ok: true,
      creditsTotal: 0,
      failures: 0,
      paused: false,
    }
    this.states.set(account.id, fresh)
    return fresh
  }

  /** 全部账号的任务状态（UI）。 */
  snapshot(agentId?: string): AccountTaskStatus[] {
    const source = agentId === undefined ? this.deps.accounts.all() : this.deps.accounts.byAgent(agentId)
    return source.map((account) => ({ ...this.state(account), enabled: this.enabledFor(account) }))
  }

  /** 清掉某个账号的暂停（UI 的「恢复」按钮）。 */
  resume(accountId: string): boolean {
    const state = this.states.get(accountId)
    if (state === undefined) return false
    state.paused = false
    state.failures = 0
    state.pausedReason = undefined
    return true
  }

  /** 最近的任务流水（UI）。 */
  recent(count = 60): TaskLogRecord[] {
    return this.deps.logStore.tail(count).filter((item): item is TaskLogRecord => {
      return typeof item === 'object' && item !== null && 'taskId' in item
    })
  }

  /** 清空任务记录。 */
  clearLog(): void {
    this.deps.logStore.reset()
  }

  // ─────────────────────── 单个账号的一轮 ───────────────────────

  /**
   * 跑一个账号的活动任务。
   *
   * 流程：拉列表 → 过滤今天已领过的 → 逐个执行（带重试）→ 记账。
   * 连续失败达到 `maxFailures` 会把**该账号**的自动任务临时暂停（任务书要求）。
   */
  async runForAccount(account: AccountRecord, signal?: AbortSignal): Promise<{
    attempted: number
    succeeded: number
    credits: number
    message: string
  }> {
    const adapter = this.deps.adapterOf(account.agentId)
    const ctx = this.deps.contextOf(account.agentId)
    if (adapter === undefined || ctx === undefined || !adapter.capabilities.tasks) {
      return { attempted: 0, succeeded: 0, credits: 0, message: '该 Agent 未实现活动任务，跳过' }
    }
    const state = this.state(account)
    if (state.paused) {
      return { attempted: 0, succeeded: 0, credits: 0, message: state.pausedReason ?? '该账号的自动任务处于暂停中' }
    }
    if (!this.enabledFor(account)) {
      return { attempted: 0, succeeded: 0, credits: 0, message: '该账号未开启自动任务' }
    }

    const at = this.now()
    let tasks: TaskRecord[]
    try {
      tasks = await adapter.fetchAvailableTasks(account, ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.failures += 1
      state.ok = false
      state.lastMessage = `拉取任务失败：${message}`
      state.lastRun = at
      this.record(account, { id: '(fetch)', title: '拉取任务列表', kind: 'activity' }, false, 0, message, 'unknown', 1, at)
      this.maybePause(account, state)
      return { attempted: 0, succeeded: 0, credits: 0, message: state.lastMessage }
    }

    const kinds = this.deps.tasksConfigOf(account.agentId).kinds
    const filtered = tasks.filter((task) => kinds.length === 0 || kinds.includes(task.kind))
    // 今天已经领过的直接跳过 —— 幂等，不重复领。
    const pending = filtered.filter((task) => this.deps.accounts.lastRun(taskKey(account.agentId, account.id, task.id, at)) === 0)

    let succeeded = 0
    let credits = 0
    let attempted = 0
    for (const task of pending) {
      if (signal?.aborted === true) break
      attempted += 1
      const outcome = await this.runOne(adapter, ctx, account, task, signal)
      if (outcome.ok) {
        succeeded += 1
        credits += outcome.credits ?? 0
        this.deps.accounts.setLastRun(taskKey(account.agentId, account.id, task.id, at), at)
      }
    }
    state.lastRun = at
    state.ok = succeeded > 0 || pending.length === 0
    state.creditsTotal += credits
    state.lastMessage =
      pending.length === 0
        ? `没有待做的任务（共 ${filtered.length} 个，今天都已领过）`
        : `执行 ${attempted} 个，成功 ${succeeded} 个，积分 +${credits}`
    if (succeeded > 0) state.failures = 0
    return { attempted, succeeded, credits, message: state.lastMessage }
  }

  /** 执行单个任务，带重试。 */
  private async runOne(
    adapter: AgentAdapter,
    ctx: AdapterContext,
    account: AccountRecord,
    task: TaskRecord,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const config = this.deps.tasksConfigOf(account.agentId)
    const state = this.state(account)
    let last: TaskResult = { taskId: task.id, ok: false, message: '未执行', at: this.now() }
    for (let attempt = 1; attempt <= Math.max(1, config.retryDelaySec > 0 ? 2 : 1); attempt += 1) {
      if (signal?.aborted === true) break
      try {
        last = await adapter.executeTask(task, account, ctx)
      } catch (error) {
        last = {
          taskId: task.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          kind: 'unknown',
          retryable: true,
          at: this.now(),
        }
      }
      this.record(account, task, last.ok, last.credits ?? 0, last.message ?? '', last.kind ?? 'none', attempt, last.at)
      if (last.ok) return last
      if (last.retryable === false || last.kind === 'bad_request') break
      if (attempt < 2) await sleep(Math.max(1000, config.retryDelaySec * 1000), signal).catch(() => undefined)
    }
    state.failures += 1
    state.ok = false
    state.lastMessage = last.message ?? '任务执行失败'
    this.maybePause(account, state)
    return last
  }

  /** 连续失败超限 → 临时暂停该账号的自动任务 + 日志告警。 */
  private maybePause(account: AccountRecord, state: AccountTaskStatus): void {
    const config = this.deps.tasksConfigOf(account.agentId)
    const limit = Math.max(1, config.maxFailures)
    if (state.failures < limit) return
    state.paused = true
    state.pausedReason = `连续失败 ${state.failures} 次，已暂停该账号的自动任务（点「恢复」或改配置后重试）`
    this.deps.log.error(
      `自动任务暂停：${account.id}`,
      `${state.pausedReason}；最近错误：${state.lastMessage ?? '(无)'}`,
    )
  }

  /** 写一条任务流水（同时进 JSONL 与 DSH 日志）。 */
  private record(
    account: AccountRecord,
    task: TaskRecord,
    ok: boolean,
    credits: number,
    message: string,
    kind: ErrorKind,
    attempt: number,
    at: number,
  ): void {
    const record: TaskLogRecord = {
      at,
      agentId: account.agentId,
      accountId: account.id,
      accountLabel: account.label,
      taskId: task.id,
      taskTitle: task.title,
      kind: task.kind,
      ok,
      credits,
      message,
      errorKind: kind,
      attempt,
    }
    this.deps.logStore.append(record)
    const text = `[${account.agentId}] ${account.label} 执行「${task.title}」→ ${ok ? '成功' : '失败'}${
      credits > 0 ? `（+${credits} 积分）` : ''
    }`
    if (ok) this.deps.log.info(text, message)
    else this.deps.log.warn(text, `kind=${kind} ${message}`)
  }

  // ─────────────────────── 批量（并发受控） ───────────────────────

  /**
   * 对一个 Agent 下的**全部开启自动任务**的账号跑一轮。
   *
   * 并发受 `tasks.concurrency` 限制（**防止短时间大量请求触发上游风控**）。
   */
  async runBatch(agentId: string, signal?: AbortSignal): Promise<{
    accounts: number
    attempted: number
    succeeded: number
    credits: number
    details: Array<{ accountId: string; message: string }>
  }> {
    const targets = this.deps.accounts.byAgent(agentId).filter((account) => account.enabled && this.enabledFor(account))
    const details: Array<{ accountId: string; message: string }> = []
    let attempted = 0
    let succeeded = 0
    let credits = 0

    const runnable = targets.map((account) => async () => {
      const outcome = await this.semaphore.run(() => this.runForAccount(account, signal))
      attempted += outcome.attempted
      succeeded += outcome.succeeded
      credits += outcome.credits
      details.push({ accountId: account.id, message: outcome.message })
    })
    // 槽位数量由构造时的最大并发决定；这里分批等待，避免一次性铺开成千上万个 promise。
    const batchSize = Math.max(1, this.maxConcurrency())
    for (let index = 0; index < runnable.length; index += batchSize) {
      await Promise.all(runnable.slice(index, index + batchSize).map((run) => run()))
    }
    return { accounts: targets.length, attempted, succeeded, credits, details }
  }

  // ─────────────────────── 每日签到 ───────────────────────

  /**
   * 跑一个账号的每日签到。
   *
   * 幂等：同一天内同一个账号只签一次（`checkin:<agent>:<account>:<yyyy-mm-dd>`，
   * 日期是**服务端业务日 UTC+8**）。
   * 上游没有签到能力时**不是故障** —— 返回一句「上游无签到接口」，只记 debug。
   *
   * ⚠️ **记「今天已签」的唯一判据是 `CheckInResult.coversToday !== false`**。
   * 「今天已领」这句话本身有歧义：有些平台的活动按日**在固定时刻刷新**
   * （Qoder 是 10:00 UTC+8），刷新前看到的「已领」属于**昨天那一轮** ——
   * 拿它记账会让当天刷新后再也不去领，**每天静默漏掉一份额度**。
   * 详见 `core/types.ts` 的 `CheckInResult.coversToday`。
   */
  async checkIn(account: AccountRecord, options: { force?: boolean } = {}): Promise<{
    ok: boolean
    supported: boolean
    credits: number
    message: string
    /** 见 `CheckInResult.coversToday`。 */
    coversToday: boolean
    /** 见 `CheckInResult.actionRequired`。 */
    actionRequired: boolean
    /** 今天已记账（幂等命中或本轮确认覆盖今天）。 */
    recorded: boolean
  }> {
    const adapter = this.deps.adapterOf(account.agentId)
    const ctx = this.deps.contextOf(account.agentId)
    if (adapter === undefined || ctx === undefined) {
      return { ok: false, supported: false, credits: 0, message: '适配器未装载', coversToday: false, actionRequired: false, recorded: false }
    }
    if (!adapter.capabilities.checkIn) {
      return {
        ok: true,
        supported: false,
        credits: 0,
        message: '该 Agent 的上游没有每日签到接口（不是故障）',
        coversToday: false,
        actionRequired: false,
        recorded: false,
      }
    }
    const at = this.now()
    const key = checkInKey(account.agentId, account.id, at)
    if (options.force !== true && this.deps.accounts.lastRun(key) !== 0) {
      return {
        ok: true,
        supported: true,
        credits: 0,
        message: '今天已经签过了',
        coversToday: true,
        actionRequired: false,
        recorded: true,
      }
    }
    try {
      const result = await adapter.checkIn(account, ctx)
      // ⚠️ 只有「覆盖今天」的成功才记档。`coversToday === false` 时**故意不记**，
      // 于是当天稍晚的重试仍会真的去打一次上游（那正是我们要的）。
      const coversToday = result.coversToday !== false
      const recorded = result.supported && result.ok && coversToday
      if (recorded) this.deps.accounts.setLastRun(key, at)
      const record: TaskLogRecord = {
        at: result.at,
        agentId: account.agentId,
        accountId: account.id,
        accountLabel: account.label,
        taskId: '(checkin)',
        taskTitle: '每日签到',
        kind: 'checkin',
        ok: result.ok,
        credits: result.credits ?? 0,
        message: result.message ?? '',
        errorKind: result.kind ?? 'none',
        attempt: 1,
      }
      this.deps.logStore.append(record)
      const text = `[${account.agentId}] ${account.label} 每日签到 → ${result.ok ? '成功' : '失败'}${
        (result.credits ?? 0) > 0 ? `（+${result.credits} 积分）` : ''
      }`
      if (result.ok) this.deps.log.info(text, result.message ?? '')
      else this.deps.log.warn(text, result.message ?? '')
      if (!coversToday) {
        // 单独记一条：这是「今天还没真正处理」的信号，排查漏领时靠它。
        this.deps.log.info(
          `[${account.agentId}] ${account.label} 本轮结果不覆盖今天（今天尚未记账，稍后会重试）`,
          result.message ?? '',
        )
      }
      return {
        ok: result.ok,
        supported: result.supported,
        credits: result.credits ?? 0,
        message: result.message ?? (result.ok ? '签到成功' : '签到失败'),
        coversToday,
        actionRequired: result.actionRequired === true,
        recorded,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log.warn(`[${account.agentId}] ${account.label} 每日签到抛错`, message)
      return { ok: false, supported: true, credits: 0, message, coversToday: false, actionRequired: false, recorded: false }
    }
  }

  /**
   * 批量签到（某个 Agent 下所有该签的账号）。
   *
   * ⚠️ 计数的口径与参考实现的 `shouldMarkToday` 一致：**只有能证明「今天这一轮
   * 已被处理」的才算成功**（`coversToday`）。把「刷新前那一轮」也算成成功，
   * 会让汇总行显示「3 个成功」而实际上三个都没领到今天的东西。
   */
  async checkInBatch(agentId: string, signal?: AbortSignal): Promise<{
    accounts: number
    ok: number
    /** 真正记账到今天的条数（`ok` 的子集）。 */
    recorded: number
    /** 需要用户去别处操作的账号（不是故障，重试无用）。 */
    actionRequired: number
    credits: number
    details: Array<{ accountId: string; message: string; coversToday: boolean; actionRequired: boolean }>
  }> {
    const targets = this.deps.accounts
      .byAgent(agentId)
      .filter((account) => account.enabled && this.checkInEnabledFor(account))
    const details: Array<{ accountId: string; message: string; coversToday: boolean; actionRequired: boolean }> = []
    let ok = 0
    let recorded = 0
    let actionRequired = 0
    let credits = 0
    for (const account of targets) {
      if (signal?.aborted === true) break
      const outcome = await this.checkIn(account)
      if (outcome.ok && outcome.supported && outcome.coversToday) ok += 1
      if (outcome.recorded) recorded += 1
      if (outcome.actionRequired) actionRequired += 1
      credits += outcome.credits
      details.push({
        accountId: account.id,
        message: outcome.message,
        coversToday: outcome.coversToday,
        actionRequired: outcome.actionRequired,
      })
    }
    return { accounts: targets.length, ok, recorded, actionRequired, credits, details }
  }
}
