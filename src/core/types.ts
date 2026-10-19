/**
 * 统一领域模型：账号、额度、模型元数据、活动任务、错误分类。
 *
 * 这一份是**全插件的词汇表**：核心网关层、适配器层、DSH LLM 适配器层、客户端 UI
 * 都只认这里的形状。新增一个 Agent 时**不改这里**，只实现 `AgentAdapter`。
 *
 * 约定：所有类型都是「可结构化克隆的纯数据」——它们会经过 Typert Remote 通道
 * 送到浏览器半边，所以不允许出现 class 实例、函数、Symbol。
 */

// ───────────────────────────── 错误分类 ─────────────────────────────

/**
 * 上游错误的**稳定分类**。核心层只按这个路由，永远不解析错误文案。
 *
 * - `auth`        鉴权失效（401/403）：账号要降权 + 换号
 * - `rate_limit`  限流（429）：账号要短时降权 + 换号，且带 Retry-After
 * - `quota`       额度耗尽：账号要长时降权 + 换号，且不应重试同一个号
 * - `server`      上游 5xx：可重试，账号不降权
 * - `network`     传输层失败（DNS/连接/超时）：可重试，账号不降权
 * - `bad_request` 请求本身有问题（400/422）：**绝不能换号重试**，换号也错
 * - `not_found`   端点不存在（404）：常用于能力探测，不是故障
 * - `unsupported` 上游明确不支持该能力：不是故障，但要在 UI 里说清楚
 * - `unknown`     认不出来：当作可重试，但记一条日志
 */
export type ErrorKind =
  | 'none'
  | 'auth'
  | 'rate_limit'
  | 'quota'
  | 'server'
  | 'network'
  | 'bad_request'
  | 'not_found'
  | 'unsupported'
  | 'unknown'

/** 该错误是否值得**换一个账号**再试一次。 */
export function shouldSwitchAccount(kind: ErrorKind): boolean {
  return kind === 'auth' || kind === 'rate_limit' || kind === 'quota'
}

/** 该错误是否值得**换账号重试之外**的直接重试（同号/同网关层）。 */
export function isRetryable(kind: ErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'server' || kind === 'network' || kind === 'unknown'
}

/** 一次失败的完整描述（日志 / UI / 路由都用它）。 */
export interface FailureInfo {
  kind: ErrorKind
  message: string
  /** HTTP 状态码（如果有）。 */
  status?: number
  /** 上游给的 Retry-After（毫秒）。 */
  retryAfterMs?: number
  /** 上游请求 id，便于对账。 */
  requestId?: string
  at: number
}

// ───────────────────────────── 账号 ─────────────────────────────

/**
 * 凭证。**字段按 Agent 自由扩展**，但核心层只认下面这几个键：
 * 适配器拿到 `AccountRecord` 后自己决定读哪个。
 *
 * `refreshToken` / `expiresAt` 是给 **OAuth 设备码登录**（OpenCode Console）用的：
 * 那条路拿到的不是 API key，而是一个会过期的 access token + 一个 refresh token。
 * 适配器在请求前自动续期，并把新值经 `AdapterContext.onCredentialsRefreshed`
 * 回写落盘（否则重启后还要重新登录）。
 */
export interface AccountCredentials {
  /** bearer token / API key（OpenCode Console 的 API key 形如 `oc_sk_...`）。 */
  token?: string
  /** OAuth refresh token（设备码登录拿到的）。 */
  refreshToken?: string
  /** access token 的绝对过期时间戳（ms）。 */
  expiresAt?: number
  /** 登录到的账号（邮箱，仅用于界面显示）。 */
  account?: string
  /** 登录到的工作区 id（Console 的 `org_id`）。 */
  orgId?: string
  /** 原始 cookie 串（`a=1; b=2`），部分 Agent 只有 cookie 鉴权。 */
  cookie?: string
  /** 额外请求头。 */
  headers?: Record<string, string>
  /** 适配器私有字段。 */
  [key: string]: unknown
}

/** 一个被管理的账号。落盘时 `credentials` 整体加密。 */
export interface AccountRecord {
  /** 稳定 id：`<agentId>:<slug>`，UI/日志/路由都用它。 */
  id: string
  agentId: string
  /** 用户可见标签。 */
  label: string
  /** 明文凭证（**只在内存里**；落盘走 `accounts.enc.json`）。 */
  credentials: AccountCredentials
  /** 是否参与路由。关掉 = 保留但不用。 */
  enabled: boolean
  createdAt: number
  updatedAt: number
  /** 账号级覆盖：自动签到（undefined = 跟随 Agent 配置）。 */
  autoCheckIn?: boolean
  /** 账号级覆盖：自动活动任务（undefined = 跟随 Agent 配置）。 */
  autoTasks?: boolean
  /** 账号级覆盖：参与对话路由（undefined = 跟随 Agent 配置）。 */
  routeChat?: boolean
  note?: string
}

/** 账号健康状态：路由的输入之一。 */
export interface AccountHealth {
  accountId: string
  /** `ok` 正常 / `degraded` 降权中 / `invalid` 已判死。 */
  state: 'ok' | 'degraded' | 'invalid'
  /** 连续失败次数（成功即清零）。 */
  failures: number
  /** 降权截止时间戳（ms）；0 = 没降权。 */
  penaltyUntil: number
  /** 降权倍率惩罚：路由排序用（越大越靠后）。 */
  weight: number
  lastError?: FailureInfo
  lastOkAt?: number
  lastAttemptAt?: number
}

// ───────────────────────────── 额度 ─────────────────────────────

export type QuotaUnit = 'credits' | 'usd' | 'requests' | 'unknown'

/** 一次额度快照。`remaining === undefined` 就代表「未知」。 */
export interface QuotaSnapshot {
  accountId: string
  unit: QuotaUnit
  remaining?: number
  total?: number
  used?: number
  unlimited?: boolean
  /** 上游额外字段（原样保留，UI 可展开看）。 */
  extra?: Record<string, unknown>
  fetchedAt: number
  /** 取不到的原因（不是故障时也给一句人话）。 */
  error?: string
}

// ───────────────────────────── 模型元数据 ─────────────────────────────

/**
 * 一个模型 + 它的归属分组 + 积分倍率。
 *
 * ⚠️ 这是「模型列表管理」的**唯一契约**：适配器的 `getModelMetaList()` 返回它，
 * 核心层把它渲染成 DSH 模型选择器里的分组与行标签。
 */
export interface ModelMeta {
  /** 上游模型 id（直接透传给 completion 请求）。 */
  id: string
  /** 上游给的显示名。 */
  name: string
  /** 归属 Agent（分组键）。 */
  agentId: string
  /** 归属 Agent 的展示名（分组标题）。 */
  agentName: string
  /**
   * 积分消耗倍率。`undefined` = **未知倍率**（UI 显示「未知倍率」）。
   * `0` = 免费。
   */
  multiplier?: number
  /** 倍率的原始来源描述，例如 `models.dev:cost` / `console:config`。 */
  multiplierSource?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ('text' | 'image')[]
  /** 是否支持思维链（thinking / reasoning_content）。 */
  reasoning?: boolean
  /**
   * 该模型**实际声明的思考档位 id**（上游 wire 值，原样）。
   *
   * ## 为什么不能由核心层写死一组档位
   *
   * 各平台的档位 id 既是**上游 wire 值**，又彼此不同名、数量也不同：
   *
   *   | 平台 | 真实 id |
   *   |---|---|
   *   | Trae | `light` / `high` / `extra_high` |
   *   | Cline | `none` / `low` / `medium` / `high` / `max` |
   *   | Raccoon | `on` / `off` |
   *
   * 而走 OpenAI 协议的客户端只有**一套固定的 8 档词汇**
   * （`none minimal low medium high xhigh max ultra`）。两边必然撞车 ——
   * `max` 撞 `xhigh`、`low` 撞 `light`，结果是 **400 + 整轮对话不可用**，
   * 而用户从两端都看不出为什么。
   *
   * 所以：**适配器负责如实报告模型声明了哪些档位**（这个字段），
   * **核心层负责翻译**（`core/reasoning.ts` 的 `canonicalReasoningEffortFor` /
   * `translateReasoningEffort`）。适配器不要去猜规范档位名，核心层也不要去猜
   * 各平台有哪些档位 —— 两侧各猜一半必然漂移。
   *
   * 不填 = 不知道该模型有哪些档位（UI 就不该给它出档位选择器）。
   */
  reasoningEfforts?: string[]
  /**
   * 该模型**自己声明的默认档位**（上游 wire 值，必须落在 {@link reasoningEfforts} 内）。
   *
   * ## 为什么不能由核心层「猜一个中性的」
   *
   * 有的平台在目录里**明确下发了** `is_default`（Qoder 是
   * `thinking_config.enabled.efforts.<key>.is_default`，我们的兜底目录逐条抄了它）。
   * 拿一个启发式（「优先 medium，否则取中间那个」）去覆盖上游的明确声明，
   * 后果是**用户一开口就跑在与官方客户端不同的档位上** ——
   * 实测 `dfmodel` 上游声明 `max`，启发式会挑 `low`，
   * 于是同样的模型在插件里「想得更少」，而用户完全看不出差别在哪。
   *
   * 优先级：**上游声明的默认 > 核心层的启发式**（`defaultReasoningEffortFor`）。
   * 不填 = 上游没声明，交给核心层启发式。
   */
  defaultReasoningEffort?: string
  /** 该模型是否被上游标记为免费。 */
  free?: boolean
  updatedAt?: number
}

/** 倍率的格式化：`×2` / `×1.5` / `免费` / `未知倍率`。 */
export function formatMultiplier(multiplier: number | undefined, free?: boolean): string {
  if (free === true || multiplier === 0) return '免费'
  if (multiplier === undefined || multiplier === null || !Number.isFinite(multiplier)) return '未知倍率'
  const rounded = Math.round(multiplier * 100) / 100
  return `×${rounded}`
}

// ───────────────────────────── 活动任务 ─────────────────────────────

/** 任务类型：基础每日签到与活动任务是**两个独立模块**。 */
export type TaskKind = 'checkin' | 'daily' | 'activity'

/** 一个可参与的任务。 */
export interface TaskRecord {
  /** 上游任务 id。 */
  id: string
  title: string
  description?: string
  kind: TaskKind
  /** 奖励积分；未知则不填。 */
  reward?: number
  /** 执行所需的额外参数（原样回传给 `executeTask`）。 */
  params?: Record<string, unknown>
  /** 上游原文（排查用）。 */
  raw?: unknown
}

/** 任务执行 / 查询的结论。 */
export interface TaskResult {
  taskId: string
  ok: boolean
  /** 本次实际到账的积分（能读到就给）。 */
  credits?: number
  message?: string
  kind?: ErrorKind
  retryable?: boolean
  /** 上游原文。 */
  raw?: unknown
  at: number
}

/**
 * 签到结论。`supported: false` 是**一等公民**：上游没有签到接口时要如实说，不报故障。
 */
export interface CheckInResult {
  ok: boolean
  supported: boolean
  credits?: number
  message?: string
  kind?: ErrorKind
  /**
   * 本次结论是否**覆盖「今天」这一轮**（缺省视为 `true`）。
   *
   * ## 为什么必须有这个字段（真实缺陷，参考实现 2026-10-02 审查定位）
   *
   * 「今天已领」（`ok: true` + 一句「今天已签过了」）**天然有歧义**：它只说明
   * 「服务端现在认为没有可领的了」，而「没有可领的」在某些平台里**不等于**
   * 「今天这一轮已领」。
   *
   * 典型是 Qoder：每日活动**10:00（UTC+8）才刷新**（服务端原文「每日 10:00
   * （UTC+8）刷新，领取后 30 天有效」）。于是上午 9 点那次签到看到的是**昨天**
   * 那条 `CLAIMED`，适配器如实回「今天已领」—— 记账层若拿它当「今天已处理」的
   * 凭证记档，当天 10 点刷新后就**再也不会去领**，于是**每天静默漏掉 100 积分**。
   *
   * ## 判据只能由适配器给
   *
   * 修法**不是**在核心层配一张「各平台刷新时刻表」（那必然漂移），而是让**看得见
   * 该平台刷新语义的那一层**自己回答。所以：
   *
   *   - 绝大多数平台（普通每日签到）**不用填**（缺省 `true`）；
   *   - 观察到的是「刷新前的那一轮」时置 `false` ⇒ {@link "TaskEngine".checkIn}
   *     不会把今天记为已签，当天稍晚会**自动重试**。
   *
   * ⚠️ 不要在核心汇总层用猜测补这个值 —— 那正是本缺陷的成因。
   */
  coversToday?: boolean
  /**
   * 该结果是「**需要用户先去做点什么**」而不是「等一会儿就好」（缺省 `false`）。
   *
   * 用来把两类「现在领不到」区分开：
   *   - `false` —— 「今天活动还没开始」「等刷新」，**等一会儿/重试**即可；
   *   - `true`  —— 「该账号尚未开通每日领取，请先用官方客户端登录一次」，
   *     用户**必须去别处操作**，一直重试也没用。
   *
   * ⚠️ UI 必须判这个**布尔字段**，不要去判 `message` 是否非空、更不要匹配文案内容
   * —— 后者会随措辞变化而失效。带 `actionRequired` 的提示应当**单独、醒目**地展示，
   * 混在计数行里会被读漏。
   */
  actionRequired?: boolean
  at: number
}

// ───────────────────────────── 对话 ─────────────────────────────

/** OpenAI 兼容的 message（本插件对外/对内都用这一套）。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer'
  content?: string | null | Array<Record<string, unknown>>
  name?: string
  tool_call_id?: string
  tool_calls?: unknown[]
  /** 上游回传的思维链，原样保留以便多轮透传。 */
  reasoning_content?: string
  [key: string]: unknown
}

/** 一次 completion 请求（OpenAI 兼容子集 + 常见扩展）。 */
export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[] | string
  tools?: unknown[]
  tool_choice?: unknown
  /** 是否要求上游返回思维链（部分 Agent 用这个开关）。 */
  reasoning?: boolean | string
  [key: string]: unknown
}

/** 归一化后的流事件：网关层只认这几种。 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: string }
  | { type: 'error'; failure: FailureInfo }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 非流式响应（网关内部归一化用，DSH 侧一律走流式）。 */
export interface ChatResponse {
  id?: string
  model: string
  text: string
  reasoning?: string
  toolCalls?: unknown[]
  usage?: TokenUsage
  finishReason?: string
}

// ───────────────────────────── 适配器能力 ─────────────────────────────

/**
 * 适配器自报能力。核心调度器**只按这个表决定挂不挂定时任务**，
 * 避免对着一个没有签到接口的上游每 5 分钟打一次。
 */
export interface AgentCapabilities {
  /** 支持每日签到。 */
  checkIn: boolean
  /** 支持额度/积分查询。 */
  quota: boolean
  /** 支持模型列表（含倍率）。 */
  models: boolean
  /** 支持活动任务（拉取 + 执行 + 查询）。 */
  tasks: boolean
  /** 支持流式 completion。 */
  chat: boolean
  /** 支持思维链透传。 */
  reasoning: boolean
  /** 能力的探测来源：`static` 写死 / `probe` 探测得到 / `config` 配置声明。 */
  source: 'static' | 'probe' | 'config'
  /** 逐项说明（UI 直接显示，回答「为什么这项是灰的」）。 */
  notes?: Record<string, string>
}

// ───────────────────────────── 适配器接口 ─────────────────────────────

/** 适配器运行期依赖（由核心层注入，适配器不自己去 ctx.get）。 */
export interface AdapterContext {
  /** 该 Agent 的**解析后**配置。 */
  config: ResolvedAgentConfig
  /** 带前缀的日志器。 */
  log: Logger
  /** 带超时/重试/错误分类的 fetch。 */
  http: HttpFn
  /** 适配器私有缓存（跨调用存活，落盘）。 */
  cache: AdapterCache
  /** 当前时间戳（测试可注入）。 */
  now(): number
  /**
   * 适配器把**续期后的凭证**回写进账号库（加密落盘）。
   *
   * 用途：OAuth 设备码登录拿到的 access token 有有效期，适配器在请求前发现快过期时
   * 用 refresh token 换一个新的 —— 换到的新值**必须落盘**，否则重启后还得重新登录。
   *
   * 宿主没接这个回调时，适配器只改内存里的记录，不报错。
   */
  onCredentialsRefreshed?(accountId: string, patch: AccountCredentials): void
  /**
   * 出网实现。缺省 = 全局 `fetch`。
   *
   * 为什么单独留一个口子：**流式转发需要拿到原始 `Response`**（要读 `body` 的字节流），
   * 而 `http()` 会把响应体读完再返回。有了这个口子，单测就能塞一个假的流式响应进来，
   * 不必真连网。
   */
  fetch?(url: string, init: RequestInit): Promise<Response>
}

/** 简易 KV 缓存接口（适配器用来缓存模型列表、倍率等）。 */
export interface AdapterCache {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T, ttlMs?: number): void
  delete(key: string): void
  keys(): string[]
}

/** 带错误分类的 HTTP 调用。 */
export interface HttpResult {
  ok: boolean
  status: number
  kind: ErrorKind
  headers: Headers
  body: unknown
  /** 原始文本（解析失败时保留）。 */
  text: string
  requestId?: string
  retryAfterMs?: number
  message?: string
}

export type HttpFn = (
  url: string,
  init?: HttpInit,
) => Promise<HttpResult>

export interface HttpInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 毫秒；缺省用 Agent 配置的 `requestTimeoutMs`。 */
  timeoutMs?: number
  /** 直接拿原始 Response（SSE 用），跳过 json 解析。 */
  raw?: boolean
  signal?: AbortSignal
}

/** 日志器（核心层实现，转 DSH 日志 + 环形缓冲给 UI）。 */
export interface Logger {
  debug(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
  /** 派生一个带子前缀的日志器。 */
  child(scope: string): Logger
}

/**
 * **统一 Agent 适配器接口**。
 *
 * 本期只有 OpenCode 是完整实现；Qoder / Qoder CN / Trae / WorkBuddy / WorkBuddy
 * International 是骨架（每个方法都实现了，但默认返回「不支持」，语义明确、
 * 不静默失败）。新增 Agent 时**不需要改核心调度代码**。
 */
export interface AgentAdapter {
  readonly id: string
  readonly name: string
  /** 静态能力声明（探测结果会覆盖它）。 */
  readonly capabilities: AgentCapabilities

  // ── 账号 ──
  /** 取出实际用于请求的凭证（可做派生，例如 header 拼装）。 */
  getCredentials(record: AccountRecord, ctx: AdapterContext): Promise<AccountCredentials>
  /** 校验凭证是否可用（「测试连接」按钮走这条）。 */
  validateCredentials(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<{ ok: boolean; message?: string; kind?: ErrorKind }>

  // ── 基础每日任务 ──
  /** 每日签到。上游没有这个接口时必须返回 `supported: false`。 */
  checkIn(record: AccountRecord, ctx: AdapterContext): Promise<CheckInResult>
  /** 剩余积分 / 可用额度。 */
  getQuota(record: AccountRecord, ctx: AdapterContext): Promise<QuotaSnapshot>
  /** 模型元数据（含积分倍率）。 */
  getModelMetaList(record: AccountRecord, ctx: AdapterContext): Promise<ModelMeta[]>

  // ── 活动任务 ──
  /** 拉取当前账号可参与的活动任务。 */
  fetchAvailableTasks(record: AccountRecord, ctx: AdapterContext): Promise<TaskRecord[]>
  /** 执行单个任务并领取奖励。 */
  executeTask(task: TaskRecord, record: AccountRecord, ctx: AdapterContext): Promise<TaskResult>
  /** 查询任务状态与积分是否到账。 */
  checkTaskStatus(taskId: string, record: AccountRecord, ctx: AdapterContext): Promise<TaskResult>

  // ── 对话 ──
  /** 转发一次 completion（流式）。 */
  requestChatStream(
    payload: ChatRequest,
    record: AccountRecord,
    ctx: AdapterContext,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>

  /** 把上游响应分类成稳定错误码（路由的唯一依据）。 */
  detectError(status: number, body: unknown, headers: Headers): ErrorKind
}

// ───────────────────────────── 配置（解析后） ─────────────────────────────

export interface ResolvedRetryConfig {
  maxAttempts: number
  backoffMs: number
  maxBackoffMs: number
}

export interface ResolvedScheduleConfig {
  enabled: boolean
  /** 5 段 cron（DSH 定时器可用）或 `every:<秒>`；本插件自己做解析。 */
  cron: string
  /** 首次启动后多久跑（秒），避免全部账号同一秒打上游。 */
  startupDelaySec: number
}

export interface ResolvedTasksConfig {
  enabled: boolean
  intervalMinutes: number
  concurrency: number
  maxFailures: number
  retryDelaySec: number
  /** 只跑这些 kind；空 = 全部。 */
  kinds: TaskKind[]
}

/**
 * 「模型选择器里暴露哪些模型」的策略。
 *
 * `free` 是默认值，因为它就是**免费层的用法**：不加这个过滤，选择器会被
 * 上游几十上百个模型塞满（实测 OpenCode 有 85 个），用户根本找不到免费的那几个。
 */
export interface ModelPolicy {
  mode: 'free' | 'selected' | 'all'
  /** `mode: 'selected'` 时要暴露的模型 id（上游 id，不带 Agent 前缀）。 */
  selected: string[]
}

/**
 * 按策略过滤模型列表（纯函数，可单测）。
 *
 * `free` 只留 `meta.free === true`；`selected` 严格按 id 匹配；
 * `all` 原样返回。列表为空时也如实返回空 —— 让选择器真的空着，
 * 而不是偷偷放开（静默放开比空列表更难排查）。
 */
export function selectExposedModels(list: readonly ModelMeta[], policy: ModelPolicy): ModelMeta[] {
  if (policy.mode === 'all') return [...list]
  if (policy.mode === 'free') return list.filter((meta) => meta.free === true)
  const wanted = new Set(policy.selected)
  return list.filter((meta) => wanted.has(meta.id))
}

/**
 * 按配置覆盖模型的上下文长度（纯函数，可单测）。
 *
 * 为什么需要：DSH 用 `context.contextWindow` 判断**何时压缩**。
 * 上游给的窗口偏大就一直不压缩（最后撞上游硬限制，表现像“压缩坏了”），
 * 偏小又过早压缩。所以让用户能按模型改。
 *
 * 优先级：**按模型覆盖 > 默认值 > 上游报的**。两个都没配时原样返回（不改一个字节）。
 */
export function applyContextWindow(
  list: readonly ModelMeta[],
  policy: { default: number; overrides: Record<string, number> },
): ModelMeta[] {
  const hasDefault = Number.isFinite(policy.default) && policy.default > 0
  const overrideIds = Object.keys(policy.overrides ?? {})
  if (!hasDefault && overrideIds.length === 0) return [...list]
  return list.map((meta) => {
    const override = policy.overrides?.[meta.id]
    const window = typeof override === 'number' && override > 0 ? override : hasDefault ? policy.default : undefined
    return window === undefined ? meta : { ...meta, contextWindow: window }
  })
}

export interface ResolvedAgentConfig {
  id: string
  name: string
  enabled: boolean
  /**
   * 是否在设置页里**露出**这个平台。
   *
   * 与 `enabled` 是两件事：`enabled=false` 是「用户关掉了」，
   * `visible=false` 是「这一期还没做，先别让用户看见」。
   * 隐藏的平台既不注册 provider，也不出现在模型选择器里。
   */
  visible: boolean
  /** 是否把该 Agent 的模型上报给 DSH 模型选择器。 */
  exposeModels: boolean
  /** 模型名是否带 `<Agent> · ` 前缀（任务书要求的 `OpenCode · DeepSeek-R1 (×2)` 形态）。 */
  labelWithAgent: boolean
  /** 模型选择器里暴露哪些模型（勾选式）。 */
  models: ModelPolicy
  /**
   * 模型上下文长度的覆盖。
   *
   * DSH 靠它决定**何时压缩**：报太大就一直不压缩（最后撞上游硬限制），
   * 报太小就过早压缩。`default = 0` 表示不覆盖。
   */
  contextWindow: { default: number; overrides: Record<string, number> }
  /** Agent 级：自动签到。 */
  checkIn: ResolvedScheduleConfig
  /** Agent 级：额度定时拉取。 */
  quota: ResolvedScheduleConfig
  /** Agent 级：活动任务。 */
  tasks: ResolvedTasksConfig
  /** 上游连接。 */
  upstream: {
    /** completion base url，例如 `https://opencode.ai/inference/openai/v1`。 */
    chatBaseUrl: string
    /** 控制台 / 业务 API base url。 */
    apiBaseUrl: string
    /** 模型目录 url（免鉴权）。 */
    modelsUrl: string
    /** 价格/元数据源（默认 models.dev）。倍率就是从这里算的。 */
    pricingUrl?: string
    /** pricingUrl 里代表本 Agent 的 provider key（models.dev 用 `opencode`）。 */
    pricingProvider?: string
    /**
     * 免费层（匿名）客户端指纹：
     *   - `auto`（默认）—— 账号没有 key 时自动启用
     *   - `always` —— 一直启用（有 key 也带这套头，用于排查）
     *   - `never`  —— 一直不用
     */
    freeTierMode?: 'auto' | 'always' | 'never'
    /** 任务/签到接口的路径模板（可空 → 探测）。 */
    checkInPath?: string
    quotaPath?: string
    tasksPath?: string
    taskClaimPath?: string
    taskStatusPath?: string
  }
  /** 额度单位与倍率基准。 */
  credits: {
    unit: QuotaUnit
    /** 倍率基准（美元/百万 token）；用于把 cost 换算成 ×N。 */
    baselineUsdPerMTok: number
    /** 倍率取整粒度。 */
    round: number
  }
  requestTimeoutMs: number
  retry: ResolvedRetryConfig
  /** 每个账号每分钟最多几次请求（并发保护）。 */
  rateLimitPerMinute: number
}

export interface ResolvedGatewayConfig {
  routing: 'round-robin' | 'quota-first'
  /** 失败几次后降权。 */
  degradeAfterFailures: number
  /** 降权时长（秒）。 */
  penaltySec: number
  /** 自动恢复检测间隔（秒）。 */
  recoverIntervalSec: number
  /** 一次请求最多试几个账号。 */
  maxAccountAttempts: number
  maxConcurrentRequests: number
}

/** 解析后的整插件配置（`config.ts` 的 `resolveConfig()` 产物）。 */
export interface ResolvedConfig {
  enabled: boolean
  dataDir: string
  verbose: boolean
  gateway: ResolvedGatewayConfig
  agents: Record<string, ResolvedAgentConfig>
}
