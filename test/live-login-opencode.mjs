/**
 * OpenCode 设备码登录的真机验证（免鉴权段）。
 *
 * 验证点：
 *   - 真实服务端给出 device_code / user_code；
 *   - `verification_uri_complete` 必须是**绝对地址**（相对路径会让用户打不开，
 *     这是踩过的坑）；
 *   - 未授权时轮询必须回 `pending`（上游用 HTTP 400 + authorization_pending 表达）。
 *
 * 用法：`node test/live-login-opencode.mjs`（需要联网）。
 */

import { OpenCodeAdapter } from '../lib/adapters/opencode.js'

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log } }
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
  // 适配器用的是核心层的 `ctx.http`（带超时/重试/错误分类），
  // 这里给一个退化成裸 fetch 的实现，够验证登录链路。
  http: async (url, init) => fetch(url, init),
  cache: { get() {}, set() {}, delete() {} },
  now: () => Date.now(),
}

const adapter = new OpenCodeAdapter()
const problems = []
let skipped = false
try {
  const start = await adapter.startDeviceLogin(ctx)
  console.log('verificationUrl:', start.verificationUrl)
  console.log('userCode       :', start.userCode)
  console.log('expiresIn      :', start.expiresInSec, 's / interval', start.intervalSec)
  if (typeof start.verificationUrl !== 'string' || !/^https?:\/\//.test(start.verificationUrl)) {
    problems.push('verificationUrl 不是绝对地址（相对路径会让用户打不开）')
  }
  if (typeof start.userCode !== 'string' || start.userCode === '') problems.push('没拿到 user_code')

  const pending = await adapter.pollDeviceLogin(start.deviceCode, ctx)
  console.log('poll           :', pending.status, '|', pending.message)
  if (pending.status !== 'pending') problems.push(`未授权时应为 pending，实际 ${pending.status}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  // 429 = 本机出口 IP 被 opencode.ai 限流（与免费层门禁同源）。
  // 这是**环境**状态，不是登录实现的问题，所以跳过而不是报失败。
  if (/429|too many requests|rate limit/i.test(message)) {
    console.log(`\n⚠ 上游限流，本次跳过：${message}`)
    console.log('  （等一段时间或换出口 IP 后重跑）')
    // 不调 process.exit：此时可能还有探测用的 timer/fetch 句柄在收尾，
    // 强杀会触发 libuv 的 UV_HANDLE_CLOSING 断言。设置退出码让它自然结束。
    skipped = true
    process.exitCode = 0
  }
  problems.push(message)
}

console.log()
if (skipped) process.exitCode = 0
else if (problems.length > 0) {
  console.error('✗ 有问题：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
if (skipped) {
  console.log('— 本次跳过（上游限流），实现未被验证')
} else {
  console.log('✓ OpenCode 设备码登录（免鉴权段）通过')
}
