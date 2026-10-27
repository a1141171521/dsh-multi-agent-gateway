/**
 * 真机活体验证：用**构建后的适配器**（lib/adapters/raccoon.js）真打商汤小浣熊上游。
 *
 * 与单测的分工：
 *   - 单测证明「代码符合我抓到的报文形状」；
 *   - 这个脚本证明「我抓到的报文形状就是上游现在的样子」。
 *
 * 用法：node test/live-raccoon.mjs
 * 凭证：自动读客户端 auth.json（与插件运行时同一条路）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RaccoonAdapter, RACCOON_ORIGIN, RACCOON_PATHS, readRaccoonClientToken, jwtExpiresAtMs } from '../lib/adapters/raccoon.js'
import { createHttp } from '../lib/core/http.js'
import { createLlmAdapter } from '../lib/llm/adapter.js'
import { AdapterRegistry } from '../lib/core/registry.js'
import { AccountManager } from '../lib/core/accounts.js'
import { AccountRouter } from '../lib/core/router.js'

const log = {
  debug: () => {},
  info: (m, ...r) => console.log('  [info]', m, ...r),
  warn: (m, ...r) => console.warn('  [warn]', m, ...r),
  error: (m, ...r) => console.error('  [error]', m, ...r),
  child: () => log,
}

const found = readRaccoonClientToken()
if (found === undefined) {
  console.error('✗ 没找到客户端登录态（~/.office-raccoon/agent/config/auth.json）')
  process.exit(1)
}
const exp = jwtExpiresAtMs(found.token)
console.log(`凭证来源: ${found.path}`)
console.log(`token 长度: ${found.token.length}，有效期至 ${exp === undefined ? '未知' : new Date(exp).toISOString()}`)

const adapter = new RaccoonAdapter()
const ctx = {
  config: {
    id: 'raccoon',
    name: '商汤小浣熊',
    requestTimeoutMs: 120_000,
    upstream: {
      chatBaseUrl: `${RACCOON_ORIGIN}${RACCOON_PATHS.chatBase}`,
      apiBaseUrl: RACCOON_ORIGIN,
      modelsUrl: '',
    },
    credits: { unit: 'credits', baselineUsdPerMTok: 1.2, round: 2 },
  },
  log,
  cache: (() => {
    const store = new Map()
    return { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k), keys: () => [...store.keys()] }
  })(),
  now: () => Date.now(),
  http: createHttp(log, 60_000),
  fetch: (url, init) => fetch(url, init),
}

/** 没填 token 的账号 —— 适配器会回落到客户端登录态，这正是要验证的那条路。 */
const account = {
  id: 'raccoon:live',
  agentId: 'raccoon',
  label: 'live',
  enabled: true,
  routeChat: true,
  credentials: {},
}

let failures = 0
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ✓ ${label}`)
  } catch (error) {
    console.log(error.stack)
    failures += 1
    console.log(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('\n==== 1. 凭证 / 额度 / 签到 ====')
await check('validateCredentials → ok（自动读到客户端 token）', async () => {
  const verdict = await adapter.validateCredentials(account, ctx)
  console.log('    →', verdict.message)
  assert.equal(verdict.ok, true, verdict.message)
})

await check('getQuota → credits，remaining 是数字', async () => {
  const quota = await adapter.getQuota(account, ctx)
  console.log('    →', JSON.stringify({ unit: quota.unit, remaining: quota.remaining, error: quota.error }))
  assert.equal(quota.unit, 'credits')
  assert.equal(typeof quota.remaining, 'number')
  assert.equal(quota.error, undefined)
})

await check('checkIn → supported，且 coversToday 必为 true', async () => {
  const result = await adapter.checkIn(account, ctx)
  console.log('    →', result.ok, result.message)
  assert.equal(result.supported, true)
  assert.equal(result.coversToday, true)
})

console.log('\n==== 2. 模型目录 ====')
let models = []
await check('getModelMetaList → 至少 7 个模型，倍率三态齐全', async () => {
  models = await adapter.getModelMetaList(account, ctx)
  for (const m of models) {
    console.log(`    ${m.id.padEnd(28)} ×${String(m.multiplier ?? '?').padEnd(5)} free=${String(m.free === true).padEnd(5)} reason=${String(m.reasoning === true).padEnd(5)} ctx=${m.contextWindow ?? '—'}`)
  }
  assert.ok(models.length >= 7, `只拿到 ${models.length} 个模型`)
  // 实付 0 的必须标免费
  const free = models.filter((m) => m.free === true)
  assert.ok(free.length >= 1, '应当有实付 0 的免费模型')
  // 每个都必须声明 8 个档位
  for (const m of models) assert.equal(m.reasoningEfforts.length, 8, `${m.id} 档位表不对`)
})

console.log('\n==== 3. 对话（真流式）====')
await check('纯文本流：思维链 + 正文 + usage + finish 都有', async () => {
  const picked = models.find((m) => m.id === 'sn-deepseek-v4-1-flash-1017') ?? models[0]
  let reasoning = '', text = '', usage = null, finish = null
  for await (const event of adapter.requestChatStream(
    { model: picked.id, messages: [{ role: 'user', content: '用一句话说明你是谁' }], stream: true },
    account, ctx, new AbortController().signal,
  )) {
    if (event.type === 'reasoning') reasoning += event.text
    if (event.type === 'text') text += event.text
    if (event.type === 'usage') usage = event.usage
    if (event.type === 'finish') finish = event.reason
    if (event.type === 'error') throw new Error(`上游报错：${event.failure.kind} ${event.failure.message}`)
  }
  console.log(`    model=${picked.id} reason=${reasoning.length} text=${text.length} usage=${usage ? `${usage.inputTokens}/${usage.outputTokens}` : 'none'} finish=${finish}`)
  console.log(`    正文: ${JSON.stringify(text.slice(0, 60))}`)
  assert.ok(text.length > 0, '正文不能为空')
  assert.notEqual(finish, null)
  assert.notEqual(usage, null, '没拿到 usage（DSH 日志会缺 token 统计）')
})

await check('工具调用：finish_reason=tool_calls，arguments 能拼成合法 JSON', async () => {
  const picked = models.find((m) => m.id === 'sn-deepseek-v4-1-flash-1017') ?? models[0]
  const chunks = []
  let finish = null
  for await (const event of adapter.requestChatStream({
    model: picked.id,
    messages: [{ role: 'user', content: 'What is the weather in Beijing? Use the tool.' }],
    tools: [{
      type: 'function',
      function: { name: 'get_weather', description: 'Get current weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    }],
    tool_choice: 'auto',
    stream: true,
  }, account, ctx, new AbortController().signal)) {
    if (event.type === 'tool_call') chunks.push(event)
    if (event.type === 'finish') finish = event.reason
    if (event.type === 'error') throw new Error(`上游报错：${event.failure.kind} ${event.failure.message}`)
  }
  const byIndex = new Map()
  for (const chunk of chunks) {
    const cur = byIndex.get(chunk.index) ?? { id: '', name: '', arguments: '' }
    if (chunk.id) cur.id = chunk.id
    if (chunk.name) cur.name = chunk.name
    if (chunk.argumentsDelta) cur.arguments += chunk.argumentsDelta
    byIndex.set(chunk.index, cur)
  }
  const calls = [...byIndex.values()]
  console.log(`    finish=${finish} calls=${JSON.stringify(calls).slice(0, 160)}`)
  assert.equal(finish, 'tool_calls')
  assert.ok(calls.length >= 1)
  assert.notEqual(calls[0].id, '')
  assert.deepEqual(Object.keys(JSON.parse(calls[0].arguments)), ['city'])
})

console.log('\n==== 4. 经 DSH LLM 适配器（真实装配链路）====')
await check('createLlmAdapter → listModels / resolveModel / stream 全通', async () => {
  // ⚠️ 用**真的** AccountManager + AccountRouter，不再拿手写假对象糊过去。
  //
  // 上一版这里手写了 `accounts` / `router` 两个假对象，结果 `router.execute`
  // 的返回形状不对（真实现返回 `{ok, accountId, attempts}` 包一层），
  // 测试直接炸在 `attempts.length` 上 —— 假对象只能证明「我自己以为的形状」。
  // 换成真组件之后，这条路径就是 DSH 真正走的那条。
  const registry = new AdapterRegistry()
  registry.register(adapter)
  const tmpDir = mkdtempSync(join(tmpdir(), 'mag-live-raccoon-'))
  const accounts = new AccountManager(tmpDir, log, { v: 1, updatedAt: 0, health: {}, quota: {} })
  // 故意**不填 token**：验证「零配置自动读客户端登录态」这条真实路径。
  const record = accounts.add({ agentId: 'raccoon', label: 'live', credentials: {} })
  const router = new AccountRouter(accounts, { routing: 'quota-first', degradeAfterFailures: 2, penaltySec: 300, recoverIntervalSec: 600, maxAccountAttempts: 3, maxConcurrentRequests: 4 }, log)

  let lastSample = null
  const llm = createLlmAdapter({
    agentId: 'raccoon',
    displayName: '商汤小浣熊',
    labelWithAgent: true,
    accounts,
    router,
    log,
    modelsOf: () => adapter.getModelMetaList(record, ctx),
    adapterOf: (id) => (id === 'raccoon' ? adapter : undefined),
    contextOf: (id) => (id === 'raccoon' ? ctx : undefined),
    onRequest: (sample) => { lastSample = sample },
  })
  const list = await llm.listModels('multiagent-raccoon')
  console.log(`    listModels → ${list.length} 个`)
  console.log(`    第一行标签: ${list[0].name}`)
  assert.ok(list.length >= 7)
  assert.match(list[0].name, /商汤小浣熊 · /)
  assert.match(list[0].name, /\(免费\)|\(×/)

  const resolved = await llm.resolveModel('multiagent-raccoon', list[0].id)
  console.log(`    resolveModel → ctx=${resolved.context?.contextWindow} maxTokens=${resolved.defaultMaxTokens} efforts=${resolved.reasoning?.efforts.length}`)
  assert.equal(resolved.reasoning.efforts.length, 8, '档位行应当是 8 个规范名')

  // 真跑一次流，确认 pump 能收尾（这是 DSH 侧的真正入口）。
  //
  // ⚠️ 判据用 `text-delta`（DSH 的增量 chunk），**不是** `text` ——
  // `text` 是插件内部的 `StreamEvent` 名，DSH 那一层叫 `text-delta`。
  const { model, stream } = await llm.prepareCall('multiagent-raccoon', list[0].id)
  let text = ''
  let done = false
  let usageChunk = null
  for await (const chunk of stream({ model: model.id, messages: [{ role: 'user', content: '说两个字' }] })) {
    if (chunk.type === 'text-delta' && chunk.text) text += chunk.text
    if (chunk.type === 'usage') usageChunk = chunk.usage
    if (chunk.type === 'finish') done = true
  }
  console.log(`    stream → text=${JSON.stringify(text.slice(0, 40))} finished=${done} usage=${usageChunk ? `${usageChunk.inputTokens}/${usageChunk.outputTokens}` : 'none'}`)
  assert.equal(done, true, '没收到 finish，DSH 会一直转圈')
  assert.ok(text.length > 0, '正文不能为空（块被覆盖会变成空串）')
  assert.notEqual(usageChunk, null, 'usage 没到 DSH —— 日志的 token 列会是 —')

  // 请求日志采样：账号必须是真 id（不是 null），倍率必须是免费（这条流挑的是 ×0 的模型）。
  console.log(`    采样 → ok=${lastSample?.ok} account=${lastSample?.accountId} multiplier=${lastSample?.multiplier} free=${lastSample?.free} in/out=${lastSample?.inputTokens}/${lastSample?.outputTokens} tps=${lastSample?.tps}`)
  assert.equal(lastSample.ok, true)
  assert.equal(lastSample.accountId, record.id, '请求日志必须记到真实账号，不能是 null')
  assert.equal(lastSample.multiplier, 0)
  assert.equal(lastSample.free, true)
  assert.ok(lastSample.outputTokens > 0, 'token 统计不能为 0')
  rmSync(tmpDir, { recursive: true, force: true })
})

console.log(`\n${failures === 0 ? '✓ 全部通过' : `✗ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
