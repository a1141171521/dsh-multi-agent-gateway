/**
 * 端到端：**登录 → 建账号 → 拉模型 → 可用性探测 → 对话**
 *
 * 为什么需要：真实平台的最后一步必须有真人登录，自动化测不了。这里起一个
 * **本地假上游**（实现 WorkBuddy 的 4 个端点），让真实的 `GatewayRuntime`
 * 和真实的 `BuddyAdapter` 跑完整链路 —— 协议接线错了会立刻暴露，
 * 而不至于等到用户登录完才发现。
 *
 * 覆盖的端点：
 *   POST /v2/plugin/auth/state      → {state, authUrl}
 *   GET  /v2/plugin/auth/token      → 第一次 11217（未就绪），第二次给 token
 *   GET  /v3/config                 → 模型目录
 *   POST /v2/chat/completions       → SSE（正文 + usage）
 *
 * 用法：`node test/e2e-login.mjs`
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../lib/config.js'
import { GatewayRuntime } from '../lib/runtime.js'
import { builtinAdapters } from '../lib/adapters/index.js'

const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
}

// ── 假上游 ────────────────────────────────────────────────────────
let tokenPolls = 0
const seen = { authState: 0, authToken: 0, config: 0, chat: 0 }

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const json = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  if (url.pathname === '/v2/plugin/auth/state') {
    seen.authState += 1
    // 平台参数与免鉴权头必须到位，否则真实服务端不会给 state
    check(url.searchParams.get('platform') === 'ide', 'auth/state 少了 platform=ide')
    check(req.headers['x-no-authorization'] === 'true', 'auth/state 少了 X-No-Authorization')
    check(req.headers['x-domain'] === 'copilot.tencent.com', 'auth/state 少了 X-Domain')
    return json(200, { code: 0, data: { state: 'st_e2e', authUrl: `http://127.0.0.1:${port}/login?state=st_e2e` } })
  }

  if (url.pathname === '/v2/plugin/auth/token') {
    seen.authToken += 1
    tokenPolls += 1
    if (tokenPolls === 1) return json(200, { code: 11217, message: 'authorization pending' })
    return json(200, {
      code: 0,
      data: { access_token: 'e2e_access', refresh_token: 'e2e_refresh', expires_in: 3600, domain: 'copilot.tencent.com' },
    })
  }

  if (url.pathname === '/v3/config') {
    seen.config += 1
    check(String(req.headers.authorization ?? '').startsWith('Bearer '), 'config 请求没带 Bearer')
    return json(200, {
      code: 0,
      data: {
        agents: [{ name: 'craft', models: ['hy3', 'auto'] }],
        models: [
          { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, supportsImages: true },
          { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, supportsImages: true },
        ],
      },
    })
  }

  if (url.pathname === '/v2/chat/completions') {
    seen.chat += 1
    check(String(req.headers.authorization) === 'Bearer e2e_access', '对话没带上登录拿到的 token')
    check(req.headers['x-product-code'] === 'codebuddy', '对话少了 X-Product-Code')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n')
    res.write('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  json(404, { code: 404, message: `unexpected ${url.pathname}` })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// ── 真 runtime + 真适配器，只把地址指向假上游 ──────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'mag-e2e-'))
const config = resolveConfig(
  {},
  { knownAgentIds: builtinAdapters().map((a) => a.id), defaultDataDir: dataDir },
)
const upstream = `http://127.0.0.1:${port}`
config.agents.workbuddy.upstream = {
  ...config.agents.workbuddy.upstream,
  apiBaseUrl: upstream,
  chatBaseUrl: `${upstream}/`,
  modelsUrl: `${upstream}/v3/config`,
}

const runtime = new GatewayRuntime({ config, adapters: builtinAdapters() })

try {
  // ① 发起登录
  const start = await runtime.loginStart('workbuddy')
  console.log('① 发起登录 →', String(start.authUrl).slice(0, 60))
  check(typeof start.authUrl === 'string' && start.authUrl.includes('/login'), '没拿到登录地址')

  // ② 第一次问：用户还没登录
  const pending = await runtime.loginPoll(start.loginId)
  console.log('② 未登录时轮询 →', pending.status)
  check(pending.status === 'pending', `未登录时应为 pending，实际 ${pending.status}`)

  // ③ 第二次问：拿到 token，宿主建账号
  const ready = await runtime.loginPoll(start.loginId)
  console.log('③ 登录后轮询 →', ready.status, ready.message ?? '')
  check(ready.status === 'ready', `登录成功时应为 ready，实际 ${ready.status}`)
  const accounts = runtime.accounts.byAgent('workbuddy')
  check(accounts.length === 1, `应当自动建 1 个账号，实际 ${accounts.length}`)
  check(accounts[0]?.credentials?.token === 'e2e_access', '账号里存的 token 不对')

  // ④ 拉模型（真实解析 /v3/config）
  const models = await runtime.modelsOf('workbuddy', true)
  console.log('④ 模型目录 →', models.map((m) => m.id).join(', '))
  check(models.some((m) => m.id === 'hy3'), '模型目录里少了 hy3')
  check(!models.some((m) => m.id === 'auto'), 'auto 是自动选择别名，不该进列表')
  check(models.find((m) => m.id === 'hy3')?.contextWindow === 192000, 'hy3 的上下文窗口没解析出来')

  // ⑤ 可用性探测
  const probe = await runtime.probeModels('workbuddy')
  console.log('⑤ 探测 →', probe.results.map((r) => `${r.modelId}=${r.status}`).join(' '))
  check(probe.ok === true, `探测失败：${probe.error}`)
  check(probe.results.every((r) => r.status === 'available'), '假上游对每个模型都放行，应全部 available')

  // ⑥ 真对话
  const record = accounts[0]
  const adapter = builtinAdapters().find((a) => a.id === 'workbuddy')
  const chunks = []
  const controller = new AbortController()
  for await (const event of adapter.requestChatStream(
    { model: 'hy3', messages: [{ role: 'user', content: '你好' }], stream: true },
    record,
    runtime.contextOf('workbuddy'),
    controller.signal,
  )) {
    chunks.push(event)
  }
  const text = chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')
  const finish = chunks.find((c) => c.type === 'finish')
  console.log('⑥ 对话 →', JSON.stringify(text), '| finish =', finish?.reason ?? finish?.kind ?? '-')
  check(text === '你好', `对话正文不对：${JSON.stringify(text)}`)
  check(chunks.some((c) => c.type === 'usage'), '没解析到 usage')

  console.log('\n端点调用次数：', JSON.stringify(seen))
} finally {
  runtime.dispose?.()
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
}

console.log()
if (problems.length > 0) {
  console.error('✗ 有问题：')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('✓ 端到端通过：登录 → 建账号 → 拉模型 → 探测 → 对话')
