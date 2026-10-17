/**
 * 真机管线测试（可选，需要联网）：用**真实的** OpenCode 适配器打真实上游，
 * 验证「模型目录 + 倍率」这条链路真的能跑通。
 *
 * 它**不写任何账号**、**不发任何需要鉴权的请求** —— 只读公开的模型目录与
 * models.dev 价格表。所以它可以在没有账号的机器上跑，也不会碰到你的额度。
 *
 * 用法：`node test/live-opencode.mjs`
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { OpenCodeAdapter } = await import('../lib/adapters/opencode.js')
const { createHttp } = await import('../lib/core/http.js')
const { MemoryCache } = await import('../lib/core/cache.js')
const { formatMultiplier } = await import('../lib/core/types.js')
const { renderModelLabel } = await import('../lib/llm/adapter.js')

const dataDir = mkdtempSync(join(tmpdir(), 'mag-live-'))
/** 把 logger 的两三个参数拼成一行（**不要** `...arr.join()` —— 那会把字符串拆成单字符）。 */
const line = (args) => args.filter((item) => typeof item === 'string').join(' ')
const log = {
  debug() {},
  info: (...args) => console.log('[info]', line(args)),
  warn: (...args) => console.log('[warn]', line(args)),
  error: (...args) => console.log('[error]', line(args)),
  child() {
    return log
  },
}

const adapter = new OpenCodeAdapter()
const ctx = {
  config: {
    id: 'opencode',
    name: 'OpenCode',
    upstream: {
      chatBaseUrl: 'https://opencode.ai/inference/openai/v1',
      apiBaseUrl: 'https://opencode.ai/console',
      modelsUrl: 'https://opencode.ai/inference/v1/models',
    },
    credits: { unit: 'usd', baselineUsdPerMTok: 1.2 },
    requestTimeoutMs: 30_000,
  },
  log,
  http: createHttp(log, 30_000),
  cache: new MemoryCache(),
  now: () => Date.now(),
}

// 用一个「没有账号」的匿名记录：公开目录照样能拉（这正是设计意图）。
const anonymous = {
  id: 'opencode:anonymous',
  agentId: 'opencode',
  label: '(未配置账号)',
  credentials: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

const problems = []

const models = await adapter.getModelMetaList(anonymous, ctx)
console.log(`\n拉到 ${models.length} 个模型`)
if (models.length === 0) {
  // 空目录有两种可能：上游真的挂了，或者我们解析错了。**把原始响应当场打出来**
  // —— 只写一句「拉不到」等于让下一个人重新查一遍。
  const raw = await ctx.http(ctx.config.upstream.modelsUrl, { headers: { accept: 'application/json' } })
  console.log('  诊断：直接复读一次模型目录')
  console.log(`   status=${raw.status} ok=${raw.ok} kind=${raw.kind} ct=${raw.headers.get('content-type')}`)
  console.log(`   body(head)=${String(raw.text ?? '').slice(0, 200).replace(/\s+/g, ' ')}`)
  problems.push(`模型目录为空（诊断：status=${raw.status} kind=${raw.kind} body=${String(raw.text ?? '').slice(0, 120)}）`)
}

const withMultiplier = models.filter((item) => item.multiplier !== undefined)
const free = models.filter((item) => item.free === true)
console.log(`其中 ${withMultiplier.length} 个有倍率，${free.length} 个免费`)
if (withMultiplier.length === 0) problems.push('一个倍率都没算出来 —— 价格源可能没通')

console.log('\n选择器里前 12 行会显示成：')
for (const meta of models.slice(0, 12)) {
  console.log(`  ${renderModelLabel(meta, true)}` + (meta.contextWindow ? `  [ctx=${meta.contextWindow}]` : ''))
}

console.log('\n免费模型（前 10 个）：')
for (const meta of free.slice(0, 10)) console.log(`  ${meta.id} → ${renderModelLabel(meta, false)}`)

// 断言形态：必须长成 `OpenCode · <名字> (<标记>)`
for (const meta of models.slice(0, 20)) {
  const label = renderModelLabel(meta, true)
  if (!label.startsWith('OpenCode · ') || !/\((?:免费|×[\d.]+|未知倍率)\)$/.test(label)) {
    problems.push(`标签形态不对：${label}`)
    break
  }
}

// 额度：没有凭证时必须给「未知 + 原因」，而不是 0
const quota = await adapter.getQuota(anonymous, ctx)
console.log(`\n匿名额度：unit=${quota.unit} remaining=${quota.remaining ?? '未提供'}`)
console.log(`  原因：${quota.error ?? '(无)'}`)
if (quota.remaining === 0) problems.push('没有凭证却报了 remaining=0 —— 这是在用 0 冒充未知')

// 签到：官方没有这个接口，必须返回 supported:false 而不是抛错
const checkIn = await adapter.checkIn(anonymous, ctx)
console.log(`\n签到：supported=${checkIn.supported} ok=${checkIn.ok}`)
console.log(`  ${checkIn.message}`)
if (checkIn.supported !== false) problems.push('匿名账号签到居然报 supported=true')

// ── 免密钥到底行不行：空凭证必须去问上游，并给出确定的结论 ──
const verdict = await adapter.validateCredentials(anonymous, ctx)
console.log(`\n空凭证·测活：ok=${verdict.ok} kind=${verdict.kind ?? 'none'}`)
console.log(`  ${verdict.message}`)
if (verdict.kind === 'auth') {
  problems.push('空凭证被归成了 auth —— 会触发无意义的换号；FreeTierError 应该是 unsupported')
}
const keyless = await adapter.requestChatStream(
  { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
  anonymous,
  ctx,
  new AbortController().signal,
)
const streamIssues = []
for await (const event of keyless) {
  if (event.type === 'error') streamIssues.push(event.failure)
}
console.log(`\n空凭证·直连推理：${streamIssues.length} 个错误事件`)
for (const failure of streamIssues) console.log(`  kind=${failure.kind} status=${failure.status} ${failure.message}`)
if (streamIssues.length > 0 && streamIssues[0].kind === 'auth') {
  problems.push('免费层的 403 在流式路径上被归成了 auth —— 会误判成账号失效')
}

// ── 设备码登录：这是「不需要 API key 用免费模型」的正解 ──
console.log('\n=== OAuth 设备码登录（只发起，不代替用户授权）===')
try {
  const start = await adapter.startDeviceLogin(ctx)
  console.log(`  设备码     : ${start.userCode}`)
  console.log(`  授权链接   : ${start.verificationUrl}`)
  console.log(`  有效期     : ${start.expiresInSec} 秒，轮询间隔 ${start.intervalSec} 秒`)
  if (!start.verificationUrl.startsWith('https://opencode.ai/console/device')) {
    problems.push(`授权链接没有解析成绝对地址：${start.verificationUrl}`)
  }
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(start.userCode)) {
    problems.push(`设备码形状不对：${start.userCode}`)
  }
  // 还没授权的第一次轮询必须是 pending（不是 failure）
  const firstPoll = await adapter.pollDeviceLogin(start.deviceCode, ctx)
  console.log(`  首次轮询   : ${firstPoll.status} —— ${firstPoll.message}`)
  if (firstPoll.status !== 'pending') {
    problems.push(`未授权的轮询应当是 pending，实际是 ${firstPoll.status}（${firstPoll.message}）`)
  }
  console.log('  → 用户在自己的浏览器里输这个码即可完成登录；插件随后自动建账号，全程不需要 API key。')
} catch (error) {
  problems.push(`设备码登录发起失败：${error.message}`)
}

rmSync(dataDir, { recursive: true, force: true })

if (problems.length > 0) {
  console.error('\n✗ 真机管线测试失败：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\n✓ 真机管线测试通过')
