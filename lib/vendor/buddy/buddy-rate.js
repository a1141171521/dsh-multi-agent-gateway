/**
 * WorkBuddy / CodeBuddy 系的**计费倍率**解析。
 *
 * 事实来源：`dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/buddy.ts`
 * （`normalizeCreditsRate` / `normalizeDiscountedRate` / `normalizeRate` /
 * `parsePromotions`），逐条对齐语义。
 *
 * ## 上游的两套写法（这是本文件存在的理由）
 *
 * 同一后端下发倍率时用了**两种相反的写法**，实测（2026-10-20，workbuddy-intl）：
 *
 * | 来源 | 写法 | 样本 |
 * |---|---|---|
 * | `data.models[].credits` | **x 在前** | `"x0.29"` / `"x0.34 credits"` / `"x0.00"` |
 * | `data.modelPromotions[].discount.discountedCredits` | **x 在后** | `"0.50x"` / `"0x"` |
 *
 * 参考实现的注释原文：早期版本只认前缀写法，于是**促销价全部解析失败且静默丢失**。
 * 故两个「归一化」入口各自保留名字（调用点读起来知道自己在解析哪一种），
 * 但**内部都同时接受两种写法** —— 对上游格式变更更鲁棒（将来两者互换也仍正确）。
 *
 * ## ⚠️ 三条硬要求（都来自参考实现，别改）
 *
 * 1. **解析不出返回 `undefined`，绝不回退成 `x1`** ——
 *    参考实现注释原文：「编造倍率比不显示更糟」。核心层的口径是
 *    `multiplier: undefined` = 未知（UI 显示「未知倍率」），`0` = 免费，**两者不能混**。
 * 2. **`"x0.00"` / `"0x"` 是 `0` = 免费**，是**合法值**，不能当成「缺失」。
 * 3. `""` / 字段缺失 = **未知**，调用方不放 `multiplier` 键。
 */

/** 倍率解析结果。 */
                            
                       
               
                                      
              
 

/**
 * 倍率文本的共用解析：先试前缀写法，再试后缀写法。
 *
 * 两种都接受（而非按调用方区分）是为了对上游格式变更更鲁棒：
 * 实测已经出现过同一后端两套写法共存的情况，若将来它们互换，本函数仍正确。
 *
 * ⚠️ **先按空白切出第一个 token**：实测 `"x0.34 credits"` 带单位后缀，
 * 不切掉就匹配不上（`\b` 在 `x0.34` 与空格之间成立，但后缀写法会被单位干扰）。
 * 这与参考实现的 `normalizeRate` 逐字一致。
 */
function normalizeRate(value         )                        {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  // 去掉可能存在的单位后缀（如 "x0.34 credits"）。
  const head = text.split(/\s+/)[0] ?? ''
  const match = /^(?:x(\d+(?:\.\d+)?))\b/i.exec(head) ?? /^(\d+(?:\.\d+)?)x\b/i.exec(head)
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const parsed = Number(digits)
  // 理论上正则已排除非法数字，这里再挡一次 NaN/Infinity（防御）。
  if (!Number.isFinite(parsed)) return undefined
  return { value: parsed, text: `x${digits}` }
}

/**
 * 归一化 `data.models[].credits`（实测 **x 在前**：`"x0.29"`）。
 *
 * 实测原值（2026-10-20，workbuddy-intl `/v3/config`）：
 * ```
 * default-model           ""                ← 空串 = 无倍率信息 → undefined
 * fast-model              "x0.34 credits"   ← 带单位后缀 → 0.34
 * primary-model           "x3.31 credits"   → 3.31
 * deepseek-v4.1-flash     "x0.00"           ← 0 = 免费（合法值）
 * hy4-preview             "x0.29"
 * ```
 */
export function normalizeCreditsRate(value         )                        {
  return normalizeRate(value)
}

/**
 * 归一化 `data.modelPromotions[].discount.discountedCredits`（实测 **x 在后**：`"0.50x"`）。
 *
 * 与 {@link normalizeCreditsRate} 的**名字分开、实现相同**：名字让调用点读起来知道
 * 自己在解析哪一种；实现共用则保证「上游把两种写法互换」时不会挂。
 *
 * 另有一种已结束占位值 `"0x"`，归一化后是 `0`，由调用方排除（见 {@link parseModelPromotions}）。
 */
export function normalizeDiscountedRate(value         )                        {
  return normalizeRate(value)
}

/** `modelPromotions[].schedule`（活动时段）。 */
                             
                                                      
                                                       
                                     
                    
                              
                     
                              
                      
 

/** 解析 `HH:MM`（容忍不补零）为当日分钟数；非法返回 undefined。 */
function parseHHMM(value         )                     {
  if (typeof value !== 'string') return undefined
  const matched = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (matched === null) return undefined
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  return hour < 24 && minute < 60 ? hour * 60 + minute : undefined
}

/**
 * 取指定时区「当前墙上时间」的当日分钟数。
 *
 * ⚠️ 用 `Intl` 而非手算 UTC 偏移：活动时区由服务端下发（实测 `Asia/Shanghai`），
 * 硬编码 +8 在其它时区的活动上会算错。（参考实现同款理由。）
 */
function zonedMinutes(now      , timeZone         )                     {
  const zone = typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'Asia/Shanghai'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now)
    const hour = Number(parts.find((part) => part.type === 'hour')?.value)
    const minute = Number(parts.find((part) => part.type === 'minute')?.value)
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : undefined
  } catch {
    // 时区字符串非法（上游改了格式）时返回 undefined，由调用方按「不误杀」处理。
    return undefined
  }
}

/** 活动是否带任何时间窗口（每日时段或有效期）。 */
function hasTimeWindow(schedule                   )          {
  return (
    (Array.isArray(schedule.daily) && schedule.daily.length > 0) ||
    schedule.validFrom !== undefined ||
    schedule.validUntil !== undefined
  )
}

/**
 * 活动在 `now` 是否生效。
 *
 * ⚠️ **必须本地推算，不能只看 `enabled`**：`enabled: true` 只表示活动启用，
 * 是否**此刻**打折由 `schedule` 决定。参考实现实测 `glm-5.2` 有两条互补活动
 * （夜间 `23:00–7:50` 带 `0.50x` 折扣、白天 `7:50–23:00` 只带角标），
 * 不看时段就会**全天**显示夜间折扣价（用户按折扣价预期、实际被按原价计费）。
 */
export function promotionActiveNow(item                         , now      )          {
  const raw = item.schedule
  if (typeof raw !== 'object' || raw === null) return true
  const schedule = raw                     

  const from = typeof schedule.validFrom === 'string' ? Date.parse(schedule.validFrom) : Number.NaN
  const until = typeof schedule.validUntil === 'string' ? Date.parse(schedule.validUntil) : Number.NaN
  if (Number.isFinite(from) && now.getTime() < from) return false
  if (Number.isFinite(until) && now.getTime() >= until) return false

  if (!Array.isArray(schedule.daily) || schedule.daily.length === 0) return true
  const minutes = zonedMinutes(now, schedule.timezone)
  // 时区不可解析时不误杀：宁可多显示一次折扣，也不要让活动凭空消失。
  if (minutes === undefined) return true
  return schedule.daily.some((slot) => {
    if (typeof slot !== 'object' || slot === null) return false
    const start = parseHHMM((slot                       ).start)
    const end = parseHHMM((slot                     ).end)
    if (start === undefined || end === undefined) return false
    // 支持跨零点（如 23:00–7:50）。
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  })
}

/** 读取促销项的 priority；缺失或非法时按 0（最低）处理。 */
function priorityOf(item         )         {
  if (typeof item !== 'object' || item === null) return 0
  const priority = (item                           ).priority
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0
}

/**
 * 从 `data.modelPromotions` 提取「模型 id → **此刻生效的**促销倍率」映射。
 *
 * 真实结构（**数组**，不是对象；每项按 `modelIds` 关联，不是全局）：
 * ```json
 * [{ "kind": "discount", "enabled": true, "priority": 100,
 *    "discount": { "discountedCredits": "0.50x", "displayMode": "strikethrough", "factor": 0.5 },
 *    "badge": { "color": "#1E90FF", "label": "夜间折扣" },
 *    "schedule": { "daily": [{ "start": "23:00", "end": "7:50" }], "timezone": "Asia/Shanghai" },
 *    "modelIds": ["glm-5.2"] }]
 * ```
 *
 * 四个必须处理的退化情形（参考实现逐条实测换来的）：
 * - **时段未到 / 已过**（`schedule`）—— 跳过，见 {@link promotionActiveNow}；
 * - **有效期已过**（`validFrom`/`validUntil`）—— 跳过；
 * - `enabled: false` —— 已停用，跳过；
 * - 同一模型命中多条 —— 取 `priority` **最高**者。
 *
 * ⚠️ **`factor: 0` 是「免费」而非「活动已结束」**：参考实现实测 `hy4-preview` 的
 * 夜间活动是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` ——
 * 它**真的免费**。早期实现把 `0x` 当哨兵丢弃，于是「夜间免费」永远不显示
 * （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。**真正的「已结束」由有效期表达**。
 * 作为防御：**无任何时间窗口**的 `factor: 0` 仍按「已结束占位」跳过 ——
 * 免费额度必然是限时的，没有窗口的 `0x` 更可能是遗留占位。
 */
export function parseModelPromotions(
  record                         ,
  now       = new Date(),
)                         {
  const result = new Map                   ()
  /** id → 已写入的 priority（同 id 多活动时高优先级覆盖）。 */
  const chosen = new Map                ()
  const promotions = record.modelPromotions
  if (!Array.isArray(promotions)) return result
  // 按 priority 升序排序后依次写入，使高 priority 覆盖低 priority。
  const sorted = [...promotions].sort((a, b) => priorityOf(a) - priorityOf(b))
  for (const item of sorted) {
    if (typeof item !== 'object' || item === null) continue
    const promotion = item                           
    if (promotion.enabled === false) continue
    if (!promotionActiveNow(promotion, now)) continue
    const discount = promotion.discount
    if (typeof discount !== 'object' || discount === null) continue
    const detail = discount                           
    const factor = typeof detail.factor === 'number' ? detail.factor : undefined
    const rawSchedule = promotion.schedule
    const windowed =
      typeof rawSchedule === 'object' && rawSchedule !== null && hasTimeWindow(rawSchedule                     )

    let rate                       
    if (factor === 0) {
      // 免费额度必须限时；无窗口的 `0x` 视为「已结束」占位（保持与参考实现一致的行为）。
      if (!windowed) continue
      // ⚠️ 展示文本用 `免费`（与参考实现同款）：`factor: 0` 是**语义上的一句断言**
      //    （「这条活动让它此刻免费」），不是「倍率是 0」这个数字。
      //    实测 2026-10-20 的三条活动（hy3 / deepseek-v4.1-flash / step-5-preview）
      //    全是 `factor: 0` + `discountedCredits: "0x"` + `validUntil: 2026-11-01`。
      rate = { value: 0, text: '免费' }
    } else {
      rate = normalizeDiscountedRate(detail.discountedCredits)
      // 归一化后仍是 `x0`/`0` 说明是无 factor 的 `0x` 占位，同样跳过。
      if (rate !== undefined && rate.value === 0) continue
    }
    if (rate === undefined) continue

    const modelIds = promotion.modelIds
    if (!Array.isArray(modelIds)) continue
    const priority = priorityOf(promotion)
    for (const id of modelIds) {
      if (typeof id !== 'string' || id.length === 0) continue
      const previous = chosen.get(id)
      if (previous !== undefined && previous > priority) continue
      chosen.set(id, priority)
      result.set(id, rate)
    }
  }
  return result
}

/**
 * 组合计费倍率的展示文案：有促销时标出**原价→促销价**，否则只显示原价。
 *
 * 形态：`"x0.29→x0.15"`；无促销时 `"x0.03"`。
 *
 * ⚠️ **促销是活动价，不能把原价丢掉** —— 只显示促销价会让用户按折扣预期、
 * 实际被按原价计费时无从对账。用箭头而非「（促销 x…）」是因为这段文案会被拼进
 * **模型选择菜单的名字**里，菜单宽度有限，箭头更短且一眼看出折扣幅度。
 * （文案形态与参考实现的 `formatCreditsRate` 一致。）
 *
 * 返回 `undefined` 表示**两段都没有**（= 倍率未知，调用方不要编造）。
 */
export function formatCreditsRate(rate                       , discounted                       )                     {
  if (rate === undefined) return discounted?.text
  return discounted !== undefined ? `${rate.text}→${discounted.text}` : rate.text
}


//# sourceURL=src/vendor/buddy/buddy-rate.ts