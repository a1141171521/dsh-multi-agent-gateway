/**
 * 适配器缓存 + 限速器。
 *
 * 两件事都是「防上游风控」的具体手段（任务书约束 5：自动任务模块做好并发控制，
 * 防止短时间大量请求触发上游风控）：
 *
 *   - `MemoryCache`：模型列表 / 倍率 / 能力探测结果缓存，避免每次渲染都打上游。
 *   - `TokenBucket`：**每个账号一个桶**，把「每分钟 N 次」变成硬上限。
 *     跨账号不限速（账号之间的配额本来就是独立的）。
 */

                                              

                      
                
                        
                   
 

/**
 * 进程内 KV 缓存。
 *
 * ⚠️ 刻意**只放内存**：模型列表可以从上游重新拉到，落盘反而会带来
 * 「缓存坏了但看起来正常」这种最难查的问题。要跨重启保留的那一份在
 * `AccountManager.cacheModels()`（明文、可删）。
 */
export class MemoryCache                         {
                   store = new Map                    ()
                   now              

  constructor(now               = Date.now) {
    this.now = now
  }

  get   (key        )                {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry.value     
  }

  /** 缓存是否命中且未过期。 */
  has(key        )          {
    return this.get(key) !== undefined
  }

  set   (key        , value   , ttlMs         )       {
    const expiresAt = ttlMs === undefined || ttlMs <= 0 ? 0 : this.now() + ttlMs
    this.store.set(key, { value, expiresAt })
  }

  delete(key        )       {
    this.store.delete(key)
  }

  keys()           {
    return [...this.store.keys()]
  }

  /** 清掉所有过期项（防止长跑进程慢慢涨）。 */
  sweep()         {
    let removed = 0
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== 0 && entry.expiresAt <= this.now()) {
        this.store.delete(key)
        removed += 1
      }
    }
    return removed
  }
}

/** 令牌桶：每个键（账号）独立。 */
export class TokenBucket {
                   capacity        
                   refillPerMs        
                   now              
                   burst        
                   buckets = new Map                                               ()

  /**
   * @param perMinute - 每分钟允许的请求数（<=0 表示不限速）。
   * @param now - 时间源（测试可注入）。
   * @param burst - 允许的突发量，缺省等于 perMinute/4（至少 1）。
   */
  constructor(perMinute        , now               = Date.now, burst         ) {
    this.capacity = perMinute > 0 ? perMinute : Number.POSITIVE_INFINITY
    this.refillPerMs = perMinute > 0 ? perMinute / 60000 : Number.POSITIVE_INFINITY
    this.now = now
    this.burst = burst ?? Math.max(1, Math.floor(perMinute / 4))
  }

  /** 还要等多少毫秒才能拿到一个令牌（0 = 现在就能拿）。 */
  waitMs(key        )         {
    if (!Number.isFinite(this.capacity)) return 0
    const bucket = this.peek(key)
    if (bucket.tokens >= 1) return 0
    const needed = 1 - bucket.tokens
    return Math.ceil(needed / this.refillPerMs)
  }

  /** 试着拿一个令牌；成功返回 true。 */
  tryTake(key        )          {
    if (!Number.isFinite(this.capacity)) return true
    const bucket = this.peek(key)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /**
   * 等到有令牌为止（**带取消**）。
   *
   * 每一轮 sleep 都重新计算，所以中途被别的调用抢走令牌也不会死等。
   */
  async acquire(key        , signal              )                {
    for (;;) {
      if (signal?.aborted === true) throw new Error('已取消（等待限速令牌时被中止）')
      const wait = this.waitMs(key)
      if (wait <= 0) {
        if (this.tryTake(key)) return
        continue
      }
      await sleep(Math.min(wait, 1000), signal)
    }
  }

  /** 当前可用令牌数（诊断用）。 */
  tokens(key        )         {
    return this.peek(key).tokens
  }

          peek(key        )                                        {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      // 新桶从「突发量」开始，而不是满桶 —— 否则插件一启动就会对每个账号
      // 连打 perMinute 发，正好是上游风控最敏感的时刻。
      bucket = { tokens: Math.min(this.capacity, this.burst), updatedAt: now }
      this.buckets.set(key, bucket)
      return bucket
    }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs)
      bucket.updatedAt = now
    }
    return bucket
  }
}

/** 可取消的 sleep。 */
export function sleep(ms        , signal              )                {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = ()       => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * 并发闸门：`max` 个槽位，超出的排队。
 *
 * 活动任务批量执行时用它把并发压住（任务书要求「并发上限」可配置）。
 */
export class Semaphore {
                   max        
          active = 0
                   queue                    = []

  constructor(max        ) {
    this.max = Math.max(1, max)
  }

  get inFlight()         {
    return this.active
  }

  get queued()         {
    return this.queue.length
  }

  async run   (task                  )             {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

          acquire()                {
    if (this.active < this.max) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

          release()       {
    this.active -= 1
    const next = this.queue.shift()
    if (next !== undefined) next()
  }
}


//# sourceURL=src/core/cache.ts