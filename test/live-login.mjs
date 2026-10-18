/**
 * 真机验证**登录链路里不需要账号的那一段**。
 *
 * 为什么单独有这个脚本：登录的最后一步（用户在浏览器完成授权 → 换 token）
 * 必须有真人操作，自动化测不了；但前面每一步都能真机验：
 *
 *   - `auth/state` 是免鉴权接口，真实服务端会给出 state 与登录页地址；
 *   - 未登录时 `auth/token` 必须回 `pending`（回别的就说明判据写错了）；
 *   - Qoder 的授权链接是本地生成的，能验 PKCE 参数与 host。
 *
 * 用法：`node test/live-login.mjs`（需要联网）。
 */

import { BuddyAdapter, BUDDY_CN, BUDDY_INTL } from '../lib/adapters/buddy.js'
import { QoderAdapter, QODER_CN } from '../lib/adapters/qoder.js'
import { QODER } from '../lib/vendor/qoder/qoder-product.js'

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log } }
const baseCtx = {
  config: {
    id: 'x',
    name: 'X',
    upstream: { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '', freeTierMode: 'auto' },
    credits: { unit: 'usd', baselineUsdPerMTok: 1.2 },
    requestTimeoutMs: 30_000,
  },
  log,
  cache: { get() {}, set() {}, delete() {} },
  now: () => Date.now(),
}

const problems = []
const withTimeout = (ms, fn) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return fn((url, init) => fetch(url, { ...init, signal: controller.signal })).finally(() => clearTimeout(timer))
}

for (const [label, product] of [['WorkBuddy(CN)', BUDDY_CN], ['WorkBuddy(Intl)', BUDDY_INTL]]) {
  console.log(`\n=== ${label} ===`)
  try {
    const adapter = new BuddyAdapter(product)
    const start = await withTimeout(20_000, (fetchImpl) => adapter.beginLogin({ ...baseCtx, fetch: fetchImpl }))
    console.log(`  authUrl : ${start.authUrl.slice(0, 96)}`)
    if (!start.authUrl.startsWith(product.endpoint)) problems.push(`${label}: 授权链接不在产品域名下`)
    if (typeof start.state !== 'string' || start.state === '') problems.push(`${label}: 没拿到 state`)

    const pending = await withTimeout(20_000, (fetchImpl) => adapter.pollLogin(start.state, { ...baseCtx, fetch: fetchImpl }))
    console.log(`  poll    : ${pending.status} | ${pending.message ?? ''}`)
    if (pending.status !== 'pending') problems.push(`${label}: 未登录时应为 pending，实际 ${pending.status}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  ✗ ${message}`)
    problems.push(`${label}: ${message}`)
  }
}

console.log('\n=== Qoder / Qoder CN（本地生成授权链接） ===')
for (const product of [QODER, QODER_CN]) {
  try {
    const adapter = new QoderAdapter(product)
    const start = await adapter.beginLogin(baseCtx)
    console.log(`  ${product.displayName}: ${start.authUrl.slice(0, 110)}`)
    if (!start.authUrl.startsWith(product.authBase)) problems.push(`${product.displayName}: 授权链接不在 authBase 下`)
    if (!start.authUrl.includes('challenge=')) problems.push(`${product.displayName}: 缺 PKCE challenge`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  ${product.displayName} ✗ ${message}`)
    problems.push(`${product.displayName}: ${message}`)
  }
}

console.log()
if (problems.length > 0) {
  console.error('✗ 有问题：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('✓ 登录链路（免鉴权段）全部通过')
