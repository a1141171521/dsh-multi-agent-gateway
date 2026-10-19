/**
 * WorkBuddy / CodeBuddy（腾讯系）的**签到与积分余额**协议层。
 *
 * 事实来源：`dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/credits.ts`
 * （实测日期 2026-09-14 / 09-15，逆向 WorkBuddy 5.5.6 + 真实请求）。本文件只保留
 * 「与上游对话的纯逻辑」，**不持有 ctx / 不发请求** —— 发请求由 `buddy.ts` 用
 * `ctx.http` 完成，这里只负责构造请求描述与解析响应。这样解析规则可以脱离
 * 网络单测，也正是本模块唯一能被真实验证的部分（本机没有 WorkBuddy 账号）。
 *
 * ## 两个端点，两套形状（最容易解析错的地方）
 *
 * | 用途 | 路径 | 响应的 data 层 |
 * |---|---|---|
 * | 签到状态 | `/v2/billing/meter/checkin-activity-status` | **单层** `data.{today_checked_in,…}` |
 * | 领取     | `/v2/billing/meter/daily-checkin`             | **单层** `data.{credit,streak_days,…}` |
 * | 积分余额 | `/v2/billing/meter/get-user-resource`         | **双层** `data.Response.Data.Accounts[]` |
 *
 * 余额那层的双层嵌套是它独有的，别把签到那套单层写法套上去（参考实现点名的坑）。
 */

/** 签到状态查询端点（**权威**状态源）。 */
export const CHECKIN_ACTIVITY_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'

/** 每日签到领取端点。 */
export const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'

/** 积分余额查询端点（**两个产品通用**，见 `buddy.ts` 的能力表说明）。 */
export const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'

/**
 * ⚠️ **存在但不要用**的端点：`/v2/billing/meter/checkin-status`。
 *
 * 它返回的是**占位数据**（`active: false`、`checkin_dates: null`、
 * `claim_button_text: ""`），照着它判定会**永远显示「未签到」**。（参考实现实测结论。）
 *
 * 这里把名字留成常量而不是删掉，是为了让「我们为什么没用它」这件事在代码里
 * 看得见 —— 否则下一个人看到内核里有 `checkin-status` 会以为是漏了。
 */
export const PLACEHOLDER_CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-status'

/**
 * 「今天已签到」的业务码（实测值）。
 *
 * ⚠️ 重复领取返回的是 **HTTP 400 + code 10001**，不是 200。所以 **400 不能一律
 * 当失败** —— 幂等判据是响应体的 `code`，不是 HTTP 状态码。
 */
export const CODE_ALREADY_CLAIMED = 10001

/**
 * 静态分析列出的备选码表：`1001`=已领取 `1002`=无资格 `1003`=活动结束。
 *
 * 参考实现把 `1001` 与 `10001` 同等看待（都算「已领取」）。这三个码**没有**像
 * `10001` 那样被实测确认过，属「静态分析推断」，故在注释里区分开。
 */
export const CODE_ALREADY_CLAIMED_ALT = 1001
export const CODE_NO_QUALIFICATION = 1002
export const CODE_ACTIVITY_ENDED = 1003

/** 签到活动状态（字段名已由上游的 snake_case 转为 camelCase）。 */
                                     
                                 
                 
                                  
                         
                
                    
                
                     
                
                     
                    
                      
                
                      
                                     
                        
                     
                      
                          
                   
                
                 
 

/** 一次领取的结论。 */
                               
                                                                                                          
                                                
                                                                   
                                                     

/** `get-user-resource` 响应里 `Accounts[]` 的一项（一个资源包）。 */
                                     
                                                                   
              
                                                 
              
                                                     
                   
                  
               
                   
              
                                                    
                 
                        
                      
                     
                                               
                           
 

/** 账号的积分余额汇总。 */
                                     
                                        
               
                                     
                                
                                        
                      
 

/**
 * 服务端标记「该资源包已过期」的 `Status` 值（实测）。
 *
 * 实测某 CodeBuddy 账号 5 个包里，两个带 `ExpiredTime` 的条目 `Status` 均为 3，
 * 三个有效条目为 0。**其他未知取值一律当成有效** —— 宁可多显示一个额度，
 * 也不要把能用的额度藏起来。
 */
const PACKAGE_STATUS_EXPIRED = 3

// ───────────────────────────── 安全读取 ─────────────────────────────

/** 从 JSON 安全读布尔值。 */
function readBool(source                         , key        )          {
  return source[key] === true
}

/** 从 JSON 安全读数字（非有限数字按 0 处理）。 */
function readNumber(source                         , key        )         {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 从 JSON 安全读字符串。 */
function readString(source                         , key        )         {
  const value = source[key]
  return typeof value === 'string' ? value : ''
}

/** 从 JSON 安全读字符串数组。 */
function readStringArray(source                         , key        )           {
  const value = source[key]
  return Array.isArray(value) ? value.filter((item)                 => typeof item === 'string') : []
}

/** 把未知值收窄成「非 null 的对象」。 */
function asRecord(value         )                                 {
  return typeof value === 'object' && value !== null ? (value                           ) : null
}

// ───────────────────────────── 解析 ─────────────────────────────

/**
 * 解析签到状态响应（`checkin-activity-status`）。
 *
 * 返回 `null` = **「查不到」**（响应不是对象 / 业务码非 0 / 缺 `data`）。
 * 刻意与「活动未开启」（返回对象且 `active: false`）区分开：前者是「不知道」，
 * 后者是「知道，就是没开」。混成一个值会让调用方把网络故障显示成「未签到」。
 */
export function parseCheckinStatus(body         )                            {
  const envelope = asRecord(body)
  if (envelope === null) return null
  if (envelope.code !== 0) return null
  const data = asRecord(envelope.data)
  if (data === null) return null
  return {
    active: readBool(data, 'active'),
    todayCheckedIn: readBool(data, 'today_checked_in'),
    streakDays: readNumber(data, 'streak_days'),
    dailyCredit: readNumber(data, 'daily_credit'),
    todayCredit: readNumber(data, 'today_credit'),
    isStreakDay: readBool(data, 'is_streak_day'),
    totalCredits: readNumber(data, 'total_credits'),
    checkinDates: readStringArray(data, 'checkin_dates'),
    activityName: readString(data, 'activity_name'),
    themeName: readString(data, 'theme_name'),
    endTime: readString(data, 'end_time'),
  }
}

/**
 * 解析领取响应（`daily-checkin`）。
 *
 * **判定顺序**：非致命类别（已领取 / 无资格 / 活动结束）→ 成功 → failed。
 * 判定以响应体 `code` 为准 —— 重复领取是 HTTP 400，只看状态码会把幂等误报为失败。
 *
 * ⚠️ **「需要用户先去别处操作」单独成一类**：`actionRequired` 把「等一会儿」
 * 与「你得去做点什么」变成**显式语义**，而不是藏在中文文案里让 UI 去猜。
 * 参考实现的原话：前端（纯 JS、无类型检查）只能靠「有没有 message」去猜，
 * 那条行动指引混在计数行里会被读漏。
 *
 * ⚠️ 目前**没有**把 `1002` / `1003` 标成 `actionRequired: true`：参考实现把这两个
 * 码归为普通 `inactive`。本机无账号，无法确认这两个码在真实场景下是否真需要
 * 用户操作，**故不臆造**。判定留在这里是为了将来拿到证据后一处改。
 */
export function parseClaimOutcome(body         )                    {
  const envelope = asRecord(body)
  if (envelope === null) return { kind: 'failed', code: -1, message: '领取响应不是 JSON 对象' }
  const code = typeof envelope.code === 'number' ? envelope.code : -1
  const message = readString(envelope, 'msg')

  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    // 「今天已签」的正确措辞：这是**幂等命中**，不是失败。
    return { kind: 'already-claimed', message: message.length > 0 ? message : '今天已签到' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { kind: 'inactive', message: message.length > 0 ? message : '当前无领取资格' }
  }
  if (code !== 0) {
    return { kind: 'failed', code, message: message.length > 0 ? message : '领取失败' }
  }
  const data = asRecord(envelope.data)
  if (data === null) return { kind: 'failed', code, message: '领取响应缺少 data 字段' }
  const delayed = readString(data, 'message')
  return {
    kind: 'claimed',
    credit: readNumber(data, 'credit'),
    streakDays: readNumber(data, 'streak_days'),
    isStreakDay: readBool(data, 'is_streak_day'),
    ...(delayed.length > 0 ? { delayedMessage: delayed } : {}),
  }
}

/**
 * 读一个数值字段，**优先取带 `Precise` 后缀的精确版本**。
 *
 * 实测：`CapacityRemain` = 247（整数、截断），`CapacityRemainPrecise` = `"247.87"`
 * （字符串、两位小数）。**IDE 显示的是后者**，故精确值优先；精确值缺失或无法解析
 * 时回退到整数版，保证老响应格式仍能读出数字。
 */
function readPreciseNumber(source                         , baseKey        )         {
  const precise = source[`${baseKey}Precise`]
  if (typeof precise === 'string') {
    const parsed = Number.parseFloat(precise)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof precise === 'number' && Number.isFinite(precise)) return precise
  return readNumber(source, baseKey)
}

/**
 * 从 `get-user-resource` 的一个 Account 条目解析资源包。
 *
 * 包名回退链 `PackageName` → `SubProductName` → `PackageCode`：实测两个产品都会
 * 下发 `PackageName`，但企业版等变体可能只有其中之一，故逐级回退而不是显示空串。
 *
 * 余额取 **`CycleCapacityRemain`（本周期口径）**，不是 `CapacityRemain`（终身口径）：
 * 实测某账号终身口径求和 655.67，而 IDE 显示 155.67 —— 差额 500 正是那个
 * 「终身还剩 500、但本周期已一分不剩」的体验版包。用错字段数字会凭空多一大截，
 * 且**用户无从核对**。
 */
export function parseCreditPackage(entry                         , now        )                     {
  const name =
    readString(entry, 'PackageName') ||
    readString(entry, 'SubProductName') ||
    readString(entry, 'PackageCode')
  const unit = readString(entry, 'CapacityUnit') || readString(entry, 'OriginUnit')
  const status = entry.Status
  const expiredTime = readString(entry, 'ExpiredTime')
  // 扣费截止时间（毫秒）。0 / 缺失 = 服务端未下发，按「未知」而非「已过期」处理。
  const deductionEndTime = readNumber(entry, 'DeductionEndTime')

  // 失效判定三条：Status 显式为已过期、ExpiredTime 已过、扣费截止已过。
  // ⚠️ 判「会不会近期作废」只能用 `DeductionEndTime`：有效包的 `ExpiredTime`
  // 实测**一律为空串**（只在包真正失效后才由服务端回填），而订阅类套餐的
  // `CycleEndTime` 很短（2 天）却 8 年后才停止扣费 —— 取 CycleEndTime 会把
  // 每月正常刷新的套餐误判成「快作废」。
  const expiredAt = expiredTime.length > 0 ? Date.parse(expiredTime.replace(' ', 'T')) : Number.NaN
  const active =
    status !== PACKAGE_STATUS_EXPIRED &&
    !(Number.isFinite(expiredAt) && now >= expiredAt) &&
    !(deductionEndTime > 0 && now >= deductionEndTime)

  return {
    name,
    unit,
    remaining: readPreciseNumber(entry, 'CycleCapacityRemain'),
    total: readPreciseNumber(entry, 'CycleCapacitySize'),
    used: readPreciseNumber(entry, 'CycleCapacityUsed'),
    active,
    cycleStartTime: readString(entry, 'CycleStartTime'),
    cycleEndTime: readString(entry, 'CycleEndTime'),
    expiredTime,
    ...(deductionEndTime > 0 ? { deductionEndTime } : {}),
  }
}

/**
 * 把额度规整为两位小数。
 *
 * 用 `Math.round(v * 100) / 100` 而不是 `toFixed` 后 parse：后者对负数与极大值的
 * 行为不一致，且返回字符串会污染数值类型。服务端精确值本身带浮点表示
 * （如 `55.67000031`），多包相加会把尾数噪声显式化 —— 金额展示到分即可。
 */
export function roundCredits(value        )         {
  return Math.round(value * 100) / 100
}

/**
 * 解析积分余额响应（`get-user-resource`）。
 *
 * 返回 `null` = **「查不到」**（网络失败 / 业务码非 0 / 结构不符），与「余额为 0」
 * 严格区分 —— 让调用方**不要把网络故障显示成 0 积分**。
 *
 * ⚠️ `data` 是**双层嵌套**：`data.Response.Data.Accounts[]`。逐层校验，任一层缺失
 * 即视为不可解析。这与签到端点的单层 `data` 不同，是本接口最容易解析错的地方。
 *
 * `total` **只累加有效包**：失效包里的额度服务端仍会返回，但不能用于扣费，
 * 并进总额会让数字虚高（实测某账号因此从 155.67 变成 655.67）。
 */
export function parseCreditBalance(body         , now        )                            {
  const envelope = asRecord(body)
  if (envelope === null) return null
  if (envelope.code !== 0) return null

  const outer = asRecord(envelope.data)
  if (outer === null) return null
  const response = asRecord(outer.Response)
  if (response === null) return null
  const inner = asRecord(response.Data)
  if (inner === null) return null
  const accounts = inner.Accounts
  if (!Array.isArray(accounts)) return null

  const packages                       = []
  for (const item of accounts) {
    const entry = asRecord(item)
    if (entry === null) continue
    packages.push(parseCreditPackage(entry, now))
  }
  return {
    total: roundCredits(packages.reduce((sum, pkg) => sum + (pkg.active ? pkg.remaining : 0), 0)),
    packages,
    // 失效包的余额单独汇总，供 UI 提示「另有 N 已失效」——既不误导也不丢信息。
    expiredTotal: roundCredits(packages.reduce((sum, pkg) => sum + (pkg.active ? 0 : pkg.remaining), 0)),
  }
}

/**
 * 把单位串归一到**展示口径**，返回 `'token'` 或 `'credit'`。
 *
 * 存在的理由（参考实现的真实缺陷）：服务端把同一个单位拼成两种写法 —— 实测逐包
 * 原值有 `CapacityUnit: 'credit'`（Bonus Pack 241.78）与 `'credits'`
 * （Free Plan Subscription 100）。按**原始字符串**分组会让 `credit` 与 `credits`
 * 各成一组，界面于是把同一个账号渲染两次。
 *
 * ⚠️ 口径：**分组键必须与展示名同源**。凡展示层会显示成「积分」的单位串，
 * 就必须落进同一个分组。`token` 与积分**不互相折算**（分两组）。
 *
 * ⚠️ **不要用它改写 `BuddyCreditPackage.unit`** —— 那里保留服务端原值。
 * 归一化只发生在「当分组键/展示名用」的那一步。
 */
export function normalizeCreditUnit(unit        )                     {
  return unit === 'token' ? 'token' : 'credit'
}

/**
 * 额度数值的**展示格式化**（积分：整数不带小数，有小数保留两位）。
 *
 * 积分**不压缩**：现实量级是 `123456.78`（IDE 顶部就是这个精度），
 * 压成 `123.46K` 会让用户无法与官方界面核对。
 */
export function formatCreditAmount(value        )         {
  if (!Number.isFinite(value)) return '?'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}


//# sourceURL=src/adapters/buddy-credits.ts