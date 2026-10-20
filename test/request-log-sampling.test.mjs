/**
 * 请求日志采样：倍率 / token / 速度三列的回归测试。
 *
 * ## 这组用例在守什么
 *
 * 用户报「日志中 速度、输入、输出为 —，倍率为未知」。三列空白**不是**客户端画错了
 * （`client.js` 的 `multiplierTag()` / 表格渲染都正确），而是宿主压根**没把字段写进采样**。
 * 本文件把三个根因各钉一条：
 *
 * 1. `settle()` 拼采样时**完全没放** `multiplier` / `free`；
 * 2. Qoder **本就会**发 `usage` 末帧，但它排在 `finish` **之后**（实测晚约 17ms），
 *    而 `pump()` 原先收到 `finish` 就 `return` ⇒ 那一帧永远读不到；
 * 3. `startedAt` 取得太晚（在 `router.execute` 之后），导致 `ttftMs` 恒为 0、
 *    `durationMs` 只算「首字之后」，于是 `tps` 也没有可信的窗口。
 *
 * ⚠️ 用例**刻意不打真上游**：全部用假 router + 假 adapter 驱动 `pump`，
 * 上游事件序列按本机实测的形状喂进去（见注释里的原始帧）。
 *
 * 用法：`node --test test/request-log-sampling.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createLlmAdapter } from '../lib/llm/adapter.js'
import { QoderAdapter } from '../lib/adapters/qoder.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }

/**
 * 造一个只关心采样的适配器，用给定事件序列驱动 `pump`。
 *
 * @param {object} options
 * @param {Array<Record<string, unknown>>} options.events - 上游归一化事件（按真实顺序）。
 * @param {Array<Record<string, unknown>>} [options.models] - 模型元数据（倍率来源）。
 * @param {(sample: object) => void} [options.onRequest] - 采样回调。
 * @param {number} [options.gapMs] - 每个事件之间插入的等待（用来造出可算 tps 的解码窗口）。
 * @returns {{ adapter: object, samples: object[] }} 适配器与采样收集器。
 */
function harness({ events, models = [], onRequest, gapMs = 0 }) {
  const samples = []
  const backend = {
    id: 'qoder-cn',
    name: 'Qoder CN',
    async *requestChatStream() {
      for (const event of events) {
        if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
        yield event
      }
    },
  }
  const account = {
    id: 'qoder-cn:test',
    agentId: 'qoder-cn',
    label: 'test',
    credentials: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
  const adapter = createLlmAdapter({
    agentId: 'qoder-cn',
    displayName: 'Qoder CN',
    labelWithAgent: false,
    accounts: new Proxy({}, { get: () => () => undefined }),
    router: {
      async execute(agentId, run) {
        const outcome = await run(account)
        if (outcome.ok === true) {
          return { ok: true, accountId: account.id, attempts: [], value: outcome.value }
        }
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
      config: { requestTimeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 10, maxBackoffMs: 50 } },
      log: silent,
      http: async () => ({ ok: true }),
      cache: {},
      now: () => Date.now(),
    }),
    modelsOf: async () => models,
    exposedModelsOf: async () => models,
    onRequest: (sample) => {
      samples.push(sample)
      onRequest?.(sample)
    },
    log: silent,
  })
  return { adapter, samples }
}

/** 跑完一轮，返回全部 chunk。 */
async function drain(adapter, model = 'qoder-cn/auto') {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'multiagent-qoder-cn',
    model,
    messages: [{ role: 'user', content: '你好' }],
  })) {
    chunks.push(chunk)
  }
  return chunks
}

// ───────────────────── 根因 1：倍率必须进采样 ─────────────────────

test('倍率已知 → multiplier / free 都写进采样', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [
      { type: 'text', text: '你好' },
      { type: 'finish', reason: 'stop' },
    ],
  })
  await drain(adapter)
  assert.equal(samples.length, 1, '成功一轮应当只采一条')
  assert.equal(samples[0].multiplier, 0.5, '倍率必须进采样，否则日志页显示「未知倍率」')
  // 非免费模型：free 明确为 false（拿到了倍率，就说得清不是免费）。
  assert.equal(samples[0].free, false)
})

test('倍率为 0（免费）→ multiplier=0 且 free=true', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'qfmodel', name: 'Qwen3.8-Flash', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0, free: true }],
    events: [
      { type: 'text', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ],
  })
  await drain(adapter, 'qoder-cn/qfmodel')
  assert.equal(samples[0].multiplier, 0)
  assert.equal(samples[0].free, true, '免费模型要能被识别成免费')
})

/**
 * ★ 这条是整组里**最要紧**的一条。
 *
 * 「未知」与「免费」在界面上是两句完全不同的话：`0` 画成「免费」，
 * `undefined` 画成「未知倍率」。拿 `0` 冒充未知就是**告诉用户这轮不要钱**。
 */
test('★ 倍率未知 → 不写 multiplier，且绝不退化成 0', async () => {
  const { adapter, samples } = harness({
    // 模型不在上报列表里（用户没勾选）⇒ 我们**不知道**它多少倍率。
    models: [],
    events: [
      { type: 'text', text: 'ok' },
      { type: 'finish', reason: 'stop' },
    ],
  })
  await drain(adapter, 'qoder-cn/不存在的模型')
  const sample = samples[0]
  assert.equal(sample.multiplier, undefined, `未知倍率不能落成 ${sample.multiplier}（0 的含义是「免费」）`)
  assert.ok(!('multiplier' in sample), '未知时这个键根本不该出现')
  assert.ok(!('free' in sample), '不知道倍率时也不能凭空断言「不免费」')
})

test('模型元数据读取抛错 → 不拖垮整轮对话，只是不记倍率', async () => {
  const samples = []
  const backend = {
    id: 'qoder-cn',
    name: 'Qoder CN',
    async *requestChatStream() {
      yield { type: 'text', text: 'ok' }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const adapter = createLlmAdapter({
    agentId: 'qoder-cn',
    displayName: 'Qoder CN',
    labelWithAgent: false,
    accounts: new Proxy({}, { get: () => () => undefined }),
    router: {
      async execute(agentId, run) {
        const outcome = await run({ id: 'qoder-cn:test', agentId, label: 't', credentials: {}, enabled: true, createdAt: 0, updatedAt: 0 })
        return outcome.ok === true
          ? { ok: true, accountId: 'qoder-cn:test', attempts: [], value: outcome.value }
          : { ok: false, accountId: 'qoder-cn:test', attempts: [], failure: { kind: 'unknown', message: outcome.message ?? '' } }
      },
    },
    adapterOf: () => backend,
    contextOf: () => ({ config: {}, log: silent, http: async () => ({}), cache: {}, now: () => Date.now() }),
    // 目录读取失败（例如上游挂了）—— 不能让整轮对话失败。
    modelsOf: async () => { throw new Error('目录拉取失败') },
    exposedModelsOf: async () => { throw new Error('目录拉取失败') },
    onRequest: (sample) => samples.push(sample),
    log: silent,
  })
  const chunks = await drain(adapter)
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'), '正文必须照常透出')
  assert.equal(samples.length, 1)
  assert.equal(samples[0].multiplier, undefined)
  assert.equal(samples[0].ok, true, '拿不到倍率不是失败')
})

// ───────────────────── 根因 2：usage 在 finish 之后到达 ─────────────────────

/**
 * ★ 真实帧序（本机实测 Qoder CN `auto`，2026-10-20）：
 *
 * ```
 * … #16 text「你好」 → #17 finish(stop) → #18 usage{input:15, output:36}
 * ```
 *
 * usage 比 finish **晚约 17ms**。原先 `case 'finish'` 直接 `return`，
 * 于是这一帧永远读不到 ⇒ 采样里 token 恒缺 ⇒ 日志「输入/输出」两列永远是 —。
 */
test('★ usage 排在 finish 之后 → 仍必须进采样并算出 tps', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    gapMs: 40,
    events: [
      { type: 'text', text: '你好' },
      { type: 'finish', reason: 'stop' },
      // ⚠️ 关键：usage 在 finish **之后**。
      { type: 'usage', usage: { inputTokens: 15, outputTokens: 36, totalTokens: 51, reasoningTokens: 33 } },
    ],
  })
  const chunks = await drain(adapter)
  const sample = samples[0]

  assert.equal(sample.inputTokens, 15, 'finish 之后的 usage 必须被收进采样')
  assert.equal(sample.outputTokens, 36)
  assert.equal(sample.reasoningTokens, 33)
  assert.equal(typeof sample.tps, 'number', '有了 ttft 与 outputTokens，tps 必须算出来')

  // DSH 侧也要看到 usage（它是宿主显示 token 用量的来源）。
  const usageChunk = chunks.find((chunk) => chunk.type === 'usage')
  assert.ok(usageChunk, 'usage 也要透给 DSH')
  assert.equal(usageChunk.usage.inputTokens, 15)

  // 而且**只能有一个 finish**（收尾分支去重的回归）。
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1, 'finish 只能有一个')
})

test('usage 在 finish 之前到达 → 照旧立刻透出去，且不重复发', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [
      { type: 'text', text: 'hi' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } },
      { type: 'finish', reason: 'stop' },
    ],
  })
  const chunks = await drain(adapter)
  assert.equal(samples[0].inputTokens, 5)
  assert.equal(samples[0].outputTokens, 7)
  assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1, 'usage 只能透一次')
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
})

// ───────────────────── 根因 3：ttftMs 与耗时口径 ─────────────────────

test('★ ttftMs 在第一个可见事件时设置，且不再恒为 0', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [
      // 上游「想」了 60ms 才出第一个字 —— 这段等待必须被算进首字延迟。
      { type: 'text', text: '你好' },
      { type: 'finish', reason: 'stop' },
    ],
    onRequest: () => {},
    gapMs: 60,
  })
  await drain(adapter)
  const sample = samples[0]
  assert.equal(typeof sample.ttftMs, 'number')
  assert.ok(sample.ttftMs > 0, `首字延迟应当 > 0，实际 ${sample.ttftMs}（恒为 0 说明起点取得太晚）`)
  // durationMs 要覆盖「等首字 + 解码」全程，所以一定不小于 ttftMs。
  assert.ok(
    sample.durationMs >= sample.ttftMs,
    `总耗时(${sample.durationMs}) 不该小于首字延迟(${sample.ttftMs})`,
  )
})

test('思维链算首字（它是用户可见的等待结束点）', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [
      { type: 'reasoning', text: '想想' },
      { type: 'text', text: '你好' },
      { type: 'finish', reason: 'stop' },
    ],
  })
  await drain(adapter)
  assert.equal(typeof samples[0].ttftMs, 'number', '只有思维链时也要算首字')
})

// ───────────────────── 收尾分支：只 settle 一次 ─────────────────────

test('上游断流（没给 finish）→ 采样照记，finish 兜一个', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [{ type: 'text', text: '半句话' }],
  })
  const chunks = await drain(adapter)
  assert.equal(samples.length, 1, '上游断流也要留一条采样')
  assert.equal(samples[0].ok, true)
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
  // 正文不能被吞掉（block-end 覆盖式赋值那条坑）。
  const end = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
  assert.equal(end?.block.text, '半句话')
})

test('上游报错 → 采样记 ok:false + error，且只采一条', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [
      { type: 'text', text: '开头' },
      { type: 'error', failure: { kind: 'quota', message: '额度用尽', at: Date.now() } },
    ],
  })
  const chunks = await drain(adapter)
  assert.equal(samples.length, 1)
  assert.equal(samples[0].ok, false)
  assert.equal(samples[0].error, '额度用尽')
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
})

/**
 * ★ drain 超时**不能把对话拖住**。
 *
 * 上游发完 `finish` 却**挂着连接不放**（不发 usage、也不关闭）时，
 * 我们最多再等 `USAGE_DRAIN_MS`（250ms）就必须收尾。
 *
 * ⚠️ 这条用例同时是「超时判据写在 `next()` 那一层」的回归：
 * 若把超时写成循环体里的一句 `if (Date.now() > drainUntil)`，
 * `for await` 会**卡在 `next()` 上**、循环体根本不执行 ⇒ 永远等下去。
 */
test('★ drain 超时：上游发完 finish 挂着不放，也必须及时收尾（不拖住对话）', async () => {
  const samples = []
  /** 这个假适配器在 finish 之后**永久挂住**，模拟「连接不关、也不发 usage」。 */
  let hung = false
  const backend = {
    id: 'qoder-cn',
    name: 'Qoder CN',
    async *requestChatStream() {
      yield { type: 'text', text: '你好' }
      yield { type: 'finish', reason: 'stop' }
      // 之后永远不返回 —— 上游吊着连接。
      hung = true
      await new Promise(() => {})
    },
  }
  const adapter = createLlmAdapter({
    agentId: 'qoder-cn',
    displayName: 'Qoder CN',
    labelWithAgent: false,
    accounts: new Proxy({}, { get: () => () => undefined }),
    router: {
      async execute(agentId, run) {
        const outcome = await run({ id: 'qoder-cn:test', agentId, label: 't', credentials: {}, enabled: true, createdAt: 0, updatedAt: 0 })
        return { ok: true, accountId: 'qoder-cn:test', attempts: [], value: outcome.value }
      },
    },
    adapterOf: () => backend,
    contextOf: () => ({ config: {}, log: silent, http: async () => ({}), cache: {}, now: () => Date.now() }),
    modelsOf: async () => [
      { id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 },
    ],
    exposedModelsOf: async () => [],
    onRequest: (sample) => samples.push(sample),
    log: silent,
  })

  const startedAt = Date.now()
  const chunks = await drain(adapter)
  const elapsed = Date.now() - startedAt

  assert.ok(hung, '假适配器应当确实走到了「挂着不放」那一步')
  // 250ms 上限 + 一点调度余量。给到 2000ms 是为了容忍 CI 抖动，
  // 但**远小于**「永远等下去」——挂死的话这条用例会超时失败。
  assert.ok(elapsed < 2000, `drain 超时后必须及时收尾，实际等了 ${elapsed}ms`)
  assert.equal(samples.length, 1, '超时路径也要留下一条采样（不能因为没等到 usage 就不记）')
  assert.equal(samples[0].ok, true)
  assert.equal(samples[0].outputTokens, undefined, '没等到 usage 就不该编 token')
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1, 'finish 只能有一个')
})

// ───────────────────── DSH 侧 chunk 形状（既有行为的回归） ─────────────────────

test('正文与思维链各占一块，block-end 带累积正文（覆盖式赋值那条坑）', async () => {
  const { adapter } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [
      { type: 'reasoning', text: '想' },
      { type: 'reasoning', text: '想' },
      { type: 'text', text: '你' },
      { type: 'text', text: '好' },
      { type: 'finish', reason: 'stop' },
    ],
  })
  const chunks = await drain(adapter)
  const textEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
  const reasonEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'reasoning')
  assert.equal(textEnd?.block.text, '你好', 'block-end 必须带**完整**正文，否则用户看到的会被冲成空')
  assert.equal(reasonEnd?.block.text, '想想')
  assert.equal(
    new Set([textEnd.index, reasonEnd.index]).size,
    2,
    '正文与思维链必须各占一个块下标',
  )
})

test('★ finish 之后又来一个 error（drain 窗口内）→ 块不能关两次', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'auto', name: 'Auto', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0.5 }],
    events: [
      { type: 'text', text: '你好' },
      { type: 'finish', reason: 'stop' },
      // 收完尾之后上游又补一帧 error —— 现实里少见，但 drain 窗口开着就可能撞上。
      { type: 'error', failure: { kind: 'server', message: '收尾后报错', at: Date.now() } },
    ],
  })
  const chunks = await drain(adapter)
  const textEnds = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
  assert.equal(textEnds.length, 1, `正文块只能关一次，实际 ${textEnds.length} 次`)
  assert.equal(textEnds[0].block.text, '你好', '关块那次必须带完整正文（再关一次就会用空串把它冲掉）')
  assert.equal(samples.length, 1, '采样只能一条（settle 幂等）')
})

// ───────────────────── Qoder 请求体：不请求 stream_options ─────────────────────

/**
 * ★ 这条钉的是**一个被实测否掉的假设**。
 *
 * 曾经怀疑「Qoder token 拿不到是因为没请求 `stream_options.include_usage`」
 * （opencode / buddy 的请求体里都有）。2026-10-20 真打上游（qoder-cn 真实账号，
 * 5 个模型）实测：**不带也能拿到 usage 帧**，带上结果一模一样（一律 200）。
 *
 * 既然上游本就会发，加这个字段只有风险（上游改协议时多一个被 400 的面）
 * 没有收益 —— 所以**不加**。这条用例防止将来有人「顺手补上」。
 *
 * ⚠️ 注意 Qoder 的请求体是 WASM **加密**的，所以这里断言的是
 * 「明文载荷构造器没有被要求带这个字段」这件事本身：
 * 用假 fetch 截住真实请求，断言加密体里**不含**该字段名。
 * 加密后字节里当然不该出现明文键名 —— 若出现了，说明加密没生效（更严重的问题）。
 */
test('★ Qoder 请求体不带 stream_options（实测多余：上游本就会发 usage 帧）', async () => {
  const adapter = new QoderAdapter('qoder-cn')
  const account = {
    id: 'qoder-cn:test',
    agentId: 'qoder-cn',
    label: 'test',
    enabled: true,
    credentials: {
      security_oauth_token: 'fake-token',
      access_token: 'fake-token',
      machine_id: '00000000-0000-4000-8000-000000000000',
      uid: '00000000-0000-4000-8000-000000000000',
    },
  }
  /** 截住真实请求：不真打上游，只把 body 拿下来看。 */
  let sentBody
  let sentUrl
  const ctx = {
    config: { requestTimeoutMs: 1000, retry: { maxAttempts: 1, backoffMs: 1, maxBackoffMs: 1 } },
    log: silent,
    http: async () => ({ ok: true }),
    cache: {},
    now: () => Date.now(),
    fetch: async (url, init) => {
      sentUrl = String(url)
      sentBody = init?.body
      // 回一个空的 SSE，让调用方正常收尾（我们只关心发出去什么）。
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  }

  // WASM 需要真实凭据才能建立签名上下文；这里直接跑，失败也没关系 ——
  // 我们只要求「如果它真的发了请求，body 里不该有 stream_options」。
  try {
    for await (const _event of adapter.requestChatStream(
      { model: 'auto', messages: [{ role: 'user', content: '你好' }], stream: true },
      account,
      ctx,
      new AbortController().signal,
    )) {
      // 全部消费掉
    }
  } catch {
    // 没有真实凭据时 WASM 可能拒绝签名 —— 这与被测行为无关。
  }

  if (sentBody === undefined) {
    // 连请求都没发出去（WASM 需要真账号）：这条用例退化成「什么都没验证」，
    // 但我们仍要断言**明文载荷构造器**没有引入该字段。
    const { buildQoderInferPayload } = await import('../lib/vendor/qoder/qoder-wasm.js')
    const payload = buildQoderInferPayload({ modelKey: 'auto', userText: '你好' })
    assert.equal(
      payload.parameters.stream_options,
      undefined,
      '载荷构造器不该带 stream_options（实测多余，见 qoder.ts 的实测表）',
    )
    return
  }

  assert.ok(typeof sentBody === 'string' && sentBody.length > 0, '应当发出加密请求体')
  // 加密体里**不该**出现明文键名；出现了说明加密没生效。
  assert.ok(
    !sentBody.includes('include_usage'),
    `加密请求体里出现了明文 include_usage —— 要么加密失效，要么真的加了这个字段：${sentUrl}`,
  )
})

// ───────── 用户报障：「日志的模型名全是 qfmodel，不是真实选中的模型」 ─────────

/**
 * ⚠️ **2026-10-20 用户报障**：「请求日志的模型名全部都是 `qfmodel`，
 * 并不是真实选中的模型名称。」
 *
 * 查下来记录**没错** —— `qfmodel` 就是上游目录 key、也正是我们发出去的值。
 * 问题是它**在界面上不可见**：选择器里写的是 `Qwen3.8-Flash`。
 * 两套词汇对不上，用户自然认为日志记错了。
 *
 * 修法：采样同时存两个字段 ——
 * `model`（目录 key，排查时要看的就是它）与
 * `modelName`（展示名，与选择器一致；界面优先显示它，key 放进 `title`）。
 *
 * ⚠️ 取不到展示名时**不写**这个键，界面退回显示 id ——
 * 绝不拿 id 冒充名字（那正是这条报障的成因）。
 */
test('日志同时记 id 与展示名：model 是目录 key，modelName 是选择器里那个名字', async () => {
  const { adapter, samples } = harness({
    models: [{ id: 'qfmodel', name: 'Qwen3.8-Flash', agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 0, free: true }],
    events: [
      { type: 'text', text: '你好' },
      { type: 'finish', reason: 'stop' },
    ],
  })
  await drain(adapter, 'qoder-cn/qfmodel')

  assert.equal(samples.length, 1)
  assert.equal(samples[0].model, 'qfmodel', 'model 必须保留目录 key —— 它才是真正发上游的值')
  assert.equal(
    samples[0].modelName,
    'Qwen3.8-Flash',
    'modelName 必须是选择器里显示的名字（否则用户读不懂日志）',
  )
})

test('日志：取不到展示名时不写 modelName（绝不拿 id 冒充名字）', async () => {
  // 模型不在上报列表里（用户没勾选）→ 拿不到元数据。
  const { adapter, samples } = harness({
    models: [],
    events: [
      { type: 'text', text: '你好' },
      { type: 'finish', reason: 'stop' },
    ],
  })
  await drain(adapter, 'qoder-cn/auto')

  assert.equal(samples[0].model, 'auto', 'id 仍然要记（排查全靠它）')
  assert.equal(
    Object.hasOwn(samples[0], 'modelName'),
    false,
    'modelName 缺失时不该编一个 —— 界面会退回显示 id',
  )
})

test('日志：展示名与 id 不同名时必须两个都在（Qoder 的 key 与名字完全两套词汇）', async () => {
  // 逐条对照真实的 key ↔ 名字，防止哪天有人「顺手」把 model 改写成展示名、
  // 或者把两者合并成一个字段 —— 两种改法都会让排查失去依据。
  const cases = [
    { id: 'auto', name: 'Auto' },
    { id: 'qfmodel', name: 'Qwen3.8-Flash' },
    { id: 'dfmodel', name: 'DeepSeek-Flash' },
    { id: 'qmodel_38max', name: 'Qwen3.8-Max' },
    { id: 'cmodel', name: 'Cantus' },
  ]
  for (const c of cases) {
    const { adapter, samples } = harness({
      models: [{ id: c.id, name: c.name, agentId: 'qoder-cn', agentName: 'Qoder CN', multiplier: 1 }],
      events: [
        { type: 'text', text: 'x' },
        { type: 'finish', reason: 'stop' },
      ],
    })
    await drain(adapter, `qoder-cn/${c.id}`)
    assert.equal(samples[0].model, c.id, `${c.id} 的目录 key 必须原样保留`)
    assert.equal(samples[0].modelName, c.name, `${c.id} 的展示名必须是 ${c.name}`)
  }
})
