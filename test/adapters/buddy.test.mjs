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

import { BuddyAdapter, BUDDY_CN, BUDDY_INTL, capabilitiesFor } from '../../lib/adapters/buddy.js'
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
