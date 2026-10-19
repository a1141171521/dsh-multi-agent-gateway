/**
 * `TaskEngine.checkIn` 的记账口径回归。
 *
 * 守的是一个**会静默漏钱**的缺陷（参考实现 2026-10-02 审查 PR !33 定位）：
 * 「今天已领」这句话本身有歧义 —— 它只说明「服务端现在认为没有可领的了」，
 * 而在**活动按日定时刷新**的平台（Qoder 是 10:00 UTC+8）上，刷新前看到的
 * 「已领」属于**昨天那一轮**。
 *
 * 若拿它当「今天已处理」的凭证记档，当天刷新后就再也不会去领 ——
 * **每天静默漏掉一份额度**，而且界面上一切正常。
 *
 * 所以记账的唯一判据是 `CheckInResult.coversToday !== false`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'

import { TaskEngine } from '../lib/core/tasks.js'
import { AccountManager } from '../lib/core/accounts.js'
import { JsonlLog } from '../lib/core/store.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }

/** 造一个最小可用的 TaskEngine，适配器的 checkIn 返回给定结论。 */
function harness(checkInResult, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mag-checkin-'))
  const accounts = new AccountManager(dir, silent, { v: 1, updatedAt: 0, health: {}, quota: {} })
  accounts.load()
  const account = accounts.add({
    agentId: 'qoder-cn',
    label: '测试账号',
    credentials: { token: 't' },
    enabled: true,
  })
  // 记账走 setLastRun/lastRun，落盘在 state.json 的 schedule 表。
  const calls = []
  const adapter = {
    id: 'qoder-cn',
    name: 'Qoder CN',
    capabilities: options.capabilities ?? { checkIn: true, quota: false, models: false, tasks: false, chat: false, reasoning: false, source: 'static' },
    async checkIn(record) {
      calls.push(record.id)
      return typeof checkInResult === 'function' ? checkInResult(record, calls.length) : checkInResult
    },
  }
  const engine = new TaskEngine({
    adapterOf: (id) => (id === 'qoder-cn' ? adapter : undefined),
    contextOf: () => ({ config: {}, log: silent, http: async () => ({ ok: false, status: 0, kind: 'none' }), cache: new Map(), now: Date.now }),
    accounts,
    logStore: new JsonlLog(join(dir, 'tasks.jsonl')),
    log: silent,
    tasksConfigOf: () => ({ enabled: false, intervalMinutes: 60, concurrency: 1, maxFailures: 3, retryDelaySec: 60, kinds: [] }),
    checkInConfigOf: () => ({ enabled: true, cron: 'every:86400', startupDelaySec: 0 }),
    now: () => options.now ?? Date.parse('2026-10-19T09:00:00+08:00'),
  })
  return { engine, account, accounts, accountId: account.id, calls, dir }
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true })

test('签到：coversToday 缺省按 true 记账（普通每日签到平台不受影响）', async () => {
  const h = harness({ ok: true, supported: true, credits: 100, message: '签到成功', at: Date.now() })
  try {
    const first = await h.engine.checkIn(h.account)
    assert.equal(first.ok, true)
    assert.equal(first.coversToday, true)
    assert.equal(first.recorded, true)
    // 第二次同一天必须命中幂等，不再打上游。
    const second = await h.engine.checkIn(h.account)
    assert.equal(second.message, '今天已经签过了')
    assert.equal(h.calls.length, 1, '同一天第二次不该再打上游')
  } finally {
    cleanup(h.dir)
  }
})

test('签到：coversToday=false 时今天不记账，稍后会真的重试', async () => {
  // 场景：上午 9 点（活动 10:00 才刷新）看到的是昨天那条 CLAIMED。
  const h = harness({
    ok: true,
    supported: true,
    credits: 0,
    message: '今天已签到',
    coversToday: false, // ← 适配器如实声明「这是刷新前那一轮」
    at: Date.now(),
  })
  try {
    const first = await h.engine.checkIn(h.account)
    assert.equal(first.ok, true)
    assert.equal(first.coversToday, false)
    assert.equal(first.recorded, false, 'coversToday=false 绝不能记档，否则当天静默漏领')
    // ★ 关键断言：没记账 ⇒ 下一次调用**仍然会真的打上游**（刷新后就能领到）。
    await h.engine.checkIn(h.account)
    assert.equal(h.calls.length, 2, '未记账时必须允许当天重试，否则刷新后再无机会领取')
  } finally {
    cleanup(h.dir)
  }
})

test('签到：coversToday=false 不写幂等键，刷新后同一天能领到', async () => {
  const h = harness({ ok: true, supported: true, credits: 0, message: '今天已签到', coversToday: false, at: Date.now() })
  try {
    await h.engine.checkIn(h.account)
    // 幂等键必须**没被写入**（写进去就等于当天放弃了）。
    const key = `checkin:qoder-cn:${h.accountId}:2026-10-19`
    assert.equal(h.accounts.lastRun(key), 0, '未覆盖今天的结果不得写幂等键')
  } finally {
    cleanup(h.dir)
  }
})

test('签到：actionRequired 透传（「去做点什么」与「等一会儿」要能分开）', async () => {
  const h = harness({
    ok: false,
    supported: true,
    message: '该账号尚未在 Qoder 侧开通每日领取，请先用官方客户端登录一次。',
    actionRequired: true,
    at: Date.now(),
  })
  try {
    const outcome = await h.engine.checkIn(h.account)
    assert.equal(outcome.actionRequired, true, 'UI 判的是这个布尔字段，不是 message 文案')
    assert.equal(outcome.recorded, false)
  } finally {
    cleanup(h.dir)
  }
})

test('签到：上游没有签到能力时不记账、不算故障', async () => {
  const h = harness(
    { ok: false, supported: false, message: '无签到接口', at: Date.now() },
    { capabilities: { checkIn: false, quota: false, models: false, tasks: false, chat: false, reasoning: false, source: 'static' } },
  )
  try {
    const outcome = await h.engine.checkIn(h.account)
    assert.equal(outcome.supported, false)
    assert.equal(outcome.ok, true, '「没有这个接口」不是故障')
    assert.equal(outcome.recorded, false)
    assert.equal(h.calls.length, 0, '能力位为 false 时不该打上游')
  } finally {
    cleanup(h.dir)
  }
})

test('批量签到：只有覆盖今天的才算成功', async () => {
  // 「刷新前那一轮」不该被计成成功 —— 否则汇总行会显示「1 个成功」而其实什么都没领到。
  const h = harness({ ok: true, supported: true, credits: 0, message: '今天已签到', coversToday: false, at: Date.now() })
  try {
    const summary = await h.engine.checkInBatch('qoder-cn')
    assert.equal(summary.accounts, 1)
    assert.equal(summary.ok, 0, 'coversToday=false 不得计入成功数')
    assert.equal(summary.recorded, 0)
    assert.equal(summary.details[0].coversToday, false)
  } finally {
    cleanup(h.dir)
  }
})

test('批量签到：真实成功会被计入', async () => {
  const h = harness({ ok: true, supported: true, credits: 100, message: '签到成功', at: Date.now() })
  try {
    const summary = await h.engine.checkInBatch('qoder-cn')
    assert.equal(summary.ok, 1)
    assert.equal(summary.recorded, 1)
    assert.equal(summary.credits, 100)
  } finally {
    cleanup(h.dir)
  }
})

test('签到：抛错时按失败处理且不记账', async () => {
  const h = harness(() => { throw new Error('上游 500') })
  try {
    const outcome = await h.engine.checkIn(h.account)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.supported, true)
    assert.equal(outcome.recorded, false)
    assert.match(outcome.message, /上游 500/)
  } finally {
    cleanup(h.dir)
  }
})
