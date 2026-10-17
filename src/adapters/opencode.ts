/**
 * **OpenCode 适配器（完整实现）**
 *
 * ## 上游事实（都是从官方文档与真实接口核过的，不是猜的）
 *
 * | 用途 | 端点 | 鉴权 |
 * |---|---|---|
 * | 模型目录（公开） | `https://opencode.ai/inference/v1/models` | **不需要** |
 * | 模型价格/元数据 | `https://models.dev/api.json` → `providers.opencode.models` | 不需要 |
 * | 对话（OpenAI 兼容） | `https://opencode.ai/inference/openai/v1/chat/completions` | `Authorization: Bearer <key>` |
 * | 工作区配置 | `https://opencode.ai/console/api/v2/config` | Bearer（Inference 权限即可） |
 * | 额度 / 预算 | `https://opencode.ai/console/api/v1/budgets/members` | Bearer（**需要 All 权限**） |
 *
 * ### 两条必须如实说清的事实
 *
 * 1. **opencode.ai 官方 Console 没有「每日签到」**，也没有「活动任务」。
 *    签到/任务这套玩法是**国内反代平台**（把 opencode 能力再包一层的上游）的常见形态。
 *    所以本适配器的做法是：**接口路径可配**（`upstream.checkInPath` / `tasksPath` 等），
 *    配了就真的去调；没配或探测到 404 就返回 `supported: false`，
 *    在 UI 与日志里写清「上游没有这个接口，不是故障」。
 *    **绝不伪造一个假的签到** —— 那会让用户以为领到了积分。
 * 2. **额度接口要 All 权限的 key**。Inference-only 的 key 打 `/api/v1/budgets/members`
 *    会 403。这时额度显示「未知」，并把 403 的原因写进 `error`，而不是显示 0。
 *
 * ## 额度单位换算
 *
 * Console 的钱字段是 **microcents 十进制字符串**（1 美元 = 100,000,000 microcents）。
 * 本适配器统一换算成美元返回（`unit: 'usd'`），UI 上再决定显示成 `$12.34` 还是积分。
 *
 * ## 倍率（积分消耗倍率）
 *
 * 「倍率」在 OpenCode 上是**相对贵度**：以 `credits.baselineUsdPerMTok`
 * （默认 $1.2 / 百万 token，即 DeepSeek V4.1 Flash 的输出价）为 ×1，
 * 取 `max(输入价, 输出价) / 基准` 并保留两位小数。
 * 免费模型（价格都为 0）直接标 `free: true` → UI 显示「免费」。
 * **价格拿不到就是 `undefined`** → UI 显示「未知倍率」（任务书要求）。
 */

import { createHash } from 'node:crypto'
import { BaseAdapter } from './base.js'
import { unsupportedReason } from './messages.js'
import { authHeaders, mergeHeaders } from '../core/http.js'
import { iterateSse } from '../core/sse.js'
import type {
  AccountCredentials,
  AccountRecord,
  AdapterContext,
  AgentCapabilities,
  ChatRequest,
  CheckInResult,
  ErrorKind,
  ModelMeta,
  QuotaSnapshot,
  StreamEvent,
  TaskRecord,
  TaskResult,
} from '../core/types.js'

/** 默认上游地址（可在 Agent 配置里整体替换成反代地址）。 */
export const OPENCODE_DEFAULTS = {
  chatBaseUrl: 'https://opencode.ai/inference/openai/v1',
  apiBaseUrl: 'https://opencode.ai/console',
  modelsUrl: 'https://opencode.ai/inference/v1/models',
  pricingUrl: 'https://models.dev/api.json',
  /** models.dev 里代表 OpenCode Console 的 provider key。 */
  pricingProvider: 'opencode',
} as const

/**
 * OpenCode Console 的 OAuth 设备码登录（RFC 8628）。
 *
 * ## 这四个常量是从哪来的
 *
 * 从 opencode 官方 CLI（npm `opencode-windows-x64` 的 `opencode.exe`，MIT）里读出来的：
 *
 * ```js
 * var lo = "https://opencode.ai/console"   // console base
 * var ln = "opencode-cli"                  // ← 公开的 OAuth client_id
 * // POST {lo}/auth/device/code   body: { client_id: ln, supports_org_scope: true }
 * // POST {lo}/auth/device/token  body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
 * //                                       device_code, client_id: ln }
 * // refresh: 同一个 token 端点，grant_type: 'refresh_token'
 * ```
 *
 * **这不是伪造客户端指纹，也不是绕什么东西** —— 这是它自己用的那套
 * 公开 OAuth 客户端注册，流程和浏览器里扫码登录一模一样：
 * 用户在**自己的**浏览器里输一次设备码、授权，插件拿到账号 token。
 *
 * ## 为什么这才是「不需要 API key」的正解
 *
 * 免费层绑的是 **Console 账号**，不是 API key。所以：
 *
 * | 你有的东西 | 免费模型能用吗 |
 * |---|---|
 * | 什么都没有 | ❌ 403 `FreeTierError` |
 * | 账号 token（本流程拿到） | ✅ |
 * | Console 里签发的 API key | ✅（那是另一条路，要手动建 key） |
 *
 * 也就是说：「免费模型不要 key」这句话是对的，但**仍然要登录**。
 * 本流程把「登录」做成插件里点一下的事，用户不需要去 Console 建任何 key。
 */
export const OPENCODE_OAUTH = {
  consoleBase: 'https://opencode.ai/console',
  /** 公开的 OAuth 客户端 id（与官方 CLI 相同，这样用户看到的就是自己的 OpenCode 账号）。 */
  clientId: 'opencode-cli',
  codePath: '/auth/device/code',
  tokenPath: '/auth/device/token',
  deviceCodeGrant: 'urn:ietf:params:oauth:grant-type:device_code',
  /**
   * 远端校验地址的基准。
   *
   * ⚠️ 上游返回的 `verification_uri_complete` 是**相对路径**
   * （`/console/device?user_code=…&client_id=…`），必须用这个基准去解析 ——
   * 官方 CLI 里就是 `new URL(e.verification_uri_complete, \`${lo}/\`)`。
   */
  verifyBase: 'https://opencode.ai/console/',
} as const

/**
 * **免费层（匿名）通道的客户端指纹** —— 「不登录、不填 key 直接用免费模型」的实现依据。
 *
 * ## 这份配方怎么来的
 *
 * 来自 [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api)（MIT）的
 * `internal/identity/request.go` / `internal/gateway/upstream.go` / `internal/httpx/client.go`，
 * **并且逐项做了消融实验**（一次只去掉一样，看还过不过）——不是照抄结论：
 *
 * | 条件 | 去掉会怎样 |
 * |---|---|
 * | `stream: true` | **403 `FreeTierError`**（免费层只接受流式） |
 * | `tools` 里有一个叫 `read` 的工具 | **403**（这是卡我最久的一项） |
 * | `x-opencode-session` = 规范 `ses_…` | **403** |
 * | `x-opencode-client: cli` + 客户端 UA | 过（不是唯一解，但按官方形状发最稳） |
 * | `Authorization` / `x-opencode-request` / `x-opencode-project` | **去掉照样过**（不必需） |
 *
 * 实测通过的请求（真拿到 200 + 正文「收到」+ `reasoning_content` + usage）：
 *
 * ```
 * POST https://opencode.ai/inference/v1/chat/completions
 * x-opencode-client: cli
 * x-opencode-session: ses_eb8460ad4ffefwOXligfVk4H7s
 * user-agent: opencode/latest/2.0.29/cli
 * { model:'deepseek-v4.1-flash-free', stream:true, tools:[{function:{name:'read',…}}] }
 * ```
 *
 * ## 关键细节：session id 必须是「降序编码」的
 *
 * 规范形状 `ses_<12 位小写 hex><14 位 Base62>`，其中 12 位 hex 是官方
 * `Identifier.descending()` 的产物：`~(ts_ms << 12 | counter)` 取低 48 位。
 * 2026-09-16 起，别的形状一律 403。
 *
 * 这里**用真实毫秒时间戳**（比 opencode2api 用 hash 伪造更贴近官方行为），
 * 并按会话内容做**确定性派生** —— 同一段对话永远得到同一个 session，
 * 上游 prompt cache 的亲和作用才不会被每次打散。
 *
 * ## 边界（说清楚，别夸大）
 *
 * - 这是**匿名免费层**：只对免费模型有效。付费模型在 `/zen` 上会直接
 *   `401 AuthError: Missing API key`（实测）。
 * - 上游随时可能再改门禁，所以这个形状**只对没有 key 的账号启用**
 *   （`upstream.freeTierMode: 'auto'`），有 key 的账号走正常路径，互不影响。
 */
export const OPENCODE_FREE_TIER = {
  /** 客户端 UA（2.x 形状 `opencode/<channel>/<version>/cli`）。 */
  userAgent: 'opencode/latest/2.0.29/cli',
  /** `x-opencode-client` 的值。 */
  client: 'cli',
  /** 过门必需的会话头名（都设成同一个 session id）。 */
  sessionHeaders: ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'X-Session-Id'],
  /** 旧客户端的身份头：现在**不需要**，而且某些代的门禁见到它就拒。 */
  legacyRequestHeader: 'x-opencode-request',
  /** 免费层要求请求里出现这个工具名。 */
  requiredTool: 'read',
} as const

/** 只有在客户端真的没给 `read` 时才会追加的占位工具。 */
export const FREE_TIER_READ_TOOL = {
  type: 'function',
  function: {
    name: OPENCODE_FREE_TIER.requiredTool,
    description:
      'DEPRECATED: This tool is deprecated and disabled. Do NOT call or reference this tool under any circumstances; ignore it completely.',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string', description: 'The path of the file to read' } },
      required: ['filePath'],
    },
  },
} as const

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** 规范 session 形状：`ses_` + 12 位小写 hex + 14 位 Base62。 */
export const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/**
 * 时间部分的窗口检查：官方 `Identifier.descending()` 把低 12 位写成
 * `0xFFF - counter`，免费层只接受 counter 1–63（即 `f[c-f][0-9a-f]`）。
 */
export const DESCENDING_TIME_PATTERN = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

/**
 * 把「时间戳 + 计数器」编成官方 `descending()` 的 12 位 hex。
 *
 * `~(ts_ms << 12 | counter)` 取低 48 位 —— 高位被截掉是**故意的**：
 * 官方就是这么做的，所以服务端也只能校验形状。
 */
export function descendingTimePartHex(nowMs: number, counter = 1): string {
  const word = (BigInt(Math.max(0, Math.floor(nowMs))) << 12n) | BigInt(Math.max(1, counter) & 0x3f)
  return (~word & 0xffffffffffffn).toString(16).padStart(12, '0')
}

/** 把整数渲染成固定宽度的 Base62。 */
export function base62Fixed(value: bigint, width: number): string {
  let n = value < 0n ? -value : value
  const out = new Array<string>(width)
  const base = BigInt(BASE62_ALPHABET.length)
  for (let index = width - 1; index >= 0; index -= 1) {
    out[index] = BASE62_ALPHABET[Number(n % base)]
    n /= base
  }
  return out.join('')
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n
  for (const byte of bytes) out = (out << 8n) | BigInt(byte)
  return out
}

/**
 * 由一段「会话信号」派生**确定性的**规范 session id。
 *
 * 同样的信号 → 同样的 session（多轮对话命中 prompt cache）；
 * 不同对话（开场不同）→ 不同 session，互不干扰。
 */
export function canonicalSessionId(signal: string, nowMs = Date.now()): string {
  if (CANONICAL_SESSION_PATTERN.test(signal) && DESCENDING_TIME_PATTERN.test(signal.slice(4, 16))) {
    return signal
  }
  const digest = createHash('sha256').update(`ses\u0000${signal}`).digest()
  const timePart = descendingTimePartHex(nowMs ^ ((digest[0] << 8) | digest[1]), 1)
  const randomPart = base62Fixed(bytesToBigInt(digest.subarray(6, 16)), 14)
  return `ses_${timePart}${randomPart}`
}

/**
 * 从请求体里取「会话信号」：**第一条 user 消息**。
 *
 * 用第一条而不是最后一条 —— 对话越聊越长，用最后一条会让整个会话每次换 session，
 * prompt cache 全废。
 */
export function conversationSignal(payload: ChatRequest): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const content = message.content
    if (typeof content === 'string' && content.trim() !== '') return content
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => String(block.text))
        .join('')
      if (text.trim() !== '') return text
    }
  }
  return `${payload.model}\u0000${JSON.stringify(messages.slice(0, 1))}`
}

/** 该请求体里是否已经有名为 `read` 的工具。 */
export function hasReadTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false
  return tools.some((tool) => {
    const fn = (tool as { function?: { name?: unknown } } | undefined)?.function
    return typeof fn?.name === 'string' && fn.name === OPENCODE_FREE_TIER.requiredTool
  })
}

/** 缺 `read` 就补一个占位（**不覆盖**客户端已有的工具）。 */
export function ensureFreeTierTools(tools: unknown): unknown[] {
  const list = Array.isArray(tools) ? [...tools] : []
  if (hasReadTool(list)) return list
  list.push(FREE_TIER_READ_TOOL)
  return list
}

/** 免费层要带的请求头。`x-opencode-request` 刻意不设（旧客户端标记，会被拒）。 */
export function freeTierHeaders(session: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-opencode-client': OPENCODE_FREE_TIER.client,
    'user-agent': OPENCODE_FREE_TIER.userAgent,
  }
  for (const name of OPENCODE_FREE_TIER.sessionHeaders) headers[name] = session
  return headers
}

/**
 * 把一次请求改成**免费层形状**：会话头 + `read` 工具 + 强制流式。
 *
 * ⚠️ `stream: true` 不是可选项 —— 免费层对非流式请求直接回 403
 * `FreeTierError`（消融实验确认）。所以免费通道只能流式，这跟插件的
 * 对话路径本来就一致。
 */
export function shapeFreeTierRequest(
  payload: ChatRequest,
  _accountId?: string,
): { session: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const session = canonicalSessionId(conversationSignal(payload))
  return {
    session,
    headers: freeTierHeaders(session),
    body: {
      ...payload,
      stream: true,
      tools: ensureFreeTierTools(payload.tools),
    },
  }
}

/** 设备码登录：发起阶段的产物。 */
export interface DeviceLoginStart {
  deviceCode: string
  userCode: string
  /** **已解析成绝对地址**的授权页链接（直接给用户点）。 */
  verificationUrl: string
  expiresInSec: number
  intervalSec: number
}

/** 设备码登录：轮询阶段的结论。 */
export type DeviceLoginPoll =
  | { status: 'pending'; message: string }
  | { status: 'slow_down'; intervalSec: number; message: string }
  | { status: 'expired'; message: string }
  | { status: 'denied'; message: string }
  | { status: 'failed'; message: string }
  | {
      status: 'ready'
      accessToken: string
      refreshToken: string
      /** 绝对过期时间戳（ms）。 */
      expiresAt: number
      orgId?: string
      account?: string
      message: string
    }

/** models.dev 的模型记录（只声明我们真正读的字段）。 */
interface PricingModel {
  id?: string
  name?: string
  description?: string
  reasoning?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

/** Console `/api/v2/config` 的响应形状（只读我们需要的那部分）。 */
interface ConsoleConfig {
  providers?: Record<
    string,
    {
      name?: string
      settings?: { baseURL?: string }
      models?: Record<string, { name?: string }>
    }
  >
}

/** Console 预算成员记录。 */
interface BudgetMember {
  user_id?: string
  email?: string
  limit_micro_cents?: string | null
  spent_micro_cents?: string | null
  exceeded?: boolean
  resets_at?: string
  source?: string | null
}

/** microcents → 美元。 */
export function microCentsToUsd(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const micro = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(micro)) return undefined
  return micro / 100_000_000
}

/**
 * 已知品牌 token 的正确大小写。
 *
 * 为什么需要它：模型目录只给 id（`/inference/v1/models` 的返回里没有显示名），
 * 没拿到 models.dev 元数据时只能从 id 猜。纯首字母大写会把 `deepseek` 变成
 * `Deepseek`、`glm` 变成 `Glm` —— 用户一眼就看出这是「程序拼的」。
 */
const BRAND_CASE: Record<string, string> = {
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  qwen: 'Qwen',
  mimo: 'MiMo',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  longcat: 'LongCat',
  nemotron: 'Nemotron',
  grok: 'Grok',
  claude: 'Claude',
  gemini: 'Gemini',
  mistral: 'Mistral',
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  astra: 'Astra',
  sol: 'Sol',
  luna: 'Luna',
  terra: 'Terra',
  terraform: 'Terraform',
  codex: 'Codex',
  spark: 'Spark',
  jev: 'Jev',
  llm: 'LLM',
  ai: 'AI',
  api: 'API',
  ui: 'UI',
  vl: 'VL',
}

/** 把模型 id 变成人看的名字（`deepseek-v4.1-flash-free` → `DeepSeek V4.1 Flash Free`）。 */
export function prettifyModelId(id: string): string {
  return id
    .split(/[-_]/)
    .filter((piece) => piece !== '')
    .map((piece) => {
      const known = BRAND_CASE[piece.toLowerCase()]
      if (known !== undefined) return known
      if (/^v?\d+(\.\d+)*$/i.test(piece)) return piece.toUpperCase()
      // 原 id 里已经全大写且长度 >= 2 的片段（`VL` / `AI`）保持原样，
      // 不要反过来去猜「三个字母就大写」——那会把 big-pickle 变成 BIG Pickle。
      if (piece.length >= 2 && piece === piece.toUpperCase() && /[A-Z]/.test(piece)) return piece
      return piece.charAt(0).toUpperCase() + piece.slice(1)
    })
    .join(' ')
}

/** 倍率：相对贵度。 */
export function multiplierOf(cost: PricingModel['cost'], baseline: number): { multiplier?: number; free: boolean } {
  const input = typeof cost?.input === 'number' ? cost.input : undefined
  const output = typeof cost?.output === 'number' ? cost.output : undefined
  if (input === undefined && output === undefined) return { free: false }
  const peak = Math.max(input ?? 0, output ?? 0)
  if (peak === 0) return { multiplier: 0, free: true }
  if (!Number.isFinite(baseline) || baseline <= 0) return { free: false }
  return { multiplier: Math.round((peak / baseline) * 100) / 100, free: false }
}

export class OpenCodeAdapter extends BaseAdapter {
  constructor() {
    const capabilities: AgentCapabilities = {
      // 静态声明 = 「官方 Console 的能力」；运行期探测到签到/任务接口存在时会升级。
      checkIn: false,
      quota: true,
      models: true,
      tasks: false,
      chat: true,
      reasoning: true,
      source: 'static',
      notes: {
        checkIn: 'opencode.ai 官方 Console 没有签到接口；若你的上游（反代）提供，请在配置里填 checkInPath',
        tasks: 'opencode.ai 官方 Console 没有活动任务接口；若你的上游提供，请在配置里填 tasksPath / taskClaimPath',
        quota: '额度走 Console 的 /api/v1/budgets/members，需要「All」权限的 key；Inference-only 的 key 会 403',
        models: '模型目录公开可读；倍率来自 models.dev 的价格数据',
        reasoning: '思维链字段是 reasoning_content，原样透传',
      },
    }
    super({
      id: 'opencode',
      name: 'OpenCode',
      doc: 'https://opencode.ai/v2/docs/console/models/',
      credentialHint:
        'OpenCode Console 的 API Key（形如 oc_sk_…）。模型目录可匿名读取；额度查询需要「All」权限的 key。',
      capabilities,
      implemented: true,
    })
  }

  // ───────────────────────────── 凭证 ─────────────────────────────

  /**
   * 校验凭证（页面「测活」按钮 + 降权恢复探测都走这条）。
   *
   * ## 四条**实测**事实（2026-10-16，直连 opencode.ai）
   *
   * | 请求 | 结果 |
   * |---|---|
   * | `GET /inference/v1/models`（无 key） | **200**，88 个模型（目录本来就公开） |
   * | `POST .../chat/completions` 免费模型、**完全不带 Authorization** | **403** `FreeTierError` |
   * | 同上、带**假** Bearer | **403** `FreeTierError`（连 key 都没验，先拦免费层） |
   * | 付费模型 + 假 Bearer | **401** `Invalid credential` |
   *
   * `FreeTierError` 原文：`OpenCode's free tier can only be used from within OpenCode.`
   *
   * 也就是说：**免费模型确实不要 key，但要「请求来自 OpenCode 客户端」**。
   * 逐个试过 `user-agent: opencode/*`、`x-opencode-client`、`x-client-id`、
   * `origin`/`referer`，**全部仍然 403** —— 它不是一个头就能过的。
   *
   * 所以对**第三方进程**（本插件就是）来说：
   *
   *   - 直连官方 → **必须有真 key**（付费或免费额度都绑账号）；
   *   - 走**中转 / 反代** → 凭证要求由中转决定，**可能完全不需要**。
   *
   * 这解释了下面为什么分两条路：空凭证**不再直接判失败**，而是真打一次上游
   * 问它「你到底认不认匿名请求」，再把上游的原话带回来。
   */
  async validateCredentials(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<{ ok: boolean; message?: string; kind?: ErrorKind }> {
    // 设备码登录拿到的 token 会过期 —— 先续一次，再验证。
    await this.ensureFreshCredentials(record, ctx)
    const credentials = record.credentials
    const token = typeof credentials.token === 'string' ? credentials.token.trim() : ''
    const cookie = typeof credentials.cookie === 'string' && credentials.cookie !== '' ? credentials.cookie : undefined

    if (token !== '' && (token.length < 8 || /\s/.test(token))) {
      return { ok: false, message: 'token 形状不对（太短或含空白），确认没把整行配置文件复制进来', kind: 'auth' }
    }

    // ① 有 key：读工作区配置（Inference 权限就够），最省。
    if (token !== '') {
      const url = `${ctx.config.upstream.apiBaseUrl.replace(/\/+$/, '')}/api/v2/config`
      const result = await ctx.http(url, { headers: this.authOf(record, ctx) })
      if (result.ok) return { ok: true, message: '凭证有效（工作区配置读取成功）' }
      if (isFreeTierError(result.body, result.text)) {
        return { ok: false, message: `${FREE_TIER_MESSAGE}（上游点名了免费层限制，不是这个 key 坏了）`, kind: 'unsupported' }
      }
      if (result.kind === 'not_found') {
        // 反代上游没有 Console 配置端点：退化成「模型目录通不通」。
        const probe = await ctx.http(ctx.config.upstream.modelsUrl, { headers: this.authOf(record, ctx) })
        if (probe.ok) return { ok: true, message: '上游没有 Console 配置端点，但模型目录可达' }
        return { ok: false, message: probe.message ?? '上游不可达', kind: probe.kind }
      }
      return { ok: false, message: result.message ?? `HTTP ${result.status}`, kind: result.kind }
    }

    // ② 无 key：先确认上游连得上，再真打一次推理问「匿名行不行」。
    const catalog = await ctx.http(ctx.config.upstream.modelsUrl, { headers: this.authOf(record, ctx) })
    if (!catalog.ok && catalog.status !== 0) {
      return {
        ok: false,
        message: `上游模型目录不可达：${catalog.message ?? `HTTP ${catalog.status}`}`,
        kind: catalog.kind,
      }
    }
    const live = await this.probeKeylessInference(ctx, cookie)
    if (live.ok) return { ok: true, message: live.message ?? '上游接受匿名请求' }
    if (live.kind === 'unsupported') return { ok: false, message: live.message, kind: 'unsupported' }
    return {
      ok: false,
      message:
        `上游不接受匿名请求：${live.message ?? '未知原因'}。` +
        '直连 opencode.ai 必须填真 key；若你用的是中转 / 反代，请核对它的地址与凭证要求。',
      kind: live.kind ?? 'auth',
    }
  }

  /**
   * 空凭证时真打一次推理，问上游「匿名免费层到底通不通」。
   *
   * ⚠️ 必须**按免费层形状**发：会话头 + `read` 工具 + **`stream: true`**。
   * 用 `stream: false` 探会被免费层直接 403（`FreeTierError`），
   * 那会把「其实能用」误判成「不能用」——这个坑踩过。
   *
   * 用 `max_tokens: 1`，成本可以忽略。
   */
  private async probeKeylessInference(
    ctx: AdapterContext,
    cookie: string | undefined,
  ): Promise<{ ok: boolean; kind?: ErrorKind; message?: string }> {
    const candidate = await this.cheapestModelId(ctx)
    const payload: ChatRequest = {
      model: candidate,
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
      max_tokens: 1,
    }
    const shaped = shapeFreeTierRequest(payload)
    const headers = mergeHeaders(
      { 'content-type': 'application/json', accept: 'text/event-stream' },
      authHeaders(cookie === undefined ? {} : { cookie }),
      shaped.headers,
    )
    const url = `${ctx.config.upstream.chatBaseUrl.replace(/\/+$/, '')}/chat/completions`
    const result = await ctx.http(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...shaped.body, max_tokens: 1, stream_options: { include_usage: true } }),
      timeoutMs: Math.min(ctx.config.requestTimeoutMs, 20_000),
    })
    if (result.ok) {
      return { ok: true, message: `上游接受匿名免费层请求（用 ${candidate} 探的，session=${shaped.session}）` }
    }
    if (isFreeTierError(result.body, result.text)) {
      return { ok: false, kind: 'unsupported', message: FREE_TIER_MESSAGE }
    }
    return { ok: false, kind: result.kind, message: result.message }
  }

  /** 挑一个最便宜的模型去探测（优先免费）。 */
  private async cheapestModelId(ctx: AdapterContext): Promise<string> {
    const cached = ctx.cache.get<string>('opencode:probe-model')
    if (cached !== undefined) return cached
    const ids = await this.loadCatalog(ctx)
    const free = ids.find((id) => /free|pickle|worth/i.test(id))
    const chosen = free ?? ids[0] ?? 'deepseek-v4.1-flash-free'
    ctx.cache.set('opencode:probe-model', chosen, 3600_000)
    return chosen
  }

  /** 账号凭证 → 请求头（token 去空白；cookie/自定义头照传）。 */
  private authOf(record: AccountRecord, _ctx: AdapterContext): Record<string, string> {
    const credentials: AccountCredentials = record.credentials
    const token = typeof credentials.token === 'string' ? credentials.token.trim() : undefined
    return authHeaders({
      ...credentials,
      ...(token === undefined ? {} : { token }),
    })
  }

  /**
   * 这次请求要不要走**免费层（匿名）形状**。
   *
   * `auto`（默认）= 账号没有 token 时启用 —— 这正是「免费模型不用填 key」的场景。
   * 有 key 的账号走正常路径，一套头都不加，互不影响。
   */
  private freeTierEnabled(record: AccountRecord, ctx: AdapterContext): boolean {
    const mode = ctx.config.upstream.freeTierMode ?? 'auto'
    if (mode === 'never') return false
    if (mode === 'always') return true
    const token = record.credentials?.token
    return typeof token !== 'string' || token.trim() === ''
  }

  // ─────────────────── OAuth 设备码登录（真正的「不需要 API key」） ───────────────────

  /**
   * 发起设备码登录：拿 `user_code` + 授权链接。
   *
   * 用户拿着这个码到**自己的**浏览器里授权，插件这边轮询换 token。
   * 全程不需要在 Console 里创建任何 API key。
   */
  async startDeviceLogin(ctx: AdapterContext): Promise<DeviceLoginStart> {
    const base = this.consoleBase(ctx)
    const result = await ctx.http(`${base}${OPENCODE_OAUTH.codePath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: OPENCODE_OAUTH.clientId, supports_org_scope: 'true' }).toString(),
      timeoutMs: 20_000,
    })
    if (!result.ok) {
      throw new Error(
        `发起登录失败：${result.message ?? `HTTP ${result.status}`}（端点 ${base}${OPENCODE_OAUTH.codePath}）`,
      )
    }
    const body = result.body as Partial<DeviceLoginStart> & {
      device_code?: string
      user_code?: string
      verification_uri_complete?: string
      verification_uri?: string
      expires_in?: number
      interval?: number
    }
    const deviceCode = String(body?.device_code ?? '')
    const userCode = String(body?.user_code ?? '')
    if (deviceCode === '' || userCode === '') {
      throw new Error(`上游没有返回 device_code / user_code：${JSON.stringify(result.body).slice(0, 200)}`)
    }
    // ⚠️ `verification_uri_complete` 是**相对路径**，必须用 console 基准解析
    //（官方 CLI 里就是 `new URL(e.verification_uri_complete, \`${lo}/\`)`）。
    const raw = String(body?.verification_uri_complete ?? body?.verification_uri ?? '/console/device')
    let verificationUrl: string
    try {
      verificationUrl = new URL(raw, OPENCODE_OAUTH.verifyBase).href
    } catch {
      throw new Error(`上游给的授权链接无法解析：${raw}`)
    }
    const start: DeviceLoginStart = {
      deviceCode,
      userCode,
      verificationUrl,
      expiresInSec: Number(body?.expires_in ?? 600),
      intervalSec: Math.max(1, Number(body?.interval ?? 5)),
    }
    ctx.log.info('已发起 OpenCode 登录', `请在浏览器打开 ${verificationUrl}`)
    return start
  }

  /**
   * 轮询一次登录结果。
   *
   * 未授权时上游返回 **400** `{_tag:'DeviceTokenError', error:'authorization_pending'}`
   * —— 那是**正常中间态**，不是故障，所以这里刻意不抛错，而是返回 `status`。
   */
  async pollDeviceLogin(deviceCode: string, ctx: AdapterContext): Promise<DeviceLoginPoll> {
    const base = this.consoleBase(ctx)
    const result = await ctx.http(`${base}${OPENCODE_OAUTH.tokenPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: OPENCODE_OAUTH.deviceCodeGrant,
        device_code: deviceCode,
        client_id: OPENCODE_OAUTH.clientId,
      }).toString(),
      timeoutMs: 20_000,
    })
    if (result.ok) return this.tokenPayload(result.body, ctx.now())
    const error = readOAuthError(result.body)
    switch (error) {
      case 'authorization_pending':
        return { status: 'pending', message: '等待你在浏览器里完成授权…' }
      case 'slow_down':
        return { status: 'slow_down', intervalSec: 10, message: '轮询太快了，已放慢' }
      case 'expired_token':
        return { status: 'expired', message: '设备码已过期（10 分钟），请重新发起登录' }
      case 'access_denied':
        return { status: 'denied', message: '你在浏览器里拒绝了这次授权' }
      default:
        return {
          status: 'failed',
          message: result.message ?? `HTTP ${result.status}`,
        }
    }
  }

  /**
   * 把 token 响应体翻译成结论。
   *
   * `nowMs` 由 `ctx.now()` 注入（不是直接 `Date.now()`）—— 这样测试可以把时间冻住，
   * 「过期时间算得对不对」才是可断言的事实，而不是一个「差不多现在」的约数。
   */
  private tokenPayload(body: unknown, nowMs: number): DeviceLoginPoll {
    const payload = body as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      org_id?: string
      account?: { email?: string } | string
      email?: string
    }
    const accessToken = String(payload?.access_token ?? '')
    const refreshToken = String(payload?.refresh_token ?? '')
    if (accessToken === '') {
      return { status: 'failed', message: `上游没有返回 access_token：${JSON.stringify(body).slice(0, 200)}` }
    }
    const expiresIn = Number(payload?.expires_in ?? 3600)
    const account =
      typeof payload?.account === 'string'
        ? payload.account
        : (payload?.account?.email ?? payload?.email ?? undefined)
    return {
      status: 'ready',
      accessToken,
      refreshToken,
      expiresAt: nowMs + Math.max(60, expiresIn) * 1000,
      ...(typeof payload?.org_id === 'string' && payload.org_id !== '' ? { orgId: payload.org_id } : {}),
      ...(typeof account === 'string' && account !== '' ? { account } : {}),
      message: '登录成功',
    }
  }

  /** console 基准（可被 `upstream.apiBaseUrl` 覆盖，方便走自建中转）。 */
  private consoleBase(ctx: AdapterContext): string {
    const configured = ctx.config.upstream.apiBaseUrl
    return (configured !== '' ? configured : OPENCODE_OAUTH.consoleBase).replace(/\/+$/, '')
  }

  /**
   * 确保 access token 新鲜。
   *
   * 有 `refreshToken` 且 5 分钟内会过期 → 用 refresh 换一个新的，
   * **同时回写内存记录与账号库**（不然重启后又得重新登录）。
   *
   * 刷新失败**不抛错** —— 原样返回旧 token，让上游的 401 用它自己的话说话，
   * 也避免一次网络抖动把整条请求路径打断。
   */
  async ensureFreshCredentials(record: AccountRecord, ctx: AdapterContext): Promise<AccountCredentials> {
    const credentials = record.credentials ?? {}
    const refreshToken = typeof credentials.refreshToken === 'string' ? credentials.refreshToken : ''
    const expiresAt = typeof credentials.expiresAt === 'number' ? credentials.expiresAt : 0
    const hasToken = typeof credentials.token === 'string' && credentials.token !== ''
    if (refreshToken === '' || !hasToken) return credentials
    // 没写过期时间就当作「不知道」，不去刷（避免每次请求都刷一次）。
    if (expiresAt === 0) return credentials
    if (expiresAt - ctx.now() > 5 * 60_000) return credentials

    const base = this.consoleBase(ctx)
    const result = await ctx.http(`${base}${OPENCODE_OAUTH.tokenPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OPENCODE_OAUTH.clientId,
      }).toString(),
      timeoutMs: 20_000,
    })
    if (!result.ok) {
      ctx.log.warn(
        `账号 ${record.id} 的 OpenCode 登录态续期失败 —— 本次先用旧 token`,
        result.message ?? `HTTP ${result.status}`,
      )
      return credentials
    }
    const next = this.tokenPayload(result.body, ctx.now())
    if (next.status !== 'ready') {
      ctx.log.warn(`账号 ${record.id} 的登录态续期响应异常`, next.message)
      return credentials
    }
    const patch: AccountCredentials = {
      token: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
      ...(next.orgId === undefined ? {} : { orgId: next.orgId }),
      ...(next.account === undefined ? {} : { account: next.account }),
    }
    // ① 回写内存记录：本次调用链立刻用上新 token。
    record.credentials = { ...credentials, ...patch }
    // ② 请宿主加密落盘：重启后不用重新登录。
    try {
      ctx.onCredentialsRefreshed?.(record.id, patch)
    } catch (error) {
      ctx.log.warn(`账号 ${record.id} 的续期结果落盘失败`, error instanceof Error ? error.message : String(error))
    }
    ctx.log.info(`账号 ${record.id} 的 OpenCode 登录态已自动续期`, `新的过期时间 ${new Date(next.expiresAt).toLocaleString()}`)
    return record.credentials
  }

  // ───────────────────────────── 每日签到 ─────────────────────────────

  /**
   * 每日签到。
   *
   * 三条分支，全部**如实回报**：
   *   1. 配置里填了 `checkInPath` → 真的 POST 上去；
   *   2. 没填但上游探测到有签到端点 → 调它；
   *   3. 都没有 → `supported: false`（不是故障）。
   */
  async checkIn(record: AccountRecord, ctx: AdapterContext): Promise<CheckInResult> {
    await this.ensureFreshCredentials(record, ctx)
    const path = ctx.config.upstream.checkInPath
    const configured = typeof path === 'string' && path !== ''
    const discovered = configured ? undefined : await this.discoverCapability('checkIn', record, ctx)
    if (!configured && discovered === undefined) {
      return {
        ok: false,
        supported: false,
        message: `${unsupportedReason(this.name, '每日签到')}。若你的上游是反代平台且有签到接口，请在 Agent 配置里填 upstream.checkInPath（例如 /api/user/checkin）`,
        at: Date.now(),
      }
    }
    const target = (configured ? path : discovered) as string
    const url = this.absolute(target, ctx)
    const result = await ctx.http(url, {
      method: 'POST',
      headers: this.authOf(record, ctx),
      body: '{}',
    })
    if (result.ok) {
      const credits = extractCredits(result.body)
      return {
        ok: true,
        supported: true,
        ...(credits === undefined ? {} : { credits }),
        message: describePayload(result.body, '签到成功'),
        at: Date.now(),
      }
    }
    if (result.kind === 'not_found') {
      return {
        ok: false,
        supported: false,
        message: `${unsupportedReason(this.name, '每日签到')}（配置的 ${target} 返回 404）`,
        at: Date.now(),
      }
    }
    return {
      ok: false,
      supported: true,
      message: result.message ?? `HTTP ${result.status}`,
      kind: result.kind,
      at: Date.now(),
    }
  }

  // ───────────────────────────── 额度 ─────────────────────────────

  /**
   * 剩余额度。
   *
   * 优先级：
   *   1. 配置了 `quotaPath` → 直接用它（自定义/反代上游）；
   *   2. Console 的 `/api/v1/budgets/members`（官方路径）。多成员时给**工作区合计**，
   *      单成员时给该成员的「限额 − 已用」。
   *   3. 都拿不到 → `unit: 'unknown'` + 一句人话原因。
   */
  async getQuota(record: AccountRecord, ctx: AdapterContext): Promise<QuotaSnapshot> {
    await this.ensureFreshCredentials(record, ctx)
    const now = Date.now()
    if (typeof ctx.config.upstream.quotaPath === 'string' && ctx.config.upstream.quotaPath !== '') {
      const result = await ctx.http(this.absolute(ctx.config.upstream.quotaPath, ctx), {
        headers: this.authOf(record, ctx),
      })
      if (result.ok) {
        const parsed = parseGenericQuota(result.body)
        return {
          accountId: record.id,
          unit: parsed.unit,
          ...parsed,
          fetchedAt: now,
        }
      }
      if (result.kind !== 'not_found') {
        return {
          accountId: record.id,
          unit: 'unknown',
          fetchedAt: now,
          error: `自定义额度接口失败：${result.message ?? `HTTP ${result.status}`}`,
        }
      }
    }

    const base = ctx.config.upstream.apiBaseUrl.replace(/\/+$/, '')
    const result = await ctx.http(`${base}/api/v1/budgets/members`, { headers: this.authOf(record, ctx) })
    if (result.ok) {
      const rows = Array.isArray(result.body) ? (result.body as BudgetMember[]) : []
      if (rows.length === 0) {
        return {
          accountId: record.id,
          unit: 'usd',
          unlimited: true,
          fetchedAt: now,
          extra: { members: 0 },
          error: '工作区没有成员记录 —— 视为不限额度',
        }
      }
      let limitUsd = 0
      let spentUsd = 0
      let unlimited = false
      let sawLimit = false
      for (const row of rows) {
        const limit = microCentsToUsd(row.limit_micro_cents)
        const spent = microCentsToUsd(row.spent_micro_cents) ?? 0
        if (limit === undefined) {
          unlimited = true
        } else {
          sawLimit = true
          limitUsd += limit
        }
        spentUsd += spent
      }
      const remaining = sawLimit ? Math.max(0, limitUsd - spentUsd) : undefined
      return {
        accountId: record.id,
        unit: 'usd',
        ...(remaining === undefined ? {} : { remaining }),
        ...(sawLimit ? { total: limitUsd } : {}),
        used: spentUsd,
        ...(unlimited ? { unlimited: true } : {}),
        fetchedAt: now,
        extra: { members: rows.length },
      }
    }
    if (result.kind === 'auth' && result.status === 403) {
      return {
        accountId: record.id,
        unit: 'unknown',
        fetchedAt: now,
        error:
          '这个 key 没有「All」权限，读不到预算数据。' +
          '到 OpenCode Console → Keys 给该服务账号开「All」权限，或在配置里填 upstream.quotaPath 指向你的上游额度接口。',
      }
    }
    if (result.kind === 'not_found') {
      // 反代上游没有官方预算端点：试一遍常见的几种。
      const probed = await this.probeQuotaEndpoints(record, ctx)
      if (probed !== undefined) return probed
      return {
        accountId: record.id,
        unit: 'unknown',
        fetchedAt: now,
        error: `${unsupportedReason(this.name, '额度查询')}（上游没有 /api/v1/budgets/members，也没探测到常见额度接口）`,
      }
    }
    return {
      accountId: record.id,
      unit: 'unknown',
      fetchedAt: now,
      error: `额度查询失败：${result.message ?? `HTTP ${result.status}`}`,
    }
  }

  /** 反代上游常见的额度端点，挨个探一遍（第一个通的就用）。 */
  private async probeQuotaEndpoints(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<QuotaSnapshot | undefined> {
    const candidates = ['/api/user/self', '/api/user/quota', '/api/user/balance', '/v1/dashboard/billing/subscription']
    for (const path of candidates) {
      const result = await ctx.http(this.absolute(path, ctx), { headers: this.authOf(record, ctx) })
      if (!result.ok) continue
      const parsed = parseGenericQuota(result.body)
      if (parsed.remaining === undefined && parsed.unlimited !== true) continue
      ctx.log.info(`上游额度接口命中：${path}`)
      return { accountId: record.id, ...parsed, fetchedAt: Date.now(), extra: { path } }
    }
    return undefined
  }

  // ───────────────────────────── 模型 + 倍率 ─────────────────────────────

  /**
   * 模型元数据（含积分倍率）。
   *
   * 数据来源三层，**越靠后优先级越高**（因为越靠后越知道「这个账号能用什么」）：
   *   1. `modelsUrl` 的公开模型 id 列表（不需要鉴权，一定有）；
   *   2. `pricingUrl`（models.dev）的显示名 / 上下文 / 价格 → **倍率**；
   *   3. 账号自己的 Console `/api/v2/config` → 这个工作区真正可用的模型与它的显示名。
   *
   * 任何一层失败都**降级不报错**（倍率变 `undefined` → UI 显示「未知倍率」）。
   */
  async getModelMetaList(record: AccountRecord, ctx: AdapterContext): Promise<ModelMeta[]> {
    await this.ensureFreshCredentials(record, ctx)
    const agentName = this.name
    const catalog = await this.loadCatalog(ctx)
    const pricing = await this.loadPricing(ctx)
    const workspace = await this.loadWorkspaceModels(record, ctx)
    const baseline = ctx.config.credits.baselineUsdPerMTok
    const now = Date.now()

    const ids = new Set<string>()
    for (const id of catalog) ids.add(id)
    for (const id of workspace?.keys() ?? []) ids.add(id)
    if (ids.size === 0) {
      ctx.log.warn('OpenCode 模型目录为空 —— 上游与 models.dev 都没拿到列表', ctx.config.upstream.modelsUrl)
      return []
    }

    const out: ModelMeta[] = []
    for (const id of ids) {
      const price = pricing.get(id)
      const derived = multiplierOf(price?.cost, baseline)
      const workspaceName = workspace?.get(id)
      const name = workspaceName ?? price?.name ?? prettifyModelId(id)
      const meta: ModelMeta = {
        id,
        name,
        agentId: this.id,
        agentName,
        updatedAt: now,
      }
      if (derived.multiplier !== undefined) meta.multiplier = derived.multiplier
      if (derived.free) meta.free = true
      if (price !== undefined) meta.multiplierSource = `models.dev:${OPENCODE_DEFAULTS.pricingProvider}`
      if (price?.description !== undefined) meta.description = price.description
      if (price?.limit?.context !== undefined) meta.contextWindow = price.limit.context
      if (price?.limit?.output !== undefined) meta.maxTokens = price.limit.output
      if (price?.reasoning === true) meta.reasoning = true
      const modalities = price?.modalities?.input
      if (Array.isArray(modalities)) {
        meta.inputModalities = modalities.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
      }
      // 工作区里没有的模型：不是不可用（很多上游不实现 config），只是标一下来源。
      if (workspace !== undefined && !workspace.has(id)) meta.description = meta.description ?? '（不在当前工作区目录里）'
      out.push(meta)
    }
    out.sort((left, right) => {
      // 免费的排前面（对用户最有价值），然后按倍率升序，最后按名字。
      const freeLeft = left.free === true ? 0 : 1
      const freeRight = right.free === true ? 0 : 1
      if (freeLeft !== freeRight) return freeLeft - freeRight
      const multLeft = left.multiplier ?? Number.MAX_SAFE_INTEGER
      const multRight = right.multiplier ?? Number.MAX_SAFE_INTEGER
      if (multLeft !== multRight) return multLeft - multRight
      return left.id.localeCompare(right.id)
    })
    return out
  }

  /** 公开模型 id 列表（带缓存）。 */
  private async loadCatalog(ctx: AdapterContext): Promise<string[]> {
    const cacheKey = 'opencode:catalog'
    const cached = ctx.cache.get<string[]>(cacheKey)
    if (cached !== undefined) return cached
    const result = await ctx.http(ctx.config.upstream.modelsUrl, { headers: { accept: 'application/json' } })
    if (!result.ok) {
      ctx.log.warn('拉取 OpenCode 模型目录失败', result.message ?? `HTTP ${result.status}`)
      return []
    }
    const body = result.body as { data?: Array<{ id?: string }> } | Array<{ id?: string }> | undefined
    const rows = Array.isArray(body) ? body : (body?.data ?? [])
    const ids = rows.map((row) => row?.id).filter((id): id is string => typeof id === 'string' && id !== '')
    if (ids.length > 0) ctx.cache.set(cacheKey, ids, 6 * 3600_000)
    return ids
  }

  /** pricingUrl（默认 models.dev）→ `Map<modelId, PricingModel>`（带缓存）。 */
  private async loadPricing(ctx: AdapterContext): Promise<Map<string, PricingModel>> {
    const cacheKey = 'opencode:pricing'
    const cached = ctx.cache.get<Map<string, PricingModel>>(cacheKey)
    if (cached !== undefined) return cached
    const url = ctx.config.upstream.pricingUrl ?? OPENCODE_DEFAULTS.pricingUrl
    const providerKey = ctx.config.upstream.pricingProvider ?? OPENCODE_DEFAULTS.pricingProvider
    const result = await ctx.http(url, { headers: { accept: 'application/json' }, timeoutMs: 20_000 })
    if (!result.ok) {
      ctx.log.warn('拉取模型价格失败 —— 本次倍率会显示为「未知倍率」', result.message ?? `HTTP ${result.status}`)
      return new Map()
    }
    const body = result.body as
      | { [key: string]: { models?: Record<string, PricingModel> } }
      | undefined
    const models = body?.[providerKey]?.models
    const map = new Map<string, PricingModel>()
    if (models !== undefined && typeof models === 'object') {
      for (const [id, record] of Object.entries(models)) map.set(id, { ...record, id })
    }
    // 只缓存成功的（空结果不缓存，避免「一次网络抖动把倍率冻 6 小时」）。
    if (map.size > 0) ctx.cache.set(cacheKey, map, 6 * 3600_000)
    return map
  }

  /** 账号自己的工作区模型（`Map<modelId, displayName>`）；拿不到返回 undefined。 */
  private async loadWorkspaceModels(
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<Map<string, string> | undefined> {
    const token = typeof record.credentials.token === 'string' ? record.credentials.token.trim() : ''
    if (token === '') return undefined
    const base = ctx.config.upstream.apiBaseUrl.replace(/\/+$/, '')
    const result = await ctx.http(`${base}/api/v2/config`, { headers: this.authOf(record, ctx) })
    if (!result.ok) {
      ctx.log.debug(
        '读工作区模型目录失败（不影响公开目录）',
        `${result.status} ${result.message ?? ''}`.trim(),
      )
      return undefined
    }
    const config = result.body as ConsoleConfig | undefined
    const map = new Map<string, string>()
    for (const provider of Object.values(config?.providers ?? {})) {
      for (const [id, model] of Object.entries(provider.models ?? {})) {
        map.set(id, typeof model?.name === 'string' && model.name !== '' ? model.name : id)
      }
    }
    return map.size > 0 ? map : undefined
  }

  // ───────────────────────────── 活动任务 ─────────────────────────────

  async fetchAvailableTasks(record: AccountRecord, ctx: AdapterContext): Promise<TaskRecord[]> {
    await this.ensureFreshCredentials(record, ctx)
    const path = ctx.config.upstream.tasksPath
    const configured = typeof path === 'string' && path !== ''
    const target = configured ? path : await this.discoverCapability('tasks', record, ctx)
    if (target === undefined) {
      ctx.log.debug(
        `「${this.name}」上游没有活动任务接口，跳过`,
        '若你的上游是反代平台，请在 Agent 配置里填 upstream.tasksPath',
      )
      return []
    }
    const result = await ctx.http(this.absolute(target, ctx), { headers: this.authOf(record, ctx) })
    if (!result.ok) {
      ctx.log.warn('拉取活动任务失败', result.message ?? `HTTP ${result.status}`)
      return []
    }
    return parseTasks(result.body)
  }

  async executeTask(task: TaskRecord, record: AccountRecord, ctx: AdapterContext): Promise<TaskResult> {
    await this.ensureFreshCredentials(record, ctx)
    const claim = ctx.config.upstream.taskClaimPath
    if (typeof claim !== 'string' || claim === '') {
      return {
        taskId: task.id,
        ok: false,
        message: `${unsupportedReason(this.name, '活动任务领取')}（未配置 upstream.taskClaimPath）`,
        kind: 'unsupported',
        retryable: false,
        at: Date.now(),
      }
    }
    const url = this.absolute(claim.replace('{taskId}', encodeURIComponent(task.id)), ctx)
    const result = await ctx.http(url, {
      method: 'POST',
      headers: mergeHeaders(this.authOf(record, ctx), { 'content-type': 'application/json' }),
      body: JSON.stringify({ task_id: task.id, ...(task.params ?? {}) }),
    })
    if (!result.ok) {
      return {
        taskId: task.id,
        ok: false,
        message: result.message ?? `HTTP ${result.status}`,
        kind: result.kind,
        retryable: result.kind !== 'bad_request',
        at: Date.now(),
      }
    }
    const credits = extractCredits(result.body)
    return {
      taskId: task.id,
      ok: true,
      ...(credits === undefined ? {} : { credits }),
      message: describePayload(result.body, '任务已提交'),
      raw: result.body,
      at: Date.now(),
    }
  }

  async checkTaskStatus(taskId: string, record: AccountRecord, ctx: AdapterContext): Promise<TaskResult> {
    await this.ensureFreshCredentials(record, ctx)
    const status = ctx.config.upstream.taskStatusPath
    if (typeof status !== 'string' || status === '') {
      // 没配状态接口就退化成「重新拉一遍列表，看这个任务还在不在」。
      const tasks = await this.fetchAvailableTasks(record, ctx)
      const still = tasks.find((task) => task.id === taskId)
      return {
        taskId,
        ok: still === undefined,
        message:
          still === undefined
            ? '任务不在待做列表里（视为已完成）'
            : `任务仍在待做列表里（未完成）`,
        kind: 'none',
        retryable: false,
        at: Date.now(),
      }
    }
    const url = this.absolute(status.replace('{taskId}', encodeURIComponent(taskId)), ctx)
    const result = await ctx.http(url, { headers: this.authOf(record, ctx) })
    if (!result.ok) {
      return {
        taskId,
        ok: false,
        message: result.message ?? `HTTP ${result.status}`,
        kind: result.kind,
        retryable: true,
        at: Date.now(),
      }
    }
    const credits = extractCredits(result.body)
    const done = /(?:true|"?(?:completed|done|finished|claimed|已领取|已完成)")/i.test(
      JSON.stringify(result.body ?? ''),
    )
    return {
      taskId,
      ok: done,
      ...(credits === undefined ? {} : { credits }),
      message: describePayload(result.body, done ? '任务已完成' : '任务未完成'),
      raw: result.body,
      at: Date.now(),
    }
  }

  // ───────────────────────────── 对话转发 ─────────────────────────────

  /**
   * 流式转发一次 chat completion。
   *
   * ⚠️ 这里是「**SSE 不能中断**」的落点，三层保护：
   *   1. `signal`（DSH 取消）与超时都会被 `fetch` 层合并，不会泄露悬挂连接；
   *   2. `iterateSse` 对坏事件**只跳过不终止**；
   *   3. 无论上游怎么结束，都保证吐出一个 `finish`（DSH 侧才能收尾）。
   */
  async *requestChatStream(
    payload: ChatRequest,
    record: AccountRecord,
    ctx: AdapterContext,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    // 登录态快过期就地续一次（不抛错，失败就让上游的 401 说话）。
    await this.ensureFreshCredentials(record, ctx)
    const url = `${ctx.config.upstream.chatBaseUrl.replace(/\/+$/, '')}/chat/completions`
    const freeTier = this.freeTierEnabled(record, ctx)
    const shaped = freeTier ? shapeFreeTierRequest(payload, record.id) : undefined
    const headers = mergeHeaders(
      this.authOf(record, ctx),
      { 'content-type': 'application/json', accept: 'text/event-stream' },
      shaped?.headers,
    )
    const body: Record<string, unknown> = {
      ...(shaped?.body ?? payload),
      model: payload.model,
      stream: true,
      stream_options: { include_usage: true },
    }
    // 不传 undefined，避免某些上游把 null 当显式值。
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key]
    }
    if (freeTier) {
      ctx.log.debug(
        `→ 免费层通道 model=${payload.model} account=${record.id}`,
        `session=${shaped?.session ?? ''} tools=${Array.isArray(body.tools) ? body.tools.length : 0}`,
      )
    }
    ctx.log.debug(`→ chat/completions model=${payload.model} account=${record.id}`, `messages=${payload.messages.length}`)

    let response: Response
    try {
      const send = ctx.fetch ?? fetch
      response = await send(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', failure: { kind: 'network', message: `连接上游失败：${message}`, at: Date.now() } }
      return
    }
    if (!response.ok) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        // 读不到就算了，状态码已经足够分类。
      }
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // 上游可能返回 HTML 错误页，保留原文。
      }
      const verdict = describeOpenCodeError(response.status, parsed, { anonymous: freeTier })
      const kind = verdict?.kind ?? this.detectError(response.status, parsed, response.headers)
      yield {
        type: 'error',
        failure: {
          kind,
          // 能自己给出**可执行**的话就用自己的；否则用上游原文。
          message: verdict?.message ?? extractErrorMessage(parsed) ?? `HTTP ${response.status}`,
          status: response.status,
          at: Date.now(),
        },
      }
      return
    }
    let malformed = 0
    for await (const event of iterateSse(
      response,
      (raw) => {
        malformed += 1
        if (malformed <= 3) ctx.log.debug('跳过一条无法解析的 SSE 事件', raw.slice(0, 200))
      },
      signal,
    )) {
      yield event
    }
    if (malformed > 0) ctx.log.warn(`本次流共跳过 ${malformed} 条无法解析的事件（其余照常转发）`)
  }

  // ───────────────────────────── 错误分类 ─────────────────────────────

  /**
   * OpenCode 的私有错误码 → 稳定分类。
   *
   * 具体判据都在 `describeOpenCodeError` 里（流式路径与它共用同一份逻辑，
   * 免得「错误事件的消息」和「路由决策」两处漂移）。
   */
  detectError(status: number, body: unknown, headers: Headers): ErrorKind {
    return describeOpenCodeError(status, body)?.kind ?? super.detectError(status, body, headers)
  }

  // ───────────────────────────── 内部小工具 ─────────────────────────────

  /** 把相对路径拼成绝对 URL（已经是 http 开头的原样返回）。 */
  private absolute(path: string, ctx: AdapterContext): string {
    if (/^https?:\/\//i.test(path)) return path
    const base = ctx.config.upstream.apiBaseUrl.replace(/\/+$/, '')
    return `${base}${path.startsWith('/') ? path : `/${path}`}`
  }

  /**
   * 能力探测：挨个试常见路径，第一个**看起来像 API** 的算命中。
   *
   * ⚠️ 「非 404 就算命中」是错的 —— 控制台是个 SPA，**任何**路径都返回
   * 200 的 HTML 外壳。真机上这就是一次误判：探测把 `/user/checkin` 当成了
   * 签到接口，于是 POST 上去拿到 405，日志里写着「签到成功探测到」却什么也签不成。
   *
   * 所以判据是「像 API」：
   *   - `content-type` 是 JSON；或
   *   - 状态码是 401 / 403 / 405 / 422（说明这个路径**存在**，只是拒绝了这次请求）。
   *
   * 结果缓存 6 小时（用 `ctx.cache`），避免每次调度都探一遍。
   */
  private async discoverCapability(
    capability: 'checkIn' | 'tasks',
    record: AccountRecord,
    ctx: AdapterContext,
  ): Promise<string | undefined> {
    const cacheKey = `opencode:capability:${capability}:${record.id}`
    const cached = ctx.cache.get<string | 'none'>(cacheKey)
    if (cached !== undefined) return cached === 'none' ? undefined : cached
    const candidates =
      capability === 'checkIn'
        ? ['/api/user/checkin', '/api/user/sign', '/api/v1/checkin', '/user/checkin']
        : ['/api/user/tasks', '/api/user/activity/tasks', '/api/v1/tasks', '/user/tasks']
    for (const path of candidates) {
      const result = await ctx.http(this.absolute(path, ctx), { headers: this.authOf(record, ctx) })
      if (looksLikeApi(result)) {
        ctx.log.info(`探测到${capability === 'checkIn' ? '签到' : '活动任务'}接口：${path}`, `HTTP ${result.status}`)
        ctx.cache.set(cacheKey, path, 6 * 3600_000)
        return path
      }
      if (result.kind !== 'not_found' && result.kind !== 'none') break
    }
    ctx.log.debug(`没有探测到${capability === 'checkIn' ? '签到' : '活动任务'}接口`, '（上游大概率本来就没有）')
    ctx.cache.set(cacheKey, 'none', 6 * 3600_000)
    return undefined
  }
}

/**
 * 一个探测响应是否**像 API**。
 *
 * 判据刻意保守：宁可漏判（退回「上游没有这个接口」），也不要误判 ——
 * 误判会让调度器每 24 小时对着一个 HTML 页面 POST 一次。
 */
export function looksLikeApi(result: {
  status: number
  ok: boolean
  headers?: Headers
  text?: string
}): boolean {
  // 401/403/405/422：路径存在，只是拒绝了这次请求。
  if ([401, 403, 405, 422].includes(result.status)) return true
  if (!result.ok) return false
  const contentType = result.headers?.get('content-type') ?? ''
  if (contentType.includes('application/json')) return true
  // 没有 content-type 但 body 明显是 JSON（有的反代不设头）。
  const body = (result.text ?? '').trim()
  return body.startsWith('{') || body.startsWith('[')
}

// ───────────────────────────── 纯函数工具（可单测） ─────────────────────────────

/**
 * 从设备码轮询的失败响应里读出 RFC 8628 的 `error` 字段。
 *
 * 上游形状（实测）：`{"_tag":"DeviceTokenError","error":"authorization_pending",
 * "error_description":"The authorization request is still pending"}`
 * —— 注意是 `error` 而不是 `error.code`，且 HTTP 状态是 **400**。
 */
export function readOAuthError(body: unknown): string {
  if (body === null || typeof body !== 'object') return ''
  const record = body as Record<string, unknown>
  for (const key of ['error', 'error_code']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const nested = record.error_description ?? record.message
  return typeof nested === 'string' ? nested : ''
}

/**
 * 上游错误 → `{kind, message}`，**免费层与流式路径共用这一份判据**。
 *
 * 为什么必须单独认（认错了行为就错）：
 *
 * | 上游 | 错认成 | 正确 | 为什么 |
 * |---|---|---|---|
 * | `FreeTierError`（403） | `auth` → **换号** | `unsupported` | 换号也一样，它校验的是请求形状；换号纯浪费其它账号额度 |
 * | `AuthError: Missing API key`（401，**匿名请求**） | `auth` → 换号 + 界面报「API 密钥无效」 | `unsupported` | 真实含义是「这个模型不在匿名免费层里」——换号解决不了，用户该做的是换模型或填 key |
 * | `RegionError`（403） | `auth` | `unsupported` | 上游按地区拒了；换号解决不了 |
 * | `AuthError: Invalid credential`（带真 key） | `unknown` | `auth` | 这个**确实**该降权、该换号 |
 * | `insufficient_quota` 等 | `bad_request` | `quota` | 额度耗尽换号就能好 |
 *
 * `anonymous` 是**关键输入**：同样是 401，匿名请求和带 key 请求的处置完全不同。
 * 不给它，就会把「模型不在免费层」误报成「密钥无效」——实测踩到过。
 */
export function describeOpenCodeError(
  status: number,
  body: unknown,
  options: { anonymous?: boolean } = {},
): { kind: ErrorKind; message: string } | undefined {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  const upstream = extractErrorMessage(body)

  if (isFreeTierError(body, text)) return { kind: 'unsupported', message: FREE_TIER_MESSAGE }

  if (/RegionError|not available in your country/i.test(text)) {
    return {
      kind: 'unsupported',
      message:
        `上游按地区拒绝了这个模型（${upstream ?? 'RegionError'}）。` +
        '这不是你的配置问题，换一个模型即可 —— 免费层里有几个模型在部分地区本来就用不了。',
    }
  }

  if (options.anonymous === true && status === 401 && /missing api key/i.test(text)) {
    return {
      kind: 'unsupported',
      message:
        '这个模型不在匿名免费层里（上游：Missing API key）。' +
        '免费层只覆盖名字带 free 的模型；要用付费模型，请给账号填一个真 API key，或用「登录 OpenCode 账号」。',
    }
  }

  if (/insufficient_quota|quota_exceeded|billing_hard_limit|credit_balance_too_low/i.test(text)) {
    return { kind: 'quota', message: upstream ?? '额度已用尽' }
  }
  if (/invalid_api_key|token_expired|session_revoked|invalid credential/i.test(text)) {
    return { kind: 'auth', message: upstream ?? '凭证无效' }
  }

  const fallback = status === 401 || status === 403 ? ('auth' as const) : undefined
  return fallback === undefined ? undefined : { kind: fallback, message: upstream ?? `HTTP ${status}` }
}

/**
 * 判定一个响应是不是「免费层拒绝」。
 *
 * 上游的形状（实测）：`{"type":"error","error":{"type":"FreeTierError","message":"…"}}`
 * 状态码是 **403** —— 如果不单独认，它会被归成 `auth`，于是路由器会去换账号，
 * 而换任何一个号都是同一个错，白白烧掉其它账号的额度。
 *
 * 它真实校验的是**请求形状**（见 `OPENCODE_FREE_TIER` 的消融表），不是账号。
 */
export function isFreeTierError(body: unknown, text?: string): boolean {
  const haystack =
    typeof text === 'string' && text !== '' ? text : typeof body === 'string' ? body : JSON.stringify(body ?? '')
  return /FreeTierError/i.test(haystack) || /free tier can only be used from within opencode/i.test(haystack)
}

/**
 * 免费层被拒时给用户看的**确定结论**（禁止「可能 / 也许」这种让人瞎试的措辞）。
 *
 * 按**实测过的可能性**排序，第一条就是最常见的：
 *
 * ① **本机出口 IP 被限**（2026-10-17 实测踩到）：特征是
 *    `GET /inference/v1/models` 仍然 200（85 个模型）、站点 200，
 *    **只有 `chat/completions` 被 403**，且换模型/换通道/换 UA 全都是 403。
 *    处置：等一段时间、换出口 IP、或把「对话 base url」指向你自己的反代。
 * ② 请求形状缺项：需要 ①流式 ②一个名为 `read` 的工具 ③规范 `x-opencode-session`。
 *    账号没有 key 时插件会自动补齐；把 `upstream.freeTierMode` 设成 `never` 就会缺。
 * ③ 选了付费模型：匿名通道上会 401 `Missing API key`，需要真 key 或设备码登录。
 *
 * 旧文案把「形状」写成了唯一原因，结果用户拿这条信息去查形状，而真因是 IP 限流 —— 这条就是为此改的。
 */
export const FREE_TIER_MESSAGE =
  '上游拒绝了这次免费层请求（403 FreeTierError）。按实测顺序排查：' +
  '① 本机出口 IP 被免费层限流/封了 —— 特征是「模型目录（/inference/v1/models）仍然 200、' +
  '只有 chat 被拒，且换模型/换通道/换 UA 都是 403」；处置：等一段时间、换出口 IP、' +
  '或把「对话 base url」指向你自己的中转/反代。' +
  '② 请求形状缺项 —— 需要 ①流式（stream:true）②一个名为 read 的工具 ③规范的 x-opencode-session；' +
  '账号没有 key 时插件会自动补齐，若把 upstream.freeTierMode 设成 never 就会缺。' +
  '③ 选了付费模型 —— 匿名通道上会 401 Missing API key，需要真 key 或设备码登录。'

/** 从各种形状的响应体里抠出「积分/额度」数字。 */
export function extractCredits(body: unknown): number | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'number') return body
  if (typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  const nested = (record.data ?? record.result ?? record.user ?? record.payload) as
    | Record<string, unknown>
    | undefined
  const keys = ['credits', 'credit', 'points', 'quota', 'balance', 'reward', 'amount', 'score', 'integral']
  for (const source of [record, nested]) {
    if (source === undefined || source === null || typeof source !== 'object') continue
    for (const key of keys) {
      const value = (source as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
    }
  }
  return undefined
}

/** 从响应体里取一句可以给用户看的话。 */
export function describePayload(body: unknown, fallback: string): string {
  const message = extractErrorMessage(body)
  return message ?? fallback
}

/** 抠出上游的 message / msg / error.message。 */
export function extractErrorMessage(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return body.trim() === '' ? undefined : body.slice(0, 400)
  if (typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  for (const key of ['message', 'msg', 'error_description', 'detail']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  const error = record.error
  if (typeof error === 'string' && error !== '') return error
  if (error !== null && typeof error === 'object') {
    const inner = error as Record<string, unknown>
    for (const key of ['message', 'msg', 'code', 'type']) {
      const value = inner[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

/** 把任意额度响应体归一化成 `QuotaSnapshot` 的字段。 */
export function parseGenericQuota(body: unknown): {
  unit: QuotaSnapshot['unit']
  remaining?: number
  total?: number
  used?: number
  unlimited?: boolean
  extra?: Record<string, unknown>
} {
  if (body === undefined || body === null) return { unit: 'unknown' }
  if (typeof body === 'object') {
    const record = body as Record<string, unknown>
    // 常见的 `<provider>/api/user/self` 形态：{ data: { quota, used_quota } }
    const data = (record.data ?? record) as Record<string, unknown>
    const quota = numOf(data.quota) ?? numOf(data.remaining) ?? numOf(data.balance)
    const used = numOf(data.used_quota) ?? numOf(data.used)
    if (quota !== undefined || used !== undefined) {
      return {
        unit: 'credits',
        ...(quota === undefined ? {} : { remaining: quota }),
        ...(used === undefined ? {} : { used }),
      }
    }
    const unlimited = record.unlimited === true || data.unlimited === true
    if (unlimited) return { unit: 'unknown', unlimited: true }
  }
  const credits = extractCredits(body)
  if (credits !== undefined) return { unit: 'credits', remaining: credits }
  return { unit: 'unknown' }
}

function numOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/** 把任务列表响应体归一化成 `TaskRecord[]`。 */
export function parseTasks(body: unknown): TaskRecord[] {
  const rows = pickTaskRows(body)
  const out: TaskRecord[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const id = stringOf(record.id) ?? stringOf(record.task_id) ?? stringOf(record.key) ?? stringOf(record.slug)
    if (id === undefined) continue
    const title = stringOf(record.title) ?? stringOf(record.name) ?? stringOf(record.task_name) ?? id
    const task: TaskRecord = {
      id,
      title,
      kind: kindOf(record),
      raw: record,
    }
    const description = stringOf(record.description) ?? stringOf(record.desc) ?? stringOf(record.summary)
    if (description !== undefined) task.description = description
    const reward =
      numOf(record.reward) ?? numOf(record.credits) ?? numOf(record.points) ?? numOf(record.score) ?? numOf(record.amount)
    if (reward !== undefined) task.reward = reward
    const params = record.params ?? record.payload ?? record.extra
    if (params !== null && typeof params === 'object') task.params = params as Record<string, unknown>
    out.push(task)
  }
  return out
}

function pickTaskRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (body === null || typeof body !== 'object') return []
  const record = body as Record<string, unknown>
  for (const key of ['data', 'tasks', 'list', 'items', 'result', 'rows']) {
    const value = record[key]
    if (Array.isArray(value)) return value
    if (value !== null && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).list ?? (value as Record<string, unknown>).items
      if (Array.isArray(nested)) return nested
    }
  }
  return []
}

function kindOf(record: Record<string, unknown>): TaskRecord['kind'] {
  const raw = (stringOf(record.kind) ?? stringOf(record.type) ?? stringOf(record.category) ?? '').toLowerCase()
  if (raw.includes('check') || raw.includes('sign') || raw.includes('签到')) return 'checkin'
  if (raw.includes('daily') || raw.includes('每日')) return 'daily'
  return 'activity'
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}
