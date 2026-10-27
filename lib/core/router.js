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
                                                                                                      
import { isRetryable, shouldSwitchAccount } from './types.js'

/** 一次路由尝试的记账。 */
                                
                   
                 
                  
                   
                   
 

/** 路由的最终结果。 */
                             
                                                                        
                                                                  

/** 单次尝试返回：要么成功带值，要么失败带分类。 */
                              
                          
                                                                                                               

/**
 * 上游给的 `retry-after` 的**封顶**（30 分钟）。
 *
 * 逐字对齐参考实现 `dsh-our-free-model` 的 `RETRY_AFTER_CAP_MS`，理由是它注释里
 * 那句：**不封顶的话单次阻塞可能长达数小时，UI 无法区分「在等」与「卡死」**。
 * 上游给 12 小时就照锁 12 小时，用户看到的是「账号莫名其妙不用了」。
 */
export const RETRY_AFTER_CAP_MS = 30 * 60 * 1000

/**
 * 额度耗尽（402 / 配额错误）的冷却：**按当日算，24 小时**。
 *
 * 参考实现的原话：「钱不会在 60 秒内到账，**短冷却会让同一个空钱包账号被反复
 * 选中、反复 402**」。我们原来这里是 30 分钟 —— 对一个按「当日额度」结算的
 * 窗口明显偏短：半小时后那个号仍没钱，于是被反复选中、反复失败，
 * 白白消耗换号次数，用户还看到一串没意义的 402。
 */
export const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** 鉴权失败（401/403）的冷却下限：10 分钟。 */
export const AUTH_COOLDOWN_MS = 10 * 60 * 1000

/**
 * 风控拦截的冷却下限：**30 分钟**。
 *
 * 为什么比鉴权（10 分钟）还长：风控是按**行为特征**判定的，同一个号在被标记后
 * 立刻回来重试，只会加深「这是个异常客户端」的印象，把临时风控升级成长期封禁。
 * 给它一段明显的静默期，比抢那几分钟更划算。
 *
 * 上限仍受 `Retry-After` 与 {@link RETRY_AFTER_CAP_MS} 约束 —— 上游明说要等多久时听上游的。
 */
export const RISK_CONTROL_COOLDOWN_MS = 30 * 60 * 1000

/**
 * 按错误类型算「这个账号该被冷落多久」（毫秒）。
 *
 * ⚠️ **上游给了 `retry-after` 就用它的**，但要**封顶**
 * （{@link RETRY_AFTER_CAP_MS}），否则一次畸形/极长的响应头就能把账号锁掉几小时。
 * ⚠️ `retryAfterMs === 0` 是**合法值**（「立即解除」），所以判空必须用
 * `!== undefined` —— 写成 falsy 判据会把「立刻可用」换成默认冷却，
 * 让刚恢复的账号继续被跳过。
 *
 * 各类型的兜底（上游没给 `retry-after` 时）：
 *   - `rate_limit`   —— 短冷却（配置的 `penaltySec`），限流通常很快过去；
 *   - `risk_control` —— 至少 {@link RISK_CONTROL_COOLDOWN_MS}（风控要静默期）；
 *   - `auth`         —— 至少 {@link AUTH_COOLDOWN_MS}（多半要用户去重新登录）；
 *   - `quota`        —— {@link QUOTA_COOLDOWN_MS}（当日额度，等一会儿没用）。
 */
export function penaltyMsFor(kind           , retryAfterMs                    , penaltySec        )         {
  const floor = Math.max(0, penaltySec) * 1000
  if (retryAfterMs !== undefined) return Math.max(0, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS))
  if (kind === 'risk_control') return Math.max(floor, RISK_CONTROL_COOLDOWN_MS)
  if (kind === 'auth') return Math.max(floor, AUTH_COOLDOWN_MS)
  if (kind === 'quota') return Math.max(floor, QUOTA_COOLDOWN_MS)
  return floor
}

                               
                     
                      
                                        
                            
                         
                    
 

export class AccountRouter {
                   accounts                
                   gateway                       
                   log        
                   now              

  constructor(
    accounts                ,
    gateway                       ,
    log        ,
    now               = Date.now,
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
          anonymousAccount(agentId        )                {
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
  candidates(agentId        , exclude           = [])   
                           
                              
    {
    const now = this.now()
    this.accounts.recoverExpired(now)
    const pool = this.accounts
      .routable(agentId)
      .filter((account) => !exclude.includes(account.id))
    const usable                  = []
    const penalized                  = []
    for (const account of pool) {
      const health = this.accounts.health(account.id)
      if (health.state === 'invalid') continue
      if (this.accounts.available(account.id, now)) usable.push(account)
      else penalized.push(account)
    }
    const sortByStrategy = (list                 )                  => {
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
          quotaScore(account               )         {
    const quota = this.accounts.quota(account.id)
    if (quota === undefined) return 0
    if (quota.unlimited === true) return Number.MAX_SAFE_INTEGER / 2
    if (quota.remaining === undefined) return 0
    return quota.remaining
  }

  /** 轮询：用持久化游标把「上次轮到的位置」记住，DSH 重启也不重置。 */
          rotate(agentId        , list                 )                  {
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
  /**
   * 「一个候选都没有」时，把**真实原因**说出来。
   *
   * 为什么值得单独写：这条错误原来统一说「没有可用账号 —— 请到配置页添加或启用一个」，
   * 而且归类成 `auth`，DSH 界面直接显示成「**API 密钥无效**」—— 用户明明刚登录成功，
   * 却被指向「密钥」这个完全错误的方向（真机踩到：账号的「对话」开关没开）。
   *
   * 所以这里按**配置现状**分情况给话术，每种都说清「去哪点哪个开关」。
   */
          describeNoCandidate(agentId        , excluded          )         {
    const configured = this.accounts.byAgent(agentId)
    if (configured.length === 0) {
      return `「${agentId}」还没有账号 —— 到「账号」页登录或添加一个`
    }
    const disabled = configured.filter((account) => !account.enabled)
    if (disabled.length === configured.length) {
      return `「${agentId}」的 ${configured.length} 个账号都被停用了 —— 到「账号」页重新启用`
    }
    // 「对话」开关关掉 = 这个账号不参与对话路由。登录后默认是开的，
    // 但用户点过那个开关就会变成关 —— 这时必须点名说清楚。
    const chatOff = configured.filter((account) => account.enabled && account.routeChat === false)
    if (chatOff.length > 0 && chatOff.length === configured.filter((account) => account.enabled).length) {
      return `「${agentId}」的账号「对话」开关是关的 —— 到「账号」页把该账号的「对话」打开`
    }
    const invalid = configured.filter((account) => this.accounts.health(account.id).state === 'invalid')
    if (invalid.length === configured.length) {
      return `「${agentId}」的账号凭证已失效 —— 到「账号」页重新登录`
    }
    return excluded.length > 0
      ? `「${agentId}」下已经没有其它账号可换（已试 ${excluded.length} 个）`
      : `「${agentId}」下没有可用账号 —— 到「账号」页检查账号是否启用、健康是否正常`
  }

  async execute   (
    agentId        ,
    run                                                                        ,
    options               = {},
  )                           {
    const maxAttempts = Math.max(1, options.maxAttempts ?? this.gateway.maxAccountAttempts)
    const attempts                  = []
    const excluded = [...(options.exclude ?? [])]
    let lastFailure                         

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const { usable, penalized } = this.candidates(agentId, excluded)
      // 先用可用的；一个都没有时才退到降权账号（"总比没有强"）。
      const next = usable[0] ?? penalized[0]
      if (next === undefined) {
        const reason = this.describeNoCandidate(agentId, excluded)
        return {
          ok: false,
          // ⚠️ 归类用 `unsupported` 而不是 `auth`：这是**配置没就绪**，不是凭证无效。
          // 归成 auth 会被 DSH 显示成「API 密钥无效」，把用户引到错误的方向。
          // 没有 lastFailure 时（一次都没发出去）尤其不能用 auth。
          failure: lastFailure ?? failureOf('unsupported', reason, { now: this.now() }),
          attempts,
        }
      }
      excluded.push(next.id)
      const startedAt = this.now()
      let outcome                  
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
      if (
        outcome.kind === 'auth'
        || outcome.kind === 'quota'
        || outcome.kind === 'rate_limit'
        || outcome.kind === 'risk_control'
      ) {
        const penaltyMs = penaltyMsFor(outcome.kind, outcome.retryAfterMs, this.gateway.penaltySec)
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
        /**
         * 风控连续触发 → 同样判死，但**门槛更高**（`×2` 而不是 `×3` 次的鉴权口径，
         * 这里用同一套 `degradeAfterFailures` 基数）。
         *
         * 为什么值得判死：一个反复触发风控的号，每次被选中都会污染整个平台的
         * 出口信誉，而且它自己短时间内也恢复不了。标成 `invalid` 让它在界面上
         * 明确显示「已失效 · 触发风控」，用户才知道该去重新登录或换号，
         * 而不是看着它一直被降权、一直被跳过、不知道为什么。
         */
        if (
          outcome.kind === 'risk_control'
          && this.accounts.health(next.id).failures >= this.gateway.degradeAfterFailures * 2
        ) {
          this.accounts.markInvalid(next.id, failure)
          this.log.error(`账号 ${next.id} 连续触发风控，已标记为失效`, outcome.message)
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
        await new Promise      ((resolve) => {
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
    agentIds          ,
    probe                                              ,
  )                                                           {
    const now = this.now()
    const results                                                  = []
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


//# sourceURL=src/core/router.ts