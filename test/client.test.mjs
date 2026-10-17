/**
 * 客户端半边契约测试。
 *
 * 干三件事，全部是「两侧漂移就会静默坏掉」的地方：
 *
 *   1. **Remote 端点**：客户端 bundle 里的线名必须与宿主 `src/remote.ts` 的
 *      `REMOTE_ENDPOINTS` **逐项一致**。任何一侧多一个/少一个，表现都是
 *      「界面上某个按钮点了没反应」或「卡片不出现」。
 *   2. **配置字段路径**：客户端表单里写死的 `path` 必须是宿主 schema 里
 *      **真实存在的 volatile 路径**。宿主只收 volatile 路径，而且一次 mutate
 *      里有一个非法 op 就**整批拒**（连合法的字段也一起丢）。
 *   3. **bundle 形状**：`apply` / `inject` 存在，两处 keyed slot 的 key 正确。
 *
 * 用假 `window.__ModuleLoader__` 把 bundle 跑起来（它本来就是懒执行的 CJS）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 把 client.js 装进一个假浏览器环境，返回它的 exports。 */
function loadClientBundle() {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  let definition = null
  const window = {
    __ModuleLoader__: {
      load(def) {
        definition = def
      },
    },
  }
  runInNewContext(source, { window, console, JSON, Object, Array, Number, String, Boolean, Math, Error, Symbol })
  assert.ok(definition !== null, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-multi-agent-gateway')

  const require = (specifier) => {
    if (specifier === 'react/jsx-runtime') {
      return {
        Fragment: Symbol('Fragment'),
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
      }
    }
    if (specifier === 'react') return { useState: () => [undefined, () => {}], useEffect: () => {} }
    if (specifier === '@deepseek-ai/dsh-client-store') {
      return {
        createSnapshotStore: (initial) => ({
          getSnapshot: () => initial,
          subscribe: () => () => {},
          set: () => {},
        }),
      }
    }
    throw new Error(`客户端 bundle 请求了未声明的模块：${specifier}`)
  }
  return definition.factory(require)
}

/** 解析 schemastery 的 toJSON（uid 引用）并列出 volatile 路径。 */
function volatilePaths(serialized, out = new Set()) {
  const refs = serialized.refs ?? {}
  const resolve = (uid) => refs[String(uid)] ?? null
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (node.meta?.volatile === true) out.add(path.join('.'))
    const type = node.type
    if (type === 'object' && node.dict !== undefined) {
      for (const [key, child] of Object.entries(node.dict)) walk(resolve(child), [...path, key])
      return
    }
    if (type === 'dict' && node.inner !== undefined) {
      walk(resolve(node.inner), [...path, '*'])
      return
    }
    if (type === 'array' && node.inner !== undefined) {
      walk(resolve(node.inner), [...path, '*'])
    }
  }
  // 根节点本身也在 refs 里（toJSON 返回的是 `{ uid, refs }`）。
  walk(resolve(serialized.uid), [])
  return out
}

const client = loadClientBundle()
const server = await import('../lib/index.js')
const serverRemote = await import('../lib/remote.js')

/**
 * 造一个**贴近真实形状**的浏览器 ctx。
 *
 * 存在的理由：客户端条目在浏览器里挂掉时，DSH 的 boot 报告只写
 * 「`<pkg>: failed`」**不带原因**（源码里 `${a}: ${u}`，只有 import 失败才带 message）。
 * 所以「apply 跑不跑得起来」必须在这里被拦下来。
 */
function fakeBrowserContext(overrides = {}) {
  const disposed = []
  const effect = (fn) => {
    const off = fn()
    const dispose = typeof off === 'function' ? off : () => {}
    disposed.push(dispose)
    return dispose
  }
  const value = {
    enabled: true,
    agents: {
      opencode: {
        enabled: true,
        labelWithAgent: true,
        checkIn: { enabled: true, cron: 'every:86400' },
        quota: { enabled: true, cron: 'every:1800' },
        tasks: { enabled: false, intervalMinutes: 30, concurrency: 1 },
      },
    },
  }
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', available: true, writable: true, value, user: null, revision: 1 }),
    mutate: async () => ({ ok: true }),
  }
  const ctx = {
    disposed,
    effect,
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    configForms: {
      get: () => scope,
      whileServed: (_namespaces, register) => {
        const off = register(new Set(['dsh-multi-agent-gateway']))
        return typeof off === 'function' ? off : () => {}
      },
    },
    slots: {
      inject: (_name, run) => (typeof run === 'function' ? run() : undefined),
      register: () => () => {},
      getVersion: () => 0,
      entries: () => [],
    },
    remote: {
      $mount: async () => {},
      multiAgentGateway: {},
    },
    inject(names, callback) {
      void names
      return callback(this)
    },
    ...overrides,
  }
  return ctx
}

test('客户端 apply 能在真实形状的 ctx 上跑起来（不抛异常）', () => {
  const ctx = fakeBrowserContext()
  // 这一个断言就够 —— 浏览器里挂掉的表现正是 `apply` 抛异常。
  assert.doesNotThrow(() => client.apply(ctx), 'apply 抛异常会让整个客户端条目 failed')
  // 跑完之后不该留下未被 effect 收管的资源
  assert.ok(ctx.disposed.length > 0, 'apply 应当把注册都包进 ctx.effect')
})

test('apply 后能产出完整投影（字段表与实际渲染同源）', () => {
  const ctx = fakeBrowserContext()
  client.apply(ctx)
  // 直接构造面板并投影一次：字段表笔误（例如把绝对路径数组当成字段对象传）
  // 在这里就会炸，而不是等用户打开设置页才 failed。
  const panel = new client.GatewayPanel(ctx.configForms.get('dsh-multi-agent-gateway'), ctx)
  const view = panel.projection()
  assert.equal(view.global.length, client.GLOBAL_FIELDS.length)
  assert.equal(view.agentFields.length, client.AGENT_FIELDS.length)
  for (const item of view.agentFields) {
    assert.ok(item.state !== undefined, `字段 ${item.field.key} 没有产出显示态`)
  }
  // Agent 字段的显示态必须读的是**绝对路径**（`agents.<id>.<field>`）
  const enabled = view.agentFields.find((item) => item.field.key === 'enabled')
  assert.equal(enabled.state.checked, true)
  panel.dispose()
})

test('bundle 形状：apply / inject / 两处 slot key', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual([...client.inject], ['slots', 'locale', 'configForms', 'remote'])
  assert.equal(client.CONFIG_NS, 'dsh-multi-agent-gateway')
  assert.equal(client.ROW_KEY, 'dsh-multi-agent-gateway#dsh-multi-agent-gateway')
  assert.equal(server.default.Config !== undefined, true, 'Config 必须在 export default 里（否则设置页消失）')
  assert.equal(typeof server.apply, 'function')
})

test('Remote 端点两侧逐项一致', () => {
  const serverEndpoints = Object.keys(serverRemote.REMOTE_ENDPOINTS)
  const clientEndpoints = [...client.REMOTE_ENDPOINTS]
  assert.deepEqual(clientEndpoints, serverEndpoints, '客户端与宿主端的端点清单漂移了')
  // 描述符形状：宿主读 invocations、客户端读 descriptors
  const clientContribution = client.remoteContribution()
  assert.equal(clientContribution.face, 'client')
  assert.ok(Array.isArray(clientContribution.descriptors))
  assert.equal(clientContribution.invocations, undefined)
  const hostContribution = serverRemote.remoteContribution('host')
  assert.ok(Array.isArray(hostContribution.invocations))
  assert.equal(hostContribution.descriptors, undefined)
})

test('客户端描述符：每个参数都带 source: "json"', () => {
  for (const descriptor of client.remoteDescriptors()) {
    assert.equal(descriptor.service, 'multiAgentGatewayRemote')
    assert.equal(descriptor.namespace, 'dsh-multi-agent-gateway' === 'x' ? 'x' : 'multiAgentGateway')
    for (const parameter of descriptor.parameters ?? []) {
      assert.equal(parameter.source, 'json', `${descriptor.method}.${parameter.name} 少了 source: 'json'`)
    }
  }
})

test('描述符与宿主侧逐字一致（防两侧漂移）', () => {
  const host = serverRemote.remoteDescriptors()
  const mine = client.remoteDescriptors()
  // 过一遍 JSON 是为了把 vm realm 的数组/对象摊平成本 realm 的普通对象。
  const strip = (list) =>
    JSON.parse(
      JSON.stringify(
        list.map((item) => ({
          id: item.id,
          service: item.service,
          namespace: item.namespace,
          method: item.method,
          implementation: item.implementation,
          invocation: item.invocation,
          paramNames: (item.parameters ?? []).map((parameter) => parameter.name),
          paramSources: (item.parameters ?? []).map((parameter) => parameter.source),
        })),
      ),
    )
  assert.deepEqual(strip(mine), strip(host))
})

/** 从序列化的 schema 里取 `agents` 对象的固定键（= 内置 Agent 名单）。 */
function agentKeys(serialized) {
  const refs = serialized.refs ?? {}
  const resolve = (uid) => refs[String(uid)] ?? null
  const root = resolve(serialized.uid)
  const agents = resolve(root.dict.agents)
  return Object.keys(agents.dict ?? {})
}

test('客户端字段路径都是宿主 schema 里真实的 volatile 路径', () => {
  const schema = server.default.Config.toJSON()
  const volatile = volatilePaths(schema)

  // 全局字段：直接比对
  for (const field of client.GLOBAL_FIELDS) {
    const path = field.path.join('.')
    assert.ok(volatile.has(path), `全局字段「${field.label}」的路径 ${path} 不是 volatile —— 宿主会整批拒绝保存`)
  }
  // Agent 字段：宿主要求**固定路径**（dict 里的通配段会让整份配置被拒），
  // 所以这里逐个真实 agentId 比对。
  for (const agentId of agentKeys(schema)) {
    for (const field of client.AGENT_FIELDS) {
      const path = `agents.${agentId}.${field.path.join('.')}`
      assert.ok(volatile.has(path), `Agent 字段「${field.label}」的路径 ${path} 不是 volatile`)
    }
    // 模型勾选的两个字段同样是写死的路径，同样必须存在
    for (const field of client.MODEL_POLICY_PATHS) {
      const path = `agents.${agentId}.${field.path.join('.')}`
      assert.ok(volatile.has(path), `模型策略字段「${field.label}」的路径 ${path} 不是 volatile`)
    }
  }
})

test('ModelList 真的能渲染（jsx 结构错误只会在渲染时炸）', () => {
  const t = (key) => String(key)
  const actions = { setModelMode() {}, toggleModel() {}, setModelFilter() {} }
  const items = [
    { id: 'free-a', name: 'Free A', agentId: 'opencode', free: true, multiplier: 0 },
    { id: 'paid-b', name: 'Paid B', agentId: 'opencode', multiplier: 2 },
  ]
  const base = { agentName: 'OpenCode', t, actions, disabled: false }

  // 三种模式 + 带勾选 + 带搜索，都要能渲染
  for (const mode of ['free', 'selected', 'all']) {
    const view = client.ModelList({
      ...base,
      models: { status: 'ready', items, exposedIds: ['free-a'], error: null },
      modelPolicy: { mode, selected: ['free-a'], exposedIds: ['free-a'], filter: '' },
    })
    assert.ok(view !== null && view !== undefined, `mode=${mode} 渲染成了空`)
  }
  // 搜索过滤后没有命中：要给出提示而不是崩
  client.ModelList({
    ...base,
    models: { status: 'ready', items, exposedIds: [], error: null },
    modelPolicy: { mode: 'selected', selected: [], exposedIds: [], filter: 'zzz' },
  })
  // 三种非就绪态
  for (const status of ['idle', 'loading', 'error']) {
    client.ModelList({
      ...base,
      models: { status, items: [], exposedIds: [], error: 'boom' },
      modelPolicy: { mode: 'free', selected: [], exposedIds: [], filter: '' },
    })
  }
})

test('无参端点必须零参数调用（曾因多传一个 {} 让整个面板打不开）', async () => {
  const calls = []
  const remote = new Proxy(
    {},
    {
      get(_target, name) {
        return (...args) => {
          calls.push({ name: String(name), argc: args.length })
          return Promise.resolve({ ok: true, value: {} })
        }
      },
    },
  )
  const ctx = fakeBrowserContext()
  ctx.remote = { $mount: async () => {}, multiAgentGateway: remote }
  const panel = new client.GatewayPanel(ctx.configForms.get('dsh-multi-agent-gateway'), ctx)

  await panel.refresh()
  assert.equal(calls.at(-1).name, 'state')
  assert.equal(
    calls.at(-1).argc,
    0,
    'state 的描述符声明 0 个参数；多传一个 {} 会被网关直接拒（expected 0 argument(s), got 1）',
  )

  await panel.call('logs', { count: 5 })
  assert.equal(calls.at(-1).name, 'logs')
  assert.equal(calls.at(-1).argc, 1, '带参端点必须恰好传 1 个参数')
  panel.dispose()
})

test('schema 的内置 Agent 键与客户端/注册表一致', () => {
  const schema = server.default.Config.toJSON()
  assert.deepEqual(agentKeys(schema).sort(), [...client.AGENTS].sort())
})

test('客户端列出的 Agent 与宿主 registry 顺序一致', async () => {
  const { builtinAdapters } = await import('../lib/adapters/index.js')
  // `client.AGENTS` 来自另一个 vm realm，先摊平成本 realm 的数组再比。
  assert.deepEqual([...client.AGENTS], builtinAdapters().map((adapter) => adapter.id))
})

test('倍率标签在客户端与服务端同口径', async () => {
  const { formatMultiplier } = await import('../lib/core/types.js')
  for (const [multiplier, free] of [
    [0, false],
    [undefined, false],
    [2, false],
    [1.5, false],
    [undefined, true],
    [3, true],
  ]) {
    assert.equal(client.multiplierTag(multiplier, free), formatMultiplier(multiplier, free))
  }
})

test('模型标签预览与服务端渲染一致', async () => {
  const { renderModelLabel } = await import('../lib/llm/adapter.js')
  const meta = { id: 'deepseek-r1', name: 'DeepSeek-R1', agentId: 'opencode', agentName: 'OpenCode', multiplier: 2 }
  assert.equal(client.modelLabel('OpenCode', 'DeepSeek-R1', 2, false), renderModelLabel(meta, true))
})

test('dsh.client 的 externals 覆盖了 bundle 真正 require 的模块', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declared = new Set(pkg.dsh.client.inject)
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  const requested = new Set()
  const pattern = /require\(\s*'([^']+)'\s*\)/g
  let match = pattern.exec(source)
  while (match !== null) {
    const specifier = match[1]
    // 基线模块（React 及其子路径）不需要声明。
    if (specifier !== 'react' && !specifier.startsWith('react/')) requested.add(specifier)
    match = pattern.exec(source)
  }
  for (const specifier of requested) {
    assert.ok(declared.has(specifier), `bundle require 了 ${specifier}，但 package.json 的 dsh.client.inject 里没声明`)
  }
})

test('plugin.json 的 contributes 与真实注册保持一致', async () => {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'))
  const { builtinAdapters } = await import('../lib/adapters/index.js')
  const providers = manifest.contributes.llmProviders.map((item) => item.provider)
  const expected = builtinAdapters().map((adapter) => `multiagent-${adapter.id}`)
  assert.deepEqual(providers, expected)
  assert.equal(manifest.id, 'dsh-multi-agent-gateway')
  assert.equal(manifest.client.main, './lib/client.js')
})
