/**
 * `refreshQuotas` 的**筛选语义**与**返回形状**回归。
 *
 * 守两件事：
 *
 *   1. **筛选语义**（`accountId` 优先）——用户在界面上「点名刷这一个」时，
 *      那个账号即使**停用**也必须照刷。额度快照是「上游现在认为你还剩多少」这个
 *      客观事实，与「这个账号是否参与对话路由」（`enabled`）是两码事。
 *      拿 `enabled` 去过掉它，用户会看到「点了按钮什么都没发生」。
 *
 *   2. **返回形状冻结** —— 客户端半边正按
 *      `{ accountId, agentId, label, unit, remaining|null, total|null, used|null,
 *         unlimited, error|null, fetchedAt }`
 *      写 UI，**一个字段都不能改名/增删**。所以这里逐字段钉住，
 *      包括「取不到时必须落成 `null` 而不是 `undefined`/`0`」——
 *      用 0 冒充「未知」正是用户分不清「没拉到 / 真的是 0」的根因。
 *
 * 全部用假 adapter，**不打真实上游**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GatewayRuntime } from '../lib/runtime.js'
import { resolveConfig } from '../lib/config.js'
import { apply } from '../lib/index.js'

/**
 * 冻结的返回字段（顺序即 `refreshQuotas` 里的字面量顺序，也是 JSON 序列化顺序）。
 *
 * ⚠️ 改这里之前先确认客户端半边（`client/client.js` 的 `describeQuotaRefresh` /
 * `quotaView`）已经跟着改 —— 否则界面上会静默变成空白。
 */
const FROZEN_FIELDS = [
  'accountId',
  'agentId',
  'label',
  'unit',
  'remaining',
  'total',
  'used',
  'unlimited',
  'error',
  'fetchedAt',
]

/** 静默日志器：测试不该往控制台刷日志。 */
const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** 造一个只会被调用 `getQuota` 的假适配器（其余接口给最小实现，保证形状完整）。 */
function makeAdapter(id, name, calls, quota) {
  return {
    id,
    name,
    capabilities: {
      checkIn: false,
      quota: true,
      models: false,
      tasks: false,
      chat: false,
      reasoning: false,
      source: 'static',
    },
    getCredentials: () => ({}),
    validateCredentials: async () => ({ ok: true }),
    checkIn: async () => ({ ok: false, supported: false, message: '上游不支持签到', at: Date.now() }),
    async getQuota(record) {
      calls.push(record.id)
      if (typeof quota === 'function') return quota(record)
      return { accountId: record.id, unit: 'credits', remaining: 42, total: 100, used: 58, fetchedAt: Date.now() }
    },
    getModelMetaList: async () => [],
    fetchAvailableTasks: async () => [],
    executeTask: async () => ({ ok: false, supported: false, message: '上游不支持' }),
    checkTaskStatus: async () => ({ ok: false, supported: false, message: '上游不支持' }),
    async *requestChatStream() {},
    detectError: () => undefined,
  }
}

/**
 * 造一个真 `GatewayRuntime` + 两个假平台，账号布局刻意覆盖全部筛选分支：
 *
 *   alpha: 启用 / 停用
 *   beta:  启用
 */
function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mag-quota-'))
  const calls = []
  const adapters = [
    makeAdapter('alpha', 'Alpha', calls, options.alphaQuota),
    makeAdapter('beta', 'Beta', calls, options.betaQuota),
  ]
  const config = resolveConfig(
    {
      dataDir: dir,
      agents: {
        // 令牌桶给足，免得限速让测试变慢。
        alpha: { rateLimitPerMinute: 600 },
        beta: { rateLimitPerMinute: 600 },
      },
    },
    { knownAgentIds: ['alpha', 'beta'], defaultDataDir: dir },
  )
  const runtime = new GatewayRuntime({ config, adapters, dshLogger: silent })
  const alphaOn = runtime.accounts.add({ agentId: 'alpha', label: 'Alpha 启用', credentials: { token: 't' } })
  const alphaOff = runtime.accounts.add({
    agentId: 'alpha',
    label: 'Alpha 停用',
    credentials: { token: 't' },
    enabled: false,
  })
  const betaOn = runtime.accounts.add({ agentId: 'beta', label: 'Beta 启用', credentials: { token: 't' } })
  return { runtime, calls, alphaOn, alphaOff, betaOn, dir }
}

function teardown(h) {
  h.runtime.dispose()
  rmSync(h.dir, { recursive: true, force: true })
}

// ───────────────────────── 筛选语义 ─────────────────────────

test('refreshQuotas：accountId 只刷这一个账号，且停用账号也照刷', async () => {
  const h = harness()
  try {
    assert.equal(h.alphaOff.enabled, false, '前提：这个账号确实是停用的')
    const rows = await h.runtime.refreshQuotas({ accountId: h.alphaOff.id })
    assert.equal(rows.length, 1, '点名一个账号就只该返回一条')
    assert.equal(rows[0].accountId, h.alphaOff.id)
    assert.equal(rows[0].label, 'Alpha 停用')
    // ★ 关键：停用**不是**「不该刷」的理由。被 enabled 过滤掉的话，
    //   界面上就是「点了刷新额度按钮，什么都没发生」。
    assert.deepEqual(h.calls, [h.alphaOff.id], '停用账号也必须真的打上游')
  } finally {
    teardown(h)
  }
})

test('refreshQuotas：accountId 不存在 → 返回空数组，不抛错', async () => {
  const h = harness()
  try {
    // 显式断言「不抛错」：界面上点一个已被删掉的账号，应该是「没有可刷新的账号」，
    // 而不是一个红色报错。
    await assert.doesNotReject(() => h.runtime.refreshQuotas({ accountId: 'alpha:不存在的账号' }))
    const rows = await h.runtime.refreshQuotas({ accountId: 'alpha:不存在的账号' })
    assert.deepEqual(rows, [])
    assert.deepEqual(h.calls, [], '账号不存在时一次上游请求都不该发')
  } finally {
    teardown(h)
  }
})

test('refreshQuotas：agentId → 只刷该平台的启用账号', async () => {
  const h = harness()
  try {
    const rows = await h.runtime.refreshQuotas({ agentId: 'alpha' })
    assert.deepEqual(
      rows.map((row) => row.accountId),
      [h.alphaOn.id],
      'alpha 下的停用账号不该被刷，beta 的更不该',
    )
    assert.deepEqual(h.calls, [h.alphaOn.id])
  } finally {
    teardown(h)
  }
})

test('refreshQuotas：都不给 → 全部平台的启用账号', async () => {
  const h = harness()
  try {
    // 无参（默认值）与空对象（`index.ts` 传的形状）必须等价。
    const rows = await h.runtime.refreshQuotas()
    assert.deepEqual(
      rows.map((row) => row.accountId),
      [h.alphaOn.id, h.betaOn.id],
      '跨平台取全部启用账号，停用的那个不在内',
    )
    assert.deepEqual(h.calls, [h.alphaOn.id, h.betaOn.id])

    h.calls.length = 0
    const sameShape = await h.runtime.refreshQuotas({})
    assert.deepEqual(sameShape.map((row) => row.accountId), [h.alphaOn.id, h.betaOn.id])
  } finally {
    teardown(h)
  }
})

test('refreshQuotas：accountId 与 agentId 同时给 → accountId 优先（跨平台也认）', async () => {
  const h = harness()
  try {
    // agentId 说 beta，accountId 指 alpha 的停用账号 —— 结果必须是那个账号，
    // 否则「单账号刷新」在界面上传两个参数时就会刷错平台。
    const rows = await h.runtime.refreshQuotas({ agentId: 'beta', accountId: h.alphaOff.id })
    assert.deepEqual(rows.map((row) => row.accountId), [h.alphaOff.id])
    assert.deepEqual(h.calls, [h.alphaOff.id], 'agentId 必须被 accountId 完全压过')
  } finally {
    teardown(h)
  }
})

// ───────────────────────── 返回形状（冻结契约）─────────────────────────

test('refreshQuotas：返回项字段齐全，形状与冻结契约逐字段一致', async () => {
  const h = harness()
  try {
    const rows = await h.runtime.refreshQuotas({ accountId: h.alphaOn.id })
    const row = rows[0]
    // 集合相等：既防漏字段，也防以后「顺手多加一个字段」。
    assert.deepEqual(Object.keys(row).sort(), [...FROZEN_FIELDS].sort())
    assert.equal(typeof row.accountId, 'string')
    assert.equal(row.agentId, 'alpha')
    assert.equal(row.label, 'Alpha 启用')
    assert.equal(row.unit, 'credits')
    assert.equal(row.remaining, 42)
    assert.equal(row.total, 100)
    assert.equal(row.used, 58)
    assert.equal(row.unlimited, false, 'unlimited 必须是布尔，不能是 undefined')
    assert.equal(row.error, null, '成功时 error 必须是 null，不能是 undefined')
    assert.equal(typeof row.fetchedAt, 'number')
  } finally {
    teardown(h)
  }
})

test('refreshQuotas：上游没给的数字必须落成 null（不能用 0 冒充未知）', async () => {
  const h = harness({
    // 只声明「不限量」，不含量化数字 —— 典型的不限量账号。
    alphaQuota: () => ({ accountId: 'x', unit: 'credits', unlimited: true, fetchedAt: 1234 }),
  })
  try {
    const [row] = await h.runtime.refreshQuotas({ accountId: h.alphaOn.id })
    assert.deepEqual(Object.keys(row).sort(), [...FROZEN_FIELDS].sort())
    assert.equal(row.remaining, null)
    assert.equal(row.total, null)
    assert.equal(row.used, null)
    assert.equal(row.unlimited, true)
    assert.equal(row.error, null)
    assert.equal(row.fetchedAt, 1234, 'fetchedAt 要原样透传上游快照的时间')
  } finally {
    teardown(h)
  }
})

test('refreshQuotas：上游抛错时给出 error 原文，字段仍然齐全', async () => {
  const h = harness({
    alphaQuota: () => {
      throw new Error('上游 503')
    },
  })
  try {
    const [row] = await h.runtime.refreshQuotas({ accountId: h.alphaOn.id })
    assert.deepEqual(Object.keys(row).sort(), [...FROZEN_FIELDS].sort(), '抛错时形状也不许变')
    assert.equal(row.unit, 'unknown')
    assert.equal(row.remaining, null, '取不到就必须是 null —— 0 会被界面读成「已用尽」')
    assert.equal(row.total, null)
    assert.equal(row.used, null)
    assert.equal(row.unlimited, false)
    assert.match(row.error, /上游 503/)
  } finally {
    teardown(h)
  }
})

// ───────────────────────── 端点接线（客户端真正调的那一条）─────────────────────────

/**
 * 造一个**最小宿主上下文**，只为把 `installRemoteHost` 的自校验喂过去，
 * 然后把注册好的 Service 捞出来 —— 这样测的就是客户端实际调用的那条路径。
 */
function fakeHostContext() {
  const captured = { service: null, contribution: null }
  const ctx = {
    logger: silent,
    get: () => undefined,
    inject(_names, callback) {
      callback({
        effect: (run) => {
          run()
        },
        provide: (_key, value) => {
          captured.service = value
        },
        typert: {
          register: (contribution) => {
            captured.contribution = contribution
            return () => {}
          },
          local: {
            // 自校验会逐个端点回读，这里按 `<命名空间>/<方法>` 把真方法还给它。
            get: (endpoint) =>
              captured.service === null ? undefined : captured.service[String(endpoint).split('/').pop()],
          },
        },
      })
    },
    effect: () => {},
    on: () => {},
  }
  return { ctx, captured }
}

test('refreshQuota 端点：接受 accountId 与 agentId，且形状穿过 redactDeep 后不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-quota-endpoint-'))
  const { ctx, captured } = fakeHostContext()
  // `enabled: false` 只为让定时调度器**不注册任何 job**（否则模型刷新那条 job
  // 会在 15 秒后真的去打上游）。端点接线与这个开关无关。
  const handle = apply(ctx, { enabled: false, dataDir: dir })
  try {
    assert.notEqual(captured.service, null, '宿主侧 Service 没装上')

    // agentId 用 'ghost'：注册表里**刻意没有**这个适配器，于是 `fetchQuota`
    // 会走「适配器未装载」分支 —— 既验证了请求确实被发起，又保证一个字节都没出网。
    const on = handle.runtime.accounts.add({ agentId: 'ghost', label: 'Ghost 启用', credentials: { token: 't' } })
    const off = handle.runtime.accounts.add({
      agentId: 'ghost',
      label: 'Ghost 停用',
      credentials: { token: 't' },
      enabled: false,
    })

    // ① 客户端「只刷这个账号」传的就是 { accountId }。
    const rows = await captured.service.refreshQuota({ accountId: off.id })
    assert.ok(Array.isArray(rows), `端点应返回数组，实际 ${JSON.stringify(rows)}`)
    assert.equal(rows.length, 1, 'accountId 必须被端点接住（只认 agentId 的旧实现会走「全部启用账号」）')
    assert.equal(rows[0].accountId, off.id, '停用账号也要刷')
    // ② 形状穿过 `redactDeep` 后一个字段都没少也没多。
    assert.deepEqual(Object.keys(rows[0]).sort(), [...FROZEN_FIELDS].sort())
    assert.match(String(rows[0].error), /适配器未装载/)

    // ③ 不带 accountId → 只刷启用账号。
    const all = await captured.service.refreshQuota({})
    assert.deepEqual(all.map((row) => row.accountId), [on.id])

    // ④ agentId 仍然可用。
    const byAgent = await captured.service.refreshQuota({ agentId: 'ghost' })
    assert.deepEqual(byAgent.map((row) => row.accountId), [on.id])

    // ⑤ 账号不存在 → 空数组（不是 {ok:false} 那种错误对象）。
    const missing = await captured.service.refreshQuota({ accountId: 'ghost:nope' })
    assert.deepEqual(missing, [])
  } finally {
    handle.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
