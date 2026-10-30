/**
 * WorkBuddy / CodeBuddy 签到与积分余额的单测。
 *
 * ## ⚠️ 本文件**没有任何真上游验证**（诚实声明）
 *
 * 本机**没有 WorkBuddy / CodeBuddy 账号**，所以下面所有用例都是**单测**：
 * 用假的 `ctx.http` 灌入响应体，断言解析与分支判定。它们能证明「代码符合我们
 * 对上游的理解」，**不能**证明「理解符合上游」。
 *
 * ## fixture 出处（每一段都标了来源，**没有一条是编的**）
 *
 * 字段名与结构来自参考实现 clone
 * `E:\AIProject\DeepSeekPlugin\.scratch\dsh-our-free-model`（MIT）：
 *
 * | fixture | 出处 |
 * |---|---|
 * | 签到状态字段名（`today_checked_in` / `streak_days` / `daily_credit` / `is_streak_day` / `checkin_dates` / `activity_name` / `theme_name` / `end_time`） | `vendor/channel-pack/src/credits.ts` 的 `fetchCheckinStatus`（第 393–418 行）—— 逐字段照抄读取器，字段名即抓包字段名 |
 * | 领取成功 `{code:0, data:{credit:100,…}}` | `credits.ts` 模块头第 17 行：「真实领取成功（code:0, credit:100）并可见状态翻转」（2026-09-14 实测） |
 * | 幂等 `HTTP 400 + code 10001` | `credits.ts` 模块头第 19 行 + `claimDailyCheckin` 的 `CODE_ALREADY_CLAIMED`（2026-09-14 实测） |
 * | 备选码 `1001` / `1002` / `1003` | `credits.ts` 第 58–61 行（注释明写是**静态分析推断**，非实测 —— 本文件照此标注） |
 * | 余额双层嵌套 `data.Response.Data.Accounts[]` | `credits.ts` 第 536–556 行（`fetchCreditBalance`，2026-09-15 实测「两站结构完全一致」） |
 * | `CapacityRemain: 247` vs `CapacityRemainPrecise: "247.87"` | `credits.ts` 第 467–470 行（实测原值） |
 * | `Status: 3` = 已过期（有效包为 0） | `credits.ts` 第 481–488 行（实测某账号 5 个包） |
 * | 单位两种写法 `'credit'` / `'credits'` | `credits.ts` 第 600–604 行（实测逐包原值：Bonus Pack 241.78 / Free Plan Subscription 100） |
 * | 终身口径 655.67 vs 周期口径 155.67 | `credits.ts` 第 186–191 行（实测同一响应） |
 * | `DeductionEndTime` 实测分布（9 天 / 3008 天） | `vendor/channel-pack/src/buddy-balance-rank.ts` 第 22–27 行（2026-09-29 实测表格） |
 *
 * 组装成完整响应信封时补了 `name` 等**形状性字段**（如包名 "Bonus Pack"），
 * 那些名字同样取自上面的实测注释，不是自创。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BuddyAdapter, BUDDY_CN, BUDDY_INTL, capabilitiesFor, parseModelsFromConfig } from '../../lib/adapters/buddy.js'
import {
  CHECKIN_ACTIVITY_STATUS_PATH,
  DAILY_CHECKIN_PATH,
  PLACEHOLDER_CHECKIN_STATUS_PATH,
  USER_RESOURCE_PATH,
  normalizeCreditUnit,
  parseCheckinStatus,
  parseClaimOutcome,
  parseCreditBalance,
  parseCreditPackage,
  roundCredits,
} from '../../lib/adapters/buddy-credits.js'
import {
  formatCreditsRate,
  normalizeCreditsRate,
  normalizeDiscountedRate,
  parseModelPromotions,
} from '../../lib/vendor/buddy/buddy-rate.js'
import {
  decideReasoningEffort,
  isDeepSeekModel,
  parseReasoningFields,
} from '../../lib/vendor/buddy/buddy-reasoning.js'

// ───────────────────────────── 假 ctx ─────────────────────────────

/** 一次被记录的调用。 */
function jsonResult(body, status = 200, kind = 'none') {
  return {
    ok: status >= 200 && status < 300,
    status,
    kind,
    headers: new Headers({ 'content-type': 'application/json' }),
    body,
    text: typeof body === 'string' ? body : JSON.stringify(body),
  }
}

/**
 * 假 ctx：按 URL 后缀路由到响应。**记录每次调用**，供「不许发请求」的断言使用。
 *
 * `routes` 的键是路径后缀（如 `'/daily-checkin'`），值可以是响应对象或返回它的函数。
 */
function fakeCtx(routes, { now = 1_760_000_000_000 } = {}) {
  const calls = []
  const ctx = {
    config: { upstream: { apiBaseUrl: '' }, requestTimeoutMs: 5_000 },
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
    http: async (url, init = {}) => {
      const text = String(url)
      calls.push({ url: text, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
      for (const [suffix, handler] of Object.entries(routes)) {
        if (text.endsWith(suffix)) {
          return typeof handler === 'function' ? handler(text, init) : handler
        }
      }
      return jsonResult({ code: 404, msg: `未预期的端点：${text}` }, 404, 'not_found')
    },
    cache: { get: () => undefined, set() {}, delete() {}, keys: () => [] },
    now: () => now,
  }
  return { ctx, calls }
}

/** 一个带凭证的账号。 */
function account(credentials = { token: 'fixture-token' }) {
  return {
    id: 'workbuddy:fixture',
    agentId: 'workbuddy',
    label: 'fixture',
    credentials,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

const CN = new BuddyAdapter(BUDDY_CN)
const INTL = new BuddyAdapter(BUDDY_INTL)

// ─────────────────── 能力差异：国内有签到 / 国际没有 ───────────────────

test('能力表按产品区分：国内 checkIn=true，国际 checkIn=false（其余相同）', () => {
  const cn = capabilitiesFor(BUDDY_CN)
  const intl = capabilitiesFor(BUDDY_INTL)

  assert.equal(cn.checkIn, true, '国内版（CodeBuddy）有每日签到')
  assert.equal(intl.checkIn, false, '国际版没有签到接口')

  // ⚠️ 余额两边都有 —— 「国际版没有签到」不能顺手推出「也查不到余额」。
  //    这是参考实现 2026-09-15 的实测结论，两者是彼此独立的能力。
  assert.equal(cn.quota, true)
  assert.equal(intl.quota, true, '国际版同样有 get-user-resource —— 别一起关掉')

  // 其余能力两边一致
  for (const key of ['models', 'chat', 'reasoning']) {
    assert.equal(cn[key], intl[key], `${key} 不应因产品而不同`)
  }
  assert.equal(cn.tasks, false)
  assert.equal(intl.tasks, false)

  // notes 必须如实：国际版那句要说清「不会发请求」
  assert.match(intl.notes.checkIn, /没有签到接口/)
  assert.match(intl.notes.checkIn, /不会向上游发任何请求/)
  assert.match(cn.notes.checkIn, /daily-checkin/)
})

test('适配器实例上拿到的能力表就是按产品算的那一份', () => {
  assert.equal(CN.capabilities.checkIn, true)
  assert.equal(INTL.capabilities.checkIn, false)
  assert.equal(INTL.capabilities.quota, true)
  // 两个实例不能共用同一个对象（共用就会互相串改）
  assert.notEqual(CN.capabilities, INTL.capabilities)
})

test('★ 国际版 checkIn：不发任何上游请求，直接 supported:false', async () => {
  // 这是参考实现自己承认的洞：它原来的代码会落到 buddy 分支、**真去发一个必然
  // 失败的签到请求**（用国际版凭据打国内版端点）。客户端从不调用它是因为能力表
  // 写着 false，所以一直没被触发 —— 但只要有人调一次就是一次真实的上游请求。
  //
  // ⚠️ 路由表里**故意放了会成功的响应**：如果实现真去发请求，测试会拿到
  //    「签到成功」而不是 supported:false，于是这条用例会以另一种方式失败。
  for (const adapter of [INTL]) {
    const { ctx, calls } = fakeCtx({
      [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({
        code: 0,
        data: { active: true, today_checked_in: false, daily_credit: 100 },
      }),
      [DAILY_CHECKIN_PATH]: jsonResult({ code: 0, data: { credit: 100 } }),
    })
    const result = await adapter.checkIn(account(), ctx)

    assert.equal(result.ok, false)
    assert.equal(result.supported, false, '「上游没有这个接口」必须如实回报，不能报成故障')
    assert.equal(result.kind, undefined, '不支持不是错误分类，不该带 kind')
    assert.match(result.message, /没有「每日签到」接口/)
    assert.match(result.message, /CodeBuddy（国内版）/, '要给出下一步/解释，不能只说「不支持」')

    // ★ 核心断言：一次请求都没发
    assert.equal(calls.length, 0, `国际版签到必须零请求，实际发了 ${calls.length} 次：${JSON.stringify(calls.map((c) => c.url))}`)
  }
})

test('国际版 checkIn 在**没有凭证**时也照样零请求（守卫在凭证检查之前）', async () => {
  // 守卫的顺序很关键：若把「有没有 token」放在产品守卫之前，没凭证的国际版账号
  // 会返回 auth 错误，语义就变成了「补个凭证就能签」—— 而国际版根本没有签到。
  const { ctx, calls } = fakeCtx({})
  const result = await INTL.checkIn(account({}), ctx)
  assert.equal(result.supported, false)
  assert.equal(result.kind, undefined, '不能报成 auth 问题')
  assert.equal(calls.length, 0)
})

// ───────────────────────── 签到状态解析 ─────────────────────────

test('parseCheckinStatus：解析 checkin-activity-status 的单层 data', () => {
  // 字段名逐条来自参考实现 credits.ts 的 fetchCheckinStatus（抓包字段名）。
  const status = parseCheckinStatus({
    code: 0,
    data: {
      active: true,
      today_checked_in: false,
      streak_days: 3,
      daily_credit: 100,
      today_credit: 0,
      is_streak_day: true,
      total_credits: 300,
      checkin_dates: ['2026-09-12', '2026-09-13', '2026-09-14'],
      activity_name: '开学季',
      theme_name: 'Buddy加油站',
      end_time: '2026-09-30 23:59:59',
    },
  })
  assert.equal(status.active, true)
  assert.equal(status.todayCheckedIn, false)
  assert.equal(status.streakDays, 3)
  assert.equal(status.dailyCredit, 100)
  assert.equal(status.isStreakDay, true)
  assert.equal(status.totalCredits, 300)
  assert.deepEqual(status.checkinDates, ['2026-09-12', '2026-09-13', '2026-09-14'])
  assert.equal(status.activityName, '开学季')
  assert.equal(status.themeName, 'Buddy加油站')
})

test('parseCheckinStatus：查不到时返回 null，不返回「未签到」', () => {
  // 「不知道」与「知道，就是没开」必须分开：混成一个值会让网络故障显示成未签到。
  assert.equal(parseCheckinStatus(null), null)
  assert.equal(parseCheckinStatus('not json'), null)
  assert.equal(parseCheckinStatus({ code: 10001, data: {} }), null, '业务码非 0 = 查不到')
  assert.equal(parseCheckinStatus({ code: 0 }), null, '缺 data = 查不到')
  assert.equal(parseCheckinStatus({ code: 0, data: null }), null)
  // 结构缺失时字段全部退化到安全默认值，但仍是一个「有效的状态」
  const degraded = parseCheckinStatus({ code: 0, data: {} })
  assert.equal(degraded.active, false)
  assert.equal(degraded.todayCheckedIn, false)
  assert.deepEqual(degraded.checkinDates, [])
})

test('parseCheckinStatus：字段类型不对时不抛错，退化为默认值', () => {
  const status = parseCheckinStatus({
    code: 0,
    data: { active: 'yes', streak_days: '3', checkin_dates: [1, 'ok', null], activity_name: 42 },
  })
  assert.equal(status.active, false, '非 true 一律 false（不做真值转换）')
  assert.equal(status.streakDays, 0, '字符串数字不当数字用')
  assert.deepEqual(status.checkinDates, ['ok'], '只留字符串项')
  assert.equal(status.activityName, '')
})

test('★ 占位端点 CONSTANT 存在但被标注为「不要用」', () => {
  // 参考实现点名的坑：checkin-status 返回占位数据（active:false、checkin_dates:null、
  // claim_button_text:""），照着它判定会**永远显示「未签到」**。
  // 我们导出这个常量只是为了「为什么没用它」在代码里看得见。
  assert.equal(PLACEHOLDER_CHECKIN_STATUS_PATH, '/v2/billing/meter/checkin-status')
  assert.notEqual(PLACEHOLDER_CHECKIN_STATUS_PATH, CHECKIN_ACTIVITY_STATUS_PATH)
  assert.equal(CHECKIN_ACTIVITY_STATUS_PATH, '/v2/billing/meter/checkin-activity-status')
})

// ───────────────────────── 领取与幂等 ─────────────────────────

test('parseClaimOutcome：领取成功读出 credit / streak_days', () => {
  // 出处：credits.ts 模块头「真实领取成功（code:0, credit:100）」+ claimDailyCheckin 的
  // `data.credit` / `data.streak_days` / `data.is_streak_day` / `data.message`。
  const outcome = parseClaimOutcome({
    code: 0,
    data: { credit: 100, streak_days: 4, is_streak_day: true },
  })
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 100)
  assert.equal(outcome.streakDays, 4)
  assert.equal(outcome.isStreakDay, true)
  assert.equal(outcome.delayedMessage, undefined)
})

test('★ parseClaimOutcome：HTTP 400 + code 10001 判为「今天已签到」而不是失败', () => {
  // 幂等的判据是**响应体的 code**，不是 HTTP 状态码 —— 重复领取返回的是 400。
  // 只看状态码会把「今天已领」误报成「领取失败」，自动签到于是反复重试。
  const outcome = parseClaimOutcome({ code: 10001, msg: '今天已签到，请明天再来' })
  assert.equal(outcome.kind, 'already-claimed')
  assert.equal(outcome.message, '今天已签到，请明天再来')
})

test('parseClaimOutcome：1001 也按「已领取」处理（静态分析备选码）', () => {
  // ⚠️ 1001 来自参考实现的**静态分析**，不像 10001 那样有实测记录。见 credits.ts 第 58 行。
  const outcome = parseClaimOutcome({ code: 1001 })
  assert.equal(outcome.kind, 'already-claimed')
  assert.equal(outcome.message, '今天已签到', '没有 msg 时给一句默认文案')
})

test('parseClaimOutcome：1002 / 1003 是 inactive，且**不**标 actionRequired', () => {
  // ⚠️ 参考实现把这两个码归为普通 inactive。本机无账号，无法确认它们在真实场景下
  // 是否真需要用户操作，**故不臆造** actionRequired。
  for (const [code, label] of [[1002, '无资格'], [1003, '活动结束']]) {
    const outcome = parseClaimOutcome({ code, msg: `code ${code}` })
    assert.equal(outcome.kind, 'inactive', `${label} 应为 inactive`)
    assert.equal(outcome.actionRequired, undefined, `${label} 不该被标成需要用户操作`)
  }
})

test('parseClaimOutcome：其它非 0 码是真实失败，带上原始码', () => {
  const outcome = parseClaimOutcome({ code: 50000, msg: '系统繁忙' })
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.code, 50000)
  assert.equal(outcome.message, '系统繁忙')

  // code 缺失 → -1，不是 0（0 是成功，缺字段绝不能成功）
  const missing = parseClaimOutcome({ msg: 'no code' })
  assert.equal(missing.kind, 'failed')
  assert.equal(missing.code, -1)
})

test('parseClaimOutcome：code 0 但缺 data → 失败，不谎报成功', () => {
  const outcome = parseClaimOutcome({ code: 0 })
  assert.equal(outcome.kind, 'failed')
  assert.match(outcome.message, /缺少 data/)
})

// ─────────────────── 适配器层：签到分支 ───────────────────

test('国内版签到：状态说今天已签 → ok:true、credits:0，且**不发领取请求**', async () => {
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({
      code: 0,
      data: { active: true, today_checked_in: true, today_credit: 100, streak_days: 5 },
    }),
    [DAILY_CHECKIN_PATH]: jsonResult({ code: 0, data: { credit: 100 } }),
  })
  const result = await CN.checkIn(account(), ctx)

  assert.equal(result.ok, true, '「今天已领」是幂等命中，不是失败')
  assert.equal(result.supported, true)
  assert.equal(result.credits, 0, '本次没有新到账，credits 必须是 0（不能报 +100）')
  assert.match(result.message, /今天已签到/)
  assert.match(result.message, /连续 5 天/)
  assert.equal(calls.length, 1, '预检已判定今天领过，不该再发领取请求')
  assert.ok(calls[0].url.endsWith(CHECKIN_ACTIVITY_STATUS_PATH))
})

test('国内版签到：活动未开启 → 不发领取请求，也不说「已领取」', async () => {
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({
      code: 0,
      data: { active: false, today_checked_in: false, activity_name: '开学季' },
    }),
    [DAILY_CHECKIN_PATH]: jsonResult({ code: 0, data: { credit: 100 } }),
  })
  const result = await CN.checkIn(account(), ctx)

  assert.equal(result.ok, false)
  assert.equal(result.supported, true, '活动没开不是「上游没有接口」')
  assert.match(result.message, /未开启/)
  assert.match(result.message, /开学季/)
  assert.equal(calls.length, 1)
})

test('国内版签到：可以领 → 发领取请求并读回 credit', async () => {
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({
      code: 0,
      data: { active: true, today_checked_in: false, daily_credit: 100 },
    }),
    [DAILY_CHECKIN_PATH]: jsonResult({ code: 0, data: { credit: 100, streak_days: 1 } }),
  })
  const result = await CN.checkIn(account(), ctx)

  assert.equal(result.ok, true)
  assert.equal(result.supported, true)
  assert.equal(result.credits, 100)
  assert.match(result.message, /\+100 积分/)
  assert.equal(calls.length, 2, '先查状态再领取')
  assert.ok(calls[1].url.endsWith(DAILY_CHECKIN_PATH))
  // 两个请求的 body 都是 '{}'（实测口径：这两个端点都收空对象体）
  assert.equal(calls[0].body, '{}')
  assert.equal(calls[1].body, '{}')
  // POST，不是 GET
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[1].method, 'POST')
})

test('★ 国内版签到：领取接口回 400 + 10001 → ok:true「今天已签到」', async () => {
  // 这是本模块最容易写错的一条：HTTP 层 `ok:false`，但业务上这是**成功**。
  const { ctx } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({ code: 0, data: { active: true, today_checked_in: false } }),
    [DAILY_CHECKIN_PATH]: jsonResult({ code: 10001, msg: '今天已签到，请明天再来' }, 400, 'bad_request'),
  })
  const result = await CN.checkIn(account(), ctx)

  assert.equal(result.ok, true, '400 不能一律当失败 —— 幂等就是 400')
  assert.equal(result.supported, true)
  assert.equal(result.credits, 0)
  assert.match(result.message, /今天已签到/)
  assert.equal(result.kind, undefined, '不该带错误分类，否则上层会记成故障')
})

test('国内版签到：状态接口 404 → supported:false（该上游没有这个接口）', async () => {
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult('<html>not found</html>', 404, 'not_found'),
  })
  const result = await CN.checkIn(account(), ctx)

  assert.equal(result.ok, false)
  assert.equal(result.supported, false, '404 = 端点不存在 = 不是故障')
  assert.match(result.message, /404/)
  assert.equal(calls.length, 1, '404 之后不该再试领取')
})

test('国内版签到：状态接口 500 → supported:true + kind（真实故障，要能重试）', async () => {
  const { ctx } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({ code: 50000, msg: '系统繁忙' }, 500, 'server'),
  })
  const result = await CN.checkIn(account(), ctx)

  assert.equal(result.ok, false)
  assert.equal(result.supported, true, '上游有接口只是这次挂了 —— 与「没有接口」不同')
  assert.equal(result.kind, 'server')
})

test('国内版签到：状态查询失败（网络）后**仍继续尝试领取**，不误判为已领', async () => {
  // 「不知道」不等于「不能领」：状态为 null 时交给领取接口以响应体 code 定夺。
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: { ok: false, status: 0, kind: 'network', headers: new Headers(), body: undefined, text: '', message: 'socket hang up' },
  })
  const result = await CN.checkIn(account(), ctx)

  assert.equal(result.supported, true, '不能报成「上游没有接口」')
  assert.equal(result.kind, 'network')
  assert.equal(calls.length, 1, '状态查询在传输层就失败了，不该再发领取请求')
})

test('国内版签到：没有凭证 → supported:true + kind:auth', async () => {
  const { ctx, calls } = fakeCtx({})
  const result = await CN.checkIn(account({}), ctx)
  assert.equal(result.ok, false)
  assert.equal(result.supported, true)
  assert.equal(result.kind, 'auth')
  assert.equal(calls.length, 0)
})

test('国内版签到：凭据失效时给「重新登录」而不是「响应不是 JSON」', async () => {
  // 真实缺陷（参考实现）：凭据过期时腾讯网关回的是 **HTML 错误页**。
  // 若照搬解析层的「不是 JSON 对象」，用户看不出该重新登录。
  const { ctx } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({ code: 0, data: { active: true, today_checked_in: false } }),
    [DAILY_CHECKIN_PATH]: jsonResult('<html><body>401</body></html>', 401, 'auth'),
  })
  const result = await CN.checkIn(account(), ctx)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'auth')
  assert.match(result.message, /重新登录/, `实际：${result.message}`)
})

test('签到请求头：头族与参考实现 checkinHeaders 逐条对齐，不加多余的头', async () => {
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({ code: 0, data: { active: true, today_checked_in: true } }),
  })
  await CN.checkIn(account({ token: 'tok-1', user_id: 'u_1', enterprise_id: 'ent_1' }), ctx)

  const headers = calls[0].headers
  assert.equal(headers.authorization, 'Bearer tok-1')
  assert.equal(headers.accept, 'application/json', '这两类接口回 JSON 不是 SSE')
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(headers['x-domain'], 'copilot.tencent.com', 'X-Domain 以产品为准')
  assert.equal(headers['x-product-code'], 'codebuddy')
  assert.equal(headers['x-user-id'], 'u_1')
  assert.equal(headers['x-enterprise-id'], 'ent_1')
  assert.equal(headers['x-tenant-id'], 'ent_1')
  assert.equal(headers['user-agent'], 'CodeBuddyIDE/1.106.1')
  // 实测（参考实现）：该头非必需，带上去只增加失败面
  assert.equal(headers['x-device-token'], undefined, 'X-Device-Token 实测非必需，不要加')
  // 对话形态的那三个头，签到/余额路径不带
  assert.equal(headers['x-agent-purpose'], undefined, 'X-Agent-Purpose 是对话形态头')
  assert.equal(headers['x-ide-name'], undefined)
  assert.equal(headers['x-ide-type'], undefined)
  assert.equal(headers['x-ide-version'], undefined)
})

test('★ 签到请求头：X-Product 发 SaaS（照抄参考实现实测过的取值）', async () => {
  // 参考实现**自己内部不一致**，这里刻意选有证据的那一边：
  //   - 对话路径（buddy-adapter.ts:1787）发 attributionName（'CodeBuddy' / 'WorkBuddy'），
  //     且那条路径的注释说「历史实现发成 SaaS 导致后台归因不到产品」；
  //   - 签到/余额路径（credits.ts:281）发 BUDDY_DEPLOYMENT_TYPE = 'SaaS'，**没跟着改**。
  //
  // credits.ts 模块头记录的「真实领取成功（code:0, credit:100）」那次实测，
  // 发的就是 SaaS。发 attributionName 在签到端点上没有任何实测证据。
  // 取舍不对称：照抄 SaaS 最坏是后台归因列显示 `-`；换掉若被端点校验，
  // 最坏是签到与额度整个不可用。本机无账号，故选有证据的那个。
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({ code: 0, data: { active: true, today_checked_in: true } }),
    [USER_RESOURCE_PATH]: jsonResult({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  })
  await CN.checkIn(account(), ctx)
  await CN.getQuota(account(), ctx)

  assert.equal(calls[0].headers['x-product'], 'SaaS', '照抄 credits.ts 的实测取值')
  assert.equal(calls[1].headers['x-product'], 'SaaS', '余额端点同族，取值一致')

  // ⚠️ 与对话路径**故意不同**：那条路发归属名。把这个差异钉住，
  //    免得将来有人「统一」成其中一个而不知道有实测依据的差别。
  const { buddyHeaders } = await import('../../lib/adapters/buddy.js')
  assert.equal(buddyHeaders(BUDDY_CN, 't', 'hy3')['x-product'], 'CodeBuddy', '对话路径仍发归属名')
})

test('签到请求头：user_id 的 snake_case 与 camelCase 都认', async () => {
  // 参考实现用 snake_case（user_id / enterprise_id，见 BuddyCredential）；
  // 本插件其他适配器习惯短名。手工粘贴凭据的用户可能写成任一种 ——
  // 只认一种会**静默少发头**，账号/企业标识就丢了。
  const { ctx, calls } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  })
  await CN.getQuota(account({ token: 't', userId: 'camel', enterpriseId: 'ent' }), ctx)
  assert.equal(calls[0].headers['x-user-id'], 'camel')
  assert.equal(calls[0].headers['x-enterprise-id'], 'ent')

  const { ctx: ctx2, calls: calls2 } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  })
  await CN.getQuota(account({ token: 't', user_id: 'snake' }), ctx2)
  assert.equal(calls2[0].headers['x-user-id'], 'snake')
})

test('签到请求头：空串的标识**不**发出（不能用 ?? 判空）', async () => {
  // `credential.user_id ?? undefined` 这类写法会把空串当成有值，于是发出一个空头。
  // 参考实现用 `!== undefined && length > 0` 两个条件，方向一致。
  const { ctx, calls } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  })
  await CN.getQuota(account({ token: 't', user_id: '', enterprise_id: '' }), ctx)
  assert.equal(calls[0].headers['x-user-id'], undefined)
  assert.equal(calls[0].headers['x-enterprise-id'], undefined)
  assert.equal(calls[0].headers['x-tenant-id'], undefined)
})

test('签到请求头：X-Domain 跟产品走，不跟凭据里的旧 domain 走', async () => {
  // 参考实现点名的坑：凭据的 domain 是「登录时用的域名」的快照，产品改版后旧凭据
  // 仍写着 copilot.tencent.com；跟着凭据走会把国际版的请求标成国内区域。
  const { ctx, calls } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  })
  await INTL.getQuota(account({ token: 't', domain: 'copilot.tencent.com' }), ctx)
  assert.equal(calls[0].headers['x-domain'], 'www.workbuddy.ai', '必须以产品配置为准')
  assert.equal(calls[0].headers['x-product-code'], 'workbuddy')
  assert.equal(calls[0].headers['user-agent'], 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
})

// ───────────────────────── 余额解析 ─────────────────────────

test('★ parseCreditBalance：双层嵌套 data.Response.Data.Accounts[]', () => {
  // 出处：credits.ts 第 536–556 行（「注意 data 是双层嵌套，这与签到端点的单层
  // 结构不同，是本接口最容易解析错的地方」）。数值取实测原值：
  // CapacityRemain=247 / CapacityRemainPrecise="247.87"（credits.ts 第 467 行）。
  const balance = parseCreditBalance(
    {
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                PackageName: 'Bonus Pack',
                CapacityUnit: 'credit',
                CapacityRemain: 247,
                CapacityRemainPrecise: '247.87',
                CycleCapacityRemain: 100,
                CycleCapacityRemainPrecise: '100.00',
                CycleCapacitySize: 200,
                CycleCapacityUsed: 100,
                Status: 0,
                ExpiredTime: '',
                DeductionEndTime: Date.now() + 3008 * 24 * 3600 * 1000,
              },
            ],
          },
        },
      },
    },
    Date.now(),
  )
  assert.notEqual(balance, null)
  assert.equal(balance.packages.length, 1)
  assert.equal(balance.packages[0].name, 'Bonus Pack')
  assert.equal(balance.packages[0].unit, 'credit', '保留服务端原值，不做归一化')
  // 取**周期**口径 100，不是终身口径 247.87
  assert.equal(balance.packages[0].remaining, 100, '必须取 CycleCapacityRemain 而不是 CapacityRemain')
  assert.equal(balance.packages[0].total, 200)
  assert.equal(balance.packages[0].used, 100)
  assert.equal(balance.packages[0].active, true)
  assert.equal(balance.packages[0].deductionEndTime > 0, true)
  assert.equal(balance.total, 100)
  assert.equal(balance.expiredTotal, 0)
})

test('★ 只累加有效包：失效包的余额进 expiredTotal，不进 total', () => {
  // 出处：credits.ts 第 563–574 行 —— 实测某账号因把失效包并进总额，数字从
  // 155.67 虚高到 655.67。差额 500 正是「终身还剩 500、本周期已一分不剩」的体验版包。
  const now = Date.now()
  const balance = parseCreditBalance(
    {
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              // 有效包：周期剩 155.67
              { PackageName: 'Bonus Pack', CapacityUnit: 'credit', CycleCapacityRemainPrecise: '155.67', Status: 0, ExpiredTime: '' },
              // 失效包：Status 3（实测「3 = 已过期」），终身还剩 500
              { PackageName: 'CodeBuddy个人体验版', CapacityUnit: 'credits', CycleCapacityRemain: 500, Status: 3, ExpiredTime: '2026-06-02 00:00:00' },
            ],
          },
        },
      },
    },
    now,
  )
  assert.equal(balance.packages.length, 2)
  assert.equal(balance.packages[1].active, false, 'Status 3 = 已过期')
  assert.equal(balance.total, 155.67, 'total 只算有效包，与 IDE 顶部读数一致')
  assert.equal(balance.expiredTotal, 500, '失效额度单独汇总，供 UI 提示「另有 N 已失效」')
})

test('失效判定三条：Status 3 / ExpiredTime 已过 / DeductionEndTime 已过', () => {
  const now = Date.now()
  const mk = (extra) => parseCreditPackage({ PackageName: 'p', ...extra }, now)

  assert.equal(mk({ Status: 3 }).active, false, 'Status 3')
  assert.equal(mk({ Status: 0 }).active, true, 'Status 0 有效（实测有效条目为 0）')
  assert.equal(mk({ Status: 7 }).active, true, '未知 Status 一律当有效（宁多显示不藏额度）')
  assert.equal(mk({ ExpiredTime: '2020-01-01 00:00:00' }).active, false, 'ExpiredTime 已过')
  assert.equal(mk({ ExpiredTime: '2099-01-01 00:00:00' }).active, true, 'ExpiredTime 未到')
  assert.equal(mk({ ExpiredTime: '' }).active, true, '空串 = 未回填（实测有效包一律为空串）')
  assert.equal(mk({ DeductionEndTime: now - 1000 }).active, false, '扣费截止已过')
  assert.equal(mk({ DeductionEndTime: now + 1000 }).active, true)
  assert.equal(mk({ DeductionEndTime: 0 }).active, true, '0 = 服务端未下发，按「未知」而非「已过期」')
})

test('parseCreditPackage：包名三级回退 PackageName → SubProductName → PackageCode', () => {
  const now = Date.now()
  assert.equal(parseCreditPackage({ PackageName: 'A', SubProductName: 'B', PackageCode: 'C' }, now).name, 'A')
  assert.equal(parseCreditPackage({ SubProductName: 'B', PackageCode: 'C' }, now).name, 'B')
  assert.equal(parseCreditPackage({ PackageCode: 'C' }, now).name, 'C')
  assert.equal(parseCreditPackage({}, now).name, '', '都没有就是空串，不编名字')
})

test('readPreciseNumber：Precise 优先，缺失/不可解析时回退整数', () => {
  const now = Date.now()
  // 实测：CapacityRemain=247（截断），CapacityRemainPrecise="247.87"（两位小数）
  assert.equal(parseCreditPackage({ CycleCapacityRemain: 247, CycleCapacityRemainPrecise: '247.87' }, now).remaining, 247.87)
  assert.equal(parseCreditPackage({ CycleCapacityRemain: 247 }, now).remaining, 247, '没有 Precise 就用整数版')
  assert.equal(parseCreditPackage({ CycleCapacityRemain: 247, CycleCapacityRemainPrecise: 'abc' }, now).remaining, 247, 'Precise 解析不了就回退')
  assert.equal(parseCreditPackage({ CycleCapacityRemain: 247, CycleCapacityRemainPrecise: 248.5 }, now).remaining, 248.5, '数字型 Precise 也认')
  assert.equal(parseCreditPackage({}, now).remaining, 0)
})

test('roundCredits：多包相加后按两位小数规整（浮点尾数噪声）', () => {
  // 出处：credits.ts 第 566 行「服务端精确值本身带浮点表示（如 55.67000031）」。
  assert.equal(roundCredits(55.67000031), 55.67)
  assert.equal(roundCredits(0.1 + 0.2), 0.3)
  assert.equal(roundCredits(100), 100)
  // 用 Math.round 而不是 toFixed 后 parse：负数与极大值行为一致，且结果仍是 number
  assert.equal(typeof roundCredits(-1.005), 'number')
})

test('parseCreditBalance：多包合计会规整浮点噪声', () => {
  const balance = parseCreditBalance(
    {
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageName: 'a', CycleCapacityRemainPrecise: '55.67000031', Status: 0 },
              { PackageName: 'b', CycleCapacityRemainPrecise: '100.00', Status: 0 },
            ],
          },
        },
      },
    },
    Date.now(),
  )
  assert.equal(balance.total, 155.67, '不做规整会得到 155.67000031')
})

test('parseCreditBalance：结构不符一律返回 null（与「余额为 0」区分）', () => {
  // 「查不到」必须与「余额为 0」分开 —— 把网络故障显示成 0 积分会误导用户。
  assert.equal(parseCreditBalance(null, Date.now()), null)
  assert.equal(parseCreditBalance('nope', Date.now()), null)
  assert.equal(parseCreditBalance({ code: 10001 }, Date.now()), null, '业务码非 0')
  assert.equal(parseCreditBalance({ code: 0 }, Date.now()), null, '缺 data')
  assert.equal(parseCreditBalance({ code: 0, data: {} }, Date.now()), null, '缺 Response 层')
  assert.equal(parseCreditBalance({ code: 0, data: { Response: {} } }, Date.now()), null, '缺 Data 层')
  assert.equal(parseCreditBalance({ code: 0, data: { Response: { Data: {} } } }, Date.now()), null, '缺 Accounts')
  assert.equal(
    parseCreditBalance({ code: 0, data: { Response: { Data: { Accounts: 'x' } } } }, Date.now()),
    null,
    'Accounts 不是数组',
  )
  // ⚠️ 这条容易写反：单层 data（签到那种形状）**不该**被当成有效余额
  assert.equal(
    parseCreditBalance({ code: 0, data: { Accounts: [{ PackageName: 'x' }] } }, Date.now()),
    null,
    '签到端点的单层 data 形状不能被当成余额响应',
  )
  // Accounts 为空数组是**合法**的（真的没有包 = 余额 0），与上面几条不同
  const empty = parseCreditBalance({ code: 0, data: { Response: { Data: { Accounts: [] } } } }, Date.now())
  assert.notEqual(empty, null)
  assert.equal(empty.total, 0)
  assert.deepEqual(empty.packages, [])
})

test('parseCreditBalance：Accounts 里的非对象项被跳过而不是让整体失败', () => {
  const balance = parseCreditBalance(
    {
      code: 0,
      data: { Response: { Data: { Accounts: [null, 'x', { PackageName: 'ok', CycleCapacityRemain: 5, Status: 0 }] } } },
    },
    Date.now(),
  )
  assert.equal(balance.packages.length, 1)
  assert.equal(balance.packages[0].name, 'ok')
})

// ─────────────────── 适配器层：额度分支 ───────────────────

test('getQuota：国际版**也**查余额（两个产品通用）', async () => {
  // 「国际版没有签到」不能推出「也查不到余额」—— 两者是独立能力（实测结论）。
  const { ctx, calls } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageName: 'Bonus Pack', CapacityUnit: 'credit', CycleCapacityRemainPrecise: '241.78', Status: 0 },
              { PackageName: 'Free Plan Subscription', CapacityUnit: 'credits', CycleCapacityRemainPrecise: '100', Status: 0 },
            ],
          },
        },
      },
    }),
  })
  const quota = await INTL.getQuota(account(), ctx)

  assert.equal(quota.unit, 'credits')
  assert.equal(quota.remaining, 341.78, '241.78 + 100（实测两包的数值）')
  assert.equal(quota.error, undefined)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.endsWith(USER_RESOURCE_PATH))
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].body, '{}')
})

test('getQuota：extra 保留逐包明细与失效合计，供 UI 展开', async () => {
  const { ctx } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { PackageName: '有效包', CapacityUnit: 'credit', CycleCapacityRemain: 100, Status: 0 },
              { PackageName: '失效包', CapacityUnit: 'credit', CycleCapacityRemain: 500, Status: 3 },
            ],
          },
        },
      },
    }),
  })
  const quota = await CN.getQuota(account(), ctx)

  assert.equal(quota.remaining, 100)
  assert.equal(quota.extra.packageCount, 2)
  assert.equal(quota.extra.activePackageCount, 1)
  assert.equal(quota.extra.expiredTotal, 500)
  assert.equal(quota.extra.packages.length, 2)
  assert.equal(quota.extra.displayUnit, 'credit')
})

test('★ getQuota：单位两种写法归一，但逐包明细保留原值', () => {
  // 服务端把同一个单位拼成 'credit' 与 'credits' 两种写法（实测逐包原值）。
  // 按原始字符串分组会让同一个账号渲染两次 —— 归一化只发生在「当分组键用」那一步。
  assert.equal(normalizeCreditUnit('credit'), 'credit')
  assert.equal(normalizeCreditUnit('credits'), 'credit')
  assert.equal(normalizeCreditUnit(''), 'credit')
  assert.equal(normalizeCreditUnit('token'), 'token', 'token 不折算成积分')
  assert.equal(normalizeCreditUnit('TOKEN'), 'credit', '只有精确的 token 才算 token')
})

test('getQuota：查不到时给 error，**不**谎报 0 积分', async () => {
  const { ctx } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({ code: 50000, msg: '系统繁忙' }),
  })
  const quota = await CN.getQuota(account(), ctx)

  assert.equal(quota.remaining, undefined, '查不到就是 undefined，不能是 0')
  assert.ok(typeof quota.error === 'string' && quota.error.length > 0)
})

test('getQuota：上游 5xx 时把原因带出来（用户最需要知道为什么）', async () => {
  const { ctx } = fakeCtx({
    [USER_RESOURCE_PATH]: { ok: false, status: 502, kind: 'server', headers: new Headers(), body: undefined, text: '', message: 'HTTP 502' },
  })
  const quota = await CN.getQuota(account(), ctx)
  assert.equal(quota.remaining, undefined)
  assert.match(quota.error, /502/)
})

test('getQuota：端点 404 → 说明该上游没有这个接口', async () => {
  const { ctx } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult('<html>404</html>', 404, 'not_found'),
  })
  const quota = await CN.getQuota(account(), ctx)
  assert.equal(quota.remaining, undefined)
  assert.match(quota.error, /没有「额度查询」接口/)
})

test('getQuota：没有凭证时给可操作的原因，不发请求', async () => {
  const { ctx, calls } = fakeCtx({})
  const quota = await CN.getQuota(account({}), ctx)
  assert.equal(quota.remaining, undefined)
  assert.match(quota.error, /access_token/)
  assert.equal(calls.length, 0)
})

test('baseUrl：配置了 apiBaseUrl 就用它（接自有反代）', async () => {
  const { ctx, calls } = fakeCtx({
    [USER_RESOURCE_PATH]: jsonResult({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  })
  ctx.config.upstream.apiBaseUrl = 'https://my-proxy.example.com/'
  await CN.getQuota(account(), ctx)
  assert.equal(calls[0].url, 'https://my-proxy.example.com/v2/billing/meter/get-user-resource', '末尾斜杠要去掉')
})

test('所有业务端点都是 POST + 空对象体（实测口径）', async () => {
  const { ctx, calls } = fakeCtx({
    [CHECKIN_ACTIVITY_STATUS_PATH]: jsonResult({ code: 0, data: { active: true, today_checked_in: true } }),
    [USER_RESOURCE_PATH]: jsonResult({ code: 0, data: { Response: { Data: { Accounts: [] } } } }),
  })
  await CN.checkIn(account(), ctx)
  await CN.getQuota(account(), ctx)

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.method, 'POST', `${call.url} 必须是 POST`)
    assert.equal(call.body, '{}', `${call.url} 的 body 必须是 '{}'`)
  }
  // 路径常量本身也断言一次，防止有人改错字面量
  assert.deepEqual(
    calls.map((c) => c.url.replace('https://copilot.tencent.com', '')),
    [CHECKIN_ACTIVITY_STATUS_PATH, USER_RESOURCE_PATH],
  )
})

// ═══════════════════════ task-10：登录（四步） ═══════════════════════
//
// 用户报障：「workbuddy 授权登录后，并没有加入账号进来。WorkBuddy International 也是同样的问题」。
//
// ## 根因（本文件就是在钉住它）
//
// 上游 `/v2/plugin/auth/token` 回的是 **camelCase**（`accessToken` / `refreshToken`
// / `expiresIn`）—— 参考实现 `buddy.ts:331-344` 的 `parseTokenData` 读的就是这些，
// 且带一条 e2e 实证（2026-09-11）。我们原来读的是 **snake_case `data.access_token`**
// （那个形状只出现在**落盘后的凭据**里，不是响应形状）⇒ 恒为 undefined
// ⇒ 恒判「还没检测到登录」⇒ **授权完成也永远 pending，账号永远加不进来**。
//
// ## fixture 出处
//
// | fixture | 出处 |
// |---|---|
// | token 响应的 **camelCase** 字段名（`accessToken`/`refreshToken`/`expiresIn`） | 参考 `buddy.ts:331-344` + 该处 e2e 实证注释（2026-09-11） |
// | account 响应的字段名（`uid`/`nickname`/`enterpriseId`/`type`） | 参考 `buddy.ts:353-362` 的 `parseAccountData`（抓包字段名） |
// | `{"code":11217,"msg":"11217:login ing...","requestId":"…"}` + **HTTP 200** | **Lead 本机真打实测**（`.scratch/probe-buddy-intl-token.mjs`，本文件作者复跑确认） |
// | `code: 12151` = 账户信息尚未完成 | 参考 `buddy.ts:69` 的 `CODE_ACCOUNT_NOT_READY` |
// | 国际版追加 `version` + `loginSessionId` | 参考 `buddy-oauth.ts:538-551` 的 `decorateLoginUrl` + `product.ts:405-406` |
// | 昵称在 JWT 里而不在 account 响应里 | 参考 `buddy.ts:196-207` 的 `jwtNickname` + `buddy.ts:347-351` 的注释（e2e 实证） |

/** 用假 `ctx.fetch` 驱动登录流程；按 URL 子串路由，**记录每次调用**。 */
function loginCtx(routes, { now = 1_760_000_000_000 } = {}) {
  const calls = []
  const ctx = {
    config: { upstream: { apiBaseUrl: '' }, requestTimeoutMs: 5_000 },
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
    http: async () => jsonResult({ code: 0, data: {} }),
    fetch: async (url, init = {}) => {
      const text = String(url)
      calls.push({ url: text, method: init.method ?? 'GET', headers: init.headers ?? {} })
      for (const [needle, handler] of Object.entries(routes)) {
        if (text.includes(needle)) {
          const spec = typeof handler === 'function' ? handler(text, init) : handler
          return new Response(typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body ?? {}), {
            status: spec.status ?? 200,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      return new Response(JSON.stringify({ code: 404, msg: `未预期的端点：${text}` }), { status: 404 })
    },
    cache: { get: () => undefined, set() {}, delete() {}, keys: () => [] },
    now: () => now,
  }
  return { ctx, calls }
}

/** 造一个**带合法载荷**的 JWT（不验签，只为让昵称/uid 回退链可测）。 */
function fakeJwt(payload) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

/** 一个正常的 auth/state 响应。 */
const stateRoute = { state: 'fixture-state', authUrl: 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=fixture-state' }

// ─────────────────── ① beginLogin：URL 装饰 ───────────────────

test('★ 国际版登录 URL 追加 version + loginSessionId', async () => {
  const { ctx } = loginCtx({ '/auth/state': { body: { code: 0, data: stateRoute } } })
  const start = await INTL.beginLogin(ctx)

  const url = new URL(start.authUrl)
  assert.equal(url.searchParams.get('version'), '5.5.2', '国际版必须带 version')
  assert.ok((url.searchParams.get('loginSessionId') ?? '').length > 0, '必须带 loginSessionId')
  // 每次新 UUID（参考实现：实测无校验语义，每次生成新值均可）
  assert.match(url.searchParams.get('loginSessionId'), /^[0-9a-f-]{36}$/i, '应当是 UUID 形态')
})

test('★ 国内版登录 URL **不**追加任何参数', async () => {
  const { ctx } = loginCtx({
    '/auth/state': { body: { code: 0, data: { state: 's', authUrl: 'https://copilot.tencent.com/login?platform=ide&state=s' } } },
  })
  const start = await CN.beginLogin(ctx)

  assert.equal(start.authUrl, 'https://copilot.tencent.com/login?platform=ide&state=s', '必须原样返回')
  const url = new URL(start.authUrl)
  assert.equal(url.searchParams.get('version'), null)
  assert.equal(url.searchParams.get('loginSessionId'), null)
  assert.equal(url.searchParams.has('loginSessionId'), false)
})

test('★ 装饰 URL 时 state / platform / 路径都不变（防重建 URL）', async () => {
  // 参考实现明确要求：「只追加参数，不得重建 URL」——
  // platform/state/路径全部来自服务端下发的 authUrl。
  const authUrl = 'https://www.workbuddy.ai/login?platform=workbuddy-ai&state=abc-123&extra=keepme'
  const { ctx } = loginCtx({ '/auth/state': { body: { code: 0, data: { state: 'abc-123', authUrl } } } })
  const start = await INTL.beginLogin(ctx)

  const before = new URL(authUrl)
  const after = new URL(start.authUrl)
  assert.equal(after.origin, before.origin, 'origin 不变')
  assert.equal(after.pathname, before.pathname, '路径不变')
  assert.equal(after.searchParams.get('state'), 'abc-123', 'state 不变')
  assert.equal(after.searchParams.get('platform'), 'workbuddy-ai', 'platform 不变')
  assert.equal(after.searchParams.get('extra'), 'keepme', '**原有的其它参数也必须保留**')
  // 只多了两个参数
  assert.equal(after.searchParams.size, before.searchParams.size + 2)
})

test('beginLogin 返回的 state 是**上游原始值**，不被装饰影响', async () => {
  const { ctx } = loginCtx({ '/auth/state': { body: { code: 0, data: stateRoute } } })
  const start = await INTL.beginLogin(ctx)
  assert.equal(start.state, 'fixture-state', 'state 原样保留，后续两步用它')
  assert.equal(typeof start.state, 'string', '必须是字符串（宿主原样存下来）')
})

test('登录 URL 每次都是新的 loginSessionId（不复用）', async () => {
  const mk = () => loginCtx({ '/auth/state': { body: { code: 0, data: stateRoute } } })
  const a = await INTL.beginLogin(mk().ctx)
  const b = await INTL.beginLogin(mk().ctx)
  const idOf = (u) => new URL(u).searchParams.get('loginSessionId')
  assert.notEqual(idOf(a.authUrl), idOf(b.authUrl), '两次登录的会话 id 必须不同')
})

// ─────────────────── ② pollLogin：显式判 code ───────────────────

test('★ HTTP 200 + code 11217 → pending（不是 failed、更不是 ready）', async () => {
  // Lead 本机真打实测的原始响应，**HTTP 200**（不是非 200！）：
  //   {"code":11217,"msg":"11217:login ing...","requestId":"…"}
  // 旧实现只在非 200 时才读 code，靠 unwrapData 返回 null 的副作用恰好判对 —— 很脆。
  const { ctx } = loginCtx({
    '/auth/token': { status: 200, body: { code: 11217, msg: '11217:login ing...', requestId: 'r-1' } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)

  assert.equal(poll.status, 'pending', '11217 = 用户还没授权，正常中间态')
  assert.equal(poll.credentials, undefined, 'pending 绝不能带凭证')
  assert.match(poll.message, /还没检测到登录/)
})

test('★ HTTP 200 + code 非 0 且非 11217 → failed（不静默 pending）', async () => {
  // 静默 pending 会让用户对着「一直在等」干等到会话过期，还以为是自己没登录成功。
  const { ctx } = loginCtx({
    '/auth/token': { status: 200, body: { code: 40001, msg: 'invalid state' } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)

  assert.equal(poll.status, 'failed')
  assert.match(poll.message, /40001/, '必须把业务码带出来')
  assert.match(poll.message, /invalid state/, '把上游原文带出来，别吞错')
})

test('code 11217 在**非 200** 时同样判 pending（与 HTTP 状态解耦）', async () => {
  const { ctx } = loginCtx({
    '/auth/token': { status: 503, body: { code: 11217, msg: 'login ing' } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)
  assert.equal(poll.status, 'pending', '业务码说了算，不看 HTTP 状态')
})

test('未授权时**绝不**返回 ready（否则会加进一个空 token 的账号）', async () => {
  // 这是用户报障的直接防线：加进一个没有 token 的账号，看起来就是「没加进来」。
  const cases = [
    { code: 11217, msg: 'login ing' },
    { code: 0, data: null },
    { code: 0 },
  ]
  for (const body of cases) {
    const { ctx } = loginCtx({ '/auth/token': { body } })
    const poll = await INTL.pollLogin('fixture-state', ctx)
    assert.notEqual(poll.status, 'ready', `响应 ${JSON.stringify(body)} 不该判定为 ready`)
    assert.equal(poll.credentials, undefined)
  }
})

test('auth/token 返回数据但没有 token 字段 → failed（形状变了要说出来）', async () => {
  // 旧实现在这里判 pending —— 那会让「响应结构变了」伪装成「用户没登录成功」。
  const { ctx } = loginCtx({ '/auth/token': { body: { code: 0, data: { somethingElse: 1 } } } })
  const poll = await INTL.pollLogin('fixture-state', ctx)
  assert.equal(poll.status, 'failed')
  assert.match(poll.message, /没有 access token 字段/)
})

test('登录会话状态丢失 → failed 且不发请求', async () => {
  const { ctx, calls } = loginCtx({})
  for (const bad of ['', undefined, null, {}, { state: 42 }]) {
    const poll = await INTL.pollLogin(bad, ctx)
    assert.equal(poll.status, 'failed', `${JSON.stringify(bad)} 该判 failed`)
  }
  assert.equal(calls.length, 0, '状态都没有，不该发任何请求')
})

test('pollLogin 的 state 参数是字符串或对象都认（宿主两种都存过）', async () => {
  const routes = {
    '/auth/token': { body: { code: 0, data: { accessToken: 'tok', refreshToken: 'ref' } } },
    '/login/account': { body: { code: 0, data: { uid: 'u1' } } },
  }
  const asString = await INTL.pollLogin('fixture-state', loginCtx(routes).ctx)
  const asObject = await INTL.pollLogin({ state: 'fixture-state' }, loginCtx(routes).ctx)
  assert.equal(asString.status, 'ready')
  assert.equal(asObject.status, 'ready')
})

// ─────────────────── ③ getAccount + 凭证组装 ───────────────────

test('★ token 就绪 → 调 getAccount → ready 且凭证完整', async () => {
  const jwt = fakeJwt({ nickname: '张三', sub: 'jwt-sub-1', iat: 1_700_000_000, exp: 1_800_000_000 })
  const { ctx, calls } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: jwt, refreshToken: 'ref-tok', expiresIn: 7200, tokenType: 'Bearer' } } },
    '/login/account': { body: { code: 0, data: { uid: 'uid-1', nickname: '昵称', enterpriseId: 'ent-1', type: 'personal' } } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)

  assert.equal(poll.status, 'ready')
  assert.equal(poll.message, '登录成功')

  // ★ 核心：getAccount **被调用了**（我们的旧实现完全没有这一步）
  const accountCalls = calls.filter((c) => c.url.includes('/v2/plugin/login/account'))
  assert.equal(accountCalls.length, 1, 'token 就绪后必须再问一次 login/account')
  assert.ok(accountCalls[0].url.includes('state=fixture-state'), 'account 请求必须带 state')
  assert.equal(accountCalls[0].headers.authorization, `Bearer ${jwt}`, 'account 请求必须带 Bearer token')
  assert.equal(accountCalls[0].headers['x-domain'], 'www.workbuddy.ai')
  assert.equal(accountCalls[0].headers['x-no-user-id'], 'true')
  assert.equal(accountCalls[0].headers['x-no-enterprise-id'], 'true')

  // 账号信息进了最终 credentials
  const cred = poll.credentials
  assert.equal(cred.token, jwt)
  assert.equal(cred.refreshToken, 'ref-tok')
  assert.equal(cred.uid, 'uid-1', '★ 账号信息（uid）必须进凭据')
  assert.equal(cred.enterpriseId, 'ent-1', '★ 企业 id 必须进凭据')
  assert.equal(cred.accountType, 'personal')
  assert.equal(cred.nickname, '昵称')
  // expiresIn 7200s 以 JWT.iat 为基准换算（实测上游只给相对秒数）
  assert.equal(cred.expiresAt, 1_700_000_000 * 1000 + 7200 * 1000)
})

test('★ token 走 camelCase（上游真实形状）—— 这是本次报障的根因', async () => {
  // 参考实现 parseTokenData 读 accessToken/refreshToken（e2e 实证 2026-09-11）。
  // 旧实现读 data.access_token ⇒ 恒 undefined ⇒ 恒 pending ⇒ 账号加不进来。
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: 'camel-token', refreshToken: 'camel-refresh' } } },
    '/login/account': { body: { code: 0, data: { uid: 'u1' } } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)

  assert.equal(poll.status, 'ready', '★ camelCase 必须被认出来，否则就是用户报的那个 bug')
  assert.equal(poll.credentials.token, 'camel-token')
  assert.equal(poll.credentials.refreshToken, 'camel-refresh')
})

test('snake_case 也认（防御：万一某产品线回蛇形）', async () => {
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { access_token: 'snake-token', refresh_token: 'snake-refresh' } } },
    '/login/account': { body: { code: 0, data: { uid: 'u1' } } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)
  assert.equal(poll.status, 'ready')
  assert.equal(poll.credentials.token, 'snake-token')
})

test('两种命名同时出现时以 camelCase 为准（它才是被实证过的）', async () => {
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: 'camel-wins', access_token: 'snake-loses' } } },
    '/login/account': { body: { code: 0, data: { uid: 'u1' } } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)
  assert.equal(poll.credentials.token, 'camel-wins')
})

test('account 未就绪（code 12151）→ pending，**不**返回 ready', async () => {
  // 账号信息（uid/企业）只有 login/account 有；拿不到就建不出完整账号 ⇒ 不能 ready。
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: 'tok' } } },
    '/login/account': { body: { code: 12151, msg: '12151:account not ready' } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)
  assert.equal(poll.status, 'pending')
  assert.equal(poll.credentials, undefined)
  assert.match(poll.message, /刷新登录状态/, '要告诉用户再点一次，而不是让他重新登录')
})

test('account 端点真失败（非 12151 的非 0 码）→ failed', async () => {
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: 'tok' } } },
    '/login/account': { body: { code: 50000, msg: 'boom' } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)
  assert.equal(poll.status, 'failed')
  assert.match(poll.message, /50000/)
})

test('account 返回 200 但缺 data → pending（别谎报成功）', async () => {
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: 'tok' } } },
    '/login/account': { body: { code: 0 } },
  })
  const poll = await INTL.pollLogin('fixture-state', ctx)
  assert.equal(poll.status, 'pending')
  assert.equal(poll.credentials, undefined)
})

test('昵称回退链：account.nickname → JWT.nickname → preferred_username', async () => {
  // 参考实现 e2e 实证：login/account 的 nickname **常为空**，真昵称在 JWT 里。
  const fromAccount = await INTL.pollLogin('s', loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: fakeJwt({ nickname: 'jwt-name' }) } } },
    '/login/account': { body: { code: 0, data: { uid: 'u', nickname: 'account-name' } } },
  }).ctx)
  assert.equal(fromAccount.credentials.nickname, 'account-name', 'account 有就用它')

  const fromJwt = await INTL.pollLogin('s', loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: fakeJwt({ nickname: 'jwt-name' }) } } },
    '/login/account': { body: { code: 0, data: { uid: 'u' } } },
  }).ctx)
  assert.equal(fromJwt.credentials.nickname, 'jwt-name', 'account 没有就回退 JWT')

  const fromPreferred = await INTL.pollLogin('s', loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: fakeJwt({ preferred_username: 'pref' }) } } },
    '/login/account': { body: { code: 0, data: { uid: 'u' } } },
  }).ctx)
  assert.equal(fromPreferred.credentials.nickname, 'pref')
})

test('uid 回退链：account.uid → JWT.sub', async () => {
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: fakeJwt({ sub: 'from-jwt-sub' }) } } },
    '/login/account': { body: { code: 0, data: { nickname: 'n' } } },
  })
  const poll = await INTL.pollLogin('s', ctx)
  assert.equal(poll.credentials.uid, 'from-jwt-sub', 'account 没 uid 就回退 JWT.sub')
})

test('过期时间回退链：expiresIn → JWT.exp（上游通常只给相对秒数）', async () => {
  // 参考实现实证：auth/token **不返回** expiresAt，只给 expiresIn。
  const jwt = fakeJwt({ iat: 1_700_000_000, exp: 1_800_000_000 })
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: jwt, expiresIn: 3600 } } },
    '/login/account': { body: { code: 0, data: { uid: 'u' } } },
  })
  const poll = await INTL.pollLogin('s', ctx)
  assert.equal(poll.credentials.expiresAt, 1_700_000_000 * 1000 + 3600 * 1000, 'expiresIn 以 JWT.iat 为基准')

  // 没有 expiresIn 时回退到 JWT.exp（否则 UI 显示「有效期未知」）
  const noRelative = await INTL.pollLogin('s', loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: jwt } } },
    '/login/account': { body: { code: 0, data: { uid: 'u' } } },
  }).ctx)
  assert.equal(noRelative.credentials.expiresAt, 1_800_000_000 * 1000)
})

test('ready 时给出账号标签（昵称优先，其次 uid）', async () => {
  const withNick = await INTL.pollLogin('s', loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: fakeJwt({}) } } },
    '/login/account': { body: { code: 0, data: { uid: 'u-1', nickname: '我的号' } } },
  }).ctx)
  assert.equal(withNick.label, '我的号', '有昵称就用昵称做标签')

  const uidOnly = await INTL.pollLogin('s', loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: fakeJwt({}) } } },
    '/login/account': { body: { code: 0, data: { uid: 'u-2' } } },
  }).ctx)
  assert.equal(uidOnly.label, 'u-2', '没有昵称就用 uid')
})

test('凭据里**不含**空串字段（不要把 uid: "" 落盘）', async () => {
  const { ctx } = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: fakeJwt({}) } } },
    '/login/account': { body: { code: 0, data: {} } },
  })
  const poll = await INTL.pollLogin('s', ctx)
  assert.equal(poll.status, 'ready')
  for (const [k, v] of Object.entries(poll.credentials)) {
    assert.notEqual(v, '', `字段 ${k} 不该是空串（应整个省略）`)
  }
  assert.equal(poll.credentials.refreshToken, undefined, '没有 refresh token 就不放这个键')
})

test('国内版登录流程与 gather 步骤完全一致（只差 URL 装饰）', async () => {
  const { ctx, calls } = loginCtx({
    '/auth/state': { body: { code: 0, data: { state: 'cn-state', authUrl: 'https://copilot.tencent.com/login?platform=ide&state=cn-state' } } },
    '/auth/token': { body: { code: 0, data: { accessToken: 'cn-tok', refreshToken: 'cn-ref' } } },
    '/login/account': { body: { code: 0, data: { uid: 'cn-uid' } } },
  })
  const start = await CN.beginLogin(ctx)
  const poll = await CN.pollLogin(start.state, ctx)

  assert.equal(poll.status, 'ready', '国内版同样要走完 getAccount')
  assert.equal(poll.credentials.uid, 'cn-uid')
  assert.equal(calls.filter((c) => c.url.includes('/login/account')).length, 1)
  assert.ok(calls.every((c) => !c.url.includes('loginSessionId')), '国内版请求里不该出现会话参数')
})

test('网络抖动时 token 步骤回 pending（一次失败不判死整个会话）', async () => {
  const ctx = loginCtx({}).ctx
  ctx.fetch = async () => { throw new Error('socket hang up') }
  const poll = await INTL.pollLogin('s', ctx)
  assert.equal(poll.status, 'pending', '用户再点一次就好，不该让他重新发起登录')
  assert.match(poll.message, /socket hang up/, '原始报错要带出来（硬规则 4：不许吞错）')
})

test('token 已拿到但 account 网络失败 → pending（别让用户重来一遍登录）', async () => {
  let accountAttempted = false
  const ctx = loginCtx({
    '/auth/token': { body: { code: 0, data: { accessToken: 'tok' } } },
  }).ctx
  const bare = ctx.fetch
  ctx.fetch = async (url, init) => {
    if (String(url).includes('/login/account')) {
      accountAttempted = true
      throw new Error('ECONNRESET')
    }
    return bare(url, init)
  }
  const poll = await INTL.pollLogin('s', ctx)
  assert.equal(accountAttempted, true, 'account 步骤确实被执行了')
  assert.equal(poll.status, 'pending')
  assert.equal(poll.credentials, undefined)
})

// ═════════════════ task-11：11128 渠道校验 + 模型倍率 ═════════════════
//
// 用户报障两条：
//   1. 国际版调用模型失败 `{"code":11128,"msg":"request illegal"}` +「channel verification」
//   2. workbuddy 与国际版拉取的模型，**倍率全是未知**
//
// ## ⚠️ 11128 有**两个互不相干的子原因**（这条是本次最重要的认知）
//
// 修好第一个之前，两个原因的报错文案是**同一句笼统话**，根本分不出来；
// 修好之后 `msg` 才变成**具体的**，第二个才暴露。实测（真实账号）：
//
// | 消息形态 | 结果 |
// |---|---|
// | 首条是 user，且缺会话头 | ✗ 400 11128（笼统的 channel verification） |
// | 首条是 user，会话头齐 | ✗ 400 11128 msg=**"first message is not system prompt"** |
// | 首条是 system，会话头齐 | ✓ 200 |
//
// ⇒ **同一个错误码在修掉第一层之前会掩盖第二层。**
//
// ## fixture 出处
//
// | fixture | 出处 |
// |---|---|
// | 三个会话头名与「只对国际版加」 | 参考 `buddy-adapter.ts:1792-1796`；A/B 实验（Lead，真实账号） |
// | 补最小 system（`'You are a helpful assistant.'`） | 参考 `buddy-adapter.ts:1350-1352` + `account-probe.ts:92-123`（`PROBE_SYSTEM`） |
// | `credits` 实测原值（`"x0.34 credits"` / `"x0.00"` / `""`） | 本机真打 `/v3/config`（workbuddy-intl，2026-10-20） |
// | `modelPromotions` 原始结构（`"0x"` + `factor:0` + `validUntil`） | 同上，本机真打（`.scratch/probe-buddy-promotions-raw.mjs`） |

/** 只跑 `requestChatStream` 的假 ctx：记下请求体与头，回一段最小 SSE。 */
function chatCtx(sseBody = 'data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n') {
  const calls = []
  const ctx = {
    config: { upstream: { apiBaseUrl: '' }, requestTimeoutMs: 5_000 },
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
    http: async () => jsonResult({ code: 0, data: {} }),
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers ?? {}, body: init.body })
      return new Response(sseBody, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
    // ⚠️ 用**真的** KV 存储（不是空壳）：思考档位要靠 `ctx.cache` 在
    // 「拉目录」与「发请求」之间传递，空壳会让所有档位判定退化成「能力未知」。
    cache: (() => {
      const store = new Map()
      return {
        get: (key) => store.get(key),
        set: (key, value) => { store.set(key, value) },
        delete: (key) => { store.delete(key) },
        keys: () => [...store.keys()],
      }
    })(),
    now: () => 1_760_000_000_000,
  }
  return { ctx, calls }
}

/**
 * 把「某模型声明了什么档位」塞进 `ctx.cache` —— 模拟「先拉过模型目录」这个前提。
 *
 * 为什么不能省：请求侧的 `effortsOf()` 只读缓存（它拉不到目录）。
 * 不 seed 就等于**目录从没拉过**（能力未知），那是另一条分支。
 *
 * key 必须与 `BuddyAdapter.reasoningCacheKey()` 一致（`buddy:reasoning:<agentId>`）。
 */
async function seedReasoning(ctx, table, agentId = 'workbuddy-intl') {
  const normalized = {}
  for (const [id, raw] of Object.entries(table)) {
    const fields = parseReasoningFields({ reasoning: raw })
    normalized[id] = {
      ...(fields.supportedEfforts === undefined ? {} : { supported: fields.supportedEfforts }),
      ...(fields.defaultEffort === undefined ? {} : { defaultEffort: fields.defaultEffort }),
      ...(fields.singleEffort === undefined ? {} : { singleEffort: fields.singleEffort }),
    }
  }
  ctx.cache.set(`buddy:reasoning:${agentId}`, normalized)
}

/** 跑一次 chat，把流消费完（否则 fetch 不会被触发）。 */
async function drainChat(adapter, ctx, messages, record = account(), model = 'default-model', reasoningEffort) {
  const events = []
  for await (const event of adapter.requestChatStream(
    {
      model,
      messages,
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    },
    record,
    ctx,
    new AbortController().signal,
  )) {
    events.push(event)
  }
  return events
}

// ─────────────────── 缺陷 A：三个会话头 ───────────────────

test('★ 国际版对话请求带齐三个 conversation 头', async () => {
  // 缺任一个都过不了上游渠道校验（400 + 11128）。A/B 实测：只加 X-Conversation-ID 仍 400。
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }])

  const headers = calls[0].headers
  assert.ok(headers['x-conversation-id'], '必须有 X-Conversation-ID')
  assert.ok(headers['x-conversation-message-id'], '必须有 X-Conversation-Message-ID')
  assert.ok(headers['x-conversation-request-id'], '必须有 X-Conversation-Request-ID')
  // 三个都要有值（空串也算缺）
  for (const name of ['x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id']) {
    assert.ok(String(headers[name]).length > 0, `${name} 不能是空值`)
  }
})

test('★ 国内版对话请求带会话三件套（前缀缓存 key），但不发国际版的 message-id', async () => {
  // 2026-10-30 实测：不带这三个头，国内版前缀缓存命中率恒为 0%（每轮全量计费）；
  // 三头齐发后同一前缀命中率 95.5%，费用差约 17 倍。只发 `x-conversation-id` 一个仍 0%。
  const { ctx, calls } = chatCtx()
  await drainChat(CN, ctx, [{ role: 'user', content: 'hi' }])

  const headers = calls[0].headers
  assert.equal(typeof headers['x-conversation-id'], 'string')
  assert.ok(headers['x-conversation-id'].length > 0, 'x-conversation-id 不能是空串')
  assert.equal(typeof headers['x-conversation-request-id'], 'string')
  assert.equal(headers['x-conversation-request-id'], headers['x-root-request-id'], '两条 root 必须同值')
  // 国际版那套 CLI 形态的头不要照搬（国内版没有抓包依据）
  assert.equal(headers['x-conversation-message-id'], undefined)
  assert.equal(headers['x-request-id'], undefined)
  // 身份头仍然照发（这些两个产品都要）
  assert.equal(headers['x-product-code'], 'codebuddy')
})

test('★ 国内版会话 id 按账号稳定（缓存 key 不能每轮换）', async () => {
  const { ctx, calls } = chatCtx()
  const rec = account()
  await drainChat(CN, ctx, [{ role: 'user', content: 'a' }], rec)
  await drainChat(CN, ctx, [{ role: 'user', content: 'b' }], rec)
  assert.equal(calls[0].headers['x-conversation-id'], calls[1].headers['x-conversation-id'], '同账号必须一致')
  assert.equal(calls[0].headers['x-root-request-id'], calls[1].headers['x-root-request-id'], 'root 也要稳定')

  const { ctx: ctx2, calls: calls2 } = chatCtx()
  await drainChat(CN, ctx2, [{ role: 'user', content: 'c' }], { ...account({ token: 'another-token' }), id: 'workbuddy:fixture-2' })
  assert.notEqual(calls[0].headers['x-conversation-id'], calls2[0].headers['x-conversation-id'], '不同账号必须不同')
})

test('★ conversation 头名与参考实现逐字一致（大小写不敏感地比）', async () => {
  // 上游按头名精确匹配，写错一个字母就是 400 + 11128。
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }])
  const names = Object.keys(calls[0].headers).map((n) => n.toLowerCase())
  for (const required of ['x-conversation-id', 'x-conversation-message-id', 'x-conversation-request-id']) {
    assert.ok(names.includes(required), `缺少 ${required}（实际：${names.join(', ')}）`)
  }
})

test('sessionId 按账号稳定：同一账号两次请求相同，不同账号不同', async () => {
  // ⚠️ sessionId 同时是**前缀缓存的 key**（参考实现实测：带与不带它，
  // `prompt_cache_hit_tokens` 从 7808 变 0，费用差约 17 倍）。
  // 所以它必须**稳定** —— 每次请求新值等于彻底放弃缓存。
  const { ctx, calls } = chatCtx()
  const rec = account()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'a' }], rec)
  await drainChat(INTL, ctx, [{ role: 'user', content: 'b' }], rec)
  assert.equal(calls[0].headers['x-conversation-id'], calls[1].headers['x-conversation-id'], '同账号必须一致')

  const other = { ...rec, id: 'workbuddy:other' }
  await drainChat(INTL, ctx, [{ role: 'user', content: 'c' }], other)
  assert.notEqual(calls[0].headers['x-conversation-id'], calls[2].headers['x-conversation-id'], '不同账号必须不同')
})

test('messageId 每次请求新值、root request id 按会话稳定（2026-10-23 抓包口径）', async () => {
  // 抓包事实：`x-request-id` 与 `x-conversation-message-id` 同一条 32 位十六进制，
  // **每次调用新值**；而 `x-conversation-request-id` = `x-root-request-id` 是**会话级**
  // 的 root id（同一次对话里稳定，且同时充当链路 trace-id）。
  // 早期实现把 conversation-request-id 当成「每次新值」，与客户端形态不符。
  const { ctx, calls } = chatCtx()
  const rec = account()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'a' }], rec)
  await drainChat(INTL, ctx, [{ role: 'user', content: 'b' }], rec)

  // message id：每次新值，32 位十六进制（无连字符）
  assert.notEqual(calls[0].headers['x-conversation-message-id'], calls[1].headers['x-conversation-message-id'])
  assert.match(calls[0].headers['x-conversation-message-id'], /^[0-9a-f]{32}$/i)
  // x-request-id 与 message-id 是同一条值
  assert.equal(calls[0].headers['x-request-id'], calls[0].headers['x-conversation-message-id'])
  // root：会话内稳定，且 conversation-request-id 与 root-request-id 同值
  assert.equal(calls[0].headers['x-conversation-request-id'], calls[1].headers['x-conversation-request-id'], 'root 会话内稳定')
  assert.equal(calls[0].headers['x-root-request-id'], calls[0].headers['x-conversation-request-id'])
  assert.match(calls[0].headers['x-root-request-id'], /^[0-9a-f]{32}$/i)
  // 会话 id 是 UUID 形态（客户端真实形态），不是裸 32 位十六进制
  assert.match(calls[0].headers['x-conversation-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
})

test('★ 对话请求头按内嵌 CLI 的真实形态发（2026-10-23 抓包，35 个头）', async () => {
  // 依据：docs/WORKBUDDY-INTL-REQUEST.md + docs/workbuddy-intl-capture/sample-headers.json
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account({ token: 'tok-1', user_id: 'u_1' }))

  const h = calls[0].headers
  // 鉴权：Bearer + x-api-key 同值双发
  assert.equal(h.authorization, 'Bearer tok-1')
  // ⚠️ 回归护栏：官方 JWT **不能**进 x-api-key。
  // 2026-10-23 真账号 A/B：只带 authorization → 200；再加 x-api-key: <JWT> →
  // 401 {"message":"not_found"}。抓包里那个头是自定义模型的 sk-… key。
  assert.equal(h['x-api-key'], undefined, 'JWT 凭据绝不能塞进 x-api-key')
  // 客户端形态头
  assert.equal(h.accept, 'application/json', '抓包里是 application/json，流式由 body.stream 决定')
  assert.equal(h['x-requested-with'], 'XMLHttpRequest')
  assert.equal(h['x-codebuddy-request'], '1')
  assert.equal(h['x-agent-type'], 'main')
  assert.equal(h['x-agent-intent'], 'craft')
  assert.equal(h['x-agent-purpose'], 'conversation')
  assert.equal(h['x-ide-type'], 'CLI')
  assert.equal(h['x-ide-name'], 'CLI')
  assert.equal(h['x-ide-version'], '2.137.1', 'CLI 版本，不是桌面端产品版本 5.5.2')
  assert.equal(h['user-agent'], 'CLI/2.137.1 WorkBuddy AI/2.137.1')
  assert.equal(h['x-product'], 'SaaS')
  assert.equal(h['x-product-code'], undefined, '国际版 CLI 对话路径不发 x-product-code')
  assert.equal(h['x-user-id'], 'u_1')
  // 链路头：trace-id = root request id
  assert.equal(h['x-trace-id'], h['x-root-request-id'])
  assert.match(h.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.match(h.b3, /^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/)
  assert.equal(h['x-b3-traceid'], h['x-root-request-id'])
  assert.equal(h['x-b3-sampled'], '1')
  // SDK 指纹
  assert.equal(h['x-stainless-lang'], 'js')
  assert.equal(h['x-stainless-runtime'], 'node')
  assert.equal(h['x-stainless-package-version'], '6.25.0')
  assert.match(h['x-stainless-runtime-version'], /^v\d+\./)
})

test('★ x-api-key 只对 sk-… 形态的凭据发（API key 才发，JWT 不发）', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account({ token: 'sk-live-abc123' }))
  assert.equal(calls[0].headers['x-api-key'], 'sk-live-abc123', 'API key 形态照客户端发')

  const { ctx: ctx2, calls: calls2 } = chatCtx()
  await drainChat(INTL, ctx2, [{ role: 'user', content: 'hi' }], account({ token: 'eyJhbGciOi.payload.sig' }))
  assert.equal(calls2[0].headers['x-api-key'], undefined, 'JWT 形态必须不发（否则 401 not_found）')
})

test('★ 国内版对话路径保持旧形态：不发 CLI 形态头，也不发 x-api-key', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(CN, ctx, [{ role: 'user', content: 'hi' }], account({ token: 'tok-1' }))

  const h = calls[0].headers
  assert.equal(h['x-codebuddy-request'], undefined)
  assert.equal(h['x-api-key'], undefined)
  assert.equal(h['x-agent-type'], undefined)
  assert.equal(h['x-stainless-lang'], undefined)
  assert.equal(h['x-ide-name'], 'CodeBuddy', '国内版沿用旧形态（产品名 + 桌面端版本）')
  assert.equal(h['user-agent'], 'CodeBuddyIDE/1.106.1')
  assert.equal(h['x-product-code'], 'codebuddy')
})

test('★ 国际版 user 消息带客户端形态标记 agent:"cli"（system 不带）', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi' },
  ])
  const body = JSON.parse(String(calls[0].body))
  assert.equal(body.messages[0].agent, undefined, 'system 消息不带 agent')
  assert.equal(body.messages[1].agent, 'cli')
})

// ─────────────────── 缺陷 A2：首条必须是 system ───────────────────

test('★ 国际版：首条不是 system 时自动补一条（否则 400 11128）', async () => {
  // `src/llm/adapter.ts` 的 toOpenAiMessages() **只在 system 非空时**才 unshift，
  // 所以 system 为空时 wire 上首条就是 user ⇒ 必踩
  // `11128 msg="first message is not system prompt"`。
  // 参考实现在适配器内部兜了同一层（buddy-adapter.ts:1350-1352）。
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [{ role: 'user', content: '只回答两个字：收到' }])

  const body = JSON.parse(String(calls[0].body))
  assert.equal(body.messages[0].role, 'system', '★ wire 上首条必须是 system')
  assert.equal(body.messages[0].content, 'You are a helpful assistant.', '用参考实现验证过的那句')
  assert.equal(body.messages[1].role, 'user', '原来的 user 消息必须保留在后')
  assert.equal(body.messages.length, 2, '只补一条')
})

test('★ 国内版：首条不是 system 时**不补**（无此硬要求）', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(CN, ctx, [{ role: 'user', content: 'hi' }])
  const body = JSON.parse(String(calls[0].body))
  assert.equal(body.messages[0].role, 'user', '国内版不该被加料')
  assert.equal(body.messages.length, 1)
})

test('★ 已有 system 时原样保留，不覆盖也不追加第二条', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [
    { role: 'system', content: 'DSH 的真实提示词' },
    { role: 'user', content: 'hi' },
  ])
  const body = JSON.parse(String(calls[0].body))
  assert.equal(body.messages[0].content, 'DSH 的真实提示词', '★ 用户的 system 不能被替换')
  assert.equal(body.messages.length, 2, '不该出现第二条 system')
})

test('补 system 对空消息列表也安全（不抛错）', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [])
  const body = JSON.parse(String(calls[0].body))
  assert.equal(body.messages[0].role, 'system', '空列表也要补上首条 system')
  assert.equal(body.messages.length, 1)
})

test('补 system 不改变其它请求字段（model / stream / stream_options）', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }])
  const body = JSON.parse(String(calls[0].body))
  assert.equal(body.model, 'default-model')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
})

// ─────────────────── 缺陷 B：倍率解析（纯函数） ───────────────────

test('★ normalizeCreditsRate：认 x 前缀写法（上游 models[].credits 的真实形态）', () => {
  // 实测原值（2026-10-20，workbuddy-intl /v3/config）
  assert.equal(normalizeCreditsRate('x0.29')?.value, 0.29)
  assert.equal(normalizeCreditsRate('x0.29')?.text, 'x0.29')
  assert.equal(normalizeCreditsRate('x3.31 credits')?.value, 3.31, '★ 带单位后缀也要能解析')
  assert.equal(normalizeCreditsRate('x0.34 credits')?.value, 0.34)
  assert.equal(normalizeCreditsRate('x6.67')?.value, 6.67, '整数部分多位')
  assert.equal(normalizeCreditsRate('X0.29')?.value, 0.29, '大小写不敏感')
  assert.equal(normalizeCreditsRate('  x0.29  ')?.value, 0.29, '两侧空白要容忍')
})

test('★ "x0.00" 是 0 = 免费（合法值，不能当成缺失）', () => {
  // 这是三条硬要求里的第 2 条：0 与 undefined 语义完全不同。
  const rate = normalizeCreditsRate('x0.00')
  assert.notEqual(rate, undefined)
  assert.equal(rate.value, 0)
  assert.equal(rate.text, 'x0.00')
  assert.equal(normalizeCreditsRate('x0')?.value, 0)
})

test('★ "" / 缺失 / 非法值 → undefined（绝不回退成 x1）', () => {
  // 三条硬要求的第 1、3 条：编造倍率比不显示更糟。
  assert.equal(normalizeCreditsRate(''), undefined)
  assert.equal(normalizeCreditsRate('   '), undefined)
  assert.equal(normalizeCreditsRate(undefined), undefined)
  assert.equal(normalizeCreditsRate(null), undefined)
  assert.equal(normalizeCreditsRate(0.29), undefined, '数字不是上游形态，不猜')
  assert.equal(normalizeCreditsRate('credits'), undefined)
  assert.equal(normalizeCreditsRate('x'), undefined, 'x 后面没数字')
  assert.equal(normalizeCreditsRate('xabc'), undefined)
  // ★ 关键：绝不能是 1（那等于谎称「标准倍率」）
  for (const bad of ['', 'nope', undefined, 'x']) {
    assert.notEqual(normalizeCreditsRate(bad)?.value, 1, `${String(bad)} 解析不出，不能回退成 1`)
  }
})

test('★ normalizeDiscountedRate：促销是 **x 在后** 的写法（两套写法必须都认）', () => {
  // 实测：模型 credits 是 "x0.29"（x 在前），促销 discountedCredits 是 "0.50x"（x 在后）。
  // 参考实现注释原文：早期只认前缀，导致**促销价全部解析失败且静默丢失**。
  assert.equal(normalizeDiscountedRate('0.50x')?.value, 0.5, 'x 在后')
  assert.equal(normalizeDiscountedRate('0.15x')?.value, 0.15)
  assert.equal(normalizeDiscountedRate('0x')?.value, 0, '已结束占位，解析出 0 由调用方排除')
  // 两个入口**都接受两种写法**（对上游互换写法更鲁棒）
  assert.equal(normalizeDiscountedRate('x0.29')?.value, 0.29, '促销入口也认前缀')
  assert.equal(normalizeCreditsRate('0.50x')?.value, 0.5, '模型入口也认后缀')
  assert.equal(normalizeDiscountedRate(''), undefined)
})

// ─────────────────── 缺陷 B：促销（活动价） ───────────────────

test('parseModelPromotions：取未过期的折扣，按 modelIds 关联', () => {
  const now = new Date('2026-10-20T12:00:00+08:00')
  const promos = parseModelPromotions(
    {
      modelPromotions: [
        {
          enabled: true,
          priority: 50,
          discount: { discountedCredits: '0.15x', factor: 0.15 },
          modelIds: ['glm-5.2'],
          schedule: { validFrom: '2026-10-01T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
        },
      ],
    },
    now,
  )
  assert.equal(promos.get('glm-5.2')?.value, 0.15)
})

test('parseModelPromotions：有效期已过 / 未到 / enabled:false 都跳过', () => {
  const now = new Date('2026-10-20T12:00:00+08:00')
  const mk = (extra) => ({
    modelPromotions: [
      { enabled: true, discount: { discountedCredits: '0.15x', factor: 0.15 }, modelIds: ['m'], ...extra },
    ],
  })
  // 已过
  assert.equal(parseModelPromotions(mk({ schedule: { validUntil: '2026-10-01T00:00:00+08:00' } }), now).size, 0)
  // 未到
  assert.equal(parseModelPromotions(mk({ schedule: { validFrom: '2026-12-01T00:00:00+08:00' } }), now).size, 0)
  // 停用
  assert.equal(parseModelPromotions(mk({ enabled: false }), now).size, 0)
  // 都没问题 → 生效
  assert.equal(parseModelPromotions(mk({}), now).size, 1)
})

test('parseModelPromotions：同模型多条活动取 priority 最高者', () => {
  const now = new Date('2026-10-20T12:00:00+08:00')
  const promos = parseModelPromotions(
    {
      modelPromotions: [
        { enabled: true, priority: 10, discount: { discountedCredits: '0.90x', factor: 0.9 }, modelIds: ['m'] },
        { enabled: true, priority: 200, discount: { discountedCredits: '0.10x', factor: 0.1 }, modelIds: ['m'] },
        { enabled: true, priority: 50, discount: { discountedCredits: '0.50x', factor: 0.5 }, modelIds: ['m'] },
      ],
    },
    now,
  )
  assert.equal(promos.get('m')?.value, 0.1, '取 priority 200 那条')
})

test('★ parseModelPromotions：factor:0 + 有窗口 = 免费（不是「已结束」）', () => {
  // 参考实现实测 hy4-preview 的夜间活动就是 {discountedCredits:"0x", factor:0}
  // —— 它**真的免费**。早期实现把 0x 当哨兵丢弃，于是「夜间免费」永远不显示
  // （用户报障「hy4 preview 夜间 0，现在显示 0.29」）。真正的「已结束」由有效期表达。
  const now = new Date('2026-10-20T12:00:00+08:00')
  const promos = parseModelPromotions(
    {
      modelPromotions: [
        {
          enabled: true,
          discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
          modelIds: ['hy3'],
          schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
        },
      ],
    },
    now,
  )
  assert.equal(promos.get('hy3')?.value, 0, '★ factor:0 是免费')
  assert.equal(promos.get('hy3')?.text, '免费', '语义是一句断言，不是「倍率 0」这个数字')
})

test('parseModelPromotions：无时间窗口的 factor:0 视为「已结束」占位，跳过', () => {
  // 防御：免费额度必然是限时的，没有窗口的 0x 更可能是遗留占位（参考实现同款口径）。
  const now = new Date('2026-10-20T12:00:00+08:00')
  const promos = parseModelPromotions(
    { modelPromotions: [{ enabled: true, discount: { discountedCredits: '0x', factor: 0 }, modelIds: ['m'] }] },
    now,
  )
  assert.equal(promos.size, 0)
})

test('parseModelPromotions：每日时段（含跨零点）按此刻判定', () => {
  const schedule = { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' }
  const mk = () => ({
    modelPromotions: [
      { enabled: true, discount: { discountedCredits: '0.50x', factor: 0.5 }, modelIds: ['glm-5.2'], schedule },
    ],
  })
  // 北京时间 02:00 落在 23:00–7:50 内（跨零点）
  assert.equal(parseModelPromotions(mk(), new Date('2026-10-20T02:00:00+08:00')).size, 1)
  // 北京时间 12:00 不在窗口内
  assert.equal(parseModelPromotions(mk(), new Date('2026-10-20T12:00:00+08:00')).size, 0)
})

test('parseModelPromotions：结构不符时返回空 Map（不抛错）', () => {
  assert.equal(parseModelPromotions({}).size, 0)
  assert.equal(parseModelPromotions({ modelPromotions: 'nope' }).size, 0)
  assert.equal(parseModelPromotions({ modelPromotions: [null, 'x', 42] }).size, 0)
})

test('formatCreditsRate：有促销时保留「原价→促销价」两段', () => {
  // ⚠️ 促销是**活动价**，不能把原价丢掉 —— 只显示促销价会让用户按折扣预期、
  // 实际按原价计费时无从对账。
  const rate = { value: 0.29, text: 'x0.29' }
  const discounted = { value: 0.15, text: 'x0.15' }
  assert.equal(formatCreditsRate(rate, discounted), 'x0.29→x0.15')
  assert.equal(formatCreditsRate(rate, undefined), 'x0.29', '无促销时只显示原价')
  assert.equal(formatCreditsRate(undefined, discounted), 'x0.15', '只有促销时显示促销价')
  assert.equal(formatCreditsRate(undefined, undefined), undefined, '都没有 = 未知，不要编')
})

// ─────────────────── 缺陷 B：真实 /v3/config → multiplier ───────────────────

test('★ parseModelsFromConfig：用真实 /v3/config 的 credits 值逐条解析倍率', () => {
  // fixture 的 credits 值**逐条取自本机真打**（2026-10-20，workbuddy-intl，HTTP 200，
  // `data.models` 28 条）。见 `.scratch/probe-buddy-promotions-raw.mjs` 的输出。
  const body = {
    data: {
      agents: [{ name: 'cli', models: ['fast-model', 'primary-model', 'hy4-preview', 'hy3', 'default-model', 'deepseek-v4.1-flash'] }],
      models: [
        { id: 'default-model', name: 'Auto', credits: '' },                    // 空串 = 未知
        { id: 'fast-model', name: 'Fast', credits: 'x0.34 credits' },          // 带单位后缀
        { id: 'primary-model', name: 'Primary', credits: 'x3.31 credits' },
        { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29' },
        { id: 'hy3', name: 'Hy3', credits: 'x0.00' },                          // 0 = 免费
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek', credits: 'x0.00' },
      ],
    },
  }
  const byId = new Map(parseModelsFromConfig(body).map((m) => [m.id, m]))

  assert.equal(byId.get('fast-model').multiplier, 0.34)
  assert.equal(byId.get('fast-model').multiplierSource, 'buddy:config')
  assert.equal(byId.get('primary-model').multiplier, 3.31)
  assert.equal(byId.get('hy4-preview').multiplier, 0.29)
  assert.equal(byId.get('hy3').multiplier, 0, '★ x0.00 是 0，不是 undefined')
  assert.equal(byId.get('hy3').free, true, '★ 0 要同时标 free')
  assert.equal(byId.get('deepseek-v4.1-flash').multiplier, 0)
  assert.equal(byId.get('deepseek-v4.1-flash').free, true)

  // ★ 空串 = 未知：**不放 multiplier 键**（不是 0、也不是 1）
  const auto = byId.get('default-model')
  assert.equal(auto.multiplier, undefined, '★ credits="" 必须解析成「未知」')
  assert.equal(auto.free, undefined)
  assert.equal(auto.multiplierSource, undefined, '未知时不该声称有来源')
  assert.ok(!('multiplier' in auto), '未知时连键都不该有')
})

test('★ parseModelsFromConfig：解析不出时绝不给 1（编造倍率比不显示更糟）', () => {
  const list = parseModelsFromConfig({
    data: {
      models: [
        { id: 'a', credits: 'garbage' },
        { id: 'b', credits: 'x' },
        { id: 'c' },                      // 字段缺失
        { id: 'd', credits: 0.5 },        // 数字不是上游形态
      ],
    },
  })
  for (const meta of list) {
    assert.equal(meta.multiplier, undefined, `${meta.id} 不该有倍率`)
    assert.notEqual(meta.multiplier, 1, `${meta.id} 绝不能回退成 ×1`)
    assert.notEqual(meta.multiplier, 0, `${meta.id} 也不能被当成免费`)
  }
})

test('parseModelsFromConfig：促销生效时 multiplier 用促销价、description 保留原价', () => {
  // ⚠️ 方向不能反：拿原价当 multiplier 会让打了折的模型显示成原价。
  const body = {
    data: {
      agents: [{ name: 'cli', models: ['glm-5.2'] }],
      models: [{ id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.59' }],
      modelPromotions: [
        {
          enabled: true,
          priority: 100,
          discount: { discountedCredits: '0.15x', displayMode: 'strikethrough', factor: 0.15 },
          modelIds: ['glm-5.2'],
          schedule: { validFrom: '2026-10-01T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
        },
      ],
    },
  }
  const meta = parseModelsFromConfig(body).find((m) => m.id === 'glm-5.2')
  // 系统的「现在」落在或不在窗口内都取决于运行时刻，所以断言两种自洽结果之一
  const inWindow = Date.now() >= Date.parse('2026-10-01T00:00:00+08:00')
    && Date.now() < Date.parse('2026-11-01T00:00:00+08:00')
  if (inWindow) {
    assert.equal(meta.multiplier, 0.15, '★ 生效价 = 促销价')
    assert.equal(meta.description, '倍率 x0.59→x0.15', '★ 原价必须保留在描述里')
  } else {
    assert.equal(meta.multiplier, 0.59, '窗口外回到原价')
    assert.equal(meta.description, undefined, '无促销时不写冗余描述')
  }
})

test('parseModelsFromConfig：促销价与原价相同时不写 description（免费→免费是噪音）', () => {
  // 实测（2026-10-20）：hy3 / deepseek-v4.1-flash / step-5-preview 的 credits 本来就是
  // "x0.00"（免费），活动又给一个 factor:0 的免费 ⇒ 文案会拼成 `x0.00→免费`，
  // 「免费→免费」信息量为零。
  const body = {
    data: {
      agents: [{ name: 'cli', models: ['hy3'] }],
      models: [{ id: 'hy3', name: 'Hy3', credits: 'x0.00' }],
      modelPromotions: [
        {
          enabled: true,
          priority: 200,
          discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
          modelIds: ['hy3'],
          schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
        },
      ],
    },
  }
  const meta = parseModelsFromConfig(body).find((m) => m.id === 'hy3')
  assert.equal(meta.multiplier, 0, '仍然是免费')
  assert.equal(meta.free, true)
  assert.equal(meta.description, undefined, '★ 免费→免费 不该产生描述')
})

test('parseModelsFromConfig：无促销时不写冗余 description', () => {
  // 倍率本身已经渲染成 `(×0.34)`，再写一句「倍率 x0.34」是噪音、还撑长选择器行。
  const list = parseModelsFromConfig({
    data: { models: [{ id: 'fast-model', name: 'Fast', credits: 'x0.34 credits' }] },
  })
  assert.equal(list[0].multiplier, 0.34)
  assert.equal(list[0].description, undefined)
})

test('parseModelsFromConfig：既有字段（窗口 / 图片 / 推理）不受倍率改动影响', () => {
  const list = parseModelsFromConfig({
    data: {
      models: [{
        id: 'hy3', name: 'Hy3', maxInputTokens: 192000, supportsImages: true,
        reasoning: {}, credits: 'x0.00',
      }],
    },
  })
  const meta = list[0]
  assert.equal(meta.contextWindow, 192000)
  assert.deepEqual(meta.inputModalities, ['text', 'image'])
  assert.equal(meta.reasoning, true)
  assert.equal(meta.multiplier, 0)
})

// ═════════════════ task-12：思考档位（reasoning.supportedEfforts） ═════════════════
//
// 用户问：「为什么 workbuddy 的 deepseek 模型不能调整思考等级呢？qoder 的就可以呢」
//
// 查下来是**两件事叠在一起**：
//   ① 我们漏读了 `data.models[].reasoning.supportedEfforts` —— 影响 **19 个**模型（真 bug）；
//   ② 用户恰好试到的 DeepSeek 那两条，**上游本来就锁死单档**（没有档位行是**正确**行为）。
//
// ## fixture 出处（**全部来自本机真打**，2026-10-20，workbuddy-intl，HTTP 200）
//
// 见 `.scratch/probe-buddy-efforts-dump.mjs` 的输出：`data.models` 共 28 条，
// **19 条有 `supportedEfforts`、9 条没有**。下面用到的每一组值都是照抄的。
//
// | 形态 | 真实样本 |
// |---|---|
// | 有档位 | `hy3:["low","high"]` / `gpt-5.6-sol:["low","medium","high","xhigh","max"]` / `minimax-m3.1-flash`（default=`max`）|
// | **无**档位（DeepSeek 真实形状） | `{"effort":"high","summary":"auto"}` + `onlyReasoning:true` |

/** 真上游的 reasoning 字段逐条出处：见文件头表格。 */
const REAL_EFFORTS = {
  'hy4-preview': { supportedEfforts: ['high'], defaultEffort: 'high' },
  hy3: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' },
  'kimi-k2.8-preview': { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  'gpt-5.6-sol': { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  'glm-5.2': { supportedEfforts: ['high', 'xhigh'], defaultEffort: 'high' },
  'minimax-m3.1-flash': { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'max' },
  'gemini-3.8-flash': { supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
}

/** ★ DeepSeek 两条的**真实形状**：只有单一 effort，没有 supportedEfforts。 */
const REAL_DEEPSEEK = { effort: 'high', summary: 'auto' }

// ─────────────────── 读能力：有档位 / 没有档位 ───────────────────

test('★ 有 supportedEfforts → 报出 reasoningEfforts（逐条对上真上游）', () => {
  const body = {
    data: {
      models: Object.entries(REAL_EFFORTS).map(([id, r]) => ({
        id, name: id, credits: 'x0.29',
        reasoning: { ...r },
      })),
    },
  }
  const byId = new Map(parseModelsFromConfig(body).map((m) => [m.id, m]))

  assert.deepEqual(byId.get('hy3').reasoningEfforts, ['low', 'high'], 'hy3 真值')
  assert.deepEqual(byId.get('hy4-preview').reasoningEfforts, ['high'])
  assert.deepEqual(byId.get('kimi-k2.8-preview').reasoningEfforts, ['low', 'high', 'max'])
  assert.deepEqual(byId.get('gpt-5.6-sol').reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(byId.get('glm-5.2').reasoningEfforts, ['high', 'xhigh'])
  assert.deepEqual(byId.get('gemini-3.8-flash').reasoningEfforts, ['low', 'medium', 'high'])

  // defaultEffort 有则报
  assert.equal(byId.get('hy3').defaultReasoningEffort, 'high')
  assert.equal(byId.get('minimax-m3.1-flash').defaultReasoningEffort, 'max', '真值不是 high')
  assert.equal(byId.get('gemini-3.8-flash').defaultReasoningEffort, 'medium')
})

test('★ 防回归：没有 supportedEfforts 的模型（DeepSeek 真实形状）→ **不报** reasoningEfforts', () => {
  // 这是本任务最重要的一条。上游**只对真正支持多等级的模型**下发 supportedEfforts；
  // 只有单一 effort 的模型此处缺省 ⇒ **不暴露等级选择器**。
  // 给它编一组档位就是谎报能力：用户选了、上游 400，而他无从知道是插件编的。
  const list = parseModelsFromConfig({
    data: {
      models: [
        { id: 'deepseek-v4.1-flash', name: 'DeepSeek', credits: 'x0.00', onlyReasoning: true, reasoning: { ...REAL_DEEPSEEK } },
        { id: 'deepseek-v4.1-flash-sg', name: 'DeepSeek SG', credits: 'x0.03', onlyReasoning: true, reasoning: { ...REAL_DEEPSEEK } },
      ],
    },
  })
  for (const meta of list) {
    assert.equal(meta.reasoningEfforts, undefined, `${meta.id} 绝不能有档位（上游没声明）`)
    assert.ok(!('reasoningEfforts' in meta), `${meta.id} 连键都不该有`)
    // ★ 核心层的判据是「数组且非空」，两者都保证不出档位行
    assert.equal(Array.isArray(meta.reasoningEfforts) && meta.reasoningEfforts.length > 0, false)
  }
})

test('★ 防回归：绝不给没声明的模型编一组「看起来合理」的档位', () => {
  // 反面清单：任何常见的「通用档位」都不该出现在没声明的模型上。
  const meta = parseModelsFromConfig({
    data: { models: [{ id: 'deepseek-v4.1-flash', reasoning: { ...REAL_DEEPSEEK } }] },
  })[0]
  for (const invented of [['low', 'high'], ['low', 'medium', 'high'], ['low', 'high', 'max'], ['none', 'low', 'high']]) {
    assert.notDeepEqual(meta.reasoningEfforts, invented, `不该编出 ${invented.join('/')}`)
  }
})

test('supportedEfforts: [] （空数组）→ 视同没有，不出档位行', () => {
  const list = parseModelsFromConfig({
    data: { models: [{ id: 'x', reasoning: { supportedEfforts: [], defaultEffort: 'high' } }] },
  })
  assert.equal(list[0].reasoningEfforts, undefined, '空数组 = 没有可枚举档位')
  // ⚠️ defaultEffort 单独存在也**不足以**出档位行 —— 核心层只看 reasoningEfforts。
  // 这与 DeepSeek 的处境一致：它有一个默认 effort，但仍不该有档位行。
  assert.equal(list[0].defaultReasoningEffort, 'high', '声明了还是要如实带出')
})

test('supportedEfforts 里混入非字符串 / 空串 → 过滤掉；全被过滤则不出档位行', () => {
  // 上游偶尔会混进 null / 空串，直接喂给核心层会在选择器里出现空行。
  const mixed = parseModelsFromConfig({
    data: { models: [{ id: 'a', reasoning: { supportedEfforts: ['low', null, '', 'high', 42] } }] },
  })[0]
  assert.deepEqual(mixed.reasoningEfforts, ['low', 'high'], '只留非空字符串')

  const allJunk = parseModelsFromConfig({
    data: { models: [{ id: 'b', reasoning: { supportedEfforts: [null, '', 42] } }] },
  })[0]
  assert.equal(allJunk.reasoningEfforts, undefined, '过滤后为空 ⇒ 视同没有')
})

test('reasoning 字段类型不对时不抛错、不出档位行', () => {
  const list = parseModelsFromConfig({
    data: {
      models: [
        { id: 'a', reasoning: null },
        { id: 'b', reasoning: 'high' },
        { id: 'c', reasoning: { supportedEfforts: 'low' } },   // 不是数组
        { id: 'd', reasoning: { defaultEffort: '' } },          // 空串
        { id: 'e' },                                            // 完全没有
      ],
    },
  })
  for (const meta of list) assert.equal(meta.reasoningEfforts, undefined, `${meta.id}`)
  assert.equal(list.find((m) => m.id === 'd').defaultReasoningEffort, undefined, '空串不当声明')
})

test('defaultEffort 缺省 → 不报 defaultReasoningEffort（不猜）', () => {
  const list = parseModelsFromConfig({
    data: { models: [{ id: 'a', reasoning: { supportedEfforts: ['low', 'high'] } }] },
  })
  assert.deepEqual(list[0].reasoningEfforts, ['low', 'high'])
  assert.equal(list[0].defaultReasoningEffort, undefined, '上游没给默认档就别编')
})

test('★ 真上游规模：19 条有档位 / 9 条没有（用真实 id 清单核对）', () => {
  // 本机真打（2026-10-20）的完整清单。这条用例的作用是**锁住「19」这个数字**：
  // 修复前是 0（我们完全没读这个字段），任务书期望 19。
  const withEfforts = Object.keys(REAL_EFFORTS)
  const withoutEfforts = [
    'default-model', 'fast-model', 'balanced-model', 'primary-model',
    'deepseek-v4.1-flash', 'deepseek-v4.1-flash-sg',
    'gemini-3.5-flash', 'kimi-k3', 'kimi-k2.6',
  ]
  const body = {
    data: {
      models: [
        ...withEfforts.map((id) => ({ id, reasoning: { ...REAL_EFFORTS[id] } })),
        ...withoutEfforts.map((id) => ({
          id,
          reasoning: id === 'default-model' ? undefined : { ...REAL_DEEPSEEK },
        })),
      ],
    },
  }
  const list = parseModelsFromConfig(body)
  const rows = list.filter((m) => Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0)
  assert.equal(rows.length, withEfforts.length, `有档位的应恰好 ${withEfforts.length} 条`)
  for (const id of withoutEfforts) {
    const meta = list.find((m) => m.id === id)
    assert.equal(meta.reasoningEfforts, undefined, `${id} 不该有档位行`)
  }
})

// ─────────────────── 请求侧：决定发什么 ───────────────────

test('★ decideReasoningEffort：选了模型支持的档 → 下发', () => {
  const d = decideReasoningEffort({ requested: 'low', supported: ['low', 'high'], isDeepSeek: false })
  assert.equal(d.effort, 'low')
  assert.equal(d.thinking, false)
})

test('★ decideReasoningEffort：选了**不支持**的档 → 不下发（否则上游 400）', () => {
  const d = decideReasoningEffort({ requested: 'max', supported: ['low', 'high'], isDeepSeek: false })
  assert.equal(d.effort, undefined, 'hy3 只声明 [low,high]，max 发出去会 400')
  assert.equal(d.thinking, false)
})

test('★ decideReasoningEffort：能力未知（supported===undefined）→ 原样放行', () => {
  // 与核心层口径一致：`undefined` = 我们不知道该模型接受什么 ⇒ 拦下来等于
  // 把调用方的显式选择静默丢掉。`[]` 才是「确认没有档位」。
  const d = decideReasoningEffort({ requested: 'xhigh', isDeepSeek: false })
  assert.equal(d.effort, 'xhigh')
})

test('★ decideReasoningEffort：DeepSeek 没选档 → 必须补一个 + 带 thinking', () => {
  // 三站点实测：裸请求/只带 thinking → `reasoning_content` 恒为 0；
  // **`reasoning_effort` 才是开关**。所以 DeepSeek 必须有一个档位。
  const d = decideReasoningEffort({ isDeepSeek: true, singleEffort: 'high' })
  assert.equal(d.effort, 'high', '★ 用上游自己声明的单一档，不是我们猜的')
  assert.equal(d.thinking, true)
})

test('★ decideReasoningEffort：DeepSeek 的档位回退顺序', () => {
  // 上游默认档 → 上游单一档 → high（在支持集内）→ 支持集首个
  assert.equal(decideReasoningEffort({ isDeepSeek: true, defaultEffort: 'medium', supported: ['low', 'medium'] }).effort, 'medium')
  assert.equal(decideReasoningEffort({ isDeepSeek: true, singleEffort: 'xhigh' }).effort, 'xhigh')
  assert.equal(decideReasoningEffort({ isDeepSeek: true, supported: ['low', 'high', 'max'] }).effort, 'high')
  assert.equal(decideReasoningEffort({ isDeepSeek: true, supported: ['low', 'medium'] }).effort, 'low', '没有 high 就取最低支持档')
})

test('★ decideReasoningEffort：绝不臆造模型未声明的档位', () => {
  // 拿不到任何档位信息时：带 thinking（对齐官方客户端），但**不发档位**。
  const d = decideReasoningEffort({ isDeepSeek: true })
  assert.equal(d.effort, undefined, '★ 编一个档位就可能被服务端 400')
  assert.equal(d.thinking, true)
})

test('★ decideReasoningEffort：thinking **只对 DeepSeek** 加', () => {
  // glm / kimi 等走各自的 thinkingFormat，不需要这个开关（参考实现同款）。
  assert.equal(decideReasoningEffort({ isDeepSeek: false, supported: ['low', 'high'] }).thinking, false)
  assert.equal(decideReasoningEffort({ isDeepSeek: false }).thinking, false)
  assert.equal(decideReasoningEffort({ isDeepSeek: true }).thinking, true)
})

test('★ decideReasoningEffort：DeepSeek 声明了档位时也照常校验所选的档', () => {
  // 若某天上游给 DeepSeek 也下发 supportedEfforts，所选不被支持时仍不该原样发；
  // 但 DeepSeek 会落到兜底（补一个合法档），不是「什么都不发」。
  const d = decideReasoningEffort({ requested: 'ultra', supported: ['low', 'high'], isDeepSeek: true })
  assert.equal(d.effort, 'high', '回退到合法档而不是发非法的 ultra')
})

test('★ decideReasoningEffort：上游默认档若不在支持集内 → 视为未声明，继续回退', () => {
  // 远端数据可能自相矛盾（声明了 default 却不在 supported 里）。
  const d = decideReasoningEffort({ isDeepSeek: true, defaultEffort: 'ultra', supported: ['low', 'high'] })
  assert.equal(d.effort, 'high', '不采信矛盾的默认档，回退到 high')
})

test('isDeepSeekModel：按 id 前缀判定（与参考实现同款）', () => {
  assert.equal(isDeepSeekModel('deepseek-v4.1-flash'), true)
  assert.equal(isDeepSeekModel('deepseek-v4.1-flash-sg'), true)
  assert.equal(isDeepSeekModel('DeepSeek-V4-Pro'), true, '大小写不敏感')
  assert.equal(isDeepSeekModel('  deepseek-x  '), true, '两侧空白要容忍')
  assert.equal(isDeepSeekModel('my-deepseek'), false, '必须**前缀**命中')
  assert.equal(isDeepSeekModel('gpt-5.6-sol'), false)
  assert.equal(isDeepSeekModel(''), false)
})

test('parseReasoningFields：字段名与参考实现 parseModelMeta 逐条对齐', () => {
  // 有档位
  assert.deepEqual(parseReasoningFields({ reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' } }), {
    supportedEfforts: ['low', 'high'], defaultEffort: 'high',
  })
  // 只有单一 effort（DeepSeek 真实形状）
  assert.deepEqual(parseReasoningFields({ reasoning: { ...REAL_DEEPSEEK } }), { singleEffort: 'high' })
  // 什么都没有
  assert.deepEqual(parseReasoningFields({}), {})
  assert.deepEqual(parseReasoningFields(undefined), {})
  assert.deepEqual(parseReasoningFields({ reasoning: null }), {})
})

// ─────────────────── 请求侧：wire 上真的发了什么 ───────────────────

test('★ wire：国际版 + 已声明的档位 → 请求体带 reasoning_effort', async () => {
  const { ctx, calls } = chatCtx()
  // 先拉一次目录填缓存（生产里的真实顺序）
  await seedReasoning(ctx, { hy3: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' } })
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account(), 'hy3', 'low')

  const body = JSON.parse(String(calls.at(-1).body))
  assert.equal(body.reasoning_effort, 'low')
})

test('★ wire：选了**不支持**的档 → 请求体**不带** reasoning_effort', async () => {
  const { ctx, calls } = chatCtx()
  await seedReasoning(ctx, { hy3: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' } })
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account(), 'hy3', 'max')

  const body = JSON.parse(String(calls.at(-1).body))
  assert.equal(body.reasoning_effort, undefined, '★ 发没声明过的档上游会 400')
  assert.ok(!('reasoning_effort' in body))
})

test('★ wire：DeepSeek 未选档 → 补一个档位 **且** 带 thinking', async () => {
  // 三站点实测：只带 thinking 不生效、只带 effort 才是开关；DeepSeek 没有档位
  // 就等于「不思考」。所以这里两者都必须有。
  const { ctx, calls } = chatCtx()
  await seedReasoning(ctx, { 'deepseek-v4.1-flash': { effort: 'high', summary: 'auto' } })
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account(), 'deepseek-v4.1-flash')

  const body = JSON.parse(String(calls.at(-1).body))
  assert.equal(body.reasoning_effort, 'high', '★ 用上游声明的单一档')
  assert.deepEqual(body.thinking, { type: 'enabled' }, '★ DeepSeek 必须带 thinking')
})

test('★ wire：非 DeepSeek 不带 thinking', async () => {
  const { ctx, calls } = chatCtx()
  await seedReasoning(ctx, { hy3: { supportedEfforts: ['low', 'high'] } })
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account(), 'hy3', 'low')

  const body = JSON.parse(String(calls.at(-1).body))
  assert.equal(body.thinking, undefined)
})

test('★ wire：核心层塞了一个不被支持的档位时，必须被清掉（不能留在 body 里）', async () => {
  // 核心层在「拿不到我们的档位声明」时会**原样放行**用户请求的档位。
  // 我们这里重新算过之后，若不把旧值删掉，spread 会把它留在 body 里 → 400。
  const { ctx, calls } = chatCtx()
  await seedReasoning(ctx, { hy3: { supportedEfforts: ['low', 'high'] } })
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account(), 'hy3', 'ultra')

  const body = JSON.parse(String(calls.at(-1).body))
  assert.equal(body.reasoning_effort, undefined, '★ 不能让不受支持的旧值漏出去')
})

test('★ wire：目录没拉到（缓存空）→ 原样放行请求的档位（不静默丢弃）', async () => {
  const { ctx, calls } = chatCtx()
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account(), 'hy3', 'low')

  const body = JSON.parse(String(calls.at(-1).body))
  assert.equal(body.reasoning_effort, 'low', '能力未知时拦下来等于丢掉用户的显式选择')
})

test('★ wire：档位判定不改变其它请求字段', async () => {
  const { ctx, calls } = chatCtx()
  await seedReasoning(ctx, { hy3: { supportedEfforts: ['low', 'high'] } })
  await drainChat(INTL, ctx, [{ role: 'user', content: 'hi' }], account(), 'hy3', 'low')

  const body = JSON.parse(String(calls.at(-1).body))
  assert.equal(body.model, 'hy3')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.equal(body.messages[0].role, 'system', '补 system 的守卫仍在')
})

// ── issue #4：回退内置表也要带 reasoning 声明 ──

test('★ /v3/config 拉取失败回退内置表时，模型仍带 reasoning 声明（issue #4）', async () => {
  const { ctx } = chatCtx()
  ctx.fetch = async () => {
    throw new Error('network down')
  }
  const list = await CN.getModelMetaList(account(), ctx)
  const hy = list.find((item) => item.id === 'hy4-preview')
  assert.ok(hy !== undefined, '回退表里必须有 hy4-preview')
  // 没有这一条，DSH 核心层会把「没声明」当成「不支持」，用户配了 effort 就整轮抛错。
  assert.deepEqual(hy.reasoningEfforts, ['high'])
  assert.equal(hy.defaultReasoningEffort, 'high')
  assert.equal(CN.modelListSource(), 'fallback')
})

test('★ /v3/config 拉取成功时不把来源标成 fallback', async () => {
  const { ctx } = chatCtx()
  ctx.fetch = async () =>
    new Response(
      JSON.stringify({ data: { models: [{ id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000 }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  await CN.getModelMetaList(account(), ctx)
  assert.equal(CN.modelListSource(), 'live')
})

// ── issue #6：429 的退避与 requestId ──

test('★ 429 带 Retry-After 时直接用头里的值', async () => {
  const { ctx } = chatCtx()
  ctx.fetch = async () =>
    new Response(JSON.stringify({ code: 6004, msg: 'too many requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '3600' },
    })
  const events = await drainChat(CN, ctx, [{ role: 'user', content: 'hi' }])
  const failure = events.find((event) => event.type === 'error')?.failure
  assert.ok(failure !== undefined)
  assert.equal(failure.kind, 'rate_limit')
  assert.equal(failure.retryAfterMs, 3_600_000)
})

test('★ 429 不带 Retry-After 时从报文读重置时刻 + requestId（issue #6）', async () => {
  const { ctx } = chatCtx()
  const body = JSON.stringify({
    code: 6004,
    msg: '当前请求较多，将在 2027-01-01 00:00:00 UTC+8 重置',
    requestId: 'req-fixture-1',
  })
  ctx.fetch = async () => new Response(body, { status: 429, headers: { 'content-type': 'application/json' } })
  const events = await drainChat(CN, ctx, [{ role: 'user', content: 'hi' }])
  const failure = events.find((event) => event.type === 'error')?.failure
  assert.ok(failure !== undefined)
  assert.equal(failure.kind, 'rate_limit')
  assert.equal(failure.requestId, 'req-fixture-1')
  assert.ok(typeof failure.retryAfterMs === 'number' && failure.retryAfterMs > 0, '必须解析出退避时长')
  const expected = Date.parse('2027-01-01T00:00:00+08:00') - Date.now()
  assert.ok(Math.abs(failure.retryAfterMs - expected) < 5000, `退避偏差过大：${failure.retryAfterMs} vs ${expected}`)
})