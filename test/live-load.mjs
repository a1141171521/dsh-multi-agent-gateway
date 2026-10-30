/**
 * 真机负载验证（发布前清单 §6）：**真账号、真上游、真并发**。
 *
 * 单测证明「代码符合我抓到的报文形状」，这个脚本证明「上游现在的样子还是那样」，
 * 顺便把清单 §6 里人肉做不到的几项量出来：
 *
 *   1. 会话头是否真的发出去了、跨轮是否稳定（issue #2 的前缀缓存 key）
 *   2. 同一前缀连续多轮，第 2、3 轮的 cacheReadTokens 是否 > 0
 *   3. 并发 N × 连续 M 次：成功率、P50 / P95
 *   4. 撞到 429 时，失败对象里有没有 retryAfterMs（issue #6）
 *
 * 用法：
 *   node test/live-load.mjs --agent workbuddy --rounds 3
 *   node test/live-load.mjs --agent workbuddy --concurrency 4 --requests 20
 *   node test/live-load.mjs --agent workbuddy-intl --requests 5
 *   node test/live-load.mjs --agent raccoon --requests 5
 *
 * 凭证：读插件数据目录（`~/.dsh/multi-agent-gateway`），与运行时同一条路。
 * **不打印**账号 id / token / 余额 —— 只打印 agent 名和聚合数字。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { AccountManager } from '../lib/core/accounts.js'
import { createHttp } from '../lib/core/http.js'
import { BuddyAdapter, BUDDY_CN, BUDDY_INTL } from '../lib/adapters/buddy.js'
import { RaccoonAdapter } from '../lib/adapters/raccoon.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}

const agentId = arg('agent', 'workbuddy')
const rounds = Number(arg('rounds', '3'))
const concurrency = Number(arg('concurrency', '1'))
const requests = Number(arg('requests', '0'))
const modelArg = arg('model', '')
const dataDir = arg('data', join(homedir(), '.dsh', 'multi-agent-gateway'))

const log = {
  debug: () => {},
  info: () => {},
  warn: (m, ...r) => console.warn('  [warn]', m, ...r),
  error: (m, ...r) => console.error('  [error]', m, ...r),
  child: () => log,
}

const state = { v: 1, updatedAt: 0, health: {}, quota: {}, models: {}, schedule: {} }
const manager = new AccountManager(dataDir, log, state)
const loaded = manager.load()
if (!loaded.ok) {
  console.error(`✗ 账号装载失败：${loaded.error}`)
  process.exit(1)
}

const candidates = manager.all().filter((a) => a.agentId === agentId && a.enabled !== false)
if (candidates.length === 0) {
  console.error(`✗ 没有可用的 ${agentId} 账号（共装载 ${loaded.count} 个）`)
  process.exit(1)
}
const account0 = candidates[0]
let account = account0

/** 记录对话请求实际发出的头（只记存在的键 + 值指纹，不打印值）。 */
const seenHeaders = []
const ctx = {
  config: {
    id: agentId,
    name: agentId,
    requestTimeoutMs: 120_000,
    upstream: { apiBaseUrl: '', chatBaseUrl: '', modelsUrl: '' },
    credits: { unit: 'credits', baselineUsdPerMTok: 1.2, round: 2 },
  },
  log,
  cache: (() => {
    const store = new Map()
    return {
      get: (k) => store.get(k),
      set: (k, v) => store.set(k, v),
      delete: (k) => store.delete(k),
      keys: () => [...store.keys()],
    }
  })(),
  now: () => Date.now(),
  http: createHttp(log, 60_000),
  fetch: (url, init) => {
    const headers = init?.headers ?? {}
    const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers)
    const picked = {}
    for (const [key, value] of entries) {
      const lower = String(key).toLowerCase()
      if (lower.startsWith('x-conversation') || lower.startsWith('x-root-request')) {
        picked[lower] = String(value)
      }
    }
    seenHeaders.push(picked)
    return fetch(url, init)
  },
}

const adapter =
  agentId === 'raccoon' ? new RaccoonAdapter() : new BuddyAdapter(agentId === 'workbuddy-intl' ? BUDDY_INTL : BUDDY_CN)

const signal = new AbortController().signal

async function chat(messages) {
  const started = Date.now()
  let text = ''
  let usage
  let failure
  let finish
  for await (const event of adapter.requestChatStream({ model, messages, stream: true }, account, ctx, signal)) {
    if (event.type === 'text') text += event.text
    if (event.type === 'usage') usage = event.usage
    if (event.type === 'finish') finish = event.reason
    if (event.type === 'error') failure = event.failure
  }
  return { ms: Date.now() - started, text, usage, failure, finish }
}

const percentile = (values, p) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

console.log(`agent=${agentId} 账号数=${candidates.length} 模型=${modelArg || '(自动)'}`)

let models = []
try {
  models = await adapter.getModelMetaList(account0, ctx)
} catch (error) {
  console.error(`✗ getModelMetaList 失败：${error instanceof Error ? error.message : String(error)}`)
}
console.log(`模型目录：${models.length} 个（${adapter.modelListSource?.() ?? 'live'}）`)

const model = modelArg || models[0]?.id
if (!model) {
  console.error('✗ 没有可用模型')
  process.exit(1)
}
console.log(`模型前 8 个：${models.slice(0, 8).map((m) => m.id).join(', ')}`)

// `--list`：只看目录（含推理档位），不发对话 —— 用来验证「兜底表是否带档位」（issue #4）。
if (argv.includes('--list')) {
  for (const m of models) {
    const efforts = Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.join('/') : '—'
    console.log(`  ${String(m.id).padEnd(26)} reasoning=${String(m.reasoning === true).padEnd(5)} efforts=${efforts.padEnd(16)} default=${m.defaultReasoningEffort ?? '—'}`)
  }
  process.exit(0)
}

console.log(`实际使用：${model}`)

// 上游风控是**按账号**判的，第一个账号不一定能用 —— 逐个试一句。
let probed = 0
for (const candidate of candidates) {
  probed += 1
  account = candidate
  const result = await chat([{ role: 'user', content: '只回答一个字「好」。' }])
  const ok = result.failure === undefined && result.text.length > 0
  const detail = ok ? '' : `（${result.failure?.kind} ${String(result.failure?.message ?? '').slice(0, 50)}）`
  console.log(`  账号 ${probed}/${candidates.length}：${ok ? '可用' : '不可用'}${detail}`)
  if (ok) break
}

// ── 1. 前缀缓存：同一段长前缀 + 每轮不同的短问题 ──
// `--prefix-lines`：前缀太短上游不会建缓存（多数实现有最小可缓存长度），默认可调。
const prefixLines = Number(arg('prefix-lines', '40'))
const prefix = [
  '你在做一次长文档校对。下面是一份内部规范，读完后只回答我最后提的问题，不要复述规范。',
  Array.from({ length: prefixLines }, (_, i) => `第 ${i + 1} 条：所有对外接口必须在失败时返回可读的原因，不得吞掉上游原始报错。`).join('\n'),
].join('\n\n')

console.log(`\n==== 1. 前缀缓存（${rounds} 轮，同前缀）====`)
const cacheRows = []
for (let i = 1; i <= rounds; i += 1) {
  const result = await chat([
    { role: 'user', content: prefix },
    { role: 'user', content: `第 ${i} 轮：只回答一个字「好」。` },
  ])
  const row = {
    round: i,
    ok: result.failure === undefined && result.text.length > 0,
    ms: result.ms,
    cacheRead: result.usage?.cacheReadTokens ?? 0,
    cacheWrite: result.usage?.cacheWriteTokens ?? 0,
    prompt: result.usage?.inputTokens ?? 0,
    err: result.failure ? `${result.failure.kind} ${result.failure.message}` : '',
  }
  cacheRows.push(row)
  console.log(
    `  第 ${i} 轮  ${row.ok ? '✓' : '✗'}  ${String(row.ms).padStart(6)}ms  ` +
      `prompt=${row.prompt} cacheRead=${row.cacheRead} cacheWrite=${row.cacheWrite} ${row.err}`,
  )
}

const headerRows = seenHeaders.filter((h) => Object.keys(h).length > 0)
if (headerRows.length > 0) {
  const ids = headerRows.map((h) => h['x-conversation-id']).filter(Boolean)
  const rootIds = headerRows.map((h) => h['x-root-request-id']).filter(Boolean)
  const uniqueConv = new Set(ids)
  console.log(
    `  会话头：${headerRows.length} 条请求带会话头，` +
      `x-conversation-id ${uniqueConv.size === 1 ? '跨轮稳定 ✓' : `跨轮变了 ${uniqueConv.size} 次 ✗`}` +
      (rootIds.length > 0 ? `，x-root-request-id 存在` : ''),
  )
}

// ── 2. 并发负载 ──
if (requests > 0) {
  console.log(`\n==== 2. 并发 ${concurrency} × 共 ${requests} 次 ====`)
  const results = []
  let cursor = 0
  const worker = async () => {
    while (cursor < requests) {
      cursor += 1
      const index = cursor
      const result = await chat([{ role: 'user', content: `第 ${index} 次：只回答一个字「好」。` }])
      results.push({ index, ...result })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, worker))

  const ok = results.filter((r) => r.failure === undefined && r.text.length > 0)
  const ms = ok.map((r) => r.ms)
  const kinds = new Map()
  for (const r of results) {
    if (r.failure === undefined) continue
    const key = `${r.failure.kind}｜${r.failure.message}`.slice(0, 120)
    kinds.set(key, (kinds.get(key) ?? 0) + 1)
  }
  console.log(`  成功 ${ok.length}/${results.length}（${((ok.length / results.length) * 100).toFixed(1)}%）`)
  console.log(`  P50 ${percentile(ms, 50)}ms   P95 ${percentile(ms, 95)}ms   max ${Math.max(...ms, 0)}ms`)
  for (const [key, count] of kinds) console.log(`  失败 ×${count}：${key}`)
  // 429 / 限流能不能给出恢复时间，是 issue #6 的核心
  const retryHints = results.filter((r) => r.failure?.retryAfterMs > 0)
  if (retryHints.length > 0) {
    console.log(`  带 retryAfterMs 的失败：${retryHints.length} 条，示例 ${retryHints[0].failure.retryAfterMs}ms`)
  }
}

const failed = cacheRows.filter((r) => !r.ok).length
process.exitCode = failed > 0 ? 1 : 0
