/**
 * **商汤小浣熊（Raccoon Office）适配器 —— 完整实现**
 *
 * 目标客户端：`商汤小浣熊 1.1.3`（Electron，包名 `@raccoon/office-desktop`，
 * 主进程入口 `dist/electron/entry.cjs`）。安装位置因机器而异，不在源码里写死路径。
 *
 * ## 上游事实（**全部本机实测**，2026-10-27，不是猜的）
 *
 * | 用途 | 端点 | 鉴权 | 实测结果 |
 * |---|---|---|---|
 * | 对话（OpenAI 兼容 SSE） | `POST https://xiaohuanxiong.com/api/web/llm/v2/chat/completions` | Bearer | 200 `text/event-stream` |
 * | 模型目录 | `GET .../api/web/llm/v2/model_catalog` | Bearer（**要**，匿名 401） | 200，10 个模型 |
 * | 积分余额 | `GET .../api/web/points/v1/balance` | Bearer | 200 `available_points` 等 10 个字段 |
 * | 积分流水 | `GET .../api/web/points/v2/bills?paging.limit=N&type=all` | Bearer | 200 `items[]` |
 * | 登录积分发放 | `POST .../api/web/desktop/v1/login/points/grant` | Bearer | 200 `{granted, popup}` |
 * | 账号信息 | `GET .../api/web/auth/v1/user_info` | Bearer | 200 `{id, name, phone}` |
 * | 图片生成 | `POST .../api/web/llm/v2/images/gen` | Bearer | 未接（本适配器不涉及） |
 *
 * ### 三条**被实测否掉**的假设（写下来防止下一个人重新猜）
 *
 * 1. **`X-Client-*` 请求头不是必需的，而且客户端自己也不是到处都发**。
 *    客户端源码里有一套 `X-Client-Name/Platform/Version/Page`
 *    （`build/shared/client/requestHeaders.js`），看起来像指纹门。
 *    实测四种组合（只 Bearer / Bearer+真指纹 / Bearer+假指纹 / 只有指纹）
 *    **前三种全 200**，只有「无 Authorization」401 —— 上游不按它门禁。
 *    而全仓查实际使用点，这套头只出现在**内容检测**与**手机互联**两类请求上；
 *    模型目录、积分余额用的 `fetchWithAuth` 都不带，只有网页端的
 *    `login/points/grant` 带 `X-Client-Platform` + `X-Client-Version`。
 *    ⇒ 本适配器**按端点分别对齐**：只在签到这一个接口带这套头。
 * 2. **`X-Org-Code` 不能乱发**。客户端的 `office_identity` 是 `personal` 时它
 *    **根本不发**这个头；手工塞 `X-Org-Code: personal` 会 400
 *    `org_not_found_error`。个人账号一律不带。
 * 3. **`stream_options.include_usage` 不需要**。实测带与不带，最后一帧
 *    `usage` 都在（`completion_tokens_details.reasoning_tokens` 也在）。
 *    少一个字段就少一份上游改协议时被 400 的面。
 *
 * ### 指纹：我们对齐到了什么程度，以及**没有**对齐到什么
 *
 * 抓包对比过两边真实发出的头（本地 HTTP 捕获，不是看代码猜）：
 *
 * | 头 | 官方客户端 | 本插件 |
 * |---|---|---|
 * | `user-agent` | `node` | `node`（`RACCOON_USER_AGENT`） |
 * | `accept-encoding` / `sec-fetch-mode` / `connection` | undici 默认 | undici 默认（**同一套栈**） |
 * | `accept` | `* / *`（全通配） | `text/event-stream`（对话）/ `application/json` |
 * | `X-Client-Platform` / `-Version` | 只有 `login/points/grant` 带 | 只有 `checkIn` 带 |
 * | `X-Org-Code` | 企业号才带 | 不带（个人号带了会 400） |
 *
 * ⚠️ **有一处对不齐，且改不了**：官方客户端的**对话**请求不是这个 Electron 进程发的，
 * 而是 `box-agent-acp.exe`（PyInstaller 打的 Python 包，内含 `httpx` + OpenAI/Anthropic
 * SDK）。它的 `user-agent` 与 `x-stainless-*` 由 Python 那套栈决定，**没有抓到过样本**
 * （要抓得改客户端的 `api_base` 并驱动它发一轮，成本高且有副作用）。
 * 所以「对话请求与官方逐字节相同」这句话**不成立**，别这么写。
 *
 * ### 关于「能不能不被风控」
 *
 * 如实说：**不能保证**。改头只是把「一眼可见的第三方标记」拿掉
 * （改之前额度/目录/签到四条请求都带着 `dsh-multi-agent-gateway/版本号`）。
 * 真正的风险面是**行为**，而其中一条是结构性的、改不掉：
 *
 * - 插件与官方客户端**共用同一个 token、同一个出口 IP**。同时用就是
 *   「一个账号、两个不同 HTTP 栈在交错发请求」——这不是伪装能解决的。
 * - 节奏：人手有间隔，脚本可以秒级连发。所以 `rateLimitPerMinute` /
 *   `maxConcurrentRequests` 比头重要得多。
 * - 形态：DSH 每轮重发整段会话历史与自己的工具集，长度与工具形状都和
 *   官方 agent 不同。
 *
 * 已经做进去的减害项：`coversToday: true` 让签到**不会**当天反复打；
 * `risk_control` 独立分类 + 30 分钟冷却 + **不对同号重试**。
 *
 * ### 思考档位：**上游用的就是 OpenAI 那 8 个规范名**
 *
 * `reasoning_effort` 的合法值由上游 serde 枚举**硬校验**，非法值的 400 原文是：
 *
 * ```
 * Failed to deserialize the JSON body into the target type:
 * reasoning_effort: unknown variant `off`, expected one of
 * `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`, `max`
 * ```
 *
 * 这 8 个值与 `core/reasoning.ts` 的 `CANONICAL_REASONING_EFFORTS`
 * **完全同集**（只是顺序不同）⇒ 本平台的档位翻译是**恒等映射**，
 * 不需要 `light` / `extra_high` / `on` 那类私有 id 的落位逻辑。
 *
 * ⚠️ 但这个 400 是**请求体反序列化**阶段报的，发生在模型路由**之前** ——
 * 所以它证明的是「**参数**被全局接受」，**不能**推出「每个模型都会因此改变行为」。
 * 实测同一个值在不同模型上效果差异很大（`sn-deepseek` 上 `max` 的思维链明显更长，
 * `raccoon-*` 上压根不吐思维链）。所以：
 *   - `reasoningEfforts` 对**所有**模型如实声明这 8 档（参数确实通用）；
 *   - `reasoning: true`（会不会吐思维链）**按实测**逐模型给。
 *
 * ### 思维链与工具调用
 *
 * - 思维链在 `delta.reasoning_content`，与 OpenAI 的字段名一致（`core/sse.ts` 已认）。
 * - 工具调用是标准 `delta.tool_calls`，实测一轮 `finish_reason: "tool_calls"`，
 *   回填 `role: 'tool'` 后第二轮正常收尾 ⇒ **多轮工具循环可用**。
 * - 视觉：`sn-deepseek-v4-1-flash-1017` 接受 `image_url` data URI（200）；
 *   但 `sn-glm-5-3` 同请求 400（内部 MaaS 组件拒绝）⇒ **不按 tag 猜**，
 *   只对实测通过的模型标 `inputModalities: ['text','image']`。
 *
 * ## 凭证：**手工粘贴 + 自动从客户端读取**两条路
 *
 * 客户端把 token 落在 `auth.json`（`{access_token, office_identity}`），
 * 路径按 `BOX_AGENT_CONFIG_DIR` → `BOX_AGENT_HOME/config` → 两个已知默认目录依次找。
 * 本适配器在**账号没填 token 时**自动去读它 —— 用户装好客户端登录一次，
 * 插件这边**零配置**就能用（这是「把客户端模型反代进插件」的核心体验）。
 *
 * ⚠️ 这个 token 是 **IAM JWT**（`iss: xiaohuanxiong.com/iam`），实测有效期 **30 天**，
 * 且 `auth.json` 里**没有 refresh_token** ⇒ **本适配器无法自动续期**。
 * 过期后只能重新登录客户端（插件会自动读到新值）。这一点写进
 * `capabilities.notes.login`，不假装能续。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BaseAdapter } from './base.js'
import { missingCredentialReason } from './messages.js'
import { mergeHeaders } from '../core/http.js'
import { parseRetryAfter } from '../core/errors.js'
import { iterateSse } from '../core/sse.js'
import { CANONICAL_REASONING_EFFORTS } from '../core/reasoning.js'
                                                                         
             
                     
                
                 
                    
              
                
            
            
                
              
                         

// ───────────────────────────── 上游常量 ─────────────────────────────

/** 站点根。所有端点都在它下面（客户端源码里 `getDesktopHostedGatewayOrigin()` 的兜底值）。 */
export const RACCOON_ORIGIN = 'https://xiaohuanxiong.com'

/** 各端点路径（相对站点根）。与 `AGENT_UPSTREAM_DEFAULTS.raccoon` 一一对应。 */
export const RACCOON_PATHS = {
  /** OpenAI 兼容对话端点。注意它**不是** `/v1/chat/completions`。 */
  chat: '/api/web/llm/v2/chat/completions',
  /** 对话 base（配置里 `upstream.chatBaseUrl` 存的就是它）。 */
  chatBase: '/api/web/llm/v2',
  /** 模型目录。 */
  catalog: '/api/web/llm/v2/model_catalog',
  /** 积分余额。 */
  balance: '/api/web/points/v1/balance',
  /** 积分流水。 */
  bills: '/api/web/points/v2/bills',
  /** 登录积分发放（等价于「每日签到」）。 */
  loginGrant: '/api/web/desktop/v1/login/points/grant',
  /** 账号信息（拿昵称/手机号做默认标签）。 */
  userInfo: '/api/web/auth/v1/user_info',
}         

/**
 * 与官方客户端**逐字对齐**的传输层 `user-agent`。
 *
 * ## 为什么是 `node` 这个看起来像「忘了设」的值
 *
 * 客户端 JS 侧的请求（模型目录 / 余额 / 账单 / 签到）都走 Electron 主进程的
 * 全局 `fetch`，也就是 undici —— 而它在**没有**显式 UA 时补的就是字面量 `node`。
 * 这不是推断：用它**自己安装目录里的那个 exe** 真发一次抓到的就是这个值
 * （`ELECTRON_RUN_AS_NODE=1 商汤小浣熊.exe`，Node 24 / Electron 41）：
 *
 * ```
 * 客户端：user-agent: node   accept: 全通配   sec-fetch-mode: cors   accept-encoding: gzip, deflate
 * 本插件：user-agent: node   accept: text/event-stream   sec-fetch-mode: cors   accept-encoding: gzip, deflate
 * ```
 *
 * 两边同一个字面量（Node 22 与 Node 24 的 undici 在这件事上取值相同），
 * 唯一差别是 `accept` —— 那是我们**本来就该**声明流式的值。
 *
 * ## 为什么必须由适配器显式写出来
 *
 * `core/http.ts` 对没给 UA 的调用会补默认值 `dsh-multi-agent-gateway/<版本>`。
 * 那是给自家排查用的合理默认，但在这条链路上它是**负资产**：
 * 客户端发 `node`，我们发「一个叫 dsh-multi-agent-gateway 的第三方工具 + 版本号」——
 * 比不声明身份更醒目。实测过：改之前额度/目录/签到四条请求全部带着插件名出去。
 * 显式写 `node` 之后两边才真正一致。
 *
 * ⚠️ 这只影响**声明**，不影响**校验**：假 UA / 假指纹实测都照样 200，
 * 上游没有按这套头做门禁。
 */
export const RACCOON_USER_AGENT = 'node'

/**
 * 登录积分发放**这一个**接口专属的客户端标识头。
 *
 * 出处（客户端产物里的网页端调用点）：
 *
 * ```js
 * fetchWithAuth(`${origin}/api/web/desktop/v1/login/points/grant`, {
 *   method: 'POST',
 *   headers: { 'X-Client-Platform': n, ...(s ? { 'X-Client-Version': s.startsWith('v') ? s : `v${s}` } : {}), ... }
 * })
 * ```
 *
 * ## 为什么只有这一个接口带
 *
 * 全仓查 `X-Client-*` 的实际使用点只有两类：内容检测
 * （`build/electron/main/security/safetyReview.js`）与手机互联
 * （`desktopTrustedDeviceApi` / `pairingApi` / `httpsDesktopRelayApi`）。
 * 模型目录与积分余额用的 `fetchWithAuth` **不带**这套头 ——
 * `hostedModels.js` 只发 `Authorization`（企业号再加 `X-Org-Code`）。
 *
 * 所以这里是**按端点分别对齐**，不是「为了像客户端就把所有头都发出去」：
 * 在客户端不发的端点上多发一套，恰恰就不是客户端的样子了。
 *
 * ⚠️ 版本号会随客户端升级漂移。漂移的后果只是「与官方不再逐字相同」，
 * **不是被拒**（实测假值 200）。要改就改这一处。
 */
export const RACCOON_GRANT_HEADERS                                   = Object.freeze({
  'x-client-platform': 'desktop-windows',
  'x-client-version': '1.1.3',
})

/**
 * 客户端的 `auth.json` 候选路径（**按顺序**试，第一个存在的赢）。
 *
 * 为什么是这四条：客户端自己的解析逻辑是
 * `BOX_AGENT_CONFIG_DIR || join(BOX_AGENT_HOME || join(homedir, '.box-agent'), 'config')`
 * （`build/electron/main/agent/boxAgentProfilePath.js` +
 * `boxAgentAuthFile.js` 的 `getBoxAgentAuthPath`）。而 Office 客户端实际把
 * `BOX_AGENT_HOME` 指到 `<userData 的兄弟目录>/agent`，本机实测就是
 * `~/.office-raccoon/agent`。所以前两条覆盖「环境变量被设过」的情况，
 * 后两条覆盖「没设环境变量」的两种历史布局。
 */
export const RACCOON_AUTH_FILE_CANDIDATES                    = [
  ...(process.env.BOX_AGENT_CONFIG_DIR ? [join(process.env.BOX_AGENT_CONFIG_DIR, 'auth.json')] : []),
  ...(process.env.BOX_AGENT_HOME ? [join(process.env.BOX_AGENT_HOME, 'config', 'auth.json')] : []),
  join(homedir(), '.office-raccoon', 'agent', 'config', 'auth.json'),
  join(homedir(), '.box-agent', 'config', 'auth.json'),
]

/** 上游业务码 → 稳定分类（实测过的几个，见文件头）。 */
export const RACCOON_BUSINESS_CODES                                      = Object.freeze({
  /** `authorization empty` —— 没带 token。 */
  200001: 'auth',
  /** `authorization invalid` —— 带了但是空串/畸形。 */
  200002: 'auth',
  /** `authorization verify failed` —— 签名/过期不对。 */
  200003: 'auth',
  /** `org_code empty` —— 企业号缺组织头（个人账号不该发这个头）。 */
  200020: 'bad_request',
  /** `org not found` —— 组织不存在（同上）。 */
  200022: 'bad_request',
  /** `param platform empty` —— 缺必填参数。 */
  100001: 'bad_request',
})

/** 模型目录缓存 TTL。目录变更很慢，10 分钟足够，且它要打一次上游。 */
const CATALOG_TTL_MS = 10 * 60 * 1000

/** 目录里「官方客户端隐藏」的模型前缀（`raccoon-*` 是内部自动路由用的档位）。 */
const INTERNAL_MODEL_PREFIX = /^raccoon-/

/**
 * 每个模型是否**真的会吐思维链** —— 按本机实测填，不按 tag 猜。
 *
 * 为什么不能看目录里的 `tags`：`sn-sensenova-6-8-flash` 的 tags 里**没有**
 * `reasoning`，但实测带 `reasoning_effort: high` 时回了 216 字符
 * `reasoning_content`；反过来 `raccoon-*` 三个的 tags 里**有** `reasoning`
 * 或 `analysis`，实测思维链**恒为 0**（它们是内部自动路由档，走的是「直出」）。
 * 所以这张表只能是实测结论。
 */
const REASONING_CAPABLE                                    = Object.freeze({
  'raccoon-8c4485': false,
  'raccoon-19b265': false,
  'raccoon-405a1c': false,
  'sn-sensenova-6-8-flash': true,
  'sn-sensenova-6-8-flash-lite': true,
  'sn-glm-5-3': true,
  'sn-kimi-k3': true,
  'sn-glm-5-3-flash': true,
  'sn-deepseek-v4-1-flash': true,
  'sn-deepseek-v4-1-flash-1017': true,
})

/**
 * 接受 `image_url` 的模型 —— 同样只认实测。
 *
 * 实测：`sn-deepseek-v4-1-flash-1017` + 1×1 PNG data URI → 200；
 * `sn-glm-5-3` 同请求 → 400（`rejected by an internal MaaS component`）。
 * 其余 8 个没测过 ⇒ **不标**（`inputModalities` 缺省 = 只有文本，
 * 这是安全的缺省：DSH 不会把图片塞进一个不收图片的模型）。
 */
const VISION_CAPABLE                      = new Set(['sn-deepseek-v4-1-flash-1017'])

/** 能力声明。`source: 'static'` 是因为**每一项都本机实测过**，不是照文档填的。 */
const CAPABILITIES                    = {
  checkIn: true,
  quota: true,
  models: true,
  // 上游没有「活动任务」体系：签到就是登录积分发放，没有可领的任务列表。
  tasks: false,
  chat: true,
  reasoning: true,
  // 没有 token 一律 401（实测），不是免账号平台。
  accountFree: false,
  /**
   * usage 帧比 `finish` 晚 **472 … 3744ms**（本机 8 次采样，均值 ≈ 2.4s）。
   *
   * 上游在网关侧要等计费算完才补这一帧，所以窗口必须比默认的 250ms 宽，
   * 否则 token 统计**永远收不到**（日志里输入/输出/速度三列恒为 `—`）。
   * 取 5000ms：比实测最大值（3744ms）多三成余量。
   *
   * ⚠️ 这只是**上限**。上游发完 usage 紧接着就 `[DONE]` 并关连接，
   * 循环自然结束，正常情况下用户感觉不到任何额外等待。
   */
  usageDrainMs: 5000,
  source: 'static',
  notes: {
    checkIn:
      '等价于客户端登录时领积分：`POST /api/web/desktop/v1/login/points/grant`。' +
      '返回 `granted: true` 表示今天真领到了（带 `popup` 文案）；`granted: false` 表示今天没有可领的。',
    quota: '积分余额来自 `/api/web/points/v1/balance`，单位是积分（points）。',
    models:
      '模型目录来自 `/api/web/llm/v2/model_catalog`，倍率取 `billing_effective_multiplier`（实付）。' +
      '`raccoon-*` 三个是官方客户端隐藏的内部自动路由档，仍然可调。',
    tasks: '上游没有独立的活动任务接口（登录积分发放就是唯一的每日领取），这一项不适用。',
    chat: 'OpenAI 兼容 SSE，正文、思维链（`reasoning_content`）、工具调用全部透传。',
    reasoning:
      '`reasoning_effort` 的合法值就是 OpenAI 那 8 个规范名（上游 serde 枚举硬校验），' +
      '所以档位翻译是恒等映射；但**每个模型是否真的多想**差异很大，已按实测标注。',
    login:
      '登录和客户端走同一条路：本机临时回环 + 授权码（`/authorize?desktop_callback=loopback`）。' +
      '点一下 → 浏览器里登录 → 回来自动建账号，**不装客户端也能用**。' +
      '没填 token 时仍会回落到读客户端的 `auth.json`。' +
      '令牌是 30 天有效的 IAM JWT，服务端没有可用的续期（refresh 只会换回同一个令牌），到期重新登录即可。',
    credentials:
      '可留空（登录后自动落盘）；也可以手工粘贴客户端请求头里 `Authorization: Bearer` 后面那串。',
  },
}

// ───────────────────────────── 纯函数（可单测） ─────────────────────────────

/** 从 `auth.json` 里取 access token（认客户端用的三个别名）。 */
export function readRaccoonTokenFromAuthFile(raw         )                     {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw                           
  for (const key of ['access_token', 'token', 'auth_token']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * 读客户端的 `auth.json`。
 *
 * **只读，不写**：本插件不碰客户端的任何文件，token 过期由客户端自己刷新，
 * 插件下次读到的自然就是新值。读不到返回 undefined（不抛错）。
 */
export function readRaccoonClientToken(
  candidates                    = RACCOON_AUTH_FILE_CANDIDATES,
)                                              {
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const token = readRaccoonTokenFromAuthFile(JSON.parse(readFileSync(path, 'utf8')))
      if (token !== undefined) return { token, path }
    } catch {
      // 文件被占用 / 半写入 / 不是 JSON：换下一个候选，不打扰用户。
    }
  }
  return undefined
}

/**
 * 解 JWT 的 `exp`（秒）→ 毫秒时间戳。
 *
 * 只用于**在界面上显示有效期**，不做任何信任判断（签名校验在上游）。
 * 解不出来返回 undefined。
 */
export function jwtExpiresAtMs(token        )                     {
  const parts = token.split('.')
  if (parts.length < 2 || parts[1] === undefined || parts[1] === '') return undefined
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const payload          = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (payload === null || typeof payload !== 'object') return undefined
    const exp = (payload                     ).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    return Math.round(exp * 1000)
  } catch {
    return undefined
  }
}

// ───────────────────── 登录：本机回环 + 授权码（照抄客户端的 OAuth 流程） ─────────────────────

/** 回环回调路径。与客户端 loopback 模式逐字一致（`webLoginLoopback.js`）。 */
export const RACCOON_LOOPBACK_PATH = '/auth/callback'

/** 授权页上显示的应用名。取自客户端 `shared/client/web-login.js` 的 `appName`。 */
export const RACCOON_LOGIN_APP_NAME = '商汤小浣熊客户端'

/** 登录会话有效期（秒）。客户端给回环窗口 5 分钟，这里对齐。 */
export const RACCOON_LOGIN_EXPIRES_SEC = 300

/** 授权码换令牌（web 那套接口，不是 `/api/iam/v1`）。 */
export const RACCOON_CODE_EXCHANGE_PATH = '/api/web/auth/v1/login_with_authorization_code'

/**
 * 拼 `/authorize` 链接。
 *
 * 五个参数**逐字照抄**客户端 `desktopLoginUrl()` + `startLoopback()`：
 * `login_source=desktop`、`appname`、`desktop_callback=loopback`、`state`、`redirect`。
 *
 * ⚠️ 少了 `desktop_callback=loopback` 会怎样（2026-10-28 实测踩到）：
 * 服务端按「自定义协议 `office-raccoon://`」那条路处理，回调里**只回 state、不回 code**，
 * 浏览器停在「缺少 code」。补上之后一次通过。
 */
export function buildRaccoonAuthorizeUrl(
  redirect        ,
  state        ,
  appName         = RACCOON_LOGIN_APP_NAME,
)         {
  const params = new URLSearchParams({
    login_source: 'desktop',
    appname: appName,
    desktop_callback: 'loopback',
    state,
    redirect,
  })
  return `${RACCOON_ORIGIN}/authorize?${params.toString()}`
}

/**
 * 解一次回调。
 *
 * 返回三种结果，调用方必须分得清：
 *   - `null`     —— 这不是给我们的请求（路径不对 / state 对不上）；
 *   - `{ error }` —— 是我们的请求，但上游明确报错或没给 code；
 *   - `{ code }`  —— 可以拿去换了。
 *
 * state 先比长度再 `timingSafeEqual`：长度不等时 `timingSafeEqual` 会抛 `RangeError`，
 * 直接比就是给自己埋一个崩溃点。
 */
export function parseRaccoonCallback(
  rawUrl        ,
  path        ,
  expectedState        ,
)                                              {
  let url     
  try {
    url = new URL(rawUrl, 'http://127.0.0.1')
  } catch {
    return null
  }
  if (url.pathname !== path) return null
  const failure = url.searchParams.get('error') ?? ''
  if (failure !== '') {
    const description = url.searchParams.get('error_description') ?? ''
    return { error: `${failure} ${description}`.trim() }
  }
  const state = url.searchParams.get('state') ?? ''
  if (state.length !== expectedState.length) return null
  try {
    if (!timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) return null
  } catch {
    return null
  }
  const code = (url.searchParams.get('code') ?? '').trim()
  if (code === '') return { error: '回调里没有 code（授权没完成或被上游丢掉）' }
  return { code }
}

/** 一个只监听 127.0.0.1 的一次性回调接收器。 */
                                  
                                     
                           
                                                 
              
                         
               
                        
               
 

/**
 * 起一个临时回环服务接授权码。
 *
 * 三个刻意的约束（都是为了不给自己开洞）：
 *   1. **只绑 127.0.0.1**，端口交给系统分配（客户端也是 `listen(0)`）——
 *      固定端口会跟真客户端抢，绑 0.0.0.0 则是把回调暴露给局域网；
 *   2. **只认 `GET` + 指定路径 + 正确 state**，其余一律 404，不回任何信息；
 *   3. **一次性**：收到 code 或出错就关，之后再来请求就是连接被拒。
 */
export async function startRaccoonLoopback(options   
               
               
                    
 )                           {
  const path = options.path ?? RACCOON_LOOPBACK_PATH
  const timeoutMs = options.timeoutMs ?? RACCOON_LOGIN_EXPIRES_SEC * 1000
  const receiver = { code: '', error: '', closed: false }
  let close             = () => { /* 还没 listen 完就被关的情况由下面兜住 */ }
  let timer                                           

  const finish = ()       => {
    if (receiver.closed) return
    receiver.closed = true
    if (timer !== undefined) clearTimeout(timer)
    close()
  }

  const server = createServer((request, response) => {
    const parsed = request.method === 'GET'
      ? parseRaccoonCallback(request.url ?? '/', path, options.state)
      : null
    if (parsed === null) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    const ok = 'code' in parsed
    if (ok) receiver.code = parsed.code
    else receiver.error = parsed.error
    response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>商汤小浣熊</title>`
      + `<body style="font:16px/1.7 system-ui;padding:48px;max-width:640px;margin:auto">`
      + `<h1 style="font-size:20px">${ok ? '登录成功' : '登录失败'}</h1>`
      + `<p>${ok ? '账号已交给 DSH，可以关闭这个页面。' : '请回到 DSH 重新发起登录。'}</p></body></html>`,
    )
    setImmediate(finish)
  })

  await new Promise      ((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('本机回环端口分配失败')
  }
  close = ()       => {
    try {
      server.close()
      // Node 18.2+：不主动断开的话，浏览器那条 keep-alive 连接会让 close 一直挂着。
      ;(server                                                   ).closeAllConnections?.()
    } catch {
      // 已经关了就算了。
    }
  }
  timer = setTimeout(finish, timeoutMs)
  timer.unref?.()
  server.unref()

  return {
    redirect: `http://127.0.0.1:${address.port}${path}`,
    get code() {
      return receiver.code
    },
    get error() {
      return receiver.error
    },
    close: finish,
  }
}

/** 目录里的一条模型（只声明我们会读的字段）。 */
                                      
                
                       
                   
                               
                
                         
                                                             
                              
                                        
                          
                               
 

/** `model_catalog` 的响应外壳。 */
                                        
                
                                                                                              
 

/**
 * 解析模型目录 → 归一化列表。
 *
 * ## 两条与官方客户端一致的口径
 *
 * 1. **只取 `type === 'chat'` 的那一类**（目录里目前只有它，但客户端是这么筛的）；
 * 2. **`default_model` 必须在列表里**，否则退回第一个 —— 客户端
 *    `normalizeLocalAgentRoutingCatalog` 同样这么兜。
 *
 * ## 倍率取 `billing_effective_multiplier` 而不是 `billing_multiplier`
 *
 * 前者是**实付**（含折扣），后者是**标价**。实测两者在 `sn-glm-5-3` 上不同
 * （标价与实付都有 0.75 的档），只有实付能回答用户真正关心的「这一轮扣多少」。
 * 两者都没有时**不写 `multiplier`**（= 未知），绝不写 0（0 在我们的口径里是「免费」）。
 */
export function parseRaccoonCatalog(payload         )   
                       
                               
              {
  if (payload === null || typeof payload !== 'object') return undefined
  const body = payload                         
  if (body.code !== undefined && body.code !== 0) return undefined
  const categories = Array.isArray(body.data?.categories) ? body.data.categories : []
  const chat = categories.find((item) => item !== null && typeof item === 'object' && item.type === 'chat')
  if (chat === undefined) return undefined
  const rows = Array.isArray(chat.models) ? chat.models : []
  const models = rows.filter(
    (item)                              => item !== null && typeof item === 'object',
  )
  if (models.length === 0) return undefined
  const declaredDefault = typeof chat.default_model === 'string' ? chat.default_model.trim() : ''
  const names = models.map((item) => (typeof item.name === 'string' ? item.name.trim() : ''))
  const defaultModel = declaredDefault !== '' && names.includes(declaredDefault)
    ? declaredDefault
    : names.find((name) => name !== '')
  return defaultModel === undefined ? { models } : { defaultModel, models }
}

/** 取一个有限的非负数（上游有时给字符串）。 */
function finiteNumber(value         )                     {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** 取一个正整数（上下文长度 / max_tokens 用）。 */
function positiveInt(value         )                     {
  const num = finiteNumber(value)
  return num !== undefined && Number.isInteger(num) && num > 0 ? num : undefined
}

/**
 * 目录行 → `ModelMeta`。
 *
 * ⚠️ **`multiplier: 0` 与 `multiplier: undefined` 是两件事**：
 * 上游 `billing_effective_multiplier` 实测有 `0`（`sn-sensenova-6-8-flash`、
 * `sn-deepseek-v4-1-flash-1017`），那**真的免费**；字段缺失才是「未知」。
 * 所以这里只在上游给了数时写这个键，缺失时**整个键不出现**。
 */
export function toRaccoonModelMeta(
  row                     ,
  agentId        ,
  agentName        ,
  now        ,
)                        {
  const id = typeof row.name === 'string' ? row.name.trim() : ''
  if (id === '') return undefined
  const display = typeof row.description === 'string' && row.description.trim() !== ''
    ? row.description.trim()
    : id
  const meta            = {
    id,
    name: display,
    agentId,
    agentName,
    updatedAt: now,
  }
  const hint = typeof row.display_description === 'string' ? row.display_description.trim() : ''
  if (hint !== '') meta.description = hint
  const contextWindow = positiveInt(row.params?.context_window)
  if (contextWindow !== undefined) meta.contextWindow = contextWindow
  const maxTokens = positiveInt(row.params?.max_tokens)
  if (maxTokens !== undefined) meta.maxTokens = maxTokens
  const multiplier = finiteNumber(row.billing_effective_multiplier)
  if (multiplier !== undefined) {
    meta.multiplier = multiplier
    meta.multiplierSource = 'raccoon:model_catalog'
    // 实付 0 = 真的免费。这条**只在有明确数值时**成立，字段缺失时不是免费。
    if (multiplier === 0) meta.free = true
  }
  // 档位：上游参数层接受全部 8 个规范名（见文件头），所以如实声明。
  meta.reasoningEfforts = [...CANONICAL_REASONING_EFFORTS]
  const capable = REASONING_CAPABLE[id]
  if (capable !== undefined) meta.reasoning = capable
  if (VISION_CAPABLE.has(id)) meta.inputModalities = ['text', 'image']
  /**
   * 官方客户端隐藏的内部自动路由档：**仍然上报**（它们真的可调），
   * 但在描述里说清楚，免得用户以为这是给人选的模型。
   */
  if (INTERNAL_MODEL_PREFIX.test(id)) {
    const prefix = '官方客户端隐藏的内部自动路由档（仍可直接调用）'
    meta.description = meta.description === undefined ? prefix : `${prefix}｜${meta.description}`
  }
  return meta
}

/**
 * 业务错误体 → 稳定分类。
 *
 * 上游的错误体是 `{code, message, details}` 三件套（`message` 是英文 snake_case
 * 标识符，`details` 是人话）。`code` 是**数字业务码**，与 HTTP 状态码**无关**
 * —— 实测所有鉴权失败都是 **HTTP 401 + code 2000xx**，但同一个 code 也可能
 * 出现在 200 的响应体里（客户端代码里 `payload?.code !== 0` 就抛错）。
 *
 * 所以判据顺序：**先认业务码**（精确），认不出再交给核心的 `classify()`
 * （按状态 + 文案）。返回 undefined 表示「本适配器没有更强的判断」。
 */
export function classifyRaccoonBody(body         )                        {
  if (body === null || typeof body !== 'object') return undefined
  const code = finiteNumber((body                      ).code)
  if (code === undefined) return undefined
  if (code === 0) return 'none'
  return RACCOON_BUSINESS_CODES[code]
}

/** 从错误体里抽一句能直接给用户看的话（优先 `details`，其次 `message`）。 */
export function describeRaccoonError(body         )                     {
  if (body === null || typeof body !== 'object') return undefined
  const record = body                                                            
  const detail = typeof record.details === 'string' ? record.details.trim() : ''
  const message = typeof record.message === 'string' ? record.message.trim() : ''
  const code = finiteNumber(record.code)
  const head = code === undefined ? '' : `[${code}] `
  if (detail !== '' && message !== '') return `${head}${message}：${detail}`
  if (detail !== '') return `${head}${detail}`
  if (message !== '') return `${head}${message}`
  return undefined
}

/** 从余额响应里取可用积分。 */
export function parseRaccoonBalance(body         )   
                    
                
                 
                
                                 
  {
  if (body === null || typeof body !== 'object') return {}
  const root = body                                      
  if (root.code !== undefined && root.code !== 0) return {}
  const data = root.data
  if (data === null || typeof data !== 'object') return {}
  const record = data                           
  const out                                         = { extra: { ...record } }
  const available = finiteNumber(record.available_points)
  if (available !== undefined) out.available = available
  const daily = finiteNumber(record.daily_points)
  if (daily !== undefined) out.daily = daily
  const reward = finiteNumber(record.reward_points)
  if (reward !== undefined) out.reward = reward
  const topup = finiteNumber(record.topup_points)
  if (topup !== undefined) out.topup = topup
  return out
}

/** 拼绝对 URL（已经是 http(s) 开头的原样返回）。 */
function absolute(base        , path        )         {
  if (/^https?:\/\//i.test(path)) return path
  const trimmed = base.replace(/\/+$/, '')
  return `${trimmed}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 把签到响应里的 `popup` 抽成一句人话。
 *
 * ## 为什么这里必须防御式写
 *
 * 本机实测拿到的只有 `popup: null`（今天已领过）。`granted: true` 时它长什么样
 * **没有样本** —— 客户端代码里是 `emit(SHOW_POINT_GRANT_POPUPS, [popup])`，
 * 说明它至少能是个对象（弹框数据），但这不等于它不会是字符串。
 *
 * 所以：字符串直接用；对象里找常见的文案字段；认不出就返回 undefined
 * （调用方退回「已领取今日登录积分」），**绝不 `String(popup)`** ——
 * 那会把 `[object Object]` 糊到用户脸上。
 */
export function describePopup(popup         )                     {
  if (typeof popup === 'string') {
    const trimmed = popup.trim()
    return trimmed === '' ? undefined : trimmed
  }
  if (popup === null || typeof popup !== 'object' || Array.isArray(popup)) return undefined
  const record = popup                           
  for (const key of ['title', 'text', 'message', 'content', 'desc', 'description']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

// ───────────────────────────── 适配器 ─────────────────────────────

export class RaccoonAdapter extends BaseAdapter {
  /**
   * 客户端 `auth.json` 的候选路径。
   *
   * 做成构造参数**不是**为了好看：默认值会去读本机真实文件，单测若不能替换它，
   * 「没填 token」这条路径就永远测不到（本机装了客户端 ⇒ 永远读得到）。
   * 顺便也让高级用户能指到自定义安装位置。
   */
                   authFileCandidates                   

  constructor(options                                             = {}) {
    super({
      id: 'raccoon',
      name: '商汤小浣熊',
      doc: 'https://xiaohuanxiong.com',
      credentialHint:
        '可留空 —— 本插件会自动读商汤小浣熊客户端的登录态。也可以手工粘贴客户端请求头里 `Authorization: Bearer` 后面那串。',
      capabilities: CAPABILITIES,
      implemented: true,
    })
    this.authFileCandidates = options.authFileCandidates ?? RACCOON_AUTH_FILE_CANDIDATES
  }

  // ───────────────────── 凭证 ─────────────────────

  /**
   * 取可用 token：**账号里填的优先，没填就去读客户端**。
   *
   * 顺序刻意如此：用户显式填了就以他为准（多账号场景下每个人贴各自的 token），
   * 只有空着时才回落到客户端登录态。这样「零配置可用」与「多账号可控」不打架。
   */
          resolveToken(record               , ctx                )                                         {
    const explicit = typeof record.credentials.token === 'string' ? record.credentials.token.trim() : ''
    if (explicit !== '') return { token: explicit, fromClient: false }
    const client = readRaccoonClientToken(this.authFileCandidates)
    if (client !== undefined) {
      ctx.log.debug(`使用客户端登录态：${client.path}`, `account=${record.id}`)
      return { token: client.token, fromClient: true }
    }
    return { token: '', fromClient: false }
  }

           async getCredentials(record               , ctx                )                              {
    const { token } = this.resolveToken(record, ctx)
    const out                     = { ...record.credentials, token }
    // 顺手把过期时间写出来，界面上能直接看出「还有几天」。解不出来就不写。
    const expiresAt = token === '' ? undefined : jwtExpiresAtMs(token)
    if (expiresAt !== undefined) out.expiresAt = expiresAt
    return out
  }

  /**
   * 凭证 → 请求头。
   *
   * 三条都**逐字对齐**官方客户端（见 `RACCOON_USER_AGENT` 的实测对比）：
   *   - `user-agent: node` —— 盖掉 `core/http.ts` 的 `dsh-multi-agent-gateway/*` 默认值；
   *   - **不发** `X-Client-*` —— 客户端在目录 / 余额 / 对话上也不发；
   *   - **不发** `X-Org-Code` —— 个人号发了会 400 `org_not_found_error`。
   */
          headersOf(token        , accept = 'application/json')                         {
    return mergeHeaders(
      { accept, 'user-agent': RACCOON_USER_AGENT },
      token === '' ? {} : { authorization: `Bearer ${token}` },
    )
  }

  /**
   * 校验凭证：问一次 `/api/web/points/v1/balance`。
   *
   * 为什么用它而不是 `/user_info`：两者都轻，但余额接口**顺带把额度带回来了**，
   * 一次请求干两件事；而 `user_info` 只回身份。另外它是**只读**的（不会像
   * `login/points/grant` 那样改变服务端状态），做「测活」安全。
   */
           async validateCredentials(
    record               ,
    ctx                ,
  )                                                               {
    const { token, fromClient } = this.resolveToken(record, ctx)
    if (token === '') {
      return {
        ok: false,
        message:
          missingCredentialReason(this.name, 'token') +
          '（也没在本机找到商汤小浣熊客户端的登录态 —— 请先打开客户端登录一次，或手工粘贴 token）',
        kind: 'auth',
      }
    }
    const url = absolute(ctx.config.upstream.apiBaseUrl || RACCOON_ORIGIN, RACCOON_PATHS.balance)
    const result = await ctx.http(url, { headers: this.headersOf(token) })
    if (!result.ok) {
      const kind = classifyRaccoonBody(result.body) ?? (result.kind === 'none' ? 'auth' : result.kind)
      return {
        ok: false,
        message: describeRaccoonError(result.body) ?? result.message ?? `HTTP ${result.status}`,
        kind,
      }
    }
    const balance = parseRaccoonBalance(result.body)
    const source = fromClient ? '（自动读取客户端登录态）' : ''
    const left = balance.available === undefined ? '' : `，可用积分 ${balance.available}`
    return { ok: true, message: `凭证可用${source}${left}` }
  }

  /** 拿 token 问一次 `/user_info`，取一个能当账号标签的字符串。 */
          async labelForToken(token        , ctx                )                              {
    const url = absolute(ctx.config.upstream.apiBaseUrl || RACCOON_ORIGIN, RACCOON_PATHS.userInfo)
    const result = await ctx.http(url, { headers: this.headersOf(token), timeoutMs: 15_000 })
    if (!result.ok || result.body === null || typeof result.body !== 'object') return undefined
    const data = (result.body                      ).data
    if (data === null || typeof data !== 'object') return undefined
    const record2 = data                                                     
    for (const value of [record2.name, record2.phone, record2.id]) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
    return undefined
  }

  // ───────────────────── 登录：本机回环 + 授权码（与客户端同一条路） ─────────────────────

  /**
   * 发起登录：起本机回环、给出 `/authorize` 链接。
   *
   * ## 为什么改成这条路（推翻上一版的判断）
   *
   * 上一版写的是「本平台没有公开的 OAuth 端点，硬造设备码就是伪造客户端」，
   * 于是退成「打开 `/login` + 盯客户端写的 `auth.json`」。**那个判断错在把
   * 「没有设备码」当成「没有可用的授权方式」**：客户端用的是最标准的
   * **授权码 + 本机回环重定向**（RFC 8252 给原生应用定的那套），`/authorize`、
   * `state`、`redirect` 全在 URL 上，不需要任何签名或 client_secret，谈不上伪造。
   *
   * 2026-10-28 实测走通：回环收到 46 字符 code → 换出 432 字符 IAM 令牌 →
   * 令牌打 `/points/v1/balance` 200。**不装客户端也能登录。**
   *
   * ## 两个参数少一个就废
   *
   * `login_source=desktop` 与 `desktop_callback=loopback`（见
   * `buildRaccoonAuthorizeUrl`）—— 少 `desktop_callback` 时服务端按自定义协议处理，
   * 回调只回 state 不回 code，页面停在「缺少 code」。
   */
  async beginLogin(ctx                )                            {
    const expectedState = randomBytes(32).toString('hex')
    try {
      const loopback = await startRaccoonLoopback({ state: expectedState })
      ctx.log.info('已启动本机回环登录，等待浏览器回调', loopback.redirect)
      return {
        authUrl: buildRaccoonAuthorizeUrl(loopback.redirect, expectedState),
        expiresInSec: RACCOON_LOGIN_EXPIRES_SEC,
        // 回环句柄塞进 state：宿主只存在内存里，永远不回浏览器。
        state: { startedAt: Date.now(), expectedState, loopback },
      }
    } catch (error) {
      // 端口被禁 / 沙箱不允许 listen：退回「打开登录页 + 读客户端登录态」。
      ctx.log.warn(
        '本机回环起不来，退回「打开登录页 + 读客户端登录态」',
        error instanceof Error ? error.message : String(error),
      )
      return {
        authUrl: `${RACCOON_ORIGIN}/login`,
        expiresInSec: 600,
        state: { startedAt: Date.now() },
      }
    }
  }

  /**
   * 问一次结果。
   *
   * 按 state 的形状分两条路：
   *   - **有 `loopback`**：新流程。收到 code 就换令牌，没到就 pending；
   *   - **没有**：兜底流程（回环起不来时），读客户端 `auth.json`。
   *
   * ⚠️ 这里**不校验令牌是否还有效**（那要多打一次上游）。真正的有效性在账号加进来
   * 之后的「测活」里验 —— 那时用户已经在看结果，失败原因也能落到账号行上。
   */
  async pollLogin(state         , ctx                )                           {
    const session = (state ?? {})                                                       
    const loopback = session.loopback
    if (loopback !== undefined) {
      if (loopback.error !== '') {
        const reason = loopback.error
        loopback.close()
        return { status: 'failed', message: `授权页返回错误：${reason}` }
      }
      if (loopback.code === '') {
        const waited = typeof session.startedAt === 'number'
          ? Math.round((Date.now() - session.startedAt) / 1000)
          : 0
        return {
          status: 'pending',
          message:
            '已在本机开好回调端口，请在浏览器里打开授权页并登录。' +
            (waited > 0 ? `（已等待 ${waited} 秒）` : ''),
        }
      }
      const code = loopback.code
      loopback.close()
      const exchanged = await this.exchangeAuthorizationCode(code, ctx)
      if ('error' in exchanged) return { status: 'failed', message: exchanged.error }
      const expiresAt = jwtExpiresAtMs(exchanged.token)
      const label = await this.labelForToken(exchanged.token, ctx)
      const left = expiresAt === undefined ? '' : `，有效期至 ${new Date(expiresAt).toISOString().slice(0, 10)}`
      ctx.log.info(`授权码登录成功${left}`)
      return {
        status: 'ready',
        message: `登录成功${left}`,
        credentials: { token: exchanged.token, ...(expiresAt === undefined ? {} : { expiresAt }) },
        ...(label === undefined ? {} : { label }),
      }
    }

    const startedAt = session.startedAt
    const client = readRaccoonClientToken(this.authFileCandidates)
    if (client === undefined) {
      const waited = typeof startedAt === 'number' ? Math.round((Date.now() - startedAt) / 1000) : 0
      return {
        status: 'pending',
        message:
          '还没在本机找到客户端的登录态。请在浏览器里完成登录；' +
          '如果你用的是**网页版**（不是桌面客户端），它不会写这个文件 —— 那就手工把 token 粘到账号里。' +
          (waited > 0 ? `（已等待 ${waited} 秒）` : ''),
      }
    }
    const label = await this.labelForToken(client.token, ctx)
    const expiresAt = jwtExpiresAtMs(client.token)
    const left = expiresAt === undefined ? '' : `，有效期至 ${new Date(expiresAt).toISOString().slice(0, 10)}`
    ctx.log.info(`已读取客户端登录态${left}`, client.path)
    return {
      status: 'ready',
      message: `已读取商汤小浣熊客户端登录态${left}`,
      credentials: { token: client.token, ...(expiresAt === undefined ? {} : { expiresAt }) },
      ...(label === undefined ? {} : { label }),
    }
  }

  /**
   * 授权码换令牌。
   *
   * 端点与字段名取自客户端 `accountRequests.js`（`loginWithAuthorizationCode`）：
   * `POST /api/web/auth/v1/login_with_authorization_code {authorization_code}` →
   * `{ code: 0, data: { access_token, refresh_token } }`。
   *
   * ⚠️ **`refresh_token` 是个摆设**：实测它与 `access_token` 一字不差，拿它去打
   * `/api/web/auth/v1/refresh` 只会原样换回同一个令牌（`exp` 不变）。
   * 所以这里**故意不存** refreshToken —— 存了会让人以为能自动续期。
   */
          async exchangeAuthorizationCode(
    code        ,
    ctx                ,
  )                                                 {
    const url = absolute(ctx.config.upstream.apiBaseUrl || RACCOON_ORIGIN, RACCOON_CODE_EXCHANGE_PATH)
    const result = await ctx
      .http(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': RACCOON_USER_AGENT,
        },
        body: JSON.stringify({ authorization_code: code }),
        timeoutMs: 20_000,
      })
      .catch(() => null)
    if (result === null) return { error: '换取令牌失败：请求没有发出去' }
    const body = result.body                                                                
    if (body === null || typeof body !== 'object') {
      return { error: `换取令牌失败：HTTP ${result.status}` }
    }
    if (Number(body.code) !== 0) {
      return { error: describeRaccoonError(result.body) ?? `换取令牌失败：HTTP ${result.status}` }
    }
    const token = body.data?.access_token
    if (typeof token !== 'string' || token === '') {
      return { error: '换取令牌失败：响应里没有 access_token' }
    }
    return { token }
  }

  // ───────────────────── 每日签到（登录积分发放） ─────────────────────

  /**
   * 每日签到 = 客户端登录时的积分发放。
   *
   * ## 为什么 `granted: false` 判成「今天已处理」而不是「等会再试」
   *
   * 这是**按天发放**的一次性事件（客户端每次启动都会 POST 一次，服务端自己保证
   * 幂等）。`granted: false` 的两种可能（今天已领过 / 该账号不参与）**都不是
   * 等一会儿就会变的**，所以 `coversToday: true` —— 否则插件会当天反复打这个
   * 接口，纯属给自己招风控。
   *
   * ⚠️ 但**不谎报领到**：`ok` 只在真的 `granted: true` 时为真，
   * 消息里原样说清是哪一种，并把上游给的 `popup` 文案带出来。
   */
           async checkIn(record               , ctx                )                         {
    const { token } = this.resolveToken(record, ctx)
    if (token === '') {
      return {
        ok: false,
        supported: true,
        message: missingCredentialReason(this.name, 'token'),
        kind: 'auth',
        at: Date.now(),
      }
    }
    const url = absolute(ctx.config.upstream.apiBaseUrl || RACCOON_ORIGIN, RACCOON_PATHS.loginGrant)
    const result = await ctx.http(url, {
      method: 'POST',
      // 只有这一个接口带 `X-Client-*`（客户端就是只在它上面带，见 RACCOON_GRANT_HEADERS）。
      headers: mergeHeaders(
        this.headersOf(token),
        { 'content-type': 'application/json' },
        RACCOON_GRANT_HEADERS                          ,
      ),
      body: '{}',
    })
    if (!result.ok) {
      return {
        ok: false,
        supported: true,
        message: describeRaccoonError(result.body) ?? result.message ?? `HTTP ${result.status}`,
        kind: classifyRaccoonBody(result.body) ?? (result.kind === 'none' ? 'unknown' : result.kind),
        at: Date.now(),
      }
    }
    const body = result.body
    if (body === null || typeof body !== 'object') {
      return { ok: false, supported: true, message: '上游返回的不是对象，无法判断是否领到', kind: 'unknown', at: Date.now() }
    }
    const payload = body                                                                     
    if (payload.code !== undefined && payload.code !== 0) {
      return {
        ok: false,
        supported: true,
        message: describeRaccoonError(body) ?? `业务码 ${String(payload.code)}`,
        kind: classifyRaccoonBody(body) ?? 'unknown',
        at: Date.now(),
      }
    }
    const granted = payload.data?.granted === true
    /**
     * `popup` 的**形状没有实测样本**（本机今天已经领过，只见到 `popup: null`）。
     * 所以这里只做防御式提取，**不假设**它是字符串还是对象 ——
     * 认不出就不带，绝不把 `[object Object]` 糊到界面上。
     */
    const popup = describePopup(payload.data?.popup)
    if (granted) {
      return {
        ok: true,
        supported: true,
        message: popup === undefined ? '已领取今日登录积分' : `已领取今日登录积分：${popup}`,
        coversToday: true,
        at: Date.now(),
      }
    }
    return {
      ok: false,
      supported: true,
      message:
        '今天没有可领的登录积分（上游 `granted: false` —— 通常是今日已领过，' +
        '也可能是该账号不参与登录积分活动；两种情况重试都不会变）',
      coversToday: true,
      at: Date.now(),
    }
  }

  // ───────────────────── 额度 ─────────────────────

           async getQuota(record               , ctx                )                         {
    const fetchedAt = Date.now()
    const { token } = this.resolveToken(record, ctx)
    if (token === '') {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt,
        error: missingCredentialReason(this.name, 'token'),
      }
    }
    const url = absolute(ctx.config.upstream.apiBaseUrl || RACCOON_ORIGIN, RACCOON_PATHS.balance)
    const result = await ctx.http(url, { headers: this.headersOf(token), timeoutMs: 20_000 })
    if (!result.ok) {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt,
        error: describeRaccoonError(result.body) ?? result.message ?? `HTTP ${result.status}`,
      }
    }
    const balance = parseRaccoonBalance(result.body)
    const snapshot                = { accountId: record.id, unit: 'credits', fetchedAt }
    // `remaining === undefined` 才是「未知」；上游给了 0 就如实给 0。
    if (balance.available !== undefined) snapshot.remaining = balance.available
    if (balance.extra !== undefined) snapshot.extra = balance.extra
    if (balance.available === undefined) snapshot.error = '上游余额响应里没有 available_points 字段'
    return snapshot
  }

  // ───────────────────── 模型目录 ─────────────────────

  /**
   * 模型目录 → `ModelMeta[]`。
   *
   * **不做任何过滤**：目录里有 10 个模型，全部可调（逐个实测 200）。
   * 「上报哪些」是**用户的策略**（`ModelPolicy.mode`），不是适配器该替他决定的事
   * —— 适配器悄悄筛掉模型，用户会以为上游没有那个模型。
   *
   * 唯一会丢掉的是「解析不出名字的行」（`name` 为空），那是畸形数据不是策略。
   */
           async getModelMetaList(record               , ctx                )                       {
    const { token } = this.resolveToken(record, ctx)
    if (token === '') {
      ctx.log.warn(`${this.name} 没有可用 token，本次不返回模型`, `account=${record.id}`)
      return []
    }
    const cacheKey = `raccoon:catalog:${record.id}`
    const cached = ctx.cache.get             (cacheKey)
    if (cached !== undefined) return cached

    const configured = ctx.config.upstream.modelsUrl
    const url = configured !== ''
      ? configured
      : absolute(ctx.config.upstream.apiBaseUrl || RACCOON_ORIGIN, RACCOON_PATHS.catalog)
    const result = await ctx.http(url, { headers: this.headersOf(token), timeoutMs: 20_000 })
    if (!result.ok) {
      ctx.log.warn(
        `拉取${this.name}模型目录失败 —— 选择器里这次不会有这个分组`,
        describeRaccoonError(result.body) ?? result.message ?? `HTTP ${result.status}`,
      )
      return []
    }
    const parsed = parseRaccoonCatalog(result.body)
    if (parsed === undefined) {
      ctx.log.warn(`拉取${this.name}模型目录失败 —— 响应里没有 chat 分类`, '上游可能改了目录结构')
      return []
    }
    const now = Date.now()
    const out              = []
    for (const row of parsed.models) {
      const meta = toRaccoonModelMeta(row, this.id, this.name, now)
      if (meta !== undefined) out.push(meta)
    }
    // 稳定排序：实付倍率升序（免费在前），再按 id。用户找便宜模型时不用自己扫。
    out.sort((left, right) => {
      const multLeft = left.multiplier ?? Number.MAX_SAFE_INTEGER
      const multRight = right.multiplier ?? Number.MAX_SAFE_INTEGER
      if (multLeft !== multRight) return multLeft - multRight
      return left.id.localeCompare(right.id)
    })
    if (out.length > 0) ctx.cache.set(cacheKey, out, CATALOG_TTL_MS)
    ctx.log.debug(`${this.name} 模型目录：${out.length} 个`, `默认 ${parsed.defaultModel ?? '未声明'}`)
    return out
  }

  // ───────────────────── 对话 ─────────────────────

  /**
   * 流式转发一次 chat completion。
   *
   * 与 OpenCode 那份同构（都是 OpenAI 兼容），差别只有三点，且都是**实测结论**：
   *   1. 端点路径是 `/api/web/llm/v2/chat/completions`（不是 `/v1/...`）；
   *   2. **不发** `stream_options`（上游本来就发 usage）；
   *   3. 错误体是 `{code, message, details}` 业务码形态，文案要按业务码翻。
   */
  ;        async *requestChatStream(
    payload             ,
    record               ,
    ctx                ,
    signal             ,
  )                             {
    const { token } = this.resolveToken(record, ctx)
    if (token === '') {
      yield {
        type: 'error',
        failure: { kind: 'auth', message: missingCredentialReason(this.name, 'token'), at: Date.now() },
      }
      return
    }
    const chatBase = ctx.config.upstream.chatBaseUrl || `${RACCOON_ORIGIN}${RACCOON_PATHS.chatBase}`
    const url = `${chatBase.replace(/\/+$/, '')}/chat/completions`
    const headers = mergeHeaders(this.headersOf(token, 'text/event-stream'), {
      'content-type': 'application/json',
    })
    const body                          = { ...payload, model: payload.model, stream: true }
    // 不传 undefined（有的上游把 null 当显式值）。数组里的 undefined 不处理：
    // messages 是调用方的数据结构，改它反而可能踩到别的东西。
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key]
    }
    ctx.log.debug(`→ chat/completions model=${payload.model} account=${record.id}`, `messages=${payload.messages.length}`)

    let response          
    try {
      const send = ctx.fetch ?? fetch
      response = await send(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
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
        // 读不到就算了，状态码已经够分类。
      }
      let parsed          = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // 上游可能返回 HTML 错误页，保留原文。
      }
      const kind = classifyRaccoonBody(parsed) ?? this.detectError(response.status, parsed, response.headers)
      // 与 OpenCode 同一条坑：这里走裸 fetch，绕开了 core/http.ts 的 parseRetryAfter。
      const retryAfterMs = parseRetryAfter(response.headers, Date.now())
      yield {
        type: 'error',
        failure: {
          kind,
          message: describeRaccoonError(parsed) ?? `HTTP ${response.status}`,
          status: response.status,
          // `0` 是合法值（立即重试），只有 undefined 才省略。
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
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

  // ───────────────────── 错误分类 ─────────────────────

  /**
   * 业务码优先，认不出再交给核心分类器。
   *
   * ⚠️ 这里**刻意不把 403 一概判成 auth**：核心的 `classify()` 已经在 403 上
   * 先认额度、再认风控（`core/errors.ts`），本适配器没有比它更强的判据时
   * 就应当让位 —— 自己另写一套必然和流式路径漂移。
   */
  detectError(status        , body         , headers         )            {
    const byCode = classifyRaccoonBody(body)
    if (byCode !== undefined && byCode !== 'none') return byCode
    return super.detectError(status, body, headers)
  }

  // ───────────────────── 活动任务 ─────────────────────

  /**
   * 上游**没有**独立的活动任务接口 —— 登录积分发放就是唯一的每日领取
   * （见 `checkIn`，`capabilities.tasks = false` 已让调度器不排这个任务）。
   *
   * 这里**不覆盖** `fetchAvailableTasks` / `executeTask` / `checkTaskStatus`：
   * `BaseAdapter` 的默认实现已经是「空列表 + 明确说『上游没有这个接口，不是故障』」，
   * 正是我们要的语义。再抄一份只会多一处会漂的文案。
   */
}


//# sourceURL=src/adapters/raccoon.ts