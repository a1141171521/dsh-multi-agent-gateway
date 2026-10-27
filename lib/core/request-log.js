/**
 * **逐请求采样**：把每一次对话调用记成一行，供「日志」页与「总览」的 KPI 使用。
 *
 * ## 为什么要记
 *
 * 出问题时用户能给的只有一句「刚才报错了」。没有逐请求记录，就只能靠猜：
 * 是哪个平台、哪个模型、哪个账号、耗时多少、首字等了多久、上游原话是什么。
 *
 * ## 记什么（以及刻意不记什么）
 *
 * 记：时间、平台、模型、账号、结果、耗时、首字、速度、token 细分、倍率、失败原因。
 * **不记**：请求体、响应体、任何凭证。日志是给排查用的，不是抓包。
 *
 * ## 速度怎么算
 *
 * `tps = 输出 token / 解码耗时`，而解码耗时 = 总耗时 − 首字延迟。
 * 拿总耗时当分母会把首字延迟算进速度里，长提示的请求会被严重低估；
 * 窗口过短（< 50ms）时不给结论（`undefined`），否则一个 1ms 的窗口能算出
 * 几万 tok/s，把整页的均值带飞。
 */

import { JsonlLog } from './store.js'
                                                   

/** 一条请求记录。字段全部是可选的「不知道就不写」，不拿 0 冒充未知。 */
                                  
                  
            
                                           
                 
               
                   
                                          
               
     
                                                     
    
                                            
                                               
                                              
                                     
                                 
     
                    
     
                                  
    
                                             
    
                                                       
                                               
    
                                           
                                                         
                                                     
                                            
                                                                       
     
                          
              
             
                 
                    
                                  
                 
                                        
              
                      
                       
                          
                        
                     
                
     
                                   
    
                                                 
                                              
                                              
                                                          
    
                                                              
                                                 
     
                       
                              
                
 

/** 汇总视图（总览页的 KPI 与汇总表）。 */
                                 
               
                        
               
            
                
                     
                      
                         
                           
                          
                           
                       
                  
                   
                 
                 
                  
                       
                        
                         
                      
    
                                                                                                       
                          
                              
 

/** 解码速度的下限：窗口短于此就不给结论。 */
const MIN_DECODE_MS = 50

/** 算一个请求的速度；样本不足返回 undefined。 */
export function computeTps(input   
                    
                 
                       
 )                     {
  const { durationMs, ttftMs, outputTokens } = input
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) return undefined
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) return undefined
  const decodeMs = durationMs - ttftMs
  if (!Number.isFinite(decodeMs) || decodeMs < MIN_DECODE_MS) return undefined
  return Math.round((outputTokens / (decodeMs / 1000)) * 10) / 10
}

/** 本地日期键（用于「今天」）。 */
function dayKey(ts        )         {
  const date = new Date(ts)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** 平均值的辅助：忽略 undefined，空集返回 null。 */
function mean(values                   )                {
  if (values.length === 0) return null
  let sum = 0
  for (const value of values) sum += value
  return Math.round((sum / values.length) * 10) / 10
}

/**
 * 请求日志：内存环形缓冲 + JSONL 追加落盘。
 *
 * 内存里保存最近 `maxEntries` 条（新的在前），查询与汇总都走内存；
 * 磁盘只是为了让重启后还能看到昨天的记录。
 */
export class RequestLog {
                   file          
                   maxEntries        
                   log                    
  /** 新的在前。 */
          entries                    = []

  constructor(path        , options                                        = {}) {
    this.maxEntries = Math.max(50, Math.floor(options.maxEntries ?? 2000))
    this.log = options.log
    // 磁盘上限比内存略大，滚动时不至于把内存里还在显示的记录也删掉。
    this.file = new JsonlLog(path, Math.floor(this.maxEntries * 1.5), options.log)
    this.load()
  }

  /** 从磁盘恢复最近若干条（新的在前）。 */
          load()       {
    const rows = this.file.tail(this.maxEntries)                     
    this.entries = rows
      .filter((row) => row !== null && typeof row === 'object' && typeof (row                   ).ts === 'number')
      .reverse()
    if (this.entries.length > 0) this.log?.debug(`请求日志已载入 ${this.entries.length} 条`)
  }

  /** 记一条。返回落库后的记录（补齐 ts）。 */
  record(input                                               )                  {
    const entry                  = {
      ...input,
      ts: typeof input.ts === 'number' ? input.ts : Date.now(),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      ...(input.ttftMs === undefined ? {} : { ttftMs: Math.max(0, Math.round(input.ttftMs)) }),
      ...(input.error === undefined ? {} : { error: String(input.error).slice(0, 300) }),
    }
    this.entries.unshift(entry)
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries
    this.file.append(entry)
    return entry
  }

  /** 分页查询（新的在前）。 */
  list(options                                      = {})                                                {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 20)))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    return { total: this.entries.length, entries: this.entries.slice(offset, offset + limit) }
  }

  /** 清空（内存 + 磁盘）。 */
  clear()       {
    this.entries = []
    this.file.clear()
  }

  /** 汇总。 */
  summary(now = Date.now())                 {
    const today = dayKey(now)
    let ok = 0
    let failed = 0
    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let todayCount = 0
    const ttfts           = []
    const tpss           = []
    const models = new Map                                           ()
    /** 每个模型的 ttft / tps 样本，边遍历边收集（避免再扫一遍全表）。 */
    const samples = new Map                                           ()
    const agents = new Map                                                                                                    ()

    for (const entry of this.entries) {
      if (dayKey(entry.ts) === today) todayCount += 1
      if (entry.ok) ok += 1
      else failed += 1
      inputTokens += entry.inputTokens ?? 0
      outputTokens += entry.outputTokens ?? 0
      reasoningTokens += entry.reasoningTokens ?? 0
      if (typeof entry.ttftMs === 'number') ttfts.push(entry.ttftMs)
      if (typeof entry.tps === 'number') tpss.push(entry.tps)

      const modelKey = `${entry.agentId}\u0000${entry.model}`
      const modelRow = models.get(modelKey) ?? {
        agentId: entry.agentId,
        model: entry.model,
        calls: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        ttftMs: null,
        tps: null,
      }
      modelRow.calls += 1
      if (!entry.ok) modelRow.failed += 1
      modelRow.inputTokens += entry.inputTokens ?? 0
      modelRow.outputTokens += entry.outputTokens ?? 0
      models.set(modelKey, modelRow)

      const bucket = samples.get(modelKey) ?? { ttft: [], tps: [] }
      if (typeof entry.ttftMs === 'number') bucket.ttft.push(entry.ttftMs)
      if (typeof entry.tps === 'number') bucket.tps.push(entry.tps)
      samples.set(modelKey, bucket)

      const agentRow = agents.get(entry.agentId) ?? {
        agentId: entry.agentId,
        agentName: entry.agentName,
        calls: 0,
        failed: 0,
        models: new Set        (),
      }
      agentRow.calls += 1
      if (!entry.ok) agentRow.failed += 1
      agentRow.models.add(entry.model)
      agents.set(entry.agentId, agentRow)
    }

    // 每个模型的均值单独算（不能用全局均值糊过去）
    for (const [key, row] of models) {
      const bucket = samples.get(key)
      row.ttftMs = bucket === undefined ? null : mean(bucket.ttft)
      row.tps = bucket === undefined ? null : mean(bucket.tps)
    }

    return {
      total: this.entries.length,
      today: todayCount,
      ok,
      failed,
      inputTokens,
      outputTokens,
      reasoningTokens,
      avgTtftMs: mean(ttfts),
      avgTps: mean(tpss),
      byModel: [...models.values()].sort((left, right) => right.calls - left.calls),
      byAgent: [...agents.values()]
        .map((row) => ({
          agentId: row.agentId,
          agentName: row.agentName,
          calls: row.calls,
          failed: row.failed,
          models: row.models.size,
        }))
        .sort((left, right) => right.calls - left.calls),
      last: this.entries[0] ?? null,
    }
  }
}


//# sourceURL=src/core/request-log.ts