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