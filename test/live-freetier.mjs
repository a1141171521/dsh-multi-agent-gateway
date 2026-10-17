/**
 * 端到端：空凭证账号走适配器的 requestChatStream，打真实 opencode 免费层。
 * 这是「不登录、不填 key 直接用免费模型」的最终验证。
 */
import { MemoryCache } from '../lib/core/cache.js'
import { createHttp } from '../lib/core/http.js'
import { OpenCodeAdapter } from '../lib/adapters/opencode.js'

const line = (a) => a.filter((x) => typeof x === 'string').join(' ')
const log = {
  debug: (...a) => console.log('  [debug]', line(a)),
  info: (...a) => console.log('  [info]', line(a)),
  warn: (...a) => console.log('  [warn]', line(a)),
  error: (...a) => console.log('  [error]', line(a)),
  child() {
    return log
  },
}

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
    requestTimeoutMs: 90_000,
  },
  log,
  http: createHttp(log, 90_000),
  cache: new MemoryCache(),
  now: () => Date.now(),
}

const adapter = new OpenCodeAdapter()
const account = {
  id: 'opencode:free',
  agentId: 'opencode',
  label: '免费层（无凭证）',
  credentials: {},
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
}

console.log('=== 1) 测活（空凭证）===')
const verdict = await adapter.validateCredentials(account, ctx)
console.log(`  ok=${verdict.ok} kind=${verdict.kind ?? 'none'}`)
console.log(`  ${verdict.message}`)

console.log('\n=== 2) 真实对话（流式，工具清单里带 read）===')
const tools = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file from the filesystem',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
    },
  },
]
const events = []
for await (const event of adapter.requestChatStream(
  { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: '只回答两个字：收到' }], tools },
  account,
  ctx,
  new AbortController().signal,
)) {
  events.push(event)
}

let text = ''
let reasoning = ''
let usage = null
let finish = null
for (const event of events) {
  if (event.type === 'text') text += event.text
  else if (event.type === 'reasoning') reasoning += event.text
  else if (event.type === 'usage') usage = event.usage
  else if (event.type === 'finish') finish = event.reason
}
console.log(`  事件数=${events.length}`)
console.log(`  正文   = ${JSON.stringify(text)}`)
console.log(`  思维链 = ${reasoning.slice(0, 60) ? JSON.stringify(reasoning.slice(0, 60) + '…') : '(无)'}`)
console.log(`  用量   = ${JSON.stringify(usage)}`)
console.log(`  结束   = ${finish}`)

const problems = []
if (!verdict.ok) problems.push(`测活没通过：${verdict.message}`)
if (!events.some((e) => e.type === 'text')) problems.push('一个 text 事件都没收到')
if (events.some((e) => e.type === 'error')) {
  problems.push(`出现错误事件：${JSON.stringify(events.find((e) => e.type === 'error').failure)}`)
}

/**
 * 3) **零账号**走完整路由器链路 —— 这才是用户的真实场景。
 *
 * 早先路由器把「没有账号」当错误（还归成 `auth`，界面上显示「API 密钥无效」），
 * 于是「零配置用免费模型」这个主场景根本走不通。现在应当自动兜一个匿名占位。
 */
console.log('\n=== 3) 零账号 · 走 AccountRouter ===')
const { mkdtempSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')
const { AccountManager } = await import('../lib/core/accounts.js')
const { AccountRouter } = await import('../lib/core/router.js')

const routerDataDir = mkdtempSync(join(tmpdir(), 'mag-live-router-'))
const manager = new AccountManager(routerDataDir, log, { v: 1, updatedAt: 0, health: {}, quota: {} })
const router = new AccountRouter(
  manager,
  {
    routing: 'quota-first',
    degradeAfterFailures: 1,
    penaltySec: 60,
    recoverIntervalSec: 600,
    maxAccountAttempts: 2,
    maxConcurrentRequests: 2,
  },
  log,
)
console.log(`  已配置账号数：${manager.byAgent('opencode').length}`)

let usedAccount = null
let routedText = ''
const outcome = await router.execute('opencode', async (account) => {
  usedAccount = account
  const collect = []
  for await (const event of adapter.requestChatStream(
    { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: '只回答两个字：收到' }], tools },
    account,
    ctx,
    new AbortController().signal,
  )) {
    collect.push(event)
  }
  const failure = collect.find((event) => event.type === 'error')
  if (failure !== undefined) return { ok: false, kind: failure.failure.kind, message: failure.failure.message }
  routedText = collect
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('')
  return { ok: true, value: account.id }
})

console.log(`  路由结果：ok=${outcome.ok} account=${usedAccount?.id ?? '(无)'} 正文=${JSON.stringify(routedText)}`)
if (!outcome.ok) problems.push(`零账号路由失败：${outcome.failure?.message ?? '(无消息)'}`)
if (usedAccount?.id !== 'opencode:anonymous') {
  problems.push(`零账号时应当用匿名占位，实际用了 ${usedAccount?.id ?? '(无)'}`)
}
if (routedText.trim() === '') problems.push('零账号路由没拿到正文')
rmSync(routerDataDir, { recursive: true, force: true })

console.log()
if (problems.length > 0) {
  console.error('✗ 失败：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('✓ 空凭证账号成功调用 OpenCode 免费模型（全程没有任何 key）')
