/**
 * 「账号门」回归 —— 用户报障：
 *
 * > 「当某个平台的账号被全部移除后，则在对话框的模型选择列表中，不要再显示该平台的模型」
 *
 * 两条根因，这个文件**各钉一组**：
 *
 *   - **A（判据）**：`exposedAgentIds()` 只看「配置上启用了吗」，不看「有没有账号」
 *     ⇒ 零账号的平台照样进选择器、照样进 `allModels()`。修法是把**账号门**
 *     加进新的 `isAgentExposed()`。
 *   - **B（通知）**：删账号只重建定时任务，**不通知 DSH 重读模型目录** ——
 *     DSH 的下拉只在收到 `llm/adapters-updated`（由 `handle.replace()` 发出）时才重读。
 *     不修这条，判据修好了用户**不重启还是看到旧分组**。
 *
 * ## 两条边界（刻意钉住，别再改回去）
 *
 * 1. **免账号平台必须保留**：`opencode` 零账号时仍在选择器里 —— 零凭证用免费模型
 *    正是这个插件的卖点（README 的「Free Token」）。判据落在**适配器自己声明的**
 *    `capabilities.accountFree` 上，而**不是**宿主侧写死一个平台名数组：
 *    客户端 `client.js` 已经有一份 `FREE_ONLY` 硬编码，宿主再抄一份，两份迟早漂移
 *    （「四处清单不一致」这个坑本项目踩过一次，见 `config.ts` 的注释）。
 * 2. **"可用账号" 用 `routable` 口径**（`enabled && routeChat !== false`），
 *    与路由器自己的候选口径一致 ⇒ 选择器里出现的东西，路由器真的路由得到。
 *
 * 假 adapter + 内存构造的 AccountManager，**不打真实上游、不碰用户真实账号**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GatewayRuntime, accountGateDecision } from '../lib/runtime.js'
import { resolveConfig } from '../lib/config.js'
import { apply } from '../lib/index.js'
import { builtinAdapters } from '../lib/adapters/index.js'

/** 静默日志器：测试不该往控制台刷日志。 */
const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** 造一个假适配器（只关心 `capabilities.accountFree` 与 id/name）。 */
function makeAdapter(id, name, options = {}) {
  return {
    id,
    name,
    capabilities: {
      checkIn: false,
      quota: false,
      models: true,
      tasks: false,
      chat: true,
      reasoning: false,
      ...(options.accountFree === true ? { accountFree: true } : {}),
      source: 'static',
    },
    implemented: true,
    getCredentials: () => ({}),
    validateCredentials: async () => ({ ok: true }),
    checkIn: async () => ({ ok: false, supported: false, message: '上游不支持签到', at: Date.now() }),
    getQuota: async (record) => ({ accountId: record.id, unit: 'credits', fetchedAt: Date.now() }),
    // 模型目录：免鉴权，所以「零账号」也能拉到 —— 这正是必须靠账号门、
    // 而不能靠「拉不到模型所以自然为空」的原因。
    getModelMetaList: async () => [
      { id: `${id}-model-1`, name: `${name} Model 1`, agentId: id, agentName: name },
      { id: `${id}-model-2`, name: `${name} Model 2`, agentId: id, agentName: name },
    ],
    fetchAvailableTasks: async () => [],
    executeTask: async () => ({ ok: false, supported: false, message: '上游不支持' }),
    checkTaskStatus: async () => ({ ok: false, supported: false, message: '上游不支持' }),
    async *requestChatStream() {},
    detectError: () => undefined,
  }
}

/**
 * 造一个真 `GatewayRuntime`：
 *
 *   `freechan`  —— 免账号通道（声明 `accountFree: true`），类比 opencode
 *   `needacct`  —— 必须有账号，类比 qoder / workbuddy
 *   `hidden`    —— 必须有账号，但 `visible: false`，类比 trae（默认隐藏）
 *
 * ⚠️ 必须**显式**写 `enabled` / `visible`：`resolveConfig` 对没见过的 agentId
 * 默认是 `enabled = registryHas && DEFAULT_VISIBLE_AGENTS.includes(id)`，
 * 而这三个是测试专用的假 id，不在那份名单里 ⇒ 不写就是「未启用」，什么都测不到。
 */
function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mag-gate-'))
  const adapters = [
    makeAdapter('freechan', 'Free Channel', { accountFree: true }),
    makeAdapter('needacct', 'Needs Account'),
    makeAdapter('hidden', 'Hidden Platform'),
  ]
  const config = resolveConfig(
    {
      dataDir: dir,
      agents: {
        freechan: { enabled: true, visible: true },
        needacct: { enabled: true, visible: true },
        hidden: { enabled: false, visible: false },
        ...(options.agents ?? {}),
      },
    },
    { knownAgentIds: ['freechan', 'needacct', 'hidden'], defaultDataDir: dir },
  )
  const runtime = new GatewayRuntime({ config, adapters, dshLogger: silent })
  return { runtime, dir, adapters }
}

function teardown(h) {
  h.runtime.dispose?.()
  rmSync(h.dir, { recursive: true, force: true })
}

// ═══════════════════ 纯判定：accountGateDecision ═══════════════════

test('accountGateDecision：免账号平台零账号也保留（reason 要能区分原因）', () => {
  // 免账号 → 保留
  assert.deepEqual(accountGateDecision({ accountFree: true, routableAccounts: 0 }), {
    exposed: true,
    reason: 'account-free',
  })
  // 有账号 → 保留
  assert.deepEqual(accountGateDecision({ accountFree: false, routableAccounts: 1 }), {
    exposed: true,
    reason: 'has-accounts',
  })
  // 必须有账号但一个都没有 → 门掉
  assert.deepEqual(accountGateDecision({ accountFree: false, routableAccounts: 0 }), {
    exposed: false,
    reason: 'no-accounts',
  })
})

test('accountGateDecision：reason 必须能分辨「免账号保留」与「有账号保留」', () => {
  // ⚠️ 只看 `exposed` 布尔的话，`accountFree` 即使完全写反也照样是 true ——
  // 那这个门就永远测不出「免账号平台被误砍」或「需账号平台被误留」。
  const free = accountGateDecision({ accountFree: true, routableAccounts: 0 })
  const paid = accountGateDecision({ accountFree: false, routableAccounts: 3 })
  assert.equal(free.exposed, paid.exposed, '两者都是 true')
  assert.notEqual(free.reason, paid.reason, '但原因必须不同，否则这个门无法验证')
})

// ═══════════════════ A：判据（免账号保留 / 需账号门掉）═══════════════════

test('零账号时：免账号平台留着，需账号平台门掉', () => {
  const h = harness()
  try {
    const exposed = h.runtime.exposedAgentIds()
    assert.ok(exposed.includes('freechan'), '免账号通道零账号时必须保留 —— 那是它的卖点')
    assert.ok(!exposed.includes('needacct'), '需账号平台零账号时必须门掉（用户报障的核心）')
    assert.ok(!exposed.includes('hidden'), 'visible:false 的依旧不在')
  } finally {
    teardown(h)
  }
})

test('agentAccountGate：能直接问「为什么」，且如实报出账号数', () => {
  const h = harness()
  try {
    const free = h.runtime.agentAccountGate('freechan')
    assert.equal(free.exposed, true)
    assert.equal(free.reason, 'account-free')
    assert.equal(free.accountFree, true)
    assert.equal(free.routableAccounts, 0)

    const needy = h.runtime.agentAccountGate('needacct')
    assert.equal(needy.exposed, false)
    assert.equal(needy.reason, 'no-accounts')
    assert.equal(needy.accountFree, false)
  } finally {
    teardown(h)
  }
})

test('★ 核心回归：加一个账号 → 出现；删掉最后一个 → 又消失', () => {
  const h = harness()
  try {
    assert.equal(h.runtime.isAgentExposed('needacct'), false, '前提：一开始没有账号')

    // ① 加一个账号 → 该平台该出现
    const account = h.runtime.accounts.add({ agentId: 'needacct', label: '唯一的账号', credentials: { token: 't' } })
    assert.equal(h.runtime.isAgentExposed('needacct'), true, '有账号后必须出现')
    assert.ok(h.runtime.exposedAgentIds().includes('needacct'))
    assert.equal(h.runtime.agentAccountGate('needacct').reason, 'has-accounts')

    // ② 删掉这个（也就是最后一个）账号 → 必须再次消失
    assert.equal(h.runtime.removeAccount(account.id), true)
    assert.equal(h.runtime.isAgentExposed('needacct'), false, '★ 删光账号后必须门掉 —— 这就是用户报的那条')
    assert.ok(!h.runtime.exposedAgentIds().includes('needacct'))
  } finally {
    teardown(h)
  }
})

test('留着别的账号时不会误门掉平台（删的必须是「最后一个」）', () => {
  const h = harness()
  try {
    const first = h.runtime.accounts.add({ agentId: 'needacct', label: '账号一', credentials: { token: 't' } })
    h.runtime.accounts.add({ agentId: 'needacct', label: '账号二', credentials: { token: 't' } })

    h.runtime.removeAccount(first.id)
    assert.equal(h.runtime.isAgentExposed('needacct'), true, '还剩一个账号，不该门掉')
    assert.equal(h.runtime.agentAccountGate('needacct').routableAccounts, 1)
  } finally {
    teardown(h)
  }
})

// ═══════════════════ 边界：enabled / routeChat 的取舍 ═══════════════════

test('边界：账号被禁用（enabled:false）算「没有账号」', () => {
  const h = harness()
  try {
    const account = h.runtime.accounts.add({
      agentId: 'needacct',
      label: '被停用的账号',
      credentials: { token: 't' },
      enabled: false,
    })
    // 取舍：`routable` 口径要求 `enabled`。禁用 = 不参与路由 ⇒ 它的模型必然调不动，
    // 显示出来只会让用户点到必然失败的东西。
    assert.equal(h.runtime.isAgentExposed('needacct'), false, '全部账号被停用 ⇒ 门掉')
    assert.equal(h.runtime.agentAccountGate('needacct').reason, 'no-accounts')

    // 「存在但没启用」与「根本不存在」在界面上都叫「没有可用账号」，
    // 但账号本身仍然在账号页看得见（那是 `snapshotState`，不受本门影响）。
    assert.equal(h.runtime.accounts.byAgent('needacct').length, 1, '账号记录本身必须还在')
    assert.ok(
      JSON.stringify(h.runtime.snapshotState()).includes('needacct'),
      '设置页仍然要能看到这个平台（别把设置页一起砍了）',
    )

    // 再启用回来 → 立刻恢复
    h.runtime.updateAccount(account.id, { enabled: true })
    assert.equal(h.runtime.isAgentExposed('needacct'), true, '启用回来后必须恢复 —— 门是可逆的')
  } finally {
    teardown(h)
  }
})

test('边界：routeChat:false 也算「没有可用账号」（只留 enabled 会漏掉这一种）', () => {
  const h = harness()
  try {
    const account = h.runtime.accounts.add({
      agentId: 'needacct',
      label: '不参与对话的账号',
      credentials: { token: 't' },
      routeChat: false,
    })
    // 取舍：用 `routable()` 而不是 `byAgent()`。若只按 `enabled` 过滤，
    // 一个「账号都在、但全部关掉了对话路由」的平台会显示一堆注定失败的模型。
    assert.equal(h.runtime.isAgentExposed('needacct'), false, '全部关掉对话路由 ⇒ 门掉')
    assert.equal(h.runtime.accounts.byAgent('needacct').length, 1, '账号仍在（用户会觉得「我有账号」）')

    // 打开对话路由 → 恢复
    h.runtime.updateAccount(account.id, { routeChat: true })
    assert.equal(h.runtime.isAgentExposed('needacct'), true)
  } finally {
    teardown(h)
  }
})

test('边界：只要还有一个可路由账号就保留（混合 enabled/routeChat）', () => {
  const h = harness()
  try {
    h.runtime.accounts.add({ agentId: 'needacct', label: '停用的', credentials: { token: 't' }, enabled: false })
    h.runtime.accounts.add({ agentId: 'needacct', label: '不管对话的', credentials: { token: 't' }, routeChat: false })
    assert.equal(h.runtime.isAgentExposed('needacct'), false, '两个都不可路由')

    h.runtime.accounts.add({ agentId: 'needacct', label: '能用的', credentials: { token: 't' } })
    assert.equal(h.runtime.isAgentExposed('needacct'), true, '只要有一个能路由的就该保留')
  } finally {
    teardown(h)
  }
})

// ═══════════════════ allModels：被门掉的平台不上报 ═══════════════════

test('allModels() 不返回被门掉的平台的模型（免账号平台照旧返回）', async () => {
  const h = harness()
  try {
    const models = await h.runtime.allModels(true)
    const agents = new Set(models.map((model) => model.agentId))
    assert.ok(agents.has('freechan'), '免账号平台的模型必须还在')
    assert.ok(!agents.has('needacct'), '★ 被门掉的平台一个模型都不该上报')
    assert.ok(!agents.has('hidden'), 'visible:false 的照旧不报')
    assert.equal(models.length, 2, '只剩 freechan 的 2 个模型')

    // 加账号后该平台的模型要回来
    h.runtime.accounts.add({ agentId: 'needacct', label: '账号', credentials: { token: 't' } })
    const after = await h.runtime.allModels(true)
    assert.ok(new Set(after.map((m) => m.agentId)).has('needacct'), '有账号后模型必须重新上报')
    assert.equal(after.length, 4)
  } finally {
    teardown(h)
  }
})

// ═══════════════════ 免账号判据来自适配器声明（不是硬编码）═══════════════════

test('免账号判据来自适配器声明：真实 opencode 声明了 accountFree，其余没声明', () => {
  const byId = new Map(builtinAdapters().map((adapter) => [adapter.id, adapter]))
  assert.equal(byId.get('opencode')?.capabilities.accountFree, true, 'opencode 必须声明免账号')

  // 其余平台一律**不声明**（缺省 = 必须有账号）。
  for (const id of ['qoder', 'qoder-cn', 'workbuddy', 'workbuddy-intl', 'trae']) {
    assert.notEqual(byId.get(id)?.capabilities.accountFree, true, `${id} 不该声明免账号`)
  }
})

test('免账号是适配器声明的，不是宿主写死平台名：换个 id 同样生效', () => {
  const h = harness()
  try {
    // `freechan` 不是任何真实平台名 —— 它仍然因为**声明了** accountFree 而被保留。
    // 这证明判据落在适配器的事实上（写死 ['opencode'] 的话这条会失败）。
    const config = resolveConfig(
      { dataDir: h.dir, agents: { freechan: { enabled: true, visible: true } } },
      { knownAgentIds: ['freechan'], defaultDataDir: h.dir },
    )
    const runtime = new GatewayRuntime({ config, adapters: h.adapters, dshLogger: silent })
    try {
      assert.equal(runtime.isAgentExposed('freechan'), true)
      assert.equal(runtime.agentAccountGate('freechan').reason, 'account-free')
    } finally {
      runtime.dispose?.()
    }
  } finally {
    teardown(h)
  }
})

test('未声明 accountFree 的平台（新平台忘了声明）走严格一侧：零账号即门掉', () => {
  const h = harness()
  try {
    // 缺省语义刻意是「必须有账号」：忘了声明只是「少显示一个分组」（看得见、好修），
    // 而不是「静默多上报一堆调不动的模型」。
    assert.equal(h.runtime.agentAccountGate('needacct').accountFree, false)
    assert.equal(h.runtime.isAgentExposed('needacct'), false)
  } finally {
    teardown(h)
  }
})

// ═══════════════════ B：账号变更要通知 DSH 重读目录 ═══════════════════

/**
 * 造一个最小宿主上下文，捕获 `ctx.llm.registerAdapter` 返回的 handle，
 * 从而数出 `replace()`（= 通知 DSH 重读目录的那个事件）到底被调了几次。
 */
function fakeHostContext() {
  const seen = { registered: [], replaced: [], disposed: [] }
  const ctx = {
    logger: silent,
    get: () => undefined,
    llm: {
      registerAdapter(providers) {
        const provider = providers[0]
        seen.registered.push(provider)
        return Object.assign(
          () => {
            seen.disposed.push(provider)
          },
          {
            replace: (next) => {
              seen.replaced.push(next[0])
            },
          },
        )
      },
    },
    inject: () => {},
    effect: () => {},
    on: () => {},
  }
  return { ctx, seen }
}

test('★ 账号变更触发路由重注册 + 通知 DSH 重读目录（根因 B）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-gate-notify-'))
  const { ctx, seen } = fakeHostContext()
  // 用真适配器，但把平台收窄到 opencode（免账号）+ qoder（需账号）。
  const handle = apply(ctx, { dataDir: dir })
  try {
    // 启动时：opencode 免账号 → 注册；qoder 零账号 → 不注册。
    assert.ok(seen.registered.includes('multiagent-opencode'), '免账号平台启动时就该注册')
    assert.ok(!seen.registered.includes('multiagent-qoder'), '零账号的 qoder 启动时不该注册')

    const before = seen.replaced.length

    // ① 加一个 qoder 账号 → 该平台要注册上，并通知 DSH 重读。
    //    走 `runtime.addAccount()`（公开入口）—— 界面点「添加账号」走的就是这条，
    //    它才会触发 `afterAccountsChanged()`。直接用 `accounts.add()` 是底层写操作，
    //    刻意不带善后（那正是根因 B 的成因）。
    const created = handle.runtime.addAccount({ agentId: 'qoder', label: 'Q', credentials: { token: 't' } })
    assert.ok(seen.registered.includes('multiagent-qoder'), '加账号后该平台必须注册上')
    assert.ok(seen.replaced.length > before, '★ 必须通知 DSH 重读目录，否则界面不刷新')

    // ② 删掉最后一个 qoder 账号 → 路由要被摘掉 + 再通知一次
    const beforeRemove = seen.replaced.length
    handle.runtime.removeAccount(String(created.id))
    assert.ok(seen.disposed.includes('multiagent-qoder'), '★ 删光账号后必须主动摘掉路由')
    assert.ok(seen.replaced.length > beforeRemove, '★ 摘掉之后必须再通知一次，DSH 才会重读')
  } finally {
    handle.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('账号增删改都走 afterAccountsChanged（三种写操作各自触发）', () => {
  const h = harness()
  try {
    const calls = []
    h.runtime.setAccountsChangedHook(() => calls.push('changed'))

    const account = h.runtime.addAccount({ agentId: 'needacct', label: 'A', credentials: { token: 't' } })
    assert.equal(calls.length, 1, 'addAccount 必须触发')

    h.runtime.updateAccount(account.id, { enabled: false })
    assert.equal(calls.length, 2, 'updateAccount 必须触发（enabled 会改变门的结论）')

    h.runtime.removeAccount(account.id)
    assert.equal(calls.length, 3, 'removeAccount 必须触发')

    // 删一个不存在的账号：什么都没变，不该白通知（否则每次误点都刷一次目录）
    h.runtime.removeAccount('needacct:不存在')
    assert.equal(calls.length, 3, '删失败时不该通知')
  } finally {
    teardown(h)
  }
})

test('回调抛错不许把账号操作弄失败（通知失败只记日志）', () => {
  const h = harness()
  try {
    h.runtime.setAccountsChangedHook(() => {
      throw new Error('通知界面炸了')
    })
    // 账号已经删掉了，这时因为「通知 UI 刷新」失败而抛错是荒唐的。
    const account = h.runtime.accounts.add({ agentId: 'needacct', label: 'X', credentials: { token: 't' } })
    assert.doesNotThrow(() => h.runtime.removeAccount(account.id))
    assert.equal(h.runtime.accounts.get(account.id), undefined, '账号必须真的被删掉')
  } finally {
    teardown(h)
  }
})

test('解绑 hook 后不再通知（避免热重载叠监听器）', () => {
  const h = harness()
  try {
    const calls = []
    const off = h.runtime.setAccountsChangedHook(() => calls.push('changed'))
    h.runtime.addAccount({ agentId: 'needacct', label: 'A', credentials: { token: 't' } })
    assert.equal(calls.length, 1)

    off()
    h.runtime.addAccount({ agentId: 'needacct', label: 'B', credentials: { token: 't' } })
    assert.equal(calls.length, 1, '解绑后不该再被调用')
  } finally {
    teardown(h)
  }
})

// ═══════════════════ 别误伤：设置页 / 其它平台 ═══════════════════

test('设置页不过滤账号：零账号的需账号平台仍然在 snapshotState 里', () => {
  const h = harness()
  try {
    const snapshot = h.runtime.snapshotState()
    const agents = snapshot.agents
    const needy = agents.find((item) => item.agentId === 'needacct')
    assert.ok(needy !== undefined, '设置页必须能看到没账号的平台 —— 否则用户没法去登录')

    // ⚠️ 这条是本次改动的**关键边界**：账号门只作用于「选择器」，
    //    不能顺手把设置页也砍了。`enabled` 保持**配置语义**（没被账号门污染），
    //    否则界面会把「只是没配账号」显示成「已停用」。
    assert.equal(needy.enabled, true, 'enabled 是配置语义：平台是启用的，只是没账号')
    assert.equal(needy.visible, true)
    assert.deepEqual(needy.accounts, [], '账号列表如实为空')

    // 而选择器看的是另一套判据 —— 两者故意不同。
    assert.equal(h.runtime.isAgentActive('needacct'), true, '配置上是启用的')
    assert.equal(h.runtime.isAgentExposed('needacct'), false, '但不上报给选择器')

    // 「进选择器的模型数」必须也跟着门归零：否则界面显示「12 个模型进选择器」
    // 而下拉里空空如也 —— 与注释里那个「22 个模型」的老毛病是同一类困惑。
    assert.equal(needy.exposedCount, 0, '被门掉的平台，进选择器的模型数必须是 0')
  } finally {
    teardown(h)
  }
})

test('exposedCount 与选择器同口径：加账号后才有数，删光后归零', async () => {
  // 上报策略用 `all`，否则默认的 `free` 会把假模型全滤掉（那是另一条规则，
  // 这里要单独验的是**账号门**，别让两条规则互相掩盖）。
  const h = harness({ agents: { needacct: { enabled: true, visible: true, models: { mode: 'all' } } } })
  try {
    await h.runtime.allModels(true)
    const countOf = () =>
      h.runtime.snapshotState().agents.find((item) => item.agentId === 'needacct').exposedCount

    // 缓存里有 needacct 的模型，但账号门挡着 ⇒ 必须是 0
    h.runtime.accounts.cacheModels('needacct', [{ id: 'x', name: 'X', agentId: 'needacct', agentName: 'Needs Account' }])
    assert.equal(countOf(), 0, '被门掉时必须报 0，不能报缓存里的数量')

    const account = h.runtime.addAccount({ agentId: 'needacct', label: 'A', credentials: { token: 't' } })
    await h.runtime.modelsOf('needacct', true)
    assert.equal(countOf(), 2, '有账号后按缓存如实报数')

    h.runtime.removeAccount(String(account.id))
    assert.equal(countOf(), 0, '删光账号后又归零')
  } finally {
    teardown(h)
  }
})

test('别误伤：hidden 平台（visible:false）在两种判据下都不活跃', () => {
  const h = harness()
  try {
    assert.equal(h.runtime.isAgentActive('hidden'), false, 'visible:false ⇒ 不活跃')
    assert.equal(h.runtime.isAgentExposed('hidden'), false)
    assert.ok(!h.runtime.exposedAgentIds().includes('hidden'))
  } finally {
    teardown(h)
  }
})

test('别误伤：trae 仍然因 visible:false 不在选择器里（真适配器）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-gate-trae-'))
  const adapters = builtinAdapters()
  const config = resolveConfig({ dataDir: dir }, { knownAgentIds: adapters.map((a) => a.id), defaultDataDir: dir })
  const runtime = new GatewayRuntime({ config, adapters, dshLogger: silent })
  try {
    assert.equal(runtime.isAgentActive('trae'), false, 'trae 默认隐藏')
    assert.ok(!runtime.exposedAgentIds().includes('trae'), 'trae 不该进选择器')
    // 免账号的 opencode 零账号仍在；其余四个需账号的平台全部门掉。
    assert.deepEqual(runtime.exposedAgentIds(), ['opencode'], '零账号时只剩免账号通道')
  } finally {
    runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('别误伤：有账号的 Qoder 正常在（真适配器 + 内存账号）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mag-gate-qoder-'))
  const adapters = builtinAdapters()
  const config = resolveConfig({ dataDir: dir }, { knownAgentIds: adapters.map((a) => a.id), defaultDataDir: dir })
  const runtime = new GatewayRuntime({ config, adapters, dshLogger: silent })
  try {
    assert.ok(!runtime.exposedAgentIds().includes('qoder'), '前提：零账号时 qoder 被门掉')

    // 内存里给 qoder 建一个账号（不碰用户真实账号文件）。
    const account = runtime.accounts.add({ agentId: 'qoder', label: '内存账号', credentials: { token: 't' } })
    const exposed = runtime.exposedAgentIds()
    assert.ok(exposed.includes('qoder'), '有账号后 qoder 必须回来')
    assert.ok(exposed.includes('opencode'), 'opencode 不受影响')

    // 删掉后又门掉，且不影响别人
    runtime.removeAccount(account.id)
    assert.ok(!runtime.exposedAgentIds().includes('qoder'))
    assert.ok(runtime.exposedAgentIds().includes('opencode'))
  } finally {
    runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
