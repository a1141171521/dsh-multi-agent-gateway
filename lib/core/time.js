/**
 * **服务端日界**（UTC+8）的时间工具。
 *
 * ## 为什么必须集中在这一份里
 *
 * 本插件管的平台**按 UTC+8 结算每日额度**：
 *
 *   - Qoder 的每日领取活动在**每日 10:00（UTC+8）刷新**（服务端原文：
 *     `"每日 10:00（UTC+8）刷新，领取后 30 天有效"`）；
 *   - 其余平台的「今天」同样是服务端的 UTC+8 业务日。
 *
 * 而 `new Date(at).toISOString().slice(0, 10)` 给的是 **UTC 日**，与 UTC+8 日
 * 在每天 00:00–08:00（UTC+8）之间**不是同一天**。用它做「今天签过了没」的幂等键
 * 会在这 8 小时里把同一天算成两天 —— 表现是**跨零点重复领取**，或者反过来
 * 把该领的那天记成已领而**整天漏领**。
 *
 * ⚠️ 必须用**算术平移**而不是 `Date.getHours()` / 本机时区：日界归服务端，
 * 取本机时区会在用户出差 / 改系统时区时得到错的「今天」（偏东提前记为已处理 → 真漏领，
 * 偏西一天判两次）。口径与 `dsh-our-free-model` 的 `QODER_BILLING_UTC_OFFSET_MS` 一致。
 */

/** UTC+8 相对 UTC 的毫秒偏移。**不按本机时区算**。 */
export const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000

/** Qoder 每日活动的刷新时刻（UTC+8 的小时）。来源是服务端自己下发的文案。 */
export const QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10

/** 把绝对时刻平移到「UTC+8 的墙上时间」，再当 UTC 读。 */
function shifted(at        )       {
  return new Date(at + UTC8_OFFSET_MS)
}

/**
 * 取服务端业务日（UTC+8）的 `YYYY-MM-DD`。
 *
 * 幂等键、每日记录、跨天判定的**唯一**日期来源。
 */
export function utc8DateString(at         = Date.now())         {
  return shifted(at).toISOString().slice(0, 10)
}

/** 服务端业务日（UTC+8）的小时（0–23）。 */
export function utc8Hour(at         = Date.now())         {
  return shifted(at).getUTCHours()
}

/**
 * 「今天的每日活动是否已经刷新」。
 *
 * 用于 Qoder 这类**活动列表本身按日刷新**的平台：在刷新时刻**之前**看到的
 * `CLAIMED` 属于**昨天那一轮**，不能推断「今天已领」。判错的代价是方向性的 ——
 * 说成「已领取」会让用户真的错过今天的额度。
 *
 * ⚠️ 早于刷新时刻时，调用方应报「今天还没刷新，稍后再来」（可重试），
 * 而**不是**「已领取」，也不是「没有可领取的活动」。
 */
export function hasUtc8HourPassed(hour        , at         = Date.now())          {
  return utc8Hour(at) >= hour
}

/** Qoder 专用便捷入口：今天的活动列表刷新了没。 */
export function hasQoderCampaignRefreshedToday(at         = Date.now())          {
  return hasUtc8HourPassed(QODER_CAMPAIGN_REFRESH_HOUR_UTC8, at)
}


//# sourceURL=src/core/time.ts