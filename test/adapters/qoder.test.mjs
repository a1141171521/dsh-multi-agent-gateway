/**
 * Qoder / Qoder CN 的**签到与额度**单测。
 *
 * 全部用假的 `ctx.http`，**不真打上游**（真上游验证走 `.scratch/probe-chat.mjs`）。
 *
 * 这里的每条用例都对应一个真实缺陷或一条实测结论，注释里写了「为什么」——
 * 删掉某条断言之前先读它的理由。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { QoderAdapter, QODER_CN, qoderEffortsOf } from '../../lib/adapters/qoder.js'
import {
  claimableQoderCampaigns,
  hasClaimedQoderBenefit,
  interpretQoderClaim,
  isQoderNotActivated,
  parseQoderCampaigns,
  parseQoderUsage,
  qoderCreditsHeaders,
  qoderTotalRemaining,
} from '../../lib/vendor/qoder/qoder-credits.js'

// ───────────────────────────── 真实响应样本 ─────────────────────────────
//
// 全部来自本机 2026-10-19 对真实 qoder-cn 账号的实测响应（原样摘录，没有编造）。
// ⚠️ 改这些样本前先重跑一遍探针，别凭印象改。

/** `/sash/api/v2/me/usage` 实测响应。`userQuota` 是恒为 0 的占位。 */
const USAGE_BODY = {
  displayMode: 'qoder',
  qoderUsage: {
    userId: '019e88b9-1c04-7552-8feb-7b4a137d4c3d',
    userType: 'personal_standard',
    usageType: 'credits',
    totalUsagePercentage: 0.15,
    isQuotaExceeded: false,
    expiresAt: 253402214400000,
    upgradeUrl: 'https://qoder.cn/pricing?client=qoder',
    userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
    addOnQuota: {
      total: 1000,
      used: 142,
      remaining: 858,
      percentage: 0.15,
      unit: 'credits',
      detailUrl: 'https://qoder.cn/account/usage',
    },
  },
}

/**
 * `/sash/api/v1/me/campaigns` 实测响应（**今天已领**的状态）。
 *
 * ⚠️ 两条活动的 `claimStatus` **都是 `CLAIMED`** —— 包括那条 `VIEW_DETAILS`
 * 纯展示活动。所以任何「有 CLAIMED 就算已领」的写法都会误判，
 * 必须先按 `actionType` 过滤。
 */
function campaignsBody(list) {
  return {
    uid: '019e88b9-1c04-7552-8feb-7b4a137d4c3d',
    showCampaign: list.length > 0,
    claimable: list.some((item) => item.claimStatus === 'CLAIMABLE'),
    campaignUrl: 'https://openapi.qoder.com.cn/growth-page/activity-iframe',
    campaigns: list,
  }
}

/** 每日领取那条活动（`CLAIM_BENEFIT`）。 */
function benefitCampaign(claimStatus) {
  return {
    campaignId: '01a130ec-98c5-74dc-a29b-ac1ef0d1416c',
    campaignKey: 'act-20261013-146',
    actionType: 'CLAIM_BENEFIT',
    claimStatus,
    benefit: {
      kind: 'CREDITS',
      amount: 100,
      modelScope: { modelSeries: { key: 'ALL_MODELS' } },
      validity: { mode: 'RELATIVE_DAYS', days: 30 },
    },
  }
}

/** 「Pro 首月翻倍」那条纯展示活动 —— **同样带 `CLAIMED`**。 */
const VIEW_DETAILS_CAMPAIGN = {
  campaignId: '01a05bbf-5668-7031-83d6-91545f97ec05',
  campaignKey: 'act-20260901-922',
  actionType: 'VIEW_DETAILS',
  claimStatus: 'CLAIMED',
}

// ───────────────────────────── 测试脚手架 ─────────────────────────────

const record = (credentials = { token: 'dt-fake-token', uid: 'u-1' }) => ({
  id: 'qoder-cn:t',
  agentId: 'qoder-cn',
  label: '测试号',
  credentials,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
})

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }

/**
 * 造一个假的 `ctx`。
 *
 * `routes` 是 `路径 → 响应`；值是函数时按 `(init)` 调用（领取要按 body 区分）。
 * `calls` 记录每次请求，供「不该发请求」这类断言用。
 */
function fakeCtx(routes, nowMs) {
  const calls = []
  return {
    calls,
    config: { requestTimeoutMs: 15_000, retry: { maxAttempts: 1, backoffMs: 1, maxBackoffMs: 2 } },
    log: silent,
    cache: { get: () => undefined, set() {}, delete() {}, keys: () => [] },
    now: () => nowMs,
    http: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body, headers: init.headers })
      const path = new URL(url).pathname
      const handler = routes[path]
      if (handler === undefined) {
        return { ok: false, status: 404, kind: 'not_found', headers: new Headers(), body: undefined, text: '' }
      }
      const value = typeof handler === 'function' ? handler(init) : handler
      if (value === 'network-error') throw new Error('模拟网络失败')
      if (value.ok === false) {
        return {
          ok: false,
          status: value.status,
          kind: value.kind,
          headers: new Headers(),
          body: value.body,
          text: '',
          message: value.message,
        }
      }
      return {
        ok: true,
        status: 200,
        kind: 'none',
        headers: new Headers(),
        body: value.body,
        text: JSON.stringify(value.body),
      }
    },
  }
}

/** 造一个「已刷新 / 未刷新」的绝对时刻（UTC+8 口径）。 */
// UTC+8 18:00 = UTC 10:00 → 已过 10:00，已刷新。
const AFTER_REFRESH = Date.UTC(2026, 9, 19, 10, 0)
// UTC+8 09:00 = UTC 01:00 → 还没到 10:00，未刷新。
const BEFORE_REFRESH = Date.UTC(2026, 9, 19, 1, 0)

const USAGE_PATH = '/sash/api/v2/me/usage'
const CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'

// ═══════════════════════════ 请求头 ═══════════════════════════

test('Qoder 请求头：带 Cosy-ClientType 10，且**不带** machine 头', () => {
  // 实测（2026-10-19，真实账号）：仅 '10' 就能拿到含 CLAIM_BENEFIT 的活动列表；
  // 加 machine 头结果完全相同；仅 '5' 则 campaigns=0。
  // ⚠️ 所以 '10' 是承重的，而 machine 头只会增加失败面 —— 回归时别把它们加回来。
  const headers = qoderCreditsHeaders(QODER_CN, 'tok')
  assert.equal(headers['cosy-clienttype'], '10', "Cosy-ClientType 必须是 '10'（桌面 app 身份）")
  assert.equal(headers.authorization, 'Bearer tok')
  assert.equal(headers['user-agent'], 'Qoder')
  const machineKeys = Object.keys(headers).filter((key) => key.toLowerCase().includes('machine'))
  assert.deepEqual(machineKeys, [], `不该带 machine 头，实际带了：${machineKeys.join(',')}`)
})

test('Qoder 请求头：取 product.sashClientType，不是 clientMetadata.client_type', () => {
  // 这两个是**不同身份**：client_type '5' 是 CLI（用于推理信封），
  // sashClientType '10' 是桌面客户端（用于 /sash/ 端点）。用错会拿不到活动。
  const headers = qoderCreditsHeaders(QODER_CN, 'tok')
  assert.notEqual(headers['cosy-clienttype'], QODER_CN.clientMetadata.client_type)
  assert.equal(headers['cosy-clienttype'], QODER_CN.sashClientType)
})

// ═══════════════════════════ 余额解析 ═══════════════════════════

test('Qoder 余额：addOnQuota 与 userQuota 都解析出来，且能区分「缺失」与「为 0」', () => {
  const usage = parseQoderUsage(USAGE_BODY)
  assert.ok(usage !== undefined)
  assert.deepEqual(usage.userQuota, {
    name: '套餐额度', unit: 'credits', total: 0, used: 0, remaining: 0,
  })
  assert.deepEqual(usage.addOnQuota, {
    name: '资源包', unit: 'credits', total: 1000, used: 142, remaining: 858,
  })
  assert.equal(usage.hasAddOnQuota, true)
  assert.equal(usage.userId, '019e88b9-1c04-7552-8feb-7b4a137d4c3d')
  assert.equal(usage.userType, 'personal_standard')
  assert.equal(qoderTotalRemaining(usage), 858)
})

test('Qoder 余额：addOnQuota 缺失时 hasAddOnQuota=false（这是「未开通」判据的一半）', () => {
  const withoutAddOn = {
    displayMode: 'qoder',
    qoderUsage: { userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' } },
  }
  const usage = parseQoderUsage(withoutAddOn)
  assert.equal(usage.hasAddOnQuota, false)
  assert.equal(usage.addOnQuota, undefined)
  // ⚠️ 「字段缺失」与「字段为 0」必须分开：用光额度的老账号是后者，不该被判成未开通。
  const zeroAddOn = {
    displayMode: 'qoder',
    qoderUsage: { addOnQuota: { total: 100, used: 100, remaining: 0, unit: 'credits' } },
  }
  const zeroUsage = parseQoderUsage(zeroAddOn)
  assert.equal(zeroUsage.hasAddOnQuota, true, 'remaining 为 0 但字段存在 → 仍然是「已开通」')
  assert.equal(zeroUsage.addOnQuota.remaining, 0)
})

test('Qoder 余额：负值 clamp 到 0（超额扣费/计量回滚会下发负值）', () => {
  const usage = parseQoderUsage({
    qoderUsage: { addOnQuota: { total: 100, used: 120, remaining: -20, unit: 'credits' } },
  })
  assert.equal(usage.addOnQuota.remaining, 0, '负的 remaining 不能原样透出')
  // remaining 缺失时按 total - used 兜底，同样 clamp
  const derived = parseQoderUsage({
    qoderUsage: { addOnQuota: { total: 100, used: 250, unit: 'credits' } },
  })
  assert.equal(derived.addOnQuota.remaining, 0)
})

test('Qoder 余额：形状非法返回 undefined，不假装「余额 0」', () => {
  assert.equal(parseQoderUsage(null), undefined)
  assert.equal(parseQoderUsage([]), undefined)
  assert.equal(parseQoderUsage({}), undefined)
  assert.equal(parseQoderUsage({ qoderUsage: 'nope' }), undefined)
})

// ═══════════════════════════ getQuota ═══════════════════════════

test('Qoder getQuota：remaining 取 addOnQuota（userQuota 恒 0，只读它会显示 0 积分）', async () => {
  const ctx = fakeCtx({ [USAGE_PATH]: { body: USAGE_BODY } }, AFTER_REFRESH)
  const snapshot = await new QoderAdapter(QODER_CN).getQuota(record(), ctx)
  assert.equal(snapshot.unit, 'credits')
  assert.equal(snapshot.remaining, 858, '真实余额在 addOnQuota.remaining，不是 userQuota 的 0')
  assert.equal(snapshot.total, 1000)
  assert.equal(snapshot.used, 142)
  assert.equal(snapshot.error, undefined)
  // 原始字段留给 UI 展开
  assert.equal(snapshot.extra.addOnQuota.remaining, 858)
  assert.equal(snapshot.extra.userQuota.remaining, 0)
  assert.equal(snapshot.extra.remainingSource, 'addOnQuota')
})

test('Qoder getQuota：没有 addOnQuota 时回退 userQuota，再没有才算全部之和', async () => {
  const onlyUser = {
    qoderUsage: { userQuota: { total: 500, used: 100, remaining: 400, unit: 'credits' } },
  }
  const first = await new QoderAdapter(QODER_CN).getQuota(
    record(),
    fakeCtx({ [USAGE_PATH]: { body: onlyUser } }, AFTER_REFRESH),
  )
  assert.equal(first.remaining, 400)
  assert.equal(first.extra.remainingSource, 'userQuota')

  const onlyDedicated = {
    qoderUsage: {
      dedicatedResourcePackages: [{ name: '专用包', total: 50, used: 10, remaining: 40, unit: 'credits' }],
    },
  }
  const second = await new QoderAdapter(QODER_CN).getQuota(
    record(),
    fakeCtx({ [USAGE_PATH]: { body: onlyDedicated } }, AFTER_REFRESH),
  )
  assert.equal(second.remaining, 40)
  assert.equal(second.extra.remainingSource, '全部资源包之和')
})

test('Qoder getQuota：查询失败给原因，不给 0', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  const unauthorized = await adapter.getQuota(
    record(),
    fakeCtx({ [USAGE_PATH]: { ok: false, status: 401, kind: 'auth', message: '未授权' } }, AFTER_REFRESH),
  )
  assert.equal(unauthorized.remaining, undefined, '失败时不能报 0（会让人以为额度被清空）')
  assert.match(unauthorized.error, /额度查询失败/)

  const failed = await adapter.getQuota(record(), fakeCtx({ [USAGE_PATH]: 'network-error' }, AFTER_REFRESH))
  assert.equal(failed.remaining, undefined)
  assert.match(failed.error, /额度查询失败/)
})

test('Qoder getQuota：企业版不给数字（报 0 会误导），给一句人话', async () => {
  const snapshot = await new QoderAdapter(QODER_CN).getQuota(
    record(),
    fakeCtx({ [USAGE_PATH]: { body: { displayMode: 'enterprise', detailUrl: 'https://x/y' } } }, AFTER_REFRESH),
  )
  assert.equal(snapshot.remaining, undefined)
  assert.match(snapshot.error, /企业版/)
  assert.equal(snapshot.extra.displayMode, 'enterprise')
})

test('Qoder getQuota：没有 token 时不发请求', async () => {
  const ctx = fakeCtx({}, AFTER_REFRESH)
  const snapshot = await new QoderAdapter(QODER_CN).getQuota(record({}), ctx)
  assert.equal(ctx.calls.length, 0)
  assert.match(snapshot.error, /token/)
})

// ═══════════════════════════ 活动列表解析 ═══════════════════════════

test('Qoder 活动列表：VIEW_DETAILS 也带 CLAIMED —— 必须先按 actionType 过滤', () => {
  // ⚠️ 这是本机实测（2026-10-19）才看清的一条：两条活动的 claimStatus 都是 CLAIMED。
  // 若不按 actionType 过滤，「有没有 CLAIMED」会在**从没有过每日领取的账号**上
  // 也判成「今天已领」。
  const parsed = parseQoderCampaigns(campaignsBody([benefitCampaign('CLAIMED'), VIEW_DETAILS_CAMPAIGN]))
  assert.equal(parsed.campaigns.length, 2)
  assert.equal(hasClaimedQoderBenefit(parsed), true, '有领分类活动已领')

  const onlyView = parseQoderCampaigns(campaignsBody([VIEW_DETAILS_CAMPAIGN]))
  assert.equal(
    hasClaimedQoderBenefit(onlyView),
    false,
    '只有 VIEW_DETAILS 时不能判成「今天已领」——它只是纯展示活动的状态',
  )
})

test('Qoder 活动列表：claimable 只在 CLAIM_BENEFIT + CLAIMABLE 时成立', () => {
  const mix = parseQoderCampaigns(
    campaignsBody([benefitCampaign('CLAIMABLE'), VIEW_DETAILS_CAMPAIGN]),
  )
  const claimable = claimableQoderCampaigns(mix)
  assert.equal(claimable.length, 1)
  assert.equal(claimable[0].campaignId, '01a130ec-98c5-74dc-a29b-ac1ef0d1416c')
  assert.equal(claimable[0].amount, 100, 'benefit.amount 要读出来')

  // VIEW_DETAILS 即使是 CLAIMABLE 也不该领
  const viewClaimable = parseQoderCampaigns(
    campaignsBody([{ ...VIEW_DETAILS_CAMPAIGN, claimStatus: 'CLAIMABLE' }]),
  )
  assert.deepEqual(claimableQoderCampaigns(viewClaimable), [], 'VIEW_DETAILS 永远不该尝试领取')
})

test('Qoder 活动列表：空列表与非法形状', () => {
  const empty = parseQoderCampaigns({ showCampaign: false, claimable: false, campaigns: [] })
  assert.deepEqual(empty.campaigns, [])
  assert.equal(empty.showCampaign, false)
  assert.equal(hasClaimedQoderBenefit(empty), false)
  assert.equal(parseQoderCampaigns(null), undefined)
  assert.equal(parseQoderCampaigns([]), undefined)
  // 没有 campaignId 的条目跳过（没有 id 就领不了）
  const noId = parseQoderCampaigns({ campaigns: [{ actionType: 'CLAIM_BENEFIT' }, benefitCampaign('CLAIMED')] })
  assert.equal(noId.campaigns.length, 1)
})

// ═══════════════════════════ 领取响应 ═══════════════════════════

test('Qoder 领取：replayed=true 判「今天已领」，不是「领取成功」', () => {
  // ⚠️ 重复领取**同样返回 200**。只看状态码会把「今天已领」误报成「+100」。
  //
  // ⚠️⚠️ 下面这份 `replayed:true` 的响应是**本机 2026-10-19 真实抓到的原样**：
  // 它**带 `benefit`**，与参考实现「回放响应不含 benefit」的说法不符。
  // 所以任何「有没有 benefit」的判据在本机都不成立 —— 只能认 `replayed` 本身。
  const replay = {
    grantId: '01a15366-08e3-7d77-8ab3-0e1ef524aa3c',
    status: 'CLAIMED',
    replayed: true,
    benefit: { kind: 'CREDITS', amount: 100 },
    campaignId: '01a130ec-98c5-74dc-a29b-ac1ef0d1416c',
    campaignKey: 'act-20261013-146',
    campaignVersion: 2,
    claimedAt: '2026-10-19T09:02:38.233484Z',
    grantedAt: '2026-10-19T09:02:38.459564Z',
  }
  assert.deepEqual(
    interpretQoderClaim(replay),
    { kind: 'already-claimed' },
    'replayed=true 就是回放，即使带着 benefit 也不能算本次到账',
  )

  const fresh = {
    status: 'CLAIMED',
    replayed: false,
    benefit: { kind: 'CREDITS', amount: 100 },
    claimedAt: '2026-10-19T00:00:00.000Z',
  }
  assert.deepEqual(interpretQoderClaim(fresh), { kind: 'claimed', amount: 100 })
})

test('Qoder 领取：benefit 的有无**不能**当判据（真机回放响应带 benefit）', () => {
  // 这条守的是一个很容易写错的方向：
  //   「没 benefit 就算回放」→ 在本机**永远不成立**（回放也带 benefit）→ 重复领取全被当成功；
  //   「有 benefit 就算成功」→ 每次都把「今天已领」误报成 +100。
  const replayWithBenefit = { status: 'CLAIMED', replayed: true, benefit: { amount: 100 } }
  assert.deepEqual(interpretQoderClaim(replayWithBenefit), { kind: 'already-claimed' })

  // 反向：没有 benefit 但 replayed=false 且 status 正常 → 仍是「领取成功 +0」
  assert.deepEqual(
    interpretQoderClaim({ status: 'CLAIMED', replayed: false }),
    { kind: 'claimed', amount: 0 },
    'benefit 缺失时不该回退成「已领」——判据只有 replayed',
  )
})

test('Qoder 领取：status 不是 CLAIMED 时报「未成功」而不是成功', () => {
  const outcome = interpretQoderClaim({ status: 'PENDING', replayed: false })
  assert.equal(outcome.kind, 'unexpected')
  assert.match(outcome.message, /PENDING/)
})

// ═══════════════════════════ 未开通判据 ═══════════════════════════

test('Qoder 未开通：活动列表无 CLAIM_BENEFIT 且 addOnQuota 字段缺失才成立', () => {
  const noBenefit = parseQoderCampaigns(campaignsBody([VIEW_DETAILS_CAMPAIGN]))
  const noAddOn = { qoderUsage: { userQuota: { total: 0, used: 0, remaining: 0 } } }
  assert.equal(isQoderNotActivated(noBenefit, noAddOn), true)

  // 有 addOnQuota（哪怕 remaining 为 0）→ 已开通，不能报「未开通」
  const zeroAddOn = { qoderUsage: { addOnQuota: { total: 100, used: 100, remaining: 0 } } }
  assert.equal(
    isQoderNotActivated(noBenefit, zeroAddOn),
    false,
    '「额度用光」不等于「从未开通」——用光额度的老账号会被误报成未开通',
  )

  // 有 CLAIM_BENEFIT（即使已领）→ 已开通
  const withBenefit = parseQoderCampaigns(campaignsBody([benefitCampaign('CLAIMED')]))
  assert.equal(isQoderNotActivated(withBenefit, noAddOn), false)
})

test('Qoder 未开通：取不到任一侧时**不判定**（保守返回 false，不许误报）', () => {
  const noBenefit = parseQoderCampaigns(campaignsBody([VIEW_DETAILS_CAMPAIGN]))
  // 活动列表取不到 → 不判定
  assert.equal(isQoderNotActivated(undefined, { qoderUsage: {} }), false)
  // 用量取不到 / 形状非法 → 不判定
  assert.equal(isQoderNotActivated(noBenefit, undefined), false)
  assert.equal(isQoderNotActivated(noBenefit, null), false)
  assert.equal(isQoderNotActivated(noBenefit, {}), false)
  assert.equal(isQoderNotActivated(noBenefit, { qoderUsage: null }), false)
})

// ═══════════════════════════ checkIn：主路径 ═══════════════════════════

test('Qoder checkIn：已领取且已刷新 → ok、credits 0、不误报成功', async () => {
  const ctx = fakeCtx(
    { [CAMPAIGNS_PATH]: { body: campaignsBody([benefitCampaign('CLAIMED'), VIEW_DETAILS_CAMPAIGN]) } },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.ok, true)
  assert.equal(result.supported, true)
  assert.equal(result.credits, 0, '已领不是「本轮 +100」')
  assert.match(result.message, /今天已领取/)
  assert.notEqual(result.coversToday, false, '已刷新时结论覆盖今天')
  // 已领就无需再问用量，也不该尝试领取
  assert.deepEqual(ctx.calls.map((call) => call.method), ['GET'])
})

test('Qoder checkIn：可领时真的 POST 领取，请求体是空串', async () => {
  const ctx = fakeCtx(
    {
      [CAMPAIGNS_PATH]: { body: campaignsBody([benefitCampaign('CLAIMABLE')]) },
      '/sash/api/v1/me/campaigns/01a130ec-98c5-74dc-a29b-ac1ef0d1416c/claim': {
        body: { status: 'CLAIMED', replayed: false, benefit: { kind: 'CREDITS', amount: 100 } },
      },
    },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.ok, true)
  assert.equal(result.credits, 100)
  assert.match(result.message, /\+100/)

  const claimCall = ctx.calls.find((call) => call.method === 'POST')
  assert.ok(claimCall !== undefined, '应当发一次领取请求')
  // ⚠️ 抓包实测 content-length: 0 —— 必须空串，不是 '{}'
  assert.equal(claimCall.body, '', "领取请求体必须是空串（实测 content-length: 0）")
  assert.equal(claimCall.headers['content-type'], 'application/json')
})

test('Qoder checkIn：重复领取（replayed=true）判「今天已领」，不报 +100', async () => {
  // ⚠️ 这是幂等判据的核心回归：上游回 200、还**带着 benefit**，但没真的发积分。
  // 用本机 2026-10-19 抓到的真实回放响应。
  const ctx = fakeCtx(
    {
      [CAMPAIGNS_PATH]: { body: campaignsBody([benefitCampaign('CLAIMABLE')]) },
      '/sash/api/v1/me/campaigns/01a130ec-98c5-74dc-a29b-ac1ef0d1416c/claim': {
        body: {
          status: 'CLAIMED',
          replayed: true,
          benefit: { kind: 'CREDITS', amount: 100 },
          claimedAt: '2026-10-19T09:02:38.233484Z',
        },
      },
    },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.ok, true)
  assert.equal(result.credits, 0, '回放不是本次到账 —— 报 +100 就是谎报')
  assert.match(result.message, /今天已领取/)
})

test('Qoder checkIn：多个可领活动逐个领取，积分累加', async () => {
  const second = {
    ...benefitCampaign('CLAIMABLE'),
    campaignId: '01a00000-0000-7000-8000-000000000002',
    campaignKey: 'act-other',
    benefit: { kind: 'CREDITS', amount: 50 },
  }
  const ctx = fakeCtx(
    {
      [CAMPAIGNS_PATH]: { body: campaignsBody([benefitCampaign('CLAIMABLE'), second]) },
      '/sash/api/v1/me/campaigns/01a130ec-98c5-74dc-a29b-ac1ef0d1416c/claim': {
        body: { status: 'CLAIMED', replayed: false, benefit: { amount: 100 } },
      },
      '/sash/api/v1/me/campaigns/01a00000-0000-7000-8000-000000000002/claim': {
        body: { status: 'CLAIMED', replayed: false, benefit: { amount: 50 } },
      },
    },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.credits, 150, '一个账号可能同时有多个可领活动，不能只领第一个')
  assert.equal(ctx.calls.filter((call) => call.method === 'POST').length, 2)
})

// ═══════════════════════════ checkIn：刷新时刻 ═══════════════════════════

test('Qoder checkIn：刷新前看到 CLAIMED → 不是「今天已领」，且带 coversToday=false', async () => {
  // ⚠️ 真实缺陷（参考实现 2026-10-02 审查定位）：上午 9 点看到的那条 CLAIMED
  // 属于**昨天**。若报「今天已领」且不带 coversToday=false，记账层会把今天记成
  // 已签，10 点刷新后的新额度整天没人领 —— 每天静默漏 100 积分。
  const ctx = fakeCtx(
    { [CAMPAIGNS_PATH]: { body: campaignsBody([benefitCampaign('CLAIMED'), VIEW_DETAILS_CAMPAIGN]) } },
    BEFORE_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.coversToday, false, '刷新前绝不能声称覆盖今天')
  assert.notEqual(result.message, '今天已领取', '刷新前不许说「今天已领取」')
  assert.match(result.message, /尚未刷新/, '要说清是「等一会儿再来」，而不是「已领」也不是「没有活动」')
  assert.equal(result.ok, true, '这不是故障，是可重试的正常状态')
  assert.equal(result.supported, true)
})

test('Qoder checkIn：刷新前后两条分支给出不同结论（同一份响应）', async () => {
  const body = campaignsBody([benefitCampaign('CLAIMED'), VIEW_DETAILS_CAMPAIGN])
  const adapter = new QoderAdapter(QODER_CN)
  const before = await adapter.checkIn(record(), fakeCtx({ [CAMPAIGNS_PATH]: { body } }, BEFORE_REFRESH))
  const after = await adapter.checkIn(record(), fakeCtx({ [CAMPAIGNS_PATH]: { body } }, AFTER_REFRESH))
  assert.equal(before.coversToday, false)
  assert.equal(before.message.includes('今天已领取'), false)
  assert.equal(after.coversToday, undefined, '已刷新时不写该字段（缺省视为 true）')
  assert.equal(after.message, '今天已领取')
})

test('Qoder checkIn：刷新前领取成功也要带 coversToday=false（补领不算今天已处理）', async () => {
  // ⚠️ 参考实现把这条叫 `stale`，**成功分支也要带**：刷新前可领的是昨天那一轮，
  // 领到是一次真实动作（该报成功），但不证明今天已被处理。
  const ctx = fakeCtx(
    {
      [CAMPAIGNS_PATH]: { body: campaignsBody([benefitCampaign('CLAIMABLE')]) },
      '/sash/api/v1/me/campaigns/01a130ec-98c5-74dc-a29b-ac1ef0d1416c/claim': {
        body: { status: 'CLAIMED', replayed: false, benefit: { amount: 100 } },
      },
    },
    BEFORE_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.ok, true)
  assert.equal(result.credits, 100, '确实领到了，如实报')
  assert.equal(result.coversToday, false, '但不许声称今天已被处理，否则 10 点后就没人再领了')
})

test('Qoder checkIn：刷新前无已领项也不报「没有可领取的活动」', async () => {
  // 「没有可领取的活动」会让人以为今天没戏了。刷新前应当说「等一会儿」。
  const ctx = fakeCtx(
    { [CAMPAIGNS_PATH]: { body: campaignsBody([VIEW_DETAILS_CAMPAIGN]) }, [USAGE_PATH]: { body: USAGE_BODY } },
    BEFORE_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.match(result.message, /尚未刷新/)
  assert.equal(result.coversToday, false)
})

// ═══════════════════════════ checkIn：未开通 ═══════════════════════════

test('Qoder checkIn：未开通 → actionRequired=true + 可操作文案', async () => {
  const noAddOn = { qoderUsage: { userQuota: { total: 0, used: 0, remaining: 0, unit: 'credits' } } }
  const ctx = fakeCtx(
    { [CAMPAIGNS_PATH]: { body: campaignsBody([VIEW_DETAILS_CAMPAIGN]) }, [USAGE_PATH]: { body: noAddOn } },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.actionRequired, true, 'UI 判这个布尔字段，不判文案')
  assert.match(result.message, /官方客户端/, '文案必须可操作：用户要知道去哪开通')
  assert.notEqual(result.message, '当前没有可领取的活动')
})

test('Qoder checkIn：已开通只是没活动 → 不报未开通，也不带 actionRequired', async () => {
  const ctx = fakeCtx(
    { [CAMPAIGNS_PATH]: { body: campaignsBody([VIEW_DETAILS_CAMPAIGN]) }, [USAGE_PATH]: { body: USAGE_BODY } },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.notEqual(result.actionRequired, true)
  assert.match(result.message, /当前没有可领取的活动/)
  // ⚠️ 必须带 coversToday:false：我们**无法证明**今天这一轮被处理过。
  // 记成「今天已处理」而活动稍后才出现 → 整天漏领；不记账最多多查一次（只读）。
  assert.equal(result.coversToday, false, '「没活动」不等于「今天处理过了」')
})

// ═══════════════════════════ checkIn：取不到时不误判 ═══════════════════════════

test('Qoder checkIn：活动列表取不到 → 报真实失败，**不判定**是否已领/未开通', async () => {
  const adapter = new QoderAdapter(QODER_CN)

  const network = await adapter.checkIn(record(), fakeCtx({ [CAMPAIGNS_PATH]: 'network-error' }, AFTER_REFRESH))
  assert.equal(network.ok, false, '取不到不能报成功')
  assert.equal(network.supported, true, '这是真实故障，不是「上游没这接口」')
  assert.equal(network.kind, 'network')
  assert.notEqual(network.actionRequired, true, '网络失败不能误导用户去重新登录')
  assert.equal(network.credits ?? 0, 0)

  const unauthorized = await adapter.checkIn(
    record(),
    fakeCtx({ [CAMPAIGNS_PATH]: { ok: false, status: 401, kind: 'auth', message: '未授权' } }, AFTER_REFRESH),
  )
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.kind, 'auth')

  // 形状非法（例如上游返回 HTML 字符串）也算取不到
  const weird = await adapter.checkIn(record(), fakeCtx({ [CAMPAIGNS_PATH]: { body: 'nope' } }, AFTER_REFRESH))
  assert.equal(weird.ok, false)
  assert.match(weird.message, /活动列表查询失败/)
})

test('Qoder checkIn：用量取不到时**不判「未开通」**（保守，宁可不提示）', async () => {
  // 两条判据少一条就不能下结论。误报「未开通」会让用户白跑一趟官方客户端。
  const ctx = fakeCtx(
    { [CAMPAIGNS_PATH]: { body: campaignsBody([VIEW_DETAILS_CAMPAIGN]) }, [USAGE_PATH]: 'network-error' },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.notEqual(result.actionRequired, true)
  assert.match(result.message, /当前没有可领取的活动/, '取不到用量时退回中性结论')
})

test('Qoder checkIn：领取失败如实报错，不假装成功', async () => {
  const ctx = fakeCtx(
    {
      [CAMPAIGNS_PATH]: { body: campaignsBody([benefitCampaign('CLAIMABLE')]) },
      '/sash/api/v1/me/campaigns/01a130ec-98c5-74dc-a29b-ac1ef0d1416c/claim': {
        ok: false, status: 429, kind: 'rate_limit', message: '慢一点',
      },
    },
    AFTER_REFRESH,
  )
  const result = await new QoderAdapter(QODER_CN).checkIn(record(), ctx)
  assert.equal(result.ok, false)
  assert.equal(result.credits ?? 0, 0)
  assert.equal(result.kind, 'rate_limit', '错误分类要透出来，路由层要靠它决定换号')
})

test('Qoder checkIn：没有 token 时不发任何上游请求', async () => {
  const ctx = fakeCtx({}, AFTER_REFRESH)
  const result = await new QoderAdapter(QODER_CN).checkIn(record({}), ctx)
  assert.equal(ctx.calls.length, 0)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'auth')
  assert.match(result.message, /token/)
})

test('Qoder checkIn：supported 恒为 true（上游有这个接口，失败也不该说「不支持」）', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  for (const routes of [
    { [CAMPAIGNS_PATH]: 'network-error' },
    { [CAMPAIGNS_PATH]: { ok: false, status: 500, kind: 'server', message: '炸了' } },
  ]) {
    const result = await adapter.checkIn(record(), fakeCtx(routes, AFTER_REFRESH))
    assert.equal(result.supported, true, 'supported:false 意为「上游没这个接口」，不是故障')
  }
})

test('Qoder 能力表：checkIn / quota 已打开，notes 如实说明', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  assert.equal(adapter.capabilities.checkIn, true)
  assert.equal(adapter.capabilities.quota, true)
  assert.equal(adapter.capabilities.tasks, false, '每日领取并入签到，没有独立的活动任务接口')
  assert.match(adapter.capabilities.notes.checkIn, /10:00/)
  assert.match(adapter.capabilities.notes.quota, /addOnQuota/)
})

test('Qoder checkIn 与 getQuota：国际版与国际版共用同一套实现（只是 product 不同）', async () => {
  // 两个产品只差 host / clientId / 目录；积分与领取的协议同形。
  const { QODER } = await import('../../lib/vendor/qoder/qoder-product.js')
  const adapter = new QoderAdapter(QODER)
  const ctx = fakeCtx({ [USAGE_PATH]: { body: USAGE_BODY } }, AFTER_REFRESH)
  const snapshot = await adapter.getQuota(record(), ctx)
  assert.equal(snapshot.remaining, 858)
  assert.equal(
    ctx.calls[0].url,
    'https://openapi.qoder.sh/sash/api/v2/me/usage',
    '国际版要用 openApiBase=https://openapi.qoder.sh',
  )
})

// ─────────────────── 思考档位（模型调用那条链的前半段） ───────────────────

/**
 * 真实缺口（2026-10-19 实测）：兜底目录里**逐条抄了**官方客户端的
 * `thinking_config.enabled.efforts` 与 `is_default`，但适配器从来没把它们报进
 * `ModelMeta` —— 于是选择器里**一个档位行都不出现**，用户没法设思考档位
 * （参考实现的注释把它记为用户报障：「qoder中国版可以设置思考档位，
 * 我们应该按照他的设置给出可设置的档位选择」）。
 */
test('Qoder 模型目录：把思考档位报进 ModelMeta（不报就永远没有档位行）', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  const models = await adapter.getModelMetaList(record(), fakeCtx({}))
  const byId = new Map(models.map((m) => [m.id, m]))

  const df = byId.get('dfmodel')
  assert.ok(df, 'dfmodel 必须在目录里')
  assert.equal(df.reasoning, true)
  assert.deepEqual(df.reasoningEfforts, ['high', 'max', 'low', 'none'], 'efforts 表 + 追加的 none')
  assert.equal(df.defaultReasoningEffort, 'max', '上游声明的 is_default 要照实上报')

  // `qmodel_38max` 的目录声明是 xhigh/low/medium + is_default=xhigh。
  const q38 = byId.get('qmodel_38max')
  assert.deepEqual(q38.reasoningEfforts, ['xhigh', 'low', 'medium', 'none'])
  assert.equal(q38.defaultReasoningEffort, 'xhigh')
})

test('Qoder 模型目录：没有 thinking_config 的模型不出档位（不编造能力）', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  const models = await adapter.getModelMetaList(record(), fakeCtx({}))
  const byId = new Map(models.map((m) => [m.id, m]))
  // 实测 `mmodel`(MiniMax) 连 thinking_config 都没有 → IDE 里也显示「不支持」。
  //
  // ⚠️ 本条原本断言的是 `auto` / `efficient`。两个都是**档位、不是厂商模型**，
  // 现在不再上报（见 `QODER_NON_VENDOR_MODEL_IDS`），故改钉 `mmodel` ——
  // 它同样是「目录里没有 thinking_config」的厂商模型，**覆盖意图不变**。
  assert.equal(byId.get('mmodel').reasoningEfforts, undefined)
  assert.equal(byId.get('mmodel').defaultReasoningEffort, undefined)
  // 档位本身仍留在底层表里，按 id 查表照样能看出「它没有档位」
  // （证明过滤没有连带改坏协议层的数据）。
  const { QODER } = await import('../../lib/vendor/qoder/qoder-product.js')
  const auto = (QODER.fallbackModels ?? []).find((m) => m.id === 'auto')
  assert.ok(auto !== undefined, 'auto 仍在底层表里')
  assert.equal(qoderEffortsOf(auto).length, 0, 'auto 目录里没有 thinking_config → 无档位')
})

test('Qoder 档位：supportsDisable 追加 none，且不重复', () => {
  const withDisable = qoderEffortsOf({ id: 'x', name: 'X', contextWindow: 1, efforts: ['high', 'low'], supportsDisable: true })
  assert.deepEqual(withDisable, ['high', 'low', 'none'])
  // 目录里已经写了 none 时不重复追加。
  const already = qoderEffortsOf({ id: 'x', name: 'X', contextWindow: 1, efforts: ['high', 'none'], supportsDisable: true })
  assert.deepEqual(already, ['high', 'none'])
  // 不能关闭思考的模型不追加 —— 否则用户会看到一个点了报错的「关闭思考」。
  const noDisable = qoderEffortsOf({ id: 'x', name: 'X', contextWindow: 1, efforts: ['high', 'low'] })
  assert.deepEqual(noDisable, ['high', 'low'])
  // 只有 disabled、没有 efforts 的模型（CN 的 qmodel / qmodel_latest）→ 只有 none。
  const onlyDisable = qoderEffortsOf({ id: 'x', name: 'X', contextWindow: 1, supportsDisable: true })
  assert.deepEqual(onlyDisable, ['none'])
})

test('Qoder 档位：supportsThinking 为假不代表没有档位', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  const models = await adapter.getModelMetaList(record(), fakeCtx({}))
  // ⚠️ 本条原本钉的是 CN 的 `performance`（档位、已不上报）。改成厂商模型
  // `kmodel_latest`：它同样是 `is_reasoning: false` 但目录里有 `thinking_config`
  // —— **覆盖意图不变**（区分「不声明 reasoning」与「没有档位可选」）。
  const target = models.find((m) => m.id === 'kmodel_latest')
  assert.ok(target !== undefined, 'kmodel_latest 必须在目录里')
  assert.equal(target.reasoning, undefined, 'is_reasoning=false → 不声明 reasoning')
  assert.ok(
    Array.isArray(target.reasoningEfforts) && target.reasoningEfforts.length > 0,
    '但它仍然有档位可选',
  )
  // 被过滤掉的档位在协议层仍有档位数据（证明过滤只动了上报，没动表）
  const { QODER } = await import('../../lib/vendor/qoder/qoder-product.js')
  const perf = (QODER.fallbackModels ?? []).find((m) => m.id === 'performance')
  assert.ok(perf !== undefined, 'performance 仍在底层表里')
  assert.equal(perf.supportsThinking, false, '它 is_reasoning=false')
  assert.ok(qoderEffortsOf(perf).length > 0, '但它仍然有档位可选（这就是本条要守的事实）')
})

test('Qoder 对话：两个字段名都认（核心层发 reasoning_effort，老调用方发 reasoning）', async () => {
  // 真实缺口：核心层写 `payload.reasoning_effort`，而适配器只读 `payload.reasoning`
  // ⇒ 用户在选择器里选了档位，Qoder 这边永远收不到，静默按模型默认档跑。
  const adapter = new QoderAdapter(QODER_CN)
  const seen = []
  const client = {
    prepareInfer: (input) => {
      seen.push(input.reasoningEffort)
      return { url: 'https://gateway.qoder.com.cn/x', headers: {}, body: '{}' }
    },
  }
  // 直接换掉内部 WASM 客户端，避免真起 WASM。
  adapter.clients.set(record().id, client)
  const ctx = fakeCtx({})
  ctx.fetch = async () => new Response('', { status: 200 })

  const drain = async (payload) => {
    for await (const _ of adapter.requestChatStream({ model: 'dfmodel', messages: [{ role: 'user', content: 'hi' }], ...payload }, record(), ctx, new AbortController().signal)) {
      // 只要跑完
    }
  }
  await drain({ reasoning_effort: 'high' })
  await drain({ reasoning: 'low' })
  await drain({})
  assert.deepEqual(seen, ['high', 'low', undefined], '两个字段名都要认；都没给时不传档位')
})

/**
 * ⚠️ **用户报障 2026-10-20**：「Qoder CN 的模型发消息后没有回复，直接显示已完成；
 * Qoder 平台正常」，并明确纠正了当时的误判 ——「**上游没问题，我在 Qoder CN
 * 客户端里用这两个模型就没问题**」。
 *
 * 他是对的。真因是**请求体缺 `business`**：服务端据此选路由池
 * （源码 `MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`），
 * 缺字段会走异常分支、把请求路由到**故障节点** `oa_qwen-plus-2025-04-28`，
 * 回 `[FAIL]node:... msg:Execution failed`。
 *
 * 两个极易误判的点：
 *   ① 报错里的节点名是 **`qwen-plus`**，与我们在发的 `qfmodel` 对不上 ——
 *      那正是「被路由到了别的节点」的指纹，**不是**「这个模型坏了」；
 *   ② 只有 `qfmodel` / `dfmodel` 这类会踩中，`auto` / `qmodel_38max` 恰好不受影响，
 *      所以看起来像「个别模型的服务端故障」。上一轮就是这么误判的。
 *
 * ⚠️ 参考实现的注释里早就写明了这条**且连现象都一样**（「IDE 里同一模型完全正常」），
 * 我们移植时漏了这个字段。
 */
test('Qoder 对话：请求体必须带 business（漏了它 qfmodel/dfmodel 恒失败）', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  const captured = []
  const client = {
    prepareInfer: (input) => {
      captured.push(input)
      return { url: 'https://gateway.qoder.com.cn/x', headers: {}, body: '{}' }
    },
  }
  adapter.clients.set(record().id, client)
  const ctx = fakeCtx({})
  ctx.fetch = async () => new Response('', { status: 200 })

  for await (const _ of adapter.requestChatStream(
    { model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }] },
    record(), ctx, new AbortController().signal,
  )) { /* 只要跑完 */ }

  assert.equal(captured.length, 1, '应当只调用一次 prepareInfer')
  const ask = captured[0]
  assert.ok(ask.business !== undefined, 'business 必须传 —— 缺了服务端会路由到故障节点')
  assert.equal(ask.business.type, 'agent', 'business.type 取 agent（与参考实现一致）')
  assert.equal(ask.modelKey, 'qfmodel', 'modelKey 仍然是目录 key，别被 business 挤掉')
})

// ══════════════════ 非厂商模型（档位/路由名）不上报 ══════════════════
//
// 用户要求（2026-10-20）：「Sonus、Auto这些不是厂商的模型，直接排除掉」。
//
// 判据：`name` 是不是「厂商 + 型号」。`auto` / `ultimate` / `performance` /
// `efficient` / `smodel`(Sonus) / `cmodel`(Cantus) 都是 Qoder 自己的**档位**。
// 官方文档把「档位」与「具体模型」分两张表列，倍率逐条对得上
// （见 `qoder-product.ts` 的 `QODER_NON_VENDOR_MODEL_IDS` 注释）。
//
// ⚠️ 两个必须同时守住的方向：
//   ① 这些 id **不出现在** `getModelMetaList()`（选择器干净）；
//   ② 它们**仍在底层表里**（协议层按 id 查表照旧能用，不产生悬空引用）。

/** 两份产品目录共用的、**确定不是厂商模型**的 id。 */
const NON_VENDOR_IDS = ['auto', 'ultimate', 'performance', 'efficient', 'smodel', 'cmodel']

/**
 * 保留的**厂商模型** id（用户点名「一个都不能少」）。
 *
 * ⚠️ `qmodel_38max` 这类目录 key 不在断言里 —— 这里比的是**厂商型号**这个层面，
 * 用 name 更直观；但 id 是稳定键，故两个都断言（见下面两条用例）。
 */
const VENDOR_NAMES_INTL = [
  'Qwen3.8-Max', 'Qwen3.8-Flash', 'Qwen3.7-Max', 'Qwen3.7-Plus',
  'Kimi-K3', 'Kimi-K2.8-Preview',
  'GLM-5.3', 'GLM-5.3-Flash',
  'DeepSeek-V4-Pro', 'DeepSeek-Flash',
  'MiniMax-M3',
]

/** 国际版目录的厂商模型 **id 集合**（16 条表里除去 6 条档位）。 */
const VENDOR_IDS_INTL = [
  'qmodel_38max', 'qfmodel', 'qmodel_latest', 'qmodel',
  'kmodel_latest', 'kmodel',
  'gmodel', 'gfmodel',
  'dmodel', 'dfmodel',
  'mmodel',
]

/**
 * CN 目录的厂商模型 id 集合。
 *
 * ⚠️ 比国际版多 `q37fmodel`(Qwen3.7-Flash) 与 `gm51model`(GLM-5.2) —— CN 独有；
 * 且 CN **本来就没有**那 5 条档位（只有 `auto`）。
 * 注意 `mmodel` 在 CN 是 **MiniMax-M2.7**（国际版 M3）。
 */
const VENDOR_IDS_CN = [
  'qmodel_38max', 'qfmodel', 'qmodel_latest', 'qmodel',
  'q37fmodel',
  'dmodel', 'dfmodel',
  'gmodel', 'gfmodel', 'gm51model',
  'kmodel_latest', 'kmodel',
  'mmodel',
]

const { QODER } = await import('../../lib/vendor/qoder/qoder-product.js')

test('Qoder：国际版 getModelMetaList 不含任何档位/路由名', async () => {
  const list = await new QoderAdapter(QODER).getModelMetaList(record(), {})
  const ids = list.map((meta) => meta.id)
  for (const id of NON_VENDOR_IDS) {
    assert.equal(ids.includes(id), false, `${id} 不是厂商模型，不该上报（实际列表：${ids.join(',')}）`)
  }
  // 名字层面也守一道：这些展示名不该出现（Sonus / Cantus 是 id 的中文以外的代号）
  const names = list.map((meta) => meta.name)
  for (const banned of ['Auto', 'Ultimate', 'Performance', 'Efficient', 'Sonus', 'Cantus']) {
    assert.equal(names.includes(banned), false, `${banned} 不该出现在选择器里`)
  }
})

test('Qoder：CN getModelMetaList 不含任何档位/路由名', async () => {
  const list = await new QoderAdapter(QODER_CN).getModelMetaList(record(), {})
  const ids = list.map((meta) => meta.id)
  for (const id of NON_VENDOR_IDS) {
    assert.equal(ids.includes(id), false, `${id} 不该上报（实际列表：${ids.join(',')}）`)
  }
  // CN 目录本来只有 auto 一条档位 —— 单独钉一下，防止将来「沿用国际版表」把它带回来
  assert.equal(ids.includes('auto'), false, 'CN 的 auto 同样要滤掉')
})

test('Qoder：国际版保留的厂商模型一个都没少（集合相等）', async () => {
  const list = await new QoderAdapter(QODER).getModelMetaList(record(), {})
  const ids = list.map((meta) => meta.id).sort()
  assert.deepEqual(
    ids,
    [...VENDOR_IDS_INTL].sort(),
    `国际版必须正好是这些厂商模型，实际：${ids.join(',')}`,
  )
  // 展示名层面再钉一次（用户看的是这个）
  const names = list.map((meta) => meta.name).sort()
  assert.deepEqual(names, [...VENDOR_NAMES_INTL].sort(), `国际版展示名不对：${names.join(',')}`)
})

test('Qoder：CN 保留的厂商模型一个都没少（集合相等）', async () => {
  // ⚠️ **注意这里断言的是 11 条，不是 CN 底层表的 14 条。**
  //
  // 原因是一个**已存在的接线缺陷**（不是本轮引入的，已报告给 Lead）：
  // `src/adapters/qoder.ts` 的 `QODER_CN = { ...QODER, … }` —— 摊开的是**国际版**
  // 产品对象，所以 `qoder-cn` 实际用的是国际版那 17 条兜底表，
  // `vendor/qoder/qoder-product.ts` 里那份**真正的 CN 表（14 条）根本没有被用上**。
  //
  // 后果：CN 独有的 `q37fmodel`(Qwen3.7-Flash) 与 `gm51model`(GLM-5.2) 看不见，
  // 而 `mmodel` 显示成国际版的 `MiniMax-M3`（CN 实际是 M2.7）。
  // 本轮的过滤不改变这个事实，故这里按**当前真实行为**钉住，
  // 等接线修好后应改成 14 条的期望（届时这条用例会失败并提醒改回来）。
  const list = await new QoderAdapter(QODER_CN).getModelMetaList(record(), {})
  const ids = list.map((meta) => meta.id).sort()
  assert.deepEqual(ids, [...VENDOR_IDS_INTL].sort(), `CN 上报的厂商模型不对：${ids.join(',')}`)
  // 档位一条都不能有
  for (const id of NON_VENDOR_IDS) {
    assert.equal(ids.includes(id), false, `${id} 不该上报`)
  }
})

test('Qoder：接线缺陷的现状（CN 用的是国际版表，不是 vendor 里的 CN 表）', async () => {
  // ⚠️ 这条**记录的是一处已知缺陷**，不是期望行为。修好接线后应当反过来断言。
  // 详见 `src/adapters/qoder.ts` 的 `QODER_CN` 定义（`...QODER` 摊开了国际版对象）。
  const { QODER_CN: VENDOR_CN } = await import('../../lib/vendor/qoder/qoder-product.js')
  const adapterTable = QODER_CN.fallbackModels ?? []
  const vendorTable = VENDOR_CN.fallbackModels ?? []
  assert.equal(vendorTable.length, 14, 'vendor 的 CN 表是 14 条（实测采集）')
  assert.equal(adapterTable.length, 17, '适配器实际用的是 17 条的国际版表 —— 这就是缺陷')
  // CN 独有的两条现在丢失了（这正是「沿用国际版表会让菜单出问题」的反面）
  const adapterIds = adapterTable.map((model) => model.id)
  assert.equal(adapterIds.includes('q37fmodel'), false, 'CN 独有的 Qwen3.7-Flash 目前丢失')
  assert.equal(adapterIds.includes('gm51model'), false, 'CN 独有的 GLM-5.2 目前丢失')
})

test('Qoder：被排除的 id **仍在底层表里**（是「不上报」不是「删掉了」）', async () => {
  // ⚠️ 这条守的是「悬空引用」：用户配置里可能还留着 `smodel`，
  // 若把条目从表里删掉，按 id 查表的路径就查不到了。
  const { QODER_CN: VENDOR_CN } = await import('../../lib/vendor/qoder/qoder-product.js')
  for (const [label, product] of [['国际版', QODER], ['vendor CN', VENDOR_CN]]) {
    const table = product.fallbackModels ?? []
    const tableIds = table.map((model) => model.id)
    for (const id of NON_VENDOR_IDS) {
      // CN 本来就没有那 5 条档位，只有 auto —— 只对**表里有的**断言
      if (!tableIds.includes(id)) continue
      const meta = table.find((model) => model.id === id)
      assert.ok(meta !== undefined, `${label}：${id} 必须仍在底层表里（不能物理删除）`)
      assert.equal(typeof meta.name, 'string', `${label}：${id} 的元数据要完整`)
    }
  }
  // 国际版这 6 条一条都不能少
  const intlIds = (QODER.fallbackModels ?? []).map((model) => model.id)
  for (const id of NON_VENDOR_IDS) {
    assert.ok(intlIds.includes(id), `国际版底层表必须保留 ${id}`)
  }
  // 两份表条数不能因为「排除」而变化（排除是过滤，不是删除）
  assert.equal((QODER.fallbackModels ?? []).length, 17, '国际版底层表仍是 17 条')
  assert.equal((VENDOR_CN.fallbackModels ?? []).length, 14, 'vendor CN 底层表仍是 14 条')
  // vendor CN 表里只有 auto 一条档位（另外 5 条 CN 目录本来就没有）
  const vendorCnIds = (VENDOR_CN.fallbackModels ?? []).map((model) => model.id)
  assert.deepEqual(
    NON_VENDOR_IDS.filter((id) => vendorCnIds.includes(id)),
    ['auto'],
    'CN 目录只有 auto 一条档位 —— 这条同时证明「两份表各自独立」',
  )
})

test('Qoder：isVendorModel 判据本身（含未知 id 默认按厂商模型处理）', async () => {
  const { isVendorModel, QODER_NON_VENDOR_MODEL_IDS } = await import('../../lib/vendor/qoder/qoder-product.js')
  for (const id of NON_VENDOR_IDS) {
    assert.equal(isVendorModel(id), false, `${id} 不是厂商模型`)
    assert.ok(QODER_NON_VENDOR_MODEL_IDS.includes(id), `${id} 应当在常量集合里`)
  }
  for (const id of VENDOR_IDS_INTL) {
    assert.equal(isVendorModel(id), true, `${id} 是厂商模型`)
  }
  // ⚠️ 未登记的 id 默认**放行**：将来上游新增一个厂商模型时，
  // 默认是「显示」而不是「静默隐藏」—— 隐藏一个新模型用户根本发现不了。
  assert.equal(isVendorModel('brandnewmodel'), true, '未登记 id 默认放行（宁可多显示，不可静默少显示）')
})

test('Qoder：被排除的 id 的档位/倍率查询仍正常（协议层照旧认识它们）', async () => {
  const { effectiveMultiplier, qoderEffortsOf, isPromotionActive } = await import('../../lib/adapters/qoder.js')
  const now = new Date(Date.UTC(2026, 9, 20, 6, 0)) // UTC+8 14:00，错峰窗口外
  for (const id of NON_VENDOR_IDS) {
    const meta = (QODER.fallbackModels ?? []).find((model) => model.id === id)
    if (meta === undefined) continue
    // 倍率仍算得出来（不是 undefined、不是 NaN）
    const multiplier = effectiveMultiplier(meta, now)
    assert.equal(typeof multiplier, 'number', `${id} 的倍率必须仍可算`)
    assert.ok(Number.isFinite(multiplier), `${id} 的倍率不能是 NaN`)
    // 档位查询不抛错，且返回值是数组
    const efforts = qoderEffortsOf(meta)
    assert.ok(Array.isArray(efforts), `${id} 的档位查询必须仍可用`)
    assert.equal(isPromotionActive(meta, now), false, `${id} 没有 promotion`)
  }
  // 逐个钉一下实测倍率（官方档位表：Auto ~0.5× / Ultimate ~2× / Performance 1.1× / Efficient ~0.3×）
  const byId = new Map((QODER.fallbackModels ?? []).map((model) => [model.id, model]))
  assert.equal(effectiveMultiplier(byId.get('auto'), now), 0.5, 'Auto = 0.5×（官方档位表）')
  assert.equal(effectiveMultiplier(byId.get('ultimate'), now), 2, 'Ultimate = 2×（官方档位表）')
  assert.equal(effectiveMultiplier(byId.get('performance'), now), 1.1, 'Performance = 1.1×（更名前）')
  assert.equal(effectiveMultiplier(byId.get('efficient'), now), 0.3, 'Efficient = 0.3×（官方档位表）')
  assert.equal(effectiveMultiplier(byId.get('smodel'), now), 8, 'Sonus = 8×（内部代号）')
  assert.equal(effectiveMultiplier(byId.get('cmodel'), now), 4, 'Cantus = 4×（内部代号）')
})

test('Qoder：过滤只影响上报列表，不影响其它路径（未登录仍返回空）', async () => {
  // 过滤加在 `.filter()` 上，不能把「没 token 直接返回 []」这条短路弄坏。
  // ⚠️ 用 `record({})` 而不是 `record(undefined)` —— 后者的默认参数会给出
  // 一个**有 token** 的记录（见 `record` 的定义），测不到未登录分支。
  const adapter = new QoderAdapter(QODER_CN)
  assert.deepEqual(await adapter.getModelMetaList(record({}), {}), [])
  // 有 token 时列表非空，且每一条都带倍率（过滤后不该出现「未知倍率」）
  const list = await adapter.getModelMetaList(record(), {})
  assert.ok(list.length > 5, '过滤后仍应有多个厂商模型')
  for (const meta of list) {
    assert.equal(typeof meta.multiplier, 'number', `${meta.id} 缺倍率`)
  }
})

