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

    const { jsx, jsxs: jsxsRaw, Fragment } = require('react/jsx-runtime')
    /**
     * `jsxs` 的兼容包装。
     *
     * `react/jsx-runtime` 的签名是 `jsxs(type, props, key)` —— **第三个参数是 key，
     * 不是 children**。本文件里两种写法都在用：
     *
     *   - `jsxs('tr', { children: [...] }, item.id)`  → 第三个参数是 key
     *   - `jsxs('div', { className: 'x' }, [ ... ])`  → 第三个参数是 children
     *
     * 后者如果直接传给 runtime，children 会被当成 key 丢掉，**整块渲染成空壳**
     * （踩过一次：导航、卡片全是空的，但没有任何报错）。
     * 这里按类型分流：数组当 children，其余（字符串/数字）当 key。
     */
    const jsxs = (type, props, third) =>
      Array.isArray(third) ? jsxsRaw(type, { ...props, children: third }) : jsxsRaw(type, props, third)
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
      'probeModels',
      'requestLog',
      'requestSummary',
      'clearRequestLog',
      'updateStatus',
      'updateApply',
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
     *
     * ## `section` 决定它落在哪一块
     *
     *   - `basic`    常用开关 —— 永远展开
     *   - `schedule` 自动任务 —— 永远展开
     *   - `models`   模型表上方的「默认上下文长度」
     *   - `advanced` 上游地址 / cron 表达式 —— **默认折叠**
     *
     * ## ⚠️ 接口路径故意**不在**这张表里
     *
     * `upstream.checkInPath` / `quotaPath` / `tasksPath` / `taskClaimPath`
     * 是**适配器的内置知识**（每个 Agent 的接口形状本来就不同），让用户手填
     * 只会填错 —— 界面上出现过一次，反馈是「这些路径用户根本不知道怎么填」。
     * schema 里仍然保留这几个字段（YAML 高级用法仍可写），只是不再渲染。
     */
    const AGENT_FIELDS = [
      // ── 基础 ──
      { section: 'basic', key: 'enabled', kind: 'bool', path: ['enabled'], label: '启用这个 Agent', hint: '关掉后不再路由请求，也不再往模型选择器上报模型。' },
      { section: 'basic', key: 'exposeModels', kind: 'bool', path: ['exposeModels'], label: '上报模型到 DSH 选择器', hint: '关掉后对话框的模型下拉里不会有这个分组。' },
      { section: 'basic', key: 'labelWithAgent', kind: 'bool', path: ['labelWithAgent'], label: '模型名带 Agent 前缀', hint: '开启后显示成 `OpenCode · DeepSeek-R1 (×2)`。' },

      // ── 自动任务 ──
      { section: 'schedule', key: 'checkInEnabled', kind: 'bool', path: ['checkIn', 'enabled'], label: '自动签到（基础每日任务）', hint: '与活动任务完全独立的一套开关。' },
      { section: 'schedule', key: 'quotaEnabled', kind: 'bool', path: ['quota', 'enabled'], label: '定时拉取额度', hint: '定期查询每个账号的剩余额度，显示在账号表里。' },
      { section: 'schedule', key: 'tasksEnabled', kind: 'bool', path: ['tasks', 'enabled'], label: '自动活动任务', hint: '默认关。上游没有活动任务接口时打开也不会有收获。' },
      { section: 'schedule', key: 'tasksInterval', kind: 'number', path: ['tasks', 'intervalMinutes'], label: '任务轮询间隔（分钟）', hint: '太短会触发上游风控，建议不少于 30。' },
      { section: 'schedule', key: 'tasksConcurrency', kind: 'number', path: ['tasks', 'concurrency'], label: '任务并发上限', hint: '同时最多几个账号在跑，默认 1（串行）。' },
      { section: 'schedule', key: 'tasksMaxFailures', kind: 'number', path: ['tasks', 'maxFailures'], label: '连续失败暂停阈值', hint: '达到后临时暂停该账号的自动任务并告警。' },

      // ── 模型（紧贴在模型表上方） ──
      //
      // 上游报的窗口偏大 → DSH 一直不压缩 → 最后撞上游硬限制（表现像“压缩坏了”）；
      // 偏小 → 过早压缩。逐个模型的精确值在下面模型表里改，这里只是「一把改全部」。
      {
        section: 'models',
        key: 'contextWindowDefault',
        kind: 'number',
        path: ['contextWindow', 'default'],
        label: '默认上下文长度（token）',
        hint: '0 = 不覆盖。想给所有模型统一设一个值时才填；单个模型请在下面表格里单独改。',
      },

      // ── 高级（默认折叠） ──
      { section: 'advanced', key: 'chatBaseUrl', kind: 'text', path: ['upstream', 'chatBaseUrl'], label: '对话 base url', hint: '留空 = 用内置的官方地址。只有接自有反代时才需要填。' },
      { section: 'advanced', key: 'apiBaseUrl', kind: 'text', path: ['upstream', 'apiBaseUrl'], label: '业务 API base url', hint: '留空 = 用内置的官方地址。签到 / 额度 / 活动任务走这里。' },
      { section: 'advanced', key: 'checkInCron', kind: 'text', path: ['checkIn', 'cron'], label: '签到时间', hint: '`every:86400`（每天一次）或 `30 8 * * *`（每天 08:30）。' },
      { section: 'advanced', key: 'quotaCron', kind: 'text', path: ['quota', 'cron'], label: '额度拉取间隔', hint: '例如 `every:1800` = 每 30 分钟一次。' },
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
      // 全部颜色只用 DSH 的 14 个 design token，**不写兜底色**：
      // 兜底色一旦写错主题（浅色值出现在深色主题上）就会「没有原型好看」。
      // color-scheme 让原生控件（checkbox / select / 滚动条）跟着主题走；
      // 不写的话深色主题下会冒出亮白色的复选框。
      '.mag-root{display:flex;flex-direction:column;gap:10px;max-width:100%;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;color-scheme:light dark}',
      '.mag-root *{box-sizing:border-box}',
      '.mag-body{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.mag-spacer{margin-left:auto}',
      '.mag-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}',
      '.mag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.mag-ok{color:var(--dsw-alias-state-success-primary);font-weight:600}',
      '.mag-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.mag-row-tight{gap:6px}',

      // ── 页头 ─────────────────────────────────────────────────
      '.mag-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
      '.mag-brand{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13.5px;white-space:nowrap}',
      '.mag-tabs{display:flex;gap:2px;flex-wrap:wrap}',
      '.mag-tab{display:flex;align-items:center;gap:6px;border:0;background:0 0;padding:5px 11px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px}',
      '.mag-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mag-tab[aria-selected=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.mag-tab-n{min-width:16px;height:16px;line-height:16px;text-align:center;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;padding:0 4px}',
      '.mag-tab[aria-selected=true] .mag-tab-n{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary)}',

      // ── 点 / 徽章 / 标签 ──────────────────────────────────────
      '.mag-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary)}',
      '.mag-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}',
      '.mag-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}',
      '.mag-dot[data-tone=err]{background:var(--dsw-alias-state-error-primary)}',
      '.mag-dot[data-tone=brand]{background:var(--dsw-alias-brand-primary)}',
      '.mag-dot.mag-poll{animation:mag-poll 1.6s ease-out infinite}',
      '@keyframes mag-poll{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}',
      '.mag-tag{display:inline-block;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mag-tag-strong{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1))}',
      '.mag-badge{display:inline-block;border-radius:5px;padding:0 6px;font-size:11px;line-height:17px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.mag-badge[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.mag-badge[data-tone=warn]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.mag-badge[data-tone=err]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',

      // ── 按钮 / 输入 / 开关 ────────────────────────────────────
      '.mag-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;font:inherit;font-size:12.5px;padding:4px 11px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}',
      '.mag-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.mag-btn:disabled{opacity:.45;cursor:default}',
      '.mag-btn-sm{padding:3px 9px;font-size:12px}',
      '.mag-btn-xs{padding:1px 7px;font-size:11.5px;border-radius:5px}',
      '.mag-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.mag-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.07)}',
      '.mag-btn-brand{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));color:var(--dsw-alias-brand-primary)}',
      '.mag-btn-brand:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}',
      '.mag-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.mag-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mag-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,var(--dsw-alias-border-l1))}',
      '.mag-input{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;height:26px;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);padding:0 8px;min-width:0}',
      '.mag-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.mag-input:disabled{opacity:.5}',
      '.mag-input-num{max-width:120px}',
      '.mag-input-ctx{width:96px;text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;height:24px}',
      // 复选框自己画：不依赖原生外观，深色主题下不会冒出亮白方块。
      '.mag-check{appearance:none;-webkit-appearance:none;width:14px;height:14px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer;margin:0;flex:0 0 auto;position:relative;transition:background .12s,border-color .12s}',
      '.mag-check:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.mag-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.mag-check:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:2px solid #fff;border-top:0;border-left:0;transform:rotate(40deg)}',
      '.mag-check:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px}',
      '.mag-checkrow{display:flex;align-items:center;gap:5px;font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}',
      '.mag-switch{position:relative;width:30px;height:17px;border-radius:9px;background:var(--dsw-alias-state-idle-primary);border:0;cursor:pointer;flex:0 0 auto;padding:0;transition:background .15s}',
      '.mag-switch::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:left .15s}',
      '.mag-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}',
      '.mag-switch[aria-checked=true]::after{left:15px}',

      // ── 卡片 ─────────────────────────────────────────────────
      '.mag-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:9px;min-width:0}',
      '.mag-card>h3,.mag-card-hd>h3{margin:0;font-size:13px;font-weight:600;white-space:nowrap}',
      '.mag-card-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.mag-two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}',
      '@media (max-width:880px){.mag-two{grid-template-columns:minmax(0,1fr)}}',
      '.mag-alert{margin:0;padding:6px 10px;border-radius:6px;font-size:12.5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.mag-alert[data-tone=err]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.mag-alert[data-tone=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}',
      // 带 tone 的说明文字（版本更新的「检查结果」那一行）。
      // 失败必须是红的 —— 用灰的 `mag-hint` 显示「拉取远端失败」太容易被当成
      // 一句普通提示略过，而它恰恰是用户唯一能据以行动的信息。
      '.mag-hint[data-tone=err]{color:var(--dsw-alias-state-error-primary)}',
      '.mag-hint[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}',
      '.mag-hint[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
      '.mag-banner{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:7px 11px;border-radius:8px;font-size:12.5px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}',
      // 「作为左侧导航栏一行打开」时的外框（`surface: 'sidebar'`）。
      //
      // 为什么必须有这一层：`main` 槽位落在宿主的 centerCol 里，而那个容器是
      // `display:flex; overflow:hidden` —— 面板比视口高时**没有滚动条**，多出来的
      // 内容被直接裁掉（设置页里不会有这个问题：那边由宿主的卡片自己滚）。
      // 少了 padding 面板还会贴着窗口边，和宿主自带的插件页/定时任务页明显不像一家人。
      '.mag-page{padding:14px 16px;overflow:auto;flex:1 1 auto;min-height:0;min-width:0}',
      // 侧栏图标继承宿主的行颜色（含选中态），所以用 currentColor 而不是写死颜色。
      '.mag-navicon{display:block;flex:0 0 auto}',

      // ── 总览 ─────────────────────────────────────────────────
      '.mag-hero{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
      '.mag-hero h2{margin:0;font-size:15px;font-weight:600}',
      '.mag-hero p{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px}',
      '.mag-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}',
      '.mag-kpi{padding:7px 10px;border-radius:7px;background:var(--dsw-alias-bg-layer-2)}',
      '.mag-kpi b{display:block;font-size:17px;font-weight:600;letter-spacing:-.3px;font-variant-numeric:tabular-nums}',
      '.mag-kpi span{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.mag-kpi[data-tone=err] b{color:var(--dsw-alias-state-error-primary)}',
      '.mag-last{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;padding:7px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);font-size:12.5px;min-width:0}',

      // ── 表格 ─────────────────────────────────────────────────
      '.mag-tbl-wrap{overflow:auto;min-width:0}',
      '.mag-tbl{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.mag-tbl th,.mag-tbl td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}',
      '.mag-tbl th{color:var(--dsw-alias-label-secondary);font-weight:400;font-size:11px;white-space:nowrap}',
      '.mag-tbl tr:last-child td{border-bottom:0}',
      '.mag-tbl td.num,.mag-tbl th.num{text-align:right;font-variant-numeric:tabular-nums}',
      '.mag-tbl tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 4%,transparent)}',
      '.mag-tbl tr.failed td{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}',
      '.mag-pager{margin-top:4px}',

      // ── 平台 pills ───────────────────────────────────────────
      '.mag-pills{display:flex;gap:5px;flex-wrap:wrap}',
      '.mag-pill{display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:20px;padding:3px 11px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.mag-pill:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.mag-pill[aria-selected=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}',

      // ── 账号卡 ───────────────────────────────────────────────
      '.mag-acct-list{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.mag-acct{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0;flex-wrap:wrap}',
      '.mag-acct[data-tone=warn]{border-left:3px solid var(--dsw-alias-state-warn-primary)}',
      '.mag-acct-empty{flex-direction:column;align-items:center;text-align:center;gap:8px;padding:18px 12px;border-style:dashed;background:var(--dsw-alias-bg-layer-2)}',
      '.mag-acct-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1 1 240px}',
      '.mag-avatar{width:28px;height:28px;border-radius:7px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.mag-who{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.mag-who b{font-size:12.5px;font-weight:600}',
      '.mag-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      '.mag-togs{display:flex;gap:10px;flex-wrap:wrap}',
      '.mag-tog{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',

      // ── 模型区 ───────────────────────────────────────────────
      '.mag-count{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
      '.mag-count b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.mag-mtoolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mag-input-search{width:200px;max-width:100%}',
      '.mag-save{position:sticky;top:4px;z-index:3;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12.5px}',
      '.mag-save b{font-weight:600}',
      '.mag-save[data-dirty=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 6%,var(--dsw-alias-bg-layer-1))}',
      '.mag-save[data-dirty=true] b{color:var(--dsw-alias-state-warn-primary)}',
      '.mag-mtable{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:auto}',
      '.mag-mhead,.mag-mrow{display:grid;grid-template-columns:20px minmax(140px,1fr) 58px 120px 78px 62px;align-items:center;gap:8px;padding:5px 9px;min-width:540px}',
      '.mag-mhead{background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.mag-mrow{border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px}',
      '.mag-mrow:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 3%,transparent)}',
      '.mag-mrow[data-off=true] .mag-mn{color:var(--dsw-alias-label-secondary)}',
      '.mag-mname{min-width:0}',
      '.mag-mn{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mag-mid{display:block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mag-mrow>.mag-tag,.mag-stcell{justify-self:start}',
      '.mag-ctx{display:flex;align-items:center;gap:4px}',
      '.mag-ctx-hint{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mag-mempty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}',
      // 窄面板（设置页只有 ~460px 时）：去掉状态列、收紧上下文列，避免横向滚动
      '@media (max-width:620px){',
      '.mag-mhead,.mag-mrow{grid-template-columns:20px minmax(96px,1fr) 52px 100px 58px;min-width:0}',
      '.mag-mhead>span:nth-child(5),.mag-mrow>.mag-stcell{display:none}',
      '.mag-ctx-hint{display:none}',
      '.mag-input-ctx{width:88px}',
      '.mag-input-search{width:100%;flex:1 1 140px}',
      '}',
      '.mag-mfoot{margin-top:2px}',

      // ── 任务 ─────────────────────────────────────────────────
      '.mag-module-hd{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}',
      '.mag-kv{display:grid;grid-template-columns:76px minmax(0,1fr);gap:5px 10px;font-size:12.5px}',
      '.mag-k{color:var(--dsw-alias-label-secondary)}',

      // ── 设置表单 ─────────────────────────────────────────────
      '.mag-form-row{display:grid;grid-template-columns:minmax(170px,250px) minmax(0,1fr);gap:14px;align-items:start;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mag-form-row:last-child{border-bottom:0}',
      '@media (max-width:760px){.mag-form-row{grid-template-columns:minmax(0,1fr);gap:6px}}',
      '.mag-lab{font-size:12.5px;line-height:18px}',
      '.mag-ctl{display:flex;flex-direction:column;gap:4px;min-width:0;align-items:flex-start}',

      // ── 登录弹框 ─────────────────────────────────────────────
      //
      // 排版原则：**一屏只讲一件事**，每块之间留 14px。
      // 上一版把步骤、链接、按钮、状态全塞进 13px padding 里，链接框和主按钮
      // 还并排 —— 真机上挤成一团（用户报「排版太丑」），所以这一版：
      //   步骤 → 设备码 / 授权链接 → 整行主按钮 → 状态卡，从上到下一条线。
      '.mag-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}',
      // ⚠️ 不要再给「已打开浏览器」的状态加左移（原型里的 `with-browser` 那套）。
      // 真机上 DSH 是全屏窗口，左移 6% 在 1920 宽屏上等于把弹框甩到最左边，
      // 用户原话「弹框位置偏移太厉害」——居中永远是对的，别再动它。
      '.mag-modal{width:100%;max-width:520px;max-height:calc(100vh - 48px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,.28);display:flex;flex-direction:column}',
      '.mag-modal-hd{display:flex;align-items:center;gap:9px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mag-modal-hd b{font-size:14px;font-weight:600}',
      '.mag-x{margin-left:auto;border:0;background:0 0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;padding:3px 6px;border-radius:6px}',
      '.mag-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mag-modal-bd{padding:16px 18px;display:flex;flex-direction:column;gap:14px}',
      '.mag-modal-lead{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}',
      '.mag-modal-center{align-items:center;text-align:center;gap:9px;padding:28px 20px}',
      '.mag-modal-title{font-size:15px;font-weight:600}',
      '.mag-modal-ft{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      // 步骤：圆圈 + 连接线（比两行裸文字清楚，能一眼看出走到第几步）
      '.mag-steps{display:flex;flex-direction:column}',
      '.mag-step{position:relative;display:flex;align-items:flex-start;gap:10px;padding-bottom:12px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}',
      '.mag-step:last-child{padding-bottom:0}',
      '.mag-step:not(:last-child)::before{content:"";position:absolute;left:9px;top:23px;bottom:3px;width:1px;background:var(--dsw-alias-border-l1)}',
      '.mag-step-n{width:19px;height:19px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;justify-content:center;font-size:11px;flex:0 0 auto;z-index:1}',
      '.mag-step-t{min-width:0;line-height:19px}',
      '.mag-step[data-state=on]{color:var(--dsw-alias-label-primary)}',
      '.mag-step[data-state=on] .mag-step-n{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.mag-step[data-state=done]{color:var(--dsw-alias-label-primary)}',
      '.mag-step[data-state=done] .mag-step-n{background:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);color:#fff}',
      // 「带标签的字段」：授权链接与设备码共用同一套（标签在框外，别挤在框里）
      '.mag-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.mag-field-lab{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.mag-urlbox{display:flex;align-items:center;gap:8px;padding:7px 7px 7px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.mag-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary)}',
      '.mag-codebox{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.mag-code{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-primary)}',
      // 主按钮整行、说明放按钮下面（上一版按钮和说明并排，窄屏下互相挤）
      '.mag-cta{display:flex;flex-direction:column;gap:7px}',
      '.mag-btn-block{width:100%;justify-content:center;padding:8px 12px;font-size:13px}',
      '.mag-cta-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.mag-ext{margin-left:2px;font-size:11px;opacity:.85}',
      // 状态卡：主状态 + 剩余有效期进度条 + 次要说明
      '.mag-status{display:flex;flex-direction:column;gap:9px;padding:12px 13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.mag-status-line{display:flex;align-items:center;gap:8px;font-size:12.5px;flex-wrap:wrap}',
      '.mag-status-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px}',
      '.mag-status-t{color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}',
      '.mag-bar{height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden}',
      '.mag-bar>i{display:block;height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary);transition:width .3s linear}',
      '.mag-spin{width:11px;height:11px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent);border-top-color:var(--dsw-alias-brand-primary);display:inline-block;animation:mag-spin .8s linear infinite}',
      '.mag-spin-lg{width:18px;height:18px;border-width:2.5px}',
      '@keyframes mag-spin{to{transform:rotate(360deg)}}',
      '.mag-tick{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.mag-ic{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.mag-ic[data-tone=warn]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.mag-reason{width:100%;margin:2px 0 0;padding:6px 8px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);text-align:left;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px}',

      // ── toast ────────────────────────────────────────────────
      '.mag-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:1010;padding:7px 14px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12.5px;color:var(--dsw-alias-label-primary)}',
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
      nav: 'Free Token',
      title: 'Free Token',
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
      // ── 分组标题 / 上下文长度 ──
      sectionBasic: '基础',
      sectionSchedule: '自动任务',
      sectionAdvanced: '高级（一般不用改）',
      advanced: '高级设置',
      pageOverview: '总览',
      pageAccounts: '账号',
      pageTasks: '任务',
      pageLogs: '日志',
      pageSettings: '设置',
      contextWindow: '上下文长度',
      contextWindowHint: 'DSH 靠它判断何时压缩上下文。留空 = 用上游报的值。',
      upstreamWindow: '上游',
      freeCount: '免费 {free} / 共 {total}',
      noFreeModels: '这个 Agent 没有免费模型（上游没把任何模型标成免费）。勾上「显示付费模型」看看全部。',
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
      nav: 'Free Token',
      title: 'Free Token',
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
      // ── group headings / context window ──
      sectionBasic: 'Basics',
      sectionSchedule: 'Automation',
      sectionAdvanced: 'Advanced (rarely needed)',
      advanced: 'Advanced settings',
      pageOverview: 'Overview',
      pageAccounts: 'Accounts',
      pageTasks: 'Tasks',
      pageLogs: 'Logs',
      pageSettings: 'Settings',
      contextWindow: 'Context window',
      contextWindowHint: 'DSH uses this to decide when to compact. Empty = the upstream value.',
      upstreamWindow: 'upstream',
      freeCount: '{free} free / {total} total',
      noFreeModels: 'No free models for this Agent. Tick “Show paid models” to see them all.',
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

    /** 把 hint 的几段拼起来，空段自动丢掉（别让用户看到「 ·  · 」这种）。 */
    function joinHint(...parts) {
      return parts.filter((part) => typeof part === 'string' && part !== '').join(' · ')
    }

    /**
     * 「上次拉取 …」后缀。
     *
     * 只在快照**真的带时间戳**时追加 —— 否则会显示成「上次拉取 —」，
     * 比不显示更让人困惑。
     */
    function fetchedStamp(quota) {
      const at = quota?.fetchedAt
      return typeof at === 'number' && at > 0 ? `上次拉取 ${timeOf(at)}` : ''
    }

    /**
     * 额度显示。
     *
     * ## 为什么要分四种状态（用户报「账号的额度未拉取」）
     *
     * 下面三种情形在旧实现里长得几乎一样，用户分不清：
     *   ① **没拉到** —— 快照压根不存在（定时拉取没开 / 还没轮到）；
     *   ② **拉到了，真的是 0** —— 上游明确回 `remaining: 0`；
     *   ③ **拉到了，但已用尽** —— 上游下发 `extra.isQuotaExceeded: true`。
     * 旧实现在 `remaining` 是 0 时给的是**绿色 ok 语气**，`quota.error` 被塞进
     * 一个大多数调用点根本不渲染的 `hint` 里，`isQuotaExceeded` 更是从没露过面。
     * 于是「0 积分（已用尽）」看起来和「一切正常」一模一样。
     *
     * 现在四种状态各有 tone，且 hint 一律带上**上次拉取时间** ——
     * 「未拉取」与「拉到了但 0」就再也不会混淆。
     */
    function quotaView(quota, unit) {
      // ① 没有快照 = 从来没拉到过。说「未拉取」，不要画成 0。
      if (quota === undefined || quota === null) {
        return { text: '未拉取', tone: undefined, hint: '还没拉取过，点「刷新额度」拉一次' }
      }
      const stamp = fetchedStamp(quota)
      // ② 拉取失败：**说原因**，不能拿 remaining 画一个看着挺正常的数字。
      if (typeof quota.error === 'string' && quota.error !== '') {
        return { text: '未知', tone: 'warn', hint: joinHint(quota.error, stamp) }
      }
      if (quota.unlimited === true) {
        return { text: '不限', tone: 'ok', hint: stamp }
      }
      if (typeof quota.remaining === 'number') {
        const suffix = unit === 'usd' ? ' 美元' : unit === 'credits' ? ' 积分' : ''
        const usedUp = quota.extra?.isQuotaExceeded === true
        const empty = quota.remaining <= 0
        // 「0 剩余」不该再用绿色 ok 语气：上游明说用尽时说「已用尽」，
        // 只是数字为 0 时也说「剩余为 0」—— 两者措辞不同，因为证据不同
        // （前者是上游的判定，后者是我们的推断）。
        const note = usedUp ? '上游报告额度已用尽' : empty ? '剩余为 0' : ''
        return {
          text: `${quota.remaining}${suffix}`,
          tone: usedUp || empty ? 'warn' : 'ok',
          hint: joinHint(note, quota.total === undefined ? '' : `总额度 ${quota.total}，已用 ${quota.used ?? 0}`, stamp),
        }
      }
      // ③ 有快照但既没有 remaining 也不是不限：上游没给这个字段。
      return { text: '未知', tone: 'warn', hint: joinHint('上游没有返回剩余额度', stamp) }
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

    /**
     * 把签到结果翻成一句**用户能据此行动**的话。
     *
     * ## 为什么不能只说「签到 完成」
     *
     * 「完成」不等于「领到了」。签到实际有四种结果，用户必须能分开：
     *
     *   1. **真领到了** —— 说清加了多少积分；
     *   2. **今天已经领过** —— 什么都没发生，但**也不需要再做**（安心）；
     *   3. **需要你去别处操作** —— 例如账号还没在平台侧开通每日领取，
     *      一直点「立即签到」也没用，必须去官方客户端登录一次；
     *   4. **今天还没到刷新时刻** —— 稍后重试就行（今天尚未记账）。
     *
     * 3 与 4 尤其不能混：前者是「你得做点什么」，后者是「等一会儿就好」。
     * 说反了用户会白折腾半天（或以为已经领到而错过当天额度）。
     *
     * ⚠️ 判据取自宿主的**布尔字段**（`actionRequired` / `coversToday` / `recorded`），
     * **不是**去匹配 message 文案 —— 文案会随措辞变化而失效。
     */
    function describeCheckIn(value) {
      // 宿主返回的是一组账号的结果（批量）或单个账号的结果，两种都认。
      const rows = Array.isArray(value) ? value : (value && Array.isArray(value.accounts) ? value.accounts : [value])
      const items = rows.filter((item) => item !== null && typeof item === 'object')
      if (items.length === 0) return '签到完成（宿主没有返回明细）'

      const needAction = items.filter((item) => item.actionRequired === true)
      const granted = items.filter((item) => Number(item.credits) > 0)
      const already = items.filter(
        (item) => item.ok === true && item.supported === true && item.recorded === true && !(Number(item.credits) > 0),
      )
      const pending = items.filter((item) => item.coversToday === false)
      const unsupported = items.filter((item) => item.supported === false)
      const failed = items.filter((item) => item.ok === false && item.supported !== false)

      const parts = []
      if (granted.length > 0) {
        const total = granted.reduce((sum, item) => sum + Number(item.credits || 0), 0)
        parts.push(`${granted.length} 个账号领到 ${total} 积分`)
      }
      if (already.length > 0) parts.push(`${already.length} 个账号今天已经领过`)
      if (unsupported.length > 0) parts.push(`${unsupported.length} 个平台没有签到接口`)
      if (failed.length > 0) parts.push(`${failed.length} 个失败`)

      // 「需要你操作」与「稍后重试」各占一句，且**追加在末尾单独成句** ——
      // 它们是需要用户采取行动的信息，混在计数里会被读漏。
      const notes = []
      if (needAction.length > 0) {
        const detail = needAction.map((item) => item.message).filter((text) => typeof text === 'string' && text !== '')
        notes.push(`有 ${needAction.length} 个账号需要你先去平台侧操作：${detail[0] || '请到账号页重新登录一次该账号'}`)
      }
      if (pending.length > 0) {
        notes.push(`有 ${pending.length} 个账号今天还没到活动刷新时刻（今天尚未记账，稍后会自动重试）`)
      }

      const head = parts.length > 0 ? parts.join('，') : '没有可签到的账号'
      return notes.length > 0 ? `${head}。${notes.join('；')}` : head
    }

    /**
     * 把「刷新额度」的结果翻成一句**能据以行动**的话。
     *
     * ## 宿主返回的形状是**冻结**的（别再改，客户端按它写）
     *
     * `Array<{ accountId, agentId, label, unit, remaining|null, total|null,
     *  used|null, unlimited, error|null, fetchedAt }>`
     *
     * ## 为什么不能只说「刷新额度 完成」
     *
     * 用户点这个按钮，就是要回答一个问题：**「我这几个账号到底还有多少额度？」**
     * 「完成」没有回答它。而且「刷新完成」有三种截然不同的结果：
     *   ① 全成功 —— 要说清**每个账号剩多少**，尤其是 0 / 已用尽的；
     *   ② 有失败 —— 说清**几个失败 + 第一条原因**（原因才是用户能去处理的）；
     *   ③ 一个账号都没刷 —— 说「没有可刷新的账号」，而不是「0 个账号额度已更新」。
     *
     * ⚠️ 判据用的是宿主的**结构化字段**（`error` / `remaining` / `unlimited`），
     * **不是**去匹配 message 文案 —— 文案会随措辞变化而失效。
     */
    function describeQuotaRefresh(value) {
      // 批量（数组）与单个账号（对象）两种都给认，和 describeCheckIn 同口径。
      const rows = Array.isArray(value) ? value : (value && Array.isArray(value.accounts) ? value.accounts : [value])
      const items = rows.filter((item) => item !== null && typeof item === 'object')
      if (items.length === 0) return '没有可刷新的账号'

      const failed = items.filter((item) => typeof item.error === 'string' && item.error !== '')
      const ok = items.filter((item) => !(typeof item.error === 'string' && item.error !== ''))

      /** 一个账号的剩余额度摘要，如「主号 0 积分（已用尽）」。 */
      const summaryOf = (item) => {
        const who = item.label || item.accountId || '账号'
        if (item.unlimited === true) return `${who} 不限`
        if (item.remaining === null || item.remaining === undefined) return `${who} 额度未知`
        const suffix = item.unit === 'usd' ? ' 美元' : item.unit === 'credits' ? ' 积分' : ''
        if (item.remaining <= 0) return `${who} 0${suffix}（已用尽）`
        return `${who} ${item.remaining}${suffix}`
      }

      const parts = []
      if (ok.length > 0) {
        // 最多列 3 个账号的明细，其余折叠成计数 —— 一句话不能变成一张表。
        const shown = ok.slice(0, 3).map(summaryOf).join('、')
        const more = ok.length > 3 ? ` 等 ${ok.length} 个账号` : ''
        parts.push(`${ok.length} 个账号额度已更新：${shown}${more}`)
      }
      if (failed.length > 0) parts.push(`${failed.length} 个账号拉取失败`)

      const head = parts.length > 0 ? parts.join('，') : '没有可刷新的账号'
      // 失败原因**单独成句缀在末尾**：混在计数中间会被读漏，而它才是用户能动手的部分。
      if (failed.length > 0) {
        const first = failed.find((item) => typeof item.error === 'string' && item.error !== '')
        return `${head}。第一个失败原因：${first.error}`
      }
      return head
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
        /** 模型勾选列表的搜索框内容（纯界面状态，不写进配置）。 */
        this.modelFilter = ''
        /**
         * 正在探测可用性的模型 id（纯界面状态）。
         *
         * 探测是**一次真实上游请求**，慢的时候十几秒。不把「进行中」画出来，
         * 用户点完「测一次」看不到任何变化，会以为按钮坏了（实际报障）。
         */
        this.probing = new Set()
        /** 「高级设置」是否展开（纯界面状态；默认折叠，绝大多数人不用碰）。 */
        this.advancedOpen = false
        /** 当前页（`overview` / `accounts` / `tasks` / `logs` / `settings`）。 */
        this.page = 'overview'
        /** 总览 KPI（`requestSummary` 端点）。 */
        this.summaryState = { status: 'idle', data: null, error: null }
        /** 请求日志（分页）。 */
        this.logState = { status: 'idle', entries: [], total: 0, page: 1, pageSize: 20, error: null }
        /** 版本更新状态。 */
        this.updateState = { status: 'idle', data: null, error: null, applying: false, result: null }
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
          // 同样要 unwrap：远端出错时返回的是 `{ok:false,error}`，
          // 直接当成快照会让整页渲染出一堆 undefined。
          const result = unwrap(await this.call('state'))
          if (!result.ok) throw new Error(result.error)
          this.snapshot = { status: 'ready', value: result.value, error: null }
          this.remoteError = null
        } catch (error) {
          this.snapshot = { status: 'error', value: this.snapshot.value, error: String(error && error.message ? error.message : error) }
          this.remoteError = this.snapshot.error
        }
        this.publish()
        // 总览要的 KPI 与「最近失败」：首屏就把数据拉好，
        // 否则默认页（总览）会空着一块，直到用户手动切页才出现。
        if (this.snapshot.status === 'ready') {
          void this.loadSummary()
          void this.loadRequestLog()
        }
      }

      /** 拉模型列表（全量 + 当前上报策略 + 实际上报的 id）。 */
      async loadModels(force) {
        this.models = { ...this.models, status: 'loading', agentId: this.selectedAgent }
        this.publish()
        try {
          // ⚠️ 必须 unwrap：远端把结果包在 `{ok, value}` 里，
          // 直接读 `payload.models` 会永远拿到 undefined（列表一直是空的）。
          const result = unwrap(await this.call('models', { agentId: this.selectedAgent, force: force === true }))
          if (!result.ok) throw new Error(result.error)
          const payload = result.value ?? {}
          this.models = {
            status: 'ready',
            agentId: this.selectedAgent,
            items: payload.models ?? [],
            exposedIds: payload.exposedIds ?? [],
            // 勾选框显示的必须是「实际会上报的那份」，否则 mode=free 时勾选框全空
            selectedIds: payload.selectedIds ?? [],
            defaultSelectedIds: payload.defaultSelectedIds ?? [],
            policy: payload.policy ?? { mode: 'free', selected: [] },
            error: null,
          }
        } catch (error) {
          this.models = {
            status: 'error',
            agentId: this.selectedAgent,
            items: [],
            exposedIds: [],
            selectedIds: [],
            defaultSelectedIds: [],
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
       *
       * 基准的优先级：**草稿 > 宿主上报的 `selectedIds` > 默认勾选**。
       * 草稿必须优先 —— 否则连续勾两个模型时，第二次会用宿主的旧集合当基准，
       * 把第一次的改动冲掉（表现为「勾了 5 个，保存后只剩 1 个」）。
       */
      toggleModel(id, checked) {
        const draft = this.drafts.get(keyOf(this.modelPath('selected')))
        const draftIds = draft === undefined || typeof draft.text !== 'string'
          ? null
          : draft.text.split(/[,\n]/).map((item) => item.trim()).filter((item) => item !== '')
        const base = new Set(
          draftIds !== null
            ? draftIds
            : Array.isArray(this.models.selectedIds) && this.models.selectedIds.length > 0
              ? this.models.selectedIds
              : this.modelSelection(),
        )
        if (checked === true) base.add(id)
        else base.delete(id)
        this.edit(this.modelPath('selected'), [...base].join(','))
        this.edit(this.modelPath('mode'), 'selected')
      }

      // ── 逐模型上下文长度 ──────────────────────────────────────

      /** 路径：当前 Agent 的「按模型覆盖上下文长度」字段（绝对路径）。 */
      windowPath() {
        return ['agents', this.selectedAgent, 'contextWindow', 'overrides']
      }

      /** 当前生效的 `模型id → 长度` 覆盖（草稿优先，其次配置里的值）。 */
      windowOverrides() {
        const path = this.windowPath()
        const draft = this.drafts.get(keyOf(path))
        return parseWindowText(draft !== undefined ? draft.text : textOf(this.valueAt(path)))
      }

      /**
       * 改**单个模型**的上下文长度（模型表里那一列）。
       *
       * 空串 / 0 / 负数 = 删掉这条覆盖，回落到「默认值 → 上游报的值」。
       * 写回的是 `模型id=长度` 串（宿主只接受固定路径的 volatile 字段，
       * 用不了按模型的 dict）。
       */
      setModelWindow(id, text) {
        if (typeof id !== 'string' || id === '') return
        const map = this.windowOverrides()
        const raw = String(text ?? '').trim()
        const value = Number(raw)
        if (raw === '' || !Number.isFinite(value) || value <= 0) delete map[id]
        else map[id] = Math.floor(value)
        this.edit(this.windowPath(), serializeWindowText(map))
      }

      /** 展开 / 收起「高级设置」。 */
      toggleAdvanced() {
        this.advancedOpen = !this.advancedOpen
        this.publish()
      }

      /**
       * 用户回答「要不要加到左侧导航栏」。
       *
       * 只转给控制器，自己**不**存状态：这个选择的生命周期比面板长 ——
       * 侧栏那一行由 `apply` 注册的槽位占着，而面板每次打开都是新的。
       * 存两份早晚不一致（面板被卸载时那份就丢了）。
       */
      async setSidebarEntry(enabled) {
        if (SIDEBAR_ENTRY === null) return
        await SIDEBAR_ENTRY.set(enabled)
      }

      // ── 分页与数据 ──────────────────────────────────────────────

      /** 切页，并顺手拉这一页要的数据。 */
      setPage(page) {
        if (this.page === page) return
        this.page = page
        /**
         * ⚠️ **切页必须清掉上一次的动作提示**。
         *
         * 那是「刚才那一下干了什么」的一次性反馈（「1 个账号额度已更新…」），
         * 它属于**触发它的那一页**。早先不清，于是用户点了刷新额度、再切到
         * 任务页，顶上那条提示还在（用户报「切换选项卡后提示一直存在」）——
         * 看起来像任务页自己的状态，很误导。
         */
        this.actionMessage = null
        this.publish()
        if (page === 'overview') void this.loadSummary()
        if (page === 'logs') void this.loadRequestLog()
      }

      /** 总览 KPI。失败也要显示出来，不能静默空着。 */
      async loadSummary() {
        this.summaryState = { ...this.summaryState, status: 'loading' }
        this.publish()
        try {
          const result = unwrap(await this.call('requestSummary', {}))
          if (!result.ok) throw new Error(result.error)
          this.summaryState = { status: 'ready', data: result.value, error: null }
        } catch (error) {
          this.summaryState = {
            status: 'error',
            data: null,
            error: String(error && error.message ? error.message : error),
          }
        }
        this.publish()
      }

      /** 请求日志分页。 */
      async loadRequestLog() {
        this.logState = { ...this.logState, status: 'loading' }
        this.publish()
        const offset = (this.logState.page - 1) * this.logState.pageSize
        try {
          const result = unwrap(
            await this.call('requestLog', { limit: this.logState.pageSize, offset }),
          )
          if (!result.ok) throw new Error(result.error)
          const value = result.value ?? {}
          this.logState = {
            status: 'ready',
            entries: value.entries ?? [],
            total: value.total ?? 0,
            page: this.logState.page,
            pageSize: this.logState.pageSize,
            error: null,
          }
        } catch (error) {
          this.logState = {
            status: 'error',
            entries: [],
            total: 0,
            page: 1,
            pageSize: this.logState.pageSize,
            error: String(error && error.message ? error.message : error),
          }
        }
        this.publish()
      }

      setLogPage(page) {
        this.logState = { ...this.logState, page: Math.max(1, Math.floor(page)) }
        void this.loadRequestLog()
      }

      setLogPageSize(size) {
        this.logState = { ...this.logState, pageSize: Math.max(1, Math.floor(size)), page: 1 }
        void this.loadRequestLog()
      }

      async clearRequestLogs() {
        try {
          await this.call('clearRequestLog', {})
        } catch {
          // 清空失败不该拦住界面：下面重新拉一次就能看出结果
        }
        this.logState = { ...this.logState, page: 1 }
        await this.loadRequestLog()
        await this.loadSummary()
      }

      /** 外链登录：问一次结果（用户点「刷新登录状态」时调用）。 */
      async refreshLogin() {
        if (this.login.loginId === null) return
        await this.pollLogin()
      }
      /**
       * 对一个平台跑一轮模型可用性探测；传 `ids` 就只探这几个。
       *
       * 探测结论由宿主写进 `probes.json`、并随 `models` 端点的 `availability`
       * 一起回来，所以这里只要「跑一轮 + 重新拉模型」就够了 —— 刷新页面也在。
       *
       * 「进行中」必须画出来（`this.probing`）：一次探测是真实上游请求，
       * 十几秒很正常，不给反馈用户会以为没生效。同一时间只跑一轮 ——
       * 宿主的 probe 是串行的，并发只会互相排队。
       */
      async probeModels(agentId, ids) {
        const list = (Array.isArray(ids) ? ids : []).map((id) => String(id)).filter((id) => id !== '')
        if (this.probing.size > 0) return
        for (const id of list) this.probing.add(id)
        this.publish()
        try {
          await this.run('探测模型', 'probeModels', {
            agentId,
            force: true,
            ...(list.length > 0 ? { ids: list } : {}),
          })
          await this.loadModels(true)
        } finally {
          this.probing.clear()
          this.publish()
        }
      }

      /** 检查插件版本更新。 */
      async checkUpdate() {
        this.updateState = { ...this.updateState, status: 'loading', error: null, result: null }
        this.publish()
        try {
          const result = unwrap(await this.call('updateStatus', {}))
          if (!result.ok) throw new Error(result.error)
          this.updateState = { status: 'ready', data: result.value, error: null, applying: false, result: null }
        } catch (error) {
          this.updateState = {
            status: 'error',
            data: null,
            error: String(error && error.message ? error.message : error),
            applying: false,
            result: null,
          }
        }
        this.publish()
      }

      /** 一键更新（git pull --ff-only）。 */
      async applyUpdate() {
        if (this.updateState.applying === true) return
        this.updateState = { ...this.updateState, applying: true, error: null }
        this.publish()
        try {
          const result = unwrap(await this.call('updateApply', {}))
          if (!result.ok) throw new Error(result.error)
          this.updateState = {
            status: 'ready',
            data: this.updateState.data,
            error: null,
            applying: false,
            result: result.value,
          }
          await this.checkUpdate()
        } catch (error) {
          this.updateState = {
            ...this.updateState,
            applying: false,
            error: String(error && error.message ? error.message : error),
          }
        }
        this.publish()
      }

      /**
       * 跑一个动作（统一 busy 状态与结果提示）。
       *
       * `describe` 可选：把宿主的返回值翻成一句人话。
       *
       * 为什么需要它：默认文案只有「<标签> 完成」，而**「完成」不等于「领到了」**。
       * 签到尤其如此 —— 三种结果在用户眼里必须分得开：
       *   · 真领到了（+100 积分）
       *   · 今天已经领过（什么都没发生，但也不必再做）
       *   · 该账号还没开通每日领取 / 今天还没到刷新时刻（**需要用户做点什么，或稍后重试**）
       * 只说一句「签到 完成」，用户既不知道有没有领到，也不知道要不要再点一次。
       */
      async run(label, method, input, describe) {
        if (this.busy !== null) return
        this.busy = label
        this.actionMessage = null
        this.publish()
        let value
        try {
          value = unwrap(await this.call(method, input ?? {}))
          if (value !== null && typeof value === 'object' && value.ok === false) {
            throw new Error(typeof value.error === 'string' ? value.error : '宿主返回失败')
          }
          this.actionMessage = {
            ok: true,
            text: typeof describe === 'function' ? describe(value.value) : `${label} 完成`,
          }
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
          const info = unwrap(await this.call('loginStart', { agentId: this.selectedAgent }))
          if (!info.ok) throw new Error(info.error)
          const data = info.value ?? {}
          // 两种形态：
          //   · 设备码（OpenCode）—— 有 verificationUrl，前端自动轮询；
          //   · 外链登录（WorkBuddy / Qoder）—— 只有 authUrl，用户登录完自己点
          //     两种都要自动轮询；「手动刷新状态」是补充，不是唯一入口。
          const authUrl = typeof data.authUrl === 'string' ? data.authUrl : null
          const verificationUrl = typeof data.verificationUrl === 'string' ? data.verificationUrl : null
          const expiresInSec = Math.max(30, Number(data.expiresInSec) || 300)
          this.login = {
            status: 'waiting',
            message: null,
            loginId: data.loginId,
            userCode: data.userCode ?? null,
            verificationUrl,
            authUrl,
            autoPoll: true,
            intervalSec: Math.max(2, Number(data.intervalSec) || 5),
            expiresInSec,
            /**
             * 绝对到期时刻。
             *
             * 弹框要画「剩余 4:32」和一条倒计时进度条 —— 只给相对秒数的话，
             * 每次重画都要重新起算，倒计时会一直卡在初始值。
             */
            expiresAt: Date.now() + expiresInSec * 1000,
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
            // 一直排到 ready / failed / expired（外链登录也自动检查）
            if (this.login.autoPoll === true) this.scheduleLoginPoll()
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
            dirtyCount: ops.length,
            saving: this.saving,
            saved: this.saved,
            saveError: this.saveError,
            status: form.status,
            advancedOpen: this.advancedOpen,
            page: this.page,
          },
          summary: this.summaryState,
          log: this.logState,
          update: this.updateState,
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
            /** 实际上报的那份（宿主给的），勾选框与计数都读它。 */
            selectedIds: this.models.selectedIds ?? [],
            exposedIds: this.models.exposedIds ?? [],
            filter: this.modelFilter,
            /** 逐模型覆盖的上下文长度（模型表里那一列）。 */
            windowOverrides: this.windowOverrides(),
          },
          busy: this.busy,
          /** 正在探测可用性的模型 id（模型表格里画「测试中…」）。 */
          probing: [...this.probing],
          actionMessage: this.actionMessage,
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
          setModelWindow: (id, text) => this.setModelWindow(id, text),
          toggleAdvanced: () => this.toggleAdvanced(),
          /**
           * 「要不要加到左侧导航栏」。
           *
           * 走控制器而不是写配置：这个选择存在 localStorage 里（理由见
           * `createSidebarStore`），不经过宿主 schema，所以没有草稿/保存那套。
           * 落盘后由控制器自己 `notify()` → 订阅者重画，这里不用再 `paint()`。
           */
          setSidebarEntry: (enabled) => this.setSidebarEntry(enabled),
          setPage: (page) => this.setPage(page),
          loadSummary: () => this.loadSummary(),
          loadRequestLog: () => this.loadRequestLog(),
          setLogPage: (page) => this.setLogPage(page),
          setLogPageSize: (size) => this.setLogPageSize(size),
          clearRequestLogs: () => this.clearRequestLogs(),
          probeModels: (agentId, ids) => this.probeModels(agentId, ids),
          checkUpdate: () => this.checkUpdate(),
          applyUpdate: () => this.applyUpdate(),
          // ⚠️ `describe` 必须一起转发。早先这里只声明了 3 个形参，而调用方
          // 一直是按 4 个实参写的（`props.run(label, method, input, describeXxx)`）——
          // 第 4 个被静默吞掉，`run()` 里的 `typeof describe === 'function'` 永远是 false，
          // 于是所有动作都退化成兜底文案「<标签> 完成」。
          // 表现：签到早就该说「N 个账号领到 X 积分 / 今天已经领过」，
          // 实际一直只显示「签到 完成」—— 用户分不清「领到了」与「今天已领」。
          run: (label, method, input, describe) => this.run(label, method, input, describe),
          startLogin: () => this.startLogin(),
          refreshLogin: () => this.refreshLogin(),
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
    //
    // 这一层刻意**不建 React 组件树**：整页是「投影 → HTML 字符串」的纯函数，
    // 交互靠根节点上的合成事件委托。理由有三：
    //
    //   1. DSH 设置页宽度有限（约 900px），布局必须能被 CSS 完全控制，
    //      而不是被组件层级和行内样式牵着走；
    //   2. 状态本来就有 `GatewayPanel.projection()` 这一份投影，
    //      视图只需要把它渲染出来，不需要再维护一份 React state；
    //   3. 与原型（`docs/prototype/app.html`）逐块对应，改版时不容易走样。
    //
    // ⚠️ 整块 innerHTML 重建会丢焦点，所以每个可输入元素都带 `data-k`，
    // 重建后按它把焦点和光标位置复原（见 `paint()`）。

    /** 界面本地状态：不进配置、不落盘，切页会重置。 */
    const ui = {
      /** agentId -> true：模型卡片收起 */
      collapsed: {},
      /** 只看免费 */
      freeOnly: false,
      /** 弹框：{ agentId } | null */
      modal: null,
      /** 弹框里用户是否点过「在浏览器打开」 */
      modalOpened: false,
      /** 一次性提示 */
      toast: null,
      toastTimer: null,
    }

    /** 平台顺序（与宿主 registry 一致）。 */
    const PLATFORM_ORDER = ['opencode', 'qoder', 'qoder-cn', 'workbuddy', 'workbuddy-intl']
    /** 平台头像缩写（与原型一致，别再拿 name.slice(0,2) 拼出「OP」这种）。 */
    const AVATAR = {
      opencode: 'OC',
      qoder: 'QD',
      'qoder-cn': 'QC',
      trae: 'TR',
      workbuddy: 'WB',
      'workbuddy-intl': 'WI',
    }
    /** 头像文字：优先用映射，未知平台退回名字前两个字母。 */
    function avatarOf(agent) {
      const mapped = AVATAR[agent?.agentId]
      if (typeof mapped === 'string') return mapped
      return String(agent?.name ?? agent?.agentId ?? '?').slice(0, 2).toUpperCase()
    }

    /** 只有免费层的平台：模型区只列免费、没有账号区。 */
    const FREE_ONLY = { opencode: true }

    /** 最近一次渲染的 { props, state }，事件处理器靠它取数据。 */
    let CURRENT = null
    /** 挂载点。 */
    let ROOT = null
    /** 模型自动加载的去重键。 */
    let lastModelsKey = ''

    // ── 小工具 ──────────────────────────────────────────────────

    const esc = (value) =>
      String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

    const pad2 = (n) => String(n).padStart(2, '0')

    /** 整数：1234 → 1,234。 */
    function intText(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
    }

    /** token 数：1234567 → 1.2M。 */
    function tokenText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}K`
      return String(value)
    }

    /** 毫秒：8400 → 8.4 s。 */
    function msText(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`
    }

    /**
     * 毫秒 → 本地时钟（`HH:MM:SS`）。
     *
     * ⚠️ **必须先判有效数字**。早先只 try/catch，而 `new Date(undefined)` 与
     * `new Date(NaN)` **不抛异常**，它们产出一个 Invalid Date，于是
     * `getHours()` 全返回 NaN —— 界面上就出现了「NaN:NaN:NaN」（用户真机报的）。
     * 任务流水那条尤其容易踩：宿主写进 task-log 的字段叫 `at`，而这里读的是 `ts`，
     * 取到 undefined 就直接画成 NaN。
     * 取不到时间就画「—」，绝不画 NaN。
     */
    function clockText(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—'
      const d = new Date(ts)
      if (Number.isNaN(d.getTime())) return '—'
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    }

    function dateTimeText(ts) {
      if (typeof ts !== 'number' || ts <= 0) return '—'
      try {
        const d = new Date(ts)
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
      } catch {
        return '—'
      }
    }

    /** `模型id=长度,模型id=长度` ↔ 对象。宿主只收固定路径的 volatile 字段。 */
    function parseWindowText(text) {
      const out = {}
      for (const part of String(text ?? '').split(',')) {
        const eq = part.indexOf('=')
        if (eq <= 0) continue
        const id = part.slice(0, eq).trim()
        const value = Number(part.slice(eq + 1))
        if (id === '' || !Number.isFinite(value) || value <= 0) continue
        out[id] = Math.floor(value)
      }
      return out
    }

    function serializeWindowText(map) {
      // 按 id 排序：同样的覆盖集合永远序列化成同一个字符串，
      // 配置 diff 才不会因为「先改哪个」而抖动。
      return Object.entries(map ?? {})
        .filter(([, v]) => Number.isFinite(v) && v > 0)
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
        .map(([id, v]) => `${id}=${v}`)
        .join(',')
    }

    /** 倍率 → 标签文字（免费 / ×1.8 / 未知倍率）。 */
    const multText = (model) => multiplierTag(model.multiplier, model.free)

    /** 宿主「已是最新」那句话的形态（`describeUpdate()` 的成功分支，见 `src/core/updater.ts:240`）。 */
    const UP_TO_DATE_TEXT = /已是最新/

    /**
     * 版本更新：把 `updateState{status,data,applying}` 压成一个好用的形状。
     *
     * ## 四态，且**失败优先于「已是最新」**
     *
     * 用户报障：「昨天的版本发布到 git 后，检查更新仍是最新版本」。
     * 直接根因是宿主从来没发过 `available` —— 客户端读 `d.available === true` 恒为 false，
     * 徽标于是永远落在 `update.checked ? '已是最新'` 这一条上。
     *
     * ⚠️ 但**只补上 `available` 还不够**：`behind === 0` 同样证明不了「已是最新」。
     * `checkUpdate()` 在 `git fetch` 失败时返回的正是 `behind: 0` + `error`
     * （`src/core/updater.ts:161-172`，那里的注释也点明界面要显示「能更新，但这次检查失败」）。
     * 于是判断顺序必须是**先判失败、再判最新** —— 反过来就会把一次失败的检查
     * 说成「已是最新」，那正是用户看到的现象。
     *
     * 判据全部取自宿主的**结构化字段**（`status` / `error` / `supported` / `behind`），
     * **不匹配 `message` 的措辞** —— 文案会随措辞变化而失效。唯一的例外是最后那条兜底。
     */
    function updateInfo(state) {
      const u = state.update ?? {}
      const d = u.data ?? {}
      const error = textOf(d.error) || textOf(u.error) || null
      // 回退链：新宿主给 `message`，旧宿主只给 `error`，端点本身失败时有 `u.error`。
      // 少任何一环，用户都会看到一个**没有原因的**界面（原缺陷的 B 面：
      // 「拉取远端失败：…」这类关键信息从来没被渲染过）。
      const message = textOf(d.message) || error
      // `behind` 是既有字段，所以**旧宿主**（没有 `available`）也能正确显示
      // 「可更新到 X」，而不是因为缺字段就一律报「最新」。
      const behind = typeof d.behind === 'number' && d.behind > 0 ? d.behind : 0
      const ready = u.status === 'ready'
      const transportError = u.status === 'error'
      const available = ready && (d.available === true || behind > 0)
      const failed =
        transportError ||
        (ready &&
          !available &&
          (d.supported === false ||
            error !== null ||
            // 兜底：有 `message` 却没有 `error` 的宿主。此时**没有任何证据**支持
            // 「已是最新」，所以宁可把宿主原话显示出来，也不报一个假的「最新」。
            (message !== null && !UP_TO_DATE_TEXT.test(message))))
      return {
        supported: d.supported !== false,
        current: textOf(d.current),
        latest: textOf(d.latest),
        available,
        checked: ready,
        failed,
        busy: u.status === 'loading' || u.applying === true,
        message,
      }
    }

    /**
     * 更新状态 → 徽标（**四态，失败优先**）。
     *
     * 顺序不能调换：`available` 是「确实有新版本」的正面证据，先判它；
     * 然后**必须**判 `failed` —— 一旦把这条放到 `checked` 后面，一次失败的检查
     * 就会被说成「已是最新」，也就是本缺陷本身。
     */
    function updateBadge(info) {
      if (info.busy && !info.checked) return { label: '检查中…', tone: 'idle' }
      if (info.available) return { label: info.latest ? `可更新到 ${info.latest}` : '有新版本', tone: 'warn' }
      if (info.failed) return { label: '检查失败', tone: 'err' }
      if (info.checked) return { label: '已是最新', tone: 'ok' }
      return { label: '未检查', tone: 'idle' }
    }

    /** 厂商排序：拉丁字母在前（A→Z），中文按拼音在后。 */
    function vendorCompare(a, b) {
      const latin = /^[\x20-\x7e]/
      const la = latin.test(a)
      const lb = latin.test(b)
      if (la !== lb) return la ? -1 : 1
      return a.localeCompare(b, la ? 'en' : 'zh-Hans-CN')
    }

    /** 模型表排序：免费优先 → 厂商聚簇 → 倍率升序 → 名称。 */
    function sortModels(models) {
      return [...models].sort((a, b) => {
        const fa = a.free === true || a.multiplier === 0 ? 0 : 1
        const fb = b.free === true || b.multiplier === 0 ? 0 : 1
        if (fa !== fb) return fa - fb
        const va = String(a.vendor ?? '')
        const vb = String(b.vendor ?? '')
        if (va !== vb) return vendorCompare(va, vb)
        const ma = Number.isFinite(a.multiplier) ? a.multiplier : Number.MAX_SAFE_INTEGER
        const mb = Number.isFinite(b.multiplier) ? b.multiplier : Number.MAX_SAFE_INTEGER
        if (ma !== mb) return ma - mb
        return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id), 'zh-Hans-CN')
      })
    }

    // ── 小部件 ──────────────────────────────────────────────────

    const badge = (text, tone) => `<span class="mag-badge" data-tone="${tone ?? 'idle'}">${esc(text)}</span>`

    const tag = (text, kind) => `<span class="mag-tag${kind ? ` mag-tag-${kind}` : ''}">${esc(text)}</span>`

    function switchHTML(attrs, checked) {
      return `<button class="mag-switch" role="switch" aria-checked="${checked === true}" ${attrs}></button>`
    }

    function healthBadge(health) {
      const view = healthView(health)
      const tone = view.tone === 'ok' ? 'ok' : view.tone === 'warn' ? 'warn' : view.tone === 'bad' ? 'err' : 'idle'
      return badge(view.text, tone)
    }

    /**
     * 额度那一格：**带 tone 的徽标**，不是一个裸数字。
     *
     * 为什么必须把 tone 画出来：`quotaView` 早就算好了 tone，但这里只取 `.text`，
     * 于是「已用尽（warn）」和「一切正常（ok）」在屏幕上长得**一模一样** ——
     * 用户报的「分不清没拉到 / 真的是 0 / 已用尽」正是这么来的。
     */
    function quotaBadge(account) {
      const view = quotaView(account.quota, account.quota && account.quota.unit)
      const tone = view.tone === 'ok' ? 'ok' : view.tone === 'warn' ? 'warn' : 'idle'
      return badge(view.text, tone)
    }

    /**
     * 额度那一格的悬停说明。
     *
     * 账号行里只能塞下一句话，而「未拉取 / 真的是 0 / 已用尽 / 拉取失败」
     * 需要更多上下文才能分开 —— 全放 title 里，不占行宽。
     */
    function quotaHint(account) {
      return quotaView(account.quota, account.quota && account.quota.unit).hint ?? ''
    }

    // ── 页头 ────────────────────────────────────────────────────

    const PAGES = [
      { id: 'overview', label: '总览' },
      { id: 'accounts', label: '账号' },
      { id: 'tasks', label: '任务' },
      { id: 'logs', label: '日志' },
      { id: 'settings', label: '设置' },
    ]

    function headHTML(state, payload) {
      const page = state.shell.page ?? 'overview'
      const accounts = payload.totals?.accounts ?? 0
      const tabs = PAGES.map((item) => {
        const count = item.id === 'accounts' && accounts > 0 ? `<span class="mag-tab-n">${accounts}</span>` : ''
        return `<button class="mag-tab" role="tab" data-act="page" data-id="${item.id}" aria-selected="${page === item.id}">`
          + `${item.label}${count}</button>`
      }).join('')
      const enabled = payload.enabled !== false
      const update = updateInfo(state)
      return `<div class="mag-head">`
        + `<span class="mag-brand"><span class="mag-dot" data-tone="${enabled ? 'ok' : 'idle'}"></span>Free Token</span>`
        + `<nav class="mag-tabs" role="tablist">${tabs}</nav>`
        + `<span class="mag-spacer"></span>`
        + (update.available
          ? `<button class="mag-btn mag-btn-xs mag-btn-brand" data-act="goto-update">有新版本 ${esc(update.latest)}</button>`
          : '')
        + `<span class="mag-tag mag-tag-strong">${enabled ? '已启用' : '已停用'}</span>`
        + `</div>`
    }

    function noteHTML(state) {
      let html = ''
      if (state.snapshot?.status === 'error' && state.snapshot?.value === null) {
        html += `<p class="mag-alert" data-tone="err">读不到宿主状态：${esc(state.snapshot.error ?? '')}</p>`
      }
      if (state.actionMessage) {
        html += `<p class="mag-alert" data-tone="${state.actionMessage.ok ? 'ok' : 'err'}">${esc(state.actionMessage.text)}</p>`
      }
      if (state.busy) html += `<p class="mag-alert" data-tone="idle">${esc(state.busy)}…</p>`
      return html
    }

    /**
     * 保存条。
     *
     * 模型勾选与上下文长度都是**草稿**：勾半天才点一次保存，一次改动只写一次盘、
     * 只重新发布一次 provider。`shell.dirtyCount` 是本次待提交的字段路径条数。
     */
    function saveBarHTML(state, hint) {
      const dirty = state.shell.dirty === true
      const count = typeof state.shell.dirtyCount === 'number' ? state.shell.dirtyCount : 0
      const saving = state.shell.saving === true
      const left = dirty
        ? `<span class="mag-dot" data-tone="warn"></span><b>${count > 0 ? `${count} 项` : '有'}改动未保存</b>`
          + `<span class="mag-hint">${esc(hint ?? '点「保存并生效」后，对话框的模型下拉才会更新')}</span>`
        : `<span class="mag-ok">✓</span><span class="mag-hint">${state.shell.saved === true ? '已保存' : '没有未保存的改动'}`
          + `${dirty ? '' : ' · 勾选改动需点右侧保存才生效'}</span>`
      return `<div class="mag-save" data-dirty="${dirty}">${left}<span class="mag-spacer"></span>`
        + (dirty ? `<button class="mag-btn mag-btn-sm" data-act="discard"${saving ? ' disabled' : ''}>放弃</button>` : '')
        + `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="save"${dirty && !saving ? '' : ' disabled'}>`
        + `${saving ? '保存中…' : '保存并生效'}</button></div>`
    }

    // ── 总览 ────────────────────────────────────────────────────

    function overviewHTML(state, payload, agents) {
      const summary = state.summary?.status === 'ready' ? state.summary.data ?? {} : null
      const today = summary?.today ?? 0
      const failed = summary?.failed ?? 0
      const total = summary?.total ?? 0
      const failRate = total > 0 ? `${((failed / total) * 100).toFixed(1)}%` : '—'
      // `exposedCount` = 实际会进选择器的数量（宿主按上报策略算好的）；
      // `modelCount` 是上游拉回来多少个 —— 早期两处都读后者，于是「22 个模型进选择器」
      // 而下拉里空空如也。
      const exposed = agents.reduce((n, item) => n + (typeof item.exposedCount === 'number' ? item.exposedCount : 0), 0)
      const last = summary?.last ?? null
      const info = updateInfo(state)
      const update = info.available

      const kpi = (value, label, bad) =>
        `<div class="mag-kpi"${bad ? ' data-tone="err"' : ''}><b>${value}</b><span>${label}</span></div>`

      return (update
        ? `<div class="mag-banner"><span class="mag-dot" data-tone="warn"></span>`
          + `<b>插件有新版本 ${esc(info.latest)}</b>`
          + `<span class="mag-hint">当前 ${esc(info.current)} · 走 git 快进更新，不覆盖本地改动</span>`
          + `<span class="mag-spacer"></span><button class="mag-btn mag-btn-sm" data-act="goto-update">去更新</button></div>`
        : '')
        + `<div class="mag-card">`
        + `<div class="mag-hero"><div><h2>${agents.length} 个平台 · ${payload.totals?.accounts ?? 0} 个账号 · ${exposed} 个模型进选择器</h2>`
        + `<p>免费通道直连；账号平台按额度路由，失败自动降权并在恢复后回归。</p></div>`
        + `<span class="mag-spacer"></span><div class="mag-row">`
        + `<button class="mag-btn mag-btn-sm" data-act="checkin">立即签到</button>`
        + `<button class="mag-btn mag-btn-sm" data-act="refresh-models">拉取模型</button>`
        + `</div></div>`
        + `<div class="mag-kpis">`
        + kpi(exposed, '进选择器的模型')
        + kpi(today, '今日请求')
        + kpi(tokenText(summary?.outputTokens ?? 0), '今日输出 token')
        + kpi(failRate, '失败率', failed > 0)
        + kpi(summary?.avgTtftMs == null ? '—' : `${Math.round(summary.avgTtftMs)} ms`, '平均首字')
        + kpi(summary?.avgTps == null ? '—' : `${Math.round(summary.avgTps)}`, '平均速度')
        + `</div>`
        + (last
          ? `<div class="mag-last"><b>最近一回合</b><b>${esc(last.model ?? '—')}</b>`
            + `<span class="mag-hint">输入 ${tokenText(last.inputTokens ?? 0)} · 输出 ${tokenText(last.outputTokens ?? 0)}`
            + ` · 首字 ${msText(last.ttftMs)} · ${multText(last)}</span>`
            + `<span class="mag-spacer"></span><span class="mag-hint">${clockText(last.ts)}</span></div>`
          : `<p class="mag-hint" style="margin-top:10px">还没有请求记录。发一轮对话后这里会有数据。</p>`)
        + `</div>`

        + `<div class="mag-two">`
        + `<div class="mag-card"><h3>平台健康</h3><p class="mag-hint">每行一个平台；免费平台显示「免账号」。</p>`
        + `<div class="mag-tbl-wrap"><table class="mag-tbl"><thead><tr>`
        + `<th>平台</th><th>通道</th><th class="num">账号</th><th class="num">模型</th><th>状态</th>`
        + `</tr></thead><tbody>`
        + agents.map((item) => {
            const accounts = item.accounts ?? []
            const bad = accounts.filter((a) => a.health && a.health.state !== 'ok').length
            const tone = item.enabled === false ? 'idle'
              : accounts.length === 0 && !FREE_ONLY[item.agentId] ? 'idle'
                : bad > 0 ? 'warn' : 'ok'
            const text = item.enabled === false ? '已停用'
              : accounts.length === 0 && !FREE_ONLY[item.agentId] ? '未配置'
                : bad > 0 ? `${bad} 个降权` : '可用'
            return `<tr><td>${esc(item.name ?? item.agentId)}</td>`
              + `<td>${FREE_ONLY[item.agentId] ? '免账号' : '账号'}</td>`
              + `<td class="num">${FREE_ONLY[item.agentId] ? '—' : accounts.length}</td>`
              + `<td class="num">${typeof item.exposedCount === 'number' ? item.exposedCount : '—'}</td>`
              + `<td>${badge(text, tone)}</td></tr>`
          }).join('')
        + `</tbody></table></div></div>`

        + `<div class="mag-card"><h3>最近失败</h3><p class="mag-hint">失败不吞，原样带原因；悬停看完整报文。</p>`
        + `<div class="mag-tbl-wrap"><table class="mag-tbl"><thead><tr><th>时间</th><th>模型</th><th>原因</th></tr></thead><tbody>`
        + (state.log?.status === 'ready'
          ? (state.log.entries ?? []).filter((e) => e.ok !== true).slice(0, 3).map((e) =>
              `<tr class="failed"><td>${clockText(e.ts)}</td><td>${esc(e.model)}</td>`
              + `<td title="${esc(e.error ?? '')}">${badge('失败', 'err')} ${esc(String(e.error ?? '').slice(0, 28))}</td></tr>`).join('')
            || `<tr><td colspan="3" class="mag-hint">最近没有失败请求。</td></tr>`
          : `<tr><td colspan="3" class="mag-hint">日志还没加载。</td></tr>`)
        + `</tbody></table></div></div>`
        + `</div>`
    }

    // ── 账号 ────────────────────────────────────────────────────

    function platformPills(agents, current) {
      return `<div class="mag-pills" role="tablist">` + agents.map((item) => {
        const accounts = item.accounts ?? []
        const bad = accounts.some((a) => a.health && a.health.state !== 'ok')
        const tone = FREE_ONLY[item.agentId] ? 'ok' : accounts.length === 0 ? 'idle' : bad ? 'warn' : 'ok'
        const count = FREE_ONLY[item.agentId] ? '免账号' : String(accounts.length)
        return `<button class="mag-pill" role="tab" data-act="platform" data-id="${item.agentId}"`
          + ` aria-selected="${current === item.agentId}">`
          + `<span class="mag-dot" data-tone="${tone}"></span>${esc(item.name ?? item.agentId)}`
          + `<span class="mag-tag">${count}</span></button>`
      }).join('') + `</div>`
    }

    function freeChannelCard(agent) {
      return `<div class="mag-card"><div class="mag-acct">`
        + `<span class="mag-avatar">${esc(avatarOf(agent))}</span>`
        + `<div class="mag-who"><b>免账号通道</b><span class="mag-hint">匿名 · 无需凭证 · 免费层</span></div>`
        + `<span class="mag-spacer"></span>`
        + `<div class="mag-meta"><span>免费模型 <b>${typeof agent.modelCount === 'number' ? agent.modelCount : '—'}</b> 个</span>`
        + `<span>健康 ${badge('正常', 'ok')}</span></div>`
        + `<button class="mag-btn mag-btn-sm" data-act="refresh-models">拉取模型</button>`
        + `</div></div>`
    }

    function accountCard(agent) {
      const accounts = agent.accounts ?? []
      const rows = accounts.length === 0
        ? `<div class="mag-acct mag-acct-empty"><p class="mag-hint">还没有账号。登录后在浏览器完成授权，账号与模型会自动出现在这里。</p>`
          + `<button class="mag-btn mag-btn-primary mag-btn-sm" data-act="login" data-id="${agent.agentId}">登录 ${esc(agent.name ?? '')}</button></div>`
        : accounts.map((account, index) => {
            const health = account.health ?? null
            const degraded = health !== null && health.state !== 'ok'
            const toggle = (label, key, on) =>
              `<span class="mag-tog">${label}${switchHTML(`data-act="acc-toggle" data-id="${account.id}" data-key="${key}"`, on === true)}</span>`
            return `<div class="mag-acct"${degraded ? ' data-tone="warn"' : ''}>`
              + `<div class="mag-acct-main">`
              + `<span class="mag-avatar">${esc(avatarOf(agent))}</span>`
              + `<div class="mag-who"><div class="mag-row mag-row-tight">`
              + `<b>${esc(agent.agentId)}-${index + 1}</b><span class="mag-tag">${esc(account.label ?? '')}</span>`
              + healthBadge(health)
              + (account.expiresAt ? `<span class="mag-hint">${account.autoRefresh ? '自动续期' : '到期'} ${dateTimeText(account.expiresAt)}</span>` : '')
              + `</div><div class="mag-meta">`
              + `<span title="${esc(quotaHint(account))}">额度 ${quotaBadge(account)}</span>`
              + `<span>登录态 <b>${account.authKind === 'oauth-device' ? '设备码' : '手动'}</b></span>`
              + (account.loginAccount ? `<span>${esc(account.loginAccount)}</span>` : '')
              + `</div></div></div><span class="mag-spacer"></span>`
              + `<div class="mag-togs">${toggle('对话', 'routeChat', account.routeChat)}`
              + `${toggle('签到', 'autoCheckIn', account.autoCheckIn)}`
              + `${toggle('任务', 'autoTasks', account.autoTasks)}</div>`
              // 单账号刷新：只刷这一个（**不过滤 enabled** —— 用户点名要刷它就该刷）。
              // 与卡片头那个（不带 data-id）区分：这里带 data-id，点谁刷谁。
              + `<button class="mag-btn mag-btn-xs" data-act="quota-refresh" data-id="${account.id}" title="只刷新这个账号的额度">刷新额度</button>`
              + `<button class="mag-btn mag-btn-xs" data-act="acc-test" data-id="${account.id}">测活</button>`
              + (degraded ? `<button class="mag-btn mag-btn-xs" data-act="acc-resume" data-id="${account.id}">恢复</button>` : '')
              + `<button class="mag-btn mag-btn-xs mag-btn-danger" data-act="acc-remove" data-id="${account.id}">退出</button>`
              + `</div>`
          }).join('')

      return `<div class="mag-card"><div class="mag-card-hd"><h3>账号</h3>`
        + `<span class="mag-hint">失败自动降权，恢复后回归；三个开关分别控制对话 / 签到 / 活动任务</span>`
        + `<span class="mag-spacer"></span>`
        // 整平台刷新：**不带 data-id** —— 点击分发靠「有没有 data-id」区分
        // 「刷这个平台全部账号」与「只刷这一个账号」。
        + (accounts.length ? `<button class="mag-btn mag-btn-sm" data-act="quota-refresh" title="刷新本平台全部账号的额度">刷新额度</button>` : '')
        + (accounts.length ? `<button class="mag-btn mag-btn-primary mag-btn-sm" data-act="login" data-id="${agent.agentId}">+ 添加账号</button>` : '')
        + `</div><div class="mag-acct-list">${rows}</div></div>`
    }

    /**
     * 这个平台是否「必须先有账号」才谈得上模型。
     *
     * `FREE_ONLY`（OpenCode）是免账号通道，没账号也照样能用免费模型；
     * 其它平台（Qoder / WorkBuddy / 国际版）的模型目录虽然内置在插件里，
     * 但登录前一个都调不动。
     */
    function needsAccountFor(agent) {
      if (agent === null || agent === undefined) return false
      if (FREE_ONLY[agent.agentId] === true) return false
      return !(Array.isArray(agent.accounts) && agent.accounts.length > 0)
    }

    /** 模型卡片：标题、工具栏、保存条、表格（无厂商分组）。 */
    function modelCard(state, agent) {
      const modelsState = state.models ?? {}
      const policy = state.modelPolicy ?? {}
      const agentId = agent.agentId
      const collapsed = ui.collapsed[agentId] === true
      const loading = modelsState.status === 'loading'
      const items = sortModels(Array.isArray(modelsState.items) ? modelsState.items : [])
      /**
       * 没账号的平台**不拉、不列**模型。
       *
       * 早期这里会对 Qoder / WorkBuddy 列出内置目录（17 / 11 个），倍率全是
       * 「未知倍率」—— 用户的报障原话：「还没登录账号就拉取到了模型，但是倍率
       * 是未知呢？太不友好了」。模型目录是产品级的、登录前就存在，但一个都调不动，
       * 列出来只会让人以为已经能用。
       */
      if (needsAccountFor(agent)) {
        return `<div class="mag-card"><div class="mag-card-hd">`
          + `<h3>模型</h3><span class="mag-tag">未登录</span>`
          + `<span class="mag-spacer"></span>`
          + `<span class="mag-count">登录后自动拉取</span>`
          + `</div>`
          + `<p class="mag-hint">这个平台的模型要登录后才能用，所以先不列出来 —— 免得看到一堆调不动的模型和「未知倍率」。</p>`
          + `<p class="mag-hint">点上面「登录 ${esc(agent.name ?? agentId)}」完成授权；账号一加进来，模型会自动出现，倍率与上下文长度都来自上游目录。</p>`
          + saveBarHTML(state, '如果之前勾过模型，这一页仍然可以保存 / 放弃')
          + `</div>`
      }
      const selected = policy.mode === 'selected'
        ? new Set(Array.isArray(policy.selected) ? policy.selected : [])
        : new Set(Array.isArray(policy.selectedIds) ? policy.selectedIds : [])
      const overrides = policy.windowOverrides ?? {}
      const filter = String(policy.filter ?? '').trim().toLowerCase()
      const shown = items.filter((model) => {
        if (ui.freeOnly && !(model.free === true || model.multiplier === 0)) return false
        if (filter === '') return true
        return `${model.id} ${model.name ?? ''}`.toLowerCase().includes(filter)
      })
      const picked = items.filter((model) => selected.has(model.id)).length
      // 「只看免费」只在**这个平台确实有付费模型**时才有意义。
      // OpenCode 现在只拉免费模型（免费层的用法），所有行都是免费的，
      // 再放一个过滤器只会让人以为「是不是还有没显示出来的」。
      const hasPaid = items.some((model) => !(model.free === true || model.multiplier === 0))
      // 正在探测的模型 id：行内按钮与「状态」列都要跟着变，
      // 否则点完「测一次」十几秒没反馈，用户会以为没生效。
      const probing = new Set(Array.isArray(state.probing) ? state.probing : [])

      const row = (model) => {
        const on = selected.has(model.id)
        const free = model.free === true || model.multiplier === 0
        const override = overrides[model.id]
        const isProbing = probing.has(model.id)
        // 探测结论来自宿主（写进 probes.json 并随 models 端点回来），刷新页面也还在。
        // `unknown` 只表示「没探测过」，不能当成不可用。
        const availability = model.availability ?? 'unknown'
        const probeTone = availability === 'available' ? 'ok'
          : availability === 'region-blocked' ? 'warn'
            : availability === 'unavailable' ? 'err' : 'idle'
        const probeText = availability === 'available'
          ? `可用${typeof model.ttftMs === 'number' ? ` · ${Math.round(model.ttftMs)} ms` : ''}`
          : availability === 'region-blocked' ? '地区受限'
            : availability === 'unavailable' ? '不可用' : '未探测'
        return `<div class="mag-mrow"${on ? '' : ' data-off="1"'}>`
          + `<input class="mag-check" type="checkbox" data-act="toggle-model" data-id="${esc(model.id)}"${on ? ' checked' : ''}>`
          + `<div class="mag-mname"><span class="mag-mn">${esc(model.name ?? model.id)}</span>`
          + `<span class="mag-mid">${esc(model.id)}</span></div>`
          + `<span class="mag-tag${free ? ' mag-tag-strong' : ''}">${esc(multText(model))}</span>`
          + `<div class="mag-ctx"><input class="mag-input mag-input-ctx" data-act="ctx-edit" data-id="${esc(model.id)}" data-k="ctx-${esc(model.id)}"`
          + ` placeholder="${model.contextWindow ? esc(String(model.contextWindow)) : '上游未报'}"`
          + ` value="${override === undefined ? '' : esc(String(override))}"`
          + ` title="留空 = 用上游报的 ${model.contextWindow ? esc(String(model.contextWindow)) : '未知值'}">`
          + `<span class="mag-ctx-hint">${override === undefined ? '上游' : '覆盖'}</span></div>`
          + `<span class="mag-stcell" title="${esc(model.probeDetail ?? '')}">${isProbing ? badge('测试中', 'idle') : badge(probeText, probeTone)}</span>`
          + (isProbing
            ? `<button class="mag-btn mag-btn-xs" disabled>测试中…</button>`
            : `<button class="mag-btn mag-btn-xs" data-act="probe" data-id="${esc(model.id)}"${probing.size > 0 ? ' disabled' : ''}>测一次</button>`)
          + `</div>`
      }

      const body = collapsed ? '' : `<div class="mag-mtoolbar">`
        + `<input class="mag-input mag-input-search" type="search" data-act="model-filter" data-k="model-q"`
        + ` placeholder="搜索模型名或 ID…" value="${esc(policy.filter ?? '')}">`
        + (hasPaid
          ? `<label class="mag-checkrow"><input class="mag-check" type="checkbox" data-act="free-only"${ui.freeOnly ? ' checked' : ''}>只看免费</label>`
          : '')
        + `<span class="mag-spacer"></span>`
        + (probing.size > 0
          ? `<span class="mag-hint">正在测试 ${probing.size} 个模型…（一次真实上游请求，通常几秒到十几秒）</span>`
          : '')
        + `<button class="mag-btn mag-btn-sm" data-act="load-models"${loading ? ' disabled' : ''}>${loading ? '拉取中…' : '拉取模型'}</button>`
        + `</div>`
        + saveBarHTML(state, '勾选与上下文长度是草稿：点保存才写入并刷新下拉（一次改动只发一次请求）')
        + `<div class="mag-mtable">`
        + `<div class="mag-mhead"><span></span><span>模型 / ID</span><span>倍率</span><span>上下文长度</span><span>状态</span><span></span></div>`
        + (loading ? `<div class="mag-mempty">正在向上游拉取模型…</div>`
          : modelsState.status === 'error' ? `<div class="mag-mempty">拉取失败：${esc(modelsState.error ?? '')}</div>`
            : shown.length === 0
              ? `<div class="mag-mempty">${items.length === 0 ? '还没有拉取过模型。点右上角「拉取模型」。' : '没有匹配的模型。'}</div>`
              : shown.map(row).join(''))
        + `</div>`
        + `<p class="mag-hint mag-mfoot">`
        + `默认不向对话框上报任何模型：勾选后点「保存并生效」，选择器里才会出现。`
        + ` 上下文长度留空 = 用上游报的值。`
        + (FREE_ONLY[agentId] ? ' 这个平台只拉免费模型。' : '')
        + `</p>`

      return `<div class="mag-card"><div class="mag-card-hd">`
        + `<button class="mag-btn mag-btn-xs mag-btn-ghost" data-act="collapse" data-id="${agentId}"`
        + ` aria-expanded="${collapsed ? 'false' : 'true'}"`
        + ` aria-label="${collapsed ? '展开模型列表' : '收起模型列表'}"`
        + ` title="${collapsed ? '展开模型列表' : '收起模型列表'}">${collapsed ? '▶' : '▼'}</button>`
        + `<h3>模型</h3>`
        + (collapsed ? ''
          : `<span class="mag-tag">${FREE_ONLY[agentId] ? '只拉免费' : '拉全量'}</span>`
            + `<span class="mag-tag" title="上游返回的 auto 路由聚合模型会被过滤：不进列表、不计入勾选">Auto 已排除</span>`)
        + `<span class="mag-spacer"></span>`
        + (state.shell.dirty === true ? badge('未保存', 'warn') : '')
        + `<span class="mag-count">已勾选 <b>${picked}</b> / 共 <b>${items.length}</b></span>`
        + (collapsed ? `<button class="mag-btn mag-btn-xs" data-act="collapse" data-id="${agentId}">展开</button>` : '')
        + `</div>${body}</div>`
    }

    function accountsHTML(state, payload, agents) {
      const current = currentAgent(state, agents)
      if (current === null) return `<div class="mag-card"><p class="mag-hint">配置里没有任何可见平台。</p></div>`
      loadModelsIfNeeded(state, current)
      return platformPills(agents, current.agentId)
        + (FREE_ONLY[current.agentId] ? freeChannelCard(current) : accountCard(current))
        + modelCard(state, current)
    }

    // ── 任务 ────────────────────────────────────────────────────

    function tasksHTML(state, payload, agent) {
      const fields = state.agentFields ?? []
      // ⚠️ `fieldState` 的形状由控制器决定，**不是** `{value}`：
      //   · bool → `{ checked, changed }`
      //   · 其它 → `{ text, changed }`
      // 早先这里读 `.value`（两种都不是）→ `textOf(undefined) === ''`，于是
      // 两个开关**恒画成关闭**（aria-checked 永远是 false、徽标永远「已关闭」），
      // 四个 kv 也恒显示兜底默认值（签到时间永远「每天一次」、间隔永远 60 分钟），
      // 与真实配置完全不符。用户报的「任务列表下的每日签到和活动任务按钮不生效」
      // 起因就是它：界面画的是一套值，点击按的是另一套值。
      // 口径与 settingsHTML 的 fieldRowHTML() 完全一致，别再各写各的。
      const stateOf = (key) => fields.find((item) => item.field.key === key)?.state
      const onOf = (key) => stateOf(key)?.checked === true
      const valueOf = (key) => textOf(stateOf(key)?.text)
      const checkIn = onOf('checkInEnabled')
      const tasks = onOf('tasksEnabled')
      const jobs = Array.isArray(payload.taskLog) ? payload.taskLog : []
      const kv = (k, v) => `<span class="mag-k">${k}</span><span>${v}</span>`

      return `<div class="mag-two">`
        + `<div class="mag-card"><div class="mag-module-hd"><b>每日签到</b>${badge(checkIn ? '已开启' : '已关闭', checkIn ? 'ok' : 'idle')}`
        + `<span class="mag-spacer"></span>${switchHTML('data-act="field-toggle" data-scope="agent" data-key="checkInEnabled"', checkIn)}</div>`
        + `<p class="mag-hint">与活动任务完全独立的一套开关。</p>`
        + `<div class="mag-kv">`
        + kv('签到时间', esc(valueOf('checkInCron') || '每天一次'))
        + kv('作用范围', '所有开启了「签到」开关的账号')
        + `</div>`
        + `<div class="mag-row" style="margin-top:10px">`
        + `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="checkin">立即签到</button>`
        + `<button class="mag-btn mag-btn-sm mag-btn-ghost" data-act="page" data-id="logs">查看流水</button>`
        + `</div></div>`

        + `<div class="mag-card"><div class="mag-module-hd"><b>活动任务</b>${badge(tasks ? '已开启' : '已关闭', tasks ? 'ok' : 'idle')}`
        + `<span class="mag-spacer"></span>${switchHTML('data-act="field-toggle" data-scope="agent" data-key="tasksEnabled"', tasks)}</div>`
        + `<p class="mag-hint">默认关；上游没有活动任务接口时，打开也不会有收获。</p>`
        + `<div class="mag-kv">`
        + kv('轮询间隔', `${esc(valueOf('tasksInterval') || '60')} 分钟`)
        + kv('并发上限', `${esc(valueOf('tasksConcurrency') || '1')} 个账号`)
        + kv('失败暂停', `连续 ${esc(valueOf('tasksMaxFailures') || '3')} 次`)
        + `</div>`
        + `<div class="mag-row" style="margin-top:10px">`
        + `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="run-tasks">跑一轮任务</button>`
        + `<button class="mag-btn mag-btn-sm mag-btn-ghost" data-act="page" data-id="logs">查看流水</button>`
        + `</div></div></div>`

        + `<div class="mag-card"><div class="mag-card-hd"><h3>任务流水</h3>`
        + `<span class="mag-hint">按时间倒序</span><span class="mag-spacer"></span>`
        + `<button class="mag-btn mag-btn-sm mag-btn-ghost" data-act="tasklog-clear">清空</button></div>`
        + `<div class="mag-tbl-wrap"><table class="mag-tbl"><thead><tr>`
        + `<th>时间</th><th>平台</th><th>账号</th><th>类型</th><th>结果</th><th class="num">耗时</th><th>详情</th>`
        + `</tr></thead><tbody>`
        + (jobs.length === 0
          ? `<tr><td colspan="7" class="mag-hint">还没有任务记录。</td></tr>`
          // ⚠️ 字段名按宿主**真实**写进 task-log 的形状来读（见 `TaskLogRecord`）：
          //   时间 `at`（**不是** `ts`）、详情 `message`（不是 `detail`/`error`）、
          //   外加 `credits`。早先三个都读错，于是时间画成「NaN:NaN:NaN」、
          //   详情永远空白 —— 用户报的就是这个。
          : jobs.map((job) => `<tr><td>${esc(clockText(job.ts ?? job.at))}</td><td>${esc(job.agentName ?? job.agentId ?? '')}</td>`
            + `<td>${esc(job.accountLabel ?? '—')}</td><td>${esc(job.kind ?? '')}</td>`
            + `<td>${badge(job.ok === true ? '成功' : job.skipped === true ? '不支持' : '失败', job.ok === true ? 'ok' : job.skipped === true ? 'idle' : 'err')}</td>`
            + `<td class="num">${msText(job.durationMs)}</td>`
            + `<td class="mag-hint">${esc(job.message ?? job.detail ?? job.error ?? '')}`
            + `${typeof job.credits === 'number' && job.credits > 0 ? ` <b>+${job.credits}</b>` : ''}</td></tr>`).join(''))
        + `</tbody></table></div></div>`
    }

    // ── 日志 ────────────────────────────────────────────────────

    function logsHTML(state, payload) {
      // 账号列显示标签而不是 `acc-xxxx`：日志里只存 id，标签在快照里。
      const labels = new Map()
      for (const agent of payload?.agents ?? []) {
        for (const account of agent.accounts ?? []) labels.set(account.id, account.label ?? account.id)
      }
      const accountText = (id) => (id === null || id === undefined ? '免账号' : labels.get(id) ?? String(id))
      const log = state.log ?? {}
      const entries = Array.isArray(log.entries) ? log.entries : []
      const total = typeof log.total === 'number' ? log.total : 0
      const page = log.page ?? 1
      const pageSize = log.pageSize ?? 20
      const pages = Math.max(1, Math.ceil(total / pageSize))
      return `<div class="mag-card"><div class="mag-card-hd"><h3>请求日志</h3>`
        + `<span class="mag-hint">逐请求明细，失败行标红，原因悬停可见</span><span class="mag-spacer"></span>`
        + `<button class="mag-btn mag-btn-sm" data-act="log-refresh">刷新</button>`
        + `<button class="mag-btn mag-btn-sm mag-btn-ghost" data-act="log-clear">清空</button></div>`
        + `<div class="mag-tbl-wrap"><table class="mag-tbl"><thead><tr>`
        + `<th>时间</th><th>平台</th><th>模型</th><th>账号</th><th>结果</th>`
        + `<th class="num">耗时</th><th class="num">首字</th><th class="num">速度</th>`
        + `<th class="num">输入</th><th class="num">输出</th><th>倍率</th>`
        + `</tr></thead><tbody>`
        + (log.status === 'error'
          ? `<tr><td colspan="11" class="mag-hint">加载失败：${esc(log.error ?? '')}</td></tr>`
          : entries.length === 0
            ? `<tr><td colspan="11" class="mag-hint">${log.status === 'loading' ? '加载中…' : '还没有请求记录。'}</td></tr>`
            : entries.map((entry) => `<tr${entry.ok === true ? '' : ' class="failed"'}>`
              + `<td>${clockText(entry.ts)}</td><td>${esc(entry.agentName ?? entry.agentId ?? '')}</td>`
              // 模型列显示**选择器里那个名字**（`Qwen3.8-Flash`），而不是上游目录 key
              // （`qfmodel`）—— 用户报过「日志里全是 qfmodel，不是真实选中的模型」：
              // 记的是对的，但 key 在界面上不可见，两套词汇对不上就等于看不懂。
              // 把 key 放进 title，排查时仍然拿得到（它才是真正发上游的值）。
              + `<td title="${esc(entry.model ?? '')}">${esc(entry.modelName ?? entry.model ?? '')}</td>`
              + `<td>${esc(accountText(entry.accountId))}</td>`
              + `<td title="${esc(entry.error ?? '')}">${badge(entry.ok === true ? '成功' : '失败', entry.ok === true ? 'ok' : 'err')}</td>`
              + `<td class="num">${msText(entry.durationMs)}</td>`
              + `<td class="num">${entry.ttftMs === undefined ? '—' : msText(entry.ttftMs)}</td>`
              + `<td class="num">${entry.tps === undefined ? '—' : Math.round(entry.tps)}</td>`
              + `<td class="num">${tokenText(entry.inputTokens ?? 0)}</td>`
              + `<td class="num">${tokenText(entry.outputTokens ?? 0)}</td>`
              + `<td>${tag(multiplierTag(entry.multiplier, entry.free))}</td></tr>`).join(''))
        + `</tbody></table></div>`
        + `<div class="mag-row mag-pager"><span class="mag-hint">显示 ${entries.length} / 共 ${total} 条</span>`
        + `<span class="mag-spacer"></span>`
        + `<button class="mag-btn mag-btn-ghost mag-btn-sm" data-act="log-page" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>‹</button>`
        + `<span class="mag-hint">第 ${page} / ${pages} 页</span>`
        + `<button class="mag-btn mag-btn-ghost mag-btn-sm" data-act="log-page" data-page="${page + 1}"${page >= pages ? ' disabled' : ''}>›</button>`
        + `</div></div>`
    }

    // ── 设置 ────────────────────────────────────────────────────

    function fieldRowHTML(scope, field, fieldState, disabled) {
      // ⚠️ `fieldState` 的形状由控制器决定，不是 `{value}`：
      //   · bool → `{ checked, changed }`
      //   · 其它 → `{ text, changed }`
      // 早先这里读 `.value`（两种都不是），于是开关永远渲染成 false、输入框永远空 ——
      // 「设置里所有开关点了都不生效」就是这个 bug。
      const checked = fieldState?.checked === true
      const value = textOf(fieldState?.text)
      const changed = fieldState?.changed === true
      const common = `data-scope="${scope}" data-key="${field.key}"`
      let control = ''
      if (field.kind === 'bool') {
        control = switchHTML(`data-act="field-toggle" ${common}`, checked)
      } else if (field.kind === 'enum') {
        const options = (field.options ?? []).map((option) =>
          `<option value="${esc(option.value)}"${value === option.value ? ' selected' : ''}>${esc(option.label)}</option>`).join('')
        control = `<select class="mag-input" data-act="field-edit" ${common}>${options}</select>`
      } else {
        control = `<input class="mag-input${field.kind === 'number' ? ' mag-input-num' : ''}"`
          + ` data-act="field-edit" ${common} data-k="f-${scope}-${field.key}" value="${esc(value)}"`
          + ` placeholder="${field.kind === 'number' ? '0' : '留空 = 用内置默认'}"${disabled ? ' disabled' : ''}>`
      }
      return `<div class="mag-form-row"><div class="mag-lab">${esc(field.label)}`
        + `${changed ? ' <span class="mag-tag mag-tag-strong" title="还没保存">已改</span>' : ''}`
        + `${field.hint ? `<div class="mag-hint">${esc(field.hint)}</div>` : ''}</div>`
        + `<div class="mag-ctl">${control}</div></div>`
    }

    function settingsHTML(state, payload, agent) {
      const global = state.global ?? []
      const agentFields = state.agentFields ?? []
      const bySection = (section) => agentFields.filter((item) => item.field.section === section)
      const disabled = state.shell.writable !== true
      const update = updateInfo(state)
      const view = updateBadge(update)
      const row = (title, body) => `<div class="mag-form-row"><div class="mag-lab">${title}</div><div class="mag-ctl">${body}</div></div>`

      return `<div class="mag-card"><h3>基础</h3>`
        + global.map((item) => fieldRowHTML('global', item.field, item.state, disabled)).join('')
        + `</div>`

        + `<div class="mag-card"><h3>当前平台 · ${esc(agent?.name ?? '—')}</h3>`
        + `<p class="mag-hint">这一组只作用于上面选中的平台；切平台请在「账号」页切。</p>`
        + bySection('basic').map((item) => fieldRowHTML('agent', item.field, item.state, disabled)).join('')
        + bySection('models').map((item) => fieldRowHTML('agent', item.field, item.state, disabled)).join('')
        + `</div>`

        + `<div class="mag-card"><h3>自动任务</h3>`
        + bySection('schedule').map((item) => fieldRowHTML('agent', item.field, item.state, disabled)).join('')
        + `</div>`

        + `<div class="mag-card"><div class="mag-card-hd"><h3>高级</h3><span class="mag-spacer"></span>`
        + `<button class="mag-btn mag-btn-sm mag-btn-ghost" data-act="advanced">${state.shell.advancedOpen === true ? '收起' : '展开'}</button></div>`
        + `<p class="mag-hint">接口路径是适配器的内置知识，界面上不放；这里只有真正需要改的地址与定时表达式。</p>`
        + (state.shell.advancedOpen === true
          ? bySection('advanced').map((item) => fieldRowHTML('agent', item.field, item.state, disabled)).join('')
          : '')
        + `</div>`

        + `<div class="mag-card" id="mag-update"><h3>版本更新</h3>`
        + row('当前版本', `<span class="mag-mono">${esc(update.current || '—')}</span>`
          + ` ${badge(view.label, view.tone)}`)
        // ⚠️ 这一行是原缺陷的 B 面：`message` 以前**从来没被渲染过**，
          // 于是「拉取远端失败：…」这种唯一能解释问题的信息用户永远看不到，
          // 他只看到一句「已是最新」。tone 跟着四态走，失败时用 err 才不会被当成好消息。
        + (update.message === null
          ? ''
          : row('检查结果', `<span class="mag-hint" data-tone="${view.tone}">${esc(update.message)}</span>`))
        + row('更新方式', `<span class="mag-hint">走 git <span class="mag-mono">pull --ff-only</span> 快进；本地有未提交改动时会拒绝，不覆盖你的东西。更新后需重启宿主。</span>`)
        + row('', `<div class="mag-row">`
          + `<button class="mag-btn mag-btn-sm" data-act="update-check"${update.busy ? ' disabled' : ''}>`
          + `${update.busy ? '检查中…' : '检查更新'}</button>`
          // 「立即更新到 X」只在**确实有新版本**时出现。失败态不给这个按钮 ——
          // 把 pull 按钮摆在一次失败的检查旁边，只会让人以为检查成功了。
          + (update.available
            ? `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="update-apply"${update.busy ? ' disabled' : ''}>立即更新到 ${esc(update.latest || '最新版本')}</button>`
            : '')
          + `</div>`)
        + `</div>`

        + `<div class="mag-card"><h3>关于</h3>`
        + row('交流群', `QQ 群 <b>1105449571</b> <span class="mag-hint">（进群备注「dsh 插件」）</span>`)
        + `</div>`

        + sidebarCardHTML()
    }

    /**
     * 设置页里的「左侧导航栏」卡片。
     *
     * 与「版本更新」「关于」并列 —— 它是插件自己的显示设置，不属于任何 Agent。
     * 三种状态各有各的说法，绝不混为一谈：
     *
     *   a. **宿主没有这个槽位** → 开关画成禁用 + 换一段诚实的说明。画一个点不动的
     *      开关而不解释，用户只会以为插件坏了。
     *   b. **从没回答过** → 开关按当前**实际**显示状态画（没回答过时若侧栏是唯一
     *      入口它就是显示的），并注明这一行是默认加上的、可以关掉。
     *      ⚠️ 这里必须画「实际状态」而不是恒画 `false`：否则用户看到关着的开关、
     *      左边却明明有一行，会以为状态读错了。
     *   c. **回答过** → 开关照用户的选。
     */
    function sidebarCardHTML() {
      const view = sidebarView()
      // 开关画的是**实际**显示状态（`shown()` 是唯一判据），不是「用户上次选了什么」。
      const shown = view.shown
      const attrs = view.supported ? 'data-act="sidebar-toggle"' : 'data-act="sidebar-toggle" disabled'
      const note = !view.supported
        ? `<span class="mag-hint">这个版本的 DSH 还没有左侧导航栏槽位（sidebar.panellist），`
          + `只能在「设置 → 插件」里打开这一页。</span>`
        : (view.chosen ? '' : `<span class="mag-hint">默认加的 —— 关掉它就只在「设置 → 插件」里打开。</span>`)
          + (view.saveError === null
            ? ''
            : `<span class="mag-hint">这次没存住（${esc(view.saveError)}），重开 DSH 后会回到上一次的选择。</span>`)
      return `<div class="mag-card" id="mag-sidebar">`
        + `<h3>左侧导航栏</h3>`
        + `<div class="mag-form-row"><div class="mag-lab">在左侧导航栏显示入口`
        + `<div class="mag-hint">打开后左侧多一行「Free Token」，点它直接进这一页，`
        + `不用再去「设置 → 插件」里找。</div></div>`
        + `<div class="mag-ctl">${switchHTML(attrs, shown)}</div></div>`
        + `<div class="mag-hint">${badge(shown ? '已加入左侧导航栏' : '未加入左侧导航栏', shown ? 'ok' : 'idle')}`
        + `${note}</div>`
        + `</div>`
    }

    // ── 登录弹框 ────────────────────────────────────────────────

    /**
     * 登录弹框。
     *
     * 排版按「一屏一件事」重排（上一版挤成一团，用户报「排版太丑」）：
     * 标题 → 引导语 → 步骤（带连接线）→ 设备码 / 授权链接 → 整行主按钮
     * → 状态卡（带倒计时进度条）→ 页脚动作。
     *
     * 每种状态只画自己那一块，不留占位 —— 空着的行比没有行更难看。
     */
    function loginModalHTML(state, agent) {
      const login = state.login ?? { status: 'idle' }
      const name = agent?.name ?? '平台'
      const status = login.status ?? 'idle'
      const url = login.authUrl ?? login.verificationUrl ?? ''
      const opened = ui.modalOpened === true
      const waiting = status === 'starting' || status === 'waiting'
      const head = `<div class="mag-modal-hd"><span class="mag-dot" data-tone="ok"></span><b>登录 ${esc(name)}</b>`
        + `<span class="mag-tag">${FREE_ONLY[agent?.agentId] ? '免账号' : '账号'}</span>`
        + `<button class="mag-x" data-act="login-close" aria-label="关闭">✕</button></div>`

      /** 剩余有效期（mm:ss），基于绝对到期时刻算，重画不会跳。 */
      const leftText = () => {
        const at = typeof login.expiresAt === 'number' ? login.expiresAt : null
        const total = Math.max(0, Math.round((at === null ? (login.expiresInSec ?? 600) * 1000 : at - Date.now()) / 1000))
        const m = Math.floor(total / 60)
        const s = total % 60
        return { total, text: `${m}:${String(s).padStart(2, '0')}`, percent: Math.max(0, Math.min(100, (total / Math.max(1, login.expiresInSec ?? 600)) * 100)) }
      }

      let body = ''
      let foot = ''
      if (status === 'starting') {
        body = `<div class="mag-modal-bd mag-modal-center"><span class="mag-spin mag-spin-lg"></span>`
          + `<b class="mag-modal-title">正在获取授权链接…</b><p class="mag-modal-lead">向 ${esc(name)} 申请一次登录会话</p></div>`
        foot = `<span class="mag-spacer"></span><button class="mag-btn mag-btn-sm" data-act="login-close">取消</button>`
      } else if (waiting) {
        const left = leftText()
        // 只有设备码形态才有 userCode（OpenCode）；外链登录没有，别画空框。
        const code = typeof login.userCode === 'string' && login.userCode !== ''
          ? `<div class="mag-field"><span class="mag-field-lab">设备码（在授权页里核对）</span>`
            + `<div class="mag-codebox"><span class="mag-code">${esc(login.userCode)}</span>`
            + `<button class="mag-btn mag-btn-xs" data-act="login-copy-code">复制</button></div></div>`
          : ''
        body = `<p class="mag-modal-lead">在浏览器里完成登录。本窗口每 ${login.intervalSec ?? 5} 秒自动检查一次，成功后自动添加账号。</p>`
          + `<div class="mag-steps">`
          + `<div class="mag-step" data-state="${opened ? 'done' : 'on'}"><span class="mag-step-n">${opened ? '✓' : '1'}</span>`
          + `<span class="mag-step-t">在浏览器中打开授权页</span></div>`
          + `<div class="mag-step" data-state="${opened ? 'on' : ''}"><span class="mag-step-n">2</span>`
          + `<span class="mag-step-t">完成登录，回到本窗口</span></div>`
          + `</div>`
          + code
          + `<div class="mag-field"><span class="mag-field-lab">授权链接</span>`
          + `<div class="mag-urlbox"><span class="mag-url" title="${esc(url)}">${esc(url || '（等待上游返回链接）')}</span>`
          + `<button class="mag-btn mag-btn-xs" data-act="login-copy"${url ? '' : ' disabled'}>复制</button></div></div>`
          + `<div class="mag-cta">`
          + `<button class="mag-btn mag-btn-block${opened ? '' : ' mag-btn-primary'}" data-act="login-open"${url ? '' : ' disabled'}>`
          + `${opened ? '重新打开浏览器' : '在浏览器打开'}<span class="mag-ext">↗</span></button>`
          + `<span class="mag-cta-hint">打不开？复制链接到手机或其它浏览器</span></div>`
          + `<div class="mag-status"><div class="mag-status-line">`
          + `<span class="mag-dot${opened ? ' mag-poll' : ''}" data-tone="${opened ? 'brand' : 'idle'}"></span>`
          + `<b>${opened ? '等待授权…' : '等待在浏览器中登录…'}</b><span class="mag-spacer"></span>`
          + `<span class="mag-status-t" data-bind="left">剩余 ${left.text}</span></div>`
          + `<div class="mag-bar"><i data-bind="bar" style="width:${left.percent.toFixed(1)}%"></i></div>`
          + `<div class="mag-status-line mag-status-sub">每 ${login.intervalSec ?? 5} 秒自动检查一次`
          + `${opened ? ' · 浏览器窗口可以关掉了' : ''}</div>`
          + `</div>`
        foot = `<span class="mag-spacer"></span><button class="mag-btn mag-btn-sm" data-act="login-close">取消</button>`
          + `<button class="mag-btn mag-btn-sm mag-btn-brand" data-act="login-refresh">手动刷新状态</button>`
      } else if (status === 'failed') {
        body = `<div class="mag-modal-bd mag-modal-center"><span class="mag-ic" data-tone="err">!</span>`
          + `<b class="mag-modal-title">获取授权链接失败</b>`
          + `<div class="mag-reason">${esc(login.message ?? '上游没有返回原因')}</div>`
          + `<p class="mag-modal-lead">上游暂时不可用，重试即可；不需要重新登录。</p></div>`
        foot = `<span class="mag-spacer"></span><button class="mag-btn mag-btn-sm" data-act="login-close">取消</button>`
          + `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="login-retry">重试</button>`
      } else if (status === 'expired') {
        // 关键分支：授权链接超过有效期（宿主把 `expired` 原样传上来）。
        // 少这一支会被下面的 `else` 当成成功，弹出绿勾「已添加账号」—— 骗人。
        body = `<div class="mag-modal-bd mag-modal-center"><span class="mag-ic" data-tone="warn">!</span>`
          + `<b class="mag-modal-title">授权链接已过期</b>`
          + `<p class="mag-modal-lead">链接有效期 ${Math.round((login.expiresInSec ?? 600) / 60)} 分钟，已经超时。请重新获取一条再登录。</p></div>`
        foot = `<span class="mag-spacer"></span><button class="mag-btn mag-btn-sm" data-act="login-close">取消</button>`
          + `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="login-retry">重新获取链接</button>`
      } else if (status === 'ready') {
        body = `<div class="mag-modal-bd mag-modal-center"><span class="mag-tick">✓</span>`
          + `<b class="mag-modal-title">已添加账号</b>`
          + `<span class="mag-mono mag-hint">${esc(agent?.agentId ?? '')}</span>`
          + `<p class="mag-modal-lead">账号已出现在「账号」页；模型默认已勾选，记得在上方保存。</p></div>`
        foot = `<span class="mag-spacer"></span><button class="mag-btn mag-btn-sm mag-btn-primary" data-act="login-close">完成</button>`
      } else {
        // 兜底：既不是等待也不是已知终态 —— 说清楚，别装作成功。
        body = `<div class="mag-modal-bd mag-modal-center"><span class="mag-ic" data-tone="warn">?</span>`
          + `<b class="mag-modal-title">登录状态未知</b>`
          + `<p class="mag-modal-lead">宿主返回的状态是「${esc(status)}」。可以重试一次；如果反复出现，重启宿主再看。</p></div>`
        foot = `<span class="mag-spacer"></span><button class="mag-btn mag-btn-sm" data-act="login-close">取消</button>`
          + `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="login-retry">重试</button>`
      }
      return `<div class="mag-modal" role="dialog" aria-modal="true">${head}${body}<div class="mag-modal-ft">${foot}</div></div>`
    }

    // ── 左侧导航栏入口 ──────────────────────────────────────────

    /**
     * `main` 槽的 key 与 `sidebar.panellist` 的 id —— **必须是同一个字符串**。
     *
     * 宿主就是靠这个相等的值把两边对上的：侧栏行被点击时它拿行的 `id` 调
     * `layout.selectPanel(id)`，而中间那一栏再按 `activePanelId` 去
     * `main` 槽里找 `key` 相同的 occupant 来渲染
     * （见 `@deepseek-ai/dsh-client-ui-sidebar` 的 `PanelRow`/`syncPanels`
     * 与 `@deepseek-ai/dsh-client-ui-layout` 的 `MainPanel`）。
     * 两边写成不同的字符串，表现就是「侧栏多了一行，点了什么都不发生」——
     * 而且不报任何错。
     */
    const SIDEBAR_PANEL_ID = CONFIG_NS

    /**
     * 选择的落盘位置。
     *
     * 带包名前缀：一台机器上会同时装好几个第三方插件，裸 key（`sidebar-entry`）
     * 早晚会撞，撞了就是两个插件互相改对方的显示状态。
     */
    const SIDEBAR_STORAGE_KEY = `${CONFIG_NS}/sidebar-entry`

    /**
     * 侧栏入口选择的存取。
     *
     * ## 为什么是 localStorage 而不是配置字段
     *
     * DSH 的配置走宿主的 schema + `scope.mutate`，而 `Config` 里能写回的前提是
     * 那一项在**宿主源码**里标了 `.volatile()`。加一个字段就得改宿主源码、
     * 重新构建 `lib/`，本轮的写范围里没有那条路。localStorage 是纯客户端的，
     * 当场就能落地；桌面端只有一个浏览器上下文，够用。
     *
     * ## 这里最要紧的一条：坏数据 ≠「用户选了关」
     *
     * 读不到 / 解析失败 / localStorage 整个不可用 —— 一律当作
     * **「用户从没回答过」**，绝不能当成「选了关」。两者的后果完全不同：
     * 前者还能按默认值把入口显示出来，后者会让入口**永久消失**，
     * 而用户根本不知道自己什么时候关过它（清缓存、换 profile 都会造成）。
     */
    function createSidebarStore(storage) {
      /**
       * 取 localStorage。
       *
       * 三层都可能出问题，所以一层层兜：`typeof` 挡住「没有这个全局」
       * （VM / 测试环境就是）；`try` 挡住「有这个全局，但**读它的那一刻**
       * 就抛」（某些隐私模式 / 被策略拦下的 iframe）。
       */
      const resolve = () => {
        if (storage !== undefined) return storage
        try {
          return typeof localStorage === 'undefined' ? null : localStorage
        } catch {
          return null
        }
      }
      /** 「从没回答过」的统一形状 —— 所有失败路径都收敛到它。 */
      const never = { chosen: false, enabled: false }
      return {
        async read() {
          const box = resolve()
          if (box === null || typeof box.getItem !== 'function') return never
          let raw = null
          try {
            raw = box.getItem(SIDEBAR_STORAGE_KEY)
          } catch {
            return never
          }
          // 没有这一条 = 从没回答过（这是**正常**路径，不是异常）。
          if (typeof raw !== 'string' || raw === '') return never
          let parsed = null
          try {
            parsed = JSON.parse(raw)
          } catch {
            return never
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return never
          // 只认**明确的布尔**：`"true"` / 1 / 缺字段都不算回答过。
          if (typeof parsed.enabled !== 'boolean') return never
          return { chosen: true, enabled: parsed.enabled }
        },
        async write(enabled) {
          const box = resolve()
          if (box === null || typeof box.setItem !== 'function') throw new Error('这个环境没有可用的 localStorage')
          // 值存 JSON 而不是裸 `"true"`：以后要加字段（位置、顺序、图标）时
          // 不用换 key，老记录也还读得出来。
          box.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify({ v: 1, enabled }))
        },
      }
    }

    /**
     * 「先确认槽位存在，再显形」的闸门。语义照抄 dshmarket 的 `createSectionGate`。
     *
     * 为什么不能直接 `ctx.slots.register(...)`：在**不认识**这个槽位的旧宿主上，
     * 直接注册要么静默失效、要么直接抛错拖垮整个客户端条目（表现是整个插件
     * `failed`，连设置页一起消失）。而这个闸门只在 `available()` 之后才注册，
     * 于是「宿主有没有这个槽位」与「用户要不要显示」这两件**互相独立、到达顺序
     * 还不确定**的事，被收敛成一次判定。
     *
     * @param register 真的去注册的那个函数，返回注销器。**必须**只在应当显示时
     *   调用；撤回之后还可能再次调用，所以注销器是必需的、不能省。
     * @param initiallyVisible 还没人给答案时的初始值。
     */
    function createSectionGate(register, initiallyVisible = true) {
      let ready = false
      let wanted = initiallyVisible
      let removed = false
      let dispose = null
      const apply = () => {
        if (!ready) return
        const shouldShow = wanted && !removed
        if (shouldShow && dispose === null) {
          dispose = register()
          return
        }
        if (!shouldShow && dispose !== null) {
          const stop = dispose
          dispose = null
          stop()
        }
      }
      return {
        /** 宿主确认「这个槽位存在」。在这之前一次都不注册。 */
        available: () => {
          ready = true
          apply()
        },
        setVisible: (visible) => {
          wanted = visible
          apply()
        },
        visible: () => dispose !== null,
        /** 永久退休（插件被卸载/移除时）。之后再 `setVisible` 也不会回来。 */
        retire: () => {
          removed = true
          apply()
        },
      }
    }

    /**
     * 侧栏入口的判定核心。语义照抄 dshmarket 的 `createSidebarEntry`，
     * 只把「从服务器读写」换成上面那个 localStorage 存取。
     *
     * ## 为什么要区分「从没回答过」与「选了关」
     *
     * 三态而不是两态：`chosen`（用户表过态没有）与 `enabled`（他要不要）是
     * **两件事**。只存一个布尔的话，「没回答过」与「回答过关」会挤在同一个
     * `false` 上，于是「默认显示」这件事永远做不到 —— 而默认显示恰恰是必要的：
     * 入口是这一页的门，把门藏起来的默认值是危险的。
     *
     * 默认值的口径：**没回答过时，只有当侧栏是唯一入口才显示**。设置页入口
     * 在的时候（`otherSeat()` 为真）不抢那一行 —— 侧栏的全局行是宿主自己的
     * 页面（插件、定时任务），第三方插件不该默认往里挤；这一行是用户**主动**
     * 打开的。设置页入口无论选什么都保留。
     */
    function createSidebarEntry({ gate, store, hasOtherSeat }) {
      const otherSeat = hasOtherSeat ?? (() => true)
      let supported = false
      let enabled = false
      let ready = false
      /** 用户表过态没有。**没有答案不等于「关」**。 */
      let chosen = false
      /** 每次写入自增：慢的初始 `load` 回来时对不上号，就丢掉它的结果。 */
      let epoch = 0
      let saveError = null
      const listeners = new Set()
      const notify = () => {
        for (const listener of listeners) listener()
      }
      /**
       * 「这一行现在显示不显示」的**唯一**出处：用户自己选的算数；没有记录时，
       * 只有当侧栏是唯一入口才显示。
       *
       * ⚠️ 抽成一个函数而不是在三处各写一遍：界面上的开关、顶部那条提示、
       * 点击时该取反成什么，读的必须是同一个判据。各写各的迟早会出现
       * 「开关画着关、左边却有一行」这种自相矛盾的状态。
       */
      const wanted = () => enabled || (!chosen && !otherSeat())
      const decide = () => {
        if (!supported) return
        gate.setVisible(wanted())
        notify()
      }
      const settle = () => {
        if (ready) return
        ready = true
        notify()
      }
      return {
        supported: () => supported,
        enabled: () => enabled,
        chosen: () => chosen,
        ready: () => ready,
        /** 这一行此刻显示没有（界面照它画开关）。 */
        shown: () => wanted(),
        onlyDoor: () => !otherSeat(),
        saveError: () => saveError,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** 宿主确认 `sidebar.panellist` 存在 —— 到这一步才谈得上显不显示。 */
        markSupported: () => {
          supported = true
          gate.available()
          decide()
        },
        /** 别的入口（设置页）到货/变化时重算一次。 */
        refresh: () => {
          decide()
        },
        load: async () => {
          const at = epoch
          try {
            const choice = await store.read()
            // ⚠️ 这一句就是全部的防竞态：用户在读取返回**之前**点过任何一下，
            // `epoch` 就已经变了，于是这次读到的旧值被整个丢掉 ——
            // 否则「用户点了『不用』，紧接着慢吞吞的初始读取把界面又改回显示」
            // 会让用户觉得开关坏了（而它其实忠实地执行了那条**过期**的指令）。
            if (at === epoch) {
              enabled = choice.enabled
              chosen = choice.chosen
              decide()
            }
          } catch {
            // 读失败 = 从没回答过，按默认值走。这里**不**设 chosen。
          } finally {
            settle()
          }
        },
        set: async (next) => {
          const at = ++epoch
          const wanted = next === true
          // 先更新内存态再落盘：localStorage 是同步的，等一个微任务再画会让
          // 开关有肉眼可见的延迟。写入失败也不会把界面退回去 —— 用户看到
          // 「开着」，同时下面用 saveError 如实告诉他这次没存住。
          enabled = wanted
          chosen = true
          saveError = null
          decide()
          try {
            await store.write(wanted)
          } catch (error) {
            saveError = error && error.message ? String(error.message) : String(error)
            notify()
          }
          // 落地时若已被更晚的一次点击顶掉（`at !== epoch`），不再覆盖状态。
          if (at === epoch) decide()
          settle()
          return enabled
        },
      }
    }

    /**
     * 侧栏那一行的图标。
     *
     * 自绘 SVG，**不** require `@deepseek-ai/dsh-client-ui-primitives`：
     * 那个包要写进 `package.json` 的 `dsh.client.inject` 才能 require，而本轮
     * 不许碰 package.json。自绘还有个好处 —— 不依赖宿主的图标集版本。
     *
     * 用 `currentColor`：行的颜色由宿主控制（含选中态），写死颜色在浅色主题
     * 下会看不清。`size` 由宿主给（宽栏 16、窄栏 18），照收不误。
     */
    function SidebarNavIcon(owner) {
      const size = typeof owner?.size === 'number' && owner.size > 0 ? owner.size : 16
      /**
       * 辐条端点。
       *
       * ⚠️ `key` 只能当**第三个实参**传：它是 `jsx(type, props, key)` 的第三个
       * 位置，塞进 props 里 React 会当成普通属性并告警。数组子元素又必须有 key，
       * 所以两个都不能省。
       */
      const dot = (key, cx, cy) => jsx('circle', { cx, cy, r: '1.15', fill: 'currentColor', stroke: 'none' }, key)
      // 子元素走本地那个 `jsxs` 包装（数组放第三个实参 = children，见文件头注释）。
      return jsxs('svg', {
        className: 'mag-navicon',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.2',
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, [
        // 中心节点 + 四条辐条：一个网关，多个 Agent —— 与时钟（定时任务）、
        // 方块（插件）明显不同形，缩到 16px 也还认得出。
        jsx('circle', { cx: '8', cy: '8', r: '2.35' }, 'hub'),
        jsx('path', { d: 'M8 5.65V3.05M8 10.35v2.6M5.65 8h-2.6M10.35 8h2.6' }, 'spokes'),
        dot('n', '8', '1.9'),
        dot('s', '8', '14.1'),
        dot('w', '1.9', '8'),
        dot('e', '14.1', '8'),
      ])
    }

    /**
     * 点侧栏之后右侧显示什么 —— **复用现有面板**，不另写一套 UI。
     *
     * 外面那层 `mag-page` 的用处见它在 CSS 里的注释：`main` 槽落在宿主的
     * centerCol（`display:flex; overflow:hidden`），不自己滚的话长面板会被裁掉。
     *
     * ⚠️ children 写在 props 里，**不能当第三个实参传**。`jsx(type, props, key)`
     * 的第三个位置是 **key**，把子元素放那儿会被整块丢掉、渲染成一个空壳
     * （文件开头那段注释记的就是这个坑）。
     */
    function SidebarPanelView(owner) {
      return jsx('div', { className: 'mag-page', children: jsx(GatewayPanelView, owner ?? {}) })
    }

    /** 当前的侧栏入口控制器（模块级单例，渲染函数直接读它）。 */
    let SIDEBAR_ENTRY = null

    /** 投影给渲染用的一份只读状态。控制器还没建起来时给「什么都不知道」的默认值。 */
    function sidebarView() {
      const entry = SIDEBAR_ENTRY
      if (entry === null) return { supported: false, chosen: false, enabled: false, shown: false, onlyDoor: false, saveError: null }
      return {
        supported: entry.supported(),
        chosen: entry.chosen(),
        enabled: entry.enabled(),
        shown: entry.shown(),
        onlyDoor: entry.onlyDoor(),
        saveError: entry.saveError(),
      }
    }

    /**
     * 面板顶部那条**一次性**提示。
     *
     * 只在「从没回答过」**且「这一行还没显示」**时出现。
     *
     *   - 回答过（哪怕回答的是「不用」）就永久消失 —— 用户已经明确表态的事，
     *     不该每次打开都再问一遍。
     *   - 已经显示出来时也不出现：那一行明明就在左边，还问「要不要加」
     *     是自相矛盾的（在设置页不是入口的宿主上，默认就是显示的）。
     *     那种情况下要关掉它，设置页的卡片里有关闭开关。
     *   - 槽位不支持的宿主上不出现：问一个做不到的问题比不问更糟，
     *     那种情况下设置页卡片会如实说明宿主缺什么。
     */
    function sidebarBannerHTML() {
      const view = sidebarView()
      if (!view.supported || view.chosen || view.shown) return ''
      return `<div class="mag-banner" id="mag-sidebar-banner">`
        + `<span class="mag-dot" data-tone="warn"></span><b>要不要把它放到左侧导航栏？</b>`
        + `<span class="mag-hint">加了之后，左侧导航栏会多一行「Free Token」，点一下直接打开这一页。</span>`
        + `<span class="mag-spacer"></span>`
        + `<button class="mag-btn mag-btn-sm mag-btn-primary" data-act="sidebar-on">添加到侧栏</button>`
        + `<button class="mag-btn mag-btn-sm" data-act="sidebar-off">不用</button>`
        + `</div>`
    }

    // ── 装配与挂载 ──────────────────────────────────────────────

    function toastHTML() {
      return ui.toast ? `<div class="mag-toast">${esc(ui.toast)}</div>` : ''
    }

    function showToast(text) {
      ui.toast = text
      if (ui.toastTimer !== null) clearTimeout(ui.toastTimer)
      ui.toastTimer = setTimeout(() => {
        ui.toast = null
        ui.toastTimer = null
        paint()
      }, 2400)
      paint()
    }

    /**
     * 复制到剪贴板（链接与设备码共用）。
     *
     * `navigator.clipboard` 在非 https / 被策略拦下时会**抛异常或返回 rejected
     * promise**，两条路都要兜住并给出「手动复制」的可见提示 —— 静默失败最糟。
     */
    function copyText(text, okText, failText) {
      if (typeof text !== 'string' || text === '') {
        showToast('没有可复制的内容')
        return
      }
      try {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
          showToast(failText)
          return
        }
        navigator.clipboard.writeText(text).then(
          () => showToast(okText),
          () => showToast(failText),
        )
      } catch {
        showToast(failText)
      }
    }

    /** 当前选中平台。 */
    function currentAgent(state, agents) {
      return agents.find((item) => item.agentId === state.selectedAgent) ?? agents[0] ?? null
    }

    /**
     * 模型列表只在「切了平台 / 还没拉过 / 拉的是别的平台 / 账号数变了」时才自动加载。
     *
     * 没账号的平台**一次都不拉**（`needsAccountFor`）：目录是产品级的，
     * 拉回来也只是让人以为已经能用。登录成功后 `pollLogin()` 会显式拉一次。
     */
    function loadModelsIfNeeded(state, agent) {
      if (agent === null || agent === undefined) return
      if (needsAccountFor(agent)) return
      const agentId = agent.agentId
      const models = state.models ?? {}
      // 账号数进 key：0 → 1（刚登录完）时要重新拉，否则会一直显示登录前的空列表。
      const accountKey = Array.isArray(agent.accounts) ? agent.accounts.length : 0
      const key = `${agentId}:${models.status}:${models.agentId}:${models.items?.length ?? 0}:${accountKey}`
      if (key === lastModelsKey) return
      lastModelsKey = key
      const stale = models.agentId !== agentId
      if (stale && (models.status === 'idle' || models.status === 'ready' || models.status === 'error')) {
        Promise.resolve().then(() => {
          if (CURRENT !== null) CURRENT.props.loadModels(false)
        })
      }
    }

    function bodyHTML(state, payload, agents) {
      const page = state.shell.page ?? 'overview'
      if (page === 'accounts') return accountsHTML(state, payload, agents)
      if (page === 'tasks') return tasksHTML(state, payload, currentAgent(state, agents))
      if (page === 'logs') return logsHTML(state, payload)
      if (page === 'settings') return settingsHTML(state, payload, currentAgent(state, agents))
      return overviewHTML(state, payload, agents)
    }

    /** 整页 HTML。 */
    function panelHTML(state) {
      const payload = state.snapshot?.value ?? {}
      const agents = (payload.agents ?? [])
        .filter((item) => item.visible !== false)
        .sort((a, b) => PLATFORM_ORDER.indexOf(a.agentId) - PLATFORM_ORDER.indexOf(b.agentId))
      // 弹框**不**画在这里：它挂到 `document.body` 上（见 `paintPortal`）。
      // 设置面板的祖先节点常带 `transform` / `overflow`，`position:fixed`
      // 在那种树里会被裁剪或错位 —— 弹框是最关键的交互，不能赌。
      // 「账号」页的保存条长在模型卡片里（原型要求：标题与列表之间）；
      // 其它页的字段改动没有那个位置，所以在页头下面补一条 —— 否则改了设置
      // 找不到保存按钮，只能靠刷新丢掉改动。
      const needsBar = (state.shell.page ?? 'overview') !== 'accounts' && state.shell.dirty === true
      // 面板比第一份快照先挂上：这一瞬间 `value` 还是 null，如果照常渲染正文，
      // 用户会先看到一帧「0 个平台 · 0 个账号」的空页面（闪一下再变）。
      const cold = state.snapshot?.value === null || state.snapshot?.value === undefined
      const body = cold
        ? `<div class="mag-body"><div class="mag-card"><p class="mag-hint">`
          + `${state.snapshot?.status === 'error' ? '读取宿主状态失败，点「刷新」重试。' : '正在读取宿主状态…'}`
          + `</p></div></div>`
        : `<div class="mag-body">${bodyHTML(state, payload, agents)}</div>`
      return headHTML(state, payload)
        + noteHTML(state)
        + sidebarBannerHTML()
        + (needsBar ? saveBarHTML(state) : '')
        + body
        + toastHTML()
    }

    /**
     * 弹框层：一个挂在 `document.body` 上的 div。
     *
     * 为什么不画在面板里：`position:fixed` 遇到带 `transform` / `filter` /
     * `contain` 的祖先会**以那个祖先为参照**，遇到 `overflow` 还会被裁。设置页
     * 恰恰常在这种容器里。挂到 body 上就与面板布局彻底无关，`z-index` 也只需
     * 要压过它自己那一层。
     */
    let PORTAL = null
    /**
     * 弹框倒计时用的秒级计时器。
     *
     * 只更新那**两个节点**（剩余时间与进度条），不整块重画 —— 整块重画会让
     * 「在浏览器打开」按钮每秒钟重建一次，鼠标悬停和焦点都会断。
     */
    let portalTick = null

    function stopPortalTick() {
      if (portalTick !== null) {
        clearInterval(portalTick)
        portalTick = null
      }
    }

    /** 每一秒把剩余时间与进度条往前推一格。 */
    function startPortalTick(state) {
      stopPortalTick()
      const expiresAt = state?.login?.expiresAt
      if (typeof expiresAt !== 'number') return
      const total = Math.max(1, (state.login.expiresInSec ?? 600) * 1000)
      portalTick = setInterval(() => {
        if (PORTAL === null) {
          stopPortalTick()
          return
        }
        const left = Math.max(0, expiresAt - Date.now())
        const label = PORTAL.querySelector('[data-bind="left"]')
        const bar = PORTAL.querySelector('[data-bind="bar"]')
        if (label === null && bar === null) {
          stopPortalTick()
          return
        }
        const seconds = Math.round(left / 1000)
        const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        if (label !== null) label.textContent = `剩余 ${text}`
        if (bar !== null) bar.style.width = `${Math.max(0, Math.min(100, (left / total) * 100)).toFixed(1)}%`
      }, 1000)
    }

    /** 关掉登录弹框（三处共用：✕ / 取消 / Esc / 点空白）。 */
    function closeLoginModal() {
      if (ui.modal === null) return
      ui.modal = null
      ui.modalOpened = false
      stopPortalTick()
      paint()
      if (CURRENT !== null) CURRENT.props.cancelLogin()
    }

    function bindPortal(node) {
      node.addEventListener('click', (event) => {
        // 点遮罩空白处关闭（原型行为）。必须在这里判，不能让通用分发去走
        // `closest('[data-act]')` —— 点在弹框正文上也会冒泡到遮罩，会误关。
        if (event.target && event.target.classList && event.target.classList.contains('mag-overlay')) {
          closeLoginModal()
          return
        }
        onSwitchClick(event)
        onClick(event)
      })
      node.addEventListener('change', onChange)
      node.addEventListener('input', onInput)
    }

    function paintPortal(state) {
      if (typeof document === 'undefined' || document.body === undefined) return
      const open = ui.modal !== null
      if (!open) {
        stopPortalTick()
        if (PORTAL !== null) {
          PORTAL.innerHTML = ''
          PORTAL.style.display = 'none'
        }
        return
      }
      if (PORTAL === null) {
        PORTAL = document.createElement('div')
        PORTAL.className = 'mag-portal'
        bindPortal(PORTAL)
        document.body.appendChild(PORTAL)
      }
      PORTAL.style.display = ''
      const agent = currentAgent(state, visibleAgents(state))
      // 弹框永远居中（见上面 CSS 里的说明：左移那套在真机上像「跑偏了」）。
      const markup = `<div class="mag-overlay">`
        + loginModalHTML(state, agent)
        + `</div>`
      // ⚠️ 只在内容真变了的时候写 innerHTML：等待授权期间每秒都可能因为别的
      // 状态变化触发重画，无条件重写会把按钮的 hover / 焦点打断，点击还会偶发丢失。
      if (PORTAL.__magMarkup !== markup) {
        PORTAL.innerHTML = markup
        PORTAL.__magMarkup = markup
      }
      startPortalTick(state)
    }

    /** 把投影画到根节点上（保留焦点与光标）。 */
    function paint() {
      if (ROOT === null || CURRENT === null) return
      const active = typeof document !== 'undefined' ? document.activeElement : null
      const focusKey = active && active.getAttribute ? active.getAttribute('data-k') : null
      const caret = focusKey !== null && active && typeof active.selectionStart === 'number' ? active.selectionStart : null
      ROOT.innerHTML = panelHTML(CURRENT.state)
      paintPortal(CURRENT.state)
      if (focusKey !== null && focusKey !== undefined) {
        const next = ROOT.querySelector(`[data-k="${focusKey}"]`)
        if (next) {
          next.focus()
          if (caret !== null) {
            try {
              next.setSelectionRange(caret, caret)
            } catch {
              // number input 不支持 setSelectionRange，忽略
            }
          }
        }
      }
    }

    /** 当前可见平台。 */
    function visibleAgents(state) {
      const payload = state.snapshot?.value ?? {}
      return (payload.agents ?? [])
        .filter((item) => item.visible !== false)
        .sort((a, b) => PLATFORM_ORDER.indexOf(a.agentId) - PLATFORM_ORDER.indexOf(b.agentId))
    }

    /** 点击分发。 */
    function onClick(event) {
      const node = event.target.closest ? event.target.closest('[data-act]') : null
      if (node === null || CURRENT === null) return
      if (node.tagName === 'INPUT' || node.tagName === 'SELECT') return
      const { props, state } = CURRENT
      const act = node.getAttribute('data-act')
      const id = node.getAttribute('data-id')
      const agents = visibleAgents(state)
      const agent = currentAgent(state, agents)

      switch (act) {
        case 'page':
          props.setPage(id)
          return
        case 'platform':
          lastModelsKey = ''
          props.selectAgent(id)
          return
        case 'refresh':
          props.refresh()
          return
        case 'save':
          props.save()
          return
        case 'discard':
          props.discard()
          return
        case 'collapse':
          ui.collapsed[id] = ui.collapsed[id] !== true
          paint()
          return
        case 'load-models':
        case 'refresh-models':
          props.loadModels(true)
          return
        case 'probe':
          props.probeModels(agent === null ? id : agent.agentId, [id])
          return
        case 'login':
          ui.modal = { agentId: id ?? (agent === null ? '' : agent.agentId) }
          ui.modalOpened = false
          paint()
          props.startLogin()
          return
        case 'login-close':
          closeLoginModal()
          return
        case 'login-retry':
          ui.modalOpened = false
          paint()
          props.startLogin()
          return
        case 'login-refresh':
          props.refreshLogin()
          return
        case 'login-open': {
          const url = state.login?.authUrl ?? state.login?.verificationUrl ?? ''
          ui.modalOpened = true
          paint()
          try {
            if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener')
          } catch {
            showToast('浏览器拦截了弹窗，请复制链接手动打开')
          }
          return
        }
        case 'login-copy': {
          const url = state.login?.authUrl ?? state.login?.verificationUrl ?? ''
          copyText(url, '链接已复制', '复制被拦下，请选中链接手动复制')
          return
        }
        case 'login-copy-code': {
          copyText(state.login?.userCode ?? '', '设备码已复制', '复制被拦下，请手动抄下设备码')
          return
        }
        case 'acc-toggle': {
          const key = node.getAttribute('data-key')
          const account = (agent?.accounts ?? []).find((item) => item.id === id)
          if (account === undefined) return
          props.run('更新账号', 'updateAccount', { id, [key]: account[key] !== true })
          return
        }
        case 'acc-test':
          props.run('测活', 'testAccount', { id })
          return
        case 'quota-refresh':
          // 两种入口共用一个分支，靠**有没有 data-id** 区分：
          //   · 卡片头「刷新额度」（不带 data-id）→ 刷当前平台全部账号；
          //   · 账号行「刷新额度」（带 data-id）  → 只刷点名的那一个。
          // 账号页的 data-id 就是 account.id，宿主端点也是按 accountId 收的。
          props.run(
            '刷新额度',
            'refreshQuota',
            id ? { accountId: id } : (agent === null ? {} : { agentId: agent.agentId }),
            describeQuotaRefresh,
          )
          return
        case 'acc-remove':
          props.run('退出账号', 'removeAccount', { id })
          return
        case 'acc-resume':
          props.run('恢复账号', 'resumeAccount', { accountId: id })
          return
        case 'checkin':
          props.run('签到', 'checkIn', agent === null ? {} : { agentId: agent.agentId }, describeCheckIn)
          return
        case 'run-tasks':
          props.run('活动任务', 'runTasks', agent === null ? {} : { agentId: agent.agentId })
          return
        case 'tasklog-clear':
          props.run('清空任务流水', 'clearTaskLog', {})
          return
        case 'log-refresh':
          props.loadRequestLog()
          return
        case 'log-clear':
          props.clearRequestLogs()
          return
        case 'log-page': {
          const next = Number(node.getAttribute('data-page'))
          if (Number.isFinite(next) && next > 0) {
            props.setLogPage(next)
            props.loadRequestLog()
          }
          return
        }
        case 'update-check':
          props.checkUpdate()
          return
        case 'update-apply':
          props.applyUpdate()
          return
        case 'goto-update':
          props.setPage('settings')
          if (typeof document !== 'undefined') {
            setTimeout(() => {
              const card = document.getElementById('mag-update')
              if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center' })
            }, 60)
          }
          return
        case 'advanced':
          props.toggleAdvanced()
          return
        // ── 左侧导航栏入口 ──
        //
        // 两个方向（加 / 不加）走同一条路：`setSidebarEntry` 里
        // 「用户点过了」是它自己记的，这里不重复判断。
        // 提示条上的两个按钮与设置页的开关共用这三个分支 ——
        // 用户从哪儿回答都是同一个答案。
        case 'sidebar-toggle':
          if (!sidebarView().supported) return
          props.setSidebarEntry(!sidebarView().shown)
          return
        case 'sidebar-on':
          props.setSidebarEntry(true)
          return
        case 'sidebar-off':
          props.setSidebarEntry(false)
          return
        default:
          return
      }
    }

    /** 开关类：bool 字段在 click 里处理。 */
    function onSwitchClick(event) {
      const node = event.target.closest ? event.target.closest('[data-act="field-toggle"]') : null
      if (node === null || CURRENT === null) return
      const { props, state } = CURRENT
      const scope = node.getAttribute('data-scope')
      const key = node.getAttribute('data-key')
      const list = scope === 'global' ? state.global : state.agentFields
      const hit = (list ?? []).find((item) => item.field.key === key)
      if (hit === undefined) return
      // 取反的依据是**状态里的 checked**，不是 DOM 上的 aria-checked ——
      // 后者一旦和真实值不同（例如渲染时读错了字段），点下去就会「设成同一个值」，
      // 表现为「开关点了没反应」。
      const next = hit.state?.checked !== true
      if (scope === 'global') props.toggleGlobal(hit.field, next)
      else props.toggleAgent(hit.field, next)
    }

    /**
     * 文本类输入（逐字生效）。
     *
     * `input` 和 `change` 都会调到这里 —— 重复调用是**幂等**的（草稿写同一个值，
     * `ops()` 比完就没了）。之所以两边都挂：
     *   - `input` 让打字时逐字生效（和以前 React 的 `onChange` 一样）；
     *   - `change` 补上 `<select>`（下拉只有 change，没有 input 语义）。
     *
     * @returns 是否被本函数处理
     */
    function handleTextEdit(node, props, state) {
      const act = node.getAttribute ? node.getAttribute('data-act') : null
      if (act === 'ctx-edit') {
        props.setModelWindow(node.getAttribute('data-id'), node.value)
        return true
      }
      if (act === 'field-edit') {
        const scope = node.getAttribute('data-scope')
        const key = node.getAttribute('data-key')
        const list = scope === 'global' ? state.global : state.agentFields
        const hit = (list ?? []).find((item) => item.field.key === key)
        if (hit === undefined) return true
        if (scope === 'global') props.editGlobal(hit.field, node.value)
        else props.editAgent(hit.field, node.value)
        return true
      }
      return false
    }

    /** 复选框 / 下拉：勾选、只看免费、配置字段。 */
    function onChange(event) {
      const node = event.target
      if (node === null || CURRENT === null) return
      const { props, state } = CURRENT
      const act = node.getAttribute ? node.getAttribute('data-act') : null
      if (act === 'toggle-model') {
        props.toggleModel(node.getAttribute('data-id'), node.checked === true)
        return
      }
      if (act === 'free-only') {
        ui.freeOnly = node.checked === true
        paint()
        return
      }
      // 输入框失焦时也会走到这里（原生 change），和 input 幂等。
      handleTextEdit(node, props, state)
    }

    /** 文本输入：搜索框 + 上下文长度 + 配置字段（逐字生效）。 */
    function onInput(event) {
      const node = event.target
      if (node === null || CURRENT === null) return
      const { props, state } = CURRENT
      const act = node.getAttribute ? node.getAttribute('data-act') : null
      if (act === 'model-filter') {
        props.setModelFilter(node.value)
        return
      }
      handleTextEdit(node, props, state)
    }

    /**
     * 整页视图。
     *
     * `view === 'summary'` 是 keyed 槽里的一行说明；`view === 'page'` 才是完整面板。
     */
    function GatewayPanelView(props) {
      const { t, view } = props
      const state = props.useGatewayPanel ? props.useGatewayPanel((snapshot) => snapshot) : null
      const host = React.useRef(null)

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
      if (state === null) return jsx('p', { className: 'mag-hint', children: t('unavailable') })

      CURRENT = { props, state }
      React.useEffect(() => {
        ROOT = host.current
        paint()
        // ⚠️ 交互事件必须走**原生监听**，不能挂在 jsx 的 onClick / onChange 上。
        //
        // 面板正文是 `innerHTML` 字符串（`paint()` 直接写 ROOT.innerHTML），
        // 所以事件目标节点**没有 React fiber**。React 会把目标解析成最近的
        // 有 fiber 的祖先 —— 也就是根 div。对 `click` / `input` 这类普通事件
        // 没影响（一般事件插件会把监听派发到根 div 上）；
        // 但 `onChange` 走的是 ChangeEventPlugin，它只在「解析出的目标节点是
        // input / select / textarea」时才派发。目标被解析成 div 之后**一次都不派发**。
        //
        // 实测症状（真机）：模型勾选框点下去什么也没发生 —— 草稿没写入，
        // 保存条永远停在「没有未保存的改动」，用户以为是「勾选后没有保存按钮」。
        // 「只看免费」勾选框、上下文长度输入框同理。
        // 结论：直接监听真 DOM 事件（`change` 会冒泡到根节点）。
        const root = ROOT
        const onRootClick = (event) => {
          onSwitchClick(event)
          onClick(event)
        }
        const listen = (name, handler) => {
          if (root !== null && root !== undefined && typeof root.addEventListener === 'function') {
            root.addEventListener(name, handler)
          }
        }
        const unlisten = (name, handler) => {
          if (root !== null && root !== undefined && typeof root.removeEventListener === 'function') {
            root.removeEventListener(name, handler)
          }
        }
        listen('click', onRootClick)
        listen('change', onChange)
        listen('input', onInput)
        // Esc 关弹框：弹框是 fixed 覆盖层，焦点不一定在它里面，
        // 所以监听挂在 document 上而不是根节点上。
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          closeLoginModal()
        }
        if (typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown)
        return () => {
          unlisten('click', onRootClick)
          unlisten('change', onChange)
          unlisten('input', onInput)
          ROOT = null
          // 倒计时计时器必须一起收掉：设置页会被反复挂载，留着就是后台空转。
          stopPortalTick()
          if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', onKeyDown)
            // 面板卸载时把挂在 body 上的弹框层收掉，否则会留下一层看不见的遮罩
            if (PORTAL !== null && PORTAL.parentNode) PORTAL.parentNode.removeChild(PORTAL)
            PORTAL = null
          }
        }
      })
      // 根 div 上**不挂** onClick / onChange / onInput：见上面 effect 里的说明。
      return jsx('div', { className: 'mag-root', ref: host })
    }
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

      // ── 三处入口，同一个面板 ────────────────────────────────────
      //
      //   ① `plugins.bundle.config`（key = 包名）：**包页上直接渲染**，不用点任何东西。
      //   ② `plugins.row.config`（key = `<包名>#<row id>`）：包页那一行的标题变成可点按钮。
      //   ③ `settings.section`（id = 包名）：**设置页左侧导航独立一页**。
      //
      // ①② 都藏在「设置 → 插件」里，用户得先知道有这个插件才找得到；③ 是一级入口，
      // 与「账号 / 通用 / 模型 / 插件 / Agent 预设」并列（order 40 = 排在内置五页之后）。
      //
      // 三处都由 `whileServed` 包着：宿主不提供这个 namespace 时不留痕迹 ——
      // 面板没有配置来源，注册上去也只会是一页报错。
      const face = () => ({ locale: DICT, inject: () => panel.inject() })

      // ── 左侧导航栏入口（第四个入口）─────────────────────────────
      //
      // 与上面三处并列，但**默认不显示** —— 侧栏那一行是用户主动打开的：
      // 侧栏的全局行本来都是宿主自己的页面（插件、定时任务），第三方插件不该
      // 默认往里挤。设置页那个入口无论选什么都保留。
      //
      // 两个槽位**必须一起注册**（同一个 gate、同一个 id）：
      //   · `main`（keyed，key = SIDEBAR_PANEL_ID）—— 点侧栏后右侧显示什么；
      //   · `sidebar.panellist`（list，id = SIDEBAR_PANEL_ID）—— 左侧那一行。
      // 宿主靠这两个相等的值把「点了哪一行」与「渲染哪个面板」对上
      // （`layout.selectPanel(id)` → `activePanelId` → `main` 槽按 key 取 occupant）。
      // 只注册其中一个的表现：少了 `main` → 点了侧栏什么都不发生（而且
      // `layout.selectPanel` 对未注册的 key **会抛错**，见 layout 的
      // `hasMainPanel` 断言）；少了 `panellist` → 面板永远没入口。
      //
      // `seat.settings`：设置页入口在不在。它决定「没回答过时要不要默认显示
      // 侧栏」—— 设置页能进就不抢那一行。
      const seat = { settings: false }
      const sidebarGate = createSectionGate(() => {
        const offPanel = ctx.slots.register(
          { name: 'main', key: SIDEBAR_PANEL_ID, ...face() },
          SidebarPanelView,
        )
        const offRow = ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: SIDEBAR_PANEL_ID,
            // `order` 20 = 排在宿主自带的「插件」(0) 与「定时任务」(10) **之后**：
            // 第三方插件不该挤到宿主自己的页面前面。
            order: 20,
            // 与别处一样传 thunk，切语言不用重新注册。
            label: () => t('nav'),
            locale: DICT,
          },
          SidebarNavIcon,
        )
        return () => {
          // ⚠️ 这里**不**手动去 `layout.selectPanel(null)`（dshmarket 有一句）。
          // 宿主自己会收拾：ui-layout 用 `ctx.slots.subscribe('main', retainMainPanels)`
          // 订阅本槽，一旦当前 `activePanelId` 不在已注册的 key 里就把它置回
          // `null`（见 `retainMainPanels`）。自己再依赖 `layout` 服务只是多一个
          // 可能不存在的依赖 —— 少一个依赖就少一种装不上的可能。
          if (typeof offRow === 'function') offRow()
          if (typeof offPanel === 'function') offPanel()
        }
      }, false)
      const sidebarEntry = createSidebarEntry({
        gate: sidebarGate,
        store: createSidebarStore(),
        hasOtherSeat: () => seat.settings,
      })
      SIDEBAR_ENTRY = sidebarEntry
      // 选择一变就重画面板（顶部那条一次性提示要消失、设置页开关要跟着动）。
      ctx.effect(
        () => sidebarEntry.subscribe(() => panel.publish()),
        `${CONFIG_NS}: sidebar entry repaint`,
      )
      // 先读用户的旧选择，再等宿主确认槽位 —— 顺序与 dshmarket 一致。
      // 两者谁先到都不影响结果：`decide()` 在 `supported` 之前是空转的。
      void sidebarEntry.load()
      // 宿主真的声明了 `sidebar.panellist` 才会执行到这里。
      // `slots.inject` 的契约是「等这个槽位被声明」（见 runner 的 inject 文档：
      // callback 只在声明提交后运行），所以在没有这个槽位的旧宿主上**一次都不会
      // 执行** —— 这正是我们要的优雅退化：不注册、不抛错，设置页入口照旧。
      ctx.slots.inject('sidebar.panellist', () => {
        sidebarEntry.markSupported()
      })

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
              // `label` 传 thunk：槽位每次投影都重读，切语言不用重新注册。
              //
              // 这一处同时兼「设置页入口在不在」的探测器：能走到 `register`
              // 就说明宿主既提供了 configForms 这个 namespace、也声明了
              // `settings.section`，那设置页就是一条真实可用的入口。
              ctx.slots.inject('settings.section', () => {
                const off = ctx.slots.register(
                  {
                    name: 'settings.section',
                    id: CONFIG_NS,
                    order: 40,
                    label: () => t('nav'),
                    ...face(),
                  },
                  GatewayPanelView,
                )
                seat.settings = true
                sidebarEntry.refresh()
                return off
              }),
            ]
            return () => {
              for (const dispose of disposers) if (typeof dispose === 'function') dispose()
              // namespace 不再被服务 = 设置页入口没了 → 侧栏就成了唯一入口，
              // 默认值要跟着变（这正是「两件事到达顺序不确定」里的一件）。
              seat.settings = false
              sidebarEntry.refresh()
            }
          }),
        `${CONFIG_NS}: settings page panel`,
      )
    }

    exports.apply = apply
    exports.inject = inject
    /**
     * 客户端半的名字。
     *
     * 槽位树（Inspect → client Slots）用它当 `registrant` 标签；不导出就退化成
     * 运行器的默认名（`Kb`），排查「这一格是谁注册的」时看不出来源。
     */
    exports.name = CONFIG_NS
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
    exports.DashboardHTML = panelHTML
    /** 登录弹框：单测直接喂 login 状态就能验五个分支（过期不能画成成功）。 */
    exports.LoginModalHTML = loginModalHTML
    /**
     * 整页视图也导出。
     *
     * 分组渲染（`renderGroup`）与「高级设置」折叠只活在这个函数里，
     * 不渲染一次就拦不住「字段被静默丢掉」这类只在打开设置页时暴露的错。
     */
    exports.GatewayPanelView = GatewayPanelView
    /**
     * 样式表也导出。
     *
     * 给「本地渲染预览」（`scripts/preview.mjs`）用：把同一份 CSS 和同一棵
     * 组件树渲染成 HTML 再截图 —— 样式改动才能被**看见**，而不是靠读代码猜。
     */
    exports.CSS = CSS
    /** 字典也导出（仅给本地渲染预览用，DSH 里走 locale 服务）。 */
    exports.__dictionary = { zh, en }
    exports.keyOf = keyOf
    /**
     * 额度显示的三态判定与「刷新额度」的结果措辞，都**直接导出给测试**。
     *
     * 理由：这两个函数是纯的、且判据全在它们身上（tone / hint / 那句话）。
     * 只断言 HTML 字符串的话，「已用尽 vs 正常」这种 tone 差异很容易假通过
     * （两者文案都是「0 积分」时看不出区别）。导出后测试可以直接钉住判据。
     */
    exports.quotaView = quotaView
    exports.describeQuotaRefresh = describeQuotaRefresh
    /**
     * 签到结果措辞也导出。
     *
     * 它早就写好了，但因为 `inject().run` 吞掉了 describe 参数而**从未生效** ——
     * 导出是为了给「describe 真的被转发」补一条回归用例。
     */
    exports.describeCheckIn = describeCheckIn
    exports.AGENTS = AGENTS
    exports.multiplierTag = multiplierTag
    exports.modelLabel = modelLabel
    exports.remoteDescriptors = remoteDescriptors
    exports.remoteContribution = remoteContribution
    /**
     * 左侧导航栏入口这几件也导出给测试。
     *
     * 理由：这一块最要紧的两条语义（**「从没回答过」不等于「选了关」**、
     * 以及**慢的初始 load 不得覆盖用户随后的选择**）全是纯逻辑，但它们的
     * 表现又只在「异步到达顺序」里才露出来。只断言渲染结果的话，把三态压成
     * 两态、把 `epoch` 去掉，用例**照样通过** —— 那两条正是真实缺陷的来源。
     * 所以把闸门、存取、控制器都露出来，让测试能直接驱动它们、把判据钉死。
     */
    exports.SIDEBAR_PANEL_ID = SIDEBAR_PANEL_ID
    exports.SIDEBAR_STORAGE_KEY = SIDEBAR_STORAGE_KEY
    exports.createSidebarStore = createSidebarStore
    exports.createSidebarEntry = createSidebarEntry
    exports.createSectionGate = createSectionGate
    exports.SidebarNavIcon = SidebarNavIcon
    /** 点侧栏后右侧那个视图 —— 测试要能证明它复用的就是 `GatewayPanelView`。 */
    exports.SidebarPanelView = SidebarPanelView
    /** 顶部的「要不要加」一次性提示；直接渲染它就能验「回答过就不再出现」。 */
    exports.sidebarBannerHTML = sidebarBannerHTML
    exports.sidebarCardHTML = sidebarCardHTML
    return module.exports
  },
})
