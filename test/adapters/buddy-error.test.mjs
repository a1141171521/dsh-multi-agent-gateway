/**
 * `describeBuddyErrorBody` 的用例。
 *
 * 这个函数存在的唯一理由：上游拒绝时**原文被截断**过（`text.slice(0,300)`），
 * 第 300 个字符正好落在 `displayTips.en` 中间，把「为什么被拒」切掉了。
 * 2026-10-28 国内版那次 `11-128` 就是这么只看到半句话。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeBuddyErrorBody } from '../../lib/adapters/buddy.js'

/** 真机抓到的 11-128 报文（字段逐字保留，requestId 换成构造值）。 */
const CHANNEL_BLOCKED = JSON.stringify({
  code: '11-128',
  msg: 'Illegal API invocation from an unapproved channel',
  requestId: 'aaaaaaaa-0000-4000-8000-000000000000',
  displayMsg: {
    en: 'Request blocked. Please send it again',
    zh: '请求被拦截，请重新发送',
    'zh-hant': '請求已被攔截，請重新傳送',
  },
  displayTips: {
    en: 'This call failed channel verification, possibly because the request was not sent from an approved client.',
    zh: '本次调用的渠道校验未通过，可能是因为请求不是由受信任的客户端发出的。',
  },
})

test('11-128：把 code / msg / 中英文提示 / requestId 全部还原出来', () => {
  const text = describeBuddyErrorBody(CHANNEL_BLOCKED, 400)
  assert.ok(text.includes('11-128'), text)
  assert.ok(text.includes('Illegal API invocation from an unapproved channel'), text)
  assert.ok(text.includes('请求被拦截，请重新发送'), text)
  // 关键：英文提示必须**完整**，这正是旧实现被切断的那半句。
  assert.ok(text.includes('not sent from an approved client'), `英文提示被截断了：${text}`)
  assert.ok(text.includes('requestId=aaaaaaaa'), text)
  assert.ok(!text.startsWith('HTTP 400'), '解析成功时不该再带 HTTP 前缀')
})

test('11-128：结尾完整（旧实现正好切在这半句中间），且不把原始 JSON 灌出来', () => {
  const text = describeBuddyErrorBody(CHANNEL_BLOCKED, 400)
  // 旧实现 `text.slice(0,300)` 停在这里；新实现必须把整句说完。
  assert.ok(text.endsWith('（requestId=aaaaaaaa-0000-4000-8000-000000000000）'), `结尾被切了：${text.slice(-40)}`)
  assert.ok(!text.includes('{"code"'), '不该把原始 JSON 灌出来')
})

test('非 JSON（HTML 错误页）：退回原文并截断，不抛错', () => {
  const html = `<html><body><h1>502 Bad Gateway</h1>${'x'.repeat(5000)}</body></html>`
  const text = describeBuddyErrorBody(html, 502)
  assert.ok(text.startsWith('HTTP 502'), text)
  assert.ok(text.length <= 310, `退回路径仍要截断，实际 ${text.length}`)
})

test('空响应体：只说 HTTP 状态，不留一个空冒号', () => {
  assert.equal(describeBuddyErrorBody('   ', 503), 'HTTP 503')
})

test('字段缺失 / 类型不对：能出多少出多少，不抛错', () => {
  assert.equal(describeBuddyErrorBody('{"code":50001}', 200), '50001')
  assert.equal(describeBuddyErrorBody('[]', 400), 'HTTP 400 []')
  // displayMsg/displayTips 不是对象时直接忽略，不能崩。
  const odd = describeBuddyErrorBody('{"msg":"boom","displayMsg":"oops","displayTips":null}', 400)
  assert.equal(odd, 'boom')
})

test('中英文相同时去重（zh 与 en 一模一样的场合）', () => {
  const text = describeBuddyErrorBody('{"msg":"same","displayMsg":{"zh":"same","en":"same"}}', 400)
  assert.equal(text, 'same')
})
