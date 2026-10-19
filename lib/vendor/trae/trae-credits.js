/**
 * TRAE 每日签到与积分余额。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae-credits.ts`。
 * 本模块只放**可单测的纯解析与分类函数**；网络请求在适配器里发（这样解析逻辑
 * 能被 fixture 直接覆盖，不必 mock fetch）。
 *
 * ## 端点与响应形状
 *
 * ### 签到状态
 * ```
 * POST /trae/api/v2/ug/checkin_credits/status   body {}
 * → { checked_in: bool, credits: int64, enable: bool }
 * ```
 *
 * ### 签到领取
 * ```
 * POST /trae/api/v2/ug/checkin_credits/claim    body {}
 * → { code: 0, message: "success" }
 * ```
 *
 * ### 积分余额
 * ```
 * POST /trae/api/v2/pay/ide_user_ent_usage
 * body {"require_usage": true, "req_source": 2}
 * → { user_entitlement_pack_list: [ ... ] }
 * remain = ∑(credits_limit - credits_amount)
 * ```
 *
 * ## 三条真实缺陷换来的纪律
 *
 * 1. **claim 响应不含积分数**。实测它的完整响应就是 `{"code":0,"message":"success"}`。
 *    早期实现读 `body.credits` 因此恒为 0，界面显示「领取成功 +0 积分」，
 *    而 IDE 里明明写着 150。真实数值只在 **status 端点**的 `credits` 字段里。
 *    故这里明确暴露「领取后需要补查状态」这件事（见 `TraeClaimOutcome.needsStatusRefresh`）。
 * 2. **业务码可能是字符串**。后端在部分网关上以 `"9074"` 返回，只认 number 会把
 *    失败误判为成功（code=0）。见 {@link readTraeClaimCode}。
 * 3. **`0` 是合法业务码**（成功），且**字段缺失也当 0**（上游的成功响应不带 code）。
 *    所以判据是「数字且 != 0 才算失败」，而不是 falsy 判据。
 */

import { readNumberField, readStringField } from './trae-identity.js'

/**
 * 签到业务码 **9074**：「签到人数过多」。
 *
 * ⚠️ 它的限流范围是 **device_id 而非账号**（见 {@link isTraeCheckinBusy}）——
 * 这条事实决定了它的处理方式是「轮换设备号 + 重试」，而不是「判死」。
 */
export const TRAE_CHECKIN_BUSY_CODE = 9074

/** 签到业务码 **9074**：「签到人数过多」。 */
export const TRAE_CHECKIN_BUSY = TRAE_CHECKIN_BUSY_CODE

/**
 * 读取业务码，兼容**数字与字符串**形态。
 *
 * ⚠️ **不能只 `typeof === 'number'`**：后端在部分网关上以字符串 `"9074"` 返回，
 * 只认数字会误判为成功（code=0）。
 *
 * ⚠️ 字段**缺失**返回 `0`（= 成功）：上游的成功响应本来就是
 * `{"code":0,"message":"success"}`，而有些网关会省略 `code`。
 * 反过来「字段存在但不是数字」返回 `-1`（= 认不出的失败），
 * 这样它既不会被当成成功、也不会静默消失。
 */
export function readTraeClaimCode(body                         )         {
  const raw = body.code
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim())
  return raw === undefined ? 0 : -1
}

/** 签到结果分类。 */
                                  
                                         
               
                       
              
                                
                 
                     
              
                      
            
                         
            
                         
                   
                   
             

/** 签到错误分类 + 建议冷却时长。 */
                                   
                            
                                                
                      
 

/**
 * 分类签到错误，返回类型与冷却时间。
 *
 * 对齐参考实现（trae-mate `cooldown.rs:classify_error`）：
 * - `200` + `code=1005` → PlanLimit, 43200s (12h)
 * - HTTP 429 → SoftRate, 60s
 * - HTTP 401 → SessionDead, **永久**
 * - HTTP 404 → NotFound, 60s
 * - 5xx → Server, 600s
 * - 4xx → Client, 600s
 * - 业务码非 0 → BusinessError, 300s
 * - 成功 / 无码 → Unknown, 不冷却
 */
export function classifyTraeCheckinError(httpStatus        , code                    )                   {
  if (httpStatus === 200 && code === 1005) return { type: 'PlanLimit', cooldownSecs: 43_200 }
  if (httpStatus === 429) return { type: 'SoftRate', cooldownSecs: 60 }
  if (httpStatus === 401) return { type: 'SessionDead', cooldownSecs: -1 }
  if (httpStatus === 404) return { type: 'NotFound', cooldownSecs: 60 }
  if (httpStatus >= 500 && httpStatus < 600) return { type: 'Server', cooldownSecs: 600 }
  if (httpStatus >= 400 && httpStatus < 500) return { type: 'Client', cooldownSecs: 600 }
  if (code !== undefined && code !== 0) return { type: 'BusinessError', cooldownSecs: 300 }
  return { type: 'Unknown', cooldownSecs: 0 }
}

/**
 * **9074（签到人数过多）是可重试的**，不是失败。
 *
 * ## 为什么它不该被判死
 *
 * 参考实现记录：9074 的限流范围是 **device_id 而非账号** —— 同一个账号在某个
 * id 上签到返回 9074 后，换一个**全新派生**的 id 立刻就能签到成功。
 * 所以命中 9074 时正确做法是「轮换签到设备号 + 稍后重试」，而不是告诉用户
 * 「签到失败」让他明天再来。
 *
 * 本插件里对应的动作由适配器完成：把 `traeCheckinDeviceGeneration` 加一，
 * 派生一个新的签到设备号（见 `deriveCheckinDeviceId`），并回报
 * `retryable: true` 让调度器稍后再来。
 *
 * ⚠️ 但**不要在一次调用里无限重试**：参考实现给 9074 的是 300s 冷却。
 */
export function isTraeCheckinBusy(code        )          {
  return code === TRAE_CHECKIN_BUSY_CODE
}

/** 签到状态解析结果。 */
                                    
                          
                 
                               
                         
     
                              
    
                                           
                                                       
     
                     
                                        
                    
                                        
                      
 

/**
 * 解析签到状态响应。
 *
 * 上游形状：`{ checked_in: bool, credits: int64, enable: bool }`
 *
 * ⚠️ `checked_in` 必须是**严格 `=== true`**：上游在字段缺失时不下发它，
 * 而 `undefined` 与 `false` 在这里的下一步动作不同（缺失 = 上游没说，
 * 我们应当保守地**不**声称「已签到」）。返回 `false` 是保守方向 ——
 * 它会让我们去尝试领取，而 TRAE 的 claim 对「今天已签到」是**幂等**的
 * （重复领取同样返回成功），所以多试一次的代价只是多一次往返。
 * 反过来若把 `undefined` 当成「已签到」，用户就真的领不到了。
 */
export function parseTraeCheckinStatus(body                         )                    {
  return {
    active: body.enable === true,
    todayCheckedIn: body.checked_in === true,
    dailyCredit: readNumberField(body, 'credits') ?? 0,
    streakDays: readNumberField(body, 'streak_days') ?? 0,
    totalCredits: readNumberField(body, 'total_credits') ?? 0,
  }
}

/** 一个积分包的解析结果。 */
                                    
                                                  
              
                 
                                               
                   
                              
               
                                    
              
                          
                           
 

/** 积分余额解析结果。 */
                                    
                 
               
                               
 

/**
 * 解析积分余额响应（对齐参考实现 `calc_remaining_credits`）。
 *
 * 上游形状：`{ user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit }, display_desc }, usage: { credits_amount }, expire_time }, …] }`
 *
 * ⚠️ **`credits_limit <= 0` 的条目跳过**：上游会下发额度为 0 的占位包，
 * 把它们算进来只会让「剩余」看起来比实际少（0 不影响求和，但会污染 UI 的包列表）。
 *
 * ⚠️ **包名用 `display_desc`，不是 `base.name`** —— 参考实现实测 `base.name`
 * 为 `undefined`，旧代码因此全部回退成了「资源包」这种无信息量的名字。
 *
 * ⚠️ **`expire_time` 是秒级 Unix 时间戳，必须 ×1000**。实测
 * `1790783999` = 2026-09-30 23:59:59，与官方 UI 的「2026/09/30 23:59 到期」
 * 逐条吻合。不乘会让显示落在 1970 年。
 *
 * @returns 没有可解析的包时返回 `undefined`（而不是一个 `total: 0` 的假余额）——
 *   「没有数据」与「余额是 0」是两件事，界面必须能区分。
 */
export function parseTraeCreditBalance(body                         )                                {
  const packList = body.user_entitlement_pack_list ?? body.UserEntitlementPackList
  if (!Array.isArray(packList) || packList.length === 0) return undefined

  const packages                      = []
  let total = 0

  for (const item of packList) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item                           
    const base = entry.entitlement_base_info ?? entry.EntitlementBaseInfo
    if (typeof base !== 'object' || base === null) continue
    const baseRecord = base                           
    const quota = baseRecord.quota ?? baseRecord.Quota
    if (typeof quota !== 'object' || quota === null) continue
    const creditsLimit = readNumberField(quota                           , 'credits_limit')
    if (creditsLimit === undefined || creditsLimit <= 0) continue

    const usage = entry.usage ?? entry.Usage
    const used = typeof usage === 'object' && usage !== null
      ? (readNumberField(usage                           , 'credits_amount') ?? 0)
      : 0

    const expireSec = readNumberField(entry, 'expire_time') ?? readNumberField(entry, 'expireTime')
    const deductionEndMs = expireSec !== undefined && expireSec > 0 ? expireSec * 1000 : undefined

    const pkg                    = {
      name: readStringField(baseRecord, 'display_desc')
        || readStringField(baseRecord, 'displayDesc')
        || readStringField(entry, 'display_desc')
        || '资源包',
      unit: 'credits',
      // ⚠️ 剩余可能是负数（上游下发过 used > limit 的情况）——**如实保留**，
      // 不 `Math.max(0, …)`：负数是一个有信息量的异常信号，抹平它只会让人
      // 以为额度正常。
      remaining: creditsLimit - used,
      total: creditsLimit,
      used,
      ...(deductionEndMs === undefined ? {} : { deductionEndTime: deductionEndMs }),
    }
    packages.push(pkg)
    total += pkg.remaining
  }

  if (packages.length === 0) return undefined
  return { total, packages }
}

/** 取签到设备轮换代次（跨重启持久化在适配器缓存里）。 */
export function readCheckinGeneration(cached         )         {
  if (typeof cached !== 'object' || cached === null) return 0
  const value = (cached                           ).generation
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** 构造签到设备的缓存载荷。 */
export function checkinGenerationPayload(generation        )                         {
  return { generation: Math.max(0, Math.floor(generation)) }
}


//# sourceURL=src/vendor/trae/trae-credits.ts