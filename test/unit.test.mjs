/**
 * 单元测试：核心层纯函数与状态机。
 *
 * 用 `node --test`（Node 内置，零依赖）。覆盖面刻意选在**会出错且难发现**的地方：
 * 错误分类、倍率换算、时间表达式、多账号路由、SSE 分片、任务幂等。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classify, flattenBody, parseRetryAfter, failureOf } from '../lib/core/errors.js'
import { redactSecret, redactDeep, CredentialVault } from '../lib/core/crypto.js'
import { MemoryCache, TokenBucket, Semaphore } from '../lib/core/cache.js'
import { SseDecoder, translateChunk, normalizeUsage, isParseableJson } from '../lib/core/sse.js'
import { parseSchedule, matches, isDue } from '../lib/core/scheduler.js'
import { AccountManager } from '../lib/core/accounts.js'
import { AccountRouter } from '../lib/core/router.js'
import { formatMultiplier, shouldSwitchAccount, isRetryable, selectExposedModels } from '../lib/core/types.js'
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
    assert.match(outcome.failure.message, /没有可用账号/)
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

// ───────────────────────── 适配器 ─────────────────────────

test('注册表：内置清单包含 OpenCode 与五个骨架，且接口完整', () => {
  const adapters = builtinAdapters()
  const registry = new AdapterRegistry()
  registry.registerAll(adapters)
  assert.deepEqual(registry.ids(), ['opencode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-intl'])
  for (const adapter of adapters) {
    const check = validateAdapter(adapter)
    assert.equal(check.ok, true, `${adapter.id} 缺少 ${check.missing.join(',')}`)
  }
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

test('DSH 消息 → OpenAI 消息', () => {
  const messages = toOpenAiMessages({
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
