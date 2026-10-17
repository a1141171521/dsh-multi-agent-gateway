/**
 * 管线演示：真实形状的假上游 → 真实适配器 → DSH 的 chunk 序列。
 *
 * 为什么要有这个：上游免费层的门禁会按出口 IP 限流（实测：目录 200、只有 chat 403），
 * 那样就没法用真网络演示「工具调用 / 思考链 / 结尾」这三件事。
 * 这里用一段**与上游 SSE 完全同形状**的脚本来驱动整条管线（不 mock 任何自己的代码），
 * 所以能确定性地证明这三项。
 *
 * 用法：node test/demo-pipeline.mjs
 */
import { MemoryCache } from '../lib/core/cache.js'
import { createLlmAdapter } from '../lib/llm/adapter.js'
import { OpenCodeAdapter } from '../lib/adapters/opencode.js'

const line = (args) => args.filter((item) => typeof item === 'string').join(' ')
const log = { debug() {}, info() {}, warn: (...a) => console.log('  [warn]', line(a)), error: (...a) => console.log('  [error]', line(a)), child: () => log }

/** 上游 SSE：思考 → 正文 → 工具调用（两帧增量）→ finish_reason=tool_calls */
const UPSTREAM_SSE = [
  'data: {"choices":[{"delta":{"reasoning_content":"用户要执行命令，我先确认一下。"}}]}',
  'data: {"choices":[{"delta":{"content":"我来执行这条命令。"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"pwsh","arguments":"{\\"command\\":"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"echo hi\\"}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  'data: [DONE]',
  '',
].join('\n\n')

const ctx = {
  config: {
    id: 'opencode',
    name: 'OpenCode',
    upstream: {
      chatBaseUrl: 'https://opencode.ai/inference/openai/v1',
      apiBaseUrl: 'https://opencode.ai/console',
      modelsUrl: 'https://opencode.ai/inference/v1/models',
      freeTierMode: 'auto',
    },
    credits: { unit: 'usd', baselineUsdPerMTok: 1.2 },
    requestTimeoutMs: 30_000,
  },
  log,
  http: async () => ({ ok: true, status: 200, kind: 'none', headers: new Headers(), body: {}, text: '{}' }),
  cache: new MemoryCache(),
  now: () => Date.now(),
  /** 假上游：把脚本文本变成流式 Response。 */
  fetch: async () => new Response(UPSTREAM_SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
}

const backend = new OpenCodeAdapter()
const account = {
  id: 'opencode:anonymous',
  agentId: 'opencode',
  label: '(匿名)',
  credentials: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

const adapter = createLlmAdapter({
  agentId: 'opencode',
  displayName: 'OpenCode',
  labelWithAgent: true,
  accounts: new Proxy({}, { get: () => () => undefined }),
  router: {
    async execute(agentId, run) {
      const outcome = await run({ ...account, agentId })
      if (outcome.ok === true) return { ok: true, accountId: account.id, attempts: [], value: outcome.value }
      return { ok: false, accountId: account.id, attempts: [], failure: { kind: outcome.kind, message: outcome.message } }
    },
  },
  adapterOf: () => backend,
  contextOf: () => ctx,
  modelsOf: async () => [],
  exposedModelsOf: async () => [],
  log,
})

const chunks = []
for await (const chunk of adapter.stream({
  provider: 'multiagent-opencode',
  model: 'opencode/deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: '执行 echo hi' }],
  system: 'you are helpful',
  tools: [
    {
      name: 'pwsh',
      description: 'Run a PowerShell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  ],
})) {
  chunks.push(chunk)
}

console.log('上游 SSE（假，与真实形状一致）→ DSH chunk 序列：\n')
for (const chunk of chunks) {
  const detail =
    chunk.type === 'block-start' ? `index=${chunk.index} type=${chunk.blockType}`
    : chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? `index=${chunk.index} ${JSON.stringify(chunk.text)}`
    : chunk.type === 'tool-call-delta' ? `index=${chunk.index} id=${chunk.id} name=${chunk.name ?? '-'} args+=${JSON.stringify(chunk.argumentsDelta)}`
    : chunk.type === 'block-end' ? `index=${chunk.index} ${JSON.stringify(chunk.block).slice(0, 90)}`
    : chunk.type === 'finish' ? JSON.stringify(chunk.reason)
    : JSON.stringify(chunk)
  console.log(`  ${chunk.type.padEnd(16)} ${detail}`)
}

// ── 断言三项 ──────────────────────────────────────────────
const problems = []
const has = (type) => chunks.some((chunk) => chunk.type === type)

const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
const finish = chunks.find((c) => c.type === 'finish')
const toolEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')

console.log('\n=== 三项检查 ===')
if (reasoning.length > 0 && has('reasoning-delta')) console.log(`  ② 思考链：✅ ${JSON.stringify(reasoning)}`)
else problems.push('思考链没有输出')

if (deltas.length > 0 && new Set(deltas.map((d) => d.id)).size === 1 && new Set(deltas.map((d) => d.index)).size === 1) {
  console.log(`  ① 工具调用：✅ ${deltas.length} 帧增量，id 稳定=${deltas[0].id}，参数拼回=${JSON.stringify(toolEnd?.block?.arguments)}`)
} else problems.push('工具调用的增量/id/块下标不对')

if (finish?.reason?.kind === 'tool-calls') console.log(`  ③ 结尾：✅ finish=${finish.reason.kind}（DSH 据此才会去执行工具）`)
else problems.push(`结尾 kind 不对：${finish?.reason?.kind}`)

if (text.length > 0) console.log(`  附：正文 ✅ ${JSON.stringify(text)}`)
else problems.push('正文没有输出')

console.log()
if (problems.length > 0) {
  console.error('✗ 有问题：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('✓ 三项全部正常（思考链 / 工具调用 / 结尾）')
