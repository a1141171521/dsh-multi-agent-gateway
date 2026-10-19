/**
 * 定时任务管理器。
 *
 * 一个 tick 循环（默认 15 秒粒度）驱动全部定时工作：
 *   - 每日签到（每个账号一条 job）
 *   - 额度定时拉取（每个账号一条 job）
 *   - 活动任务（每个账号一条 job）
 *   - 模型/倍率缓存刷新（每个 Agent 一条 job）
 *   - 降权账号的自动恢复检测（每个 Agent 一条 job）
 *
 * 为什么用「轮询 + 到期判定」而不是 `setTimeout` 链：
 *   1. DSH 可能会被休眠/挂起，`setTimeout` 的墙钟时间会撒谎，轮询看的是**真实时间**；
 *   2. 一条 job 抛错不会带崩其它 job；
 *   3. 「上次执行时间」持久化在 `state.json`，**DSH 重启不会把当天该签到的漏掉**；
 *   4. 启动时按 `startupDelaySec` 错峰，避免所有账号在同一秒打上游（风控）。
 *
 * 时间表达式支持三种（够用且不会写错）：
 *   - 5 段 cron：`分 时 日 月 周`（例如 `30 8 * * *` = 每天 08:30）
 *   - 6 段 cron：`秒 分 时 日 月 周`（例如 `0 30 8 * * *`）
 *   - 间隔：`every:1800`（秒）
 */

                                        

/** cron 字段的允许范围（索引对应 `[分, 时, 日, 月, 周]`）。 */
const RANGES                          = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
]

/** 解析后的 cron：每段是一个「允许值集合」；`null` 表示 `*`（全通配）。 */
                                   

                             
              
                                                                 
                   
                
 

                                 
                  
                 
                
 

                                                        

/** 解析一段 cron 字段。 */
function parseField(text        , range                  , label        )            {
  if (text === '*' || text === '?') return null
  const values = new Set        ()
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    const [base, stepText] = piece.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`${label} 的步长不合法：${piece}`)
    let from        
    let to        
    if (base === '*' || base === '' || base === undefined) {
      from = range[0]
      to = range[1]
    } else if (base.includes('-')) {
      const [a, b] = base.split('-')
      from = Number(a)
      to = Number(b)
    } else {
      from = Number(base)
      to = from
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`${label} 的取值不合法：${piece}`)
    if (from < range[0] || to > range[1] || from > to) {
      throw new Error(`${label} 超出范围（${range[0]}-${range[1]}）：${piece}`)
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  if (values.size === 0) throw new Error(`${label} 解析后为空：${text}`)
  return values
}

/**
 * 解析时间表达式。认不出来就抛错（**不静默失败**）——
 * 一个写错的时间表达式意味着「永远不会跑」，那是用户绝对看不见的坑。
 */
export function parseSchedule(expression        )                 {
  const text = expression.trim()
  if (text === '') throw new Error('时间表达式为空')
  const interval = /^every:(\d+)$/.exec(text)
  if (interval !== null) {
    const seconds = Number(interval[1])
    if (!Number.isFinite(seconds) || seconds < 30) throw new Error(`间隔至少 30 秒：${text}`)
    return { kind: 'interval', seconds, source: text }
  }
  const parts = text.split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(`时间表达式要 5 段（分 时 日 月 周）、6 段（秒 分 时 日 月 周）或 every:<秒>：${text}`)
  }
  const [minute, hour, day, month, weekday] = parts.length === 6 ? parts.slice(1) : parts
  return {
    kind: 'cron',
    source: text,
    fields: [
      parseField(minute, RANGES[0], '分钟'),
      parseField(hour, RANGES[1], '小时'),
      parseField(day, RANGES[2], '日'),
      parseField(month, RANGES[3], '月'),
      parseField(weekday, RANGES[4], '星期'),
    ],
  }
}

/** 某个时间戳是否命中（分钟粒度 + 秒粒度的近似：命中即认为「这一分钟内该跑」）。 */
export function matches(schedule                , at      )          {
  if (schedule.kind === 'interval') return true
  const probes                             = [
    [schedule.fields[0], at.getMinutes()],
    [schedule.fields[1], at.getHours()],
    [schedule.fields[2], at.getDate()],
    [schedule.fields[3], at.getMonth() + 1],
    [schedule.fields[4], at.getDay()],
  ]
  for (const [field, value] of probes) {
    if (field === null) continue
    if (!field.has(value)) return false
  }
  return true
}

/**
 * 判定「这条 job 现在该不该跑」。
 *
 * cron 的语义是「**这一分钟**该跑」，而 tick 是 15 秒粒度，所以必须按
 * **分钟桶**去重：落在同一分钟里的后续 tick 都不能再跑一次。
 *
 * @param firstRunAt - 「从没跑过」时的首次执行时刻（启动 + 错峰）。缺省表示立刻可跑。
 */
export function isDue(
  schedule                ,
  lastRun        ,
  at        ,
  firstRunAt         ,
)          {
  if (lastRun === 0) {
    return firstRunAt === undefined ? true : at >= firstRunAt
  }
  if (schedule.kind === 'interval') {
    return at - lastRun >= schedule.seconds * 1000
  }
  if (Math.floor(at / 60_000) === Math.floor(lastRun / 60_000)) return false
  return matches(schedule, new Date(at))
}

/** 一条 job 的定义。 */
                                
                                               
             
                       
               
               
                  
                           
                    
                              
                                           
                             
                          
                                 
                         
 

/** 一条 job 的运行记录。 */
                            
             
               
                  
                    
                 
                     
                    
              
                  
                     
                 
                       
 

                                   
                     
                 
                        
                      
                                
                     
                
                 
                                 
                 
                                           
                
 

/**
 * 定时任务管理器。
 *
 * 生命周期：`start()` → 内部 tick → `stop()`。`stop()` 会 abort 所有在跑的 job。
 */
export class Scheduler {
                   jobs = new Map                       ()
                   status = new Map                   ()
                   parsed = new Map                        ()
                   options                  
                   tickMs        
                   maxFailures        
                   cooldownMs        
                   log        
                   now              
          timer                        = null
          controller                         = null
          running = false
          startedAt = 0

  constructor(options                  ) {
    this.options = options
    this.tickMs = Math.max(1000, options.tickMs ?? 15000)
    this.maxFailures = Math.max(1, options.maxFailures ?? 5)
    this.cooldownMs = Math.max(60_000, options.cooldownMs ?? 10 * 60_000)
    this.log = options.logger
    this.now = options.now ?? Date.now
  }

  /** 注册（或替换）一条 job。时间表达式不合法会抛错。 */
  register(job               )       {
    const schedule = parseSchedule(job.schedule)
    this.jobs.set(job.key, job)
    this.parsed.set(job.key, schedule)
    const previous = this.status.get(job.key)
    this.status.set(job.key, {
      key: job.key,
      title: job.title,
      schedule: job.schedule,
      ...(job.accountId === undefined ? {} : { accountId: job.accountId }),
      lastRun: previous?.lastRun ?? this.options.getLastRun(job.key),
      runs: previous?.runs ?? 0,
      failures: previous?.failures ?? 0,
      paused: previous?.paused ?? false,
      ...(previous?.lastResult === undefined ? {} : { lastResult: previous.lastResult }),
      ...(previous?.lastError === undefined ? {} : { lastError: previous.lastError }),
      ...(previous?.pausedReason === undefined ? {} : { pausedReason: previous.pausedReason }),
    })
  }

  /** 清掉全部 job（重新生成计划前调用）。 */
  clear()       {
    this.jobs.clear()
    this.parsed.clear()
  }

  /** 当前全部 job 状态（UI 数据源）。 */
  snapshot()              {
    return [...this.status.values()].sort((left, right) => left.key.localeCompare(right.key))
  }

  /** 有没有注册 job。 */
  get size()         {
    return this.jobs.size
  }

  /** 启动 tick。重复调用无副作用。 */
  start()       {
    if (this.running) return
    this.running = true
    this.startedAt = this.now()
    this.controller = new AbortController()
    const tick = ()       => {
      void this.runOnce()
    }
    this.timer = setInterval(tick, this.tickMs)
    this.timer.unref?.()
    // 立刻跑一次（启动错峰由 job 自己的 firstRunDelayMs 控制）。
    tick()
    this.log.info(`定时调度器已启动：${this.jobs.size} 条 job，tick=${this.tickMs}ms`)
  }

  /** 停止。 */
  stop()       {
    if (!this.running) return
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.controller?.abort()
    this.controller = null
    this.log.info('定时调度器已停止')
  }

  /** 跑一轮（测试可直接调用，不用等 tick）。 */
  async runOnce()                                                                {
    const at = this.now()
    const results                                                       = []
    for (const [key, job] of this.jobs) {
      const schedule = this.parsed.get(key)
      if (schedule === undefined) continue
      const status = this.status.get(key)
      if (status === undefined) continue
      // 暂停恢复：冷却期过了就放行（并保留「上次暂停过」的痕迹）。
      if (status.paused) {
        if (at - status.lastRun < this.cooldownMs) continue
        status.paused = false
        status.failures = 0
        status.lastResult = '失败计数已清零，自动恢复执行'
        this.log.info(`定时任务自动恢复：${job.title}`, key)
      }
      const firstDelay = job.firstRunDelayMs ?? 0
      const firstRunAt = this.startedAt + firstDelay
      if (!isDue(schedule, status.lastRun, at, firstRunAt)) continue

      status.lastRun = at
      status.runs += 1
      this.options.setLastRun(key, at)
      try {
        const message = await job.run(this.controller?.signal ?? new AbortController().signal)
        status.lastResult = message
        status.failures = 0
        delete status.lastError
        results.push({ key, ok: true, message })
        this.log.debug(`定时任务完成：${job.title}`, message)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        status.failures += 1
        status.lastError = message
        results.push({ key, ok: false, message })
        if (job.verboseErrors !== false) {
          this.log.error(`定时任务失败：${job.title}`, message)
        }
        if (status.failures >= this.maxFailures) {
          status.paused = true
          status.pausedReason = `连续失败 ${status.failures} 次，暂停 ${Math.round(this.cooldownMs / 60000)} 分钟`
          this.log.error(`定时任务已暂停：${job.title}`, status.pausedReason)
        }
      }
    }
    return results
  }
}


//# sourceURL=src/core/scheduler.ts