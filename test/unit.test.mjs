/**
 * 单元测试：核心层纯函数与状态机。
 *
 * 用 `node --test`（Node 内置，零依赖）。覆盖面刻意选在**会出错且难发现**的地方：
 * 错误分类、倍率换算、时间表达式、多账号路由、SSE 分片、任务幂等。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classify, flattenBody, isAbortError, parseResetAtFromBody, parseRetryAfter, failureOf } from '../lib/core/errors.js'
import { utc8DateString, utc8Hour, hasQoderCampaignRefreshedToday } from '../lib/core/time.js'
import { checkInKey, taskKey } from '../lib/core/tasks.js'
import { redactSecret, redactDeep, CredentialVault } from '../lib/core/crypto.js'
import { MemoryCache, TokenBucket, Semaphore } from '../lib/core/cache.js'
import { SseDecoder, translateChunk, normalizeUsage, isParseableJson, iterateSse } from '../lib/core/sse.js'
import {
  parseQueueError,
  isBillingErrorBody,
  queueDelayMs,
  QUEUE_MAX_DELAY_MS,
  QUEUE_BUSINESS_CODE,
  BILLING_BUSINESS_CODE,
} from '../lib/core/queue.js'
import { unwrapQoderEnvelopeStream } from '../lib/vendor/qoder/qoder-envelope.js'
import { parseSchedule, matches, isDue } from '../lib/core/scheduler.js'
import { AccountManager } from '../lib/core/accounts.js'
import { AccountRouter, penaltyMsFor, RETRY_AFTER_CAP_MS, QUOTA_COOLDOWN_MS, AUTH_COOLDOWN_MS, RISK_CONTROL_COOLDOWN_MS } from '../lib/core/router.js'
import { formatMultiplier, shouldSwitchAccount, isRetryable, selectExposedModels } from '../lib/core/types.js'
import {
  vendorOf,
  isFreeModel,
  sortForPicker,
  effectiveSelectedIds,
  defaultSelectedIds,
} from '../lib/core/model-order.js'
import {
  classifyProbeOutcome,
  runProbeBatch,
  mergeProbeCache,
  isStale,
  availabilityLabel,
  PROBE_DEFAULTS,
} from '../lib/core/probe.js'
import { RequestLog, computeTps } from '../lib/core/request-log.js'
import { checkUpdate, applyUpdate, compareVersions, semverParts, readVersion, describeUpdate } from '../lib/core/updater.js'
import { parseModelsFromConfig, buddyHeaders, userAgentFor, BUDDY_CN, BUDDY_INTL, BuddyAdapter } from '../lib/adapters/buddy.js'
import { uidFromToken, machineIdOf, QoderAdapter, QODER_CN } from '../lib/adapters/qoder.js'
import {
  microCentsToUsd,
  multiplierOf,
  prettifyModelId,
  parseTasks,
  extractCredits,
  parseGenericQuota,
  isFreeTierError,
  describeOpenCodeError,
  FREE_TIER_MESSAGE,
  readOAuthError,
  OpenCodeAdapter,
  looksLikeApi,
  canonicalSessionId,
  descendingTimePartHex,
  conversationSignal,
  hasReadTool,
  ensureFreeTierTools,
  shapeFreeTierRequest,
  CANONICAL_SESSION_PATTERN,
  DESCENDING_TIME_PATTERN,
} from '../lib/adapters/opencode.js'
import { createSkeleton } from '../lib/adapters/skeleton.js'
import { AdapterRegistry, validateAdapter } from '../lib/core/registry.js'
import {
  renderModelLabel,
  encodeModelId,
  decodeModelId,
  toOpenAiMessages,
  createLlmAdapter,
} from '../lib/llm/adapter.js'
import { builtinAdapters } from '../lib/adapters/index.js'
import { SKELETON_IDS } from '../lib/adapters/skeletons.js'
// `resolveConfig`：验证「哪些平台默认露出」这类**默认值**（Trae 的隐藏就是靠它）。
import { resolveConfig } from '../lib/config.js'

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent
  },
}

function freshAccounts() {
  const dir = mkdtempSync(join(tmpdir(), 'mag-unit-'))
  const manager = new AccountManager(dir, silent, { v: 1, updatedAt: 0, health: {}, quota: {} })
  manager.load()
  return { dir, manager, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ───────────────────────── 错误分类 ─────────────────────────

test('错误分类：状态码是硬事实', () => {
  assert.equal(classify(401, {}), 'auth')
  assert.equal(classify(403, {}), 'auth')
  assert.equal(classify(404, {}), 'not_found')
  assert.equal(classify(429, {}), 'rate_limit')
  assert.equal(classify(500, {}), 'server')
  assert.equal(classify(503, {}), 'server')
  assert.equal(classify(400, { message: 'bad model' }), 'bad_request')
  assert.equal(classify(0, {}), 'network')
})

test('错误分类：文案能把 403/429/400 纠正成额度耗尽', () => {
  assert.equal(classify(403, { error: { message: 'insufficient_quota' } }), 'quota')
  assert.equal(classify(429, { error: { message: 'insufficient balance' } }), 'quota')
  assert.equal(classify(400, { message: '额度不足，请充值' }), 'quota')
  assert.equal(classify(400, { message: '余额已用尽' }), 'quota')
})

test('错误分类：限流与鉴权的中文文案', () => {
  assert.equal(classify(400, { message: '请求过于频繁' }), 'rate_limit')
  assert.equal(classify(400, { message: '登录已过期' }), 'auth')
})

test('错误分类：不该换号的情况', () => {
  assert.equal(shouldSwitchAccount('bad_request'), false)
  assert.equal(shouldSwitchAccount('auth'), true)
  assert.equal(shouldSwitchAccount('quota'), true)
  assert.equal(shouldSwitchAccount('rate_limit'), true)
  assert.equal(shouldSwitchAccount('server'), false)
  assert.equal(isRetryable('server'), true)
  assert.equal(isRetryable('bad_request'), false)
})

// ───────────────── 风控：必须换号，但不能白重试（2026-10-27） ─────────────────

/**
 * 用户原话：「账号如果被风控以后，自动切换其他账号吗？」
 *
 * 实测（改之前）八个常见风控文案在 400 上**全部**判成 `bad_request` ⇒
 * `shouldSwitchAccount` 为假 ⇒ **不换号**，用户就卡在那个号上一直失败。
 * 而 403 上的风控落到 `auth` ⇒ 换号是对的，但 DSH 会把上游原话整句覆盖成
 * 「API 密钥无效」，用户跑去重新登录、重贴 token，全是白费。
 *
 * 所以风控必须有自己的 kind：既能换号，又能让上游原话透到界面上。
 */
test('风控：400 上的风控文案必须判成 risk_control（不能是 bad_request）', () => {
  // 这些文案在改之前**全部**落到 bad_request ⇒ 不换号。逐条钉住。
  const texts = [
    'risk control triggered, please verify',
    'abnormal request detected',
    'verification required',
    'device fingerprint mismatch',
    'your account has been banned',
    'account suspended',
    'suspicious activity',
    'please complete the captcha',
    '检测到异常请求，请完成验证',
    '您的账号已被限制',
  ]
  for (const text of texts) {
    assert.equal(
      classify(400, { error: text }),
      'risk_control',
      `400「${text}」没判成风控 —— 会被当成「请求本身有问题」而**不换号**`,
    )
  }
})

test('风控：403 / 429 / 200 上的风控也要认（不能落进 auth 被 DSH 覆盖文案）', () => {
  // 403 上的风控若落进 auth，DSH 的 failureMessage() 会把整句覆盖成
  // 「API 密钥无效」（`code === "AUTH" ? t("message.failure.auth") : message`），
  // 上游那句「请完成验证」直接消失，把用户引向完全错误的方向。
  assert.equal(classify(403, { error: 'Request blocked by risk control' }), 'risk_control')
  assert.equal(classify(403, { error: 'account flagged for abuse' }), 'risk_control')
  assert.equal(classify(429, { error: 'suspicious traffic detected' }), 'risk_control')
  assert.equal(classify(200, { error: 'risk control triggered' }), 'risk_control')
})

test('风控：必须换号，但绝不能在同一账号上重试', () => {
  assert.equal(shouldSwitchAccount('risk_control'), true, '风控是账号维度的问题，换号有效')
  // ★ 这条是「不重试」的判据：同号立刻重试只会加深「异常客户端」印象，
  //   把临时风控升级成长期封禁。
  assert.equal(isRetryable('risk_control'), false, '风控不该在同一账号上重试')
})

test('风控：冷却必须比鉴权更长（30 分钟 vs 10 分钟）', () => {
  const penaltySec = 300 // 默认 5 分钟地板
  const risk = penaltyMsFor('risk_control', undefined, penaltySec)
  const auth = penaltyMsFor('auth', undefined, penaltySec)
  assert.equal(risk, RISK_CONTROL_COOLDOWN_MS)
  assert.ok(risk > auth, `风控冷却（${risk}）必须比鉴权（${auth}）长`)
  // 但上游明说要等多久时听上游的（仍受封顶约束）。
  assert.equal(penaltyMsFor('risk_control', 60_000, penaltySec), 60_000, '上游给了 Retry-After 就用它')
  assert.equal(
    penaltyMsFor('risk_control', 999 * 60 * 60 * 1000, penaltySec),
    RETRY_AFTER_CAP_MS,
    '畸形超长的 Retry-After 必须被封顶',
  )
})

test('风控：不能误伤正常业务报错（否则好号被无谓锁 30 分钟）', () => {
  // 宁可漏判（落 bad_request，用户手动换号），也不要把正常报错判成风控。
  const normal = [
    'invalid parameter: temperature must be <= 2',
    'model not found',
    'context length exceeded',
    'content filtered: contains prohibited words',
    'The request was rejected because the input was too long',
  ]
  for (const text of normal) {
    assert.notEqual(
      classify(400, { error: text }),
      'risk_control',
      `正常报错「${text}」被误判成风控 —— 会让好号被无谓锁 30 分钟`,
    )
  }
  // Cloudflare 的「Access denied」是按 IP/ASN 封的，**换号无效**，
  // 保持 auth 不动；判成风控会让用户以为每个号都坏了。
  assert.equal(classify(403, { error: 'Access denied' }), 'auth')
})

test('风控：流式路径也要认（两条路径不能漂移）', () => {
  // 非流式走 classify()，流式走 classifyStreamError() —— 各自独立。
  // 只修一边的话，风控落在流里仍会被判成 server ⇒ 白重试 5 次 + 账号不降权。
  const frame = '{"error":{"message":"abnormal request detected"}}'
  const events = [...translateChunk(frame)]
  assert.equal(events.length, 1, `流式风控帧应该产出 1 个事件，实际 ${events.length} 个`)
  assert.equal(events[0].type, 'error')
  assert.equal(events[0].failure.kind, 'risk_control', '流式风控帧必须判成 risk_control')
  // 上游原话要留在文案里：那是用户唯一能行动的线索。
  assert.ok(
    events[0].failure.message.includes('abnormal request detected'),
    `文案要带上游原话，实际：${events[0].failure.message}`,
  )
})

test('风控：没有 choices 也没有 error 的帧不能被静默吞掉', () => {
  // 实测：`{"code":"RISK_CONTROL","message":"blocked"}` 带 message 会走网关分支，
  // 但只要上游换个字段名（去掉 message），整帧就凭空消失 ——
  // 用户看到「回复是空的」，完全不知道发生了什么。
  const swallowed = '{"code":"RISK_CONTROL","data":{"blocked":1}}'
  const events = [...translateChunk(swallowed)]
  assert.equal(events.length, 1, '风控帧不能被当成空帧丢掉')
  assert.equal(events[0].type, 'error')
  assert.equal(events[0].failure.kind, 'risk_control')
  // 但普通的心跳/元数据帧仍要照旧丢弃，不能把所有认不出的帧都变成错误。
  assert.deepEqual([...translateChunk('{"ping":1}')], [], '普通元数据帧应继续被丢弃')
  assert.deepEqual([...translateChunk('{"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}')]
    .filter((event) => event.type === 'error'), [], '只有 usage 的尾帧不该报错')
})

test('风控：DSH 的重试策略里不能出现 RISK_CONTROL', async () => {
  // 走到 DSH 重试这一步说明插件内部已经把所有候选号换完了，
  // 再让 DSH 重试同一路由就是纯重复撞墙，还会把风控升级成封禁。
  //
  // ⚠️ 这里**不能**引用模块级的 `GATEWAY` —— 它定义在文件后半段，
  // 而本用例在前半段执行，会撞上 TDZ（`Cannot access 'GATEWAY' before initialization`）。
  const { createLlmAdapter } = await import('../lib/llm/adapter.js')
  const { AccountRouter } = await import('../lib/core/router.js')
  const { manager, cleanup } = freshAccounts()
  try {
    const router = new AccountRouter(
      manager,
      { routing: 'quota-first', degradeAfterFailures: 1, penaltySec: 60, recoverIntervalSec: 600, maxAccountAttempts: 3, maxConcurrentRequests: 2 },
      silent,
    )
    const adapter = createLlmAdapter({
      agentId: 'qoder-cn',
      accounts: manager,
      router,
      log: silent,
      displayName: 'Qoder CN',
      labelWithAgent: true,
      modelsOf: async () => [],
    })
    const policy = adapter.providerRetryPolicy()
    assert.ok(!policy.retryableCodes.includes('RISK_CONTROL'), 'RISK_CONTROL 不该出现在可重试码里')
    // 反过来：这些确实该重试，别一起删掉。
    for (const code of ['RATE_LIMIT', 'SERVER', 'NETWORK']) {
      assert.ok(policy.retryableCodes.includes(code), `${code} 应该仍然可重试`)
    }
  } finally {
    cleanup()
  }
})

test('flattenBody 不吃循环引用', () => {
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  assert.equal(typeof flattenBody(cyclic), 'string')
})

test('parseRetryAfter 认秒数与 HTTP-date', () => {
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '2' }), 1000), 2000)
  const at = new Date(60_000).toUTCString()
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': at }), 1000), 59_000)
  assert.equal(parseRetryAfter(new Headers(), 0), undefined)
})

/**
 * 畸形 `retry-after` 的回归（真实缺陷，对齐参考实现 `retry-after.ts` 的两个细节）。
 *
 * ⚠️ 真正踩到的洞**只有负数那一条**（2026-10-19 从 git 取旧实现实测确认）：
 * 旧版是 `Number.isFinite(seconds) && seconds >= 0`，有 `>= 0` 守卫，所以
 * `'900'` 一直走秒分支、**从来不是洞**；只有 `'-5'` / `'-1'` 掉过守卫落到
 * `Date.parse` 被当成 ISO 年份（2001 年），`at - now` 成了巨大负数，
 * 再被 `Math.max(0, …)` 抹成 0 = 「立即解除限流」
 * ⇒ **刚落限流的账号马上被重选，无限空转**。
 */
test('parseRetryAfter 不把畸形数字串当成 HTTP-date', () => {
  const headers = (value) => new Headers({ 'retry-after': value })
  const now = Date.UTC(2026, 9, 19, 12, 0, 0)
  // 前置事实：负数串确实能被 Date.parse 解析出「合法」结果（缺陷的成因）。
  assert.ok(Number.isFinite(Date.parse('-5')))
  // ★ 核心回归：负数一律按「服务端没声明」处理，绝不落到 Date.parse。
  assert.equal(parseRetryAfter(headers('-5'), now), undefined)
  assert.equal(parseRetryAfter(headers('-1'), now), undefined)
  // 纯数字走「秒」分支（旧版也是对的，这条守住它别被改坏）。
  assert.equal(parseRetryAfter(headers('900'), now), 900_000)
  assert.equal(parseRetryAfter(headers('120'), now), 120_000)
  // 其它畸形值同样不产生「立即解除」。
  assert.equal(parseRetryAfter(headers('abc'), now), undefined)
  assert.equal(parseRetryAfter(headers(''), now), undefined)
})

test('parseRetryAfter 的 0 是合法值（立即解除），不是「没声明」', () => {
  // 两者语义不同：0 = 服务端明说可以立刻重试；undefined = 服务端没给。
  // 调用方必须用 `=== undefined` 判空，任何 falsy 判据都会让 0 退到保守兜底。
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '0' }), 1234), 0)
  assert.notEqual(parseRetryAfter(new Headers({ 'retry-after': '0' }), 1234), undefined)
})

test('parseRetryAfter 的 HTTP-date 分支：未来给正数，过去给 0 而不是 undefined', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0, 0)
  const future = new Date(now + 60_000).toUTCString()
  const past = new Date(now - 60_000).toUTCString()
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': future }), now), 60_000)
  // 过去的日期 = 「已经可以重试了」，是 0（合法值），不是 undefined（没声明）。
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': past }), now), 0)
})

// ───────────────────────── 降权时长（对齐参考实现） ─────────────────────────

/**
 * 额度耗尽的冷却必须是**当日量级**，不是几十分钟。
 *
 * 真实取舍（参考实现注释原话）：「钱不会在 60 秒内到账，**短冷却会让同一个
 * 空钱包账号被反复选中、反复 402**」。我们原来给 30 分钟 —— 半小时后那个号
 * 仍然没钱，于是被反复选中、反复失败，白白消耗换号次数。
 */
test('penaltyMsFor：额度耗尽按当日冷却（24h），不是 30 分钟', () => {
  assert.equal(penaltyMsFor('quota', undefined, 300), QUOTA_COOLDOWN_MS)
  assert.equal(QUOTA_COOLDOWN_MS, 24 * 60 * 60 * 1000)
})

test('penaltyMsFor：上游给了 retry-after 就用它，但封顶 30 分钟', () => {
  // 上游给 12 小时 —— 不封顶就会把账号锁 12 小时，UI 分不清「在等」与「卡死」。
  assert.equal(penaltyMsFor('quota', 12 * 60 * 60 * 1000, 300), RETRY_AFTER_CAP_MS)
  assert.equal(RETRY_AFTER_CAP_MS, 30 * 60 * 1000)
  // 没超上限就照用。
  assert.equal(penaltyMsFor('rate_limit', 90_000, 300), 90_000)
})

test('penaltyMsFor：0 是合法值（立即解除），必须被当 falsy 吞掉', () => {
  // 判空必须用 `!== undefined`；写成 falsy 判据会把「立刻可用」换成默认冷却，
  // 让刚恢复的账号继续被跳过。
  assert.equal(penaltyMsFor('rate_limit', 0, 300), 0)
  assert.equal(penaltyMsFor('quota', 0, 300), 0)
  assert.equal(penaltyMsFor('auth', 0, 300), 0)
})

test('penaltyMsFor：各类型的兜底互不相同', () => {
  assert.equal(penaltyMsFor('auth', undefined, 300), AUTH_COOLDOWN_MS)
  // 限流通常很快过去，用配置的短冷却（不额外抬高）。
  assert.equal(penaltyMsFor('rate_limit', undefined, 300), 300_000)
  // 配置的 penaltySec 比内置下限还大时，取大的那个（不缩水）。
  assert.equal(penaltyMsFor('auth', undefined, 3600), 3_600_000)
})

// ───────────────────────── 服务端日界（UTC+8） ─────────────────────────

/**
 * 幂等键的日期必须是**服务端业务日（UTC+8）**。
 *
 * 真实缺陷：原实现用 `new Date(at).toISOString().slice(0, 10)`（UTC 日），
 * 与 UTC+8 日在每天 00:00–08:00（UTC+8）之间**不是同一天** ⇒ 同一个业务日
 * 算出两个不同的幂等键 ⇒ **跨零点重复领取**。
 */
test('checkInKey 用 UTC+8 业务日，跨零点不会变成两次', () => {
  const early = Date.parse('2026-10-19T07:00:00+08:00')
  const late = Date.parse('2026-10-19T09:00:00+08:00')
  // 前置事实：UTC 日在这两点确实不同（这正是缺陷的成因）。
  assert.notEqual(new Date(early).toISOString().slice(0, 10), new Date(late).toISOString().slice(0, 10))
  assert.equal(checkInKey('qoder-cn', 'a1', early), checkInKey('qoder-cn', 'a1', late))
  assert.ok(checkInKey('qoder-cn', 'a1', early).endsWith(':2026-10-19'))
  // 跨到下一个业务日必须换键，否则第二天就漏签。
  assert.notEqual(checkInKey('qoder-cn', 'a1', early), checkInKey('qoder-cn', 'a1', Date.parse('2026-10-20T09:00:00+08:00')))
})

test('taskKey 与 checkInKey 同一日期口径', () => {
  const at = Date.parse('2026-10-19T07:30:00+08:00')
  assert.ok(taskKey('trae', 'a1', 'sign', at).endsWith(':2026-10-19'))
})

test('utc8DateString / utc8Hour 是算术平移而非本机时区', () => {
  // 取一个 UTC+8 与 UTC 分属不同日期的时刻：UTC 是 18 日 23:30，UTC+8 已是 19 日 07:30。
  const at = Date.parse('2026-10-19T07:30:00+08:00')
  assert.equal(utc8DateString(at), '2026-10-19')
  assert.equal(utc8Hour(at), 7)
  // 与「本机时区」无关：结果只由偏移常量决定。
  assert.equal(utc8DateString(Date.parse('2026-01-01T00:30:00+08:00')), '2026-01-01')
})

test('Qoder 活动刷新时刻：10:00（UTC+8）之前不算今天已刷新', () => {
  const before = Date.parse('2026-10-19T09:59:00+08:00')
  const after = Date.parse('2026-10-19T10:00:00+08:00')
  assert.equal(hasQoderCampaignRefreshedToday(before), false)
  assert.equal(hasQoderCampaignRefreshedToday(after), true)
})

test('failureOf 只带上真正给了的字段', () => {
  const failure = failureOf('auth', 'nope', { status: 401, now: 5 })
  assert.deepEqual(failure, { kind: 'auth', message: 'nope', status: 401, at: 5 })
})

// ───────────────────────── 凭证与脱敏 ─────────────────────────

test('redactSecret 只留头尾', () => {
  assert.equal(redactSecret('oc_sk_1234567890abcdef'), 'oc_s***cdef')
  assert.equal(redactSecret('short'), '***')
  assert.equal(redactSecret(undefined), '')
})

test('redactDeep 认得出各种凭证字段名', () => {
  const out = redactDeep({
    token: 'oc_sk_abcdefghijklmn',
    nested: { apiKey: 'sk-1234567890', Authorization: 'Bearer xyz12345678' },
    safe: 'ok',
    list: [{ cookie: 'a=1; b=2' }],
  })
  assert.equal(out.token, 'oc_s***klmn')
  assert.notEqual(out.nested.apiKey, 'sk-1234567890')
  assert.notEqual(out.nested.Authorization, 'Bearer xyz12345678')
  assert.equal(out.safe, 'ok')
  assert.notEqual(out.list[0].cookie, 'a=1; b=2')
})

test('凭证加解密：往返一致，改一个字节就解不开', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-vault-'))
  try {
    const vault = new CredentialVault(dir)
    const sealed = vault.seal({ token: 'oc_sk_secret' })
    assert.deepEqual(vault.open(sealed), { token: 'oc_sk_secret' })
    // 篡改密文 → 认证标签校验失败（AEAD 的意义就在这里）
    const tampered = { ...sealed, data: Buffer.from('garbage').toString('base64') }
    assert.throws(() => vault.open(tampered))
    // 换一个 vault（不同主密钥）→ 解不开
    const other = new CredentialVault(join(dir, 'nested'))
    assert.throws(() => other.open(sealed))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────── 缓存与限速 ─────────────────────────

test('MemoryCache：TTL 到期即失效', () => {
  let now = 0
  const cache = new MemoryCache(() => now)
  cache.set('a', 1, 1000)
  assert.equal(cache.get('a'), 1)
  now = 1001
  assert.equal(cache.get('a'), undefined)
  cache.set('b', 2)
  now = 10 ** 9
  assert.equal(cache.get('b'), 2)
})

test('TokenBucket：新桶从突发量开始，且会随时间补充', () => {
  let now = 0
  const bucket = new TokenBucket(60, () => now, 2)
  assert.equal(bucket.tokens('x'), 2)
  assert.equal(bucket.tryTake('x'), true)
  assert.equal(bucket.tryTake('x'), true)
  assert.equal(bucket.tryTake('x'), false)
  now = 1000
  assert.equal(bucket.tryTake('x'), true)
})

test('Semaphore：并发不超过上限', async () => {
  const semaphore = new Semaphore(2)
  let active = 0
  let peak = 0
  await Promise.all(
    Array.from({ length: 8 }, () =>
      semaphore.run(async () => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
      }),
    ),
  )
  assert.equal(peak, 2)
})

// ───────────────────────── SSE ─────────────────────────

test('SseDecoder：跨分片的 JSON 不被截断', () => {
  const decoder = new SseDecoder()
  const payload = 'data: {"choices":[{"delta":{"content":"你好"}}]}'
  // 故意切在中间
  const half = Math.floor(payload.length / 2)
  assert.deepEqual(decoder.push(payload.slice(0, half)), [])
  assert.deepEqual(decoder.push(`${payload.slice(half)}\n\n`), ['{"choices":[{"delta":{"content":"你好"}}]}'])
})

test('SseDecoder：认 \\r\\n 与心跳注释行', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push(': keep-alive\r\n\r\ndata: [DONE]\r\n\r\n'), ['[DONE]'])
})

test('translateChunk：思维链字段的四种写法都认', () => {
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'analysis']) {
    const events = translateChunk(JSON.stringify({ choices: [{ delta: { [key]: 'think' } }] }))
    assert.deepEqual(events, [{ type: 'reasoning', text: 'think' }], `字段 ${key} 没被识别`)
  }
})

test('translateChunk：坏 JSON 只返回空数组（不抛）', () => {
  assert.deepEqual(translateChunk('{ not json'), [])
  assert.deepEqual(translateChunk('[DONE]'), [])
})

/**
 * ⚠️ 用户报障 2026-10-20：**Qoder CN 的模型发消息后没有回复，直接显示「已完成」**，
 * 同一账号的 Qoder 平台正常。
 *
 * 根因：上游在 **HTTP 200** 的流里回业务错误
 * `{"code":"400","message":"[FAIL]…Execution failed: null","statusCodeValue":400}`，
 * 而 `translateChunk` 只认 `parsed.error` —— 这一帧**一个条件都不命中**，
 * 被当成「合法但空的 chunk」丢掉，流随后照常 `finish(stop)`。
 * 于是 DSH 收到「成功但零正文」，界面上就是「已完成，没有回复」。
 *
 * 危害比报错大：报错用户至少知道要重试，**静默成功会被当成模型真没话说**。
 * 参考实现（`openai-compat.ts`）对同一形态有显式分支，我们移植时漏了。
 */
test('translateChunk：网关形态/信封剥离后的错误帧不能被静默丢掉（Qoder CN 报障）', () => {
  // ① 信封剥离后的统一形态（`unwrapQoderEnvelopeStream` 产出这个）
  const stripped = translateChunk(JSON.stringify({
    code: '400',
    message: '[FAIL]node:oa_qwen-plus-main msg:Execution failed: null',
    type: 'model_error',
  }))
  assert.equal(stripped.length, 1, '必须产出恰好一个 error 事件，而不是空数组')
  assert.equal(stripped[0].type, 'error')
  assert.equal(stripped[0].failure.kind, 'server')
  assert.match(stripped[0].failure.message, /Execution failed/, '上游原文必须透出来')

  // ② 直连网关形态：没有 `type`，靠 `statusCodeValue >= 400`
  const gateway = translateChunk(JSON.stringify({
    statusCodeValue: 400,
    message: 'bad request from gateway',
  }))
  assert.equal(gateway.length, 1)
  assert.equal(gateway[0].type, 'error')
  assert.equal(gateway[0].failure.status, 400, 'status 要带出来（诊断用）')

  // ③ 带 stackTrace 也算错误
  const withStack = translateChunk(JSON.stringify({ message: 'boom', stackTrace: 'at foo' }))
  assert.equal(withStack.length, 1)
  assert.equal(withStack[0].type, 'error')

  // ④ ⚠️ 防过度修正：**正常帧绝不能被误判**。
  //    上游的正常帧也带 `statusCodeValue`（信封里是 200）与 `message` 字段吗？
  //    不 —— 正常帧是 `choices` 形状，下面两条钉住这个边界。
  const normal = translateChunk(JSON.stringify({ choices: [{ delta: { content: '你好' } }] }))
  assert.deepEqual(normal, [{ type: 'text', text: '你好' }], '正常正文不能被当成错误')

  // ⑤ 只有 `message`、既无状态码也无 type/stackTrace 的帧**不算错误**
  //    （那是上游的普通通知帧，误判会让正常对话中断）
  assert.deepEqual(translateChunk(JSON.stringify({ message: 'hello' })), [])

  // ⑥ issue IKJOZ8 不能回归：心跳帧（body:null → 'null'）仍要返回空数组
  assert.deepEqual(translateChunk('null'), [])
  assert.deepEqual(translateChunk('{}'), [])
})

test('translateChunk：usage 与 finish 都能出来', () => {
  const usage = translateChunk(
    JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } },
    }),
  )
  assert.equal(usage[0].type, 'finish')
  assert.equal(usage[0].reason, 'stop')
  assert.deepEqual(usage[1], {
    type: 'usage',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 3 },
  })
})

test('normalizeUsage：缓存字段的多种命名', () => {
  assert.equal(normalizeUsage({ prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 7 } }).cacheReadTokens, 7)
  assert.equal(normalizeUsage({ prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 5 }).cacheReadTokens, 5)
  assert.equal(normalizeUsage(undefined), undefined)
})

// ───────────────────────── 时间表达式 ─────────────────────────

test('parseSchedule：every:<秒> / 5 段 / 6 段都认', () => {
  assert.deepEqual(parseSchedule('every:1800'), { kind: 'interval', seconds: 1800, source: 'every:1800' })
  assert.equal(parseSchedule('30 8 * * *').kind, 'cron')
  assert.equal(parseSchedule('0 30 8 * * *').kind, 'cron')
})

test('parseSchedule：写错就抛（不静默）', () => {
  assert.throws(() => parseSchedule(''), /为空/)
  assert.throws(() => parseSchedule('every:5'), /至少 30 秒/)
  assert.throws(() => parseSchedule('1 2 3'), /5 段/)
  assert.throws(() => parseSchedule('99 8 * * *'), /超出范围/)
})

test('matches：每天 08:30 只在这一分钟命中', () => {
  const schedule = parseSchedule('30 8 * * *')
  assert.equal(matches(schedule, new Date(2026, 0, 1, 8, 30)), true)
  assert.equal(matches(schedule, new Date(2026, 0, 1, 8, 31)), false)
})

test('isDue：同一分钟内不重复跑', () => {
  const schedule = parseSchedule('* * * * *')
  const at = new Date(2026, 0, 1, 8, 30, 10).getTime()
  assert.equal(isDue(schedule, at - 5000, at + 5000), false)
  assert.equal(isDue(schedule, at - 61_000, at), true)
})

test('isDue：间隔任务与首次执行错峰', () => {
  const schedule = parseSchedule('every:600')
  assert.equal(isDue(schedule, 0, 1000, 5000), false)
  assert.equal(isDue(schedule, 0, 6000, 5000), true)
  assert.equal(isDue(schedule, 1000, 1000 + 599_000), false)
  assert.equal(isDue(schedule, 1000, 1000 + 600_000), true)
})

// ───────────────────────── 账号管理 ─────────────────────────

test('账号：增删改 + 标签唯一 + 加密落盘', () => {
  const { dir, manager, cleanup } = freshAccounts()
  try {
    const created = manager.add({ agentId: 'opencode', label: '主号', credentials: { token: 'oc_sk_a' } })
    assert.equal(created.id, 'opencode:主号')
    assert.throws(() => manager.add({ agentId: 'opencode', label: '主号', credentials: {} }), /已经有叫/)
    // 同名不同 Agent 可以共存
    const other = manager.add({ agentId: 'qoder', label: '主号', credentials: { token: 'q' } })
    assert.notEqual(other.id, created.id)

    manager.update(created.id, { label: '副号' })
    assert.equal(manager.get(created.id).label, '副号')

    // 密文落盘：文件里查不到明文 token
    const raw = readFileSync(manager.accountsPath, 'utf8')
    assert.equal(raw.includes('oc_sk_a'), false)

    // 重新装载（模拟 DSH 重启）
    const reloaded = new AccountManager(dir, silent, { v: 1, updatedAt: 0, health: {}, quota: {} })
    const loaded = reloaded.load()
    assert.equal(loaded.ok, true)
    assert.equal(reloaded.all().length, 2)
    assert.equal(reloaded.get(created.id).credentials.token, 'oc_sk_a')

    assert.equal(manager.remove(created.id), true)
    assert.equal(manager.get(created.id), undefined)
  } finally {
    cleanup()
  }
})

test('账号健康：连续失败降权，到期自动恢复', () => {
  const { manager, cleanup } = freshAccounts()
  try {
    const account = manager.add({ agentId: 'opencode', label: 'a', credentials: {} })
    const failure = { kind: 'rate_limit', message: '429', at: 0 }
    manager.markFailure(account.id, failure, 2, 1000, 100)
    assert.equal(manager.health(account.id).state, 'ok') // 还没到阈值
    manager.markFailure(account.id, failure, 2, 1000, 200)
    assert.equal(manager.health(account.id).state, 'degraded')
    assert.equal(manager.available(account.id, 1100), false)
    assert.equal(manager.available(account.id, 1300), true)
    const recovered = manager.recoverExpired(1300)
    assert.deepEqual(recovered, [account.id])
    manager.markOk(account.id, 2000)
    assert.equal(manager.health(account.id).failures, 0)
  } finally {
    cleanup()
  }
})

// ───────────────────────── 路由 ─────────────────────────

const GATEWAY = {
  routing: 'quota-first',
  degradeAfterFailures: 1,
  penaltySec: 60,
  recoverIntervalSec: 600,
  maxAccountAttempts: 3,
  maxConcurrentRequests: 2,
}

test('路由：401 换下一个账号，成功后返回那个账号', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    const first = manager.add({ agentId: 'opencode', label: 'a', credentials: { token: '1' } })
    const second = manager.add({ agentId: 'opencode', label: 'b', credentials: { token: '2' } })
    const router = new AccountRouter(manager, GATEWAY, silent)
    const seen = []
    const outcome = await router.execute('opencode', async (account) => {
      seen.push(account.id)
      if (account.id === first.id) return { ok: false, kind: 'auth', message: 'expired' }
      return { ok: true, value: 42 }
    })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.value, 42)
    assert.equal(outcome.accountId, second.id)
    assert.equal(seen.length, 2)
    assert.equal(manager.health(first.id).state, 'degraded')
  } finally {
    cleanup()
  }
})

test('路由：bad_request 不换号', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    manager.add({ agentId: 'opencode', label: 'a', credentials: {} })
    manager.add({ agentId: 'opencode', label: 'b', credentials: {} })
    const router = new AccountRouter(manager, GATEWAY, silent)
    let calls = 0
    const outcome = await router.execute('opencode', async () => {
      calls += 1
      return { ok: false, kind: 'bad_request', message: 'model not found' }
    })
    assert.equal(outcome.ok, false)
    assert.equal(calls, 1)
  } finally {
    cleanup()
  }
})

test('路由：额度优先按剩余额度排序', () => {
  const { manager, cleanup } = freshAccounts()
  try {
    const poor = manager.add({ agentId: 'opencode', label: 'poor', credentials: {} })
    const rich = manager.add({ agentId: 'opencode', label: 'rich', credentials: {} })
    manager.setQuota({ accountId: poor.id, unit: 'credits', remaining: 1, fetchedAt: 0 })
    manager.setQuota({ accountId: rich.id, unit: 'credits', remaining: 999, fetchedAt: 0 })
    const router = new AccountRouter(manager, GATEWAY, silent)
    const { usable } = router.candidates('opencode')
    assert.equal(usable[0].id, rich.id)
  } finally {
    cleanup()
  }
})

test('路由：账号「对话」开关关掉时，错误要说清是开关问题（不是密钥无效）', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    const account = manager.add({ agentId: 'qoder-cn', label: '主号', credentials: { token: 't' } })
    manager.update(account.id, { routeChat: false })
    const router = new AccountRouter(manager, GATEWAY, silent)
    const outcome = await router.execute('qoder-cn', async () => ({ ok: true, value: 1 }))

    assert.equal(outcome.ok, false)
    // ⚠️ 两条都是回归点：
    //   ① 归类不能是 auth —— DSH 把 code === 'AUTH' 直接渲染成「API 密钥无效」
    //      （`dsh-client-ui-chat` 的 `message.failure.auth`），用户被引向错误方向；
    //   ② 话术要点名「对话」开关，否则用户不知道该点哪里。
    assert.notEqual(outcome.failure?.kind, 'auth', '配置没就绪不该归成 auth')
    assert.match(outcome.failure?.message ?? '', /「对话」开关/, '要说清是「对话」开关关着')
    assert.match(outcome.failure?.message ?? '', /账号/, '要指向「账号」页')
  } finally {
    cleanup()
  }
})

test('路由：账号被停用 / 凭证失效各有各的话术', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    const router = new AccountRouter(manager, GATEWAY, silent)

    // 一个账号都没有时不会走到「没有可用账号」——`candidates()` 会给匿名占位
    // （见上面那条测试）。所以这里只覆盖「有账号、但都不能用」的分支。
    const account = manager.add({ agentId: 'qoder-cn', label: '主号', credentials: { token: 't' } })
    manager.update(account.id, { enabled: false })
    const off = await router.execute('qoder-cn', async () => ({ ok: true, value: 1 }))
    assert.equal(off.ok, false)
    assert.match(off.failure?.message ?? '', /停用/)
    // ⚠️ 归类必须是 unsupported：DSH 把 code === 'AUTH' 渲染成「API 密钥无效」
    assert.equal(off.failure?.kind, 'unsupported')

    // 凭证失效（健康状态 invalid）→ 说「重新登录」，不要说「没有可用账号」
    const second = manager.add({ agentId: 'qoder', label: '主号', credentials: { token: 't' } })
    manager.markInvalid(second.id, { kind: 'auth', message: '401 invalid credential', at: Date.now() })
    const invalid = await new AccountRouter(manager, GATEWAY, silent).execute('qoder', async () => ({
      ok: true,
      value: 1,
    }))
    assert.equal(invalid.ok, false)
    assert.match(invalid.failure?.message ?? '', /重新登录|凭证/, `实际：${invalid.failure?.message}`)
  } finally {
    cleanup()
  }
})

test('账号快照里的三个开关给的是「生效值」，不是「磁盘上存了什么」', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    // 登录新建的账号：三个字段都是 undefined
    const account = manager.add({ agentId: 'qoder-cn', label: '主号', credentials: { token: 't' } })
    assert.equal(account.routeChat, undefined, '前提：新建账号不写 routeChat')

    // 路由的真实判据是 `routeChat !== false` → 参与对话。
    // 界面若把 undefined 画成「关」，用户看到的就是**与真实行为相反**的状态。
    const { usable } = new AccountRouter(manager, GATEWAY, silent).candidates('qoder-cn')
    assert.equal(usable.length, 1, '未写 routeChat 的账号必须参与路由')
  } finally {
    cleanup()
  }
})

test('路由：一个账号都没有时用匿名占位（免费层不该要求先建账号）', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    const router = new AccountRouter(manager, GATEWAY, silent)
    let seen = null
    const outcome = await router.execute('opencode', async (account) => {
      seen = account
      return { ok: true, value: 'ok' }
    })
    // 关键：**必须真的发出请求**，而不是回一句「没有可用账号」。
    // 这句错误既挡住了「零配置用免费模型」的主场景，又被归成 auth，
    // 在 DSH 界面上显示成「API 密钥无效」——把用户引向完全错误的方向。
    assert.equal(outcome.ok, true, `零账号应当照常路由，实际：${outcome.failure?.message ?? ''}`)
    assert.equal(seen?.id, 'opencode:anonymous')
    assert.deepEqual(seen?.credentials, {}, '匿名占位不能带任何凭证')

    // 同一个 Agent 反复取候选，必须是**同一个 id**（否则令牌桶/健康记录会失控）
    assert.equal(router.candidates('opencode').usable[0].id, router.candidates('opencode').usable[0].id)
  } finally {
    cleanup()
  }
})

test('路由：有账号但全被禁用时仍然报配置错误，不被匿名占位掩盖', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    for (const label of ['a', 'b']) {
      const record = manager.add({ agentId: 'opencode', label, credentials: {} })
      manager.update(record.id, { enabled: false })
    }
    const router = new AccountRouter(manager, GATEWAY, silent)
    const outcome = await router.execute('opencode', async () => ({ ok: true, value: 1 }))
    assert.equal(outcome.ok, false, '有账号但全禁用 = 真实配置问题，必须报错')
    // 话术按现状分情况：全被停用就直说「停用」，别再含糊地说「没有可用账号」
    assert.match(outcome.failure.message, /停用/)
    assert.notEqual(outcome.failure.kind, 'auth', '配置问题不该显示成「API 密钥无效」')
  } finally {
    cleanup()
  }
})

// ───────────────── 工具调用的 chunk 映射（「死循环」那条 bug） ─────────────────

test('工具调用：finish 必须是 tool-calls，id 每帧稳定，多个调用各占一块', async () => {
  const events = [
    { type: 'reasoning', text: '先想想' },
    { type: 'tool_call', index: 0, id: 'call_real_1', name: 'pwsh', argumentsDelta: '{"command":' },
    { type: 'tool_call', index: 0, argumentsDelta: '"dir"}' },
    { type: 'tool_call', index: 1, id: 'call_real_2', name: 'read', argumentsDelta: '{}' },
    { type: 'finish', reason: 'tool_calls' },
  ]
  const backend = {
    id: 'opencode',
    name: 'OpenCode',
    async *requestChatStream() {
      for (const event of events) yield event
    },
  }
  const log = { child: () => log, debug() {}, info() {}, warn() {}, error() {} }
  const adapter = createLlmAdapter({
    agentId: 'opencode',
    displayName: 'OpenCode',
    labelWithAgent: true,
    // 任何属性都当函数返回 undefined —— 只关心 chunk 映射，其余依赖不该被打到。
    accounts: new Proxy({}, { get: () => () => undefined }),
    router: {
      async execute(agentId, run) {
        const account = {
          id: 'opencode:anonymous',
          agentId,
          label: 'x',
          credentials: {},
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        }
        const outcome = await run(account)
        if (outcome.ok === true) return { ok: true, accountId: account.id, attempts: [], value: outcome.value }
        return {
          ok: false,
          accountId: account.id,
          attempts: [],
          failure: { kind: outcome.kind ?? 'unknown', message: outcome.message ?? '' },
        }
      },
    },
    adapterOf: () => backend,
    contextOf: () => ({
      config: { upstream: {}, requestTimeoutMs: 1000 },
      log,
      http: async () => ({ ok: true }),
      cache: new MemoryCache(),
      now: () => 0,
    }),
    modelsOf: async () => [],
    exposedModelsOf: async () => [],
    log,
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'multiagent-opencode',
    model: 'opencode/m',
    messages: [],
    system: 's',
  })) {
    chunks.push(chunk)
  }

  // ① 有工具调用时**必须**报 `tool-calls`。报 `stop` 的话 DSH 认为本轮正常结束、
  //    不去执行工具，模型下一轮又发同样的调用 —— 就是「工具失败 + 无限循环」。
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  assert.equal(finish?.reason?.kind, 'tool-calls', `finish 报成了 ${finish?.reason?.kind}`)

  // ② 同一个工具调用跨帧的 id 必须完全一致（DSH 是 `partial.toolCallId = chunk.id` 覆盖式赋值）
  const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
  assert.ok(deltas.length >= 3, `工具增量太少：${deltas.length}`)
  const firstIndex = deltas[0].index
  const ids = new Set(deltas.filter((chunk) => chunk.index === firstIndex).map((chunk) => chunk.id))
  assert.equal(ids.size, 1, `同一工具调用的 id 必须稳定，实际拿到 ${[...ids].join(' / ')}`)
  assert.equal([...ids][0], 'call_real_1', '真 id 不能被合成的 call_N 覆盖')

  // ③ 两个并行工具调用不能挤在同一个块下标里
  assert.equal(new Set(deltas.map((chunk) => chunk.index)).size, 2, '两个并行调用应当各占一块')

  // ④ block-end 要带上累积的 name / arguments，否则拼不回完整调用
  const ends = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(ends.length, 2, `工具块收尾数不对：${ends.length}`)
  const first = ends.find((chunk) => chunk.block.id === 'call_real_1')
  assert.equal(first?.block.name, 'pwsh')
  assert.equal(first?.block.arguments, '{"command":"dir"}')
})

// ───────────────── block-end 必须带上完整正文（「输出被覆盖」那条 bug） ─────────────────

/**
 * 造一个「事件流写死」的适配器，只关心 chunk 映射。
 *
 * @param {Array<Record<string, unknown>>} events - 上游归一化事件。
 * @returns {Promise<Array<Record<string, unknown>>>} 插件吐出的全部 chunk。
 */
async function chunksOf(events) {
  const backend = {
    id: 'opencode',
    name: 'OpenCode',
    async *requestChatStream() {
      for (const event of events) yield event
    },
  }
  const log = { child: () => log, debug() {}, info() {}, warn() {}, error() {} }
  const adapter = createLlmAdapter({
    agentId: 'opencode',
    displayName: 'OpenCode',
    labelWithAgent: true,
    accounts: new Proxy({}, { get: () => () => undefined }),
    router: {
      async execute(agentId, run) {
        const account = {
          id: 'opencode:anonymous',
          agentId,
          label: 'x',
          credentials: {},
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        }
        const outcome = await run(account)
        if (outcome.ok === true) return { ok: true, accountId: account.id, attempts: [], value: outcome.value }
        return {
          ok: false,
          accountId: account.id,
          attempts: [],
          failure: { kind: outcome.kind ?? 'unknown', message: outcome.message ?? '' },
        }
      },
    },
    adapterOf: () => backend,
    contextOf: () => ({
      config: { upstream: {}, requestTimeoutMs: 1000 },
      log,
      http: async () => ({ ok: true }),
      cache: new MemoryCache(),
      now: () => 0,
    }),
    modelsOf: async () => [],
    exposedModelsOf: async () => [],
    log,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'multiagent-opencode',
    model: 'opencode/m',
    messages: [],
    system: 's',
  })) {
    chunks.push(chunk)
  }
  return chunks
}

test('选择器档位行：看模型声明的档位，不看 `reasoning` 标志', async () => {
  /**
   * 真实缺口（2026-10-19 实测）：档位行原先被包在 `if (meta.reasoning === true)` 里，
   * 于是**声明了档位但 `reasoning` 为假**的模型一个档位行都拿不到。
   * 实测 Qoder CN 的 `performance` 正是这种：目录 `is_reasoning: false`
   * （请求体 `isReasoning` 为假），但 `thinking_config.enabled` 为真、
   * 上游**确实**提供档位选择 —— 参考实现的 `resolveModel` 也只看
   * `qoderEffortsFor(entry).length > 0`，从不看 `is_reasoning`。
   *
   * 两个字段语义独立：`reasoning` = 会不会吐思维链；`reasoningEfforts` = 能不能调强度。
   */
  const log = { child: () => log, debug() {}, info() {}, warn() {}, error() {} }
  const makeInfo = async (meta) => {
    const llm = createLlmAdapter({
      agentId: 'qoder-cn',
      displayName: 'Qoder CN',
      labelWithAgent: true,
      accounts: new Proxy({}, { get: () => () => undefined }),
      router: { execute: async () => ({ ok: false, kind: 'unknown', message: 'x' }) },
      adapterOf: () => ({ id: 'qoder-cn', name: 'Qoder CN' }),
      contextOf: () => ({ config: { upstream: {} }, log, http: async () => ({ ok: true }), cache: new MemoryCache(), now: () => 0 }),
      modelsOf: async () => [meta],
      log,
    })
    return llm.resolveModel('multiagent-qoder-cn', meta.id)
  }

  // ① 有档位但 reasoning 为假 → **仍然**要出档位行（这就是被吞掉的那类）。
  const perf = await makeInfo({
    id: 'performance', name: 'Performance', agentId: 'qoder-cn', agentName: 'Qoder CN',
    reasoningEfforts: ['xhigh', 'high', 'low', 'max', 'medium', 'none'], defaultReasoningEffort: 'medium',
  })
  assert.ok(perf.reasoning, 'performance 的档位行不该被吞掉')
  assert.deepEqual(perf.reasoning.efforts.map((e) => e.id), ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(perf.reasoning.defaultEffort, 'medium', '用上游声明的默认档')

  // ② 只有 reasoning、没有档位 → 不出档位行（不谎报能力）。
  const noTiers = await makeInfo({ id: 'efficient', name: 'Efficient', agentId: 'qoder-cn', agentName: 'Qoder CN', reasoning: true })
  assert.equal(noTiers.reasoning, undefined, '不知道有哪些档位时不该出一行空的')

  // ③ 两者都没有 → 同样不出。
  const nothing = await makeInfo({ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN' })
  assert.equal(nothing.reasoning, undefined)
})

test('block-end 必须带上累积的正文：宿主是覆盖式赋值，给空串就等于把输出抹掉', async () => {
  // 宿主 `BlockAssembler.push()` 的分支是 `partial.block = chunk.block`，
  // 之后 `blocks()` 直接返回这个 block —— 也就是说 block-end 里带什么，
  // 用户最终就看到什么，前面发过的 text-delta 全被丢掉。
  // 症状：流式期间文字正常显示，一调工具/一收尾整段文字变空。
  const chunks = await chunksOf([
    { type: 'text', text: '我先看看' },
    { type: 'text', text: '这个目录' },
    { type: 'text', text: '里有什么。' },
    { type: 'tool_call', index: 0, id: 'call_1', name: 'pwsh', argumentsDelta: '{"command":"dir"}' },
    { type: 'finish', reason: 'tool_calls' },
  ])

  const textEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
  assert.ok(textEnd, '应当有一个 text 块的 block-end')
  assert.equal(
    textEnd.block.text,
    '我先看看这个目录里有什么。',
    `block-end 没带累积正文，用户看到的会变成 ${JSON.stringify(textEnd.block.text)}`,
  )

  // 而且必须与 delta 累加结果一致 —— 流式显示的和收尾后留下的不能是两个东西。
  const streamed = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  assert.equal(textEnd.block.text, streamed, 'block-end 正文必须等于所有 text-delta 的拼接')

  // 工具调用的收尾不受影响（本来就是对的那一半）。
  const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(toolEnd?.block.arguments, '{"command":"dir"}')
  assert.equal(chunks.find((chunk) => chunk.type === 'finish')?.reason.kind, 'tool-calls')
})

test('思维链同样不能被 block-end 冲掉，报错路径也要保留已流出的正文', async () => {
  const reasoning = await chunksOf([
    { type: 'reasoning', text: '先想' },
    { type: 'reasoning', text: '一下' },
    { type: 'text', text: '答案' },
    { type: 'finish', reason: 'stop' },
  ])
  const reasoningEnd = reasoning.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'reasoning')
  assert.equal(reasoningEnd?.block.text, '先想一下')

  // 上游中途报错：用户已经看到的正文不该被吞。
  const failed = await chunksOf([
    { type: 'text', text: '已经说了一半' },
    { type: 'error', failure: { kind: 'server', message: '上游炸了', at: 0 } },
  ])
  const textEnd = failed.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
  assert.equal(textEnd?.block.text, '已经说了一半', '报错也要带上已流出的正文')
  assert.equal(failed.find((chunk) => chunk.type === 'finish')?.reason.kind, 'error')
})

/**
 * 宿主 `BlockAssembler` 的**忠实复刻**（只保留决定「用户看到什么」的那几条分支）。
 *
 * 抄自 `@deepseek-ai/dsh-llm/lib/types/assembler.js`：
 *   - `block-start` 只在该 index 没出现过时建 partial；
 *   - `text-delta` / `reasoning-delta` 往 `partial.text` 上**累加**；
 *   - `block-end` 是 **`partial.block = chunk.block`** —— 覆盖，不是合并；
 *   - 最终 `blocks()` 里，**`partial.block` 存在就直接返回它**，累加的 text 被丢弃。
 *
 * 最后一条就是 bug 的全部：block-end 带空串 ⇒ 流式期间的正文归零。
 * 这段复刻让回归测试不依赖宿主安装路径，任何机器上都能跑。
 */
function hostAssemble(chunks) {
  const partials = new Map()
  const order = []
  const ensure = (index, blockType) => {
    if (!partials.has(index)) {
      partials.set(index, { blockType, text: '', toolCallId: undefined, toolCallName: undefined, toolCallArguments: '', block: undefined })
      order.push(index)
    }
    return partials.get(index)
  }
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start':
        if (!partials.has(chunk.index)) {
          order.push(chunk.index)
          partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallId: undefined,
            toolCallName: undefined,
            toolCallArguments: '',
            block: undefined,
          })
        }
        break
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) break
        partial.text += chunk.text
        break
      }
      case 'tool-call-delta': {
        const partial = ensure(chunk.index, 'tool-call')
        if (partial.block) break
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        break
      }
      case 'block-end': {
        const partial = ensure(chunk.index, chunk.block.type)
        if (partial.block) break // 首次关闭生效
        partial.block = chunk.block
        break
      }
      default:
        break
    }
  }
  return order.map((index) => {
    const partial = partials.get(index)
    if (partial.block) return partial.block // ← 覆盖物优先，累加的 text 被丢掉
    if (partial.blockType === 'text') return { type: 'text', text: partial.text }
    if (partial.blockType === 'reasoning') return { type: 'reasoning', text: partial.text }
    return {
      type: 'tool-call',
      id: partial.toolCallId ?? `call-${index}`,
      name: partial.toolCallName ?? '',
      arguments: partial.toolCallArguments,
    }
  })
}

test('端到端：把适配器的 chunk 喂进宿主装配逻辑，流式正文必须一字不少地留下', async () => {
  // 这是用户报的原始症状：流式期间有字，一调工具/一收尾整段变空。
  // 上面那个 `hostAssemble` 就是宿主的行为，终局正文以它为准。
  const chunks = await chunksOf([
    { type: 'reasoning', text: '用户要读文件，先说明一下。' },
    { type: 'text', text: '我来读取' },
    { type: 'text', text: '这个文件。' },
    { type: 'tool_call', index: 0, id: 'call_a', name: 'read', argumentsDelta: '{"filePath":' },
    { type: 'tool_call', index: 0, argumentsDelta: '"C:/tmp/a.txt"}' },
    { type: 'finish', reason: 'tool_calls' },
  ])

  const streamedText = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  const streamedReasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')

  const blocks = hostAssemble(chunks)
  const settledText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const settledReasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')

  assert.equal(
    settledText,
    streamedText,
    `正文被覆盖：流式 "${streamedText}" → 装配后 "${settledText}"（空串就是老 bug）`,
  )
  assert.equal(
    settledReasoning,
    streamedReasoning,
    `思维链被覆盖：流式 ${streamedReasoning.length} 字 → 装配后 ${settledReasoning.length} 字`,
  )
  assert.ok(settledText.trim() !== '', '正文不该是空串')

  // 工具调用仍然完整可执行 —— 修复不能弄坏另一半。
  const call = blocks.find((b) => b.type === 'tool-call')
  assert.equal(call?.name, 'read')
  assert.equal(call?.arguments, '{"filePath":"C:/tmp/a.txt"}')
  assert.equal(chunks.find((c) => c.type === 'finish')?.reason.kind, 'tool-calls')

  // 顺带钉住：任何块的文本都不该是「存在但空白」——那正是老 bug 的指纹。
  const emptyBlocks = blocks.filter(
    (b) => (b.type === 'text' || b.type === 'reasoning') && (b.text ?? '').trim() === '',
  )
  assert.equal(emptyBlocks.length, 0, `出现了 ${emptyBlocks.length} 个空文本块，老 bug 回归了`)
})

// ───────────────────────── 适配器 ─────────────────────────

test('注册表：内置清单包含全部七个平台，且接口完整', () => {
  const adapters = builtinAdapters()
  const registry = new AdapterRegistry()
  registry.registerAll(adapters)
  assert.deepEqual(registry.ids(), [
    'opencode',
    'qoder',
    'qoder-cn',
    'trae',
    'workbuddy',
    'workbuddy-intl',
    'raccoon',
  ])
  for (const adapter of adapters) {
    const check = validateAdapter(adapter)
    assert.equal(check.ok, true, `${adapter.id} 缺少 ${check.missing.join(',')}`)
  }
})

/**
 * ⚠️ 用户 2026-10-20 要求：「trae 没有实现，把 trae 直接隐藏掉」。
 *
 * 注意「隐藏」与「删掉」是两件事，这条用例把**两边的边界**都钉住：
 *   - `trae` 仍然在注册表里（协议层完好，将来验证过只需改一行默认值就能放出来）；
 *   - 但它默认 `visible=false` + `enabled=false`，于是 `isAgentActive()` 为假
 *     ⇒ 不注册 provider、不进模型选择器、设置页也不露出。
 *
 * ⚠️ 还要钉住「显式配置能覆盖默认值」：`visible` 是 volatile 字段，
 * 用户在 `cordis.patch.yml` 里写了 `agents.trae.visible: true` 就该显示 ——
 * 别把显式配置一起压掉（那是「默认值」与「强制值」的区别）。
 */
test('Trae 默认隐藏但不删除：协议层仍在，且显式配置可覆盖', () => {
  const ids = builtinAdapters().map((adapter) => adapter.id)
  const resolved = resolveConfig({}, { knownAgentIds: ids, defaultDataDir: 'x' })

  // ① 默认隐藏：两个开关都是假的（`isAgentActive` 要求 enabled && visible）
  assert.equal(resolved.agents.trae.visible, false, 'trae 默认必须不可见')
  assert.equal(resolved.agents.trae.enabled, false, 'trae 默认必须不启用')
  const active = (config, id) => config.agents[id].enabled === true && config.agents[id].visible === true
  assert.equal(active(resolved, 'trae'), false, 'trae 不该活跃 —— 否则会注册一个空 provider 分组')

  // ② 其余平台不受影响（商汤小浣熊 2026-10-27 加入，默认可见）
  for (const id of ['opencode', 'qoder', 'qoder-cn', 'workbuddy', 'workbuddy-intl', 'raccoon']) {
    assert.equal(active(resolved, id), true, `${id} 不该被连累`)
  }

  // ③ 协议层没删：仍在注册表里，接口仍然完整
  assert.ok(ids.includes('trae'), 'trae 必须仍在注册表 —— 隐藏≠删除')

  // ④ 显式配置覆盖默认值（默认值 ≠ 强制值）
  const forced = resolveConfig(
    { agents: { trae: { visible: true, enabled: true } } },
    { knownAgentIds: ids, defaultDataDir: 'x' },
  )
  assert.equal(active(forced, 'trae'), true, '显式写 visible/enabled 时应当重新显示')
})

test('骨架：默认全部返回「上游不支持」，而不是抛错', async () => {
  const adapter = createSkeleton({ id: 'x', name: 'X', upstream: 'test', credentialHint: 'token' })
  const record = { id: 'x:1', agentId: 'x', label: 'a', credentials: { token: 't' }, enabled: true, createdAt: 0, updatedAt: 0 }
  const ctx = { config: { upstream: {}, credits: { baselineUsdPerMTok: 1, unit: 'credits' } }, log: silent, cache: new MemoryCache() }
  const checkIn = await adapter.checkIn(record, ctx)
  assert.equal(checkIn.supported, false)
  assert.match(checkIn.message, /这不是故障|没有/)
  const quota = await adapter.getQuota(record, ctx)
  assert.equal(quota.unit, 'unknown')
  assert.ok(quota.error.includes('不支持') || quota.error.includes('没有'))
  assert.deepEqual(await adapter.fetchAvailableTasks(record, ctx), [])
  const task = await adapter.executeTask({ id: 't', title: 'T', kind: 'activity' }, record, ctx)
  assert.equal(task.kind, 'unsupported')
  assert.equal(task.retryable, false)
  const events = []
  for await (const event of adapter.requestChatStream({ model: 'm', messages: [] }, record, ctx, new AbortController().signal)) {
    events.push(event)
  }
  assert.equal(events[0].type, 'error')
  assert.equal(events[0].failure.kind, 'unsupported')
})

test('OpenCode：microcents → 美元', () => {
  assert.equal(microCentsToUsd('7525000000'), 75.25)
  assert.equal(microCentsToUsd('0'), 0)
  assert.equal(microCentsToUsd(null), undefined)
  assert.equal(microCentsToUsd('abc'), undefined)
})

test('OpenCode：倍率 = max(输入,输出)/基准，免费模型标 free', () => {
  assert.deepEqual(multiplierOf({ input: 0, output: 0 }, 1.2), { multiplier: 0, free: true })
  assert.deepEqual(multiplierOf({ input: 0.3, output: 1.2 }, 1.2), { multiplier: 1, free: false })
  assert.deepEqual(multiplierOf({ input: 10, output: 50 }, 1.2), { multiplier: 41.67, free: false })
  // 拿不到价格 → 不给倍率（UI 显示「未知倍率」）
  assert.deepEqual(multiplierOf(undefined, 1.2), { free: false })
})

test('formatMultiplier：免费 / ×N / 未知倍率', () => {
  assert.equal(formatMultiplier(0), '免费')
  assert.equal(formatMultiplier(undefined, true), '免费')
  assert.equal(formatMultiplier(2), '×2')
  assert.equal(formatMultiplier(1.5), '×1.5')
  assert.equal(formatMultiplier(undefined), '未知倍率')
  assert.equal(formatMultiplier(Number.NaN), '未知倍率')
})

test('OpenCode：模型 id → 人看的名字', () => {
  assert.equal(prettifyModelId('deepseek-v4.1-flash-free'), 'DeepSeek V4.1 Flash Free')
  assert.equal(prettifyModelId('big-pickle'), 'Big Pickle')
})

// ───────────────────── OpenCode 只拉免费模型 ─────────────────────
//
// 需求：这个平台只拉免费模型 —— 免费通道调不动付费模型，全列出来只会把
// 免费那几个淹没。判据两条：价格源说峰值价 0，或 id 以 `-free` 结尾（兜底）。

/** 只跑 `getModelMetaList` 的假 ctx：目录 + 价格源各回一份，其它请求 404。 */
function modelCtx({ catalog, pricing = {}, pricingFails = false }) {
  const json = (body) => ({
    ok: true,
    status: 200,
    kind: 'none',
    headers: new Headers({ 'content-type': 'application/json' }),
    body,
    text: JSON.stringify(body),
  })
  return {
    config: {
      id: 'opencode',
      upstream: {
        chatBaseUrl: 'https://proxy.example/v1',
        apiBaseUrl: 'https://proxy.example',
        modelsUrl: 'https://proxy.example/v1/models',
        pricingUrl: 'https://proxy.example/models.dev.json',
        freeTierMode: 'auto',
      },
      credits: { unit: 'usd', baselineUsdPerMTok: 1.2 },
      requestTimeoutMs: 10_000,
    },
    log: silent,
    cache: new MemoryCache(),
    now: () => Date.now(),
    http: async (url) => {
      if (String(url).endsWith('/models')) return json({ data: catalog.map((id) => ({ id })) })
      if (String(url).includes('models.dev')) {
        if (pricingFails) {
          return { ok: false, status: 502, kind: 'retryable', headers: new Headers(), text: '', message: 'HTTP 502' }
        }
        return json({ opencode: { models: pricing } })
      }
      return { ok: false, status: 404, kind: 'none', headers: new Headers(), text: '', message: 'HTTP 404' }
    },
  }
}

const anonymousRecord = () => ({
  id: 'opencode:anon',
  agentId: 'opencode',
  label: '免账号',
  credentials: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
})

test('OpenCode 只拉免费模型：付费模型不进模型列表', async () => {
  const adapter = new OpenCodeAdapter()
  const ctx = modelCtx({
    catalog: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'claude-opus-4.1', 'gpt-5', 'big-pickle'],
    pricing: {
      'deepseek-v4.1-flash-free': { cost: { input: 0, output: 0 } },
      'glm-5.3-flash-free': { cost: { input: 0, output: 0 } },
      'claude-opus-4.1': { cost: { input: 10, output: 50 } },
      'gpt-5': { cost: { input: 1.25, output: 10 } },
      // big-pickle 的 id 里没有 free，只能靠价格认出来
      'big-pickle': { cost: { input: 0, output: 0 } },
    },
  })
  const list = await adapter.getModelMetaList(anonymousRecord(), ctx)
  assert.deepEqual(
    list.map((meta) => meta.id).sort(),
    ['big-pickle', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free'],
    '付费模型（claude-opus-4.1 / gpt-5）不该出现在模型列表里',
  )
  for (const meta of list) {
    assert.equal(meta.free === true || meta.multiplier === 0, true, `${meta.id} 没被标成免费`)
  }
})

test('OpenCode 免费判定有兜底：价格源挂了也不清空列表（靠 id 的 -free 特征）', async () => {
  const adapter = new OpenCodeAdapter()
  const ctx = modelCtx({
    catalog: ['deepseek-v4.1-flash-free', 'beam-free', 'claude-opus-4.1', 'gpt-5'],
    pricingFails: true,
  })
  const list = await adapter.getModelMetaList(anonymousRecord(), ctx)
  assert.deepEqual(
    list.map((meta) => meta.id).sort(),
    ['beam-free', 'deepseek-v4.1-flash-free'],
    '价格拿不到时只能靠 id 认免费，但绝不能把整个列表清空',
  )
  // 兜底认下来的也要标「免费」，否则 UI 显示「未知倍率」会让用户以为要花钱
  for (const meta of list) assert.equal(meta.free, true)
})

test('FREE_MODEL_ID：只认 id 结尾的 free，不误伤别的模型', async () => {
  const { FREE_MODEL_ID } = await import('../lib/adapters/opencode.js')
  for (const id of ['deepseek-v4.1-flash-free', 'beam-free', 'space_bunny.free']) {
    assert.equal(FREE_MODEL_ID.test(id), true, `${id} 应当算免费`)
  }
  for (const id of ['big-pickle', 'claude-opus-4.1', 'free-tier', 'freedom', 'gpt-free-mini']) {
    assert.equal(FREE_MODEL_ID.test(id), false, `${id} 不该靠 id 被当成免费`)
  }
})

test('OpenCode：任务列表解析认多种字段名', () => {
  const tasks = parseTasks({
    data: { list: [{ task_id: 't1', task_name: '签到', reward: 5, type: 'checkin' }] },
  })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, 't1')
  assert.equal(tasks[0].title, '签到')
  assert.equal(tasks[0].reward, 5)
  assert.equal(tasks[0].kind, 'checkin')
  assert.deepEqual(parseTasks(null), [])
})

test('OpenCode：积分提取认多种字段名', () => {
  assert.equal(extractCredits({ credits: 5 }), 5)
  assert.equal(extractCredits({ data: { points: '12' } }), 12)
  assert.equal(extractCredits({ reward: 3 }), 3)
  assert.equal(extractCredits({ nothing: true }), undefined)
})

test('OpenCode：通用额度解析', () => {
  const parsed = parseGenericQuota({ data: { quota: 100, used_quota: 40 } })
  assert.equal(parsed.unit, 'credits')
  assert.equal(parsed.remaining, 100)
  assert.equal(parsed.used, 40)
  assert.equal(parseGenericQuota({ unlimited: true }).unlimited, true)
})

// ───────────────────────── LLM 适配器（分组 + 倍率标签） ─────────────────────────

test('模型标签就是任务书要求的形态', () => {
  const meta = { id: 'deepseek-r1', name: 'DeepSeek-R1', agentId: 'opencode', agentName: 'OpenCode', multiplier: 2 }
  assert.equal(renderModelLabel(meta, true), 'OpenCode · DeepSeek-R1 (×2)')
  assert.equal(renderModelLabel(meta, false), 'DeepSeek-R1 (×2)')
  assert.equal(
    renderModelLabel({ ...meta, multiplier: undefined }, true),
    'OpenCode · DeepSeek-R1 (未知倍率)',
  )
})

test('模型 id 编解码可逆', () => {
  const encoded = encodeModelId('opencode', 'deepseek/v4.1')
  assert.equal(encoded, 'opencode/deepseek/v4.1')
  assert.deepEqual(decodeModelId(encoded), { agentId: 'opencode', upstreamId: 'deepseek/v4.1' })
})

test('DSH 消息 → OpenAI 消息', async () => {
  const messages = await toOpenAiMessages({
    provider: 'p',
    model: 'm',
    system: 'sys',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'call' },
          { type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' },
        ],
      },
      { role: 'tool', content: 'result', toolCallId: 'c1' },
      { role: 'developer', content: 'dev' },
    ],
  })
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[1].content, 'hi')
  assert.equal(messages[2].tool_calls[0].id, 'c1')
  assert.equal(messages[3].tool_call_id, 'c1')
  assert.equal(messages[4].role, 'system')
})

// ───────────────────────── 免费层（无 key）与鉴权 ─────────────────────────

test('FreeTierError 被单独认出来，且归类成 unsupported（不换号、不降权）', () => {
  const body = {
    type: 'error',
    error: {
      type: 'FreeTierError',
      message: "OpenCode's free tier can only be used from within OpenCode.",
    },
  }
  assert.equal(isFreeTierError(body), true)
  assert.equal(isFreeTierError(undefined, "OpenCode's free tier can only be used from within OpenCode."), true)
  assert.equal(isFreeTierError({ error: { message: 'Invalid credential' } }), false)

  const adapter = new OpenCodeAdapter()
  // ⚠️ 关键：不能归成 auth —— 那会让路由器去换账号，而换谁都一样。
  assert.equal(adapter.detectError(403, body, new Headers()), 'unsupported')
  assert.equal(shouldSwitchAccount('unsupported'), false)
  assert.equal(isRetryable('unsupported'), false)
  // 真·凭证问题仍然归 auth。
  assert.equal(adapter.detectError(401, { error: { message: 'Invalid credential' } }, new Headers()), 'auth')
  assert.equal(adapter.detectError(403, { error: { message: 'Invalid credential' } }, new Headers()), 'auth')
})

test('免费层结论是「确定的话」，并把三件事说清楚', () => {
  // 结论必须列出过门的三件事……
  assert.match(FREE_TIER_MESSAGE, /stream:true/)
  assert.match(FREE_TIER_MESSAGE, /read/)
  assert.match(FREE_TIER_MESSAGE, /x-opencode-session/)
  // ……并说明付费模型在免费通道上要真 key。
  assert.match(FREE_TIER_MESSAGE, /Missing API key/)
  // 不许出现「可能 / 也许 / 大概」这种让人瞎试的措辞。
  assert.doesNotMatch(FREE_TIER_MESSAGE, /可能|也许|大概/)
})

// ───────────────────────── 免费层客户端指纹 ─────────────────────────

test('canonicalSessionId：形状合规、可复现、且接受已规范的输入', () => {
  const a = canonicalSessionId('第一次对话的开场白', 1_792_200_000_000)
  const b = canonicalSessionId('第一次对话的开场白', 1_792_200_000_000)
  const c = canonicalSessionId('另一段对话', 1_792_200_000_000)
  assert.equal(a, b, '同样的信号必须得到同样的 session（prompt cache 亲和性）')
  assert.notEqual(a, c)
  assert.match(a, CANONICAL_SESSION_PATTERN)
  assert.match(a.slice(4, 16), DESCENDING_TIME_PATTERN)
  // 已经是规范形状的输入：原样透传（保住上游的会话亲和）
  assert.equal(canonicalSessionId(a), a)
})

test('descendingTimePartHex：低 12 位落在官方窗口 0xFC0–0xFFF', () => {
  for (const counter of [1, 2, 31, 63]) {
    const hex = descendingTimePartHex(1_792_200_000_000, counter)
    assert.equal(hex.length, 12)
    const low = parseInt(hex.slice(9), 16)
    assert.ok(low >= 0xfc0 && low <= 0xfff, `counter=${counter} 的低 12 位 ${hex.slice(9)} 越界`)
    assert.match(hex, DESCENDING_TIME_PATTERN)
  }
  // 越界的 counter 会被夹回窗口内（不能生成一个必被 403 的形状）
  assert.match(descendingTimePartHex(1_792_200_000_000, 100).slice(9), /^f[c-f][0-9a-f]$/)
})

test('ensureFreeTierTools：缺 read 就补，有就不动', () => {
  assert.equal(hasReadTool([]), false)
  assert.equal(hasReadTool([{ type: 'function', function: { name: 'read' } }]), true)
  // 大小写不同**不算**命中 —— 门禁要的就是小写 read
  assert.equal(hasReadTool([{ type: 'function', function: { name: 'Read' } }]), false)

  const filled = ensureFreeTierTools([{ type: 'function', function: { name: 'pwsh' } }])
  assert.equal(filled.length, 2)
  assert.equal(hasReadTool(filled), true)
  // 原有的工具不能被顶掉
  assert.equal(filled[0].function.name, 'pwsh')
  // 占位工具的措辞必须挡住模型调用它
  const stub = filled[1].function
  assert.equal(stub.name, 'read')
  assert.match(stub.description, /DE?PRECATED|Do NOT call/i)

  const untouched = [{ type: 'function', function: { name: 'read' } }]
  assert.deepEqual(ensureFreeTierTools(untouched), untouched)
  assert.equal(ensureFreeTierTools(undefined).length, 1)
})

test('shapeFreeTierRequest：补齐三件事，且不带旧客户端头', () => {
  const shaped = shapeFreeTierRequest({
    model: 'm',
    messages: [{ role: 'user', content: '开场白' }],
    stream: false,
    tools: [],
  })
  // ① 强制流式 ② 有 read 工具 ③ 有规范化会话头
  assert.equal(shaped.body.stream, true)
  assert.equal(hasReadTool(shaped.body.tools), true)
  assert.match(shaped.session, CANONICAL_SESSION_PATTERN)
  assert.equal(shaped.headers['x-opencode-session'], shaped.session)
  assert.equal(shaped.headers['x-opencode-session-id'], shaped.session)
  assert.equal(shaped.headers['x-opencode-client'], 'cli')
  assert.match(shaped.headers['user-agent'], /^opencode\//)
  // x-opencode-request 是旧客户端标记，带上会被某些代的门禁拒
  assert.equal(shaped.headers['x-opencode-request'], undefined)
  assert.equal(shaped.headers.authorization, undefined)
})

test('会话信号取「第一条 user 消息」——多轮增长时 session 不变', () => {
  const first = { model: 'm', messages: [{ role: 'user', content: '第一句' }] }
  const later = {
    model: 'm',
    messages: [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '第二句' },
    ],
  }
  assert.equal(conversationSignal(first), conversationSignal(later))
  // 块数组形态也要认（DSH 的请求就是这种）
  assert.equal(
    conversationSignal({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '第一句' }] }] }),
    '第一句',
  )
})

// ───────────────────── 模型上报策略（勾选式） ─────────────────────

test('selectExposedModels：三种模式的过滤口径', () => {
  const list = [
    { id: 'free-a', name: 'A', agentId: 'opencode', free: true },
    { id: 'paid-b', name: 'B', agentId: 'opencode', multiplier: 2 },
    { id: 'paid-c', name: 'C', agentId: 'opencode', multiplier: 5 },
  ]
  // free 只留标记为免费的（默认值：选择器不该被 80+ 个模型塞满）
  assert.deepEqual(
    selectExposedModels(list, { mode: 'free', selected: [] }).map((x) => x.id),
    ['free-a'],
  )
  // selected 严格按勾选
  assert.deepEqual(
    selectExposedModels(list, { mode: 'selected', selected: ['paid-c'] }).map((x) => x.id),
    ['paid-c'],
  )
  // 勾了不存在的 id 不会凭空造出来
  assert.deepEqual(selectExposedModels(list, { mode: 'selected', selected: ['nope'] }), [])
  // all 原样
  assert.equal(selectExposedModels(list, { mode: 'all', selected: [] }).length, 3)
  // 不改动入参
  assert.equal(list.length, 3)
})

test('selectExposedModels：空列表就是空列表，不偷偷放开', () => {
  assert.deepEqual(selectExposedModels([], { mode: 'free', selected: [] }), [])
  assert.deepEqual(selectExposedModels([], { mode: 'all', selected: [] }), [])
})

test('applyContextWindow：按模型覆盖 > 默认值 > 上游报的', async () => {
  const { applyContextWindow } = await import('../lib/core/types.js')
  const list = [
    { id: 'free-a', name: 'A', agentId: 'opencode', contextWindow: 262144 },
    { id: 'paid-b', name: 'B', agentId: 'opencode', contextWindow: 1000000 },
    { id: 'bare-c', name: 'C', agentId: 'opencode' },
  ]
  // 什么都没配：一个字节都不改（不能把 undefined 变成 0，那会让 DSH 立刻压缩）
  const untouched = applyContextWindow(list, { default: 0, overrides: {} })
  assert.equal(untouched[0].contextWindow, 262144)
  assert.equal(untouched[2].contextWindow, undefined)

  // 只配默认值：所有模型都被改成它
  const byDefault = applyContextWindow(list, { default: 131072, overrides: {} })
  assert.deepEqual(
    byDefault.map((meta) => meta.contextWindow),
    [131072, 131072, 131072],
  )

  // 按模型覆盖优先于默认值
  const byId = applyContextWindow(list, { default: 131072, overrides: { 'paid-b': 200000 } })
  assert.equal(byId[0].contextWindow, 131072)
  assert.equal(byId[1].contextWindow, 200000)

  // 不修改入参
  assert.equal(list[0].contextWindow, 262144)
})

test('parseWindowOverrides：只收合法的 `id=正数`，坏条目直接丢', async () => {
  const { parseWindowOverrides } = await import('../lib/config.js')
  assert.deepEqual(parseWindowOverrides('a=131072, b=200000'), { a: 131072, b: 200000 })
  assert.deepEqual(parseWindowOverrides('a=131072\nb=200000'), { a: 131072, b: 200000 })
  // 0 和负数一律丢弃 —— 否则 DSH 会立刻压缩
  assert.deepEqual(parseWindowOverrides('a=0,b=-5,c=abc,d=,=99,ok=1000'), { ok: 1000 })
  assert.deepEqual(parseWindowOverrides(''), {})
})

// ───────────────────── 上游错误的归类（含匿名 401） ─────────────────────

test('describeOpenCodeError：匿名请求的 401 是 unsupported，不是 auth', () => {
  // 真实报文：付费模型走匿名通道时上游回的就是这个。
  // 归成 auth 的话 —— 路由器会去换账号（换谁都一样），而且 DSH 界面上
  // 会显示成「API 密钥无效」，把用户引向完全错误的方向（实测踩到过）。
  const verdict = describeOpenCodeError(
    401,
    { type: 'error', error: { type: 'AuthError', message: 'Missing API key.' } },
    { anonymous: true },
  )
  assert.equal(verdict.kind, 'unsupported')
  assert.match(verdict.message, /不在匿名免费层/)
  assert.match(verdict.message, /真 API key/)
})

test('describeOpenCodeError：带 key 时的凭证错误仍然是 auth', () => {
  const keyed = describeOpenCodeError(
    401,
    { type: 'error', error: { type: 'AuthError', message: 'Invalid credential' } },
    { anonymous: false },
  )
  assert.equal(keyed.kind, 'auth')
  // 同一个 401，匿名与非匿名必须给出不同结论 —— 这是这个函数存在的全部意义。
  const anonymous = describeOpenCodeError(401, { error: { message: 'Missing API key.' } }, { anonymous: true })
  assert.notEqual(keyed.kind, anonymous.kind)
})

test('describeOpenCodeError：地区限制与免费层各自归类', () => {
  const region = describeOpenCodeError(403, {
    type: 'error',
    error: { type: 'RegionError', message: 'This model is not available in your country' },
  })
  assert.equal(region.kind, 'unsupported')
  assert.match(region.message, /地区/)

  const free = describeOpenCodeError(403, {
    type: 'error',
    error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode." },
  })
  assert.equal(free.kind, 'unsupported')
  assert.match(free.message, /stream:true/)
})

test('describeOpenCodeError：额度类错误该换号，所以是 quota', () => {
  assert.equal(describeOpenCodeError(402, { error: { message: 'insufficient_quota' } }).kind, 'quota')
})

test('isParseableJson：只有解析不了才算坏事件', () => {
  assert.equal(isParseableJson('{"a":1}'), true)
  // 只带 role 的合法首帧：解析得了 → 不算坏
  assert.equal(isParseableJson('{"choices":[{"delta":{"role":"assistant"}}]}'), true)
  assert.equal(isParseableJson('{ broken'), false)
  assert.equal(isParseableJson('   '), false)
  // 合法但空 → translateChunk 返回空数组，但**不是**坏事件
  assert.deepEqual(translateChunk('{"choices":[{"delta":{"role":"assistant"}}]}'), [])
  assert.equal(isParseableJson('{"choices":[{"delta":{"role":"assistant"}}]}'), true)
})

test('freeTierMode：auto 只在没有 key 时启用', async () => {
  const adapter = new OpenCodeAdapter()
  const seen = []
  /** 假的流式响应：给一条内容 + [DONE]。 */
  const fakeFetch = async (url, init) => {
    seen.push({ url, headers: init.headers ?? {} })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const mkCtx = (mode) => {
    const ctx = fakeContext(async () => ({ ok: true, status: 200, kind: 'none', headers: new Headers(), body: {}, text: '{}' }))
    ctx.config.upstream.freeTierMode = mode
    ctx.fetch = fakeFetch
    return ctx
  }
  const drain = async (record, ctx) => {
    for await (const _event of adapter.requestChatStream(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      record,
      ctx,
      new AbortController().signal,
    )) {
      void _event
    }
  }

  const keyless = {
    id: 'opencode:free',
    agentId: 'opencode',
    label: 'free',
    credentials: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const keyed = { ...keyless, credentials: { token: 'oc_sk_real' } }

  // auto + 无 key → 带免费层头
  await drain(keyless, mkCtx('auto'))
  assert.ok(seen.at(-1).headers['x-opencode-session'], 'auto 模式下无 key 账号必须带会话头')
  assert.equal(seen.at(-1).headers['x-opencode-client'], 'cli')

  // auto + 有 key → 不带
  seen.length = 0
  await drain(keyed, mkCtx('auto'))
  assert.equal(seen.at(-1).headers['x-opencode-session'], undefined, 'auto 模式下有 key 账号不该带免费层头')
  assert.match(String(seen.at(-1).headers.authorization ?? ''), /^Bearer oc_sk_real$/)

  // never → 一律不带
  seen.length = 0
  await drain(keyless, mkCtx('never'))
  assert.equal(seen.at(-1).headers['x-opencode-session'], undefined)

  // always → 有 key 也带
  seen.length = 0
  await drain(keyed, mkCtx('always'))
  assert.ok(seen.at(-1).headers['x-opencode-session'], 'always 模式下有 key 账号也要带')
})

test('无凭证账号是合法的：能加、能进路由候选', () => {
  const { manager, cleanup } = freshAccounts()
  try {
    // 中转 / 反代上游可能完全不要 key —— 凭证留空不该被拦。
    const account = manager.add({ agentId: 'opencode', label: '免密钥中转', credentials: {} })
    assert.equal(account.credentials.token, undefined)
    const router = new AccountRouter(manager, GATEWAY, silent)
    const { usable } = router.candidates('opencode')
    assert.equal(usable.length, 1)
    assert.equal(usable[0].id, account.id)
  } finally {
    cleanup()
  }
})

test('空凭证时 validateCredentials 会去问上游，而不是本地直接判死', async () => {
  const adapter = new OpenCodeAdapter()
  const calls = []
  const ctx = {
    config: {
      id: 'opencode',
      upstream: {
        chatBaseUrl: 'https://proxy.example/v1',
        apiBaseUrl: 'https://proxy.example',
        modelsUrl: 'https://proxy.example/v1/models',
      },
      credits: { unit: 'credits', baselineUsdPerMTok: 1.2 },
      requestTimeoutMs: 10_000,
    },
    log: silent,
    cache: new MemoryCache(),
    now: () => Date.now(),
    http: async (url) => {
      calls.push(url)
      if (url.endsWith('/models')) {
        return {
          ok: true,
          status: 200,
          kind: 'none',
          headers: new Headers({ 'content-type': 'application/json' }),
          body: { data: [{ id: 'deepseek-v4.1-flash-free' }] },
          text: '{"data":[{"id":"deepseek-v4.1-flash-free"}]}',
        }
      }
      // 中转接受匿名请求
      return {
        ok: true,
        status: 200,
        kind: 'none',
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { choices: [{ message: { content: 'pong' } }] },
        text: '{"choices":[{"message":{"content":"pong"}}]}',
      }
    },
  }
  const record = {
    id: 'opencode:anon',
    agentId: 'opencode',
    label: '免密钥',
    credentials: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const result = await adapter.validateCredentials(record, ctx)
  assert.equal(result.ok, true, `期望通过，实际：${result.message}`)
  assert.match(result.message, /匿名/)
  // 必须真的打了上游（先目录、再推理），不能只在本地判断。
  assert.ok(calls.some((url) => url.endsWith('/models')))
  assert.ok(calls.some((url) => url.endsWith('/chat/completions')))
})

test('looksLikeApi：SPA 的 HTML 外壳不算 API（探测防误判）', () => {
  // 任何路径都返回 200 HTML 的控制台，不能被当成接口存在。
  assert.equal(
    looksLikeApi({ status: 200, ok: true, headers: new Headers({ 'content-type': 'text/html' }), text: '<!doctype html>' }),
    false,
  )
  assert.equal(
    looksLikeApi({ status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: '{}' }),
    true,
  )
  // 401/403/405/422 = 路径存在，只是拒绝了这次请求。
  assert.equal(looksLikeApi({ status: 405, ok: false, headers: new Headers(), text: '' }), true)
  assert.equal(looksLikeApi({ status: 404, ok: false, headers: new Headers(), text: '' }), false)
})

// ───────────────────────── OAuth 设备码登录 ─────────────────────────

/** 造一个可编程的假 ctx。 */
function fakeContext(handler, overrides = {}) {
  return {
    config: {
      id: 'opencode',
      upstream: {
        chatBaseUrl: 'https://opencode.ai/inference/openai/v1',
        apiBaseUrl: 'https://opencode.ai/console',
        modelsUrl: 'https://opencode.ai/inference/v1/models',
      },
      credits: { unit: 'credits', baselineUsdPerMTok: 1.2 },
      requestTimeoutMs: 10_000,
    },
    log: silent,
    cache: new MemoryCache(),
    now: () => 1_000_000,
    http: handler,
    ...overrides,
  }
}

test('readOAuthError：认上游的 DeviceTokenError 形状', () => {
  assert.equal(
    readOAuthError({ _tag: 'DeviceTokenError', error: 'authorization_pending', error_description: 'pending' }),
    'authorization_pending',
  )
  assert.equal(readOAuthError({ error: 'slow_down' }), 'slow_down')
  assert.equal(readOAuthError(null), '')
})

test('startDeviceLogin：device_code 与用户可见字段都对，且相对链接被解析成绝对地址', async () => {
  const seen = []
  const ctx = fakeContext(async (url, init) => {
    seen.push({ url, body: init?.body })
    return {
      ok: true,
      status: 200,
      kind: 'none',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        device_code: 'DEV-CODE',
        user_code: 'SNDF-LJTG',
        verification_uri_complete: '/console/device?user_code=SNDF-LJTG&client_id=opencode-cli',
        expires_in: 600,
        interval: 5,
      },
      text: '{}',
    }
  })
  const adapter = new OpenCodeAdapter()
  const start = await adapter.startDeviceLogin(ctx)

  assert.equal(start.deviceCode, 'DEV-CODE')
  assert.equal(start.userCode, 'SNDF-LJTG')
  assert.equal(start.expiresInSec, 600)
  assert.equal(start.intervalSec, 5)
  // ⚠️ 上游给的是相对路径；没解析成绝对地址的话用户点不开。
  assert.equal(
    start.verificationUrl,
    'https://opencode.ai/console/device?user_code=SNDF-LJTG&client_id=opencode-cli',
  )
  // 打的是官方的设备码端点，且带上公开 client_id。
  assert.equal(seen[0].url, 'https://opencode.ai/console/auth/device/code')
  assert.match(String(seen[0].body), /client_id=opencode-cli/)
})

test('pollDeviceLogin：pending / ready / denied 三种状态各自翻译对', async () => {
  const adapter = new OpenCodeAdapter()

  const pending = await adapter.pollDeviceLogin(
    'DEV-CODE',
    fakeContext(async () => ({
      ok: false,
      status: 400,
      kind: 'bad_request',
      headers: new Headers(),
      body: { _tag: 'DeviceTokenError', error: 'authorization_pending' },
      text: '{}',
    })),
  )
  // 「还没授权」是正常中间态，**不是故障**，所以不能抛错。
  assert.equal(pending.status, 'pending')

  const ready = await adapter.pollDeviceLogin(
    'DEV-CODE',
    fakeContext(async () => ({
      ok: true,
      status: 200,
      kind: 'none',
      headers: new Headers(),
      body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, org_id: 'org_1', email: 'me@example.com' },
      text: '{}',
    })),
  )
  assert.equal(ready.status, 'ready')
  assert.equal(ready.accessToken, 'AT')
  assert.equal(ready.refreshToken, 'RT')
  assert.equal(ready.orgId, 'org_1')
  assert.equal(ready.account, 'me@example.com')
  assert.equal(ready.expiresAt, 1_000_000 + 3600_000)

  const denied = await adapter.pollDeviceLogin(
    'DEV-CODE',
    fakeContext(async () => ({
      ok: false,
      status: 400,
      kind: 'bad_request',
      headers: new Headers(),
      body: { error: 'access_denied' },
      text: '{}',
    })),
  )
  assert.equal(denied.status, 'denied')
  assert.doesNotMatch(denied.message, /失败/)
})

test('ensureFreshCredentials：快过期才续期，并把新值回写落盘', async () => {
  const adapter = new OpenCodeAdapter()
  const persisted = []
  const ctx = fakeContext(
    async (url, init) => {
      assert.match(String(init?.body), /grant_type=refresh_token/)
      return {
        ok: true,
        status: 200,
        kind: 'none',
        headers: new Headers(),
        body: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 },
        text: '{}',
      }
    },
    { onCredentialsRefreshed: (id, patch) => persisted.push({ id, patch }) },
  )

  // ① 还有很久才过期 → 不该打上游
  const fresh = {
    id: 'opencode:a',
    agentId: 'opencode',
    label: 'a',
    credentials: { token: 'AT', refreshToken: 'RT', expiresAt: 1_000_000 + 3600_000 },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  assert.equal((await adapter.ensureFreshCredentials(fresh, ctx)).token, 'AT')
  assert.equal(persisted.length, 0)

  // ② 5 分钟内过期 → 续期 + 回写
  const expiring = {
    ...fresh,
    credentials: { token: 'AT', refreshToken: 'RT', expiresAt: 1_000_000 + 60_000 },
  }
  const next = await adapter.ensureFreshCredentials(expiring, ctx)
  assert.equal(next.token, 'AT2')
  assert.equal(next.refreshToken, 'RT2')
  // 内存记录也要更新 —— 否则本次调用链还是用旧 token
  assert.equal(expiring.credentials.token, 'AT2')
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].patch.token, 'AT2')

  // ③ 没有 refreshToken（例如手工填的 API key）→ 什么都不做
  const apiKey = { ...fresh, credentials: { token: 'oc_sk_x', expiresAt: 1_000_000 + 60_000 } }
  assert.equal((await adapter.ensureFreshCredentials(apiKey, ctx)).token, 'oc_sk_x')
  assert.equal(persisted.length, 1)
})

test('ensureFreshCredentials：续期失败不抛错，先用旧 token 让上游说话', async () => {
  const adapter = new OpenCodeAdapter()
  const ctx = fakeContext(async () => ({
    ok: false,
    status: 500,
    kind: 'server',
    headers: new Headers(),
    body: { error: 'boom' },
    text: '{}',
  }))
  const record = {
    id: 'opencode:a',
    agentId: 'opencode',
    label: 'a',
    credentials: { token: 'AT', refreshToken: 'RT', expiresAt: 1_000_000 + 1000 },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const out = await adapter.ensureFreshCredentials(record, ctx)
  assert.equal(out.token, 'AT')
})

// ─────────────────────────── 模型排序 / 厂商 / 默认勾选 ───────────────────────────

/** 造一条最小 ModelMeta（只带排序用得到的字段）。 */
const meta = (id, name, multiplier, free) => ({
  id,
  name: name ?? id,
  agentId: 'opencode',
  agentName: 'OpenCode',
  ...(multiplier === undefined ? {} : { multiplier }),
  ...(free === undefined ? {} : { free }),
})

test('vendorOf：认得出的走厂商表，认不出的退化成 id 第一段', () => {
  assert.equal(vendorOf('deepseek-v4.1-flash-free').key, 'deepseek')
  assert.equal(vendorOf('glm-5.3-flash-free').key, 'zhipu')
  assert.equal(vendorOf('claude-sonnet-4.5').key, 'anthropic')
  assert.equal(vendorOf('gpt-5').key, 'openai')
  assert.equal(vendorOf('gemini-2.5-pro').key, 'google')
  assert.equal(vendorOf('qwen3.8-flash').key, 'alibaba')
  assert.equal(vendorOf('nemotron-3.5-lightning-free').key, 'nvidia')
  // 认不出的：用第一段，保证「同一家的排在一起」仍然成立
  assert.equal(vendorOf('big-pickle').key, 'big')
  assert.equal(vendorOf('space-bunny-free').key, 'space')
})

test('isFreeModel：free 标记或倍率 0 都算免费', () => {
  assert.equal(isFreeModel(meta('a', 'A', 0)), true)
  assert.equal(isFreeModel(meta('a', 'A', undefined, true)), true)
  assert.equal(isFreeModel(meta('a', 'A', 2)), false)
  assert.equal(isFreeModel(meta('a', 'A', undefined)), false)
})

test('sortForPicker：免费最前 → 厂商聚簇 → 倍率升序 → 名称', () => {
  const list = [
    meta('gpt-5', 'GPT-5', 2.4),
    meta('deepseek-v3.2', 'DeepSeek V3.2', 0.4),
    meta('big-pickle', 'Big Pickle', 0, true),
    meta('glm-5.3-flash-free', 'GLM Free', 0, true),
    meta('claude-sonnet-4.5', 'Claude', 1.8),
    meta('deepseek-r1', 'DeepSeek R1', 1.2),
    meta('space-bunny-free', 'Space Bunny', 0, true),
    meta('deepseek-v4.1-flash-free', 'DeepSeek Free', 0, true),
  ]
  const sorted = sortForPicker(list).map((item) => item.id)

  // ① 四个免费的全在最前
  assert.deepEqual(sorted.slice(0, 4).sort(), [
    'big-pickle',
    'deepseek-v4.1-flash-free',
    'glm-5.3-flash-free',
    'space-bunny-free',
  ])
  // ② 付费区里同一厂商连在一起：两个 deepseek 相邻
  const paid = sorted.slice(4)
  assert.equal(paid.length, 4)
  const deepseekAt = paid.indexOf('deepseek-v3.2')
  const deepseekR1At = paid.indexOf('deepseek-r1')
  assert.ok(deepseekAt >= 0 && deepseekR1At >= 0)
  assert.equal(Math.abs(deepseekAt - deepseekR1At), 1, 'deepseek 的两个模型必须相邻')
  // ③ 同厂商内按倍率升序
  assert.ok(deepseekAt < deepseekR1At, '×0.4 应排在 ×1.2 前面')
  // ④ 原数组不被修改
  assert.equal(list[0].id, 'gpt-5')
})

test('sortForPicker：未知倍率排在同厂商的最后', () => {
  const sorted = sortForPicker([
    meta('deepseek-x', 'X', undefined),
    meta('deepseek-y', 'Y', 0.5),
  ]).map((item) => item.id)
  assert.deepEqual(sorted, ['deepseek-y', 'deepseek-x'])
})

test('effectiveSelectedIds：mode 感知，界面勾选与实际上报同源', () => {
  const list = [meta('free-a', 'A', 0, true), meta('paid-b', 'B', 2), meta('paid-c', 'C', 3)]
  assert.deepEqual(effectiveSelectedIds(list, { mode: 'free', selected: [] }), ['free-a'])
  assert.deepEqual(effectiveSelectedIds(list, { mode: 'all', selected: [] }), ['free-a', 'paid-b', 'paid-c'])
  assert.deepEqual(effectiveSelectedIds(list, { mode: 'selected', selected: ['paid-b'] }), ['paid-b'])
  // selected 里写了不存在的 id：忽略，不报错
  assert.deepEqual(effectiveSelectedIds(list, { mode: 'selected', selected: ['nope'] }), [])
})

test('defaultSelectedIds：有免费就全勾免费，没有就一个都不勾', () => {
  assert.deepEqual(
    defaultSelectedIds([meta('free-a', 'A', 0, true), meta('free-b', 'B', undefined, true), meta('paid', 'P', 2)]),
    ['free-a', 'free-b'],
  )
  assert.deepEqual(defaultSelectedIds([meta('paid', 'P', 2)]), [])
  assert.deepEqual(defaultSelectedIds([]), [])
})

// ─────────────────────────── 模型可用性探测 ───────────────────────────

test('classifyProbeOutcome：只有针对该模型的明确答复才算判定', () => {
  // 200 = 真的能出字
  assert.equal(classifyProbeOutcome({ status: 200, text: 'data: {}' }), 'available')

  // 地区限制：三种常见措辞都要认出来
  assert.equal(
    classifyProbeOutcome({ status: 403, text: '{"error":"This model is not available in your country"}' }),
    'region-blocked',
  )
  assert.equal(classifyProbeOutcome({ status: 403, text: '{"error":"not available in your region"}' }), 'region-blocked')

  // 404 / 模型已下线
  assert.equal(classifyProbeOutcome({ status: 404, text: '{"error":"Model is unavailable"}' }), 'unavailable')
  assert.equal(classifyProbeOutcome({ status: 404, text: 'not found' }), 'unavailable')

  // 400 只有明确指向模型时才归到模型头上
  assert.equal(classifyProbeOutcome({ status: 400, text: '{"error":"invalid model: foo"}' }), 'unavailable')
  assert.equal(classifyProbeOutcome({ status: 400, text: '{"error":"messages must not be empty"}' }), 'unknown')
})

test('classifyProbeOutcome：不是对模型的判定 → 一律 unknown（绝不能标灰）', () => {
  // 网络层失败：没拿到任何答复
  assert.equal(classifyProbeOutcome({ error: 'fetch failed: ECONNRESET' }), 'unknown')
  // 免费层门禁：针对机器而不是模型
  assert.equal(
    classifyProbeOutcome({ status: 403, text: '{"error":{"type":"FreeTierError","message":"can only be used from within OpenCode"}}' }),
    'unknown',
  )
  assert.equal(classifyProbeOutcome({ status: 401, text: '{"error":"missing api key"}' }), 'unknown')
  assert.equal(classifyProbeOutcome({ status: 429, text: 'rate limited' }), 'unknown')
  assert.equal(classifyProbeOutcome({ status: 503, text: 'upstream down' }), 'unknown')
  assert.equal(classifyProbeOutcome({ status: 500, text: 'boom' }), 'unknown')
})

test('runProbeBatch：并发受控、单条失败不断批、结果按入参顺序', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  let inFlight = 0
  let peak = 0
  const results = await runProbeBatch(
    ids,
    async (id) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      if (id === 'c') throw new Error('boom')
      if (id === 'd') return { status: 404, text: 'model not found' }
      return { status: 200, text: 'ok', ttftMs: 123.6 }
    },
    { concurrency: 2 },
  )

  assert.ok(peak <= 2, `并发不该超过 2，实际峰值 ${peak}`)
  assert.deepEqual(results.map((r) => r.modelId), ids, '结果必须按入参顺序')
  assert.equal(results[0].status, 'available')
  assert.equal(results[0].ttftMs, 124, '首字延迟四舍五入')
  assert.equal(results[2].status, 'unknown', '抛错按 unknown 记，不能中断整批')
  assert.equal(results[3].status, 'unavailable')
})

test('mergeProbeCache：合并返回新对象，不改入参', () => {
  const before = { a: { modelId: 'a', status: 'available', at: 1 } }
  const after = mergeProbeCache(before, [{ modelId: 'b', status: 'unknown', at: 2 }])
  assert.equal(Object.keys(before).length, 1, '入参不能被改')
  assert.deepEqual(Object.keys(after).sort(), ['a', 'b'])
})

test('isStale：超过阈值才算过期', () => {
  const at = 1_000_000
  assert.equal(isStale({ at }, at + PROBE_DEFAULTS.staleAfterMs - 1), false)
  assert.equal(isStale({ at }, at + PROBE_DEFAULTS.staleAfterMs + 1), true)
})

test('availabilityLabel：四态文案固定', () => {
  assert.equal(availabilityLabel('available'), '可用')
  assert.equal(availabilityLabel('region-blocked'), '地区受限')
  assert.equal(availabilityLabel('unavailable'), '不可用')
  assert.equal(availabilityLabel('unknown'), '未探测')
})

// ─────────────────────────── 请求日志 ───────────────────────────

test('computeTps：解码耗时算速度，窗口太短不给结论', () => {
  // 2000ms 总耗时，首字 1000ms → 解码 1000ms，输出 50 token → 50 tok/s
  assert.equal(computeTps({ durationMs: 2000, ttftMs: 1000, outputTokens: 50 }), 50)
  // 窗口只有 20ms：算出来会是几万 tok/s，宁可没有
  assert.equal(computeTps({ durationMs: 1020, ttftMs: 1000, outputTokens: 50 }), undefined)
  // 缺 token / 缺首字：都不给结论
  assert.equal(computeTps({ durationMs: 2000, ttftMs: 1000 }), undefined)
  assert.equal(computeTps({ durationMs: 2000, outputTokens: 50 }), undefined)
})

test('RequestLog：新的在前、分页、容量上限、清空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-req-'))
  try {
    const log = new RequestLog(join(dir, 'requests.jsonl'), { maxEntries: 50 })
    for (let index = 0; index < 5; index += 1) {
      log.record({
        agentId: 'opencode',
        agentName: 'OpenCode',
        model: 'free-a',
        accountId: null,
        ok: true,
        durationMs: 1000,
        ts: 1_000 + index,
      })
    }
    const page = log.list({ limit: 2, offset: 0 })
    assert.equal(page.total, 5)
    assert.deepEqual(page.entries.map((entry) => entry.ts), [1_004, 1_003], '新的在前')

    const second = log.list({ limit: 2, offset: 2 })
    assert.deepEqual(second.entries.map((entry) => entry.ts), [1_002, 1_001])

    log.clear()
    assert.equal(log.list().total, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RequestLog：重启后从磁盘恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-req2-'))
  try {
    const path = join(dir, 'requests.jsonl')
    const first = new RequestLog(path)
    first.record({
      agentId: 'workbuddy',
      agentName: 'WorkBuddy',
      model: 'claude-sonnet-4.5',
      accountId: 'workbuddy:a',
      ok: false,
      durationMs: 120_000,
      error: 'no first byte',
    })
    const second = new RequestLog(path)
    const page = second.list()
    assert.equal(page.total, 1)
    assert.equal(page.entries[0].model, 'claude-sonnet-4.5')
    assert.equal(page.entries[0].ok, false)
    assert.equal(page.entries[0].error, 'no first byte')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RequestLog：`errorKind` 必须穿过 record → list → 落盘 → 重启（不能只在内存里活）', () => {
  // 为什么单独钉这一条：`errorKind` 是 2026-10-27 新加的字段，界面的「鉴权失效 /
  // 触发限流 / 触发风控」三种徽标全靠它。它要穿过四道手：
  //   `record()` 拼对象 → `JsonlLog.append` 序列化 → 重启后 `load()` 读回 → `redactDeep`
  // 任何一道把它丢了，界面就退回笼统的「失败」—— 而这**不会报错**，只会静默降级。
  // 单测 `adapter.ts` 只能证明「写进了采样」，证明不了「读得回来」。
  const dir = mkdtempSync(join(tmpdir(), 'mag-req-ek-'))
  try {
    const path = join(dir, 'requests.jsonl')
    const first = new RequestLog(path)
    first.record({
      agentId: 'qoder',
      agentName: 'Qoder',
      model: 'dfmodel',
      accountId: 'qoder:a1',
      ok: false,
      durationMs: 900,
      errorKind: 'risk_control',
      error: '命中风控',
    })

    // ① 同一进程内 list 读得到
    assert.equal(first.list().entries[0].errorKind, 'risk_control')

    // ② 重启（新实例从磁盘 load）之后仍然读得到
    const second = new RequestLog(path)
    const entry = second.list().entries[0]
    assert.equal(entry.errorKind, 'risk_control', '重启后丢了 —— 界面会退回「失败」两个字')
    assert.equal(entry.accountId, 'qoder:a1', '账号也要一起活下来（同一个字段组的另一半）')

    // ③ 穿过 `redactDeep`（Remote 回浏览器前必过这一道）还在。
    //    ⚠️ 字段名里没有 token/secret/... 所以不该被脱敏掉；但这条要钉住，
    //    否则哪天有人把脱敏规则改宽，`errorKind` 会变成 `***`，界面认不出来。
    const redacted = redactDeep([entry])
    assert.equal(redacted[0].errorKind, 'risk_control')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RequestLog：错误原文不再被 300 字截断（issue #1 的附带问题）', () => {
  // 适配器已经把上游错误压成一行（`describeBuddyErrorBody()`），完整长度约 330 字；
  // 旧的 `slice(0, 300)` 正好切在 `displayTips.en` 中间，把结尾的 `requestId=` 切掉 ——
  // 用户从「日志」页复制出来的原文因此是残缺的，报障时少一半线索。
  const dir = mkdtempSync(join(tmpdir(), 'mag-req-err-'))
  try {
    const path = join(dir, 'requests.jsonl')
    const requestId = '（requestId=aaaaaaaa-0000-4000-8000-000000000000）'
    const message = `11-128 · Illegal API invocation from an unapproved channel｜${'这次调用没通过渠道校验，可能不是官方客户端发出的。'.repeat(12)}${requestId}`
    assert.ok(message.length > 300, `样例要长过旧上限，实际 ${message.length}`)

    const first = new RequestLog(path)
    first.record({
      agentId: 'workbuddy',
      agentName: 'WorkBuddy',
      model: 'hy4-preview',
      accountId: 'workbuddy:a1',
      ok: false,
      durationMs: 446,
      errorKind: 'risk_control',
      error: message,
    })

    assert.equal(first.list().entries[0].error, message, '内存里就被截断了')
    const entry = new RequestLog(path).list().entries[0]
    assert.equal(entry.error, message, '落盘 / 重启这一路也要完整')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RequestLog：成功记录不写 `errorKind`，读回来也不该凭空多出来', () => {
  // 「不知道就不写」是这个仓库的既有约定（倍率那组用例同款）。这里钉的是
  // 反方向：`record()` 里 `...input` 展开不该给缺失的键补一个 undefined 值，
  // 否则界面的 `FAILURE_TEXT[undefined]` 会拿到 undefined 而不是走 `?? '失败'`。
  const dir = mkdtempSync(join(tmpdir(), 'mag-req-ek2-'))
  try {
    const path = join(dir, 'requests.jsonl')
    new RequestLog(path).record({
      agentId: 'opencode',
      agentName: 'OpenCode',
      model: 'free-a',
      accountId: null,
      ok: true,
      durationMs: 100,
    })
    const entry = new RequestLog(path).list().entries[0]
    assert.equal(Object.hasOwn(entry, 'errorKind'), false, '成功记录不该带 errorKind')
    assert.equal(entry.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RequestLog.summary：按模型/平台汇总，均值各算各的', () => {  const dir = mkdtempSync(join(tmpdir(), 'mag-req3-'))
  try {
    const log = new RequestLog(join(dir, 'requests.jsonl'))
    const now = Date.now()
    log.record({ agentId: 'opencode', agentName: 'OpenCode', model: 'a', accountId: null, ok: true, durationMs: 2000, ttftMs: 400, tps: 40, inputTokens: 100, outputTokens: 20, ts: now })
    log.record({ agentId: 'opencode', agentName: 'OpenCode', model: 'a', accountId: null, ok: true, durationMs: 3000, ttftMs: 600, tps: 60, inputTokens: 200, outputTokens: 30, ts: now })
    log.record({ agentId: 'workbuddy', agentName: 'WorkBuddy', model: 'b', accountId: 'x', ok: false, durationMs: 500, error: 'boom', ts: now })
    // 一条「昨天」的记录：不该进 today
    log.record({ agentId: 'opencode', agentName: 'OpenCode', model: 'a', accountId: null, ok: true, durationMs: 1000, ts: now - 86_400_000 * 2 })

    const summary = log.summary(now)
    assert.equal(summary.total, 4)
    assert.equal(summary.today, 3)
    assert.equal(summary.ok, 3)
    assert.equal(summary.failed, 1)
    assert.equal(summary.inputTokens, 300)
    assert.equal(summary.outputTokens, 50)
    assert.equal(summary.avgTtftMs, 500)
    assert.equal(summary.avgTps, 50)

    const modelA = summary.byModel.find((row) => row.model === 'a')
    assert.equal(modelA.calls, 3)
    assert.equal(modelA.ttftMs, 500)
    assert.equal(modelA.tps, 50)

    const agentRow = summary.byAgent.find((row) => row.agentId === 'workbuddy')
    assert.equal(agentRow.calls, 1)
    assert.equal(agentRow.failed, 1)

    // 最近一回合 = 最后记的那条（昨天那条）
    assert.equal(summary.last.model, 'a')
    assert.equal(summary.last.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────── WorkBuddy 适配器 ───────────────────────────

test('parseModelsFromConfig：合并 agent 引用 / data.models / 试用横幅', () => {
  const body = {
    data: {
      agents: [{ name: 'craft', models: ['hy3', 'auto', 'nes-completion'] }],
      models: [
        { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, supportsImages: true },
        { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, supportsImages: true },
        { id: 'completion-x' },
      ],
      productFeaturesConfig: { ModelTrialBanner: { banners: [{ targetModelId: 'hy4-preview' }] } },
    },
  }
  const list = parseModelsFromConfig(body)
  const ids = list.map((item) => item.id)
  assert.ok(!ids.includes('auto'))
  assert.ok(!ids.includes('nes-completion'))
  assert.ok(!ids.includes('completion-x'))
  assert.deepEqual(ids, ['hy3', 'glm-5.3', 'hy4-preview'])
  const hy3 = list.find((item) => item.id === 'hy3')
  assert.equal(hy3.name, 'Hy3')
  assert.equal(hy3.contextWindow, 192000)
  assert.deepEqual(hy3.inputModalities, ['text', 'image'])
  const trial = list.find((item) => item.id === 'hy4-preview')
  assert.equal(trial.name, 'hy4-preview')
  assert.equal(trial.contextWindow, undefined)
})

test('parseModelsFromConfig：结构不对就返回空数组（调用方回退内置表）', () => {
  assert.deepEqual(parseModelsFromConfig(null), [])
  assert.deepEqual(parseModelsFromConfig({}), [])
  assert.deepEqual(parseModelsFromConfig({ data: null }), [])
})

test('userAgentFor：国际版按模型族分档，国内版不分档', () => {
  assert.equal(userAgentFor(BUDDY_INTL, 'gpt-5'), 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
  assert.equal(userAgentFor(BUDDY_INTL, 'claude-sonnet-4.5'), 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')
  assert.equal(userAgentFor(BUDDY_INTL, 'glm-5.3'), 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
  assert.equal(userAgentFor(BUDDY_INTL, 'kimi-k3-1'), 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2')
  assert.equal(userAgentFor(BUDDY_CN, 'gpt-5'), 'CodeBuddyIDE/1.106.1')
})

test('buddyHeaders：五个身份头 + Bearer 一个都不能少', () => {
  const headers = buddyHeaders(BUDDY_INTL, 'tok123', 'gpt-5')
  assert.equal(headers.authorization, 'Bearer tok123')
  assert.equal(headers['x-domain'], 'www.workbuddy.ai')
  assert.equal(headers['x-product-code'], 'workbuddy')
  assert.equal(headers['x-product'], 'WorkBuddy')
  assert.equal(headers['x-agent-purpose'], 'conversation')
  assert.equal(headers['x-ide-name'], 'WorkBuddy')
  assert.equal(headers['x-ide-type'], 'WorkBuddy')
  assert.equal(headers['x-ide-version'], '5.5.2')
  assert.equal(headers['user-agent'], 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2')

  const cn = buddyHeaders(BUDDY_CN, 't', 'hy3')
  assert.equal(cn['x-domain'], 'copilot.tencent.com')
  assert.equal(cn['x-product-code'], 'codebuddy')
  assert.equal(cn['x-product'], 'CodeBuddy')
})

test('内置适配器：七个平台全部已真实现（不再有骨架）', async () => {
  const { builtinAdapters } = await import('../lib/adapters/index.js')
  const adapters = builtinAdapters()
  const byId = new Map(adapters.map((item) => [item.id, item]))
  // 2026-10-19 Trae 升级、2026-10-27 加入商汤小浣熊后，七个平台全部 implemented。
  for (const id of ['opencode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-intl', 'raccoon']) {
    assert.equal(byId.get(id)?.implemented, true, `${id} 应当已实现`)
    assert.equal(byId.get(id)?.capabilities.chat, true, `${id} 应当声明支持对话`)
  }
  assert.deepEqual(
    adapters.map((item) => item.id),
    ['opencode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-intl', 'raccoon'],
  )
  // 骨架工厂仍然存在（新增平台时的起点），只是当前没有平台停在骨架状态。
  assert.deepEqual([...SKELETON_IDS], ['qoder', 'qoder-cn', 'workbuddy', 'workbuddy-intl'])
})

// ─────────────────────────── 版本更新（真实 git 仓库） ───────────────────────────

/** 在临时目录里跑 git（测试自用）。 */
function gitRun(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true })
}

test('compareVersions / semverParts：数值段比较，预发布标记不影响', () => {
  assert.deepEqual(semverParts('v1.2.3'), [1, 2, 3])
  assert.deepEqual(semverParts('1.2.3-beta.1'), [1, 2, 3])
  assert.ok(compareVersions('1.2.3', '1.2.2') > 0)
  assert.ok(compareVersions('1.2.3', '1.10.0') < 0)
  assert.equal(compareVersions('1.2.3', 'v1.2.3'), 0)
  assert.equal(compareVersions('1.2.3', '1.2.3-beta'), 0)
  assert.ok(compareVersions('2.0', '1.9.9') > 0)
})

test('checkUpdate：不是 git 检出时明确说不支持，而不是假装能更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-nogit-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8')
    const status = await checkUpdate(dir)
    assert.equal(status.supported, false)
    assert.equal(status.current, '0.1.0')
    assert.ok(typeof status.error === 'string' && status.error.length > 0)
    assert.ok(describeUpdate(status).length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkUpdate + applyUpdate：落后提交数与版本号都对，快进后版本更新', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mag-upd-'))
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  const work = join(base, 'work')
  try {
    // 造一个本地「远端」仓库 + 两个克隆
    mkdirSync(remote, { recursive: true })
    gitRun(remote, ['init', '--bare', '-b', 'main'])
    mkdirSync(seed, { recursive: true })
    gitRun(seed, ['init', '-b', 'main'])
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }), 'utf8')
    gitRun(seed, ['add', '-A'])
    gitRun(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v0.1.0'])
    gitRun(seed, ['remote', 'add', 'origin', remote])
    gitRun(seed, ['push', 'origin', 'main'])
    gitRun(base, ['clone', remote, work])

    // 刚克隆：没有落后
    const fresh = await checkUpdate(work)
    assert.equal(fresh.supported, true)
    assert.equal(fresh.behind, 0)
    assert.equal(fresh.current, '0.1.0')
    assert.equal(fresh.latest, '0.1.0')

    // 远端发一个新版本
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'x', version: '0.2.0' }), 'utf8')
    gitRun(seed, ['add', '-A'])
    gitRun(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v0.2.0'])
    gitRun(seed, ['push', 'origin', 'main'])

    const behind = await checkUpdate(work)
    assert.equal(behind.behind, 1, '应当落后 1 个提交')
    assert.equal(behind.latest, '0.2.0', '远端版本号要读出来')
    assert.equal(behind.current, '0.1.0', '本地版本号不动')
    assert.ok(describeUpdate(behind).includes('0.2.0'))

    // 一键更新
    const result = await applyUpdate(work)
    assert.equal(result.ok, true, result.error ?? '')
    assert.equal(result.from, '0.1.0')
    assert.equal(result.to, '0.2.0')
    assert.equal(readVersion(work), '0.2.0')

    // 更新后再查：已经是最新
    const after = await checkUpdate(work)
    assert.equal(after.behind, 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('applyUpdate：本地有未提交改动时拒绝快进，不覆盖用户的东西', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mag-upd2-'))
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  const work = join(base, 'work')
  try {
    mkdirSync(remote, { recursive: true })
    gitRun(remote, ['init', '--bare', '-b', 'main'])
    mkdirSync(seed, { recursive: true })
    gitRun(seed, ['init', '-b', 'main'])
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }), 'utf8')
    gitRun(seed, ['add', '-A'])
    gitRun(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v0.1.0'])
    gitRun(seed, ['remote', 'add', 'origin', remote])
    gitRun(seed, ['push', 'origin', 'main'])
    gitRun(base, ['clone', remote, work])

    // 远端前进
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'x', version: '0.2.0' }), 'utf8')
    gitRun(seed, ['add', '-A'])
    gitRun(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v0.2.0'])
    gitRun(seed, ['push', 'origin', 'main'])

    // 本地改一个文件（未提交）
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0-local' }), 'utf8')

    const result = await applyUpdate(work)
    assert.equal(result.ok, false, '有本地改动时必须拒绝')
    assert.equal(readVersion(work), '0.1.0-local', '用户的改动不能被覆盖')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

// ─────────────────────────── Qoder（WASM 签名） ───────────────────────────

test('Qoder：WASM 桥能签出合法请求（Bearer COSY.*）', async () => {
  const { QoderEncryptedInfer } = await import('../lib/vendor/qoder/qoder-wasm.js')
  const { QODER } = await import('../lib/vendor/qoder/qoder-product.js')
  const client = await QoderEncryptedInfer.create({
    user: { uid: 'u_test_123', securityOauthToken: 'tok_test' },
    machineId: '11111111-2222-3333-4444-555555555555',
    metadata: QODER.clientMetadata,
    host: QODER.encryptedInferBase,
  })
  const prepared = client.prepareInfer({ modelKey: 'qfmodel', userText: 'ping' })

  // 加密端点，而不是公开的 api2-v2（混用会 404）
  assert.match(prepared.url, /agent_chat_generation/)
  assert.ok(prepared.url.startsWith(QODER.encryptedInferBase), '必须打到加密端点')
  assert.ok(prepared.body.length > 0, '请求体必须由 WASM 加密产出')

  // 签名格式：普通 Bearer 会 403 Signature invalid
  const auth = prepared.headers.Authorization ?? prepared.headers.authorization ?? ''
  assert.match(auth, /^Bearer COSY\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/)

  // 机器头族（少一个上游就认不出客户端）
  const names = Object.keys(prepared.headers).map((name) => name.toLowerCase())
  for (const required of ['cosy-machineid', 'cosy-version', 'cosy-scene', 'x-model-key']) {
    assert.ok(names.includes(required), `缺少身份头 ${required}`)
  }
})

test('Qoder：uidFromToken 从 JWT 解出 user_id，解不出时返回空串', () => {
  const payload = Buffer.from(JSON.stringify({ user_id: 'u_abc', exp: 1 }), 'utf8').toString('base64url')
  assert.equal(uidFromToken(`h.${payload}.s`), 'u_abc')
  // 也认 uid / userId / sub
  const alt = Buffer.from(JSON.stringify({ sub: 'sub_1' }), 'utf8').toString('base64url')
  assert.equal(uidFromToken(`h.${alt}.s`), 'sub_1')
  // 不是 JWT / 载荷不是 JSON
  assert.equal(uidFromToken('plain-token'), '')
  assert.equal(uidFromToken('a.b.c'), '')
})

test('Qoder：缺 uid 的 token 在发请求前就被拒（否则上游只会回 403 签名无效）', async () => {
  const { QoderAdapter, QODER_CN } = await import('../lib/adapters/qoder.js')
  const adapter = new QoderAdapter(QODER_CN)
  assert.equal(adapter.id, 'qoder-cn')
  assert.equal(adapter.implemented, true)

  const record = { id: 'qoder-cn:a', agentId: 'qoder-cn', label: 'a', credentials: { token: 'plain-token' }, enabled: true, createdAt: 0, updatedAt: 0 }
  const verdict = await adapter.validateCredentials(record, {})
  assert.equal(verdict.ok, false)
  // ⚠️ 这条断言原本写的是 `auth`，2026-10-24 随真实报障一起改掉（**不是放宽，是纠正**）：
  // `kind` 会被 `src/llm/adapter.ts` 原样 `toUpperCase()` 成 DSH 的失败码，而 DSH 对
  // `AUTH` 有特殊处理 —— 它**丢掉我们写的 message**、固定显示本地化文案「API 密钥无效」，
  // 并且 `displayFailure()` 对 `AUTH` 显式返回 `message: ""`。于是「凭证缺 uid」被说成
  // 「密钥无效」，把用户引向完全错误的方向（Qoder 根本没有 API key）。
  // 改用 `bad_request`：语义是「本地请求上下文有问题，绝不能换号重试」
  // （`src/core/router.ts` 明确列为不换号的情形），且 DSH 对 `BAD_REQUEST` 无特殊处理，
  // 我们的 message 会原样显示。理由全文见 `src/adapters/qoder.ts` 的 QODER_MISSING_UID_KIND。
  assert.equal(verdict.kind, 'bad_request')
  // 话术要**可操作**：说「重新登录」，而不是只报「解不出 user_id」（用户无法自救）
  assert.ok(String(verdict.message).includes('重新登录'), `实际：${verdict.message}`)

  // ① 凭证里直接存了 uid（设备码登录的正常形态）→ 通过
  const withUid = { ...record, credentials: { token: 'dt-opaque-device-token', uid: 'u_stored' } }
  const storedVerdict = await adapter.validateCredentials(withUid, {})
  assert.equal(storedVerdict.ok, true, `存了 uid 就该通过，实际：${storedVerdict.message}`)

  // ② 没有存 uid 时，退回到从 JWT 里解（手工粘贴 JWT 的老路径）
  const payload = Buffer.from(JSON.stringify({ user_id: 'u_ok' }), 'utf8').toString('base64url')
  const okRecord = { ...record, credentials: { token: `h.${payload}.s` } }
  const okVerdict = await adapter.validateCredentials(okRecord, {})
  assert.equal(okVerdict.ok, true)
})

// ─────────────────────────── 登录流程（各平台） ───────────────────────────

/** 造一个假 ctx：fetch 由调用方给定。 */
function loginCtx(fetchImpl) {
  return {
    config: { id: 'x', name: 'X', upstream: { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '', freeTierMode: 'auto' }, credits: { unit: 'usd', baselineUsdPerMTok: 1.2 }, requestTimeoutMs: 30_000 },
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
    fetch: fetchImpl,
    cache: { get() { return undefined }, set() {}, delete() {} },
    now: () => Date.now(),
  }
}

test('WorkBuddy 登录：auth/state 带 4 个免鉴权头，token 未就绪(11217)算 pending', async () => {
  const calls = []
  const ctx = loginCtx(async (url, init) => {
    calls.push({ url: String(url), method: init?.method, headers: init?.headers ?? {} })
    if (String(url).includes('/v2/plugin/auth/state')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { state: 'st_1', authUrl: 'https://login.example/auth?x=1' } }) }
    }
    // 第一次 poll：token 未就绪
    if (calls.filter((c) => c.url.includes('/auth/token')).length === 1) {
      return { ok: false, status: 200, json: async () => ({ code: 11217, message: 'not ready' }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, domain: 'copilot.tencent.com' } }),
    }
  })
  const adapter = new BuddyAdapter(BUDDY_CN)
  const start = await adapter.beginLogin(ctx)
  assert.equal(start.authUrl, 'https://login.example/auth?x=1')
  assert.equal(start.expiresInSec, 300)

  const stateCall = calls[0]
  assert.ok(stateCall.url.includes('/v2/plugin/auth/state?platform=ide'), '平台参数要传给上游')
  for (const header of ['x-no-authorization', 'x-no-user-id', 'x-no-enterprise-id', 'x-no-department-info']) {
    assert.equal(stateCall.headers[header], 'true', `缺少免鉴权头 ${header}`)
  }
  assert.equal(stateCall.headers['x-domain'], 'copilot.tencent.com')

  // 第一次问：还没登录
  const pending = await adapter.pollLogin(start.state, ctx)
  assert.equal(pending.status, 'pending')

  // 第二次问：拿到 token
  const ready = await adapter.pollLogin(start.state, ctx)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.credentials.token, 'at_1')
  assert.equal(ready.credentials.refreshToken, 'rt_1')
  assert.ok(typeof ready.credentials.expiresAt === 'number')
})

test('Qoder 登录：beginLogin 给出带 PKCE 的授权链接，poll 空 data 算 pending', async () => {
  const seen = []
  const ctx = loginCtx(async (url) => {
    seen.push(String(url))
    if (seen.length === 1) return { ok: true, status: 200, json: async () => ({ data: {} }) }
    return { ok: true, status: 200, json: async () => ({ data: { token: 'qd_at', refresh_token: 'qd_rt' } }) }
  })
  const adapter = new QoderAdapter(QODER_CN)
  const start = await adapter.beginLogin(ctx)
  assert.ok(start.authUrl.startsWith(QODER_CN.authBase), '授权链接要落在产品的 authBase 上')
  assert.ok(start.authUrl.includes('challenge='), '必须带 PKCE challenge')
  assert.ok(start.authUrl.includes('challenge_method=S256'))
  assert.equal(start.expiresInSec, 300)

  const pending = await adapter.pollLogin(start.state, ctx)
  assert.equal(pending.status, 'pending')

  const ready = await adapter.pollLogin(start.state, ctx)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.credentials.token, 'qd_at')
  assert.ok(seen[0].startsWith(QODER_CN.openApiBase), '轮询要打 openApiBase')
})

test('Qoder 登录：设备码响应里的 user_id 必须存成 uid（否则对话报解不出 user_id）', async () => {
  // ⚠️ 回归点：Qoder 给的是 `dt-...` **不透明设备令牌**，不是 JWT。
  // 早期 pollLogin 只存 token / refreshToken，漏了 user_id ——
  // 于是 clientFor 拿 token 去当 JWT 解，永远解不出 uid，
  // 用户刚登录成功却被报「token 里解不出 user_id」。
  const ctx = loginCtx(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { token: 'dt-opaque-token', refresh_token: 'drt-x', user_id: '00000000-0000-4000-8000-000000000001', user_name: '张三' },
    }),
  }))
  const adapter = new QoderAdapter(QODER_CN)
  const start = await adapter.beginLogin(ctx)
  const ready = await adapter.pollLogin(start.state, ctx)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.credentials.uid, '00000000-0000-4000-8000-000000000001', '登录响应里的 user_id 要存成 uid')
  assert.equal(ready.credentials.token, 'dt-opaque-token')
  assert.equal(ready.label, '张三', 'user_name 用作账号标签')
})

test('Qoder uid 补齐：上游用量接口能给出 uid，且能在多个端点间兜底', async () => {
  const { findUserId } = await import('../lib/adapters/qoder.js')
  // 实测两种真实形状
  assert.equal(
    findUserId({ displayMode: 'qoder', qoderUsage: { userId: 'u-1', userType: 'personal_standard' } }),
    'u-1',
    '/sash/api/v2/me/usage 的形状：qoderUsage.userId',
  )
  assert.equal(findUserId({ uid: 'u-2', showCampaign: false }), 'u-2', '/sash/api/v1/me/campaigns 的形状：顶层 uid')
  assert.equal(findUserId({ data: { list: [{ user_id: 42 }] } }), '42', '数字 id 也要认')
  assert.equal(findUserId({ nothing: 'here' }), '', '找不到就返回空串，不许瞎猜')
  assert.equal(findUserId(null), '')
  // 同一层里有多个候选时按 userId → user_id → uid 的顺序取；
  // 两个**真实**响应各自只有一种形状，所以这条只是保证行为确定，不是优先级承诺。
  assert.equal(findUserId({ uid: 'top', qoderUsage: { userId: 'nested' } }), 'top', '本层先命中就用本层的')
})

// ───────────────── 没登录就不列模型（Qoder / WorkBuddy） ─────────────────
//
// 报障原话：「还没登录账号就拉取到了模型，但是倍率是未知呢？太不友好了。」
// 目录是产品级的（内置在插件里），登录前也拿得到，但**一个都调不动** ——
// 提前列出来只会让人以为已经能用，还全是「未知倍率」。

const qoderRecord = (token) => ({
  id: 'acc-qoder-1',
  agentId: 'qoder-cn',
  label: '主号',
  credentials: token === undefined ? {} : { token },
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
})

test('Qoder：还没有账号时模型列表为空（不提前列目录）', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  // 这条路径在碰 ctx 之前就返回了，传空对象即可
  assert.deepEqual(await adapter.getModelMetaList(qoderRecord(undefined), {}), [])
})

test('Qoder：倍率按错峰窗口推算；「免费」只认 price_factor=0', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  const list = await adapter.getModelMetaList(qoderRecord('dt-fake-token'), {})
  assert.ok(list.length > 5, '兜底目录应当有多个模型')
  const byId = new Map(list.map((meta) => [meta.id, meta]))
  // ⚠️ 「无促销的模型直接用目录价」这条覆盖意图，**不能**再拿 `auto` 当样本 ——
  // `auto` 是 Qoder 的智能路由**档位**（不是厂商模型），2026-10-20 起已不上报
  // （见 `QODER_NON_VENDOR_MODEL_IDS`）。改用厂商模型 `mmodel`（MiniMax-M3，
  // 目录价 0.2、无 promotion），覆盖意图完全不变。
  assert.equal(byId.get('mmodel')?.multiplier, 0.2, 'mmodel 的目录倍率是 0.2')
  assert.equal(byId.get('mmodel')?.multiplierSource, 'qoder:catalog')
  // qfmodel 的 price_factor 是 0（合法值）→ 真免费
  assert.equal(byId.get('qfmodel')?.multiplier, 0)
  assert.equal(byId.get('qfmodel')?.free, true)
  // ⚠️ 回归点 1：Qwen3.8-Max 是 `is_free: true` —— 「免费额度模型」照样扣积分，
  // **不能**标「免费」（真机报障过）。
  assert.notEqual(byId.get('qmodel_38max')?.free, true, 'is_free 不等于免费')
  // ⚠️ 回归点 2：它的倍率是**随窗口变的**，不能直接用目录里存的折后价 0.2。
  // 目录存 0.2 = 22:00–08:00 窗口内的价；窗口外（白天）应为原价 0.5。
  assert.ok(
    [0.2, 0.5].includes(byId.get('qmodel_38max')?.multiplier),
    `Qwen3.8-Max 的倍率只可能是窗口内 0.2 或窗口外 0.5，实际 ${byId.get('qmodel_38max')?.multiplier}`,
  )
  // 每一条都得有倍率，界面不该再出现「未知倍率」
  for (const meta of list) {
    assert.equal(typeof meta.multiplier, 'number', `${meta.id} 缺倍率`)
  }
  // 除 qfmodel 外不该再有别的模型被标免费
  const freebies = list.filter((meta) => meta.free === true).map((meta) => meta.id)
  assert.deepEqual(freebies, ['qfmodel'], `只有 price_factor=0 的才算免费，实际：${freebies.join(',')}`)
})

test('Qoder 错峰窗口：窗口内折后价、窗口外原价（按 UTC+8 本地推算）', async () => {
  const { effectiveMultiplier, promotionActiveNow, isPromotionActive } = await import('../lib/adapters/qoder.js')
  // 目录里存的 priceFactor 0.2 是**采集时刻**的折后价；原价在 promotion 里
  const qwenMax = {
    id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000,
    isFree: true, priceFactor: 0.2,
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00' },
  }
  // UTC+8 22:30 → 窗口内
  const inWindow = new Date(Date.UTC(2026, 9, 19, 14, 30))
  // UTC+8 10:00 → 窗口外
  const outWindow = new Date(Date.UTC(2026, 9, 19, 2, 0))

  assert.equal(promotionActiveNow(qwenMax.promotion, inWindow), true, '22:30 应在窗口内')
  assert.equal(promotionActiveNow(qwenMax.promotion, outWindow), false, '10:00 应在窗口外')
  assert.equal(effectiveMultiplier(qwenMax, inWindow), 0.2, '窗口内 = 原价 × 折扣 = 0.5 × 0.4')
  assert.equal(effectiveMultiplier(qwenMax, outWindow), 0.5, '窗口外 = 原价 0.5（用户确认过的正确值）')
  assert.equal(isPromotionActive(qwenMax, inWindow), true)
  assert.equal(isPromotionActive(qwenMax, outWindow), false)

  // 跨零点窗口：02:00 在窗口内，12:00 不在
  assert.equal(promotionActiveNow(qwenMax.promotion, new Date(Date.UTC(2026, 9, 18, 18, 0))), true, '02:00 跨零点窗口内')
  assert.equal(promotionActiveNow(qwenMax.promotion, new Date(Date.UTC(2026, 9, 19, 4, 0))), false, '12:00 窗口外')

  // 没有 promotion 的模型直接用目录价，不受窗口影响
  const plain = { id: 'auto', name: 'Auto', contextWindow: 200_000, priceFactor: 0.5 }
  assert.equal(effectiveMultiplier(plain, inWindow), 0.5)
  assert.equal(effectiveMultiplier(plain, outWindow), 0.5)
  assert.equal(isPromotionActive(plain, inWindow), false)
})

test('Qoder uid：优先用凭证里存的（设备令牌不是 JWT，解不出来）', async () => {
  const adapter = new QoderAdapter(QODER_CN)
  // 真实形态：设备码登录给的是 `dt-...` 不透明令牌，JWT 解析必然失败
  const deviceToken = 'dt-EXAMPLE-NOT-A-REAL-TOKEN'
  const withoutUid = { ...qoderRecord(deviceToken) }
  const invalid = await adapter.validateCredentials(withoutUid, {})
  assert.equal(invalid.ok, false, '没有 uid 时不能假装可用')
  // ⚠️ 报错要说「重新登录」，不能只说「解不出 user_id」（用户无法自救）
  assert.match(invalid.message, /重新登录/, `实际：${invalid.message}`)

  // 存了 uid（登录响应里的 user_id）→ 校验通过
  const withUid = { ...qoderRecord(deviceToken), credentials: { token: deviceToken, uid: '12345678901234567' } }
  const valid = await adapter.validateCredentials(withUid, {})
  assert.equal(valid.ok, true, `存了 uid 就该通过，实际：${valid.message}`)
  assert.match(valid.message, /12345678901234567/, '报错/提示里要能看出用的是哪个 uid')
})

test('WorkBuddy：没有 token 时不列模型（登录前一个都调不动）', async () => {
  const adapter = new BuddyAdapter(BUDDY_CN)
  assert.deepEqual(await adapter.getModelMetaList(qoderRecord(undefined), {}), [])
})

// ═══════════════ 检查更新：available / message（用户报障「永远显示已是最新」）═══════════════
//
// 现场：用户推了两个提交，界面仍显示「已是最新」。根因**不是**落后多少的问题：
// 宿主 `UpdateStatus` 从来没下发过 `available`，而客户端读的是 `d.available === true`
// ⇒ `undefined === true` 恒 false ⇒ 徽标永远画「已是最新」。这个功能从来没生效过。
//
// 下面钉住两件事：
//   ① `available` 的判据是 **`behind > 0`**，不掺版本号比较
//      （本项目三个提交的 version 都是 0.1.0，比版本号就等于永远「已是最新」）；
//   ② `message` 一律走 `describeUpdate()`，且**失败绝不能报成「已是最新」**
//      —— 本机 Clash 没开时就是那条路径。

/** 造一个「本地 clone + 可推送的裸远端」fixture（与上面那条 applyUpdate 用例同款）。 */
function updateFixture(prefix) {
  const base = mkdtempSync(join(tmpdir(), prefix))
  const remote = join(base, 'remote.git')
  const seed = join(base, 'seed')
  const work = join(base, 'work')
  mkdirSync(remote, { recursive: true })
  gitRun(remote, ['init', '--bare', '-b', 'main'])
  mkdirSync(seed, { recursive: true })
  gitRun(seed, ['init', '-b', 'main'])
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }), 'utf8')
  gitRun(seed, ['add', '-A'])
  gitRun(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'v0.1.0'])
  gitRun(seed, ['remote', 'add', 'origin', remote])
  gitRun(seed, ['push', 'origin', 'main'])
  gitRun(base, ['clone', remote, work])
  return { base, remote, seed, work }
}

/** 往远端推一个**不改版本号**的提交（复刻本项目的真实形态）。 */
function pushCommit(repo, message) {
  writeFileSync(join(repo.seed, `${message}.txt`), 'x', 'utf8')
  gitRun(repo.seed, ['add', '-A'])
  gitRun(repo.seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', message])
  gitRun(repo.seed, ['push', 'origin', 'main'])
}

test('updateStatus：behind>0 → available=true，message 说「有新版本」', async () => {
  const f = updateFixture('mag-ufld1-')
  try {
    pushCommit(f, 'ahead')
    const status = await checkUpdate(f.work)
    assert.equal(status.behind, 1)
    assert.equal(status.available, true, '★ 落后提交时必须报可更新（改前这个字段压根不存在）')
    assert.match(status.message, /有新版本/, `message 应说明有新版本，实际：${status.message}`)
    // 形状契约：这两个字段必须真的在（客户端按 `=== true` 读，undefined 会让它恒 false）
    assert.ok(Object.hasOwn(status, 'available'), 'available 必须存在，不能是 undefined')
    assert.ok(Object.hasOwn(status, 'message'), 'message 必须存在')
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('updateStatus：behind=0 → available=false，message 说「已是最新」', async () => {
  const f = updateFixture('mag-ufld2-')
  try {
    const status = await checkUpdate(f.work)
    assert.equal(status.behind, 0)
    assert.equal(status.available, false)
    assert.match(status.message, /已是最新/, `实际：${status.message}`)
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('★ updateStatus：版本号相等但 behind>0 → available 仍然 true（判据不是版本号）', async () => {
  const f = updateFixture('mag-ufld3-')
  try {
    // 远端过来 2 个提交，**一个都不改 version** —— 这正是本项目的现状
    // （72e4b28 / 64ca9a9 / ee5f417 的 package.json 全是 0.1.0，也没有 tag）。
    pushCommit(f, 'one')
    pushCommit(f, 'two')

    const status = await checkUpdate(f.work)
    assert.equal(status.behind, 2)
    assert.equal(status.current, '0.1.0')
    assert.equal(status.latest, '0.1.0')
    // 版本号 == 版本号，compareVersions 会回 0 —— 拿它当判据就会误判「已是最新」。
    assert.equal(compareVersions(status.current, status.latest), 0, '前提：两个版本号确实相等')
    assert.equal(status.available, true, '★ 版本号相等但落后提交时，必须仍然报可更新')
    assert.ok(!/已是最新/.test(status.message), `不能报成已是最新，实际：${status.message}`)
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('★ updateStatus：fetch 失败 → 不能报成「已是最新」，要把原因说出来', async () => {
  const f = updateFixture('mag-ufld4-')
  try {
    // 把 origin 指到一个不存在的路径 = 远端不可达。
    // 本机 Clash 没开时用户遇到的就是这条路径。
    gitRun(f.work, ['remote', 'set-url', 'origin', join(tmpdir(), 'mag-definitely-not-here.git')])

    const status = await checkUpdate(f.work)
    // 「能更新，但这次查不动」——不该把功能整个藏掉
    assert.equal(status.supported, true, '仍是 git 检出，supported 应保持 true')
    assert.equal(status.available, false, '没查到就不能说有更新')
    // ★ 核心：false 不能等同于「最新」。原因必须留在 message 里（改前它被静默丢弃）。
    assert.match(status.message, /拉取远端失败/, `必须说清是拉取失败，实际：${status.message}`)
    assert.ok(!/已是最新/.test(status.message), '★ 绝不能把「没查到」谎报成「已是最新」')
    assert.equal(typeof status.error, 'string')
    assert.equal(status.message, status.error, 'message 走 describeUpdate，有 error 时就是 error 原文')
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('★ updateStatus：rev-list 拿不到 behind → 不能报「已是最新」', async () => {
  const f = updateFixture('mag-ufld5-')
  try {
    pushCommit(f, 'ahead')
    // 删掉 remote-tracking 引用 + 改掉 fetch refspec：
    // fetch 仍成功，HEAD 也正常，但 `HEAD..origin/main` 解析不了 ⇒ rev-list 失败。
    // 这复刻了「behind 拿不到」这条分支（改前它被 `catch { behind = 0 }` 静默吞掉，
    // 于是 behind=0 ⇒ 文案变成「已是最新」—— 把没查出来谎报成确认最新）。
    gitRun(f.work, ['update-ref', '-d', 'refs/remotes/origin/main'])
    gitRun(f.work, ['config', 'remote.origin.fetch', '+refs/heads/nonexistent:refs/remotes/origin/nonexistent'])

    const status = await checkUpdate(f.work)
    assert.equal(status.supported, true)
    assert.equal(status.behind, 0, '拿不到就是拿不到，保守留在 0')
    assert.equal(status.available, false, '拿不到 behind 时保守 false')
    // ★ 但**必须**说明「无法判断」，不能默认成最新
    assert.match(status.message, /无法判断落后多少/, `实际：${status.message}`)
    assert.ok(!/已是最新/.test(status.message), '★ 绝不能把「没查出来」谎报成「已是最新」')
    assert.equal(typeof status.error, 'string', 'error 也要留着，供客户端显示原因')
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

test('updateStatus：非 git 检出时 available=false 且 message 给出可行动的原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-ufld6-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }), 'utf8')
    const status = await checkUpdate(dir)
    assert.equal(status.supported, false)
    assert.equal(status.available, false)
    assert.match(status.message, /不是 git 检出/, `实际：${status.message}`)
    assert.ok(!/已是最新/.test(status.message), '不支持自我更新 ≠ 已是最新')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateStatus：available 与 message 文案口径一致（三种结论互斥）', async () => {
  // 这条防的是「字段之间自相矛盾」：available=true 却说「已是最新」，
  // 或 available=false 却说「有新版本」—— 客户端两个地方都会显示，自相矛盾很难查。
  const f = updateFixture('mag-ufld7-')
  try {
    pushCommit(f, 'ahead')
    const behind = await checkUpdate(f.work)
    assert.equal(behind.behind > 0, behind.available, 'available 必须恒等于 behind > 0')

    const fresh = updateFixture('mag-ufld7b-')
    try {
      const status = await checkUpdate(fresh.work)
      assert.equal(status.behind > 0, status.available, 'available 必须恒等于 behind > 0')
      assert.equal(describeUpdate(status), status.message, 'message 必须是 describeUpdate 的结果')
    } finally {
      rmSync(fresh.base, { recursive: true, force: true })
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true })
  }
})

// ═══════════ 代理连不上：可操作文案 + 回环代理才重试直连（task-20）═══════════
//
// 现场（用户实机）：上一步修好「如实报失败」后，他看到的是 git 的 fatal 原文：
//   `拉取远端失败：fatal: unable to access '…': Failed to connect to github.com:443
//    over proxy 127.0.0.1 after 2053 ms: Could not connect to server`
// 真实原因是仓库 .git/config 里钉了 http.proxy=http://127.0.0.1:7897 而 Clash 没开。
// 这段是真话但**不可操作** —— 用户看完不知道该干什么。
//
// 下面用**真实抓到的 git stderr 原文**当 fixture（本机 2026-10-24 实测，
// 见 probe-git-shapes 的对照表），而不是自己编字符串 —— 编的字符串
// 容易刚好符合我自己的识别逻辑，那样测的是「我以为的 git」而不是「真的 git」。

/**
 * 真实 stderr 样本（一字未改，来自本机实测）。
 *
 * ⚠️ 尤其注意 `DIRECT_DOWN`：**强制直连失败时没有 `over proxy`**，
 * 只有 `Could not connect to server`。这是「不能用弱特征单独判定代理问题」的实证。
 */
const REAL_GIT_STDERR = {
  /** 代理挂着但代理没开（用 127.0.0.1:9 模拟 Clash 挂掉）——有 `over proxy`。 */
  LOOPBACK_PROXY_DOWN:
    "fatal: unable to access 'https://github.com/a1141171521/dsh-multi-agent-gateway.git/': Failed to connect to github.com:443 over proxy 127.0.0.1 after 2022 ms: Could not connect to server",
  /** 同上，用 localhost 写法。 */
  LOCALHOST_PROXY_DOWN:
    "fatal: unable to access 'https://github.com/a1141171521/dsh-multi-agent-gateway.git/': Failed to connect to github.com:443 over proxy localhost after 2226 ms: Could not connect to server",
  /** ★ 强制直连也连不上 —— **没有** `over proxy`（实测 21 秒）。 */
  DIRECT_DOWN:
    "fatal: unable to access 'https://github.com/nonexistent-org-xyz/nonexistent-repo-xyz.git/': Failed to connect to github.com:443 after 21039 ms: Could not connect to server",
  /** DNS 解析失败（非连接类）。 */
  DNS_FAIL:
    "fatal: unable to access 'https://this-host-definitely-does-not-exist-xyz123.invalid/repo.git/': Could not resolve host: this-host-definitely-does-not-exist-xyz123.invalid",
  /** 超时被杀：stderr 为空，只剩我们自己的命令行。 */
  TIMEOUT_KILLED: 'Command failed: git -c http.proxy= -c https.proxy= fetch --quiet origin main',
}

test('代理识别：真实 stderr → 判为代理不可达，文案可操作且不含裸 fatal', async () => {
  const { classifyFetchFailure, describeFetchFailure } = await import('../lib/core/updater.js')

  const info = classifyFetchFailure(REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN, 'http://127.0.0.1:7897')
  assert.equal(info.kind, 'proxy-unreachable', '有 over proxy ⇒ 应当**确凿**判为代理问题')
  assert.equal(info.loopback, true)
  assert.equal(info.retryDirect, true, '回环代理 ⇒ 允许试直连')

  const message = describeFetchFailure({
    info,
    proxyDetail: REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN,
    timedOut: false,
    timeoutMs: 30_000,
  })
  assert.match(message, /代理/, `文案要提到代理，实际：${message}`)
  assert.match(message, /127\.0\.0\.1:7897/, `文案要含**现取**的代理地址，实际：${message}`)
  // ★ 核心：不能再把 git 的 fatal 原文原样丢给用户（那是「不可操作」的病根）
  assert.ok(!/fatal: unable to access/.test(message), `不该出现裸 fatal 原文：${message}`)
  // 要给出可行动的下一步
  assert.match(message, /检查更新|重试/, `要告诉用户下一步做什么，实际：${message}`)
})

test('代理识别：代理地址缺失时退化成通用文案（不写死地址）', async () => {
  const { classifyFetchFailure, describeFetchFailure } = await import('../lib/core/updater.js')
  const info = classifyFetchFailure(REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN, null)
  const message = describeFetchFailure({
    info,
    proxyDetail: REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN,
    timedOut: false,
    timeoutMs: 30_000,
  })
  assert.match(message, /代理/, `实际：${message}`)
  // 取不到配置就不该编一个地址出来
  assert.ok(!/\d+\.\d+\.\d+\.\d+:\d+/.test(message), `没有配置时不该出现具体地址：${message}`)
})

test('★ 非代理类失败（DNS）不被误判成代理问题，保留原文', async () => {
  const { classifyFetchFailure, describeFetchFailure } = await import('../lib/core/updater.js')
  const info = classifyFetchFailure(REAL_GIT_STDERR.DNS_FAIL, 'http://127.0.0.1:7897')
  assert.equal(info.kind, 'unknown', 'DNS 失败不是代理问题')
  assert.equal(info.retryDirect, false, '认不出来就不该动网络路径')

  const message = describeFetchFailure({
    info,
    proxyDetail: REAL_GIT_STDERR.DNS_FAIL,
    timedOut: false,
    timeoutMs: 30_000,
  })
  assert.match(message, /Could not resolve host/, `认不出来就保留原文，实际：${message}`)
  assert.ok(!/Clash/.test(message), `别把未知失败说成「代理没开」：${message}`)
})

test('★ 直连失败（无 over proxy）不被误判成「代理没开」', async () => {
  const { classifyFetchFailure } = await import('../lib/core/updater.js')
  // 这条是实测逼出来的：`Could not connect to server` 在**直连失败**时也会出现，
  // 只看它就会把「网络不通」说成「代理没开」，用户去开代理白折腾。
  const noProxy = classifyFetchFailure(REAL_GIT_STDERR.DIRECT_DOWN, null)
  assert.equal(noProxy.kind, 'unknown', '没配代理 + 无 over proxy ⇒ 不能赖代理')
  assert.equal(noProxy.retryDirect, false)

  // 配了**非回环**代理时，最多只能说「存疑」，且**绝不重试**
  const withCorporate = classifyFetchFailure(REAL_GIT_STDERR.DIRECT_DOWN, 'http://192.0.2.1:8080')
  assert.notEqual(withCorporate.kind, 'proxy-unreachable', '没有 over proxy 就不该「确凿」')
  assert.equal(withCorporate.retryDirect, false, '★ 非回环代理绝不重试')
})

test('回环判定：127.0.0.1 / localhost / ::1 算回环，其它一律不算', async () => {
  const { isLoopbackProxy, proxyHostOf } = await import('../lib/core/updater.js')
  assert.equal(proxyHostOf('http://127.0.0.1:7897'), '127.0.0.1')
  assert.equal(proxyHostOf('localhost:7897'), 'localhost')
  assert.equal(proxyHostOf('http://[::1]:7897'), '::1')

  assert.equal(isLoopbackProxy('http://127.0.0.1:7897'), true)
  assert.equal(isLoopbackProxy('http://localhost:7897'), true)
  assert.equal(isLoopbackProxy('http://[::1]:7897'), true)
  // ★ 非回环：绝不重试（绕过用户/公司的网络策略）
  assert.equal(isLoopbackProxy('http://192.0.2.1:8080'), false)
  assert.equal(isLoopbackProxy('http://10.0.0.5:8080'), false)
  assert.equal(isLoopbackProxy('http://proxy.corp.example:8080'), false)
  assert.equal(isLoopbackProxy(''), false)
})

test('超时（stderr 为空）不把「我们自己的命令行」显示给用户', async () => {
  const { classifyFetchFailure, describeFetchFailure, isUninformativeDetail } =
    await import('../lib/core/updater.js')
  assert.equal(isUninformativeDetail(REAL_GIT_STDERR.TIMEOUT_KILLED), true,
    '`Command failed: git …` 是我们自己的命令行，对用户没有信息量')
  assert.equal(isUninformativeDetail(''), true)
  assert.equal(isUninformativeDetail(REAL_GIT_STDERR.DNS_FAIL), false)

  const info = classifyFetchFailure(REAL_GIT_STDERR.TIMEOUT_KILLED, 'http://127.0.0.1:7897')
  const message = describeFetchFailure({
    info,
    proxyDetail: REAL_GIT_STDERR.TIMEOUT_KILLED,
    timedOut: true,
    timeoutMs: 30_000,
  })
  assert.ok(!/Command failed/.test(message), `别把命令行丢给用户：${message}`)
  assert.match(message, /超时|未完成/, `要说清是超时，实际：${message}`)
})

test('★ stderr 为空但**不是**我们超时杀的 → 也不能把命令行/空串显示给用户', async () => {
  // 这条是真·变异测试补出来的：上面那条走的是 `timedOut === true` 的分支，
  // 而「原文没有信息量」的守卫在 `timedOut === false` 时才会用到。
  // 两者是不同的失败形态：进程可能被系统信号杀掉、git 也可能崩掉而没吐 stderr，
  // 那时 killed 未必为 true，但原文一样是空的或只有我们自己的命令行。
  const { classifyFetchFailure, describeFetchFailure } = await import('../lib/core/updater.js')

  for (const [label, detail] of [
    ['只有我们自己的命令行', REAL_GIT_STDERR.TIMEOUT_KILLED],
    ['空串', ''],
    ['纯空白', '   '],
  ]) {
    const info = classifyFetchFailure(detail, 'http://127.0.0.1:7897')
    const message = describeFetchFailure({
      info,
      proxyDetail: detail,
      timedOut: false, // ← 关键：没被我们超时杀
      timeoutMs: 30_000,
    })
    assert.ok(!/Command failed/.test(message), `${label}：不该显示我们自己的命令行，实际：${message}`)
    assert.match(message, /原因未知|超时|未完成/, `${label}：要给一句人话，实际：${message}`)
    assert.ok(message.trim() !== '拉取远端失败：', `${label}：不能只留个前缀，实际：${message}`)
  }
})

// ── 重试直连：用注入的假 git 驱动完整分支（离线可跑，且能稳定造出两种局面）──

/**
 * 造一个「假 git」，**按参数**决定返回什么（不依赖调用顺序）。
 *
 * 用真实的 `__setGitRunnerForTest` 缝注入，所以走的是**生产代码的同一条路径**
 * （`checkUpdate` 真跑一遍），而不是另写一个平行实现去自证。
 *
 * ⚠️ 早先按「调用顺序」回放，结果 `config --get` 这类额外调用会把序列错位，
 * 测试变得极脆。改成按参数匹配后，只有 `fetch` 需要区分「第几次」
 * （因为同一个参数要返回不同结果），所以它单独用 `onFetch` 计数。
 */
async function withFakeGit(script, run) {
  const { __setGitRunnerForTest } = await import('../lib/core/updater.js')
  const calls = []
  let fetchCount = 0
  const gitDefaults = {
    isWorkTree: true,
    branch: 'main',
    remote: 'https://github.com/x/y.git',
    /** `git config --get <key>` 的答案表；没有的键当「未设置」。 */
    proxyConfig: {},
    /** 每次 fetch 的结果（按顺序取，取完用最后一个）。 */
    fetchResults: [{ ok: true, stdout: '', detail: '', timedOut: false }],
    revList: '0',
    remotePkg: JSON.stringify({ name: 'x', version: '0.1.0' }),
  }
  const config = { ...gitDefaults, ...script }
  const restore = __setGitRunnerForTest(async (_cwd, args, timeoutMs) => {
    const joined = args.join(' ')
    calls.push({ args: [...args], timeoutMs })

    if (joined.includes('rev-parse --is-inside-work-tree')) {
      return { ok: true, stdout: config.isWorkTree ? 'true' : 'false', detail: '', timedOut: false }
    }
    if (joined.includes('rev-parse --abbrev-ref')) {
      return { ok: true, stdout: config.branch, detail: '', timedOut: false }
    }
    if (joined.includes('remote get-url origin')) {
      return { ok: true, stdout: config.remote, detail: '', timedOut: false }
    }
    if (joined.includes('config --get')) {
      // 取键名（`config --get http.proxy`）
      const key = args[args.indexOf('--get') + 1] ?? ''
      const value = config.proxyConfig[key]
      if (typeof value !== 'string' || value === '') {
        return { ok: false, stdout: '', detail: 'not set', timedOut: false }
      }
      return { ok: true, stdout: value, detail: '', timedOut: false }
    }
    if (joined.includes('fetch')) {
      const result = config.fetchResults[Math.min(fetchCount, config.fetchResults.length - 1)]
      fetchCount += 1
      return result
    }
    if (joined.includes('rev-list')) {
      return { ok: true, stdout: config.revList, detail: '', timedOut: false }
    }
    if (joined.includes('show')) {
      return { ok: true, stdout: config.remotePkg, detail: '', timedOut: false }
    }
    return { ok: true, stdout: '', detail: '', timedOut: false }
  })
  try {
    return await run(calls)
  } finally {
    restore()
  }
}

test('★ 回环代理 + 直连成功 → available 按直连算，且说明「已改用直连」', async () => {
  await withFakeGit(
    {
      proxyConfig: { 'http.proxy': 'http://127.0.0.1:7897' },
      fetchResults: [
        // ① 走代理 → 失败（真实 stderr）
        { ok: false, stdout: '', detail: REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN, timedOut: false },
        // ② 直连重试 → 成功
        { ok: true, stdout: '', detail: '', timedOut: false },
      ],
      revList: '2',
    },
    async (calls) => {
      const status = await checkUpdate('X:/fake')
      assert.equal(status.supported, true)
      assert.equal(status.behind, 2, '直连成功后，behind 应按直连结果算')
      assert.equal(status.available, true, 'available 按直连结果算')
      assert.match(status.message, /已改用直连/, `要说明用了直连，实际：${status.message}`)

      // ★ 必须真的用「绕过代理」的参数重试过
      const fetches = calls.filter((c) => c.args.includes('fetch'))
      assert.equal(fetches.length, 2, '应当有两次 fetch（一次代理、一次直连）')
      assert.ok(
        !fetches[0].args.includes('-c'),
        `第一次不该带覆盖参数：${fetches[0].args.join(' ')}`,
      )
      assert.ok(
        fetches[1].args.includes('-c') && fetches[1].args.includes('http.proxy='),
        `第二次必须用 -c http.proxy= 绕开代理：${fetches[1].args.join(' ')}`,
      )
      assert.ok(
        fetches[1].timeoutMs <= 10_000,
        `★ 直连重试必须用短超时（实测直连失败要 21 秒），实际 ${fetches[1].timeoutMs}ms`,
      )
    },
  )
})

test('★ 回环代理 + 直连也失败 → message 同时说清两次尝试', async () => {
  await withFakeGit(
    {
      proxyConfig: { 'http.proxy': 'http://127.0.0.1:7897' },
      fetchResults: [
        { ok: false, stdout: '', detail: REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN, timedOut: false },
        { ok: false, stdout: '', detail: REAL_GIT_STDERR.DIRECT_DOWN, timedOut: false },
      ],
    },
    async () => {
      const status = await checkUpdate('X:/fake')
      assert.equal(status.available, false)
      assert.match(status.message, /连不上代理/, `要说第一次（代理）失败：${status.message}`)
      assert.match(status.message, /127\.0\.0\.1:7897/, `要含代理地址：${status.message}`)
      assert.match(status.message, /改用直连也失败/, `★ 也要说第二次（直连）失败：${status.message}`)
    },
  )
})

test('★★ 非回环代理 → 绝不重试（只发一次 fetch，且不带绕过参数）', async () => {
  await withFakeGit(
    {
      // 公司代理（非回环）
      proxyConfig: { 'http.proxy': 'http://proxy.corp.example:8080' },
      fetchResults: [
        { ok: false, stdout: '', detail: REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN, timedOut: false },
      ],
    },
    async (calls) => {
      await checkUpdate('X:/fake')
      const fetches = calls.filter((c) => c.args.includes('fetch'))
      assert.equal(fetches.length, 1, '★ 非回环代理只允许试一次 —— 重试等于绕过公司网络策略')
      assert.ok(
        !calls.some((c) => c.args.includes('http.proxy=')),
        '★ 任何调用都不许带「绕过代理」参数',
      )
    },
  )
})

test('认不出来（无 over proxy、无代理配置）→ 不重试，保留原文', async () => {
  await withFakeGit(
    {
      proxyConfig: {},
      fetchResults: [
        { ok: false, stdout: '', detail: REAL_GIT_STDERR.DIRECT_DOWN, timedOut: false },
      ],
    },
    async (calls) => {
      const status = await checkUpdate('X:/fake')
      const fetches = calls.filter((c) => c.args.includes('fetch'))
      assert.equal(fetches.length, 1, '认不出来就不该重试')
      // 保留原文（`shortenDetail` 会截断到适合设置页一行的长度，
      // 所以断言开头那段能认出来的部分，而不是结尾）。
      assert.match(status.message, /fatal: unable to access/, `保留原文：${status.message}`)
      assert.match(status.message, /Failed to connect to github\.com/, `保留原文：${status.message}`)
      // 但**不许**把它猜成代理问题
      assert.ok(!/代理/.test(status.message), `别猜成代理问题：${status.message}`)
      assert.ok(!/Clash/.test(status.message), `别猜成「代理没开」：${status.message}`)
    },
  )
})

test('代理地址现取：优先 http.proxy，取不到退回 https.proxy', async () => {
  await withFakeGit(
    {
      // http.proxy 未设置，只有 https.proxy
      proxyConfig: { 'https.proxy': 'http://127.0.0.1:8888' },
      fetchResults: [
        { ok: false, stdout: '', detail: REAL_GIT_STDERR.LOOPBACK_PROXY_DOWN, timedOut: false },
        { ok: true, stdout: '', detail: '', timedOut: false },
      ],
      revList: '1',
    },
    async () => {
      const status = await checkUpdate('X:/fake')
      // 用的是 https.proxy 里那个地址，不是写死的 7897
      assert.match(status.message, /127\.0\.0\.1:8888/, `应当用现取的 https.proxy：${status.message}`)
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 10605 排队：解析排队码与 retryAfterSeconds（task-23）
//
// 用户报障：Qoder 回
//   {"code":"10605","message":"{\"isQueued\":true,…,\"retryAfterSeconds\":30,…}"}
// 而 `sse.ts` 把它硬编码成 `kind: 'server'` ⇒ `server` 在 DSH 的可重试码里
// ⇒ **立刻白重试 5 次（≈15.5 秒）**，完全无视上游说的「等 30 秒」，最后把裸 JSON
// 丢给用户。用户以为「DS 模型在 Qoder 是免费的」是错的 —— 他记得对，是**排队**，
// 而 `subCode: RESOURCE_LIMIT` 这个名字误导人（它是**容量**限制，不是**额度**限制）。
//
// 每个用例都钉住一条「改前会静默错」的行为。
// ─────────────────────────────────────────────────────────────────────────────

/** 报障报文里的**内层**排队体（一字不改）。 */
const QUEUE_INNER = JSON.stringify({
  isQueued: true,
  modelKey: 'dfmodel',
  queueCount: 0,
  queueType: 'p3',
  retryAfterSeconds: 30,
  serviceAvailable: false,
  subCode: 'RESOURCE_LIMIT',
  waitTime: 30,
})

/** 取一个 SSE 负载的 error 事件（没有则 undefined）。 */
function errorOf(payload) {
  return translateChunk(typeof payload === 'string' ? payload : JSON.stringify(payload)).find((e) => e.type === 'error')
}

test('10605 排队：解析排队码与 retryAfterSeconds', () => {
  // ★ 主用例：正是用户看到的那一帧（信封剥离后的形态）。
  const event = errorOf({ code: '10605', message: QUEUE_INNER, type: 'model_error' })
  assert.notEqual(event, undefined, '应当产出 error 事件')
  const f = event.failure
  assert.notEqual(f.kind, 'server', '排队绝不能归成 server —— 它在可重试码里，会白重试 5 次')
  assert.equal(f.kind, 'rate_limit', '排队是「暂时被挡住」，语义就是 rate_limit')
  assert.equal(f.retryAfterMs, 30000, '必须解析出 retryAfterSeconds×1000')
  assert.equal(isRetryable('rate_limit'), true, '排队确实该重试')
  assert.equal(shouldSwitchAccount('rate_limit'), true, '排队该换号再试（不该判死账号）')
})

test('10605 排队：延迟真的会进账号冷却（下游链路通了）', () => {
  // 这条证明「解析出来」与「真的用上」是同一件事 —— 否则等于没修。
  const f = errorOf({ code: '10605', message: QUEUE_INNER, type: 'model_error' }).failure
  assert.equal(penaltyMsFor(f.kind, f.retryAfterMs, 300), 30000, '冷却应当等于上游要求的 30 秒')
})

test('10605 排队：文案是人话，且明确否定「额度」误读', () => {
  // 用户因为 RESOURCE_LIMIT 这个名字去查了一次额度，别再让他查第二次。
  const f = errorOf({ code: '10605', message: QUEUE_INNER, type: 'model_error' }).failure
  assert.match(f.message, /排队/)
  assert.match(f.message, /p3/)
  assert.match(f.message, /30 秒/)
  assert.ok(!f.message.includes('{'), '不能把裸 JSON 丢给用户')
  assert.match(f.message, /不是你的额度用尽/, '必须明确否定额度误读')
})

test('10605 排队：排队字段在内层、外层没有 code → 仍能识别', () => {
  // ⚠️ 这是参考实现第一版翻车的点：「必须命中 code 才算排队」会让这一形态
  // 静默失效（探针显示 sleep 次数 = 0，错误照旧抛 server）。
  const event = errorOf({ message: QUEUE_INNER, type: 'model_error' })
  assert.equal(event?.failure.kind, 'rate_limit')
  assert.equal(event?.failure.retryAfterMs, 30000)
})

test('10605 排队：数字编码的码值也要认（兼容字符串/数字）', () => {
  const event = errorOf({ code: 10605, message: QUEUE_INNER, type: 'model_error' })
  assert.equal(event?.failure.kind, 'rate_limit')
  assert.equal(event?.failure.retryAfterMs, 30000)
})

test('10605 排队：retryAfterSeconds 为 0 → retryAfterMs 是 0（0 是合法值）', () => {
  // ⚠️ 0 与 undefined 是两件事：前者是「立刻可重试」。falsy 判据会把它换成
  // 默认冷却，让本可立刻重试的请求白等。
  const inner = JSON.stringify({ isQueued: true, retryAfterSeconds: 0 })
  const f = errorOf({ code: '10605', message: inner, type: 'model_error' }).failure
  assert.equal(f.retryAfterMs, 0)
  assert.notEqual(f.retryAfterMs, undefined)
  assert.equal(penaltyMsFor(f.kind, f.retryAfterMs, 300), 0, '0 冷却 = 立刻可用')
})

test('10605 排队：延迟优先序 retry_after_ms → retryAfterMs → retryAfterSeconds', () => {
  // 参考实现 kJa()/EV()/IRA() 的取证结论。
  const a = errorOf({
    code: '10605',
    message: JSON.stringify({ isQueued: true, retry_after_ms: 2500, retryAfterMs: 7500, retryAfterSeconds: 30 }),
    type: 'model_error',
  }).failure
  assert.equal(a.retryAfterMs, 2500, 'retry_after_ms 优先')

  const b = errorOf({
    code: '10605',
    message: JSON.stringify({ isQueued: true, retryAfterMs: 7500, retryAfterSeconds: 30 }),
    type: 'model_error',
  }).failure
  assert.equal(b.retryAfterMs, 7500, '其次是 retryAfterMs')

  const c = errorOf({
    code: '10605',
    message: JSON.stringify({ isQueued: true, retryAfterSeconds: 4 }),
    type: 'model_error',
  }).failure
  assert.equal(c.retryAfterMs, 4000, '最后才是 retryAfterSeconds')
})

test('10605 排队：瞬时排队（isQueued:false + serviceAvailable:true）也要认', () => {
  // ⚠️ 不能要求 isQueued === true：服务端「可立即处理」时实测就是这个形态
  //（用户报告「一次重试就能成功」）。参考实现写单测时实测到了这条
  //（期望 2000ms 实际 1000ms）。
  const inner = JSON.stringify({ isQueued: false, serviceAvailable: true, waitTime: 0, retryAfterSeconds: 2 })
  const f = errorOf({ code: '10605', message: inner, type: 'model_error' }).failure
  assert.equal(f.kind, 'rate_limit')
  assert.equal(f.retryAfterMs, 2000, '必须取到 2000ms，不能退到兜底 1 秒')
})

test('10605 排队：解析器能吃 data/result 嵌套（递归展开）', () => {
  // ⚠️ 注意这是**解析器层**的断言，不是 translateChunk 层：
  // `translateChunk` 的 model_error 分支要求**顶层** `parsed.message` 是字符串
  // 才进得来（那是它识别「网关形态错误帧」的既有判据），所以纯嵌套形状
  // 根本不会走到分类器 —— 这一点单独有一条用例钉住。
  const info = parseQueueError({ data: { result: { code: '10605', message: QUEUE_INNER } } })
  assert.equal(info?.retryAfterSeconds, 30)
  assert.equal(info?.queueType, 'p3')
  assert.equal(queueDelayMs(info), 30000)
})

test('10605 排队：顶层 message 是字符串时才进 model_error 分支（既有判据不变）', () => {
  // 钉住「不改坏既有行为」：纯嵌套（顶层没有 message 字符串）不是这个分支的形态，
  // 它本来就被别处处理（或就是合法空帧）。这里如实断言**现状**，
  // 而不是假装分类器管得着。
  const events = translateChunk(JSON.stringify({ data: { result: { code: '10605', message: QUEUE_INNER } }, type: 'model_error' }))
  assert.equal(events.length, 0, '纯嵌套不进 model_error 分支 —— 这是既有判据，本次不改动它')
})

test('10605 排队：延迟封顶，畸形的大值不会把账号锁死', () => {
  const inner = JSON.stringify({ isQueued: true, retryAfterSeconds: 86400 })
  const f = errorOf({ code: '10605', message: inner, type: 'model_error' }).failure
  assert.equal(f.retryAfterMs, QUEUE_MAX_DELAY_MS, '要封顶到 QUEUE_MAX_DELAY_MS')
  assert.ok(f.retryAfterMs <= RETRY_AFTER_CAP_MS, '且不超过全局封顶')
})

test('10605 排队：负值/非有限值判无效，不当成 0（避免忙循环）', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const inner = JSON.stringify({ isQueued: true, retryAfterSeconds: bad })
    const f = errorOf({ code: '10605', message: inner, type: 'model_error' }).failure
    assert.equal(f.kind, 'rate_limit', '仍然是排队')
    assert.equal(f.retryAfterMs, undefined, `${bad} 应判无效而不是 0`)
  }
})

test('10605 排队：parseQueueError 的入参两种形态都吃', () => {
  const outer = parseQueueError({ code: '10605', message: QUEUE_INNER })
  assert.equal(outer?.retryAfterSeconds, 30)
  assert.equal(outer?.queueType, 'p3')
  const inner = parseQueueError(QUEUE_INNER)
  assert.equal(inner?.retryAfterSeconds, 30, '内层（没有 code）也要能解析出字段')
  assert.equal(inner?.isQueued, true)
  // 不是排队的一律 undefined，不能误判。
  assert.equal(parseQueueError({ code: '400', message: 'boom' }), undefined)
  assert.equal(parseQueueError('不是 JSON'), undefined)
  assert.equal(parseQueueError(null), undefined)
  assert.equal(parseQueueError(undefined), undefined)
})

test('普通 model_error 仍然归 server（不能误伤）', () => {
  // 已有用例依赖这个行为（「不认它就会静默成功」那一段）。回归守住。
  const f = errorOf({
    code: '400',
    message: '[FAIL]node:oa_qwen-plus-main msg:Execution failed: null',
    statusCodeValue: 400,
    statusCode: 'BAD_REQUEST',
    type: 'model_error',
  }).failure
  assert.equal(f.kind, 'server')
  assert.equal(f.retryAfterMs, undefined)
  assert.equal(f.status, 400)
  assert.match(f.message, /Execution failed/)
})

test('普通 model_error（无 statusCodeValue、只有 stackTrace）仍是 server', () => {
  const f = errorOf({ message: 'boom', stackTrace: 'at x', type: 'model_error' }).failure
  assert.equal(f.kind, 'server')
  assert.match(f.message, /boom/)
})

test('OpenAI 标准 error 字段分支也走同一份分类（不能只修一处）', () => {
  // ⚠️ translateChunk 有两个错误分支，排队识别只补一个就会漏掉另一个 ——
  // 参考实现第一版正是这么翻车的（只修 HTTP 通道，SSE 通道静默失效）。
  const queued = errorOf({ error: { message: 'too many', code: '10605' } })
  assert.notEqual(queued, undefined, 'error 分支应当仍然产出事件')
  // 这条形态下排队参数不在体里，退到 server 是可接受的；
  // 但若体里带了排队内层，就必须识别出来。
  const withQueue = errorOf({ error: { message: QUEUE_INNER } })
  assert.equal(withQueue?.failure.kind, 'rate_limit', 'error 分支也要认排队')
  assert.equal(withQueue?.failure.retryAfterMs, 30000)
})

test('业务码 110（当天额度耗尽）→ quota，不可重试', () => {
  // ⚠️ 它原先也是 server ⇒ 白重试 5 次（≈15.5 秒），而**等多久结果都一样**，
  // 那是纯损失。参考实现记录过同一个坑。
  const f = errorOf({ code: '110', message: 'Billing daily count exceeded', type: 'model_error' }).failure
  assert.equal(f.kind, 'quota')
  assert.equal(isRetryable('quota'), false, 'quota 不可重试 —— 这正是修复的目的')
  assert.match(f.message, /额度/)
  // 冷却应当是「当日」量级，不是几分钟。
  assert.equal(penaltyMsFor(f.kind, f.retryAfterMs, 300), QUOTA_COOLDOWN_MS)
})

test('额度文案兜底：码值不是 110 但文案命中也要认', () => {
  // 参考实现取证：110 这个码值在客户端产物里**没有硬编码**，说明它由服务端下发；
  // 上游哪天换码值，只认码就会漏判。
  for (const text of ['Billing daily count exceeded', 'billing_error', 'daily count exceeded']) {
    const f = errorOf({ code: '9999', message: text, type: 'model_error' }).failure
    assert.equal(f.kind, 'quota', `${text} 应判 quota`)
  }
})

test('额度判据不能误伤正常内容（关键词必须窄）', () => {
  // 模型正文里讨论「余额」是常见的，泛词会误伤。
  const f = errorOf({ code: '400', message: '请问我的余额还有多少？', statusCodeValue: 400, type: 'model_error' }).failure
  assert.equal(f.kind, 'server', '普通业务错误不该被说成额度耗尽')
  const g = errorOf({ message: 'quota related documentation', type: 'model_error' }).failure
  assert.equal(g.kind, 'server', 'quota 这个泛词不能当判据')
})

test('排队与额度互不干扰（同一份体只能命中一个）', () => {
  const queued = { code: '10605', message: QUEUE_INNER }
  assert.notEqual(parseQueueError(queued), undefined)
  assert.equal(isBillingErrorBody(queued), false, '排队体不能被判成额度')
  const billing = { code: '110', message: 'Billing daily count exceeded' }
  assert.equal(parseQueueError(billing), undefined, '额度体不能被判成排队')
  assert.equal(isBillingErrorBody(billing), true)
})

test('10605 排队：端到端走 Qoder 信封层（真实链路的形态）', async () => {
  // ⚠️ 这条最有价值：证明「上游原始 SSE 帧 → 信封剥离 → sse.ts」整条链
  // 真的产出 rate_limit + 30000，而不是只有绕过信封层时才正确。
  const upstreamFrame = {
    headers: {},
    body: JSON.stringify({ code: '10605', message: QUEUE_INNER, subCode: 'RESOURCE_LIMIT' }),
    statusCodeValue: 200,
    statusCode: 'OK',
  }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(upstreamFrame)}\n\n`))
      controller.close()
    },
  })
  const text = await unwrapQoderEnvelopeStream(new Response(stream), 'qoder').text()
  const inner = text.trim().replace(/^data:\s*/, '')
  // 信封层必须保真带上 code（丢掉它排队就永远命中不了）。
  assert.match(inner, /"code":"10605"/, '信封层必须保留顶层 code')
  const f = errorOf(inner).failure
  assert.equal(f.kind, 'rate_limit')
  assert.equal(f.retryAfterMs, 30000)
})

// ─────────────────────────────────────────────────────────────────────────────
// 排队延迟：Retry-After 响应头兜底（优先序第 4 档）+ iterateSse 端到端
//
// 参考实现取证的四档优先序：`retry_after_ms` → `retryAfterMs`
// → `retryAfterSeconds × 1000` → `Retry-After` 响应头。
// 前三档在体内，第 4 档在 `Response` 上 —— 少了它，一个「只说了排队、
// 没说等多久」的响应会丢掉服务端已经写明的时长。
// ─────────────────────────────────────────────────────────────────────────────

/** 造一个 SSE 响应（可选带头部）。 */
function sseResponseOf(frames, headers = {}) {
  const body = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } })
}

/** 从 iterateSse 里取第一个 error 事件的 failure。 */
async function firstSseError(response) {
  for await (const event of iterateSse(response)) {
    if (event.type === 'error') return event.failure
  }
  return undefined
}

const QUEUE_NO_DELAY = JSON.stringify({ isQueued: true, queueType: 'p3', serviceAvailable: false })

test('排队延迟：Retry-After 响应头兜底（优先序第 4 档）', async () => {
  const f = await firstSseError(
    sseResponseOf([{ code: '10605', message: QUEUE_NO_DELAY, type: 'model_error' }], { 'retry-after': '7' }),
  )
  assert.equal(f?.kind, 'rate_limit')
  assert.equal(f?.retryAfterMs, 7000, '体内没给延迟时，应当取响应头')
})

test('排队延迟：四档优先序，体内一律压过响应头', async () => {
  const withHeader = { 'retry-after': '99' }
  const cases = [
    [{ isQueued: true, retry_after_ms: 1500 }, 1500, 'retry_after_ms'],
    [{ isQueued: true, retryAfterMs: 2500 }, 2500, 'retryAfterMs'],
    [{ isQueued: true, retryAfterSeconds: 4 }, 4000, 'retryAfterSeconds'],
  ]
  for (const [inner, expected, label] of cases) {
    const f = await firstSseError(
      sseResponseOf([{ code: '10605', message: JSON.stringify(inner), type: 'model_error' }], withHeader),
    )
    assert.equal(f?.retryAfterMs, expected, `${label} 应当压过响应头的 99 秒`)
  }
})

test('排队延迟：四档都没有 → undefined（交上层退避，不是假装 0）', async () => {
  const f = await firstSseError(sseResponseOf([{ code: '10605', message: QUEUE_NO_DELAY, type: 'model_error' }]))
  assert.equal(f?.retryAfterMs, undefined)
})

test('排队延迟：响应头是 HTTP-date 也能解析', async () => {
  const future = new Date(Date.now() + 90_000).toUTCString()
  const f = await firstSseError(
    sseResponseOf([{ code: '10605', message: QUEUE_NO_DELAY, type: 'model_error' }], { 'retry-after': future }),
  )
  assert.ok(f?.retryAfterMs > 80_000 && f?.retryAfterMs <= 90_000, `实得 ${f?.retryAfterMs}`)
})

test('排队延迟：畸形的响应头（负数）判无效，不当成「立即解除」', async () => {
  // ⚠️ 这条是 parseRetryAfter 那个缺陷在 SSE 路径上的回归：
  // `Date.parse('-5')` 是合法的（被当 ISO 年份），Math.max(0,…) 会把它抹成 0
  // = 「立即解除」⇒ 刚被限流的账号马上被重选。
  const f = await firstSseError(
    sseResponseOf([{ code: '10605', message: QUEUE_NO_DELAY, type: 'model_error' }], { 'retry-after': '-5' }),
  )
  assert.equal(f?.retryAfterMs, undefined)
})

test('排队延迟：非排队错误不借用响应头的延迟（不能误伤）', async () => {
  const f = await firstSseError(
    sseResponseOf(
      [{ code: '400', message: 'boom', statusCodeValue: 400, type: 'model_error' }],
      { 'retry-after': '99' },
    ),
  )
  assert.equal(f?.kind, 'server')
  assert.equal(f?.retryAfterMs, undefined, '普通错误不该被塞进排队延迟')
})

test('排队端到端：iterateSse 从真实 SSE 流里产出 rate_limit + 延迟', async () => {
  // 这条把「字节流 → SSE 解码 → 分类」整条串起来，证明不是只有直接调
  // translateChunk 才对。
  const inner = JSON.stringify({ isQueued: true, queueType: 'p3', retryAfterSeconds: 30, serviceAvailable: false })
  const response = sseResponseOf([
    { code: '10605', message: inner, type: 'model_error' },
    '[DONE]',
  ])
  const f = await firstSseError(response)
  assert.equal(f?.kind, 'rate_limit')
  assert.equal(f?.retryAfterMs, 30000)
  assert.match(f?.message ?? '', /排队/)
})

test('排队端到端：跨 chunk 切分的一帧也能识别（SSE 缓冲回归）', async () => {
  // 一个 SSE 事件被 TCP 切成两段是常态，切成两段后仍必须识别出排队。
  const inner = JSON.stringify({ isQueued: true, retryAfterSeconds: 30 })
  const frame = `data: ${JSON.stringify({ code: '10605', message: inner, type: 'model_error' })}\n\n`
  const half = Math.floor(frame.length / 2)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame.slice(0, half)))
      controller.enqueue(new TextEncoder().encode(frame.slice(half)))
      controller.close()
    },
  })
  const f = await firstSseError(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(f?.kind, 'rate_limit')
  assert.equal(f?.retryAfterMs, 30000)
})

// ─────────────────────────── 适配器形状：图片计价 ───────────────────────────
//
// 坑（2026-10-27 实测）：DSH 0.2.1 给 `LlmAdapter` 加了 `imageRequestPricing()`
// 与 `imageRequestTarget()`，但宿主是**鸭子类型**——不实现也能注册成功，
// 只在**真正调用时**抛 `is not a function`。压缩对话就会崩：
//   compact this.adapters.get(...)?.adapter.imageRequestPricing is not a function
// 所以这里把「宿主用到的每个方法都在」写成断言，别再靠人肉记。

/** 造一个只验形状的 adapter（不发请求）。 */
function shapeOnlyAdapter() {
  const log = { child: () => log, debug() {}, info() {}, warn() {}, error() {} }
  return createLlmAdapter({
    agentId: 'opencode',
    displayName: 'OpenCode',
    labelWithAgent: true,
    accounts: new Proxy({}, { get: () => () => undefined }),
    router: {
      async execute(_agentId, run) {
        const account = {
          id: 'opencode:x',
          agentId: 'opencode',
          label: 'x',
          credentials: {},
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        }
        const outcome = await run(account)
        if (outcome.ok === true) return { ok: true, accountId: account.id, attempts: [], value: outcome.value }
        return { ok: false, accountId: account.id, attempts: [], failure: { kind: 'unknown', message: '' } }
      },
    },
    adapterOf: () => ({
      id: 'opencode',
      name: 'OpenCode',
      async *requestChatStream() {
        yield { type: 'text', content: '' }
      },
    }),
    contextOf: () => ({
      config: { upstream: {}, requestTimeoutMs: 1000 },
      log,
      http: async () => ({ ok: true }),
      cache: new MemoryCache(),
      now: () => 0,
    }),
    modelsOf: async () => [],
    log,
  })
}

test('适配器形状：宿主 LlmRuntime 会调用的方法一个都不能缺（含图片计价）', () => {
  const adapter = shapeOnlyAdapter()
  // 名单来自 dsh-llm/lib/index.js 里所有 `.adapter.xxx(` 调用点。
  const required = [
    'providerInfo',
    'providerRetryPolicy',
    'imageRequestPricing',
    'imageRequestTarget',
    'listModels',
    'resolveModel',
    'prepareCall',
    'stream',
  ]
  for (const name of required) {
    assert.equal(typeof adapter[name], 'function', `adapter 缺 ${name}()，宿主调用时会抛 is not a function`)
  }
})

test('图片计价：每次出现都要给一条价，且本网关不收视觉 token', () => {
  const adapter = shapeOnlyAdapter()
  const pricing = adapter.imageRequestPricing('multiagent-opencode', 'opencode/auto')
  assert.equal(typeof pricing?.priceImages, 'function')

  const images = [
    { type: 'image', attachment: { attachmentId: 'sha256:aaaa', width: 800, height: 600, bytes: 120000 } },
    { type: 'image', offloaded: true, attachment: { attachmentId: 'sha256:bbbb', width: 1024, height: 768, bytes: 200000 } },
  ]
  const prices = pricing.priceImages(images)

  // 计价口径是**产品决定**：0.3.5 起图片真的会发出去（`toOpenAiMessages()` 产出
  // `image_url`），但倍率表只按文本 token 计，视觉 token 仍报 0。
  // 宿主 priceSurface 会断言「价格条数 === 出现次数」，少一条直接抛。
  assert.equal(prices.length, images.length)
  for (const price of prices) {
    assert.equal(price.visualTokens, 0)
    // 图片走 `image_url`，不占文本位；写占位句只会给计量凭空加字。
    assert.equal(price.text, '')
  }
})

test('图片尺寸：长边压到 1568、单张压到 1 MiB，小图不放大', () => {
  const adapter = shapeOnlyAdapter()
  const small = { attachmentId: 'sha256:aaaa', width: 800, height: 600, bytes: 120000 }
  assert.deepEqual(adapter.imageRequestTarget('multiagent-opencode', 'opencode/auto', small), {
    width: 800,
    height: 600,
    maxBytes: 120000,
  })

  // 3136×1568 → 长边 1568（等比缩一半）；5 MiB → 1 MiB
  const huge = { attachmentId: 'sha256:bbbb', width: 3136, height: 1568, bytes: 5 * 1024 * 1024 }
  assert.deepEqual(adapter.imageRequestTarget('multiagent-opencode', 'opencode/auto', huge), {
    width: 1568,
    height: 784,
    maxBytes: 1024 * 1024,
  })
})

test('图片块：有解析器时转成 image_url data URI，文字与顺序都保留', async () => {
  const seen = []
  const messages = await toOpenAiMessages(
    {
      provider: 'p',
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '第一段' },
            { type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', width: 100, height: 50, bytes: 1000 } },
            { type: 'text', text: '第二段' },
          ],
        },
      ],
    },
    async (ref) => {
      seen.push(ref.attachmentId)
      return 'data:image/png;base64,AAAA'
    },
  )

  assert.deepEqual(seen, ['sha256:aa'])
  const content = messages[0].content
  assert.ok(Array.isArray(content), '有图时 content 必须是块数组')
  assert.deepEqual(content.map((part) => part.type), ['text', 'image_url', 'text'])
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAAA')
  assert.equal(content[0].text, '第一段')
  assert.equal(content[2].text, '第二段')
})

test('图片块：没有解析器 / offloaded / 解析失败都退回纯文本', async () => {
  const options = {
    provider: 'p',
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张' },
          { type: 'image', attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', width: 10, height: 10, bytes: 10 } },
        ],
      },
    ],
  }

  const noResolver = await toOpenAiMessages(options)
  assert.equal(noResolver[0].content, '看这张')

  const offloadedOptions = {
    ...options,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张' },
          { type: 'image', offloaded: true, attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', width: 10, height: 10, bytes: 10 } },
        ],
      },
    ],
  }
  const offloaded = await toOpenAiMessages(offloadedOptions, async () => 'data:image/png;base64,AAAA')
  assert.equal(offloaded[0].content, '看这张')

  const failed = await toOpenAiMessages(options, async () => undefined)
  assert.equal(failed[0].content, '看这张')
})

test('纯文本消息仍然产出字符串 content（老接口不吃块数组）', async () => {
  const messages = await toOpenAiMessages({
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(typeof messages[0].content, 'string')
  assert.equal(messages[0].content, 'hi')
})


// ── 分发形态：本地目录安装必须能直接加载（2026-10-29，用户报 ERR_MODULE_NOT_FOUND） ──

test('宿主半边零运行时依赖：schemastery 走 vendor，不是 npm 依赖', () => {
  // `dsh plugin add <本地目录>` 走 pnpm link：只建符号链接、不装依赖。
  // 只要宿主半边还 import 任何 npm 包，别人解压到 D:\tools\... 就会在加载阶段炸。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(
    pkg.dependencies?.['@deepseek-ai/schemastery'],
    undefined,
    '又把 schemastery 加回 npm 依赖了 —— 本地目录安装会 ERR_MODULE_NOT_FOUND',
  )
  assert.ok(pkg.files.includes('vendor'), 'vendor/ 必须在 npm pack 的文件清单里')

  const source = readFileSync(new URL('../lib/config.js', import.meta.url), 'utf8')
  assert.match(source, /import Schema from '\.\.\/vendor\/schemastery\/index\.js'/)

  const vendored = readFileSync(new URL('../vendor/schemastery/index.js', import.meta.url), 'utf8')
  assert.match(vendored, /from "\.\.\/cosmokit\/index\.js"/, 'vendor 里指向 cosmokit 的 import 被改坏了')
})
// ── 渠道校验 11-128：必须单独成类，不能算风控（issue #5，2026-10-30） ──

test('11-128 归类为 channel_reject：不换号、不降权、不冷却', () => {
  const body = {
    code: '11-128',
    msg: 'Illegal API invocation from an unapproved channel',
    requestId: 'aaaaaaaa-0000-4000-8000-000000000000',
    displayMsg: { zh: '请求被拦截，请重新发送', en: 'Request blocked. Please send it again' },
  }
  assert.equal(classify(400, body), 'channel_reject')
  // 它跟账号无关：换号只会白烧请求，所以绝不能进换号集合。
  assert.equal(shouldSwitchAccount('channel_reject'), false)
  assert.equal(isRetryable('channel_reject'), false)
})

test('11-128 的连字符不是 ASCII 也要认（原始报文里出现过 U+2011）', () => {
  const raw = '{"code":11\u2011128,"msg":"Illegal API invocation from an unapproved channel"}'
  assert.equal(classify(400, raw), 'channel_reject')
})

test('11-128 优先于风控：报文里的「请求被拦截」不能被判成 risk_control', () => {
  // 这正是 issue #5 的毁号路径：risk_control ⇒ 换号 + 30 分钟冷却 + 4 次判死。
  const body = { code: '11-128', msg: 'Illegal API invocation from an unapproved channel', displayMsg: { zh: '请求被拦截，请重新发送' } }
  assert.equal(classify(400, body), 'channel_reject')
  assert.notEqual(classify(400, body), 'risk_control')
})

test('6004 软限流：400 也归 rate_limit（不依赖「限流」关键词）', () => {
  const body = { code: 6004, msg: '当前请求较多，将在 2026-09-30 02:30:30 UTC+8 重置' }
  assert.equal(classify(400, body), 'rate_limit')
})

// ── 报文里的重置时刻（issue #6） ──

test('parseResetAtFromBody：按报文声明的 UTC+8 换算，不按本机时区', () => {
  const now = Date.parse('2026-09-30T00:00:00Z')
  const ms = parseResetAtFromBody('…将在 2026-09-30 02:30:30 UTC+8 重置…', now)
  // 02:30:30+08:00 == 2026-09-29T18:30:30Z；距 now = -5.5h ⇒ 已过期按 0
  assert.equal(ms, 0)

  const later = parseResetAtFromBody('…将在 2026-10-01 02:30:30 UTC+8 重置…', now)
  // 2026-10-01 02:30:30+08:00 == 2026-09-30T18:30:30Z ⇒ 距 now = 18.5h
  assert.equal(later, ((18 * 60 + 30) * 60 + 30) * 1000)

  const utc = parseResetAtFromBody('reset at 2026-09-30T18:30:30Z', now)
  assert.equal(utc, ((18 * 60 + 30) * 60 + 30) * 1000)
})

test('parseResetAtFromBody：没有时区声明就返回 undefined（不猜）', () => {
  assert.equal(parseResetAtFromBody('将在 2026-09-30 02:30:30 重置', Date.now()), undefined)
})

test('parseResetAtFromBody：相对时长也认（限流器实测报文，issue #6 补）', () => {
  const now = 1_000_000
  // 2026-10-30 真机抓到的原话：小浣熊限流器不给时间戳，只写「多久后重试」。
  assert.equal(
    parseResetAtFromBody('[200103] limiter_request_error：request exceed max time, retry after:0s', now),
    1_000,
  )
  assert.equal(parseResetAtFromBody('retry after:12s', now), 12_000)
  assert.equal(parseResetAtFromBody('retry-after: 250ms', now), 1_000)
  assert.equal(parseResetAtFromBody('请 15 秒后重试', now), 15_000)
  // 裸数字没有单位 ⇒ 可能是秒也可能是毫秒，不猜。
  assert.equal(parseResetAtFromBody('retry after: 30', now), undefined)
})

test('isAbortError：signal / AbortError / ABORT_ERR 都认，普通错误不认', () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal(isAbortError(new Error('x'), controller.signal), true)
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true)
  assert.equal(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' })), true)
  assert.equal(isAbortError(new Error('ECONNRESET')), false)
})

test('取消：execute 立刻返回 aborted，不发起任何尝试', async () => {
  const { manager, cleanup } = freshAccounts()
  try {
    const router = new AccountRouter(
      manager,
      { routing: 'quota-first', degradeAfterFailures: 1, penaltySec: 60, recoverIntervalSec: 600, maxAccountAttempts: 3, maxConcurrentRequests: 2 },
      silent,
    )
    const controller = new AbortController()
    controller.abort()
    let ran = 0
    const outcome = await router.execute(
      'qoder',
      async () => {
        ran += 1
        return { ok: true, value: 1 }
      },
      { signal: controller.signal },
    )
    assert.equal(outcome.ok, false)
    assert.equal(outcome.failure.kind, 'aborted')
    assert.equal(ran, 0, '取消后不该再发起任何尝试')
    assert.equal(outcome.attempts.length, 0, '取消不该记成账号失败')
  } finally {
    cleanup()
  }
})