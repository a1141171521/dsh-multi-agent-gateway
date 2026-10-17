/**
 * 多账号智能路由（**同 Agent 内切换**）。
 *
 * 决策输入只有两个：账号健康状态、`ErrorKind`。**永远不解析错误文案。**
 *
 * 两种策略：
 *   - `round-robin` —— 轮流。适合「账号之间没差别、只想摊开压力」。
 *   - `quota-first` —— 先按剩余额度降序，额度相同再按健康权重升序。
 *     适合同 Agent 下有的号快没额度了。
 *
 * 换号的触发条件（任务书明确要求）：
 *   - 限流（429）→ 短时降权 + 换号
 *   - 鉴权失效（401/403）→ 长时降权 + 换号
 *   - 额度耗尽 → 长时降权 + 换号，且**同一个号不再试**
 *   - 上游 5xx → 不降权（是上游的问题，不是账号的问题），但可以换号兜一下
 *
 * **不换号**的情况：`bad_request`（请求本身错了，换号也一样错）。
 */

import { failureOf } from './errors.js'
import { AccountManager } from './accounts.js'
import type { AccountRecord, ErrorKind, FailureInfo, Logger, ResolvedGatewayConfig } from './types.js'
import { isRetryable, shouldSwitchAccount } from './types.js'

/** 一次路由尝试的记账。 */
export interface AttemptRecord {
  accountId: string
  kind: ErrorKind
  message?: string
  startedAt: number
  elapsedMs: number
}

/** 路由的最终结果。 */
export type RouteOutcome<T> =
  | { ok: true; value: T; accountId: string; attempts: AttemptRecord[] }
  | { ok: false; failure: FailureInfo; attempts: AttemptRecord[] }

/** 单次尝试返回：要么成功带值，要么失败带分类。 */
export type AttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: ErrorKind; message: string; status?: number; retryAfterMs?: number; requestId?: string }

export interface RouteOptions {
  /** 覆盖默认的最大换号次数。 */
  maxAttempts?: number
  /** 是否允许在「上游 5xx / 网络错误」时也换号（默认允许）。 */
  switchOnUpstream?: boolean
  /** 已经排除的账号（外层重试时用）。 */
  exclude?: string[]
}

export class AccountRouter {
  private readonly accounts: AccountManager
  private readonly gateway: ResolvedGatewayConfig
  private readonly log: Logger
  private readonly now: () => number

  constructor(
    accounts: AccountManager,
    gateway: ResolvedGatewayConfig,
    log: Logger,
    now: () => number = Date.now,
  ) {
    this.accounts = accounts
    this.gateway = gateway
    this.log = log
    this.now = now
  }

  /**
   * **一个账号都没有时**用的匿名占位账号。
   *
   * 为什么必须有：这个插件的主场景就是「不登录、不填 key 直接用免费模型」。
   * 把「没有账号」当错误，用户就得为了用免费层先去建一个空账号 —— 纯属多余的一步，
   * 而且报出来的还是 `auth`（DSH 界面显示「API 密钥无效」），指向完全错误的方向。
   * 实测被这个坑卡住过。
   *
   * 三条边界：
   *   1. **只在真的一个账号都没有时**才用 —— 有账号但全被禁用是真实配置问题，
   *      这时必须照旧报错，不能被匿名账号掩盖；
   *   2. 每次调用返回**同一个 id**（`<agentId>:anonymous`），这样令牌桶、健康记录
   *      不会因为对象新建而失控；
   *   3. 它**不落盘**，也永远不会出现在账号列表里。
   */
  private anonymousAccount(agentId: string): AccountRecord {
    return {
      id: `${agentId}:anonymous`,
      agentId,
      label: '(匿名 · 无需凭证)',
      credentials: {},
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    }
  }

  /**
   * 按策略给出候选账号顺序。
   *
   * 排序规则（**优先级从高到低**）：
   *   1. 可用（`enabled` + 没被降权 + 健康状态不是 invalid）
   *   2. 策略顺序
   *   3. 可用的排前面；降权中的排在最后（只在没得选时才用）
   */
  candidates(agentId: string, exclude: string[] = []): {
    usable: AccountRecord[]
    penalized: AccountRecord[]
  } {
    const now = this.now()
    this.accounts.recoverExpired(now)
    const pool = this.accounts
      .routable(agentId)
      .filter((account) => !exclude.includes(account.id))
    const usable: AccountRecord[] = []
    const penalized: AccountRecord[] = []
    for (const account of pool) {
      const health = this.accounts.health(account.id)
      if (health.state === 'invalid') continue
      if (this.accounts.available(account.id, now)) usable.push(account)
      else penalized.push(account)
    }
    const sortByStrategy = (list: AccountRecord[]): AccountRecord[] => {
      if (this.gateway.routing === 'quota-first') {
        return [...list].sort((left, right) => {
          const scoreLeft = this.quotaScore(left)
          const scoreRight = this.quotaScore(right)
          if (scoreLeft !== scoreRight) return scoreRight - scoreLeft
          // 额度打平就按健康权重（失败多的靠后），最后按 id 稳定排序。
          const weightLeft = this.accounts.health(left.id).weight
          const weightRight = this.accounts.health(right.id).weight
          if (weightLeft !== weightRight) return weightLeft - weightRight
          return left.id.localeCompare(right.id)
        })
      }
      return this.rotate(agentId, list)
    }
    // ── 一个账号都没有 → 给一个匿名占位 ──────────────────────────────
    // 只在**确实一个账号都没配**时兜底；有账号但全被禁用属于真实配置问题，
    // 必须照旧报错，不能被这里悄悄掩盖。
    const anonymousId = `${agentId}:anonymous`
    const configured = this.accounts.byAgent(agentId).length
    if (configured === 0 && usable.length === 0 && penalized.length === 0 && !exclude.includes(anonymousId)) {
      usable.push(this.anonymousAccount(agentId))
    }

    return {
      usable: sortByStrategy(usable),
      // 降权账号永远排在真正可用的后面，且顺序固定（不打乱恢复检测的观察面）。
      penalized: [...penalized].sort((left, right) => left.id.localeCompare(right.id)),
    }
  }

  /**
   * 剩余额度的排序分值。
   *
   * 未知额度给 0（不是负数）—— 否则「还没拉过额度」的账号会被永远排到最后，
   * 而它可能恰恰是唯一能用的。
   */
  private quotaScore(account: AccountRecord): number {
    const quota = this.accounts.quota(account.id)
    if (quota === undefined) return 0
    if (quota.unlimited === true) return Number.MAX_SAFE_INTEGER / 2
    if (quota.remaining === undefined) return 0
    return quota.remaining
  }

  /** 轮询：用持久化游标把「上次轮到的位置」记住，DSH 重启也不重置。 */
  private rotate(agentId: string, list: AccountRecord[]): AccountRecord[] {
    if (list.length <= 1) return list
    const cursor = this.accounts.cursor(agentId) % list.length
    const ordered = [...list.slice(cursor), ...list.slice(0, cursor)]
    this.accounts.setCursor(agentId, (cursor + 1) % list.length)
    return ordered
  }

  /**
   * 跑一次带自动换号的任务。
   *
   * @param agentId - 哪个 Agent。
   * @param run - 拿一个账号干一件事；返回 `AttemptResult`。
   * @param options - 覆盖项。
   */
  async execute<T>(
    agentId: string,
    run: (account: AccountRecord, attempt: number) => Promise<AttemptResult<T>>,
    options: RouteOptions = {},
  ): Promise<RouteOutcome<T>> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? this.gateway.maxAccountAttempts)
    const attempts: AttemptRecord[] = []
    const excluded = [...(options.exclude ?? [])]
    let lastFailure: FailureInfo | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { usable, penalized } = this.candidates(agentId, excluded)
      // 先用可用的；一个都没有时才退到降权账号（"总比没有强"）。
      const next = usable[0] ?? penalized[0]
      if (next === undefined) {
        const reason =
          excluded.length > 0
            ? `「${agentId}」下已经没有其它账号可换（已试 ${excluded.length} 个）`
            : `「${agentId}」下没有可用账号 —— 请到配置页添加或启用一个`
        return {
          ok: false,
          failure: lastFailure ?? failureOf('auth', reason, { now: this.now() }),
          attempts,
        }
      }
      excluded.push(next.id)
      const startedAt = this.now()
      let outcome: AttemptResult<T>
      try {
        outcome = await run(next, attempt)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        outcome = { ok: false, kind: 'unknown', message }
      }
      const elapsedMs = this.now() - startedAt
      if (outcome.ok) {
        this.accounts.markOk(next.id, this.now())
        attempts.push({ accountId: next.id, kind: 'none', startedAt, elapsedMs })
        if (attempts.length > 1) {
          this.log.info(
            `「${agentId}」第 ${attempts.length} 次尝试成功`,
            `account=${next.id} 用时=${elapsedMs}ms`,
          )
        }
        return { ok: true, value: outcome.value, accountId: next.id, attempts }
      }

      const failure = failureOf(outcome.kind, outcome.message, {
        ...(outcome.status === undefined ? {} : { status: outcome.status }),
        ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        ...(outcome.requestId === undefined ? {} : { requestId: outcome.requestId }),
        now: this.now(),
      })
      lastFailure = failure
      attempts.push({ accountId: next.id, kind: outcome.kind, message: outcome.message, startedAt, elapsedMs })

      // 记健康：只有「账号自己的问题」才降权。
      if (outcome.kind === 'auth' || outcome.kind === 'quota' || outcome.kind === 'rate_limit') {
        const penaltyMs =
          outcome.kind === 'rate_limit'
            ? Math.max(outcome.retryAfterMs ?? 0, this.gateway.penaltySec * 1000)
            : outcome.kind === 'auth'
              ? Math.max(this.gateway.penaltySec * 1000, 10 * 60 * 1000)
              : Math.max(this.gateway.penaltySec * 1000, 30 * 60 * 1000)
        this.accounts.markFailure(
          next.id,
          failure,
          this.gateway.degradeAfterFailures,
          penaltyMs,
          this.now(),
        )
        // 鉴权连续失败到阈值 → 直接判死，让 UI 上看得见「这个号不行了」。
        if (outcome.kind === 'auth' && this.accounts.health(next.id).failures >= this.gateway.degradeAfterFailures * 3) {
          this.accounts.markInvalid(next.id, failure)
          this.log.error(`账号 ${next.id} 连续鉴权失败，已标记为失效`, outcome.message)
        }
      }
      this.log.warn(
        `账号 ${next.id} 失败（${outcome.kind}）`,
        `${outcome.message}${attempt + 1 < maxAttempts ? ' —— 尝试切换下一个账号' : ' —— 没有更多账号可换'}`,
      )

      const canSwitch =
        shouldSwitchAccount(outcome.kind) ||
        (options.switchOnUpstream !== false && (outcome.kind === 'server' || outcome.kind === 'network'))
      if (!canSwitch) {
        // 请求本身错了：换号也是同一个错，直接返回。
        return { ok: false, failure, attempts }
      }
      // 同一个号在限流/网络抖动时值得再等一会儿（含 Retry-After 退避）。
      if (isRetryable(outcome.kind) && outcome.kind !== 'rate_limit') {
        // 上游故障/网络：给下一个账号一点喘息，避免把上游打得更死。
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(1000, 100 + attempts.length * 250))
          timer.unref?.()
        })
      }
    }
    return {
      ok: false,
      failure: lastFailure ?? failureOf('unknown', `「${agentId}」路由失败`, { now: this.now() }),
      attempts,
    }
  }

  /**
   * 自动恢复检测：对**降权中的**账号做一次轻量探测（额度查询最省），
   * 成功就立刻解除降权。
   *
   * 由调度器周期性调用（`gateway.recoverIntervalSec`）。
   *
   * @param probe - 一次尽可能便宜的探测（返回 true 表示账号活着）。
   */
  async recover(
    agentIds: string[],
    probe: (account: AccountRecord) => Promise<boolean>,
  ): Promise<Array<{ accountId: string; restored: boolean }>> {
    const now = this.now()
    const results: Array<{ accountId: string; restored: boolean }> = []
    for (const agentId of agentIds) {
      for (const account of this.accounts.byAgent(agentId)) {
        const health = this.accounts.health(account.id)
        if (health.state !== 'degraded') continue
        // 还没到「可以试着恢复」的时间就别打上游。
        const due = health.penaltyUntil !== 0 ? health.penaltyUntil : health.lastAttemptAt ?? 0
        if (due > now) continue
        let alive = false
        try {
          alive = await probe(account)
        } catch (error) {
          this.log.debug(
            `恢复检测失败 ${account.id}`,
            error instanceof Error ? error.message : String(error),
          )
        }
        if (alive) {
          this.accounts.markOk(account.id, now)
          this.log.info(`账号 ${account.id} 已自动恢复，重新参与路由`)
        } else {
          // 再降权一轮，避免对着一个死号每轮都打。
          health.penaltyUntil = now + this.gateway.penaltySec * 1000
          this.accounts.touchState()
        }
        results.push({ accountId: account.id, restored: alive })
      }
    }
    return results
  }
}
