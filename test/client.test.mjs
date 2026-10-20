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

/**
 * 把 client.js 装进一个假浏览器环境，返回它的 exports。
 *
 * `sandbox` 可以注入额外的全局量（例如伪造的 `document`）——
 * 用来验证**样式注入**那条路径：没有 document 时它会被静默跳过，
 * 而「CSS 根本没注入」正是「界面没原型好看」的一种可能原因。
 */
function loadClientBundle(sandbox = {}, requireOverrides = {}) {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  let definition = null
  const window = {
    __ModuleLoader__: {
      load(def) {
        definition = def
      },
    },
  }
  runInNewContext(source, { window, console, JSON, Object, Array, Number, String, Boolean, Math, Error, Symbol, ...sandbox })
  assert.ok(definition !== null, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-multi-agent-gateway')

  const require = (specifier) => {
    if (requireOverrides[specifier] !== undefined) return requireOverrides[specifier]
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
 * 把 vm realm 里的对象摊平成本 realm 的普通对象。
 *
 * 存在的理由：`deepStrictEqual` 会比对原型链，跨 realm 的 `{}` 与 `{}`
 * 结构相同但「not reference-equal」，直接比会假失败。
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

/**
 * 把整棵 jsx 树里的字符串收集起来。
 *
 * ⚠️ 假的 `jsx()` **不会真的调用函数组件** —— `jsx(FieldRow, props)` 只是
 * `{type: FieldRow, props}`。所以这里遇到函数组件要手动调用一次，否则只能
 * 收集到分组标题，字段本身一个都看不见（第一版就是这么假通过的）。
 */
function collectText(node, out = []) {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node.type === 'function') {
    collectText(node.type(node.props), out)
    return out
  }
  collectText(node.props?.children, out)
  return out
}

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

/**
 * 用真实的 `GatewayPanel` 造一份投影，再交给 `DashboardHTML` 渲染成字符串。
 *
 * 视图层现在是「投影 → HTML 字符串」（见 client.js 的视图段注释），所以契约
 * 测试也断言字符串，而不是去遍历 jsx 树 —— 后者在新架构里只能看到空壳。
 */
function dashboardWith({ page = 'overview', items = [], policy = {}, agents = [], models = null } = {}) {
  const ctx = fakeBrowserContext()
  client.apply(ctx)
  const panel = new client.GatewayPanel(ctx.configForms.get('dsh-multi-agent-gateway'), ctx)
  panel.snapshot = {
    status: 'ready',
    error: null,
    value: {
      enabled: true,
      totals: { accounts: 1, enabledAccounts: 1, degraded: 0 },
      agents: agents.length > 0 ? agents : [{
        agentId: 'opencode',
        name: 'OpenCode',
        visible: true,
        implemented: true,
        enabled: true,
        accounts: [],
        modelCount: items.length,
      }],
      jobs: [],
      taskLog: [],
    },
  }
  panel.selectedAgent = 'opencode'
  panel.page = page
  if (models !== null) {
    panel.models = models
  } else if (items.length > 0) {
    panel.models = {
      status: 'ready',
      agentId: 'opencode',
      items,
      exposedIds: [],
      defaultSelectedIds: [],
      selectedIds: policy.selectedIds ?? [],
      policy: { mode: policy.mode ?? 'free', selected: policy.selected ?? [] },
      error: null,
    }
  }
  // 勾选状态在真实链路里走「配置草稿」：照着面板自己的方法写，
  // 别直接塞 `models.policy` —— 投影读的是草稿，塞那边等于没写。
  if (policy.mode !== undefined) panel.edit(panel.modelPath('mode'), policy.mode)
  if (Array.isArray(policy.selected)) panel.edit(panel.modelPath('selected'), policy.selected.join(','))
  return { panel, html: client.DashboardHTML(panel.projection()) }
}

/**
 * 造一个面板，配置里放**我们指定的真实值**，并接上一个假的 Remote。
 *
 * 与 `dashboardWith` 的分工：
 *   - `dashboardWith` 的配置是 `fakeBrowserContext` 里那份固定值，主要用来验渲染；
 *   - 这个函数让你能喂**非默认值**（例如 `cron: '30 8 * * *'`），
 *     于是「开关/kv 到底读的是真实配置还是兜底常量」能被钉死 ——
 *     兜底值恰好是「每天一次 / 60 分钟 / 1 个账号 / 连续 3 次」，
 *     喂一组不同的值，读错就必然露馅。
 *
 * 关键点：**值走真实链路**（`scope.getSnapshot().value` →
 * `GatewayPanel.fieldState()`），不伪造 state —— 缺陷 1 就是在这条链路上读错了字段。
 */
function panelWithConfig({ page = 'tasks', agent = {}, remote = {} } = {}) {
  const value = { enabled: true, agents: { opencode: { enabled: true, ...agent } } }
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', available: true, writable: true, value, user: null, revision: 1 }),
    mutate: async () => ({ ok: true }),
  }
  const ctx = fakeBrowserContext({
    configForms: {
      get: () => scope,
      whileServed: (_namespaces, register) => {
        const off = register(new Set(['dsh-multi-agent-gateway']))
        return typeof off === 'function' ? off : () => {}
      },
    },
    remote: { $mount: async () => {}, multiAgentGateway: remote },
  })
  client.apply(ctx)
  const panel = new client.GatewayPanel(scope, ctx)
  panel.snapshot = {
    status: 'ready',
    error: null,
    value: {
      enabled: true,
      totals: { accounts: 0, enabledAccounts: 0, degraded: 0 },
      agents: [{ agentId: 'opencode', name: 'OpenCode', visible: true, implemented: true, enabled: true, accounts: [], modelCount: 0 }],
      jobs: [],
      taskLog: [],
    },
  }
  panel.selectedAgent = 'opencode'
  panel.page = page
  return { panel, scope, ctx }
}

test('模型表：勾选计数、免费优先排序、每行都有上下文长度输入框', () => {
  const items = [
    { id: 'paid-b', name: 'Paid B', agentId: 'opencode', free: false, multiplier: 2, contextWindow: 200000 },
    { id: 'free-a', name: 'Free A', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 131072 },
  ]
  const { panel, html } = dashboardWith({ page: 'accounts', items })

  // ① 计数用「已勾选 N / 共 M」，N 来自宿主给的 selectedIds
  assert.ok(html.includes('已勾选 <b>0</b>'), '没有勾选时计数应为 0')
  assert.ok(html.includes('共 <b>2</b>'), '总数应为 2')

  // ② 免费优先：Free A 必须排在 Paid B 前面
  const freeAt = html.indexOf('Free A')
  const paidAt = html.indexOf('Paid B')
  assert.ok(freeAt > 0 && paidAt > 0, '两个模型都要在表里')
  assert.ok(freeAt < paidAt, '免费模型要排在付费模型前面')

  // ③ 每个模型行一个上下文长度输入框，占位符是上游报的窗口
  const inputs = html.match(/class="mag-input mag-input-ctx"/g) ?? []
  assert.equal(inputs.length, 2, '每个模型行都该有一个上下文长度输入框')
  assert.ok(html.includes('placeholder="131072"'), '占位符显示上游报的窗口')
  assert.ok(html.includes('placeholder="200000"'))

  // ④ 保存条：没有改动时保存按钮是禁用的
  assert.ok(html.includes('保存并生效'), '保存条必须在标题与列表之间')
  assert.ok(/data-dirty="false"/.test(html), '没有改动时保存条不是脏状态')
  panel.dispose()
})

test('模型表：三种非就绪态与空列表都要给出可读状态，而不是白板', () => {
  for (const status of ['idle', 'loading', 'error']) {
    const { panel, html } = dashboardWith({
      page: 'accounts',
      models: { status, agentId: 'opencode', items: [], exposedIds: [], selectedIds: [], policy: { mode: 'free', selected: [] }, error: 'boom' },
    })
    assert.ok(html.includes('模型'), `status=${status} 时模型卡片没渲染`)
    if (status === 'loading') assert.ok(html.includes('正在向上游拉取模型'), 'loading 要说明在拉取')
    if (status === 'error') assert.ok(html.includes('拉取失败'), 'error 要把原因显示出来')
    if (status === 'idle') assert.ok(html.includes('还没有拉取过模型'), 'idle 要引导去拉取')
    panel.dispose()
  }
})

test('模型表：勾选过的模型带 checked，取消勾选的不带', () => {
  const items = [
    { id: 'free-a', name: 'Free A', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 131072 },
    { id: 'free-b', name: 'Free B', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 131072 },
  ]
  const { panel, html } = dashboardWith({ page: 'accounts', items, policy: { mode: 'selected', selected: ['free-a'] } })
  assert.ok(/data-id="free-a" checked/.test(html), '勾选的模型复选框要是 checked')
  assert.ok(!/data-id="free-b" checked/.test(html), '没勾的模型复选框不该 checked')
  assert.ok(html.includes('已勾选 <b>1</b>'), '计数要跟着勾选走')
  panel.dispose()
})

test('冷启动：快照还没回来时给「正在读取」，而不是一帧 0 个平台', () => {
  const cold = client.DashboardHTML({
    shell: { page: 'overview', writable: true, dirty: false, dirtyCount: 0, saving: false, saved: false, saveError: null, status: 'ready', advancedOpen: false },
    snapshot: { status: 'loading', value: null, error: null },
    summary: { status: 'idle', data: null, error: null },
    log: { status: 'idle', entries: [], total: 0, page: 1, pageSize: 20, error: null },
    update: { status: 'idle', data: null, error: null, applying: false },
    global: [], agentFields: [], selectedAgent: 'opencode',
    models: { status: 'idle', agentId: null, items: [], error: null },
    modelPolicy: { mode: 'free', selected: [], selectedIds: [], exposedIds: [], filter: '', windowOverrides: {} },
    busy: null, actionMessage: null, login: { status: 'idle' }, remoteError: null,
  })
  assert.ok(cold.includes('正在读取宿主状态'), '冷启动要说明在读')
  assert.ok(!cold.includes('0 个平台'), '不能先画一帧空页面')
})

test('登录弹框挂在 body 上的独立层里（不被设置面板的 overflow/transform 裁剪）', () => {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  assert.ok(source.includes('document.body.appendChild(PORTAL)'), '弹框层要挂到 document.body')
  assert.ok(source.includes('PORTAL.parentNode.removeChild(PORTAL)'), '面板卸载时要收掉弹框层')
  // 面板本体不再输出遮罩层 —— 一旦有人把它塞回 inline，就会重新被裁剪
  const { html } = dashboardWith({ page: 'accounts', items: [] })
  assert.ok(!html.includes('mag-overlay'), '面板 HTML 里不该再有 mag-overlay')
})

test('登录弹框永远居中：不再因为「浏览器已打开」往左甩', () => {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  // ⚠️ 回归点（真机报「弹框位置偏移太厉害」）：全屏窗口下左移 6% 看起来就是跑偏。
  assert.ok(!source.includes('data-side'), '遮罩不该再带 data-side（左移那套已删除）')
  // 只针对遮罩自己的 flex 对齐 —— `align-items:flex-start` 在别处是正常写法。
  // 注意别去断言「源码里不出现 with-browser 这个词」：注释里会提到它。
  assert.ok(
    !/\.mag-overlay[^}]*justify-content:\s*flex-start/.test(source),
    '遮罩不该把弹框推到左边（justify-content:flex-start）',
  )
  // 居中必须是遮罩的默认行为
  assert.match(
    source,
    /\.mag-overlay\{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center/,
    '遮罩要保持 flex 居中',
  )
})

test('连续取消两个模型不会互相覆盖（草稿必须优先于宿主 selectedIds）', () => {
  const items = [
    { id: 'free-a', name: 'A', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
    { id: 'free-b', name: 'B', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
    { id: 'free-c', name: 'C', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
  ]
  const { panel } = dashboardWith({ page: 'accounts', items, policy: { mode: 'selected', selected: ['free-a', 'free-b', 'free-c'] } })
  panel.toggleModel('free-a', false)
  panel.toggleModel('free-b', false)
  const policy = panel.projection().modelPolicy
  assert.deepEqual([...policy.selected], ['free-c'], '两次取消都要保留，只有最后一次生效就是老 bug')
  assert.equal(policy.mode, 'selected')
  panel.dispose()
})

test('模型卡片没有「按推荐预选」按钮（只勾选免费模型的入口已去掉）', () => {
  const items = [
    { id: 'free-a', name: 'A', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
    { id: 'paid-b', name: 'B', agentId: 'opencode', free: false, multiplier: 2, contextWindow: 1000 },
  ]
  const { panel, html } = dashboardWith({ page: 'accounts', items, policy: { mode: 'selected', selected: [] } })
  assert.ok(!html.includes('按推荐预选'), '不该再渲染「按推荐预选 N 个」按钮')
  assert.ok(!html.includes('data-act="preselect"'), 'preselect 按钮必须彻底消失')
  assert.equal(typeof panel.preselectModels, 'undefined', 'preselectModels 已删除，避免按钮又长回来')
  // 勾选仍然是「草稿 + 保存」：手动勾一个，保存条要亮
  panel.toggleModel('free-a', true)
  assert.deepEqual([...panel.projection().modelPolicy.selected], ['free-a'])
  assert.equal(panel.projection().shell.dirty, true, '勾选必须产生未保存改动')
  panel.dispose()
})

test('「只看免费」只在平台真有付费模型时出现（OpenCode 只拉免费，不需要过滤器）', () => {
  const allFree = [
    { id: 'free-a', name: 'A', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
    { id: 'free-b', name: 'B', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
  ]
  const mixed = [
    ...allFree,
    { id: 'paid-c', name: 'C', agentId: 'opencode', free: false, multiplier: 3, contextWindow: 1000 },
  ]
  const freeOnly = dashboardWith({ page: 'accounts', items: allFree })
  assert.ok(!freeOnly.html.includes('只看免费'), '全是免费模型时不该再给「只看免费」勾选框')
  freeOnly.panel.dispose()
  const full = dashboardWith({ page: 'accounts', items: mixed })
  assert.ok(full.html.includes('只看免费'), '有付费模型时「只看免费」仍然要有')
  full.panel.dispose()
})

test('没登录的平台不列模型：给「先登录」的引导，而不是一堆「未知倍率」', () => {
  const { panel, html } = dashboardWith({
    page: 'accounts',
    agents: [{ agentId: 'qoder', name: 'Qoder', visible: true, implemented: true, enabled: true, accounts: [], modelCount: 17 }],
    // 宿主即使给了目录也不该画出来
    models: {
      status: 'ready',
      agentId: 'qoder',
      items: [{ id: 'auto', name: 'Auto', agentId: 'qoder', contextWindow: 200000 }],
      exposedIds: [],
      selectedIds: [],
      policy: { mode: 'selected', selected: [] },
      error: null,
    },
  })
  assert.ok(html.includes('登录后自动拉取'), '要说清楚「登录后自动拉取」')
  assert.ok(html.includes('登录 Qoder'), '引导要指向登录按钮')
  assert.ok(!html.includes('mag-mtable'), '没登录不该画模型表格')
  assert.ok(!html.includes('mag-mrow'), '没登录不该画模型行')
  assert.ok(!html.includes('>未知倍率<'), '没登录不该出现「未知倍率」的倍率标签')
  assert.ok(!html.includes('data-act="probe"'), '没账号不该出现「测一次」')
  assert.ok(!html.includes('data-act="load-models"'), '没账号不该出现「拉取模型」')
  panel.dispose()
})

test('探测可用性时行内显示「测试中」，不给反馈就是「点了没反应」', () => {
  const items = [
    { id: 'free-a', name: 'A', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000, availability: 'unknown' },
    { id: 'free-b', name: 'B', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000, availability: 'unknown' },
  ]
  const { panel } = dashboardWith({ page: 'accounts', items })
  // ① 平时：两行都有「测一次」
  const idle = client.DashboardHTML(panel.projection())
  assert.equal((idle.match(/data-act="probe"/g) ?? []).length, 2, '没在探测时每行都有「测一次」')
  assert.ok(idle.includes('测一次'))
  assert.ok(!idle.includes('测试中…'), '没在探测时不该出现「测试中…」')

  // ② 探测中：那一行变成禁用的「测试中…」，工具栏给出进度说明，别的行也不许再点
  const probing = client.DashboardHTML({ ...panel.projection(), probing: ['free-a'] })
  assert.ok(probing.includes('测试中…'), '探测中的行要显示「测试中…」')
  assert.ok(probing.includes('正在测试 1 个模型'), '工具栏要说明正在进行')
  assert.equal((probing.match(/data-act="probe"/g) ?? []).length, 1, '探测中的行不该还有「测一次」')
  assert.ok(/data-act="probe" data-id="free-b" disabled/.test(probing), '同一时间只跑一轮，其余行的按钮要禁掉')
  panel.dispose()
})

/**
 * 回归：面板正文是 `innerHTML` 字符串，事件目标节点没有 React fiber。
 * React 的 `onChange` 走 ChangeEventPlugin，只在「目标节点是表单元素」时派发 ——
 * 目标被解析成根 div 之后**一次都不派发**。
 *
 * 真机症状：模型勾选框点下去什么也没发生，草稿没写入，保存条永远是灰的
 * （用户报的就是「勾选模型后没有保存按钮」）。所以交互必须挂原生监听。
 */
test('交互事件挂原生监听：勾选能写进草稿，根节点不再用 React 合成事件', () => {
  const listeners = new Map()
  const root = {
    innerHTML: '',
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    querySelector: () => null,
  }
  const effects = []
  const react = {
    Fragment: Symbol('Fragment'),
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    useRef: () => ({ current: root }),
    useEffect: (fn) => {
      effects.push(fn)
    },
    useState: (value) => [value, () => {}],
  }
  const bundle = loadClientBundle({}, { react })
  const items = [
    { id: 'free-a', name: 'A', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
    { id: 'free-b', name: 'B', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000 },
  ]
  const { panel } = dashboardWith({ page: 'accounts', items, policy: { mode: 'selected', selected: [] } })
  const state = panel.projection()
  // 真实环境里 props = slot 注入的动作 + 槽位给的 t/view
  const props = { t: (key) => key, view: 'page', useGatewayPanel: () => state, ...panel.inject() }
  const tree = bundle.GatewayPanelView(props)

  // ① 根节点上不能再用 React 的合成事件：onChange 根本不派发，
  //    onClick 再挂一份会和原生监听一起把开关翻两次。
  assert.equal(tree.props.onChange, undefined, '根节点不该再用 React 的 onChange')
  assert.equal(tree.props.onClick, undefined, '根节点不该再用 React 的 onClick（会和原生监听重复）')
  assert.equal(tree.props.onInput, undefined, '根节点不该再用 React 的 onInput')

  // ② effect 跑起来后三个原生监听必须齐全
  const cleanup = effects.at(-1)()
  for (const name of ['click', 'change', 'input']) {
    assert.equal(typeof listeners.get(name), 'function', `根节点缺原生 ${name} 监听`)
  }

  // ③ 模拟勾选：change 必须真的写进草稿 —— 这一条挂掉就是「保存按钮永远灰」
  listeners.get('change')({
    target: {
      getAttribute: (name) => (name === 'data-act' ? 'toggle-model' : name === 'data-id' ? 'free-a' : null),
      checked: true,
    },
  })
  const next = panel.projection()
  assert.equal(next.shell.dirty, true, '勾选模型后必须出现未保存改动')
  assert.deepEqual([...next.modelPolicy.selected], ['free-a'])

  // ④ 卸载时监听要摘干净（插件页会被反复挂载）
  cleanup()
  assert.equal(listeners.size, 0, 'effect 清理时必须把原生监听都摘掉')
  panel.dispose()
})

test('模型上报默认关：没勾过就不该冒出来（曾经默认 free，导致没配过的平台也在下拉里）', () => {
  // 直接问宿主 schema：空配置下每个 Agent 的 models.mode 必须是 selected
  // volatile 字段的值会被包成引用对象，取默认值时先拆一层
  const plain = (raw) => (raw && typeof raw === 'object'
    ? (typeof raw.get === 'function' ? raw.get() : raw.value)
    : raw)
  const config = server.default.Config({})
  const agents = config.agents ?? {}
  assert.ok(Object.keys(agents).length > 0, 'schema 里应当有内置 Agent')
  for (const [agentId, agent] of Object.entries(agents)) {
    const mode = plain(agent?.models?.mode)
    assert.equal(mode, 'selected', `${agentId} 的 models.mode 默认值必须是 selected，实际是 ${mode}`)
    assert.equal(plain(agent?.models?.selected) ?? '', '', `${agentId} 的默认勾选必须为空`)
  }
})

test('设置页字段：开关读 fieldState.checked、输入框读 fieldState.text（曾读 .value → 开关点不动）', () => {
  const { panel } = dashboardWith({ page: 'settings' })
  const projection = panel.projection()
  const state = {
    ...projection,
    shell: { ...projection.shell, page: 'settings', dirty: true, dirtyCount: 1 },
    global: [],
    agentFields: [
      { field: { section: 'basic', key: 'enabled', kind: 'bool', label: '启用这个 Agent', path: ['enabled'] }, state: { checked: true, changed: false } },
      { field: { section: 'basic', key: 'exposeModels', kind: 'bool', label: '上报模型', path: ['exposeModels'] }, state: { checked: false, changed: false } },
      { field: { section: 'models', key: 'contextWindowDefault', kind: 'number', label: '默认上下文长度（token）', path: ['contextWindow', 'default'] }, state: { text: '131072', changed: true } },
    ],
  }
  const html = client.DashboardHTML(state)
  assert.ok(
    html.includes('aria-checked="true" data-act="field-toggle" data-scope="agent" data-key="enabled"'),
    '开着的开关必须渲染成 aria-checked=true',
  )
  assert.ok(
    html.includes('aria-checked="false" data-act="field-toggle" data-scope="agent" data-key="exposeModels"'),
    '关着的开关必须渲染成 aria-checked=false',
  )
  assert.ok(html.includes('value="131072"'), '输入框的值要来自 fieldState.text')
  assert.ok(html.includes('已改'), '草稿改过的字段要有「已改」标记')
  panel.dispose()
})

test('登录弹框：五个状态各画各的，过期绝不能画成成功', () => {
  const agent = { agentId: 'workbuddy', name: 'WorkBuddy' }
  const base = { status: 'idle', message: null, loginId: null, userCode: null, verificationUrl: null, authUrl: null, intervalSec: 5, expiresInSec: 600 }

  const starting = client.LoginModalHTML({ login: { ...base, status: 'starting' } }, agent)
  assert.ok(starting.includes('正在获取授权链接'), 'starting 要说明在取链接')

  const waiting = client.LoginModalHTML(
    { login: { ...base, status: 'waiting', authUrl: 'https://example.test/login?state=1', loginId: 'x' } },
    agent,
  )
  assert.ok(waiting.includes('在浏览器打开'), 'waiting 要有「在浏览器打开」')
  assert.ok(waiting.includes('手动刷新状态'), 'waiting 要有「手动刷新状态」')
  assert.ok(waiting.includes('https://example.test/login?state=1'), 'waiting 要显示授权链接')

  const failed = client.LoginModalHTML({ login: { ...base, status: 'failed', message: 'HTTP 500' } }, agent)
  assert.ok(failed.includes('获取授权链接失败'), 'failed 要报失败')
  assert.ok(failed.includes('HTTP 500'), 'failed 要显示上游原话')

  // ⚠️ 回归点：宿主会把 `expired` 原样传上来，早先的 else 分支把它画成了绿勾。
  const expired = client.LoginModalHTML({ login: { ...base, status: 'expired' } }, agent)
  assert.ok(expired.includes('授权链接已过期'), 'expired 要说过期')
  assert.ok(!expired.includes('已添加账号'), 'expired 绝不能画成成功')
  assert.ok(expired.includes('重新获取链接'), 'expired 要能重新取链接')

  const ready = client.LoginModalHTML({ login: { ...base, status: 'ready' } }, agent)
  assert.ok(ready.includes('已添加账号'), 'ready 才是成功态')

  // 未知状态：说不知道，也不许冒充成功
  const weird = client.LoginModalHTML({ login: { ...base, status: 'something-new' } }, agent)
  assert.ok(!weird.includes('已添加账号'), '未知状态不能画成成功')
  assert.ok(weird.includes('登录状态未知'), '未知状态要给出明确文案')
})

test('登录弹框排版：主按钮整行、状态卡带倒计时、说明在按钮下面', () => {
  const agent = { agentId: 'qoder-cn', name: 'Qoder CN' }
  const base = { status: 'idle', message: null, loginId: null, userCode: null, verificationUrl: null, authUrl: null, intervalSec: 5, expiresInSec: 600 }
  const waiting = client.LoginModalHTML(
    {
      login: {
        ...base, status: 'waiting', loginId: 'x',
        authUrl: 'https://example.test/login?state=1',
        expiresInSec: 300,
        expiresAt: Date.now() + 272_000,
      },
    },
    agent,
  )

  // ① 主按钮整行：上一版按钮和说明并排（mag-row），窄屏互相挤
  assert.ok(waiting.includes('mag-btn-block'), '主按钮要整行')
  assert.ok(waiting.includes('mag-cta'), '按钮与说明要用纵向的 mag-cta 包起来')
  assert.ok(!/mag-row[^"]*"[^>]*>\s*<button[^>]*login-open/.test(waiting), 'CTA 不该再用横向 mag-row')

  // ② 状态卡：剩余时间是**由到期时刻算出来的**，不是固定的「有效期 N 分钟」
  assert.ok(waiting.includes('剩余 4:3'), `剩余时间要按 expiresAt 算，实际：${waiting.match(/剩余 [\d:]+/)?.[0]}`)
  assert.ok(waiting.includes('data-bind="left"'), '剩余时间要可被倒计时单独更新')
  assert.ok(waiting.includes('data-bind="bar"'), '进度条要可被倒计时单独更新')

  // ③ 步骤两条，且带连接线样式类
  assert.equal((waiting.match(/class="mag-step"/g) ?? []).length, 2, '应为两步')
  assert.ok(waiting.includes('mag-step-t'), '步骤文字要单独包一层，好和圆圈对齐')

  // ④ 终态不该出现等待区的东西
  for (const [status, extra] of [['failed', { message: 'HTTP 502' }], ['expired', {}], ['ready', {}]]) {
    const html = client.LoginModalHTML({ login: { ...base, status, ...extra } }, agent)
    assert.ok(!html.includes('data-bind="bar"'), `${status} 不该有倒计时进度条`)
    assert.ok(!html.includes('mag-steps'), `${status} 不该有步骤条`)
  }
})

test('登录弹框：只有设备码形态才画设备码，外链登录不画空框', () => {
  const base = { status: 'idle', message: null, loginId: 'x', verificationUrl: null, intervalSec: 5, expiresInSec: 600, expiresAt: Date.now() + 300_000 }

  // OpenCode：设备码形态 —— 有 userCode，要画出来并给「复制设备码」
  const device = client.LoginModalHTML(
    { login: { ...base, status: 'waiting', userCode: 'OC-9F3C-1A97', verificationUrl: 'https://opencode.ai/auth/device?user_code=OC-9F3C-1A97' } },
    { agentId: 'opencode', name: 'OpenCode' },
  )
  assert.ok(device.includes('mag-codebox'), '设备码要单独一块')
  assert.ok(device.includes('OC-9F3C-1A97'), '设备码要显示出来')
  assert.ok(device.includes('data-act="login-copy-code"'), '设备码要有独立复制按钮（复制链接是另一个）')

  // Qoder：外链登录 —— 没有 userCode，不该画一个空框
  const link = client.LoginModalHTML(
    { login: { ...base, status: 'waiting', userCode: null, authUrl: 'https://qoder.com.cn/device/selectAccounts?challenge=abc' } },
    { agentId: 'qoder-cn', name: 'Qoder CN' },
  )
  assert.ok(!link.includes('mag-codebox'), '没有设备码就不该画设备码框')
  assert.ok(!link.includes('data-act="login-copy-code"'), '没有设备码就不该有复制设备码按钮')
  assert.ok(link.includes('data-act="login-copy"'), '授权链接的复制按钮仍然要有')
})

test('逐模型上下文长度：写成 `id=长度` 串，清空即删除', () => {
  const ctx = fakeBrowserContext()
  client.apply(ctx)
  const panel = new client.GatewayPanel(ctx.configForms.get('dsh-multi-agent-gateway'), ctx)
  const path = 'agents.opencode.contextWindow.overrides'

  panel.setModelWindow('paid-b', '262144')
  panel.setModelWindow('free-a', '131072')
  assert.deepEqual(plain(panel.windowOverrides()), { 'free-a': 131072, 'paid-b': 262144 })
  let op = panel.ops().find((item) => item.path.join('.') === path)
  assert.equal(op.value, 'free-a=131072,paid-b=262144', '按 id 排序，保存结果稳定可 diff')

  // 清空到与配置相同的值就不该产生 op（否则每次保存都多一个空改动）
  panel.setModelWindow('free-a', '')
  panel.setModelWindow('paid-b', 'abc')
  assert.deepEqual(plain(panel.windowOverrides()), {})
  op = panel.ops().find((item) => item.path.join('.') === path)
  assert.equal(op, undefined, '全清空后不该再有 op')
  panel.dispose()
})

test('0 / 负数不写进上下文长度覆盖（会让 DSH 立刻压缩）', () => {
  const ctx = fakeBrowserContext()
  client.apply(ctx)
  const panel = new client.GatewayPanel(ctx.configForms.get('dsh-multi-agent-gateway'), ctx)
  for (const bad of ['0', '-5', 'abc', '']) panel.setModelWindow('free-a', bad)
  assert.deepEqual(plain(panel.windowOverrides()), {})
  panel.setModelWindow('free-a', '131072')
  assert.deepEqual(plain(panel.windowOverrides()), { 'free-a': 131072 })
  panel.dispose()
})

test('接口路径不再出现在设置页（用户根本填不出来）', () => {
  const paths = client.AGENT_FIELDS.map((field) => field.path.join('.'))
  for (const path of [
    'upstream.checkInPath',
    'upstream.quotaPath',
    'upstream.tasksPath',
    'upstream.taskClaimPath',
    'upstream.taskStatusPath',
  ]) {
    assert.ok(!paths.includes(path), `${path} 不该出现在设置页 —— 它是适配器的内置知识`)
  }
  // 每个字段都必须落在某个分组里，否则 renderGroup 会把它**静默丢掉**
  for (const field of client.AGENT_FIELDS) {
    assert.ok(
      ['basic', 'schedule', 'models', 'advanced'].includes(field.section),
      `字段 ${field.key} 的 section 非法：${field.section}`,
    )
  }
})

test('设置页：常用项默认可见、上游地址折叠在「高级」里、接口路径永不出现', () => {
  const { panel, html } = dashboardWith({ page: 'settings' })

  for (const label of ['启用这个 Agent', '上报模型到 DSH 选择器', '自动签到（基础每日任务）', '任务轮询间隔（分钟）']) {
    assert.ok(html.includes(label), `设置页少了「${label}」`)
  }
  for (const label of ['签到接口路径', '额度接口路径', '任务列表路径', '领取奖励路径', '对话 base url']) {
    assert.ok(!html.includes(label), `「${label}」不该默认显示`)
  }

  panel.toggleAdvanced()
  const expanded = client.DashboardHTML(panel.projection())
  assert.ok(expanded.includes('对话 base url'), '展开「高级」后应看到上游地址')
  assert.ok(!expanded.includes('签到接口路径'), '接口路径任何时候都不该出现在界面里')
  panel.dispose()
})

test('五页导航：五个页签都在，切页后只渲染这一页', () => {
  const agents = [
    { agentId: 'opencode', name: 'OpenCode', visible: true, implemented: true, enabled: true, accounts: [], modelCount: 0 },
    { agentId: 'qoder', name: 'Qoder', visible: false, implemented: false, enabled: false, accounts: [], modelCount: 0 },
  ]
  const { panel, html } = dashboardWith({ page: 'accounts', agents })

  for (const label of ['总览', '账号', '任务', '日志', '设置']) {
    assert.ok(html.includes(label), `导航少了「${label}」`)
  }
  assert.ok(html.includes('OpenCode'), '可见平台要在列表里')
  assert.ok(!html.includes('Qoder'), 'visible=false 的平台不该出现')

  // 切到日志页：应该出现日志表头，且不再出现总览的 KPI
  panel.setPage('logs')
  const logs = client.DashboardHTML(panel.projection())
  assert.ok(logs.includes('请求日志'), '日志页没渲染')
  assert.ok(!logs.includes('平台健康'), '日志页不该出现总览的内容')
  panel.dispose()
})

test('设置页入口：apply 会注册 settings.section（设置页一级导航）', () => {
  const registered = []
  const ctx = fakeBrowserContext()
  ctx.slots = {
    ...ctx.slots,
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  }
  client.apply(ctx)

  const section = registered.find((item) => item.options.name === 'settings.section')
  assert.ok(section, 'settings.section 没注册 —— 设置页不会出现这一页')
  assert.equal(section.options.id, client.CONFIG_NS, 'id 必须用自己的，重名会顶掉别人的格子')
  assert.equal(typeof section.options.label, 'function', 'label 要是 thunk，切语言才不用重新注册')
  assert.equal(typeof section.options.inject, 'function', 'inject 负责把 useGatewayPanel 与动作交给组件')
  assert.ok(Number.isFinite(section.options.order), 'order 决定它在导航里的位置')

  // 三处入口必须渲染同一个组件，否则会出现「插件页能用、设置页空白」这种半坏状态
  const pluginsPage = registered.find((item) => item.options.name === 'plugins.bundle.config')
  assert.ok(pluginsPage, 'plugins.bundle.config 仍然要注册（老入口不能丢）')
  assert.equal(section.component, pluginsPage.component, '三处入口必须复用 GatewayPanelView')
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
  // 注意：refresh 之后还会顺手拉 KPI 与请求日志（fire-and-forget），
  // 所以不能断言「最后一次调用」，要按方法名找。
  const stateCall = calls.find((item) => item.name === 'state')
  assert.ok(stateCall !== undefined, 'refresh 没有调用 state')
  assert.equal(
    stateCall.argc,
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

test('样式真的会被注入到页面（没注入 = 界面退化成白板）', () => {
  const appended = []
  const makeDocument = (existing) => ({
    querySelector: () => existing,
    createElement: (tag) => ({ tagName: tag, dataset: {}, textContent: '' }),
    head: { appendChild: (node) => appended.push(node) },
  })

  // ① 页面上还没有这份样式 → 应当追加一个 style
  const fresh = loadClientBundle({ document: makeDocument(null) })
  assert.equal(appended.length, 1, '样式没被注入 —— 界面会完全没有本插件的样式')
  const tag = appended[0]
  assert.equal(tag.tagName, 'style')
  assert.equal(tag.dataset.pluginCss, 'dsh-multi-agent-gateway/client.css')
  assert.equal(tag.dataset.plugin, 'dsh-multi-agent-gateway')
  // 关键类名必须在里面（抽查几个渲染时依赖的）
  for (const sel of ['.mag-root', '.mag-card', '.mag-kpi', '.mag-pill', '.mag-tbl', '.mag-save', '.mag-mrow', '.mag-modal']) {
    assert.ok(tag.textContent.includes(sel), `样式里缺 ${sel}`)
  }
  // ⚠️ 只能用**真实存在**的 token。DSH 主题只提供 14 个（bg-base / bg-layer-1/2 /
  // bg-overlay / border-l1/l2 / brand-primary / label-primary/secondary /
  // state-{error,idle,success,warn}-primary / sidebar-fill）。用了不存在的名字，
  // 对应样式会静默失效 —— 这正是「界面没原型好看」的一个可能来源。
  for (const bad of [
    'label-tertiary',
    'state-business-primary',
    'settings-card-',
    'border-l3',
    'border-l4',
    'interactive-bg-hover',
    'dsw-radius',
  ]) {
    assert.ok(!tag.textContent.includes(bad), `样式里用了 DSH 不存在的 token：${bad}`)
  }

  // ② 页面上已经有这份样式 → 不重复追加（插件页会被反复挂载）
  appended.length = 0
  loadClientBundle({ document: makeDocument({ tagName: 'style' }) })
  assert.equal(appended.length, 0, '重复挂载时不该再追加一份样式')
  assert.ok(fresh.CSS.length > 500, 'CSS 导出为空')
})

// ───────────────────── 任务页开关（用户报「按钮不生效」）─────────────────────

/**
 * 造一个「任务页」投影，字段显示态做成**真实形状**（`{checked}` / `{text}`）。
 *
 * 用真实的 `dashboardWith` 走一遍是最理想的，但那要求配置里真有这些值；
 * 这里显式给状态，是为了能把「渲染读的是哪个字段」钉死 —— 缺陷本身就是
 * 「读了一个不存在的 `.value`」，只有显式喂状态才拦得住。
 */
function tasksPageWith({ checked = {}, text = {} } = {}) {
  const { panel } = dashboardWith({ page: 'tasks' })
  const projection = panel.projection()
  const field = (key, kind) => ({
    field: { section: 'schedule', key, kind, label: key, path: [key] },
    state: kind === 'bool' ? { checked: checked[key] === true, changed: false } : { text: String(text[key] ?? ''), changed: false },
  })
  const state = {
    ...projection,
    shell: { ...projection.shell, page: 'tasks' },
    agentFields: [
      field('checkInEnabled', 'bool'),
      field('quotaEnabled', 'bool'),
      field('tasksEnabled', 'bool'),
      field('checkInCron', 'text'),
      field('tasksInterval', 'number'),
      field('tasksConcurrency', 'number'),
      field('tasksMaxFailures', 'number'),
    ],
  }
  return { panel, state, html: client.DashboardHTML(state) }
}

test('任务页：两个开关读 fieldState.checked（曾读 .value → 恒画成关闭、点了不动）', () => {
  // 配置里签到开着、活动任务关着 —— 与用户真机一致（他在 cordis.patch.yml 里
  // 把 qoder-cn.tasks.enabled 设成了 true，界面却一直画成「已关闭」）。
  const { panel, html } = tasksPageWith({ checked: { checkInEnabled: true, tasksEnabled: false } })

  assert.ok(
    html.includes('aria-checked="true" data-act="field-toggle" data-scope="agent" data-key="checkInEnabled"'),
    '开着的「每日签到」必须画成 aria-checked=true（读 .value 时恒为 false）',
  )
  assert.ok(
    html.includes('aria-checked="false" data-act="field-toggle" data-scope="agent" data-key="tasksEnabled"'),
    '关着的「活动任务」必须画成 aria-checked=false',
  )
  // 徽标同样读那个值：两边不一致的话用户更糊涂
  assert.ok(html.includes('已开启'), '签到徽标要说「已开启」')
  assert.ok(html.includes('已关闭'), '活动任务徽标要说「已关闭」')

  // 反向再来一次：值对调，结论也必须对调（防「恒真」而不是「恒假」）
  const flipped = tasksPageWith({ checked: { checkInEnabled: false, tasksEnabled: true } })
  assert.ok(
    flipped.html.includes('aria-checked="false" data-act="field-toggle" data-scope="agent" data-key="checkInEnabled"'),
    '关着的签到要画成 false',
  )
  assert.ok(
    flipped.html.includes('aria-checked="true" data-act="field-toggle" data-scope="agent" data-key="tasksEnabled"'),
    '开着的活动任务要画成 true',
  )
  panel.dispose()
  flipped.panel.dispose()
})

test('任务页：四个 kv 读 fieldState.text（曾恒显示兜底默认值，与真实配置不符）', () => {
  const { panel, html } = tasksPageWith({
    checked: { checkInEnabled: true, tasksEnabled: true },
    // 全用非默认值：任何一个被兜底值顶掉都会立刻暴露
    text: { checkInCron: '30 8 * * *', tasksInterval: '45', tasksConcurrency: '3', tasksMaxFailures: '7' },
  })
  assert.ok(html.includes('30 8 * * *'), '签到时间要显示配置里的 cron，而不是兜底「每天一次」')
  assert.ok(!html.includes('每天一次'), '有真实值时不该再显示兜底文案')
  assert.ok(html.includes('45 分钟'), '轮询间隔要显示 45，而不是兜底 60')
  assert.ok(html.includes('3 个账号'), '并发上限要显示 3，而不是兜底 1')
  assert.ok(html.includes('连续 7 次'), '失败暂停要显示 7，而不是兜底 3')
  panel.dispose()
})

test('任务页开关点击：草稿按「与当前相反」写入，两下回到原值即无待保存改动', () => {
  // 机制说明（用户报「按钮不生效」的真实回路）：
  //   onSwitchClick 的取反依据是 projection 里的 `state.checked`（形状本来就是对的），
  //   而**渲染**读错了字段。于是界面画的与真实值相反 —— 用户照着界面点，
  //   第 1 下反而把开着的签到**悄悄关掉**，看起来就是「点了没生效」。
  //   这条用例钉住「渲染值 == 取反依据」，两者再也不能各说各话。
  const { panel } = tasksPageWith({ checked: { tasksEnabled: false } })
  const path = 'agents.opencode.tasks.enabled'
  const opsAt = () => panel.ops().find((op) => op.path.join('.') === path)

  const before = panel.projection().agentFields.find((f) => f.field.key === 'tasksEnabled')
  assert.equal(before.state.checked, false, '前置：配置里是关的')

  // 第 1 下：next = !false = true
  panel.toggle(panel.agentPath(before.field), before.state.checked !== true)
  assert.equal(opsAt()?.value, true, '第 1 下应写入 set true')
  assert.equal(panel.projection().shell.dirty, true, '出现未保存改动（保存条要亮）')

  // 第 2 下：投影已是 true → next = false，回到原值 → ops 被过滤（设计如此）
  const after = panel.projection().agentFields.find((f) => f.field.key === 'tasksEnabled')
  assert.equal(after.state.checked, true, '第 1 下之后开关应画成开 —— 渲染与取反依据必须同源')
  panel.toggle(panel.agentPath(after.field), after.state.checked !== true)
  assert.equal(opsAt(), undefined, '第 2 下回到原值 → 没有待保存改动')
  assert.equal(panel.projection().shell.dirty, false, '脏状态要跟着清掉')
  panel.dispose()
})

// ───────────────────── 额度显示与手动刷新（用户报「额度未拉取」）─────────────────────

test('额度显示：四种状态分得开（未拉取 / 拉取失败 / 真的是 0 / 已用尽）', () => {
  const { panel } = dashboardWith({ page: 'accounts' })
  const view = (quota) => client.quotaView(quota, quota && quota.unit)

  // ① 没有快照 = 从来没拉到过。这是用户报的「额度未拉取」。
  const none = view(null)
  assert.equal(none.text, '未拉取')
  assert.match(none.hint, /刷新额度/, '要引导用户去点刷新按钮')

  // ② 拉取失败：说原因，**不能**画成 0
  const failed = view({ unit: 'credits', fetchedAt: 1700000000000, error: '额度查询失败：401 invalid token' })
  assert.equal(failed.text, '未知')
  assert.equal(failed.tone, 'warn')
  assert.match(failed.hint, /401 invalid token/, '要把上游原话显示出来')
  assert.match(failed.hint, /上次拉取/, '带上时间戳，才能和「未拉取」区分')

  // ③ 真的是 0（上游没说用尽）—— 用户真机上就是这个：Qoder 国际版回 userQuota 全 0
  const zero = view({ unit: 'credits', remaining: 0, total: 0, used: 0, fetchedAt: 1700000000000 })
  assert.equal(zero.text, '0 积分')
  assert.equal(zero.tone, 'warn', '0 剩余不该用绿色 ok 语气')
  assert.match(zero.hint, /剩余为 0/)

  // ④ 已用尽：上游下发 isQuotaExceeded:true（实测 Qoder 真的会下发）
  const usedUp = view({ unit: 'credits', remaining: 0, total: 1000, used: 1000, fetchedAt: 1700000000000, extra: { isQuotaExceeded: true } })
  assert.equal(usedUp.tone, 'warn')
  assert.match(usedUp.hint, /已用尽/, '上游的判定必须露出来，与我们的推断分开措辞')
  assert.match(usedUp.hint, /总额度 1000/)

  // ⑤ 正常有额度：这次才该是绿色
  const healthy = view({ unit: 'credits', remaining: 858, total: 1000, used: 142, fetchedAt: 1700000000000 })
  assert.equal(healthy.text, '858 积分')
  assert.equal(healthy.tone, 'ok')

  // ⑥ 不限量
  assert.equal(view({ unit: 'credits', unlimited: true, fetchedAt: 1700000000000 }).text, '不限')
  panel.dispose()
})

test('账号页：整平台与单账号两个「刷新额度」入口，靠 data-id 区分', () => {
  const agents = [{
    agentId: 'qoder',
    name: 'Qoder',
    visible: true,
    implemented: true,
    enabled: true,
    accounts: [
      { id: 'qoder:a1', label: '主号', enabled: true, health: { state: 'ok' }, quota: { unit: 'credits', remaining: 0, fetchedAt: 1700000000000, extra: { isQuotaExceeded: true } } },
      { id: 'qoder:a2', label: '备用', enabled: true, health: { state: 'ok' }, quota: null },
    ],
    modelCount: 0,
  }]
  const { panel, html } = dashboardWith({ page: 'accounts', agents })

  // 卡片头那个**不带** data-id → 刷本平台全部账号
  assert.ok(
    /<button class="mag-btn mag-btn-sm" data-act="quota-refresh" title="刷新本平台全部账号的额度">/.test(html),
    '账号卡片头缺「刷新额度」按钮（用户明确要求加这个手动入口）',
  )
  // 每个账号行一个，带各自的 data-id
  for (const id of ['qoder:a1', 'qoder:a2']) {
    assert.ok(
      html.includes(`data-act="quota-refresh" data-id="${id}"`),
      `账号 ${id} 缺单账号「刷新额度」按钮`,
    )
  }
  // 账号行要把额度原因挂进 title（「未拉取」与「已用尽」在行内一眼分不开）
  assert.ok(html.includes('上游报告额度已用尽'), '已用尽的原因要能悬停看到')
  assert.ok(html.includes('还没拉取过'), '未拉取的账号要提示去点刷新')
  panel.dispose()
})

test('「刷新额度」点击分发：不带 data-id → {agentId}；带 data-id → {accountId}', async () => {
  const calls = []
  // 监听器**必须在 effect 跑之前**就装好收集器 —— effect 里是
  // `root.addEventListener(name, handler)`，跑完再去挂就永远收不到了。
  const listeners = new Map()
  const root = {
    innerHTML: '',
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    querySelector: () => null,
  }
  const effects = []
  const react = {
    Fragment: Symbol('Fragment'),
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    useRef: () => ({ current: root }),
    useEffect: (fn) => { effects.push(fn) },
    useState: (value) => [value, () => {}],
  }
  const bundle = loadClientBundle({}, { react })
  const agents = [{
    agentId: 'qoder',
    name: 'Qoder',
    visible: true,
    implemented: true,
    enabled: true,
    accounts: [{ id: 'qoder:a1', label: '主号', enabled: true, health: { state: 'ok' }, quota: null }],
    modelCount: 0,
  }]
  const { panel } = dashboardWith({ page: 'accounts', agents })
  // 把宿主调用录下来 —— `run` 最后一定走 `call()`。
  panel.remoteCtx = { remote: { multiAgentGateway: { refreshQuota: async (input) => { calls.push(input); return [] } } } }
  const state = panel.projection()
  const props = { t: (key) => key, view: 'page', useGatewayPanel: () => state, ...panel.inject() }
  bundle.GatewayPanelView(props)
  const cleanup = effects.at(-1)()

  const click = (attrs) => {
    // onClick 用 closest('[data-act]') 找目标，这里给一个最小替身。
    const node = {
      tagName: 'BUTTON',
      getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
      closest: () => node,
    }
    return node
  }

  // ① 账号行：带 data-id → accountId
  listeners.get('click')({ target: click({ 'data-act': 'quota-refresh', 'data-id': 'qoder:a1' }) })
  // `run()` 是异步的，并且开头就把 `busy` 立起来（防连点）。两次点击之间
  // 必须让它跑完，否则第 2 下会被 busy 守卫直接吞掉 —— 那不是我们要测的东西。
  await new Promise((resolve) => setTimeout(resolve, 0))
  // ⚠️ 必须过一层 `plain()`：这个对象是在 VM realm 里造出来的，
  // 它的 `Object.prototype` 与测试 realm 不是同一个，deepEqual 会因为
  // 原型不同而判不相等（报错里两边看起来一模一样）。
  assert.deepEqual(plain(calls.at(-1)), { accountId: 'qoder:a1' }, '带 data-id 时必须只刷那一个账号')

  // ② 卡片头：不带 data-id → agentId
  listeners.get('click')({ target: click({ 'data-act': 'quota-refresh' }) })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(plain(calls.at(-1)), { agentId: 'qoder' }, '不带 data-id 时刷本平台全部账号')

  cleanup()
  panel.dispose()
})

test('describeQuotaRefresh：翻成一句能据以行动的话（形状与宿主冻结契约一致）', () => {
  const describe = client.describeQuotaRefresh

  // ① 没有账号可刷
  assert.equal(describe([]), '没有可刷新的账号')

  // ② 全成功：要说清每个账号剩多少，0 / 已用尽的要标出来
  const allOk = describe([
    { accountId: 'q:a', label: '主号', unit: 'credits', remaining: 858, total: 1000, used: 142, unlimited: false, error: null, fetchedAt: 1 },
    { accountId: 'q:b', label: '小号', unit: 'credits', remaining: 0, total: 0, used: 0, unlimited: false, error: null, fetchedAt: 1 },
  ])
  assert.match(allOk, /2 个账号额度已更新/)
  assert.match(allOk, /主号 858 积分/)
  assert.match(allOk, /小号 0 积分（已用尽）/, '0 剩余必须显式说「已用尽」，否则用户以为一切正常')

  // ③ 有失败：原因单独成句缀在末尾（那才是用户能动手的部分）
  const someFailed = describe([
    { accountId: 'q:a', label: '主号', unit: 'credits', remaining: 1, error: null, unlimited: false, fetchedAt: 1 },
    { accountId: 'q:b', label: '小号', unit: 'unknown', remaining: null, error: '额度查询失败：401 invalid token', unlimited: false, fetchedAt: 1 },
  ])
  assert.match(someFailed, /1 个账号额度已更新/)
  assert.match(someFailed, /1 个账号拉取失败/)
  assert.match(someFailed, /第一个失败原因：额度查询失败：401 invalid token/)

  // ④ 不限量 / 未知额度都要有话说，不能拼出「undefined 积分」
  const mixed = describe([
    { accountId: 'q:a', label: '不限号', unit: 'credits', remaining: null, unlimited: true, error: null, fetchedAt: 1 },
    { accountId: 'q:b', label: '未知号', unit: 'unknown', remaining: null, unlimited: false, error: null, fetchedAt: 1 },
  ])
  assert.match(mixed, /不限号 不限/)
  assert.match(mixed, /未知号 额度未知/)
  assert.ok(!mixed.includes('undefined'), '不能把 undefined 拼进用户可见文案')
  assert.ok(!mixed.includes('null'), '不能把 null 拼进用户可见文案')
})

test('run 的 describe 参数必须被转发（曾只声明 3 个形参 → 所有动作只显示「完成」）', () => {
  // 早先 `inject().run` 是 `(label, method, input) => ...`，第 4 个实参被静默吞掉，
  // 于是 `describeCheckIn` 从写出来那天起就没生效过 —— 签到一直只说「签到 完成」，
  // 用户分不清「领到了」与「今天已领」。这条用例直接钉住转发。
  const { panel } = dashboardWith({ page: 'accounts' })
  const injected = panel.inject()
  assert.equal(injected.run.length >= 4, true, 'inject().run 必须接收 describe（少一个形参就会被静默吞掉）')
  panel.dispose()
})

// ───────── 上面三条的**端到端**版本：走真实配置 / 真实 click 派发 / 真实 run ─────────
//
// 为什么还要再来一遍：上面几条为了让「读的是哪个字段」足够显眼，是**直接喂
// 人造 state** 的（`tasksPageWith`），点击也是直接调 `panel.toggle()`。
// 那两条路都绕开了真实链路。而缺陷的原发地恰恰在真实链路上：
//   · 值来自 `fieldState(field, agentPath(field))` 的真实输出；
//   · 点击经由根节点的原生 click 监听 → `onSwitchClick` → `props.toggleAgent`。
// 下面几条一个环节都不跳过，任何一处「读了不存在的字段」都会立刻红。

test('任务页（真实链路）：真实配置的值原样出现在开关与 kv 上', () => {
  // 用**非默认值**：任何一个被兜底值顶掉都会立刻暴露。
  // 兜底值分别是「每天一次 / 60 分钟 / 1 个账号 / 连续 3 次」。
  const { panel } = panelWithConfig({
    page: 'tasks',
    agent: {
      checkIn: { enabled: true, cron: '30 8 * * *' },
      tasks: { enabled: true, intervalMinutes: 45, concurrency: 3, maxFailures: 7 },
    },
  })
  const html = client.DashboardHTML(panel.projection())

  // ① 两个开关：值直接来自 fieldState(...).checked
  assert.ok(
    html.includes('aria-checked="true" data-act="field-toggle" data-scope="agent" data-key="checkInEnabled"'),
    '真实配置里开着的签到，必须画成 aria-checked=true',
  )
  assert.ok(
    html.includes('aria-checked="true" data-act="field-toggle" data-scope="agent" data-key="tasksEnabled"'),
    '真实配置里开着的活动任务，必须画成 aria-checked=true',
  )
  assert.ok(html.includes('已开启'), '两个都开着时徽标要说「已开启」')
  assert.ok(!html.includes('已关闭'), '配置里两个都开着，不该出现「已关闭」')

  // ② 四个 kv：值来自 fieldState(...).text
  assert.ok(html.includes('30 8 * * *'), '签到时间要显示配置里的 cron')
  assert.ok(!html.includes('每天一次'), '有真实 cron 时不该再出现兜底文案「每天一次」')
  assert.ok(html.includes('45 分钟'), '轮询间隔要显示配置里的 45')
  assert.ok(html.includes('3 个账号'), '并发上限要显示配置里的 3')
  assert.ok(html.includes('连续 7 次'), '失败暂停要显示配置里的 7')
  panel.dispose()
})

test('任务页（真实 click 派发）：onSwitchClick → toggleAgent，两个方向都取反', async () => {
  // ⚠️ 这条补的是「用 `panel.toggle()` 直接调控制器」那条用例的漏：
  // 它绕过了 `onSwitchClick` + 根节点 click 监听，而缺陷原发地正是这条派发路径。
  // 这里两件事同时钉住：
  //   · 派发真的把草稿设成**与当前相反**的值（两个方向各一次）；
  //   · 画出来的 aria-checked 与取反依据**同源** —— 界面不再骗用户。
  const listeners = new Map()
  const root = {
    innerHTML: '',
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
    querySelector: () => null,
  }
  const effects = []
  const react = {
    Fragment: Symbol('Fragment'),
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    useRef: () => ({ current: root }),
    useEffect: (fn) => { effects.push(fn) },
    useState: (value) => [value, () => {}],
  }
  const bundle = loadClientBundle({}, { react })
  const { panel } = panelWithConfig({
    page: 'tasks',
    agent: {
      checkIn: { enabled: true, cron: 'every:86400' },
      tasks: { enabled: false, intervalMinutes: 60, concurrency: 1, maxFailures: 3 },
    },
  })
  const props = { t: (key) => key, view: 'page', useGatewayPanel: () => panel.projection(), ...panel.inject() }
  // 真机上每次 publish() 都会让 React 重渲染，CURRENT 随之刷新。
  // 这里照做 —— 否则第 2 次点击读到的还是旧 state，测出来的是假象。
  const render = () => {
    bundle.GatewayPanelView(props)
    effects.at(-1)()
  }
  render()
  assert.equal(typeof listeners.get('click'), 'function', '根节点缺原生 click 监听')

  const clickSwitch = (key) => {
    const node = {
      tagName: 'BUTTON',
      closest: () => node,
      getAttribute: (name) => (name === 'data-act' ? 'field-toggle' : name === 'data-scope' ? 'agent' : name === 'data-key' ? key : null),
    }
    listeners.get('click')({ target: node })
    render()
  }
  const opAt = (path) => panel.ops().find((op) => op.path.join('.') === path)
  const ariaOf = (key) =>
    (client.DashboardHTML(panel.projection()).match(
      new RegExp(`aria-checked="(true|false)" data-act="field-toggle" data-scope="agent" data-key="${key}"`),
    ) ?? [])[1]

  const TASKS = 'agents.opencode.tasks.enabled'
  const CHECKIN = 'agents.opencode.checkIn.enabled'

  // ① 方向一：关 → 开
  assert.equal(ariaOf('tasksEnabled'), 'false', '前置：活动任务关着')
  clickSwitch('tasksEnabled')
  assert.equal(opAt(TASKS)?.value, true, '第 1 下必须写入 set true（取反，不是「永远设 true」）')
  assert.equal(panel.projection().shell.dirty, true, '出现未保存改动 —— 保存条要亮起来')
  assert.equal(ariaOf('tasksEnabled'), 'true', '点完界面必须跟着变成开（渲染与取反依据同源）')

  // ② 方向二：开 → 关 —— 这一方向才是 bug 现场（配置本来就 true 时，点一下必须能关掉）
  assert.equal(ariaOf('checkInEnabled'), 'true', '前置：签到开着')
  clickSwitch('checkInEnabled')
  assert.equal(opAt(CHECKIN)?.value, false, '配置本来是 true 时，点一下必须写入 set false')
  assert.equal(ariaOf('checkInEnabled'), 'false', '点完界面要变成关')
  assert.equal(panel.projection().shell.dirty, true, '仍然有待保存改动')

  // ③ 再点一下回到原值 → ops 被过滤干净（脏状态要清掉，否则保存条一直亮着）
  clickSwitch('checkInEnabled')
  assert.equal(opAt(CHECKIN), undefined, '点回原值后不该再有这个字段的 op')
  panel.dispose()
})

test('describeCheckIn 端到端：走 props.run 后真的出现在 actionMessage 里（曾恒为「签到 完成」）', async () => {
  // 只断言 `run.length >= 4` 证明不了 describe 真的**流到了** actionMessage 里。
  // 这条喂一份真实的签到结果，断言用户看到的是 describeCheckIn 的措辞。
  const calls = []
  const remote = {
    checkIn: async (input) => {
      calls.push(input)
      return {
        ok: true,
        value: [{ accountId: 'qoder:a1', agentId: 'qoder', label: '主号', ok: true, supported: true, credits: 10, recorded: true, message: '' }],
      }
    },
    state: async () => ({ ok: true, value: {} }),
    requestSummary: async () => ({ ok: true, value: {} }),
    requestLog: async () => ({ ok: true, value: {} }),
  }
  const { panel } = panelWithConfig({ page: 'tasks', remote })
  // ⚠️ 必须走 `inject().run`（而不是直接 `panel.run`）—— 缺陷就在**那一层**：
  // `inject()` 里的转发函数少声明了一个形参。直接调 `panel.run` 会把这一层
  // 整个跳过，测出来永远是绿的（那正是「假通过」的样子）。
  const props = panel.inject()

  await props.run('签到', 'checkIn', { agentId: 'opencode' }, client.describeCheckIn)

  assert.deepEqual(plain(calls.at(-1)), { agentId: 'opencode' }, '入参要透传到宿主端点')
  const text = panel.actionMessage?.text ?? ''
  assert.match(text, /1 个账号领到 10 积分/, '必须显示 describeCheckIn 的措辞（转发被吞时就只有「签到 完成」）')
  assert.ok(!/^签到 完成$/.test(text), '不能退化成兜底文案「签到 完成」')

  // 「今天已经领过」也要能分开说 —— 这才是 describeCheckIn 存在的理由
  remote.checkIn = async () => ({
    ok: true,
    value: [{ accountId: 'qoder:a1', ok: true, supported: true, credits: 0, recorded: true, message: '' }],
  })
  await props.run('签到', 'checkIn', { agentId: 'opencode' }, client.describeCheckIn)
  assert.match(panel.actionMessage.text, /今天已经领过/, '「今天已领」与「领到了」必须分得开')
  panel.dispose()
})

// ───────────────────── 用户真机报的第四轮（2026-10-20）─────────────────────

test('任务流水：时间读宿主的 `at`，详情读 `message`（曾读 ts/detail → NaN:NaN:NaN 与空白）', () => {
  // 宿主 `TaskLogRecord`（src/core/tasks.ts）写进 task-log 的字段是
  //   `at` / `message` / `credits`，
  // 而这里早先读的是 `ts` / `detail` / `error` —— 三个全错，于是：
  //   · 时间列画成「NaN:NaN:NaN」（`new Date(undefined)` **不抛异常**，
  //     只会产出 Invalid Date，getHours() 返回 NaN）；
  //   · 详情列永远空白（用户看不到「领取成功，+100 积分」）。
  // 下面这两条是**从本机真实 task-log.jsonl 抄下来的行**，不是编的。
  const { panel } = dashboardWith({ page: 'tasks' })
  const projection = panel.projection()
  const state = {
    ...projection,
    shell: { ...projection.shell, page: 'tasks' },
    snapshot: {
      status: 'ready',
      error: null,
      value: {
        ...projection.snapshot.value,
        taskLog: [
          { at: 1792471027798, agentId: 'qoder-cn', accountLabel: 'Qoder CN 账号', kind: 'checkin', ok: true, credits: 100, message: '领取成功，+100 积分', attempt: 1 },
          { at: 1792456831105, agentId: 'qoder', accountLabel: 'Qoder 账号', kind: 'checkin', ok: false, credits: 0, message: '该账号尚未在 Qoder 侧开通每日领取', attempt: 1 },
        ],
      },
    },
  }
  const html = client.DashboardHTML(state)

  assert.ok(!html.includes('NaN'), '时间列绝不能画成 NaN:NaN:NaN')
  assert.ok(/<td>0[78]:\d{2}:\d{2}<\/td>/.test(html), '要显示真实的本地时钟')
  assert.ok(html.includes('领取成功，+100 积分'), '详情列要显示宿主的 message')
  assert.ok(html.includes('+100'), '领到的积分要显式标出来')
  panel.dispose()
})

test('时钟兜底：无效时间戳画「—」而不是 NaN（new Date(undefined) 不抛异常）', () => {
  // clockText 早先只 try/catch —— 但 Invalid Date **不会**抛异常，
  // 于是所有非法输入都安静地渲染成「NaN:NaN:NaN」。这条把兜底行为钉死。
  for (const bad of [undefined, null, NaN, 0, -1, 'abc', {}]) {
    const html = client.DashboardHTML({
      shell: { page: 'tasks', dirty: false, dirtyCount: 0, saving: false, saved: false, advancedOpen: false, writable: true, status: 'ready' },
      global: [],
      agentFields: [],
      snapshot: {
        status: 'ready',
        error: null,
        value: {
          enabled: true,
          totals: { accounts: 0, enabledAccounts: 0, degraded: 0 },
          agents: [],
          jobs: [],
          taskLog: [{ at: bad, agentId: 'qoder', kind: 'checkin', ok: true, message: 'x', attempt: 1 }],
        },
      },
      selectedAgent: 'opencode',
      models: { status: 'idle', agentId: null, items: [], error: null },
      modelPolicy: { mode: 'selected', selected: [], selectedIds: [], exposedIds: [], filter: '', windowOverrides: {} },
      summary: { status: 'idle', data: null, error: null },
      log: { status: 'idle', entries: [], total: 0, page: 1, pageSize: 20, error: null },
      update: { status: 'idle' },
      busy: null,
      probing: [],
      actionMessage: null,
      remoteError: null,
      login: { status: 'idle' },
    })
    assert.ok(!html.includes('NaN'), `时间戳 ${JSON.stringify(bad)} 渲染出了 NaN`)
  }
})

test('动作提示在切页后必须消失（曾跟着用户跑到别的页面）', async () => {
  // 用户原话：「切换选项卡后，这个提示在顶部一直存在。」
  // 那是「刚才那一下干了什么」的一次性反馈，属于**触发它的那一页**。
  const { panel } = dashboardWith({ page: 'accounts' })
  const props = panel.inject()

  // 造一条动作提示（走真实路径：run 会把结果写进 actionMessage）
  const remote = { refreshQuota: async () => ({ ok: true, value: [] }) }
  panel.remoteCtx = { remote: { multiAgentGateway: remote } }
  await props.run('刷新额度', 'refreshQuota', {}, () => '1 个账号额度已更新：Qoder CN 账号 900 积分')
  assert.ok(
    client.DashboardHTML(panel.projection()).includes('1 个账号额度已更新'),
    '前置：提示应当先出现在当前页',
  )

  panel.setPage('tasks')
  const after = client.DashboardHTML(panel.projection())
  assert.ok(!after.includes('1 个账号额度已更新'), '切页后提示必须消失')
  assert.ok(after.includes('任务流水'), '前置：切页本身要生效')
  panel.dispose()
})

// ───────────── 左侧导航栏入口（用户要求「像插件市场那样加到此处」）─────────────

/**
 * 造一个假 ctx，把 `slots.register` / `slots.inject` 的调用**录下来**。
 *
 * 为什么要专门造一个：`fakeBrowserContext` 里的 `slots` 两件事都做不了 ——
 * `register` 直接返回空注销器、`inject` 无条件立刻执行回调。于是
 * 「注册了哪些槽位」「槽位不存在时会不会硬注册」这两条根本验不出来，
 * 而它们正是这次改动最要紧的地方（旧宿主上硬注册 = 整个条目 failed）。
 *
 * `slots` 支持 `missing`：列在里面的槽位**不被声明**，于是 `inject` 的回调
 * 一次都不执行 —— 用来模拟「这个宿主没有某个槽位」。
 */
function sidebarContext({ missing = [] } = {}) {
  const registered = []
  const injected = []
  const disposed = []
  const value = { enabled: true, agents: {} }
  const scope = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', available: true, writable: true, value, user: null, revision: 1 }),
    mutate: async () => ({ ok: true }),
  }
  const ctx = {
    disposed,
    effect: (fn) => {
      const off = fn()
      const dispose = typeof off === 'function' ? off : () => {}
      disposed.push(dispose)
      return dispose
    },
    on: () => {},
    logger: { info() {}, warn() {}, error() {} },
    locale: { bind: () => (key) => key, register: () => () => {} },
    configForms: {
      get: () => scope,
      whileServed: (_namespaces, register) => {
        const off = register(new Set(['dsh-multi-agent-gateway']))
        return typeof off === 'function' ? off : () => {}
      },
    },
    slots: {
      inject: (name, run) => {
        injected.push(name)
        // 契约：`inject` 的 callback **只在槽位被声明之后**才跑。
        // 没有这个槽位的宿主上，它一次都不执行 —— 我们要的就是这个性质。
        return missing.includes(name) || typeof run !== 'function' ? undefined : run()
      },
      register: (options, component) => {
        const off = () => {
          const at = registered.findIndex((item) => item.options === options)
          if (at >= 0) registered.splice(at, 1)
        }
        registered.push({ options, component, off })
        return off
      },
      getVersion: () => 0,
      entries: () => registered.map((item) => ({ options: item.options })),
    },
    remote: { $mount: async () => {}, multiAgentGateway: {} },
    inject(names, callback) {
      void names
      return callback(this)
    },
  }
  return { ctx, registered, injected, disposed }
}

/** 只保留某个槽位的注册记录。 */
const entriesOf = (registered, name) => registered.filter((item) => item.options.name === name)

/**
 * `apply` 之后等初始读取落定。
 *
 * `sidebarEntry.load()` 是**异步**的（要读 localStorage）。`apply` 返回时它
 * 还没回来，此刻侧栏那两个槽位是按「乐观默认」注册着的；读完发现设置页入口
 * 也在，就按「不抢宿主那一行」的口径**收回去**。所以断言槽位之前必须让它落定，
 * 否则测的是中间那一瞬间的状态。
 *
 * 用 `setImmediate` 而不是 `setTimeout`：只要把已排队的微任务/宏任务跑完即可，
 * 不引入断言之外的时间依赖。
 */
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('侧栏入口：main 与 sidebar.panellist 一起注册，且用同一个 panel id', async () => {
  // 宿主就是靠这两个值**相等**把「点了哪一行」与「渲染哪个面板」对上的
  // （layout.selectPanel(id) → activePanelId → main 槽按 key 取 occupant）。
  // 两边写成不同的字符串，表现是「侧栏多了一行，点了什么都不发生」，且不报错。
  //
  // ⚠️ 这里模拟的是「设置页入口不可用」的宿主 —— 那种情况下侧栏是唯一入口，
  // 没回答过的用户默认就该看到这一行（另一条用例单独验「设置页在就不抢那一行」）。
  const { ctx, registered } = sidebarContext({ missing: ['settings.section'] })
  client.apply(ctx)
  await settle()

  const main = entriesOf(registered, 'main')
  const rows = entriesOf(registered, 'sidebar.panellist')
  assert.equal(main.length, 1, 'main 槽要注册一次 —— 少了它，点侧栏不会切页面')
  assert.equal(rows.length, 1, 'sidebar.panellist 槽要注册一次 —— 少了它，左边根本没有这一行')
  assert.equal(main[0].options.key, client.SIDEBAR_PANEL_ID, 'main 的 key 必须用本插件的 panel id')
  assert.equal(rows[0].options.id, client.SIDEBAR_PANEL_ID, 'panellist 的 id 必须与 main 的 key 是同一个值')
  assert.equal(
    main[0].options.key,
    rows[0].options.id,
    '两个槽位必须共用同一个 id —— 不等就是「点了没反应」',
  )
  // order：排在宿主自带的「插件」(0)、「定时任务」(10) 之后，别挤到它们前面。
  assert.equal(rows[0].options.order, 20, '第三方插件的行要排在宿主自己的页面后面')
  assert.equal(typeof rows[0].options.label, 'function', 'label 要是 thunk，切语言才不用重新注册')
  // `locale` 指的是**字典命名空间**（`DICT`），不是包名 —— 与别处 `face()` 同口径。
  assert.equal(rows[0].options.locale, 'settings.multi-agent-gateway', 'locale 要指到本插件的字典')
  assert.equal(rows[0].options.locale, main[0].options.locale, '两个槽位要用同一个字典命名空间')
})

test('侧栏入口：默认不抢宿主那一行 —— 设置页入口在时侧栏不出现', async () => {
  // 侧栏的全局行本来是宿主自己的页面（插件、定时任务）。第三方插件**不该**
  // 默认往里挤：设置页能进的时候，这一行是用户主动打开的。
  const { ctx, registered } = sidebarContext()
  client.apply(ctx)
  await settle()

  assert.equal(entriesOf(registered, 'settings.section').length, 1, '前置：设置页入口在')
  assert.equal(
    entriesOf(registered, 'sidebar.panellist').length,
    0,
    '设置页能进就不该默认占侧栏的行（用户主动打开时才加）',
  )
  assert.equal(entriesOf(registered, 'main').length, 0, '面板槽与侧栏行是一体的，一起不注册')

  // 用户主动打开后，两个槽位都要出现 —— 并且用的还是同一个 id。
  const props = new client.GatewayPanel(
    { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', available: true, writable: true, value: { enabled: true, agents: {} }, user: null, revision: 1 }), mutate: async () => ({ ok: true }) },
    ctx,
  ).inject()
  await props.setSidebarEntry(true)
  const main = entriesOf(registered, 'main')
  const rows = entriesOf(registered, 'sidebar.panellist')
  assert.equal(main.length, 1, '用户选了「加」之后 main 要出现')
  assert.equal(rows.length, 1, '用户选了「加」之后侧栏行要出现')
  assert.equal(main[0].options.key, rows[0].options.id, '两条路径注册的 id 必须一致')

  // 再关掉 → 两个都收回去（不能只收一个，那会留下「点了没反应」的鬼行）。
  await props.setSidebarEntry(false)
  assert.equal(entriesOf(registered, 'main').length, 0, '关掉之后 main 要收回去')
  assert.equal(entriesOf(registered, 'sidebar.panellist').length, 0, '关掉之后侧栏行要收回去')
})

test('侧栏入口：main 渲染的是现有面板（复用 GatewayPanelView，不是第二套 UI）', async () => {
  const { ctx, registered } = sidebarContext({ missing: ['settings.section'] })
  client.apply(ctx)
  await settle()
  const main = entriesOf(registered, 'main')[0]
  assert.ok(main !== undefined, '前置：侧栏是唯一入口时这一行要注册上')

  // 组件身份：点侧栏后那一页必须就是设置页那个组件，否则会出现
  // 「设置页能用、侧栏那一页是另一套」的半坏状态。
  assert.notEqual(
    main.component,
    client.GatewayPanelView,
    'main 外面要包一层滚动容器（见下一条），所以它不该直接是 GatewayPanelView',
  )
  const element = main.component({ view: 'page', t: (key) => key, useGatewayPanel: () => null })
  assert.equal(element.props.className, 'mag-page', 'main 外面那层要负责滚动')
  // ⚠️ children 必须走 props —— `jsx(type, props, key)` 的第三个实参是 **key**，
  // 子元素放那儿会被整块丢掉、渲染成空壳（探针实测踩到过一次）。
  assert.equal(
    element.props.children?.type,
    client.GatewayPanelView,
    'main 里必须是 GatewayPanelView —— 不能是第二套 UI',
  )
})

test('侧栏入口：那一行渲染出图标，且尺寸跟着宿主给的值', async () => {
  const { ctx, registered } = sidebarContext({ missing: ['settings.section'] })
  client.apply(ctx)
  await settle()
  const row = entriesOf(registered, 'sidebar.panellist')[0]
  assert.ok(row !== undefined, '前置：侧栏是唯一入口时这一行要注册上')

  // 宿主对 `sidebar.panellist` 的 occupant 传 `{ size, active }`：
  // 宽栏 16、窄栏 18。图标要照收，否则窄栏会偏大、宽栏会偏小。
  const wide = row.component({ size: 16, active: false })
  const narrow = row.component({ size: 18, active: true })
  assert.equal(wide.type, 'svg', '侧栏图标要是个 svg')
  assert.equal(wide.props.width, 16)
  assert.equal(narrow.props.width, 18, 'size 要跟着宿主给的走，不能写死')
  assert.equal(wide.props.className, 'mag-navicon')
  // 用 currentColor 而不是写死颜色：行的颜色（含选中态）由宿主控制，
  // 写死颜色在浅色主题下就看不见了。
  assert.equal(wide.props.stroke, 'currentColor')
  assert.ok(!/fill="#/.test(JSON.stringify(wide.props)), '别写死填充色')
  assert.equal(wide.props['aria-hidden'], 'true', '纯装饰的图标不进无障碍树')
  // 缺省（宿主没给 size）时退化成 16，不能是 NaN/undefined 把 svg 弄坏。
  assert.equal(row.component({}).props.width, 16)
  assert.equal(row.component({ size: 0 }).props.width, 16, 'size=0 也该退回默认值')
})

test('侧栏入口：没回答过 → 默认可见；显式关 → 不可见；显式开 → 可见', async () => {
  /** 造一个「读得到某个已存值」的假 localStorage。 */
  const storeWith = (raw) => ({
    getItem: () => (raw === undefined ? null : raw),
    setItem: () => {},
  })
  /** 走完整链路：闸门 + 存取 + 控制器。 */
  const build = (raw, { otherSeat = false } = {}) => {
    const gate = client.createSectionGate(() => () => {}, false)
    const entry = client.createSidebarEntry({
      gate,
      store: client.createSidebarStore(storeWith(raw)),
      hasOtherSeat: () => otherSeat,
    })
    entry.markSupported()
    return { entry, gate }
  }

  // ① 从没回答过 + 侧栏是唯一入口 → 默认**显示**。
  //    这是「入口是这一页的门，不能默认把门藏起来」那条口径。
  const fresh = build(undefined)
  await fresh.entry.load()
  assert.equal(fresh.entry.chosen(), false, '没存过就是「从没回答过」')
  assert.equal(fresh.entry.shown(), true, '没回答过时默认要显示出来')
  assert.equal(fresh.gate.visible(), true, '闸门要真的把它显形')

  // ② 显式选了关 → 以用户的为准，别再自作聪明打开。
  const off = build(JSON.stringify({ v: 1, enabled: false }))
  await off.entry.load()
  assert.equal(off.entry.chosen(), true, '存过就算回答过')
  assert.equal(off.entry.shown(), false, '用户选了关就必须不显示')
  assert.equal(off.gate.visible(), false, '闸门要真的把它收回去')

  // ③ 显式选了开 → 可见。
  const on = build(JSON.stringify({ v: 1, enabled: true }))
  await on.entry.load()
  assert.equal(on.entry.shown(), true, '用户选了开就必须显示')

  // ④ 设置页入口在的时候，没回答过**不抢**侧栏那一行
  //    （侧栏的全局行本来是宿主自己的页面，第三方插件不该默认往里挤）。
  const withSeat = build(undefined, { otherSeat: true })
  await withSeat.entry.load()
  assert.equal(withSeat.entry.shown(), false, '设置页能进就不该默认占侧栏的行')
  assert.equal(withSeat.entry.onlyDoor(), false)
  // 但用户一旦主动选了开，即使设置页入口在也要显示。
  await withSeat.entry.set(true)
  assert.equal(withSeat.entry.shown(), true, '用户主动要的，与有没有别的入口无关')
})

test('侧栏入口：慢的初始 load 不得覆盖用户随后的显式选择', async () => {
  // 真实场景：用户打开面板，`load()` 还在飞，他已经顺手点了「不用」。
  // 若不加防护，那个**过期**的「开着」回来后又把界面改回显示 ——
  // 用户会以为开关坏了，而它其实忠实地执行了一条早已作废的指令。
  let release
  const store = {
    read: () => new Promise((resolve) => { release = resolve }),
    write: async () => {},
  }
  const gate = client.createSectionGate(() => () => {}, false)
  const entry = client.createSidebarEntry({ gate, store, hasOtherSeat: () => false })
  entry.markSupported()

  const loading = entry.load()
  // 用户在选择到达之前就表态。
  await entry.set(false)
  assert.equal(entry.shown(), false, '前置：用户的选择先落地')

  // 现在那个慢读取才回来，而且带的是相反的值。
  release({ chosen: true, enabled: true })
  await loading
  assert.equal(entry.shown(), false, '慢 load 回来也不得推翻用户的选择（epoch 对不上就丢掉）')
  assert.equal(entry.enabled(), false, '内存态一样不能被覆盖')

  // 反向也要成立：慢读取带回「关」，而用户刚点了「开」。
  let release2
  const store2 = { read: () => new Promise((r) => { release2 = r }), write: async () => {} }
  const gate2 = client.createSectionGate(() => () => {}, false)
  const entry2 = client.createSidebarEntry({ gate: gate2, store: store2, hasOtherSeat: () => false })
  entry2.markSupported()
  const loading2 = entry2.load()
  await entry2.set(true)
  release2({ chosen: true, enabled: false })
  await loading2
  assert.equal(entry2.shown(), true, '反过来也一样：慢 load 不能把「开」改回「关」')
})

test('侧栏入口：localStorage 不可用 / 内容损坏 → 退化成「从没回答过」，不抛异常', async () => {
  const build = (box) => {
    const gate = client.createSectionGate(() => () => {}, false)
    const entry = client.createSidebarEntry({ gate, store: client.createSidebarStore(box), hasOtherSeat: () => false })
    entry.markSupported()
    return entry
  }

  // ① 内容损坏（半截 JSON / 不是对象 / 没有布尔字段）—— 全都必须当成
  //    「从没回答过」。当成「选了关」的话入口会**永久消失**，而用户根本
  //    不知道自己什么时候关过它。这一条是本次最要紧的判据。
  const broken = [
    '{坏掉的 json',
    '',
    'null',
    '[]',
    '"true"',
    '{}',
    JSON.stringify({ v: 1 }),
    JSON.stringify({ v: 1, enabled: 'true' }),   // 字符串 "true" 不算布尔
    JSON.stringify({ v: 1, enabled: 1 }),        // 数字 1 也不算
    JSON.stringify({ enabled: null }),
  ]
  for (const raw of broken) {
    const entry = build({ getItem: () => raw, setItem: () => {} })
    await entry.load()
    assert.equal(entry.chosen(), false, `内容 ${JSON.stringify(raw)} 必须退化成「从没回答过」`)
    assert.equal(entry.shown(), true, `内容 ${JSON.stringify(raw)} 之后仍该按默认值显示`)
  }

  // ② 整个 localStorage 不可用（读它的那一刻就抛）—— 不崩，同样退化成没回答过。
  const throwing = build({
    getItem() { throw new Error('SecurityError: localStorage 被拦下') },
    setItem() { throw new Error('SecurityError: localStorage 被拦下') },
  })
  await assert.doesNotReject(() => throwing.load(), '读 localStorage 抛异常不能把 load 打挂')
  assert.equal(throwing.chosen(), false, '读失败 = 从没回答过，不能当成选了关')
  assert.equal(throwing.shown(), true, '仍然按默认值显示')

  // ③ 写入失败：内存态照旧生效（用户看到开关动了），但要记下失败原因
  //    如实告诉他 —— 默默不存、下次启动又变回去才是最难查的那种。
  await throwing.set(true)
  assert.equal(throwing.shown(), true, '内存态要照常生效，不能因为写不进去就退回')
  assert.ok(
    typeof throwing.saveError() === 'string' && throwing.saveError() !== '',
    '写失败必须留下来，界面才能如实说明「这次没存住」',
  )

  // ④ 完全没有 localStorage 这个全局（测试 VM 就是）—— 一样不能崩。
  const nothing = client.createSidebarStore(null)
  const read = await nothing.read()
  assert.equal(read.chosen, false, '没有 localStorage 时不能假装用户回答过')
})

test('侧栏入口：槽位不存在的旧宿主上优雅退化（不注册、不抛错、设置页入口仍在）', async () => {
  // 旧宿主没有 `sidebar.panellist`。硬注册会静默失效或直接抛错拖垮整个客户端
  // 条目 —— 表现是插件整体 `failed`，连设置页一起消失。
  const { ctx, registered, injected } = sidebarContext({ missing: ['sidebar.panellist'] })
  assert.doesNotThrow(() => client.apply(ctx), '槽位不存在时 apply 不能抛')
  await settle()

  // `slots.inject` 仍然被调用（我们声明了兴趣），但宿主没声明这个槽位，
  // 所以回调**一次都没执行** —— 于是下面两个槽位一个都没注册。
  assert.ok(injected.includes('sidebar.panellist'), '要声明对 sidebar.panellist 的兴趣')
  assert.equal(entriesOf(registered, 'sidebar.panellist').length, 0, '槽位不存在时绝不能硬注册侧栏行')
  assert.equal(entriesOf(registered, 'main').length, 0, '面板槽也一起不注册（两个是一体的）')

  // 设置页那三处入口照旧 —— 退化的是侧栏入口，不是整个插件。
  assert.equal(entriesOf(registered, 'settings.section').length, 1, '设置页入口必须还在')
  assert.equal(entriesOf(registered, 'plugins.bundle.config').length, 1, '包页入口必须还在')
  assert.equal(entriesOf(registered, 'plugins.row.config').length, 1, '包页那一行的入口必须还在')

  // 界面要诚实说明「这个宿主做不到」，而不是画一个点不动的开关不作解释。
  const html = client.sidebarCardHTML()
  assert.ok(html.includes('sidebar.panellist'), '要如实点出缺的是哪个槽位')
  assert.ok(html.includes('disabled'), '做不到时开关要是禁用的')
})

test('侧栏入口：设置页开关 + 顶部一次性提示（回答过就不再出现）', async () => {
  // ⚠️ 顶部那条提示只在「没回答过**且还没显示**」时出现。所以这里必须用
  // **设置页入口在**的宿主：那种情况下侧栏不是唯一入口、默认不显示，
  // 提示才有意义。反面（默认已经显示了还问「要不要加」）单独在下面验。
  const { ctx } = sidebarContext()
  client.apply(ctx)
  await settle()

  // ① 设置页卡片存在（与「版本更新」「关于」并列）。
  const card = client.sidebarCardHTML()
  assert.ok(card.includes('左侧导航栏'), '设置页要有这一项')
  assert.ok(card.includes('data-act="sidebar-toggle"'), '设置页要有个开关')

  // ② 顶部提示这时才该出现。
  const banner = client.sidebarBannerHTML()
  assert.ok(banner.includes('要不要把它放到左侧导航栏'), '没回答过时要给一次提示')
  assert.ok(banner.includes('data-act="sidebar-on"'), '提示要能直接「添加」')
  assert.ok(banner.includes('data-act="sidebar-off"'), '提示要能直接「不用」')

  // ③ 回答过之后提示必须消失（这就是「回答过就不再出现」）。
  //    走真实控制器：`apply` 建好的那个就是界面读的那个。
  const props = new client.GatewayPanel(
    { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', available: true, writable: true, value: { enabled: true, agents: {} }, user: null, revision: 1 }), mutate: async () => ({ ok: true }) },
    ctx,
  ).inject()
  await props.setSidebarEntry(false)
  assert.equal(client.sidebarBannerHTML(), '', '回答过之后顶部提示必须消失')
  await props.setSidebarEntry(true)
  assert.equal(client.sidebarBannerHTML(), '', '回答过之后就不再提示，哪怕回答的是「加」')

  // ④ 反面：某一行的显示**已经**是默认值（侧栏是唯一入口）时，
  //    不该还问「要不要加」—— 那一行明明就在左边，问这个自相矛盾。
  const onlyDoor = sidebarContext({ missing: ['settings.section'] })
  client.apply(onlyDoor.ctx)
  await settle()
  assert.equal(
    client.sidebarBannerHTML(),
    '',
    '这一行已经显示出来了就不该再问「要不要加」（要关请去设置页的卡片）',
  )
})

test('侧栏入口：面板里的点击能改到控制器（两个方向都取反）', async () => {
  const { ctx } = sidebarContext({ missing: ['settings.section'] })
  client.apply(ctx)
  await settle()

  // 走真实链路：面板 → `props.setSidebarEntry` → 控制器 → localStorage。
  // `dashboardWith` 里的 `apply` 已经把控制器建好了，这里直接取面板来驱动。
  const panel = new client.GatewayPanel(
    { subscribe: () => () => {}, getSnapshot: () => ({ status: 'ready', available: true, writable: true, value: { enabled: true, agents: {} }, user: null, revision: 1 }), mutate: async () => ({ ok: true }) },
    ctx,
  )
  const props = panel.inject()
  assert.equal(typeof props.setSidebarEntry, 'function', '面板必须把 setSidebarEntry 交给视图')

  // 两个方向都要能改 —— 「只能单向生效」正是任务页那两个开关踩过的坑。
  await props.setSidebarEntry(false)
  assert.equal(client.sidebarCardHTML().includes('未加入左侧导航栏'), true, '关掉之后卡片要显示未加入')
  await props.setSidebarEntry(true)
  assert.equal(client.sidebarCardHTML().includes('已加入左侧导航栏'), true, '打开之后卡片要显示已加入')
  panel.dispose()
})

// ───────── 请求日志的模型列（用户报「全是 qfmodel，不是选中的模型名」）─────────

/**
 * ⚠️ **2026-10-20 用户报障**：「请求日志的模型名全部都是 `qfmodel`，
 * 并不是真实选中的模型名称。」
 *
 * 记录**没错** —— `qfmodel` 是上游目录 key、也正是发出去的值；
 * 但它在界面上不可见（选择器里写的是 `Qwen3.8-Flash`）。
 * 修法：宿主同时记 `model`（key）与 `modelName`（展示名），
 * 这里钉住**界面优先显示展示名、且 key 仍能从 title 读到**。
 */
test('请求日志：模型列显示选择器里的名字，目录 key 放进 title', () => {
  const { panel } = dashboardWith({ page: 'logs' })
  const projection = panel.projection()
  const state = {
    ...projection,
    shell: { ...projection.shell, page: 'logs' },
    log: {
      status: 'ready',
      error: null,
      total: 2,
      page: 1,
      pageSize: 20,
      entries: [
        // ① 两个字段都在：显示展示名，title 留 id
        { ts: 1792477000000, agentId: 'qoder-cn', agentName: 'Qoder CN', model: 'qfmodel', modelName: 'Qwen3.8-Flash', accountId: null, ok: true, durationMs: 1200 },
        // ② 只有 id（老记录 / 拿不到元数据）：退回显示 id，不能空着
        { ts: 1792477001000, agentId: 'qoder-cn', agentName: 'Qoder CN', model: 'dfmodel', accountId: null, ok: true, durationMs: 900 },
      ],
    },
  }
  const html = client.DashboardHTML(state)

  assert.ok(html.includes('Qwen3.8-Flash'), '有展示名时必须显示它 —— 否则用户读不懂日志')
  assert.ok(
    html.includes('title="qfmodel"'),
    '目录 key 要留在 title 里 —— 排查时看的仍然是它',
  )
  assert.ok(html.includes('dfmodel'), '没有展示名时退回显示 id（不能空着）')
  panel.dispose()
})

