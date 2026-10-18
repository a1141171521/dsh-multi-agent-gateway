/**
 * 模型**可用性探测**：这台机器现在能不能真的用上某个模型。
 *
 * ## 为什么需要
 *
 * 上游的模型目录是「声明」，不是「承诺」：同一个 id，有的地区直接 403
 * （`RegionError: This model is not available in your country`），有的上游临时
 * 下线（`Model is unavailable`），有的只对带 key 的账号开放。用户在对话框里选中
 * 之后才撞墙，而且报错文本和「账号坏了」长得一模一样。
 *
 * 所以对每个模型发一次**极小**的真实请求，把结论缓存在本地，界面上标成徽章。
 *
 * ## 四种判定，以及**什么不算判定**
 *
 *   - `available`      200 —— 真的能出字
 *   - `region-blocked` 403 + 地区关键词 —— 这个模型对本地不放行
 *   - `unavailable`    404 / 「模型不存在或不支持」 —— 上游已下线
 *   - `unknown`        其余一切（超时、断网、5xx、429、401、免费层门禁）
 *
 * **关键纪律**：`unknown` 不是「不可用」。上游抽风、限流、本机 IP 被免费层封禁，
 * 都不能记成「这个模型坏了」—— 那会把一个本来能用的模型永久标灰。
 * 所以只有拿到**针对该模型**的明确答复，才升级成 available / unavailable。
 */

/** 探测结论。 */
                                                                                          

/** 一次探测的结果（缓存项）。 */
                                   
                 
                           
                   
            
                              
                 
                                      
                 
 

/** 探测参数。 */
export const PROBE_DEFAULTS = {
  /** 同时在跑的探测数。上游对并发敏感，3 已经够快。 */
  concurrency: 3,
  /** 单模型超时。探测只等首帧，20 秒已经非常宽。 */
  timeoutMs: 20_000,
  /** 缓存多久后视为过期（界面仍显示旧值，只是标灰）。 */
  staleAfterMs: 30 * 60 * 1000,
}         

/** 一次探测尝试的原始结果（由调用方负责真的发请求）。 */
                               
                                    
                 
                           
               
                                      
                
                              
                
                  
                 
 

/** 地区限制的文案特征。上游措辞变过好几次，这里覆盖已知的几种。 */
const REGION_PATTERNS = [
  /not available in your country/i,
  /not available in your region/i,
  /region(?:al)?\s*(?:not supported|restricted|blocked)/i,
  /unsupported[_ ]country/i,
  /country[_ ]not[_ ]supported/i,
]

/** 「这个模型没了」的文案特征。 */
const GONE_PATTERNS = [
  /model is unavailable/i,
  /model not found/i,
  /unknown model/i,
  /no such model/i,
  /model .* (?:does not exist|is not supported)/i,
]

function textOfAttempt(attempt              )         {
  if (typeof attempt.text === 'string' && attempt.text !== '') return attempt.text
  if (attempt.body === undefined || attempt.body === null) return ''
  try {
    return JSON.stringify(attempt.body)
  } catch {
    return ''
  }
}

/**
 * 把一次探测的原始结果判成四态。
 *
 * 顺序很重要：先排除「这不是对模型的判定」的情况，再看状态码。
 */
export function classifyProbeOutcome(attempt              )                    {
  const status = attempt.status
  const text = textOfAttempt(attempt)

  // 网络层失败：没有拿到任何答复，谈不上判定
  if (status === undefined) return 'unknown'
  // 成功：拿到 200 就算这个模型对本地可用（哪怕内容只有几个 token）
  if (status >= 200 && status < 300) return 'available'

  // 地区限制优先于一切：它是**针对该模型**的明确答复
  if (REGION_PATTERNS.some((pattern) => pattern.test(text))) return 'region-blocked'

  // 403 但没有地区特征 —— 可能是免费层门禁（针对机器而非模型）、也可能是真没权限。
  // 一律记 unknown：宁可显示「未探测」，也不要把能用的模型标灰。
  if (status === 403) return 'unknown'
  if (status === 401) return 'unknown'

  // 404 / 「模型不存在」：上游明确说这个 id 不路由了
  if (status === 404) return 'unavailable'
  if (GONE_PATTERNS.some((pattern) => pattern.test(text))) return 'unavailable'

  // 400：请求形状问题。只有正文明确指向模型时才归到模型头上
  if (status === 400) {
    if (/(model|模型)/i.test(text) && /(invalid|unsupported|unknown|不存在|不支持)/i.test(text)) {
      return 'unavailable'
    }
    return 'unknown'
  }

  // 429 限流、5xx 上游故障、408 超时：都不是模型的错
  return 'unknown'
}

/** 缓存项是否已经过期（界面据此标灰，但仍显示旧结论）。 */
export function isStale(result                              , now = Date.now())          {
  return now - result.at > PROBE_DEFAULTS.staleAfterMs
}

/**
 * 并发跑一批探测。
 *
 * 用固定大小的 worker 池（而不是 `Promise.all` 一把梭）：上游对并发敏感，
 * 85 个模型同时打过去只会换来一片 429，而 429 又会被判成 unknown ——
 * 等于白跑一轮还把缓存写脏。
 *
 * 单个模型的失败**不会中断整批**（`attempt` 抛错按 unknown 记）。
 */
export async function runProbeBatch(
  ids                   ,
  attempt                                            ,
  options   
                        
                                                 
                      
    = {},
)                              {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? PROBE_DEFAULTS.concurrency))
  const now = options.now ?? (() => Date.now())
  const results                     = new Array(ids.length)
  let cursor = 0

  const worker = async ()                => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= ids.length) return
      const modelId = ids[index]          
      let outcome              
      try {
        outcome = await attempt(modelId)
      } catch (error) {
        outcome = { error: error instanceof Error ? error.message : String(error) }
      }
      const status = classifyProbeOutcome(outcome)
      const detail =
        status === 'available'
          ? undefined
          : (outcome.error ?? textOfAttempt(outcome)).slice(0, 300) || undefined
      const result                   = {
        modelId,
        status,
        at: now(),
        ...(detail === undefined ? {} : { detail }),
        ...(status === 'available' && typeof outcome.ttftMs === 'number' ? { ttftMs: Math.round(outcome.ttftMs) } : {}),
      }
      results[index] = result
      options.onResult?.(result)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, () => worker())
  await Promise.all(workers)
  return results.filter((item) => item !== undefined)
}

/** 把一批结果合并进缓存（返回新对象，不改入参）。 */
export function mergeProbeCache(
  cache                                            ,
  results                             ,
)                                   {
  const next                                   = { ...cache }
  for (const result of results) next[result.modelId] = result
  return next
}

/** 界面上用的短标签（宿主侧也给一份，保证两侧同口径）。 */
export function availabilityLabel(status                   )         {
  switch (status) {
    case 'available':
      return '可用'
    case 'region-blocked':
      return '地区受限'
    case 'unavailable':
      return '不可用'
    default:
      return '未探测'
  }
}


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\core\probe.ts