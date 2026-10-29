/**
 * 插件配置：**schemastery schema（给 DSH 设置页渲染表单）+ 解析器（给运行期用）**。
 *
 * ## 为什么必须有这一份 schema
 *
 * DSH 的 `ctx.settings` 会把**声明了 `Config` 的插件**的配置自动渲染成设置页条目
 * （`status: "schema"`；没有 schema 的条目是 `absent`，页面上根本看不到）。
 * 并且 **只有标了 `.volatile()` 的字段可写** —— 宿主按 `isVolatilePath()` 校验写回路径，
 * 一次 mutate 里有一个非法 op 就**整批拒**（连合法的字段也一起丢）。
 *
 * 所以这里的三条纪律：
 *   1. **每个字段都有 `.default()`** —— 不配置也能跑，这是本项目的一贯前提；
 *   2. **枚举一律 `Schema.union([...])`** —— 渲染成下拉框，比让用户手打字符串可靠；
 *   3. **`.description()` 写人话** —— 它是用户在设置页唯一能看到的解释。
 *
 * ## 与客户端页面的分工
 *
 *   - **这一份**负责「声明式默认值」：每个 Agent 开不开、签到几点跑、任务间隔、路由策略。
 *   - **客户端页面**（`client/client.js`）负责「动态数据」：账号增删改、额度、任务日志。
 *     账号是多条动态记录，塞进 schema 只会做出一个没法用的表单。
 *
 * ## 依赖为什么是 vendored 的（别改回 npm 依赖）
 *
 * `@deepseek-ai/schemastery` 走的是 `vendor/` 里的副本，不是 npm 依赖。
 *
 * 原因：DSH 的**本地目录安装**（`dsh plugin add D:\path\to\plugin`）走的是
 * `pnpm link`，**只建符号链接、不装依赖**；Node 解析时按真实路径找 `node_modules`，
 * 找不到 profile 里那份 hoisted 的 `@deepseek-ai/schemastery`，插件直接
 * `ERR_MODULE_NOT_FOUND` 起不来（issue 见 README 的常见故障表）。
 *
 * vendor 之后宿主半边**零运行时依赖**：解压、指向目录、启用就能跑。
 * 上游更新时：把 `node_modules/@deepseek-ai/schemastery/lib/index.mjs` 覆盖到
 * `vendor/schemastery/index.js`（只改首行 import 为 `../cosmokit/index.js`），
 * cosmokit 同理。
 */

import Schema from '../vendor/schemastery/index.js'
             
                      
                 
                        
                         
                      
           
                        

/** 每个 Agent 都需要一份的上游默认值（未配置时用）。 */
export const AGENT_UPSTREAM_DEFAULTS                                         = {
  opencode: {
    chatBaseUrl: 'https://opencode.ai/inference/openai/v1',
    apiBaseUrl: 'https://opencode.ai/console',
    modelsUrl: 'https://opencode.ai/inference/v1/models',
    pricingUrl: 'https://models.dev/api.json',
    pricingProvider: 'opencode',
  },
  qoder: { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '' },
  'qoder-cn': { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '' },
  trae: { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '' },
  workbuddy: { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '' },
  'workbuddy-intl': { chatBaseUrl: '', apiBaseUrl: '', modelsUrl: '' },
  /**
   * 商汤小浣熊（Raccoon Office）。
   *
   * ⚠️ `chatBaseUrl` 是 **`/api/web/llm/v2`**，不是 `/v1` —— 适配器会自己拼
   * `/chat/completions`。留空也能跑（适配器里有内置兜底），这里写出来是为了
   * 让「高级 → 对话 base url」输入框里能看到真值，用户要改反代时知道改哪个。
   */
  raccoon: {
    chatBaseUrl: 'https://xiaohuanxiong.com/api/web/llm/v2',
    apiBaseUrl: 'https://xiaohuanxiong.com',
    modelsUrl: '',
  },
}

/** 内置 Agent 的显示名（分组标题）。也用于「配置里没写这个 Agent」时补默认项。 */
export const AGENT_DISPLAY_NAMES                         = {
  opencode: 'OpenCode',
  qoder: 'Qoder',
  'qoder-cn': 'Qoder CN',
  trae: 'Trae',
  workbuddy: 'WorkBuddy',
  'workbuddy-intl': 'WorkBuddy International',
  raccoon: '商汤小浣熊',
}

/**
 * 这一期**对外露出**的平台。
 *
 * 七个平台现在**全部真实现**（2026-10-19 Trae 升级、2026-10-27 加入商汤小浣熊），所以全部露出。
 *
 * ⚠️ 这个数组只影响「**默认值**」—— 用户配置里显式写了 `visible` 就以配置为准。
 * 它与 `adapters/index.ts` 的 `AGENT_ORDER`、`client.js` 的 `AGENTS`、
 * `plugin.json` 的 `contributes.llmProviders` 必须保持**同一组 id**：
 * 四份漂移的症状是「设置页有、选择器没有」这类只在界面上看得见的怪事
 * （`test/client.test.mjs` 有断言钉住后三者）。
 */
export const DEFAULT_VISIBLE_AGENTS                    = [
  'opencode',
  'qoder',
  'qoder-cn',
  // ⚠️ `trae` **不在**这里 —— 用户 2026-10-20 明确要求「trae 没有实现，把 trae 直接隐藏掉」。
  //
  // TraeAdapter 本身是能跑的（`IMPLEMENTED_IDS` 里仍然有它），只是**从界面上藏起来**：
  // 本机没有 Trae 账号、签到与模型调用一次真上游都没打过，
  // 露出来只会让用户点到一个没验证过的东西。等真机验证过再把它加回这一行即可。
  //
  // 注意：这只影响**默认值**。用户若在 `cordis.patch.yml` 里显式写了
  // `agents.trae.visible: true`，仍然会显示（`visible` 是 volatile 字段，
  // 显式值优先于这里的默认）—— 那是刻意的，别把显式配置也一起压掉。
  'workbuddy',
  'workbuddy-intl',
  /**
   * 商汤小浣熊。
   *
   * 与 `trae` 相反：这一条是**本机全链路实测过**才加进来的 ——
   * 目录、余额、签到、流式对话（含思维链与工具调用）都真打过真上游，
   * 见 `src/adapters/raccoon.ts` 文件头那张表。所以它**默认可见**。
   */
  'raccoon',
]

/** 一段定时计划的 schema（签到 / 额度共用）。 */
const ScheduleSchema = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('是否开启这项定时任务。关掉之后仍然可以在插件页手动点一次。'),
  cron: Schema.string()
    .default('every:86400')
    .volatile()
    .description(
      '执行时间。三种写法都认：`every:<秒>`（间隔，例如 every:86400 = 每天一次）、' +
        '`分 时 日 月 周`（例如 `30 8 * * *` = 每天 08:30）、`秒 分 时 日 月 周`。',
    ),
  startupDelaySec: Schema.number()
    .default(60)
    .min(0)
    .volatile()
    .description('DSH 启动后延迟多少秒才跑第一次（错峰用，避免所有账号同一秒打上游）。'),
})

/** 活动任务模块的 schema。 */
const TasksSchema = Schema.object({
  enabled: Schema.boolean()
    .default(false)
    .volatile()
    .description(
      '活动任务总开关（与「每日签到」完全独立）。默认关：只有你的上游确实有活动任务接口时才该打开。',
    ),
  intervalMinutes: Schema.number()
    .default(60)
    .min(5)
    .volatile()
    .description('多久跑一轮活动任务（分钟）。太短会触发上游风控，建议不少于 30。'),
  concurrency: Schema.number()
    .default(1)
    .min(1)
    .volatile()
    .description('同时最多有几个账号在跑任务。默认 1（串行），最稳。'),
  maxFailures: Schema.number()
    .default(3)
    .min(1)
    .volatile()
    .description('连续失败多少次后，临时暂停该账号的自动任务并在日志里告警。'),
  retryDelaySec: Schema.number()
    .default(30)
    .min(0)
    .volatile()
    .description('单个任务失败后的重试等待（秒）。0 = 不重试。'),
  kinds: Schema.array(Schema.union(['checkin', 'daily', 'activity']))
    .default([])
    .volatile()
    .description('只跑这些类型的任务；留空 = 全部类型都跑。'),
})

/**
 * 上游地址的 schema。
 *
 * ⚠️ 这里的 `*Path` 字段**不出现在设置页**（`client/client.js` 的 `AGENT_FIELDS`
 * 里没有它们）。原因：每个 Agent 的接口形状是**适配器的内置知识**，让用户手填
 * 只会填错 —— 实机反馈原话是「这些路径用户根本不知道怎么填」。
 *
 * 字段保留在这里是为了两类用法：
 *   1. 适配器把它们当「覆盖值」用（留空 = 用内置默认 / 自动探测）；
 *   2. 高级用户可以在 `cordis.patch.yml` 里写（YAML 不走设置页的 volatile 校验）。
 */
const UpstreamSchema = Schema.object({
  chatBaseUrl: Schema.string()
    .default('')
    .volatile()
    .description('对话请求的 base url（OpenAI 兼容）。留空 = 用该 Agent 的内置官方地址；接自有反代时才需要填。'),
  apiBaseUrl: Schema.string()
    .default('')
    .volatile()
    .description('业务 / 控制台 API 的 base url。留空 = 用该 Agent 的内置官方地址。'),
  modelsUrl: Schema.string().default('').description('模型目录 url。留空 = 用内置官方地址。'),
  pricingUrl: Schema.string().default('').description('价格 / 元数据源 url（倍率从这算）。'),
  pricingProvider: Schema.string().default('').description('价格源里代表本 Agent 的 provider key。'),
  checkInPath: Schema.string()
    .default('')
    .description('【内置，通常不用填】签到接口路径（相对 apiBaseUrl）。留空 = 用适配器内置的默认值 / 自动探测。'),
  quotaPath: Schema.string()
    .default('')
    .description('【内置，通常不用填】额度接口路径（相对 apiBaseUrl）。留空 = 用适配器内置的额度接口。'),
  tasksPath: Schema.string()
    .default('')
    .description('【内置，通常不用填】活动任务列表接口路径。留空 = 用适配器内置的默认值 / 自动探测。'),
  taskClaimPath: Schema.string()
    .default('')
    .description('【内置，通常不用填】领取任务奖励的接口路径，用 `{taskId}` 占位。'),
  taskStatusPath: Schema.string()
    .default('')
    .description('【内置，通常不用填】任务状态查询路径，用 `{taskId}` 占位。留空 = 用「任务还在不在列表里」判断。'),
  freeTierMode: Schema.union(['auto', 'always', 'never'])
    .default('auto')
    .volatile()
    .description(
      '免费层（匿名）客户端指纹：auto = 账号没填 key 时自动启用（默认 —— 免费模型就是这么跑的）；' +
        'always = 一律启用；never = 一律不用。',
    ),
})

/** 倍率与额度单位的 schema。 */
const CreditsSchema = Schema.object({
  unit: Schema.union(['credits', 'usd', 'requests', 'unknown'])
    .default('credits')
    .volatile()
    .description('额度单位：credits = 积分/点数，usd = 美元，requests = 次数。'),
  baselineUsdPerMTok: Schema.number()
    .default(1.2)
    .min(0)
    .volatile()
    .description('倍率基准：多少美元 / 百万 token 算 ×1。默认 1.2（DeepSeek V4.1 Flash 的输出价）。'),
})

/** 重试的 schema。 */
const RetrySchema = Schema.object({
  maxAttempts: Schema.number().default(3).min(1).description('一次请求最多试几个账号。'),
  backoffMs: Schema.number().default(500).min(0).description('重试退避的初始间隔（毫秒）。'),
  maxBackoffMs: Schema.number().default(8000).min(0).description('退避上限（毫秒）。'),
})

/** 单个 Agent 的 schema。 */
/**
 * 「模型选择器里暴露哪些模型」。
 *
 * 两个字段都是**定路径的 volatile**：宿主只接受固定路径的 volatile 字段，
 * 用 `Schema.dict()` 会让整份配置被拒
 * （`$.agents.*.enabled volatile fields require a fixed object path`）。
 * 所以「勾选了哪些」存成**一个字符串**，而不是一张表。
 */
const ModelPolicySchema = Schema.object({
  mode: Schema.union(['free', 'selected', 'all'])
    .default('selected')
    .volatile()
    .description(
      '上报哪些模型给 DSH 模型选择器：' +
        '`selected` = 只报下面勾选的（默认 —— 不勾就不出现，避免选择器被整站模型塞满）；' +
        '`free` = 只报免费模型；`all` = 全部上报。',
    ),
  selected: Schema.string()
    .default('')
    .volatile()
    .description('勾选的模型 id，逗号或换行分隔（`mode: selected` 时生效）。由设置页的勾选列表写入。'),
})

/**
 * 模型上下文长度的覆盖。
 *
 * 为什么需要：DSH 用 `context.contextWindow` 判断**什么时候压缩**。上游给的窗口
 * 可能偏大（或干脆没给）—— 偏大就一直不压缩，最后撞上游硬限制；
 * 偏小又过早压缩。所以留一个用户可改的口子。
 *
 * 两个字段都是**定路径的 volatile**（宿主只认固定路径，`Schema.dict()` 会让整份配置被拒）。
 */
const ContextWindowSchema = Schema.object({
  default: Schema.number()
    .default(0)
    .volatile()
    .description('所有模型的默认上下文长度（token）。0 = 不覆盖，按上游/价格源报的算。'),
  overrides: Schema.string()
    .default('')
    .volatile()
    .description('按模型覆盖，格式 `模型id=长度`，逗号或换行分隔。例：`deepseek-v4.1-flash-free=131072`。'),
})

const AgentSchema = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('是否启用这个 Agent。关掉后：不再路由请求，也不再往模型选择器上报模型。'),
  visible: Schema.boolean()
    .default(true)
    .volatile()
    .description(
      '是否在设置页露出这个平台。与「启用」是两件事：隐藏的平台既不注册 provider，也不进模型选择器。' +
        '这一期只露出 OpenCode / WorkBuddy / WorkBuddy International。',
    ),
  exposeModels: Schema.boolean()
    .default(true)
    .volatile()
    .description('是否把该 Agent 的模型上报给 DSH 模型选择器（对话框里的模型下拉）。'),
  labelWithAgent: Schema.boolean()
    .default(true)
    .volatile()
    .description(
      '模型名是否带 `<Agent> · ` 前缀。默认开，选择器里显示成 `OpenCode · DeepSeek-R1 (×2)`；' +
        '关掉只显示 `DeepSeek-R1 (×2)`（分组标题已经写着 Agent 了）。',
    ),
  models: ModelPolicySchema.description('模型选择器里暴露哪些模型（勾选式）。'),
  contextWindow: ContextWindowSchema.description('模型上下文长度的覆盖（决定 DSH 何时压缩）。'),
  checkIn: ScheduleSchema.description('基础每日签到（与活动任务相互独立）。'),
  quota: ScheduleSchema.description('额度 / 积分的定时拉取。'),
  tasks: TasksSchema.description('活动任务：拉取 → 执行 → 领奖。'),
  upstream: UpstreamSchema.description('上游地址。用反代平台时在这里改。'),
  credits: CreditsSchema.description('额度单位与倍率基准。'),
  requestTimeoutMs: Schema.number().default(120000).min(1000).description('单次上游请求超时（毫秒）。'),
  retry: RetrySchema.description('重试与换号策略。'),
  rateLimitPerMinute: Schema.number()
    .default(60)
    .min(0)
    .description('每个账号每分钟最多几次请求（0 = 不限）。防止触发上游风控。'),
})

/** 网关（路由）的 schema。 */
const GatewaySchema = Schema.object({
  routing: Schema.union(['round-robin', 'quota-first'])
    .default('quota-first')
    .volatile()
    .description(
      '同 Agent 内的多账号路由策略。round-robin = 轮流用；quota-first = 优先用剩余额度高的账号。',
    ),
  degradeAfterFailures: Schema.number().default(2).min(1).description('连续失败几次开始给账号降权。'),
  penaltySec: Schema.number().default(300).min(10).description('降权时长（秒）。到期后自动恢复检测。'),
  recoverIntervalSec: Schema.number().default(600).min(30).description('自动恢复检测的间隔（秒）。'),
  maxAccountAttempts: Schema.number().default(3).min(1).description('一次请求最多换几个账号。'),
  maxConcurrentRequests: Schema.number().default(4).min(1).description('同时进行中的对话请求上限。'),
})

/**
 * 顶层 Config。
 *
 * ⚠️ **`agents` 必须是「固定键」的对象，不能用 `Schema.dict()`。**
 * 宿主对 volatile 字段有硬校验：
 *
 * > volatile fields require a fixed object path without an enclosing volatile field
 *
 * 用 dict 时路径里会出现 `agents.*.enabled` 这样的通配段，宿主**直接拒绝整份配置**
 * （真机上就是 `ValidationError: invalid config: $.agents.*.enabled …`，
 * 插件永远起不来）。所以七个内置 Agent 在这里逐条列出 ——
 * 加一个内置 Agent 时要同时改这里和 `AGENTS`（客户端）与 `builtinAdapters()`。
 *
 * 第三方适配器（运行期注册的）走 `extraAgents`：那是个 `Schema.dict`，
 * **只能通过 `cordis.patch.yml` 写**（不做 volatile，界面不渲染），
 * 但功能上完全等价 —— 因为 YAML 补丁不经过设置页的 volatile 校验。
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description('插件总开关。关掉后：不注册任何 provider，DSH 模型选择器里看不到本插件的分组。'),
  dataDir: Schema.string()
    .default('')
    .description('数据目录（账号密文、状态、任务日志）。留空 = `<DSH_HOME>/multi-agent-gateway`。'),
  verbose: Schema.boolean().default(false).volatile().description('输出调试日志（排查时打开）。'),
  gateway: GatewaySchema.description('多账号路由与并发。'),
  agents: Schema.object({
    opencode: AgentSchema.description('OpenCode'),
    qoder: AgentSchema.description('Qoder'),
    'qoder-cn': AgentSchema.description('Qoder CN'),
    trae: AgentSchema.description('Trae'),
    workbuddy: AgentSchema.description('WorkBuddy'),
    'workbuddy-intl': AgentSchema.description('WorkBuddy International'),
    raccoon: AgentSchema.description('商汤小浣熊'),
  }).description('按 Agent 的配置（固定七个分组，键就是 agentId）。'),
  extraAgents: Schema.dict(Schema.any()).description(
    '第三方适配器的额外配置：键是 agentId，值与该 Agent 的配置同构（只能通过 cordis.patch.yml 写）。',
  ),
})

/** 配置的 TypeScript 形状（`Schema` 的静态类型不好直接取，这里手写一份）。 */
                               
                   
                  
                   
                                          
                                                    
                                            
                                                         
 

/** 把「逗号 / 换行 / 空格分隔」的勾选串解析成 id 列表（去重、去空）。 */
export function parseSelectedModels(text        )           {
  const out           = []
  const seen = new Set        ()
  for (const raw of text.split(/[\s,;]+/)) {
    const id = raw.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * 解析 `模型id=长度` 列表（逗号 / 换行 / 分号分隔）。
 *
 * 非数字、负数、0 一律丢弃 —— 宁可当作没配，也不要塞一个会让 DSH 立刻压缩的 0。
 */
export function parseWindowOverrides(text        )                         {
  const out                         = {}
  for (const chunk of text.split(/[\s,;]+/)) {
    const trimmed = chunk.trim()
    if (trimmed === '') continue
    const at = trimmed.lastIndexOf('=')
    if (at <= 0) continue
    const id = trimmed.slice(0, at).trim()
    const value = Number(trimmed.slice(at + 1).trim())
    if (id === '' || !Number.isFinite(value) || value <= 0) continue
    out[id] = Math.floor(value)
  }
  return out
}

                                   
                   
                   
                        
                          
                                               
                                                          
                                                                          
                                                                        
           
                     
                            
                        
                        
                          
                      
   
                                               
                                                          
                           
                                                                             
                             
 

/** 把任意输入读成字符串（volatile 引用、undefined 都能吃）。 */
function textOf(value         , fallback = '')         {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value !== null && typeof value === 'object' && typeof (value                     ).get === 'function') {
    return textOf((value                          ).get(), fallback)
  }
  return fallback
}

function boolOf(value         , fallback         )          {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== null && typeof value === 'object' && typeof (value                     ).get === 'function') {
    return boolOf((value                          ).get(), fallback)
  }
  return fallback
}

function numOf(value         , fallback        )         {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (value !== null && typeof value === 'object' && typeof (value                     ).get === 'function') {
    return numOf((value                          ).get(), fallback)
  }
  return fallback
}

/** 把 5 段 cron 归一成插件能认的形式；空串回退到默认。 */
function scheduleOf(
  input                                                                              ,
  fallbackCron        ,
)                         {
  return {
    enabled: boolOf(input?.enabled, true),
    cron: textOf(input?.cron, '') || fallbackCron,
    startupDelaySec: Math.max(0, numOf(input?.startupDelaySec, 60)),
  }
}

/** 解析一个 Agent 的配置。 */
export function resolveAgentConfig(
  agentId        ,
  input                              ,
  registryHas         ,
)                      {
  const upstreamDefaults = AGENT_UPSTREAM_DEFAULTS[agentId] ?? {}
  const pick = (key        )         => textOf(input?.upstream?.[key], '') || upstreamDefaults[key] || ''
  const kinds = Array.isArray(input?.tasks?.kinds) ? (input?.tasks?.kinds              ) : []
  const tasks                      = {
    enabled: boolOf(input?.tasks?.enabled, false),
    intervalMinutes: Math.max(5, numOf(input?.tasks?.intervalMinutes, 60)),
    concurrency: Math.max(1, numOf(input?.tasks?.concurrency, 1)),
    maxFailures: Math.max(1, numOf(input?.tasks?.maxFailures, 3)),
    retryDelaySec: Math.max(0, numOf(input?.tasks?.retryDelaySec, 30)),
    kinds,
  }
  const upstream                                  = {
    chatBaseUrl: pick('chatBaseUrl'),
    apiBaseUrl: pick('apiBaseUrl'),
    modelsUrl: pick('modelsUrl'),
  }
  for (const key of ['pricingUrl', 'pricingProvider', 'checkInPath', 'quotaPath', 'tasksPath', 'taskClaimPath', 'taskStatusPath']         ) {
    const value = pick(key)
    if (value !== '') upstream[key] = value
  }
  // 免费层指纹的开关（枚举，单独处理：`pick` 的空串语义对枚举不合适）。
  const freeTierMode = textOf(input?.upstream?.freeTierMode, '')
  if (freeTierMode === 'auto' || freeTierMode === 'always' || freeTierMode === 'never') {
    upstream.freeTierMode = freeTierMode
  }
  const unit = textOf(input?.credits?.unit, 'credits')
  return {
    id: agentId,
    name: AGENT_DISPLAY_NAMES[agentId] ?? agentId,
    // 配置里没写过的 Agent：只有注册表里有实现、且属于这一期露出的平台时才默认可用
    // （骨架默认关，免得用户看到一个永远报「未实现」的分组）。
    enabled: boolOf(input?.enabled, registryHas && DEFAULT_VISIBLE_AGENTS.includes(agentId)),
    visible: boolOf(input?.visible, DEFAULT_VISIBLE_AGENTS.includes(agentId)),
    exposeModels: boolOf(input?.exposeModels, true),
    labelWithAgent: boolOf(input?.labelWithAgent, true),
    models: {
      mode: (['free', 'selected', 'all']         ).includes(
        textOf(input?.models?.mode, '')                               ,
      )
        ? (textOf(input?.models?.mode, '')                               )
        : 'free',
      selected: parseSelectedModels(textOf(input?.models?.selected, '')),
    },
    contextWindow: {
      default: Math.max(0, numOf(input?.contextWindow?.default, 0)),
      overrides: parseWindowOverrides(textOf(input?.contextWindow?.overrides, '')),
    },
    checkIn: scheduleOf(input?.checkIn, 'every:86400'),
    quota: scheduleOf(input?.quota, 'every:1800'),
    tasks,
    upstream,
    credits: {
      unit: (['credits', 'usd', 'requests', 'unknown']         ).includes(unit             )
        ? (unit                                          )
        : 'credits',
      baselineUsdPerMTok: Math.max(0, numOf(input?.credits?.baselineUsdPerMTok, 1.2)),
      round: 2,
    },
    requestTimeoutMs: Math.max(1000, numOf(input?.requestTimeoutMs, 120_000)),
    retry: {
      maxAttempts: Math.max(1, numOf(input?.retry?.maxAttempts, 3)),
      backoffMs: Math.max(0, numOf(input?.retry?.backoffMs, 500)),
      maxBackoffMs: Math.max(0, numOf(input?.retry?.maxBackoffMs, 8000)),
    },
    rateLimitPerMinute: Math.max(0, numOf(input?.rateLimitPerMinute, 60)),
  }
}

/**
 * 把用户配置解析成运行期配置。
 *
 * `knownAgentIds` 是适配器注册表里的 id 全集 —— 配置里没出现过的 Agent 也会
 * 补一份默认配置（这样 UI 上永远能看到全部七个分组，而不是「配了才出现」）。
 */
export function resolveConfig(
  input                          ,
  options                                                     ,
)                 {
  const raw = input ?? {}
  // `agents` 是固定的七项；`extraAgents` 是第三方适配器的补充（YAML 专用）。
  const configured                                            = {
    ...(raw.extraAgents ?? {}),
    ...(raw.agents ?? {}),
  }
  const agents                                      = {}
  const ids = new Set        ([...options.knownAgentIds, ...Object.keys(configured)])
  for (const id of ids) {
    agents[id] = resolveAgentConfig(id, configured[id], options.knownAgentIds.includes(id))
  }
  const gateway                        = {
    routing: raw.gateway?.routing === 'round-robin' ? 'round-robin' : 'quota-first',
    degradeAfterFailures: Math.max(1, numOf(raw.gateway?.degradeAfterFailures, 2)),
    penaltySec: Math.max(10, numOf(raw.gateway?.penaltySec, 300)),
    recoverIntervalSec: Math.max(30, numOf(raw.gateway?.recoverIntervalSec, 600)),
    maxAccountAttempts: Math.max(1, numOf(raw.gateway?.maxAccountAttempts, 3)),
    maxConcurrentRequests: Math.max(1, numOf(raw.gateway?.maxConcurrentRequests, 4)),
  }
  return {
    enabled: boolOf(raw.enabled, true),
    dataDir: textOf(raw.dataDir, '') || options.defaultDataDir,
    verbose: boolOf(raw.verbose, false),
    gateway,
    agents,
  }
}


//# sourceURL=src/config.ts