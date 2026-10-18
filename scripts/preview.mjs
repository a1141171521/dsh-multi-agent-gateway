// 把新的 client 视图层直接渲染成 HTML（不依赖 React / 宿主），用于截图验收。
// 用法：node scripts/preview.mjs   → preview/*.html（用系统浏览器打开即可）
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = fs.readFileSync(`${root}/client/client.js`, 'utf8')

let definition = null
const window = { __ModuleLoader__: { load: (def) => { definition = def } } }
new Function('window', 'console', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Math', 'Error', 'Symbol', 'document', source)(
  window, console, JSON, Object, Array, Number, String, Boolean, Math, Error, Symbol, undefined,
)
const client = definition.factory((specifier) => {
  if (specifier === 'react/jsx-runtime') return { Fragment: 'F', jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }) }
  if (specifier === 'react') return { useRef: (v) => ({ current: v }), useEffect: () => {}, useState: (v) => [v, () => {}] }
  if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: (i) => ({ getSnapshot: () => i, subscribe: () => () => {}, set: () => {} }) }
  throw new Error(specifier)
})

/* ── 示例数据（形状与宿主快照一致） ─────────────────────────── */

const freeModels = [
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 200000 },
  { id: 'glm-5.3-flash-free', name: 'GLM-5.3 Flash Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 200000 },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 200000 },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1000000 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 262144 },
  { id: 'nemotron-3.5-super-vl-free', name: 'Nemotron 3.5 Super VL Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1048576 },
  { id: 'space-bunny-free', name: 'Space Bunny Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1048576 },
  { id: 'big-pickle', name: 'Big Pickle', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 200000 },
  { id: 'beam-free', name: 'Beam Free', agentId: 'opencode', free: true, multiplier: 0, contextWindow: 1048576 },
]

const buddyModels = [
  { id: 'hy3-preview', name: 'Hy3 Preview', agentId: 'workbuddy', free: true, multiplier: 0, contextWindow: 192000 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', agentId: 'workbuddy', free: true, multiplier: 0, contextWindow: 128000 },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', agentId: 'workbuddy', multiplier: 1.8, contextWindow: 200000 },
  { id: 'claude-opus-4.1', name: 'Claude Opus 4.1', agentId: 'workbuddy', multiplier: 5, contextWindow: 200000 },
  { id: 'gpt-5', name: 'GPT-5', agentId: 'workbuddy', multiplier: 2.4, contextWindow: 400000 },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', agentId: 'workbuddy', multiplier: 0.6, contextWindow: 400000 },
  { id: 'o4-mini', name: 'o4-mini', agentId: 'workbuddy', multiplier: 0.8, contextWindow: 200000 },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', agentId: 'workbuddy', multiplier: 1.5, contextWindow: 1048576 },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', agentId: 'workbuddy', multiplier: 0.5, contextWindow: 1048576 },
  { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', agentId: 'workbuddy', multiplier: 0.4, contextWindow: 128000 },
]

// 宿主的 `models` 端点会带 vendor / availability / ttftMs / probeDetail，
// 预览数据也照着补上，否则截图里的排序和「状态」列不是真机行为。
const VENDOR = {
  'deepseek-v4.1-flash-free': 'DeepSeek',
  'glm-5.3-flash-free': '智谱',
  'mimo-v2.6-flash-free': '小米',
  'longcat-2.5-preview-free': '美团',
  'nemotron-3.5-lightning-free': 'NVIDIA',
  'nemotron-3.5-super-vl-free': 'NVIDIA',
  'space-bunny-free': 'Space',
  'big-pickle': 'Pickle',
  'beam-free': 'Beam',
  'hy3-preview': '腾讯混元',
  'glm-5.3-flash': '智谱',
  'claude-sonnet-4.5': 'Anthropic',
  'claude-opus-4.1': 'Anthropic',
  'gpt-5': 'OpenAI',
  'gpt-5-mini': 'OpenAI',
  'o4-mini': 'OpenAI',
  'gemini-2.5-pro': 'Google',
  'gemini-2.5-flash': 'Google',
  'deepseek-v3.2': 'DeepSeek',
}
const PROBE = {
  'beam-free': { availability: 'region-blocked', probeDetail: '403 RegionError: This model is not available in your country' },
  'glm-5.3-flash-free': { availability: 'available', ttftMs: 512 },
  'glm-5.3-flash': { availability: 'available', ttftMs: 420 },
  'claude-opus-4.1': { availability: 'unavailable', probeDetail: '401 unauthorized' },
}
for (const model of [...freeModels, ...buddyModels]) {
  model.vendor = VENDOR[model.id] ?? ''
  Object.assign(model, PROBE[model.id] ?? { availability: 'unknown' })
}

const account = (over) => ({
  id: 'acc-1', agentId: 'workbuddy', label: '主号', enabled: true,
  routeChat: true, autoCheckIn: true, autoTasks: false,
  authKind: 'oauth-device', autoRefresh: true, expiresAt: Date.now() + 86400000, loginAccount: 'demo@example.com',
  health: { state: 'ok', failures: 0 }, quota: { remaining: 1240, total: 2000, used: 760, unit: 'credits' },
  ...over,
})

const agents = (platform) => [
  { agentId: 'opencode', name: 'OpenCode', visible: true, implemented: true, enabled: true, accounts: [], modelCount: 9, exposedCount: 0 },
  { agentId: 'qoder', name: 'Qoder', visible: true, implemented: true, enabled: true, accounts: [account({ id: 'q1', agentId: 'qoder', label: '主号', quota: { remaining: 840, total: 1000, used: 160, unit: 'credits' } })], modelCount: 3, exposedCount: 0 },
  { agentId: 'qoder-cn', name: 'Qoder CN', visible: true, implemented: true, enabled: true, accounts: [], modelCount: 0, exposedCount: 0 },
  {
    agentId: 'workbuddy', name: 'WorkBuddy', visible: true, implemented: true, enabled: true, modelCount: 10, exposedCount: 0,
    accounts: [
      account({}),
      account({ id: 'acc-2', label: '备用', health: { state: 'degraded', failures: 2 }, quota: { remaining: 320, total: 500, used: 180, unit: 'credits' } }),
    ],
  },
  { agentId: 'workbuddy-intl', name: 'WorkBuddy 国际版', visible: true, implemented: true, enabled: true, accounts: [], modelCount: 0, exposedCount: 0 },
]

const logEntries = [
  { ts: Date.now() - 60000, agentId: 'opencode', agentName: 'OpenCode', model: 'DeepSeek V4.1 Flash Free', accountId: null, ok: true, durationMs: 8400, ttftMs: 380, tps: 38, inputTokens: 8400, outputTokens: 1100, multiplier: 0, free: true },
  { ts: Date.now() - 300000, agentId: 'opencode', agentName: 'OpenCode', model: 'Beam Free', accountId: null, ok: false, durationMs: 120, error: '403 RegionError: This model is not available in your country', multiplier: 0, free: true },
  { ts: Date.now() - 600000, agentId: 'workbuddy', agentName: 'WorkBuddy', model: 'Claude Sonnet 4.5', accountId: 'acc-1', ok: true, durationMs: 6100, ttftMs: 290, tps: 52, inputTokens: 3200, outputTokens: 640, multiplier: 1.8 },
]

const globalFields = [
  { field: { key: 'enabled', kind: 'bool', label: '插件总开关', hint: '关掉后不注册任何 provider，模型选择器里看不到本插件的分组。' }, state: { checked: true, changed: false } },
  {
    field: {
      key: 'routing', kind: 'enum', label: '账号路由策略', hint: 'round-robin = 轮流用；quota-first = 优先用剩余额度高的账号。',
      options: [{ value: 'quota-first', label: 'quota-first（优先额度高）' }, { value: 'round-robin', label: 'round-robin（轮询）' }],
    },
    state: { text: 'quota-first', changed: false },
  },
]

const agentFields = [
  { field: { section: 'basic', key: 'enabled', kind: 'bool', label: '启用这个 Agent', hint: '关掉后不再路由请求，也不再往模型选择器上报模型。' }, state: { checked: true, changed: false } },
  { field: { section: 'basic', key: 'exposeModels', kind: 'bool', label: '上报模型到 DSH 选择器', hint: '关掉后对话框的模型下拉里不会有这个分组。' }, state: { checked: true, changed: false } },
  { field: { section: 'basic', key: 'labelWithAgent', kind: 'bool', label: '模型名带 Agent 前缀', hint: '开启后显示成 `OpenCode · DeepSeek-R1 (×2)`。' }, state: { checked: true, changed: false } },
  { field: { section: 'models', key: 'contextWindowDefault', kind: 'number', label: '默认上下文长度（token）', hint: '0 = 不覆盖。单个模型请在模型表格里单独改。' }, state: { text: '0', changed: false } },
  { field: { section: 'schedule', key: 'checkInEnabled', kind: 'bool', label: '自动签到（基础每日任务）', hint: '与活动任务完全独立的一套开关。' }, state: { checked: true, changed: false } },
  { field: { section: 'schedule', key: 'quotaEnabled', kind: 'bool', label: '定时拉取额度', hint: '定期查询每个账号的剩余额度。' }, state: { checked: true, changed: false } },
  { field: { section: 'schedule', key: 'tasksEnabled', kind: 'bool', label: '自动活动任务', hint: '默认关。上游没有活动任务接口时打开也不会有收获。' }, state: { checked: false, changed: false } },
  { field: { section: 'schedule', key: 'tasksInterval', kind: 'number', label: '任务轮询间隔（分钟）', hint: '太短会触发上游风控，建议不少于 30。' }, state: { text: '60', changed: false } },
  { field: { section: 'schedule', key: 'tasksConcurrency', kind: 'number', label: '任务并发上限', hint: '同时最多几个账号在跑，默认 1。' }, state: { text: '1', changed: false } },
  { field: { section: 'schedule', key: 'tasksMaxFailures', kind: 'number', label: '连续失败暂停阈值', hint: '达到后临时暂停该账号的自动任务。' }, state: { text: '3', changed: false } },
  { field: { section: 'advanced', key: 'chatBaseUrl', kind: 'text', label: '对话 base url', hint: '留空 = 用内置的官方地址。' }, state: { text: '', changed: false } },
  { field: { section: 'advanced', key: 'checkInCron', kind: 'text', label: '签到时间', hint: '`every:86400` 或 `30 8 * * *`。' }, state: { text: '', changed: false } },
]

function stateFor(page, platform) {
  const isOpen = platform === 'opencode'
  const items = isOpen ? freeModels : buddyModels
  return {
    shell: { page, writable: true, dirty: false, dirtyCount: 0, saving: false, saved: false, saveError: null, status: 'ready', advancedOpen: false },
    summary: {
      status: 'ready',
      data: { total: 148, today: 148, ok: 145, failed: 3, inputTokens: 980000, outputTokens: 240000, avgTtftMs: 412, avgTps: 38, last: logEntries[0] },
    },
    log: { status: 'ready', entries: logEntries, total: 148, page: 1, pageSize: 20, error: null },
    update: { status: 'ready', data: { supported: true, current: '0.1.0', latest: '0.2.3', available: true }, error: null, applying: false },
    global: globalFields,
    agentFields,
    selectedAgent: platform,
    snapshot: {
      status: 'ready',
      value: { enabled: true, totals: { accounts: 3, enabledAccounts: 3, degraded: 1 }, agents: agents(platform), jobs: [], taskLog: [] },
    },
    models: { status: 'ready', agentId: platform, items, exposedIds: [], selectedIds: items.filter((m) => (m.free || m.multiplier === 0)).map((m) => m.id), policy: { mode: 'selected', selected: [] }, error: null },
    modelPolicy: {
      mode: 'selected',
      selected: [],
      selectedIds: [],
      exposedIds: [],
      filter: '',
      showPaid: true,
      windowOverrides: {},
    },
    busy: null,
    actionMessage: null,
    draft: {},
    login: { status: 'idle', message: null, loginId: null, userCode: null, verificationUrl: null, authUrl: null, intervalSec: 5, expiresInSec: 600 },
    remoteError: null,
  }
}

const outDir = join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })

const shots = [
  ['01-overview', 'overview', 'opencode', 900],
  ['02-accounts-opencode', 'accounts', 'opencode', 900],
  ['03-accounts-workbuddy', 'accounts', 'workbuddy', 900],
  ['04-accounts-narrow', 'accounts', 'workbuddy', 460],
  ['05-tasks', 'tasks', 'workbuddy', 900],
  ['06-logs', 'logs', 'opencode', 900],
  ['07-settings', 'settings', 'workbuddy', 900],
  ['08-settings-narrow', 'settings', 'workbuddy', 460],
]

/**
 * 两套 token 值（真实主题的 14 个 token，浅色 / 深色各一份）。
 *
 * 深色这套是**近似值**：宿主真实值取不到，但它能暴露「只在浅色下成立」的写法
 * （写死的浅底、深色文字、只有一边能看的 color-mix）。
 */
const PALETTE = {
  light: `--dsw-alias-bg-base:#f5f6f8; --dsw-alias-bg-layer-1:#fff; --dsw-alias-bg-layer-2:#f7f8fa;
    --dsw-alias-bg-overlay:rgba(17,20,26,.46); --dsw-alias-border-l1:#e3e5ea; --dsw-alias-border-l2:#eef0f3;
    --dsw-alias-brand-primary:#1668dc; --dsw-alias-label-primary:#1d2129; --dsw-alias-label-secondary:#86909c;
    --dsw-alias-state-error-primary:#d93026; --dsw-alias-state-idle-primary:#a9aeb8;
    --dsw-alias-state-success-primary:#00a05a; --dsw-alias-state-warn-primary:#d25f00;
    --dsw-alias-specific-sidebar-fill:#eef2f7;`,
  dark: `--dsw-alias-bg-base:#16181d; --dsw-alias-bg-layer-1:#1d2027; --dsw-alias-bg-layer-2:#242830;
    --dsw-alias-bg-overlay:rgba(0,0,0,.62); --dsw-alias-border-l1:#2e333c; --dsw-alias-border-l2:#3a4049;
    --dsw-alias-brand-primary:#4c8dff; --dsw-alias-label-primary:#e8eaee; --dsw-alias-label-secondary:#9aa2ae;
    --dsw-alias-state-error-primary:#ff6b5e; --dsw-alias-state-idle-primary:#6b7280;
    --dsw-alias-state-success-primary:#3ecf8e; --dsw-alias-state-warn-primary:#f0a34a;
    --dsw-alias-specific-sidebar-fill:#1a1d23;`,
}

for (const [name, page, platform, width] of shots) {
  const state = stateFor(page, platform)
  const body = client.DashboardHTML(state)
  for (const [theme, tokens] of Object.entries(PALETTE)) {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${name} (${theme})</title>
<style>
  :root{
    ${tokens}
  }
  html,body{margin:0;background:var(--dsw-alias-bg-base);font:13px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{width:${width}px;padding:14px;margin:0 auto}
</style>
<style>${client.CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`
    fs.writeFileSync(`${outDir}/${name}${theme === 'dark' ? '-dark' : ''}.html`, html)
  }
}

// 登录弹框：单独出一页，用来目视验证遮罩（曾经用 bg-overlay 把整屏盖死）
{
  const state = stateFor('accounts', 'qoder-cn')
  const agent = { agentId: 'qoder-cn', name: 'Qoder CN' }
  const login = {
    status: 'waiting',
    message: null,
    loginId: 'demo',
    userCode: null,
    verificationUrl: null,
    authUrl: 'https://qoder.com.cn/device/selectAccounts?challenge=AeW0QT__FwZK&challenge_method=S256',
    intervalSec: 5,
    expiresInSec: 300,
  }
  const body = client.DashboardHTML(state)
    + '<div class="mag-overlay">' + client.LoginModalHTML({ login }, agent) + '</div>'
  for (const [theme, tokens] of Object.entries(PALETTE)) {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>09-login (${theme})</title>
<style>:root{ ${tokens} }
html,body{margin:0;background:var(--dsw-alias-bg-base);font:13px/1.55 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{width:900px;padding:14px;margin:0 auto}</style>
<style>${client.CSS}</style></head>
<body><div class="wrap">${body}</div></body></html>`
    fs.writeFileSync(`${outDir}/09-login${theme === 'dark' ? '-dark' : ''}.html`, html)
  }
}

console.log('wrote', shots.length * 2, 'files to', outDir)
