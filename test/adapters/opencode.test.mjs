/**
 * OpenCode 模型调用：本轮修掉的两个**确凿缺口**的回归测试。
 *
 * 每个测试都对应一条「改之前会静默出错」的行为 —— 静默指：不抛错、界面上
 * 看不出原因，只是行为悄悄错了（换错号、锁错时长、档位表谎报能力）。
 *
 * 用法：node --test test/adapters/opencode.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { declaredReasoningEfforts, describeOpenCodeError, OpenCodeAdapter } from '../../lib/adapters/opencode.js'
import { translateReasoningEffort, reasoningEffortsForDeclared } from '../../lib/core/reasoning.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }

const account = {
  id: 'opencode:anonymous',
  agentId: 'opencode',
  label: 'anonymous',
  enabled: true,
  routeChat: true,
  credentials: { token: 'public' },
}

// ───────────────── 缺口 1：429 的 retry-after 必须真的传出去 ─────────────────

/**
 * 跑一次 chat，让上游回指定状态 + 头，取 `error` 事件。
 *
 * 为什么用假 fetch 而不是真打上游：这两条判据与**上游可用性无关**，
 * 假 fetch 才能把「43200 秒」这种要等 12 小时的分支稳定地跑出来。
 */
async function chatError({ status, headers = {}, body }) {
  const ctx = {
    config: {
      requestTimeoutMs: 30_000,
      upstream: { chatBaseUrl: 'https://opencode.ai/inference/openai/v1', modelsUrl: '' },
    },
    log: silent,
    cache: { get() { return undefined }, set() {}, delete() {} },
    now: () => Date.now(),
    http: async () => ({ ok: false, status: 404, body: undefined, text: '' }),
    fetch: async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  }
  const events = []
  for await (const event of new OpenCodeAdapter().requestChatStream(
    { model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], stream: true },
    account,
    ctx,
    new AbortController().signal,
  )) {
    events.push(event)
  }
  const error = events.find((event) => event.type === 'error')
  assert.notEqual(error, undefined, '应当产出一个 error 事件')
  return error.failure
}

const FREE_LIMIT_BODY = {
  type: 'error',
  error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' },
}

test('429 + retry-after: 43200 → 原样传到 failure.retryAfterMs（不再丢）', async () => {
  // 改之前：适配器走裸 fetch，错误分支不读头 ⇒ retryAfterMs 恒为 undefined，
  // 路由器只能退到 penaltySec（默认 300s），把 12 小时的额度窗口当 5 分钟限流。
  const failure = await chatError({ status: 429, headers: { 'retry-after': '43200' }, body: FREE_LIMIT_BODY })
  assert.equal(failure.retryAfterMs, 43_200_000)
})

test('429 + retry-after: 60 → 60000', async () => {
  const failure = await chatError({ status: 429, headers: { 'retry-after': '60' }, body: FREE_LIMIT_BODY })
  assert.equal(failure.retryAfterMs, 60_000)
})

test('429 + retry-after: 0 → 0（合法值「立即解除」，不能变成 undefined）', async () => {
  // `0` 与 `undefined` 是两件事：前者是服务端明说「立刻能重试」。若这里变成
  // undefined，路由器会退到 penaltySec，把刚恢复的账号白锁 5 分钟。
  const failure = await chatError({ status: 429, headers: { 'retry-after': '0' }, body: FREE_LIMIT_BODY })
  assert.equal(failure.retryAfterMs, 0)
  assert.notEqual(failure.retryAfterMs, undefined)
})

test('429 + 负数 retry-after → 无效，不是「立即解除」', async () => {
  // ★ 这一条正是 `parseRetryAfter` 那个缺陷的回归：`Date.parse('-5')` 是合法的
  // （被当成 ISO 年份 2001），`Math.max(0, at - now)` 把它抹成 0 = 「立即解除」，
  // 刚被限流的账号马上被重选 ⇒ 无限空转。负数必须判为无效。
  const failure = await chatError({ status: 429, headers: { 'retry-after': '-5' }, body: FREE_LIMIT_BODY })
  assert.equal(failure.retryAfterMs, undefined)
})

test('429 没有 retry-after 头 → 字段缺失（调用方退到保守兜底）', async () => {
  const failure = await chatError({ status: 429, body: FREE_LIMIT_BODY })
  assert.equal(failure.retryAfterMs, undefined)
})

test('429 + HTTP-date 形态的 retry-after 也能解析', async () => {
  const at = new Date(Date.now() + 120_000).toUTCString()
  const failure = await chatError({ status: 429, headers: { 'retry-after': at }, body: FREE_LIMIT_BODY })
  assert.notEqual(failure.retryAfterMs, undefined)
  // 秒级容差：now 在两次 Date.now() 之间会走一点。
  assert.ok(failure.retryAfterMs > 115_000 && failure.retryAfterMs <= 120_000, `实得 ${failure.retryAfterMs}`)
})

// ───────────────── 缺口 2：额度错误按「类型名」判，不按状态码 ─────────────────

test('FreeUsageLimitError：无论配哪个状态码都判 quota（不按状态码分家）', () => {
  // 改之前：403 → auth（换号 + 报「密钥无效」）、429 → rate_limit（短冷却）、
  // 400 → bad_request。同一个语义，三种互相矛盾的结论。
  for (const status of [400, 401, 403, 429]) {
    const verdict = describeOpenCodeError(status, FREE_LIMIT_BODY, { anonymous: true })
    assert.equal(verdict?.kind, 'quota', `status=${status} 应判 quota，实得 ${verdict?.kind}`)
  }
})

test('GoUsageLimitError 同样判 quota', () => {
  const body = { type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit' } }
  for (const status of [400, 403, 429]) {
    assert.equal(describeOpenCodeError(status, body, { anonymous: true })?.kind, 'quota')
  }
})

test('额度错误的文案给的是「可执行动作」，不是裸 JSON', () => {
  const verdict = describeOpenCodeError(403, FREE_LIMIT_BODY, { anonymous: true })
  assert.match(verdict.message, /额度/)
  assert.ok(!verdict.message.includes('{'), '不该把整坨 JSON 抛给用户')
  assert.ok(!verdict.message.includes('FreeUsageLimitError'), '不该把上游内部类型名当文案')
})

test('FreeTierError 仍判 unsupported（回归：不能被额度判据抢走）', () => {
  // 顺序即优先级：FreeTierError 是**形状门禁**（换号无效），必须排在额度前面，
  // 否则会被误判成 quota 而去换号，白白烧掉其它账号的额度。
  const body = { type: 'error', error: { type: 'FreeTierError', message: 'free tier can only be used from within opencode' } }
  for (const status of [400, 403, 429]) {
    assert.equal(describeOpenCodeError(status, body, { anonymous: true })?.kind, 'unsupported')
  }
})

test('地区限制仍判 unsupported（回归：403 不该落回 auth）', () => {
  const body = { type: 'error', error: { type: 'RegionError', message: 'This model is not available in your country' } }
  assert.equal(describeOpenCodeError(403, body, { anonymous: true })?.kind, 'unsupported')
})

test('带真 key 的 invalid credential 仍判 auth（回归：额度判据不吃掉它）', () => {
  const body = { error: { message: 'Invalid credential' } }
  assert.equal(describeOpenCodeError(401, body)?.kind, 'auth')
})

// ───────────────── 档位声明解析（models.dev 的 reasoning_options） ─────────────────

test('declaredReasoningEfforts：只认 effort 形态，原序产出', () => {
  const raw = [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }]
  assert.deepEqual(declaredReasoningEfforts(raw), ['none', 'low', 'medium', 'high', 'xhigh'])
})

test('declaredReasoningEfforts：toggle / budget_tokens 一概不产出（不发明档位）', () => {
  // ⚠️ 官方客户端对这类模型一个档位都不给，而 `reasoning_effort` 也表达不了
  // 「开关」/预算。编一档等于谎报能力 —— 上游会校验这个字段，非法值就是 400。
  assert.deepEqual(declaredReasoningEfforts([{ type: 'toggle' }]), [])
  assert.deepEqual(declaredReasoningEfforts([{ type: 'budget_tokens', max: 81920 }]), [])
  // 实测样本：qwen3.6-plus-free 就是这个组合。
  assert.deepEqual(declaredReasoningEfforts([{ type: 'toggle' }, { type: 'budget_tokens', max: 81920 }]), [])
})

test('declaredReasoningEfforts：脏数据不炸，只丢非法项', () => {
  assert.deepEqual(declaredReasoningEfforts(undefined), [])
  assert.deepEqual(declaredReasoningEfforts(null), [])
  assert.deepEqual(declaredReasoningEfforts('nope'), [])
  assert.deepEqual(declaredReasoningEfforts([null, 42, 'x', {}]), [])
  // 混着非法值：合法的留下。
  assert.deepEqual(declaredReasoningEfforts([{ type: 'effort', values: ['low', '', 7, null, 'high', 'low'] }]), [
    'low',
    'high',
  ])
})

test('declaredReasoningEfforts：多个 effort 项按原序拼接', () => {
  const raw = [{ type: 'effort', values: ['low'] }, { type: 'effort', values: ['high', 'max'] }]
  assert.deepEqual(declaredReasoningEfforts(raw), ['low', 'high', 'max'])
})

test('端到端：实测的 gpt-5.4 档位表 → 选择器只出规范名，且能译回去', () => {
  // 2026-10-19 拉 models.dev 的实测形状。
  const declared = declaredReasoningEfforts([{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }])
  assert.deepEqual(reasoningEffortsForDeclared(declared), ['none', 'low', 'medium', 'high', 'xhigh'])
  // 客户端选的每个规范名都必须能落到这个模型真有的档位上（否则就是 400）。
  for (const canonical of reasoningEffortsForDeclared(declared)) {
    const translated = translateReasoningEffort(canonical, declared)
    assert.ok(translated.kind === 'exact' || translated.kind === 'mapped', `${canonical} 应可表达`)
  }
})

test('端到端：TRAE 式私有档位经解析后不会泄漏到选择器', () => {
  // models.dev 若下发与我们不同的写法，选择器必须只出规范名 ——
  // 私有 id 一旦泄漏进选项，用户选了它、换个模型就是 400。
  const declared = declaredReasoningEfforts([{ type: 'effort', values: ['light', 'high', 'extra_high'] }])
  const options = reasoningEffortsForDeclared(declared)
  assert.deepEqual(options, ['low', 'high', 'xhigh'])
  for (const id of options) assert.ok(!['light', 'extra_high'].includes(id))
})

// ───────── 回归：本轮的改动不能影响既有错误分类路径 ─────────

test('回归：未知状态码 + 无类型名时行为不变（仍走原兜底）', () => {
  // 500 之类不该被新判据吃掉。
  assert.equal(describeOpenCodeError(500, { error: { message: 'boom' } }), undefined)
  assert.equal(describeOpenCodeError(200, { ok: true }), undefined)
})

// ───────── 「空档位表」与「没有档位信息」必须分开（端到端验证抓到的缺陷） ─────────

/**
 * 这两个处境长得很像，处置**相反**，混起来必然错一个：
 *   - `[]`（拿到了条目、确实没有档位）⇒ 拦下 `reasoning_effort`（发它 = 400）；
 *   - `undefined`（连条目都没拿到）⇒ **原样放行**（不知道就别丢用户的选择）。
 *
 * 我第一版把 `[]` 也当成「不声明」处理，端到端脚本立刻暴露了这条
 * （`能力未知 → 原样放行` 那条场景实测发出的是 `undefined` 而不是 `high`）。
 * 所以这里补一条端到端断言，防止再退化。
 */
async function sentEffortFor(meta, reasoningEffort) {
  let sent
  const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }
  const { createLlmAdapter } = await import('../../lib/llm/adapter.js')
  const adapter = createLlmAdapter({
    agentId: 'opencode',
    displayName: 'OpenCode',
    labelWithAgent: false,
    accounts: { markOk() {}, markFailure() {}, health: () => ({ failures: 0 }) },
    router: {
      execute: async (_agent, run) => ({
        ok: true,
        accountId: 'opencode:anonymous',
        attempts: [],
        value: await run({ id: 'opencode:anonymous' }),
      }),
    },
    adapterOf: () => ({
      async *requestChatStream(payload) {
        sent = payload.reasoning_effort
        yield { type: 'text', text: 'ok' }
        yield { type: 'finish', reason: 'stop' }
      },
    }),
    contextOf: () => ({ config: {}, log: silent, http: async () => ({}), cache: {}, now: () => Date.now() }),
    modelsOf: async () => [meta],
    log: silent,
  })
  for await (const _chunk of adapter.stream({
    provider: 'multiagent-opencode',
    model: meta.id,
    messages: [{ role: 'user', content: 'hi' }],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })) {
    // 只关心发出去的 payload
  }
  return sent
}

test('★ 档位信息缺失（能力未知）→ 原样放行，不丢用户的选择', async () => {
  const meta = { id: 'mystery', name: 'Mystery', agentId: 'opencode', agentName: 'OpenCode', reasoning: true }
  assert.equal(await sentEffortFor(meta, 'high'), 'high')
})

test('★ 档位表为空数组（确实没有档位）→ 拦下，不下发', async () => {
  const meta = {
    id: 'qwen3.6-plus-free',
    name: 'Qwen3.6 Plus',
    agentId: 'opencode',
    agentName: 'OpenCode',
    reasoning: true,
    reasoningEfforts: [],
  }
  assert.equal(await sentEffortFor(meta, 'high'), undefined)
})

test('★ 有档位表 → 翻译后下发', async () => {
  const meta = {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    agentId: 'opencode',
    agentName: 'OpenCode',
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  }
  assert.equal(await sentEffortFor(meta, 'high'), 'high')
  // mapped：max 不在表里 → 就近 xhigh（宁可多思考）。
  assert.equal(await sentEffortFor(meta, 'max'), 'xhigh')
})

test('★ 模型表达不了「关闭」时不下发（关闭族不互译，不在整条链上被顶替）', async () => {
  const meta = {
    id: 'trae-x',
    name: 'Trae X',
    agentId: 'trae',
    agentName: 'Trae',
    reasoning: true,
    reasoningEfforts: ['light', 'high', 'extra_high'],
  }
  // 要 none：模型没有关闭族 ⇒ 不下发，而不是就近顶替成 light。
  assert.equal(await sentEffortFor(meta, 'none'), undefined)
})

test('★ 用户没选档位时请求里不带该字段', async () => {
  const meta = {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    agentId: 'opencode',
    agentName: 'OpenCode',
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  }
  assert.equal(await sentEffortFor(meta, undefined), undefined)
})
