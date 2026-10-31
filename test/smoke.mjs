/**
 * 冒烟测试：用**假宿主**把插件完整装一遍，验证装配路径不炸。
 *
 * 为什么必须有这个：DSH 插件的很多错误只在装载期暴露（缺 provider、注册冲突、
 * 定时计划为空），而这些问题在真机上的表现往往是「界面上什么都没有」。
 * 这个脚本用最小可用的假 ctx 把 `apply()` 跑通，并把关键事实打印出来。
 *
 * 用法：`node test/smoke.mjs`
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'mag-smoke-'))
process.env.DSH_HOME = dataDir

/** 把 logger 的多个参数拼成一行（**不要** `...arr.join()` —— 那会把字符串拆成单字符）。 */
const line = (args) => args.map((item) => (typeof item === 'string' ? item : '')).join(' ')

const mod = await import('../lib/index.js')

const registered = []
const tools = []
const logs = []

/** 事件名 → 监听器列表（`apply` 里注册的热更新钩子也在这里）。 */
const listeners = new Map()
/** 热更新时被 `replace()` 通知过的 provider 路由。 */
const replaced = []

const ctx = {
  llm: {
    registerAdapter(providers, adapter) {
      for (const provider of providers) {
        if (registered.some((item) => item.provider === provider)) {
          throw new Error(`an adapter for provider "${provider}" is already registered`)
        }
        registered.push({ provider, adapter })
      }
      // `replace()` 是**热更新踢目录刷新**用的：它会发 `llm/adapters-updated`，
      // 客户端收到才重读模型下拉。这里记下来，等下断言它真的被调过。
      return Object.assign(
        () => {},
        {
          replace(providers) {
            replaced.push([...providers])
          },
        },
      )
    },
    registerModelDiscovery(_ns, discover) {
      ctx.__discover = discover
      return () => {}
    },
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  /** 可选依赖一律走 `ctx.get(name)`（cordis 对未注入的服务裸访问会抛错）。 */
  get(serviceName) {
    return serviceName === 'tools' ? ctx.tools : undefined
  },
  logger: {
    debug: (...args) => logs.push(['debug', line(args)]),
    info: (...args) => logs.push(['info', line(args)]),
    warn: (...args) => logs.push(['warn', line(args)]),
    error: (...args) => logs.push(['error', line(args)]),
  },
  /** 记下事件监听，供热更新测试触发。 */
  on(event, handler) {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
    return () => {
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  },
  /** 测试用：触发一次事件（模拟宿主的热更新通知）。 */
  __emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) handler(payload)
  },
  fiber: { entry: { options: { id: 'dsh-multi-agent-gateway' } } },
}

/**
 * 「活配置」。
 *
 * 宿主把 volatile 字段做成**引用对象**，所以插件拿同一个 config 对象重新解析
 * 就能读到新值。这里用普通对象模拟同样的语义 —— 直接改字段再发事件即可。
 */
const liveConfig = { agents: { opencode: { models: { mode: 'free', selected: '' } } } }

const handle = mod.apply(ctx, liveConfig)

const problems = []
if (registered.length === 0) problems.push('没有注册任何 provider 路由 —— 模型选择器里不会出现分组')
const opencode = registered.find((item) => item.provider === 'multiagent-opencode')
if (opencode === undefined) problems.push('没有注册 multiagent-opencode')

// 分组标题
if (opencode !== undefined) {
  const info = opencode.adapter.providerInfo('multiagent-opencode')
  if (info.name !== 'OpenCode') problems.push(`分组标题不对：${info.name}`)
}

if (tools.length !== 5) problems.push(`工具数量不对：${tools.length}（期望 5）`)

// 定时计划
const jobs = handle.runtime.snapshotSchedule()
if (jobs.length === 0) problems.push('定时任务计划为空')

console.log('注册的 provider 路由：')
for (const item of registered) {
  console.log(`  - ${item.provider} → 分组「${item.adapter.providerInfo(item.provider).name}」`)
}
console.log(`已注册工具：${tools.map((tool) => tool.name).join(', ')}`)
console.log(`定时任务：${jobs.length} 条`)
for (const job of jobs.slice(0, 12)) console.log(`  - [${job.key}] ${job.title} @ ${job.schedule}`)

// 账号 CRUD + 加密落盘
const account = handle.runtime.addAccount({
  agentId: 'opencode',
  label: '冒烟账号',
  credentials: { token: 'oc_sk_smoke_test_token_123456' },
})
if (account.token !== undefined) problems.push('返回的账号里带着明文 token —— 脱敏没生效')

const listed = handle.runtime.snapshotAccounts('opencode')
if (listed.length !== 1) problems.push(`账号列表数量不对：${listed.length}`)

// 假一个模型目录，验证「分组 + 倍率标签」的渲染
const { createLlmAdapter, renderModelLabel } = await import('../lib/llm/adapter.js')
const stubModels = [
  { id: 'deepseek-r1', name: 'DeepSeek-R1', agentId: 'opencode', agentName: 'OpenCode', multiplier: 2, contextWindow: 200000 },
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', agentId: 'opencode', agentName: 'OpenCode', multiplier: 0, free: true },
  { id: 'unknown-price', name: 'Unknown Price', agentId: 'opencode', agentName: 'OpenCode' },
]
const stubAdapter = createLlmAdapter({
  agentId: 'opencode',
  displayName: 'OpenCode',
  labelWithAgent: true,
  accounts: handle.runtime.accounts,
  router: handle.runtime.router,
  adapterOf: (id) => handle.runtime.registry.get(id),
  contextOf: (id) => handle.runtime.contextOf(id),
  modelsOf: async () => stubModels,
  // 用**真的过滤器**过滤**桩模型**：
  // 既验证「适配器读的是过滤后的列表」，又不让冒烟测试去打真网络。
  exposedModelsOf: async (id) => {
    const { selectExposedModels } = await import('../lib/core/types.js')
    return selectExposedModels(stubModels, handle.runtime.agentConfig(id).models)
  },
  log: handle.runtime.logger,
})
/**
 * 模型选择器里显示什么 —— **默认是「只报免费」**，所以只有免费那条会进下拉。
 *
 * 这里同时验证新加的策略开关真的能改变上报集合（而不是只改了个字段没人读）。
 */
const rowsDefault = await stubAdapter.listModels('multiagent-opencode')
console.log('\n模型选择器里会显示成（默认 mode=free）：')
for (const row of rowsDefault) console.log(`  [分组 ${stubAdapter.providerInfo('multiagent-opencode').name}] ${row.name}`)

const freeOnly = ['OpenCode · DeepSeek V4.1 Flash Free (免费)']
if (rowsDefault.length !== freeOnly.length) {
  problems.push(`默认应当只暴露免费模型：期望 ${freeOnly.length} 条，实际 ${rowsDefault.length} 条`)
}
for (const [index, want] of freeOnly.entries()) {
  if (rowsDefault[index]?.name !== want) {
    problems.push(`第 ${index + 1} 行标签不对：${rowsDefault[index]?.name}（期望 ${want}）`)
  }
}

// 切到「全部上报」，三条都应该回来 —— 这才证明策略真的作用在选择器上。
const agentConfig = handle.runtime.agentConfig('opencode')
const savedMode = agentConfig.models.mode
agentConfig.models.mode = 'all'
const rowsAll = await stubAdapter.listModels('multiagent-opencode')
agentConfig.models.mode = savedMode
console.log('切到 mode=all 之后：')
for (const row of rowsAll) console.log(`   ${row.name}`)
const expected = [
  'OpenCode · DeepSeek-R1 (×2)',
  'OpenCode · DeepSeek V4.1 Flash Free (免费)',
  'OpenCode · Unknown Price (未知倍率)',
]
if (rowsAll.length !== expected.length) {
  problems.push(`mode=all 应当暴露全部 ${expected.length} 条，实际 ${rowsAll.length} 条`)
}
for (const [index, want] of expected.entries()) {
  if (rowsAll[index]?.name !== want) problems.push(`第 ${index + 1} 行标签不对：${rowsAll[index]?.name}（期望 ${want}）`)
}

/**
 * **配置热更新回归**。
 *
 * 真实故障：用户在设置页把模型策略改成「只报我勾选的」→ **保存成功** →
 * 对话框下拉纹丝不动。原因就是热更新钩子只重建了定时计划，
 * 运行中的实例还揣着启动时那份 `mode: free`。
 *
 * 这里模拟宿主：改「活配置」→ 发 `loader/volatile-update` → 断言选择器内容真的变了。
 */
console.log('\n--- 配置热更新 ---')
liveConfig.agents.opencode.models.mode = 'selected'
liveConfig.agents.opencode.models.selected = 'unknown-price'
ctx.__emit('loader/volatile-update', {})
const rowsHot = await stubAdapter.listModels('multiagent-opencode')
console.log('热更新后选择器里：')
for (const row of rowsHot) console.log(`   ${row.name}`)
if (rowsHot.length !== 1 || rowsHot[0]?.name !== 'OpenCode · Unknown Price (未知倍率)') {
  problems.push(
    `配置热更新没生效：期望只剩「OpenCode · Unknown Price (未知倍率)」，实际 ${JSON.stringify(rowsHot.map((r) => r.name))}`,
  )
}
if (!listeners.has('loader/volatile-update')) {
  problems.push('没有注册 loader/volatile-update 钩子 —— 改配置不会生效')
}
// 光把配置换进实例还不够：DSH 的模型下拉是收到 `llm/adapters-updated` 才重读目录的，
// 所以热更新必须**也踢一下** replace()。
if (!replaced.some((list) => list.includes('multiagent-opencode'))) {
  problems.push('热更新没有通知模型目录刷新（replace 未被调用）—— 下拉里还是旧模型')
}

if (stubAdapter.providerInfo('multiagent-opencode').name !== 'OpenCode') {
  problems.push('分组标题不是 OpenCode')
}
void renderModelLabel

console.log(`\n插件数据目录：${dataDir}`)
console.log(`日志条数：${logs.length}；最后一条：${logs.at(-1)?.[1] ?? '(无)'}`)

// 状态持久化：加一个账号后应立刻能在磁盘上看到密文
const { existsSync, readFileSync } = await import('node:fs')
if (!existsSync(handle.runtime.accounts.accountsPath)) {
  problems.push('账号文件没有落盘')
} else {
  const raw = readFileSync(handle.runtime.accounts.accountsPath, 'utf8')
  if (raw.includes('oc_sk_smoke_test_token_123456')) problems.push('账号文件里出现了明文 token')
  if (!raw.includes('"data"')) problems.push('账号文件里没有密文字段')
}

handle.dispose()
rmSync(dataDir, { recursive: true, force: true })

if (problems.length > 0) {
  console.error('\n✗ 冒烟失败：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\n✓ 冒烟通过')
