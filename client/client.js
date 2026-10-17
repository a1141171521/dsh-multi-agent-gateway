/**
 * dsh-multi-agent-gateway 的 **client half**（浏览器半边）。
 *
 * ## 为什么必须有这个文件
 *
 * 宿主侧的 `Config` schema 只让 DSH 的 **describe 接口**认得这个插件
 * （`Config.listConfigs` → `status: "schema"`），但**设置界面不会自动渲染它**。
 * 「设置 → 内置插件」只是只读清单；真正的配置页在**「插件」页**，靠
 * `plugins.bundle.config` / `plugins.row.config` 这两个 **keyed slot** 渲染 ——
 * 而它们的 occupants 默认是**空的**。没有 client half 的插件，在 UI 上无处可配。
 *
 * ## 这一页做什么
 *
 * 一个页面同时解决两件事：
 *
 *   1. **声明式配置**（走宿主 schema，写回 `scope.mutate`）：
 *      Agent 开关、模型上报、签到/额度/活动任务三套独立开关、上游地址、路由策略。
 *   2. **动态数据**（走本插件自己的 Remote 通道）：账号增删改测、额度、健康、
 *      活动任务状态、模型列表（带倍率）、任务流水与运行日志。
 *
 * ## 两条不能违反的约定
 *
 *   - **远程调用必须用插件自己的 ctx**，不能用 `scope.ctx`（那是提供方
 *     `ui-settings` 的 fiber，inject 里没有 `remote.multiAgentGateway`，
 *     裸访问会被 cordis 拒：`cannot get property ... without inject`）。
 *   - **只有标了 `.volatile()` 的配置路径可写**，而且一次 `mutate` 里有一个
 *     非法 op 就**整批被拒**。所以保存失败时要把「改过哪些路径」显示出来。
 */

window.__ModuleLoader__.load({
  id: 'dsh-multi-agent-gateway',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx, jsxs, Fragment } = require('react/jsx-runtime')
    const React = require('react')
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store')

    /** 必需服务。 */
    const inject = ['slots', 'locale', 'configForms', 'remote']

    /** 字典命名空间（与下面的**配置命名空间**是两回事）。 */
    const DICT = 'settings.multi-agent-gateway'
    /** 宿主侧插件条目 id —— 也就是 `configForms.get()` 要的 namespace。 */
    const CONFIG_NS = 'dsh-multi-agent-gateway'
    /** `<包名>#<row id>`，两个都是同一个名字。 */
    const ROW_KEY = `${CONFIG_NS}#${CONFIG_NS}`
    /** 本插件在 Typert 里的包名 / 命名空间（必须与宿主 `lib/remote.js` 一致）。 */
    const REMOTE_PACKAGE = 'dsh-multi-agent-gateway'
    const REMOTE_NAMESPACE = 'multiAgentGateway'
    const REMOTE_SERVICE = `remote.${REMOTE_NAMESPACE}`

    /** 全部端点的线名（与宿主 `REMOTE_ENDPOINTS` 一一对应，测试会逐项比对）。 */
    const ENDPOINTS = [
      'state',
      'logs',
      'taskLog',
      'models',
      'addAccount',
      'updateAccount',
      'removeAccount',
      'setCredentials',
      'testAccount',
      'checkIn',
      'refreshQuota',
      'runTasks',
      'resumeAccount',
      'resetHealth',
      'tick',
      'clearTaskLog',
      'loginStart',
      'loginPoll',
      'loginCancel',
    ]

    /** 六个 Agent 分组（与服务端的 registry 顺序一致）。 */
    const AGENTS = ['opencode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-intl']

    /**
     * 声明式配置字段表：**path 是相对当前选中 Agent 的**。
     *
     * 为什么客户端要自带一张表：宿主 schema 的 volatile 路径在浏览器侧拿不到
     * 完整元数据（`configForms` 只给值，不给 schema），而"读值 → 写回"的路径
     * 必须精确。这张表与 `src/config.ts` 的 schema **逐条对应**，
     * 由 `test/client.test.mjs` 比对，防止两侧漂移。
     */
    const AGENT_FIELDS = [
      { key: 'enabled', kind: 'bool', path: ['enabled'], label: '启用这个 Agent', hint: '关掉后不再路由请求，也不再往模型选择器上报模型。' },
      { key: 'exposeModels', kind: 'bool', path: ['exposeModels'], label: '上报模型到 DSH 选择器', hint: '关掉后对话框的模型下拉里不会有这个分组。' },
      { key: 'labelWithAgent', kind: 'bool', path: ['labelWithAgent'], label: '模型名带 Agent 前缀', hint: '开启后显示成 `OpenCode · DeepSeek-R1 (×2)`。' },
      { key: 'checkInEnabled', kind: 'bool', path: ['checkIn', 'enabled'], label: '自动签到（基础每日任务）', hint: '与活动任务完全独立的一套开关。' },
      { key: 'checkInCron', kind: 'text', path: ['checkIn', 'cron'], label: '签到时间', hint: '`every:86400` 或 `30 8 * * *`（每天 08:30）。' },
      { key: 'quotaEnabled', kind: 'bool', path: ['quota', 'enabled'], label: '定时拉取额度', hint: '按下面的时间定期查询每个账号的剩余额度。' },
      { key: 'quotaCron', kind: 'text', path: ['quota', 'cron'], label: '额度拉取间隔', hint: '例如 `every:1800` = 每 30 分钟一次。' },
      { key: 'tasksEnabled', kind: 'bool', path: ['tasks', 'enabled'], label: '自动活动任务', hint: '默认关。只有上游确实有活动任务接口时才该打开。' },
      { key: 'tasksInterval', kind: 'number', path: ['tasks', 'intervalMinutes'], label: '任务轮询间隔（分钟）', hint: '太短会触发上游风控，建议不少于 30。' },
      { key: 'tasksConcurrency', kind: 'number', path: ['tasks', 'concurrency'], label: '任务并发上限', hint: '同时最多几个账号在跑，默认 1（串行）。' },
      { key: 'tasksMaxFailures', kind: 'number', path: ['tasks', 'maxFailures'], label: '连续失败暂停阈值', hint: '达到后临时暂停该账号的自动任务并告警。' },
      { key: 'chatBaseUrl', kind: 'text', path: ['upstream', 'chatBaseUrl'], label: '对话 base url', hint: '用反代平台时改这里（OpenAI 兼容）。' },
      { key: 'apiBaseUrl', kind: 'text', path: ['upstream', 'apiBaseUrl'], label: '业务 API base url', hint: '控制台 / 业务接口的地址。' },
      { key: 'checkInPath', kind: 'text', path: ['upstream', 'checkInPath'], label: '签到接口路径', hint: '例如 `/api/user/checkin`。留空 = 自动探测。' },
      { key: 'quotaPath', kind: 'text', path: ['upstream', 'quotaPath'], label: '额度接口路径', hint: '留空 = 用官方额度接口。' },
      { key: 'tasksPath', kind: 'text', path: ['upstream', 'tasksPath'], label: '任务列表路径', hint: '留空 = 自动探测。' },
      { key: 'taskClaimPath', kind: 'text', path: ['upstream', 'taskClaimPath'], label: '领取奖励路径', hint: '用 `{taskId}` 占位，例如 `/api/user/tasks/{taskId}/claim`。' },
      // ── 上下文长度（决定 DSH 什么时候压缩） ──
      //
      // 上游报的窗口偏大 → DSH 一直不压缩 → 最后撞上游硬限制（表现像“压缩坏了”）；
      // 偏小 → 过早压缩。所以给用户一个直接改的口子，默认 0 = 不覆盖。
      {
        key: 'contextWindowDefault',
        kind: 'number',
        path: ['contextWindow', 'default'],
        label: '默认上下文长度（token）',
        hint: '0 = 不覆盖，按上游/价格源报的算。填了就对所有模型生效，影响 DSH 何时压缩。',
      },
      {
        key: 'contextWindowOverrides',
        kind: 'text',
        path: ['contextWindow', 'overrides'],
        label: '按模型覆盖上下文长度',
        hint: '格式 `模型id=长度`，逗号或换行分隔。例：`deepseek-v4.1-flash-free=131072`。优先于默认值。',
      },
    ]

    /** 全局字段（不属于某个 Agent）。 */
    const GLOBAL_FIELDS = [
      { key: 'enabled', kind: 'bool', path: ['enabled'], label: '插件总开关', hint: '关掉后不注册任何 provider，模型选择器里看不到本插件的分组。' },
      {
        key: 'routing',
        kind: 'enum',
        path: ['gateway', 'routing'],
        label: '账号路由策略',
        hint: 'round-robin = 轮流用；quota-first = 优先用剩余额度高的账号。',
        options: [
          { value: 'quota-first', label: 'quota-first（优先额度高）' },
          { value: 'round-robin', label: 'round-robin（轮询）' },
        ],
      },
    ]

    // ───────────────────────────── 样式（只用 DSH 的 design token） ─────────────────────────────
    const CSS = [
      '.mag-root{display:flex;flex-direction:column;gap:12px;max-width:900px;color:var(--dsw-alias-label-primary)}',
      '.mag-title{margin:0;font-size:18px;font-weight:600}',
      '.mag-sub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}',
      '.mag-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.mag-tabs{display:flex;flex-wrap:wrap;gap:6px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding-bottom:8px}',
      '.mag-tab{border:.5px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;line-height:20px;padding:4px 10px;border-radius:var(--dsw-radius-sm)}',
      '.mag-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mag-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}',
      '.mag-tab[data-impl=false]{opacity:.75}',
      '.mag-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-lg);padding:12px;display:flex;flex-direction:column;gap:10px}',
      '.mag-field{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.mag-field:last-child{border-bottom:none}',
      '.mag-label{font-size:13px;line-height:20px;display:flex;align-items:center;gap:6px;cursor:pointer}',
      '.mag-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}',
      '.mag-input{box-sizing:border-box;width:100%;max-width:460px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);height:30px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);padding:0 8px}',
      '.mag-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.mag-input:disabled{opacity:.5}',
      '.mag-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
      '.mag-btn{border:.5px solid var(--dsw-alias-border-l3);background:0 0;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);font:inherit;font-size:13px;line-height:20px;padding:3px 10px;cursor:pointer}',
      '.mag-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mag-btn:disabled{opacity:.45;cursor:default}',
      '.mag-btn[data-primary=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.mag-btn[data-danger=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.mag-table{width:100%;border-collapse:collapse;font-size:13px}',
      '.mag-table th,.mag-table td{text-align:left;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top}',
      '.mag-table th{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:12px}',
      '.mag-tag{display:inline-block;border-radius:var(--dsw-radius-sm);padding:1px 6px;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}',
      '.mag-tag[data-tone=ok]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.mag-tag[data-tone=warn]{color:var(--dsw-alias-state-warning-primary);border-color:var(--dsw-alias-state-warning-primary)}',
      '.mag-tag[data-tone=bad]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.mag-log{max-height:240px;overflow:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;margin:0}',
      '.mag-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}',
      '.mag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
    ].join('')
    const CSS_ID = 'dsh-multi-agent-gateway/client.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = CONFIG_NS
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ───────────────────────────── 字典 ─────────────────────────────
    // ⚠️ 模板**必须是字符串**（官方 locale 用 `template.replace`，写成函数会在渲染期抛 TypeError）。
    const zh = {
      nav: '多 Agent 网关',
      title: '多 Agent 通用 API 反代网关',
      intro: '统一管理各 Agent 的账号、自动签到、额度拉取、活动任务与多账号路由；模型按 Agent 分组上报到对话框的模型选择器。',
      refresh: '刷新',
      tick: '立即执行一轮定时任务',
      saving: '保存中…',
      save: '保存配置',
      discard: '放弃改动',
      saved: '已保存 ✓',
      saveFailed: '保存失败（宿主只接受声明了 volatile 的字段）：{paths}',
      notWritable: '当前部署不允许写配置（只读）。',
      unavailable: '配置表单还没就绪（等宿主把 schema 交过来）。',
      remoteFailed: '界面数据通道出错：{message}',
      totals: '共 {accounts} 个账号 · {enabled} 个启用 · {degraded} 个异常',
      accounts: '账号',
      accountLabel: '标签',
      accountCred: '凭证',
      accountHealth: '健康',
      accountQuota: '额度',
      accountFlags: '开关（对话/签到/任务）',
      accountActions: '操作',
      addAccount: '新增账号',
      label: '标签',
      tokenPlaceholder: 'token / API key（可留空 = 免费层，不需要任何凭证）',
      cookiePlaceholder: 'cookie（部分 Agent / 反代需要，可留空）',
      headersPlaceholder: '额外请求头 JSON（可留空）',
      add: '添加',
      remove: '删除',
      test: '测活',
      setToken: '换凭证',
      resume: '恢复',
      resetHealth: '重置健康',
      noAccounts: '还没有账号。填标签与 token 后点「添加」。',
      models: '模型与倍率',
      loadModels: '列出模型',
      noModels: '还没拉到模型列表。',
      // ── 模型勾选 ──
      modeFree: '只报免费模型',
      modeSelected: '只报我勾选的',
      modeAll: '全部上报',
      modeFreeHint: '默认。只把这几个免费模型放进对话框的模型下拉里 —— 免费层就是这么用的。',
      modeSelectedHint: '只暴露下面打了勾的模型。勾选会自动切到这个模式。',
      modeAllHint: '上游所有模型都进下拉（实测 OpenCode 有 80+ 个，找起来很费劲）。',
      modelSearch: '搜索模型…',
      selectedCount: '已勾选 {selected} / 共 {total}',
      modelPick: '选',
      exposed: '进下拉',
      exposedYes: '已进',
      selectorLabel: '选择器里显示成',
      modelFailed: '拉模型失败：{message}',
      jobs: '定时任务',
      taskLog: '任务执行流水',
      logs: '运行日志',
      clear: '清空',
      checkInNow: '立即签到',
      quotaNow: '刷新额度',
      tasksNow: '跑一轮任务',
      capabilities: '能力',
      upstream: '上游地址',
      schedule: '定时',
      tasksConfig: '活动任务',
      fieldsHint: '下面的开关会写回 DSH 的插件配置（持久化）。',
      pending: '待实现',
      implemented: '已实现',
      docs: '文档',
      credentialHint: '凭证说明',
      paths: '存储位置',
      noJobs: '还没有定时任务（先加账号 / 打开开关）。',
      // ── 设备码登录 ──
      login: '登录 OpenCode 账号（设备码）',
      loginIntro:
        '程序化登录（不需要 API key）：点下面的按钮 → 在浏览器里授权一次 → 账号自动加进来。' +
        '只想用免费模型的话，其实连这步都不用做 —— 直接留空凭证加一个账号就是免费层。',
      loginStarting: '正在向 OpenCode 申请设备码…',
      loginWaiting: '请在浏览器打开下面这个链接，并输入设备码（{minutes} 分钟内有效）：',
      loginOpen: '打开授权页',
      loginCopy: '复制设备码',
      loginCopied: '已复制',
      loginPolling: '正在等待授权…（每 {seconds} 秒查一次）',
      loginCancel: '取消登录',
      loginSuccess: '登录成功：{message}',
      loginFailed: '登录失败：{message}',
      loginExpired: '设备码已过期，请重新发起。',
      loginHint: '授权页会显示「opencode-cli」申请访问你的 OpenCode 账号 —— 那是官方 CLI 用的同一个客户端。',
    }
    const en = {
      nav: 'Multi-Agent Gateway',
      title: 'Multi-Agent API Gateway',
      intro:
        'One place for every Agent account, daily check-in, quota polling, activity tasks and multi-account routing. Models are reported to the composer picker grouped per Agent.',
      refresh: 'Refresh',
      tick: 'Run one scheduler pass now',
      saving: 'Saving…',
      save: 'Save configuration',
      discard: 'Discard changes',
      saved: 'Saved ✓',
      saveFailed: 'Save failed (the host only accepts volatile fields): {paths}',
      notWritable: 'This deployment does not allow configuration writes (read-only).',
      unavailable: 'The form is not ready yet (waiting for the host schema).',
      remoteFailed: 'UI data channel failed: {message}',
      totals: '{accounts} accounts · {enabled} enabled · {degraded} degraded',
      accounts: 'Accounts',
      accountLabel: 'Label',
      accountCred: 'Credential',
      accountHealth: 'Health',
      accountQuota: 'Quota',
      accountFlags: 'Flags (chat / check-in / tasks)',
      accountActions: 'Actions',
      addAccount: 'Add account',
      label: 'Label',
      tokenPlaceholder: 'token / API key (may be empty — a proxy upstream may not need one)',
      cookiePlaceholder: 'cookie (some Agents or proxies need it; may be empty)',
      headersPlaceholder: 'extra headers as JSON (optional)',
      add: 'Add',
      remove: 'Remove',
      test: 'Test',
      setToken: 'Replace credential',
      resume: 'Resume',
      resetHealth: 'Reset health',
      noAccounts: 'No account yet. Fill a label and a token, then press Add.',
      models: 'Models and multipliers',
      loadModels: 'List models',
      noModels: 'No model list fetched yet.',
      modeFree: 'Free models only',
      modeSelected: 'Only the ones I check',
      modeAll: 'Expose everything',
      modeFreeHint: 'Default. Only the free models appear in the model dropdown — which is how the free tier is meant to be used.',
      modeSelectedHint: 'Expose only the checked models. Checking one switches to this mode.',
      modeAllHint: 'Every upstream model lands in the dropdown (OpenCode ships 80+, which is painful to scan).',
      modelSearch: 'Search models…',
      selectedCount: '{selected} of {total} checked',
      modelPick: 'Pick',
      exposed: 'In dropdown',
      exposedYes: 'yes',
      selectorLabel: 'Shown in selector as',
      modelFailed: 'Model fetch failed: {message}',
      jobs: 'Scheduled jobs',
      taskLog: 'Task execution log',
      logs: 'Runtime log',
      clear: 'Clear',
      checkInNow: 'Check in now',
      quotaNow: 'Refresh quota',
      tasksNow: 'Run tasks now',
      capabilities: 'Capabilities',
      upstream: 'Upstream',
      schedule: 'Schedule',
      tasksConfig: 'Activity tasks',
      fieldsHint: 'These toggles write back to the DSH plugin configuration (persisted).',
      pending: 'Not implemented',
      implemented: 'Implemented',
      docs: 'Docs',
      credentialHint: 'Credential hint',
      paths: 'Storage',
      noJobs: 'No scheduled job yet (add an account or enable a toggle).',
      login: 'Sign in with an OpenCode account (device code)',
      loginIntro:
        'No API key needed: press the button, authorize once in your browser, and the account is added automatically. This is how the free models are meant to be used.',
      loginStarting: 'Requesting a device code from OpenCode…',
      loginWaiting: 'Open this link in your browser and enter the device code (valid for {minutes} minutes):',
      loginOpen: 'Open authorization page',
      loginCopy: 'Copy code',
      loginCopied: 'Copied',
      loginPolling: 'Waiting for authorization… (polling every {seconds}s)',
      loginCancel: 'Cancel sign-in',
      loginSuccess: 'Signed in: {message}',
      loginFailed: 'Sign-in failed: {message}',
      loginExpired: 'The device code expired; start over.',
      loginHint: 'The page will show "opencode-cli" asking for access to your OpenCode account — that is the same client the official CLI uses.',
    }

    // ───────────────────────────── 小工具 ─────────────────────────────

    /** 按路径取值。 */
    function at(root, path) {
      let node = root
      for (const piece of path) {
        if (node === null || node === undefined || typeof node !== 'object') return undefined
        node = node[piece]
      }
      return node
    }

    /**
     * 这个端点要不要带参数。
     *
     * ⚠️ **唯一判据，两处共用**（`call()` 发请求、`remoteDescriptors()` 声明描述符）。
     * 早先两处各写各的：描述符声明 `state` 无参，`call()` 却因为 `input ?? {}`
     * 硬塞一个 `{}` —— 网关直接拒：
     * `multiAgentGateway/state expected 0 argument(s), got 1`，整个面板打不开。
     */
    function takesInput(method) {
      return method !== 'state'
    }

    /**
     * 路径 → 稳定 key。
     *
     * ⚠️ 这里**必须**容忍非数组：一个字段表的笔误（比如把绝对路径数组当成
     * 字段对象传进来）曾经让整个客户端条目 `failed`，而 DSH 的 boot 报告
     * 只说「<pkg>: failed」不带原因 —— 排查代价极高。让坏字段退化成空 key，
     * 总好过整页挂掉。
     */
    function keyOf(path) {
      return Array.isArray(path) ? path.join('.') : ''
    }

    /** 值 → 文本（volatile 引用对象也认）。 */
    function textOf(value) {
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (typeof value.get === 'function') return textOf(value.get())
      if (typeof value.value !== 'undefined') return textOf(value.value)
      return ''
    }

    /** 毫秒 → 本地时间。 */
    function timeOf(ms) {
      if (typeof ms !== 'number' || ms <= 0) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    /** 倍率标记（与服务端 `formatMultiplier` 同口径）。 */
    function multiplierTag(multiplier, free) {
      if (free === true || multiplier === 0) return '免费'
      if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) return '未知倍率'
      const rounded = Math.round(multiplier * 100) / 100
      return `×${rounded}`
    }

    /** 把 `<Agent> · <模型> (<标记>)` 渲染成选择器里那行字 —— 页面上给用户预览。 */
    function modelLabel(agentName, modelName, multiplier, free) {
      return `${agentName} · ${modelName} (${multiplierTag(multiplier, free)})`
    }

    /** 字典模板插值（只做 `{key}` 替换，模板本身必须是字符串）。 */
    function fill(template, values) {
      if (typeof template !== 'string') return String(template)
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
      )
    }

    /** 健康状态的显示标签与色调。 */
    function healthView(health) {
      if (health === undefined || health === null) return { text: '—', tone: undefined }
      if (health.state === 'invalid') return { text: '已失效', tone: 'bad' }
      if (health.state === 'degraded') return { text: `降权中（${health.failures ?? 0} 次失败）`, tone: 'warn' }
      if ((health.failures ?? 0) > 0) return { text: `正常（近期失败 ${health.failures}）`, tone: 'warn' }
      return { text: '正常', tone: 'ok' }
    }

    /** 额度显示。 */
    function quotaView(quota, unit) {
      if (quota === undefined || quota === null) return { text: '未拉取', tone: undefined, hint: '' }
      if (quota.unlimited === true) return { text: '不限', tone: 'ok', hint: quota.error ?? '' }
      if (typeof quota.remaining === 'number') {
        const suffix = unit === 'usd' ? ' 美元' : unit === 'credits' ? ' 积分' : ''
        return {
          text: `${quota.remaining}${suffix}`,
          tone: 'ok',
          hint: quota.total === undefined ? '' : `总额度 ${quota.total}，已用 ${quota.used ?? 0}`,
        }
      }
      return { text: '未知', tone: 'warn', hint: quota.error ?? '' }
    }

    /** Remote 返回值归一化：`{ok:true,value}` / `{ok:false,error}` / 裸值都能吃。 */
    function unwrap(response) {
      if (response === undefined || response === null) return { ok: true, value: null }
      if (typeof response === 'object' && 'ok' in response) {
        if (response.ok === false) {
          const raw = response.error
          return { ok: false, error: typeof raw === 'string' ? raw : (raw && raw.message) || '未知错误' }
        }
        return { ok: true, value: 'value' in response ? response.value : response }
      }
      return { ok: true, value: response }
    }

    // ───────────────────────────── 控制器 ─────────────────────────────

    /**
     * 页面的全部状态。
     *
     * 两类来源：
     *   - `scope`（宿主配置表单）：声明式配置的读/写；
     *   - `ctx.remote.multiAgentGateway.*`（本插件 Remote）：动态数据与动作。
     */
    class GatewayPanel {
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        this.listeners = new Set()
        this.drafts = new Map()
        this.saving = false
        this.saved = false
        this.saveError = null
        this.remoteError = null
        this.selectedAgent = 'opencode'
        this.snapshot = { status: 'loading', value: null, error: null }
        this.models = { status: 'idle', agentId: null, items: [], error: null }
        this.busy = null
        this.actionMessage = null
        this.draft = { label: '', token: '', cookie: '', headersJson: '' }
        /** 模型勾选列表的搜索框内容（纯界面状态，不写进配置）。 */
        this.modelFilter = ''
        /**
         * 设备码登录状态机。
         *
         * ⚠️ 轮询计时器**必须**在 dispose 里清掉：DSH 的插件页会被反复挂载/卸载，
         * 留着计时器就是一次登录成功后还在后台一直打宿主接口。
         */
        this.login = { status: 'idle', message: null, loginId: null, userCode: null, verificationUrl: null, intervalSec: 5, expiresInSec: 600 }
        this.loginTimer = null
        this.unsubscribe = scope.subscribe(() => this.publish())
        this.store = this.bind(() => this.projection())
      }

      dispose() {
        this.stopLoginTimer()
        this.unsubscribe()
        this.listeners.clear()
      }

      /** 清掉轮询计时器。 */
      stopLoginTimer() {
        if (this.loginTimer !== null) {
          clearTimeout(this.loginTimer)
          this.loginTimer = null
        }
      }

      publish() {
        for (const listener of this.listeners) listener()
      }

      bind(project) {
        const store = createSnapshotStore(project())
        this.listeners.add(() => store.set(project()))
        return store
      }

      formSnapshot() {
        try {
          return this.scope.getSnapshot()
        } catch (error) {
          return { status: 'error', available: false, writable: false, value: null, user: null, revision: 0, error: String(error && error.message ? error.message : error) }
        }
      }

      /** 配置里的值。 */
      valueAt(path) {
        const form = this.formSnapshot()
        return at(form.value, path)
      }

      /** 用户层是否显式写过这个路径。 */
      overriddenAt(path) {
        const form = this.formSnapshot()
        const user = form.user
        if (user === null || typeof user !== 'object') return false
        const parent = at(user, path.slice(0, -1))
        return parent !== null && typeof parent === 'object' ? Object.hasOwn(parent, path[path.length - 1]) : false
      }

      /**
       * 字段显示态。
       *
       * @param field 字段描述（`{kind, path, …}`）。
       * @param absolutePath 覆盖用的**绝对路径**（Agent 字段是相对路径，
       *   要拼上 `agents.<id>` 才能读写）。**不是** `field.path` 的替代品 ——
       *   早先这里把绝对路径数组当成 field 传进来，`field.path` 变成 `undefined`，
       *   于是 `new GatewayPanel()` 直接抛异常。
       */
      fieldState(field, absolutePath) {
        const path = Array.isArray(absolutePath) ? absolutePath : field.path
        const draft = this.drafts.get(keyOf(path))
        const current = field.kind === 'bool' ? this.valueAt(path) === true : textOf(this.valueAt(path))
        if (field.kind === 'bool') {
          return { checked: draft === undefined ? current : draft.value === true, changed: draft !== undefined }
        }
        const text = draft === undefined ? current : draft.text
        return { text, changed: draft !== undefined && text !== current }
      }

      /** 草稿 → 宿主的 ops（**草稿里存的都是绝对路径**）。 */
      ops() {
        const ops = []
        for (const [key, draft] of this.drafts) {
          const path = key.split('.')
          const current = this.valueAt(path)
          if (Object.hasOwn(draft, 'value')) {
            if (draft.value === current) continue
            ops.push({ op: 'set', path, value: draft.value })
            continue
          }
          const text = String(draft.text ?? '').trim()
          if (text === textOf(current)) continue
          if (text === '') {
            if (this.overriddenAt(path)) ops.push({ op: 'unset', path })
            continue
          }
          // 原来是数字的字段要给数字，否则 schema 会拒（一次 mutate 里有一个
          // 非法 op 就整批被拒，所以这里必须自己把类型弄对）。
          const value = typeof current === 'number' && Number.isFinite(Number(text)) ? Number(text) : text
          ops.push({ op: 'set', path, value })
        }
        return ops
      }

      /** 相对当前 Agent 的字段 → 绝对路径。 */
      agentPath(field) {
        return ['agents', this.selectedAgent, ...field.path]
      }

      edit(path, text) {
        this.drafts.set(keyOf(path), { text })
        this.saved = false
        this.publish()
      }

      toggle(path, checked) {
        this.drafts.set(keyOf(path), { value: checked === true })
        this.saved = false
        this.publish()
      }

      discard() {
        if (this.drafts.size === 0 && this.saveError === null) return
        this.drafts.clear()
        this.saveError = null
        this.publish()
      }

      async save() {
        const absoluteOps = this.ops()
        if (absoluteOps.length === 0 || this.saving) return
        const form = this.formSnapshot()
        if (form.writable !== true) {
          this.saveError = '宿主报告配置只读'
          this.publish()
          return
        }
        this.saving = true
        this.saveError = null
        this.publish()
        try {
          const landed = await this.scope.mutate(absoluteOps, form.revision)
          if (landed) {
            this.drafts.clear()
            this.saved = true
          } else {
            // 官方 controller 把宿主原话丢了，只能自己把改过的路径写出来 ——
            // 宿主一次 mutate 里有一个非 volatile 的 op 就**整批拒**。
            this.saveError = absoluteOps.map((op) => op.path.join('.')).join('、')
          }
        } catch (error) {
          this.saveError = String(error && error.message ? error.message : error)
        }
        this.saving = false
        this.publish()
      }

      // ── Remote ──

      /** 调一个宿主端点。**必须用注入了 `remote.<ns>` 的那个子 ctx。** */
      async call(method, input) {
        const host = this.remoteCtx ?? this.ctx
        const target = host?.remote?.[REMOTE_NAMESPACE]
        const fn = target?.[method]
        if (typeof fn !== 'function') {
          throw new Error(`remote.${REMOTE_NAMESPACE}.${method} 不可用（客户端贡献没挂上？）`)
        }
        // 无参端点**一个参数都不能传** —— 传 `undefined` 也算传。
        const response = takesInput(method) ? await fn.call(target, input ?? {}) : await fn.call(target)
        const outcome = unwrap(response)
        if (!outcome.ok) throw new Error(outcome.error)
        return outcome.value
      }

      /** 拉主快照。 */
      async refresh() {
        try {
          const value = await this.call('state')
          this.snapshot = { status: 'ready', value, error: null }
          this.remoteError = null
        } catch (error) {
          this.snapshot = { status: 'error', value: this.snapshot.value, error: String(error && error.message ? error.message : error) }
          this.remoteError = this.snapshot.error
        }
        this.publish()
      }

      /** 拉模型列表（全量 + 当前上报策略 + 实际上报的 id）。 */
      async loadModels(force) {
        this.models = { ...this.models, status: 'loading', agentId: this.selectedAgent }
        this.publish()
        try {
          const payload = await this.call('models', { agentId: this.selectedAgent, force: force === true })
          this.models = {
            status: 'ready',
            agentId: this.selectedAgent,
            items: payload?.models ?? [],
            exposedIds: payload?.exposedIds ?? [],
            policy: payload?.policy ?? { mode: 'free', selected: [] },
            error: null,
          }
        } catch (error) {
          this.models = {
            status: 'error',
            agentId: this.selectedAgent,
            items: [],
            exposedIds: [],
            policy: { mode: 'free', selected: [] },
            error: String(error && error.message ? error.message : error),
          }
        }
        this.publish()
      }

      // ── 模型勾选 ───────────────────────────────────────────────

      /** 路径：当前 Agent 的模型策略字段（绝对路径）。 */
      modelPath(key) {
        return ['agents', this.selectedAgent, 'models', key]
      }

      /** 当前生效的勾选列表（草稿优先，其次配置里的值）。 */
      modelSelection() {
        const draft = this.drafts.get(keyOf(this.modelPath('selected')))
        const text = draft !== undefined ? draft.text : textOf(this.valueAt(this.modelPath('selected')))
        const out = []
        const seen = new Set()
        for (const raw of String(text ?? '').split(/[\s,;]+/)) {
          const id = raw.trim()
          if (id === '' || seen.has(id)) continue
          seen.add(id)
          out.push(id)
        }
        return out
      }

      /** 勾选列表的搜索框内容（纯界面状态，不进配置）。 */
      setModelFilter(text) {
        this.modelFilter = String(text ?? '')
        this.publish()
      }

      /** 写策略字段（都走草稿 → 保存时一次性 mutate）。 */
      setModelMode(mode) {
        this.edit(this.modelPath('mode'), mode)
      }

      /**
       * 勾 / 取消一个模型。
       *
       * **顺手切到 `selected` 模式**：勾选本身就是「我要这几个」的明确意图；
       * 如果停在 `free` / `all` 上，勾了却没反应，用户只会以为坏了。
       */
      toggleModel(id, checked) {
        const list = this.modelSelection()
        const next = checked === true ? [...list.filter((item) => item !== id), id] : list.filter((item) => item !== id)
        this.edit(this.modelPath('selected'), next.join(','))
        this.edit(this.modelPath('mode'), 'selected')
      }

      /** 跑一个动作（统一 busy 状态与结果提示）。 */
      async run(label, method, input) {
        if (this.busy !== null) return
        this.busy = label
        this.actionMessage = null
        this.publish()
        try {
          await this.call(method, input ?? {})
          this.actionMessage = { ok: true, text: `${label} 完成` }
        } catch (error) {
          this.actionMessage = { ok: false, text: `${label} 失败：${error && error.message ? error.message : error}` }
        }
        this.busy = null
        await this.refresh()
      }

      selectAgent(agentId) {
        this.selectedAgent = agentId
        this.drafts.clear()
        this.saveError = null
        this.models = { status: 'idle', agentId: null, items: [], error: null }
        this.publish()
      }

      setDraft(patch) {
        this.draft = { ...this.draft, ...patch }
        this.publish()
      }

      /** 新增账号（凭证只在提交那一刻离开浏览器一次）。 */
      async addAccount() {
        const label = this.draft.label.trim()
        const token = this.draft.token.trim()
        const cookie = this.draft.cookie.trim()
        let headers
        if (this.draft.headersJson.trim() !== '') {
          try {
            headers = JSON.parse(this.draft.headersJson)
          } catch (error) {
            this.actionMessage = { ok: false, text: `额外请求头不是合法 JSON：${error.message}` }
            this.publish()
            return
          }
        }
        if (label === '') {
          this.actionMessage = { ok: false, text: '标签不能为空' }
          this.publish()
          return
        }
        // 刻意**不**要求必须填凭证：中转 / 反代上游可能完全不要求 key，
        // 直连官方则会在「测活」时由上游给出明确结论（FreeTierError / 401）。
        // 见 docs/OPENCODE-API.md 的「鉴权事实」。
        await this.run('新增账号', 'addAccount', {
          agentId: this.selectedAgent,
          label,
          ...(token === '' ? {} : { token }),
          ...(cookie === '' ? {} : { cookie }),
          ...(headers === undefined ? {} : { headersJson: JSON.stringify(headers) }),
        })
        if (this.actionMessage?.ok === true) {
          this.draft = { label: '', token: '', cookie: '', headersJson: '' }
          this.publish()
        }
      }

      // ── 设备码登录（「不需要 API key」的正解） ─────────────────────

      /**
       * 发起登录：向宿主要一个设备码，然后开始轮询。
       *
       * 宿主只把 `userCode` 与授权链接交回来 —— `device_code` 与最终的 token
       * **都留在宿主进程内**，浏览器全程看不到。
       */
      async startLogin() {
        this.stopLoginTimer()
        this.login = { status: 'starting', message: null, loginId: null, userCode: null, verificationUrl: null, intervalSec: 5, expiresInSec: 600 }
        this.publish()
        try {
          const info = await this.call('loginStart', { agentId: this.selectedAgent })
          this.login = {
            status: 'waiting',
            message: null,
            loginId: info.loginId,
            userCode: info.userCode,
            verificationUrl: info.verificationUrl,
            intervalSec: Math.max(2, Number(info.intervalSec) || 5),
            expiresInSec: Math.max(30, Number(info.expiresInSec) || 600),
          }
          this.publish()
          this.scheduleLoginPoll()
        } catch (error) {
          this.login = {
            status: 'failed',
            message: String(error && error.message ? error.message : error),
            loginId: null,
            userCode: null,
            verificationUrl: null,
            intervalSec: 5,
            expiresInSec: 600,
          }
          this.publish()
        }
      }

      /** 排下一次轮询。 */
      scheduleLoginPoll() {
        this.stopLoginTimer()
        const seconds = Math.max(2, Number(this.login.intervalSec) || 5)
        this.loginTimer = setTimeout(() => {
          this.loginTimer = null
          void this.pollLogin()
        }, seconds * 1000)
      }

      /** 轮询一次登录结果。 */
      async pollLogin() {
        if (this.login.status !== 'waiting' || this.login.loginId === null) return
        try {
          const outcome = await this.call('loginPoll', { loginId: this.login.loginId })
          if (outcome.status === 'pending') {
            this.publish()
            this.scheduleLoginPoll()
            return
          }
          if (outcome.status === 'slow_down') {
            this.login.intervalSec = Math.max(2, Number(outcome.intervalSec) || 10)
            this.publish()
            this.scheduleLoginPoll()
            return
          }
          if (outcome.status === 'ready') {
            this.login = { status: 'ready', message: outcome.message ?? '登录成功', loginId: null, userCode: null, verificationUrl: null, intervalSec: 5, expiresInSec: 600 }
            this.draft = { label: '', token: '', cookie: '', headersJson: '' }
            this.publish()
            // 账号是宿主建的 —— 拉一遍最新快照就能看到它。
            await this.refresh()
            await this.loadModels(false)
            return
          }
          this.login = {
            status: outcome.status === 'denied' ? 'failed' : outcome.status,
            message: outcome.message ?? null,
            loginId: null,
            userCode: null,
            verificationUrl: null,
            intervalSec: 5,
            expiresInSec: 600,
          }
          this.publish()
        } catch (error) {
          this.login = {
            status: 'failed',
            message: String(error && error.message ? error.message : error),
            loginId: null,
            userCode: null,
            verificationUrl: null,
            intervalSec: 5,
            expiresInSec: 600,
          }
          this.publish()
        }
      }

      /** 取消登录。 */
      async cancelLogin() {
        this.stopLoginTimer()
        const id = this.login.loginId
        this.login = { status: 'idle', message: null, loginId: null, userCode: null, verificationUrl: null, intervalSec: 5, expiresInSec: 600 }
        this.publish()
        if (id !== null) {
          try {
            await this.call('loginCancel', { loginId: id })
          } catch {
            // 取消失败无所谓：宿主那侧的会话自己会超时。
          }
        }
      }

      /** 页面状态投影。 */
      projection() {
        const form = this.formSnapshot()
        const ops = this.ops()
        return {
          shell: {
            available: form.status === 'ready',
            writable: form.writable === true,
            dirty: ops.length > 0,
            saving: this.saving,
            saved: this.saved,
            saveError: this.saveError,
            status: form.status,
          },
          global: GLOBAL_FIELDS.map((field) => ({ field, state: this.fieldState(field) })),
          agentFields: AGENT_FIELDS.map((field) => ({ field, state: this.fieldState(field, this.agentPath(field)) })),
          selectedAgent: this.selectedAgent,
          snapshot: this.snapshot,
          models: this.models,
          modelPolicy: {
            mode:
              textOf(this.drafts.get(keyOf(this.modelPath('mode')))?.text) ||
              textOf(this.valueAt(this.modelPath('mode'))) ||
              'free',
            selected: this.modelSelection(),
            exposedIds: this.models.exposedIds ?? [],
            filter: this.modelFilter,
          },
          busy: this.busy,
          actionMessage: this.actionMessage,
          draft: this.draft,
          remoteError: this.remoteError,
          login: this.login,
        }
      }

      /** slot entry 的 `inject`。 */
      inject() {
        return {
          hooks: { gatewayPanel: this.store },
          selectAgent: (agentId) => this.selectAgent(agentId),
          refresh: () => this.refresh(),
          save: () => this.save(),
          discard: () => this.discard(),
          loadModels: (force) => this.loadModels(force),
          setModelMode: (mode) => this.setModelMode(mode),
          toggleModel: (id, checked) => this.toggleModel(id, checked),
          setModelFilter: (text) => this.setModelFilter(text),
          run: (label, method, input) => this.run(label, method, input),
          setDraft: (patch) => this.setDraft(patch),
          addAccount: () => this.addAccount(),
          startLogin: () => this.startLogin(),
          cancelLogin: () => this.cancelLogin(),
          editGlobal: (field, text) => this.edit(field.path, text),
          toggleGlobal: (field, checked) => this.toggle(field.path, checked),
          editAgent: (field, text) => this.edit(this.agentPath(field), text),
          toggleAgent: (field, checked) => this.toggle(this.agentPath(field), checked),
          fieldStateAgent: (field) => this.fieldState(field, this.agentPath(field)),
        }
      }
    }

    // ───────────────────────────── 视图 ─────────────────────────────

    function FieldRow({ field, state, t, onEdit, onToggle, disabled }) {
      if (field.kind === 'bool') {
        return jsxs('div', {
          className: 'mag-field',
          children: [
            jsxs('label', {
              className: 'mag-label',
              children: [
                jsx('input', {
                  type: 'checkbox',
                  checked: state.checked === true,
                  disabled,
                  onChange: (event) => onToggle(field, event.target.checked),
                }),
                field.label,
              ],
            }),
            jsx('p', { className: 'mag-hint', children: field.hint }),
          ],
        })
      }
      if (field.kind === 'enum') {
        return jsxs('div', {
          className: 'mag-field',
          children: [
            jsx('span', { className: 'mag-label', children: field.label }),
            jsx('select', {
              className: 'mag-input',
              value: state.text,
              disabled,
              onChange: (event) => onEdit(field, event.target.value),
              children: (field.options ?? []).map((option) =>
                jsx('option', { value: option.value, children: option.label }, option.value),
              ),
            }),
            jsx('p', { className: 'mag-hint', children: field.hint }),
          ],
        })
      }
      return jsxs('div', {
        className: 'mag-field',
        children: [
          jsx('span', { className: 'mag-label', children: field.label }),
          jsx('input', {
            className: 'mag-input',
            type: field.kind === 'number' ? 'number' : 'text',
            value: state.text,
            disabled,
            placeholder: field.hint,
            onChange: (event) => onEdit(field, event.target.value),
          }),
          jsx('p', { className: 'mag-hint', children: field.hint }),
        ],
      })
    }

    function CapabilityTags({ capabilities, t }) {
      if (capabilities === null || capabilities === undefined) return null
      const labels = {
        models: '模型',
        quota: '额度',
        checkIn: '签到',
        tasks: '活动任务',
        chat: '对话',
        reasoning: '思维链',
      }
      return jsx('div', {
        className: 'mag-row',
        children: Object.entries(labels).map(([key, label]) => {
          const ok = capabilities[key] === true
          const note = capabilities.notes?.[key]
          return jsx(
            'span',
            {
              className: 'mag-tag',
              'data-tone': ok ? 'ok' : 'warn',
              title: note ?? '',
              children: `${label} ${ok ? '✓' : '—'}`,
            },
            key,
          )
        }),
      })
    }

    function AccountTable({ agent, t, actions, disabled }) {
      const accounts = agent.accounts ?? []
      if (accounts.length === 0) {
        return jsx('p', { className: 'mag-hint', children: t('noAccounts') })
      }
      const unit = agent.quotaUnit ?? 'credits'
      return jsx('table', {
        className: 'mag-table',
        children: jsxs(Fragment, {
          children: [
            jsx('thead', {
              children: jsxs('tr', {
                children: [
                  jsx('th', { children: t('accountLabel') }),
                  jsx('th', { children: t('accountCred') }),
                  jsx('th', { children: t('accountHealth') }),
                  jsx('th', { children: t('accountQuota') }),
                  jsx('th', { children: t('accountFlags') }),
                  jsx('th', { children: t('accountActions') }),
                ],
              }),
            }),
            jsx('tbody', {
              children: accounts.map((account) => {
                const health = healthView(account.health)
                const quota = quotaView(account.quota, unit)
                return jsxs(
                  'tr',
                  {
                    children: [
                      jsxs('td', {
                        children: [
                          jsx('div', { children: account.label }),
                          jsx('div', { className: 'mag-mono mag-hint', children: account.id }),
                        ],
                      }),
                      jsxs('td', {
                        children: [
                          account.hasToken === true
                            ? jsx('span', {
                                className: 'mag-tag',
                                'data-tone': account.authKind === 'oauth-device' ? 'ok' : undefined,
                                children: account.authKind === 'oauth-device' ? '已登录' : 'token',
                                title:
                                  account.authKind === 'oauth-device'
                                    ? `设备码登录${account.autoRefresh === true ? '（自动续期）' : ''}${
                                        account.expiresAt ? `，有效期至 ${timeOf(account.expiresAt)}` : ''
                                      }`
                                    : '手工填写的 API key',
                              })
                            : null,
                          ' ',
                          account.hasCookie === true ? jsx('span', { className: 'mag-tag', children: 'cookie' }) : null,
                          account.hasToken !== true && account.hasCookie !== true
                            ? jsx('span', {
                                className: 'mag-tag',
                                'data-tone': 'ok',
                                children: '免费层',
                                title:
                                  '匿名免费层：不需要任何凭证，插件自动补客户端指纹（会话头 + read 工具 + 流式）。' +
                                  '只对免费模型有效；付费模型需要上面两种凭证之一。',
                              })
                            : null,
                        ],
                      }),
                      jsxs('td', {
                        children: [
                          jsx('span', { className: 'mag-tag', 'data-tone': health.tone, children: health.text }),
                          account.health?.lastError
                            ? jsx('div', {
                                className: 'mag-hint',
                                children: `${account.health.lastError.kind} · ${account.health.lastError.message}`,
                              })
                            : null,
                        ],
                      }),
                      jsxs('td', {
                        children: [
                          jsx('span', { className: 'mag-tag', 'data-tone': quota.tone, children: quota.text }),
                          quota.hint === '' ? null : jsx('div', { className: 'mag-hint', children: quota.hint }),
                        ],
                      }),
                      jsx('td', {
                        children: jsxs('div', {
                          className: 'mag-row',
                          children: [
                            jsx('label', {
                              className: 'mag-label',
                              children: [
                                jsx('input', {
                                  type: 'checkbox',
                                  disabled,
                                  checked: account.routeChat !== false,
                                  onChange: (event) =>
                                    actions.update(account.id, { routeChat: event.target.checked }),
                                }),
                                '对话',
                              ],
                            }),
                            jsx('label', {
                              className: 'mag-label',
                              children: [
                                jsx('input', {
                                  type: 'checkbox',
                                  disabled,
                                  checked: account.autoCheckIn === true,
                                  onChange: (event) =>
                                    actions.update(account.id, { autoCheckIn: event.target.checked }),
                                }),
                                '签到',
                              ],
                            }),
                            jsx('label', {
                              className: 'mag-label',
                              children: [
                                jsx('input', {
                                  type: 'checkbox',
                                  disabled,
                                  checked: account.autoTasks === true,
                                  onChange: (event) => actions.update(account.id, { autoTasks: event.target.checked }),
                                }),
                                '任务',
                              ],
                            }),
                          ],
                        }),
                      }),
                      jsxs('td', {
                        children: jsxs('div', {
                          className: 'mag-row',
                          children: [
                            jsx('button', {
                              className: 'mag-btn',
                              disabled,
                              onClick: () => actions.test(account.id),
                              children: t('test'),
                            }),
                            jsx('button', {
                              className: 'mag-btn',
                              disabled,
                              onClick: () => actions.resetHealth(account.id),
                              children: t('resetHealth'),
                            }),
                            jsx('button', {
                              className: 'mag-btn',
                              disabled,
                              onClick: () => actions.resume(account.id),
                              children: t('resume'),
                            }),
                            jsx('button', {
                              className: 'mag-btn',
                              'data-danger': true,
                              disabled,
                              onClick: () => actions.remove(account.id),
                              children: t('remove'),
                            }),
                          ],
                        }),
                      }),
                    ],
                  },
                  account.id,
                )
              }),
            }),
          ],
        }),
      })
    }

    /**
     * 模型勾选器。
     *
     * 为什么要有这个：上游 OpenCode 有 80+ 个模型，全塞进 DSH 的模型下拉里
     * 会让免费的那几个彻底淹没（实测用户反馈的第一句话就是「模型太多」）。
     *
     * 三种模式对应三种真实用法：
     *   - `free`  只报免费模型 —— 匿名免费层就是这么用的，**默认**；
     *   - `selected` 只报勾选的 —— 用户自己挑；
     *   - `all`   全部 —— 原来的行为，付费 key 用户的用法。
     */
    function ModelList({ models, modelPolicy, agentName, t, actions, disabled }) {
      if (models.status === 'idle') return jsx('p', { className: 'mag-hint', children: t('noModels') })
      if (models.status === 'loading') {
        return jsx('p', { className: 'mag-hint', children: t('loadingModels') ?? '加载中…' })
      }
      if (models.status === 'error') {
        return jsx('p', { className: 'mag-error', children: fill(t('modelFailed'), { message: models.error ?? '' }) })
      }
      const all = models.items ?? []
      const exposed = new Set(modelPolicy.exposedIds ?? [])
      const chosen = new Set(modelPolicy.selected ?? [])
      const mode = modelPolicy.mode ?? 'free'
      const query = String(modelPolicy.filter ?? '').trim().toLowerCase()
      const shown =
        query === ''
          ? all
          : all.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(query))

      const modeButton = (value, label) =>
        jsx('button', {
          className: 'mag-btn',
          'data-primary': mode === value,
          disabled,
          onClick: () => actions.setModelMode(value),
          children: label,
        })

      return jsxs(Fragment, {
        children: [
          jsxs('div', {
            className: 'mag-row',
            children: [
              modeButton('free', t('modeFree')),
              modeButton('selected', t('modeSelected')),
              modeButton('all', t('modeAll')),
              jsx('span', {
                className: 'mag-hint',
                children: fill(t('selectedCount'), { selected: chosen.size, total: all.length }),
              }),
            ],
          }),
          jsx('p', {
            className: 'mag-hint',
            children:
              mode === 'free'
                ? t('modeFreeHint')
                : mode === 'selected'
                  ? t('modeSelectedHint')
                  : t('modeAllHint'),
          }),
          jsx('input', {
            className: 'mag-input',
            placeholder: t('modelSearch'),
            value: modelPolicy.filter ?? '',
            disabled,
            onChange: (event) => actions.setModelFilter(event.target.value),
          }),
          shown.length === 0
            ? jsx('p', { className: 'mag-hint', children: t('noModels') })
            : jsx('table', {
                className: 'mag-table',
                children: jsxs(Fragment, {
                  children: [
                    jsx('thead', {
                      children: jsxs('tr', {
                        children: [
                          jsx('th', { children: t('modelPick') }),
                          jsx('th', { children: '模型' }),
                          jsx('th', { children: '倍率' }),
                          jsx('th', { children: t('exposed') }),
                          jsx('th', { children: t('selectorLabel') }),
                        ],
                      }),
                    }),
                    jsx('tbody', {
                      children: shown.map((item) =>
                        jsxs(
                          'tr',
                          {
                            children: [
                              jsx('td', {
                                children: jsx('input', {
                                  type: 'checkbox',
                                  checked: chosen.has(item.id),
                                  disabled,
                                  onChange: (event) => actions.toggleModel(item.id, event.target.checked),
                                }),
                              }),
                              jsxs('td', {
                                children: [
                                  jsx('div', { children: item.name }),
                                  jsx('div', { className: 'mag-mono mag-hint', children: item.id }),
                                ],
                              }),
                              jsx('td', {
                                children: jsx('span', {
                                  className: 'mag-tag',
                                  'data-tone': item.free === true ? 'ok' : undefined,
                                  children: multiplierTag(item.multiplier, item.free),
                                }),
                              }),
                              jsx('td', {
                                children: exposed.has(item.id)
                                  ? jsx('span', { className: 'mag-tag', 'data-tone': 'ok', children: t('exposedYes') })
                                  : jsx('span', { className: 'mag-hint', children: '—' }),
                              }),
                              jsx('td', {
                                className: 'mag-mono',
                                children: modelLabel(agentName, item.name, item.multiplier, item.free),
                              }),
                            ],
                          },
                          item.id,
                        ),
                      ),
                    }),
                  ],
                }),
              }),
        ],
      })
    }

    function JobTable({ jobs, agentId, t }) {
      const rows = (jobs ?? []).filter((job) => job.key.includes(`:${agentId}`) || job.key.includes(`:${agentId}:`))
      if (rows.length === 0) return jsx('p', { className: 'mag-hint', children: t('noJobs') })
      return jsx('table', {
        className: 'mag-table',
        children: jsxs(Fragment, {
          children: [
            jsx('thead', {
              children: jsxs('tr', {
                children: [
                  jsx('th', { children: '任务' }),
                  jsx('th', { children: '时间' }),
                  jsx('th', { children: '上次执行' }),
                  jsx('th', { children: '结果' }),
                ],
              }),
            }),
            jsx('tbody', {
              children: rows.map((job) =>
                jsxs(
                  'tr',
                  {
                    children: [
                      jsx('td', { children: job.title }),
                      jsx('td', { className: 'mag-mono', children: job.schedule }),
                      jsx('td', { children: timeOf(job.lastRun) }),
                      jsxs('td', {
                        children: [
                          job.paused === true
                            ? jsx('span', { className: 'mag-tag', 'data-tone': 'bad', children: '已暂停' })
                            : jsx('span', {
                                className: 'mag-tag',
                                'data-tone': job.failures > 0 ? 'warn' : 'ok',
                                children: `失败 ${job.failures ?? 0}`,
                              }),
                          jsx('div', {
                            className: 'mag-hint',
                            children: job.lastError ?? job.lastResult ?? '—',
                          }),
                        ],
                      }),
                    ],
                  },
                  job.key,
                )
              ),
            }),
          ],
        }),
      })
    }

    function GatewayPanelView(props) {
      const { t, view } = props
      const state = props.useGatewayPanel ? props.useGatewayPanel((snapshot) => snapshot) : null
      // `view === 'summary'` 是 keyed 槽的一行说明（包页那一行 / 行详情页），
      // 只有 `view === 'page'` 才渲染完整面板。
      if (view === 'summary') {
        const totals = state?.snapshot?.value?.totals
        if (totals === undefined || totals === null) return jsx('span', { children: t('intro') })
        return jsx('span', {
          children: `${t('title')} —— ${fill(t('totals'), {
            accounts: totals.accounts ?? 0,
            enabled: totals.enabledAccounts ?? 0,
            degraded: totals.degraded ?? 0,
          })}`,
        })
      }
      const shell = state.shell
      const snapshot = state.snapshot
      const payload = snapshot.value ?? {}
      const agents = payload.agents ?? []
      const agent = agents.find((item) => item.agentId === state.selectedAgent) ?? agents[0] ?? null
      const disabled = shell.writable !== true

      if (snapshot.status === 'error' && snapshot.value === null) {
        return jsxs('div', {
          className: 'mag-root',
          children: [
            jsx('h2', { className: 'mag-title', children: t('title') }),
            jsx('p', { className: 'mag-error', children: fill(t('remoteFailed'), { message: snapshot.error ?? '' }) }),
            jsx('div', {
              className: 'mag-bar',
              children: jsx('button', { className: 'mag-btn', onClick: () => props.refresh(), children: t('refresh') }),
            }),
          ],
        })
      }

      const actions = {
        update: (id, patch) => props.run(t('save'), 'updateAccount', { id, ...patch }),
        test: (id) => props.run(t('test'), 'testAccount', { id }),
        remove: (id) => props.run(t('remove'), 'removeAccount', { id }),
        resetHealth: (id) => props.run(t('resetHealth'), 'resetHealth', { accountId: id }),
        resume: (id) => props.run(t('resume'), 'resumeAccount', { accountId: id }),
      }

      return jsxs('div', {
        className: 'mag-root',
        children: [
          jsx('h2', { className: 'mag-title', children: t('title') }),
          jsx('p', { className: 'mag-sub', children: t('intro') }),

          // ── 顶部状态条 ──
          jsxs('div', {
            className: 'mag-bar',
            children: [
              jsx('span', {
                className: 'mag-tag',
                children: fill(t('totals'), {
                  accounts: payload.totals?.accounts ?? 0,
                  enabled: payload.totals?.enabledAccounts ?? 0,
                  degraded: payload.totals?.degraded ?? 0,
                }),
              }),
              jsx('button', { className: 'mag-btn', onClick: () => props.refresh(), children: t('refresh') }),
              jsx('button', {
                className: 'mag-btn',
                disabled: state.busy !== null,
                onClick: () => props.run(t('tick'), 'tick', {}),
                children: t('tick'),
              }),
              state.busy === null ? null : jsx('span', { className: 'mag-hint', children: `${state.busy}…` }),
            ],
          }),
          state.actionMessage === null
            ? null
            : jsx('p', {
                className: state.actionMessage.ok ? 'mag-hint' : 'mag-error',
                children: state.actionMessage.text,
              }),

          // ── 全局配置 ──
          jsxs('div', {
            className: 'mag-card',
            children: [
              jsx('p', { className: 'mag-hint', children: t('fieldsHint') }),
              ...state.global.map((item) =>
                jsx(
                  FieldRow,
                  {
                    field: item.field,
                    state: item.state,
                    t,
                    disabled,
                    onEdit: (field, text) => props.editGlobal(field, text),
                    onToggle: (field, checked) => props.toggleGlobal(field, checked),
                  },
                  item.field.key,
                )
              ),
            ],
          }),

          // ── Agent 标签页 ──
          jsx('div', {
            className: 'mag-tabs',
            children: agents.map((item) =>
              jsx(
                'button',
                {
                  className: 'mag-tab',
                  'data-active': item.agentId === state.selectedAgent,
                  'data-impl': item.implemented === true,
                  onClick: () => props.selectAgent(item.agentId),
                  children: `${item.name}${item.implemented === true ? '' : `（${t('pending')}）`}`,
                },
                item.agentId,
              )
            ),
          }),

          agent === null
            ? jsx('p', { className: 'mag-hint', children: '没有可显示的分组。' })
            : jsxs(Fragment, {
                children: [
                  jsxs('div', {
                    className: 'mag-card',
                    children: [
                      jsxs('div', {
                        className: 'mag-row',
                        children: [
                          jsx('strong', { children: agent.name }),
                          jsx('span', {
                            className: 'mag-tag',
                            'data-tone': agent.implemented === true ? 'ok' : 'warn',
                            children: agent.implemented === true ? t('implemented') : t('pending'),
                          }),
                          jsx('span', { className: 'mag-tag', children: `${t('accounts')} ${(agent.accounts ?? []).length}` }),
                          agent.docs === null || agent.docs === undefined
                            ? null
                            : jsx('a', {
                                className: 'mag-hint',
                                href: agent.docs,
                                target: '_blank',
                                rel: 'noreferrer',
                                children: `${t('docs')}: ${agent.docs}`,
                              }),
                        ],
                      }),
                      agent.credentialHint === null || agent.credentialHint === undefined
                        ? null
                        : jsx('p', { className: 'mag-hint', children: `${t('credentialHint')}：${agent.credentialHint}` }),
                      jsxs('div', {
                        className: 'mag-row',
                        children: [
                          jsx('span', { className: 'mag-hint', children: `${t('capabilities')}：` }),
                          jsx(CapabilityTags, { capabilities: agent.capabilities, t }),
                        ],
                      }),
                      ...state.agentFields.map((item) =>
                        jsx(
                          FieldRow,
                          {
                            field: item.field,
                            state: props.fieldStateAgent(item.field),
                            t,
                            disabled,
                            onEdit: (field, text) => props.editAgent(field, text),
                            onToggle: (field, checked) => props.toggleAgent(field, checked),
                          },
                          item.field.key,
                        )
                      ),
                      jsxs('div', {
                        className: 'mag-row',
                        children: [
                          jsx('button', {
                            className: 'mag-btn',
                            disabled: state.busy !== null,
                            onClick: () =>
                              props.run(t('checkInNow'), 'checkIn', { agentId: state.selectedAgent, force: true }),
                            children: t('checkInNow'),
                          }),
                          jsx('button', {
                            className: 'mag-btn',
                            disabled: state.busy !== null,
                            onClick: () =>
                              props.run(t('quotaNow'), 'refreshQuota', { agentId: state.selectedAgent }),
                            children: t('quotaNow'),
                          }),
                          jsx('button', {
                            className: 'mag-btn',
                            disabled: state.busy !== null,
                            onClick: () => props.run(t('tasksNow'), 'runTasks', { agentId: state.selectedAgent }),
                            children: t('tasksNow'),
                          }),
                          jsx('button', {
                            className: 'mag-btn',
                            disabled: state.busy !== null,
                            onClick: () => props.loadModels(true),
                            children: t('loadModels'),
                          }),
                        ],
                      }),
                    ],
                  }),

                  // ── 账号 ──
                  jsxs('div', {
                    className: 'mag-card',
                    children: [
                      jsx('strong', { children: t('accounts') }),
                      jsx(AccountTable, { agent, t, actions, disabled }),

                      // ── 设备码登录：真正「不需要 API key」的那条路 ──
                      jsxs('div', {
                        className: 'mag-field',
                        children: [
                          jsx('strong', { children: t('login') }),
                          jsx('p', { className: 'mag-hint', children: t('loginIntro') }),
                          state.login.status === 'idle'
                            ? jsx('div', {
                                className: 'mag-row',
                                children: jsx('button', {
                                  className: 'mag-btn',
                                  'data-primary': true,
                                  disabled: disabled || state.busy !== null,
                                  onClick: () => props.startLogin(),
                                  children: t('login'),
                                }),
                              })
                            : null,
                          state.login.status === 'starting'
                            ? jsx('p', { className: 'mag-hint', children: t('loginStarting') })
                            : null,
                          state.login.status === 'waiting'
                            ? jsxs(Fragment, {
                                children: [
                                  jsx('p', {
                                    className: 'mag-hint',
                                    children: fill(t('loginWaiting'), {
                                      minutes: Math.round(state.login.expiresInSec / 60),
                                    }),
                                  }),
                                  jsxs('div', {
                                    className: 'mag-row',
                                    children: [
                                      jsx('span', {
                                        className: 'mag-mono',
                                        style: { fontSize: '18px', letterSpacing: '2px' },
                                        children: state.login.userCode,
                                      }),
                                      jsx('button', {
                                        className: 'mag-btn',
                                        'data-primary': true,
                                        onClick: () =>
                                          window.open(state.login.verificationUrl, '_blank', 'noopener,noreferrer'),
                                        children: t('loginOpen'),
                                      }),
                                      jsx('a', {
                                        className: 'mag-hint',
                                        href: state.login.verificationUrl,
                                        target: '_blank',
                                        rel: 'noreferrer',
                                        children: state.login.verificationUrl,
                                      }),
                                    ],
                                  }),
                                  jsx('p', {
                                    className: 'mag-hint',
                                    children: fill(t('loginPolling'), { seconds: state.login.intervalSec }),
                                  }),
                                  jsx('p', { className: 'mag-hint', children: t('loginHint') }),
                                  jsx('div', {
                                    className: 'mag-row',
                                    children: jsx('button', {
                                      className: 'mag-btn',
                                      onClick: () => props.cancelLogin(),
                                      children: t('loginCancel'),
                                    }),
                                  }),
                                ],
                              })
                            : null,
                          state.login.status === 'ready'
                            ? jsxs('div', {
                                children: [
                                  jsx('p', {
                                    className: 'mag-hint',
                                    children: fill(t('loginSuccess'), { message: state.login.message ?? '' }),
                                  }),
                                  jsx('button', {
                                    className: 'mag-btn',
                                    onClick: () => props.startLogin(),
                                    children: t('login'),
                                  }),
                                ],
                              })
                            : null,
                          state.login.status === 'failed' || state.login.status === 'expired'
                            ? jsxs('div', {
                                children: [
                                  jsx('p', {
                                    className: 'mag-error',
                                    children: fill(t('loginFailed'), { message: state.login.message ?? '' }),
                                  }),
                                  jsx('button', {
                                    className: 'mag-btn',
                                    onClick: () => props.startLogin(),
                                    children: t('login'),
                                  }),
                                ],
                              })
                            : null,
                        ],
                      }),

                      jsxs('div', {
                        className: 'mag-field',
                        children: [
                          jsx('strong', { children: t('addAccount') }),
                          jsxs('div', {
                            className: 'mag-row',
                            children: [
                              jsx('input', {
                                className: 'mag-input',
                                value: state.draft.label,
                                placeholder: t('label'),
                                disabled,
                                onChange: (event) => props.setDraft({ label: event.target.value }),
                              }),
                              jsx('input', {
                                className: 'mag-input',
                                type: 'password',
                                value: state.draft.token,
                                placeholder: t('tokenPlaceholder'),
                                disabled,
                                onChange: (event) => props.setDraft({ token: event.target.value }),
                              }),
                            ],
                          }),
                          jsxs('div', {
                            className: 'mag-row',
                            children: [
                              jsx('input', {
                                className: 'mag-input',
                                value: state.draft.cookie,
                                placeholder: t('cookiePlaceholder'),
                                disabled,
                                onChange: (event) => props.setDraft({ cookie: event.target.value }),
                              }),
                              jsx('input', {
                                className: 'mag-input',
                                value: state.draft.headersJson,
                                placeholder: t('headersPlaceholder'),
                                disabled,
                                onChange: (event) => props.setDraft({ headersJson: event.target.value }),
                              }),
                            ],
                          }),
                          jsx('div', {
                            className: 'mag-row',
                            children: jsx('button', {
                              className: 'mag-btn',
                              'data-primary': true,
                              disabled,
                              onClick: () => props.addAccount(),
                              children: t('add'),
                            }),
                          }),
                        ],
                      }),
                    ],
                  }),

                  // ── 模型 + 定时任务 ──
                  jsxs('div', {
                    className: 'mag-card',
                    children: [
                      jsx('strong', { children: t('models') }),
                      jsx('p', {
                        className: 'mag-hint',
                        children: payload.multiplierLegend ?? '',
                      }),
                      jsx(ModelList, {
                        models: state.models,
                        modelPolicy: state.modelPolicy,
                        agentName: agent.name,
                        t,
                        actions: props,
                        disabled,
                      }),
                    ],
                  }),
                  jsxs('div', {
                    className: 'mag-card',
                    children: [
                      jsx('strong', { children: t('jobs') }),
                      jsx(JobTable, { jobs: payload.jobs ?? [], agentId: state.selectedAgent, t }),
                    ],
                  }),
                ],
              }),

          // ── 流水 / 日志 ──
          jsxs('div', {
            className: 'mag-card',
            children: [
              jsxs('div', {
                className: 'mag-row',
                children: [
                  jsx('strong', { children: t('taskLog') }),
                  jsx('button', {
                    className: 'mag-btn',
                    disabled: state.busy !== null,
                    onClick: () => props.run(t('clear'), 'clearTaskLog', {}),
                    children: t('clear'),
                  }),
                ],
              }),
              jsx('pre', {
                className: 'mag-log',
                children: (payload.taskLog ?? [])
                  .slice()
                  .reverse()
                  .map(
                    (item) =>
                      `${timeOf(item.at)} [${item.agentId}/${item.accountLabel}] ${item.taskTitle} → ${
                        item.ok === true ? '成功' : '失败'
                      }${item.credits ? ` (+${item.credits})` : ''} ${item.message ?? ''}`
                  )
                  .join('\n') || '—',
              }),
            ],
          }),
          jsxs('div', {
            className: 'mag-card',
            children: [
              jsx('strong', { children: t('logs') }),
              jsx('pre', {
                className: 'mag-log',
                children: (payload.logs ?? [])
                  .map((item) => `${timeOf(item.at)} ${item.level.toUpperCase()} [${item.scope}] ${item.message} ${item.detail ?? ''}`)
                  .join('\n') || '—',
              }),
            ],
          }),
          jsxs('div', {
            className: 'mag-card',
            children: [
              jsx('strong', { children: t('paths') }),
              jsx('pre', {
                className: 'mag-log',
                children: Object.entries(payload.paths ?? {})
                  .map(([key, value]) => `${key}: ${value}`)
                  .join('\n') || '—',
              }),
            ],
          }),

          // ── 保存栏 ──
          jsxs('div', {
            className: 'mag-row',
            children: [
              jsx('button', {
                className: 'mag-btn',
                'data-primary': true,
                disabled: disabled || shell.saving || !shell.dirty,
                onClick: () => props.save(),
                children: shell.saving ? t('saving') : t('save'),
              }),
              jsx('button', {
                className: 'mag-btn',
                disabled: disabled || !shell.dirty,
                onClick: () => props.discard(),
                children: t('discard'),
              }),
              shell.saved ? jsx('span', { className: 'mag-tag', 'data-tone': 'ok', children: t('saved') }) : null,
              shell.available !== true ? jsx('span', { className: 'mag-hint', children: t('unavailable') }) : null,
              disabled ? jsx('span', { className: 'mag-hint', children: t('notWritable') }) : null,
              shell.saveError === null
                ? null
                : jsx('p', {
                    className: 'mag-error',
                    children: fill(t('saveFailed'), { paths: shell.saveError }),
                  }),
            ],
          }),
        ],
      })
    }

    // ───────────────────────────── Remote 贡献 ─────────────────────────────
    // 与服务端 `src/remote.ts` 的描述符**逐字一致**（测试会比对）。
    function remoteDescriptors() {
      const t = (name) => `${REMOTE_PACKAGE}/types#${name}`
      const codec = (typeSymbol) => ({
        mode: 'strict',
        typeSymbol,
        create: () => ({
          parse: (value) => {
            if (value === null || value === undefined) return {}
            if (typeof value !== 'object') throw new Error('期望一个对象参数')
            return value
          },
        }),
      })
      const base = (method) => ({
        id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
        service: 'multiAgentGatewayRemote',
        namespace: REMOTE_NAMESPACE,
        method,
        implementation: method,
        invocation: { kind: 'direct' },
      })
      return ENDPOINTS.map((method) => {
        const descriptor = { ...base(method), result: codec(t('Response')) }
        // 与 `call()` 共用同一个判据，别再各写各的。
        if (!takesInput(method)) return { ...descriptor, parameters: [] }
        return {
          ...descriptor,
          parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec(t('Request')) }],
        }
      })
    }

    function remoteContribution() {
      return { package: REMOTE_PACKAGE, face: 'client', schemas: [], descriptors: remoteDescriptors() }
    }

    // ───────────────────────────── apply ─────────────────────────────

    /**
     * 客户端半边入口。
     *
     * ⚠️ 外面这层 `try/catch` **不是**防御性编程，是**必需的诊断**：
     * DSH 的 web boot 报告对 `failed` 状态只写「<pkg>: failed」，**不带原因**
     * （源码里 `${a}: ${u}`，只有 import 失败才带 message）。没有这层，
     * 插件在浏览器里挂掉时你只能看到一个「failed」，完全无从下手。
     */
    function apply(ctx) {
      try {
        return applyInner(ctx)
      } catch (error) {
        const detail = error && error.stack ? error.stack : String(error)
        console.error(`[${CONFIG_NS}] client entry failed to apply:`, detail)
        throw error
      }
    }

    function applyInner(ctx) {
      const t = ctx.locale.bind(DICT)
      ctx.effect(() => ctx.locale.register(DICT, { zh, en }), `${CONFIG_NS}: dictionaries`)

      const scope = ctx.configForms.get(CONFIG_NS)
      const panel = new GatewayPanel(scope, ctx)
      ctx.effect(() => () => panel.dispose(), `${CONFIG_NS}: panel subscription`)

      // ── 挂 Remote 贡献 ───────────────────────────────────────────
      //
      // ⚠️ 顺序每一步都踩过坑，别随手简化：
      //   ① `ctx.remote.$mount(贡献)` 内部会执行 `callerCtx.typert.remotes.register(...)`
      //      —— 用的是**调用方 ctx**。第三方插件的 ctx 不在客户端核心的 isolate 里，
      //      **必须自己声明 `typert`**，否则抛 `cannot get property "typert" without inject`。
      //   ② 命名空间服务 `remote.multiAgentGateway` 是 `$mount` **之后**才 provide 的，
      //      而且点号服务要声明才能访问（裸访问会被 cordis 拒）。
      //   所以：`ctx.inject(['typert','remote'])` 拿挂载用的 ctx → `$mount` →
      //   再 `inject([REMOTE_SERVICE,'slots','locale'], ...)` 拿数据源用的 ctx。
      const mount = ctx.remote?.$mount
      if (typeof mount !== 'function') {
        panel.remoteError = '这个部署没有 ctx.remote.$mount（界面上拿不到宿主能力）'
      } else {
        ctx.effect(() => {
          let unmounted = false
          let mountFiber = null
          ctx.inject(['typert', 'remote'], (mounter) => {
            void (async () => {
              try {
                await mounter.remote.$mount(remoteContribution())
                if (unmounted) return
                const child = mounter.inject([REMOTE_SERVICE, 'slots', 'locale'], (inner) => {
                  panel.remoteCtx = inner
                  void panel.refresh()
                })
                mountFiber = child
              } catch (error) {
                panel.remoteError = String(error && error.message ? error.message : error)
                panel.publish()
              }
            })()
          })
          return () => {
            unmounted = true
            void Promise.resolve(mountFiber).then((fiber) => fiber?.dispose?.()).catch(() => {})
          }
        }, `${CONFIG_NS}: client remote contribution`)
      }

      // ── 两处入口，同一个面板 ────────────────────────────────────
      //
      //   ① `plugins.bundle.config`（key = 包名）：**包页上直接渲染**，不用点任何东西。
      //   ② `plugins.row.config`（key = `<包名>#<row id>`）：包页那一行的标题变成可点按钮。
      //
      // 两个槽都由 `whileServed` 包着：宿主不提供这个 namespace 时不留痕迹。
      const face = () => ({ locale: DICT, inject: () => panel.inject() })
      ctx.effect(
        () =>
          ctx.configForms.whileServed([CONFIG_NS], () => {
            const disposers = [
              ctx.slots.inject('plugins.bundle.config', () =>
                ctx.slots.register({ name: 'plugins.bundle.config', key: CONFIG_NS, ...face() }, GatewayPanelView),
              ),
              ctx.slots.inject('plugins.row.config', () =>
                ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, ...face() }, GatewayPanelView),
              ),
            ]
            return () => {
              for (const dispose of disposers) if (typeof dispose === 'function') dispose()
            }
          }),
        `${CONFIG_NS}: plugins-page panel`,
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.ROW_KEY = ROW_KEY
    exports.BUNDLE_KEY = CONFIG_NS
    exports.CONFIG_NS = CONFIG_NS
    exports.REMOTE_NAMESPACE = REMOTE_NAMESPACE
    exports.REMOTE_PACKAGE = REMOTE_PACKAGE
    exports.REMOTE_ENDPOINTS = ENDPOINTS
    exports.AGENT_FIELDS = AGENT_FIELDS
    exports.GLOBAL_FIELDS = GLOBAL_FIELDS
    /**
     * 模型策略的字段路径（相对 Agent 根）。
     *
     * 单独导出是为了让契约测试把它们也当作 volatile 路径去比对宿主 schema ——
     * 这两个字段是设置页直接写死的路径，漂移了就会「保存整批被拒」。
     */
    exports.MODEL_POLICY_PATHS = [
      { key: 'mode', path: ['models', 'mode'], label: '模型上报模式' },
      { key: 'selected', path: ['models', 'selected'], label: '勾选的模型' },
    ]
    // 导出面板类与 keyOf：契约测试要能**直接构造面板并投影一次**，
    // 才拦得住「字段表笔误 → 客户端条目 failed」这类只在运行期暴露的错。
    exports.GatewayPanel = GatewayPanel
    exports.ModelList = ModelList
    exports.keyOf = keyOf
    exports.AGENTS = AGENTS
    exports.multiplierTag = multiplierTag
    exports.modelLabel = modelLabel
    exports.remoteDescriptors = remoteDescriptors
    exports.remoteContribution = remoteContribution
    return module.exports
  },
})
