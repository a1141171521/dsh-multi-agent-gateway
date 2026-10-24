/**
 * Qoder / Qoder CN 适配器。
 *
 * 事实与实现全部来自 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/`：
 * `qoder-wasm.ts` / `qoder-machine.ts` / `qoder-product.ts` / `qoder-envelope.ts` /
 * `qoder.ts` 原样搬进 `src/vendor/qoder/`，本文件只做「接到我们的适配器接口」。
 *
 * ## 为什么必须带 WASM
 *
 * 对话走的是**加密端点**（`api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`），
 * 请求体由 WASM 加密，`Authorization` 也是 WASM 生成的
 * `Bearer COSY.<载荷>.<签名>`。用普通 `Bearer <token>` 会直接
 * `403 Signature invalid (101)`。
 *
 * 公开的 OpenAI 兼容端点（`api2-v2.qoder.sh`）只认**通用名**（`qwen-flash`），
 * 而模型目录里的 key（`qfmodel` …）发过去一律 `Unsupported model` ——
 * 所以走公开通道等于没有模型清单。这也是这里坚持用加密通道的原因。
 *
 * ## 凭证要求
 *
 * 需要三样东西：
 *   - `security_oauth_token`（放进账号的 `token` 字段）
 *   - `uid`：从 token 的 JWT 载荷里解（`user_id` / `uid` / `sub`）
 *   - `machine_id`：本插件按账号 id 确定性派生，重启不变
 *
 * 缺 uid 时 WASM 会产出**签名无效**的请求（上游报 `Signature invalid (101)`），
 * 所以这里在发请求前就明确报错，而不是让用户对着 403 猜。
 */

import { createHash } from 'node:crypto'
import { BaseAdapter } from './base.js'
import { iterateSse } from '../core/sse.js'
import { QoderEncryptedInfer } from '../vendor/qoder/qoder-wasm.js'
             
                    
                 
                     
                                      
import {
  QODER_REFRESH_PATH,
  QODER_REQUEST_TIMEOUT_MS,
  applyQoderRefresh,
  buildQoderAuthUrl,
  buildQoderPollUrl,
  createQoderDeviceSession,
  isQoderExpired,
  isQoderRefreshable,
  parseQoderTokenPayload,
  qoderRefreshBody,
} from '../vendor/qoder/qoder.js'
                                                                                   
import { unwrapQoderEnvelopeStream } from '../vendor/qoder/qoder-envelope.js'
import {
  QODER_CAMPAIGNS_PATH,
  QODER_CREDITS_TIMEOUT_MS,
  QODER_USAGE_PATH,
  claimableQoderCampaigns,
  hasClaimedQoderBenefit,
  interpretQoderClaim,
  isQoderNotActivated,
  parseQoderCampaigns,
  parseQoderUsage,
  qoderClaimUrl,
  qoderCreditsHeaders,
  qoderTotalRemaining,
} from '../vendor/qoder/qoder-credits.js'
                                                                      
                                                                         
import { QODER, isVendorModel } from '../vendor/qoder/qoder-product.js'
                                                                                                             
import { hasQoderCampaignRefreshedToday, QODER_CAMPAIGN_REFRESH_HOUR_UTC8 } from '../core/time.js'
             
                
                 
                    
              
              
                
            
            
                
              
                         

/** Qoder CN 的产品常量（与 QODER 的差别只在 host 与目录，见参考实现的注释）。 */
export const QODER_CN               = {
  ...QODER,
  id: 'qodercn',
  displayName: 'Qoder CN',
  authBase: 'https://qoder.com.cn',
  openApiBase: 'https://openapi.qoder.com.cn',
  inferBase: 'https://gateway.qoder.com.cn',
  encryptedInferBase: 'https://gateway.qoder.com.cn',
  defaultCredentialRef: 'QODER_CN_ACCESS_TOKEN',
}

const CAPABILITIES                    = {
  checkIn: true,
  quota: true,
  models: true,
  tasks: false,
  chat: true,
  reasoning: true,
  source: 'static',
  notes: {
    checkIn:
      '每日领取走 /sash/api/v1/me/campaigns；活动每日 10:00（UTC+8）刷新，' +
      `刷新前查询会如实回报「尚未刷新」并带 coversToday=false（当天稍后自动重试）。刷新时刻：${QODER_CAMPAIGN_REFRESH_HOUR_UTC8}:00 UTC+8`,
    quota: '积分余额取 /sash/api/v2/me/usage 的 addOnQuota.remaining（userQuota 实测恒为 0 的占位）',
    models: '模型目录来自产品兜底表（加密目录需 WASM 解密，本期未接）',
    tasks: 'Qoder 的活动就是每日领取，已并入签到；没有独立的「活动任务」接口',
  },
}

/** 单次积分/活动请求的超时（毫秒）；与 vendor 里的常量同源。 */
const QODER_CREDITS_TIMEOUT_MS_FALLBACK = QODER_CREDITS_TIMEOUT_MS

/** 续期提前量：距过期不足这么久就主动换新（与 `opencode.ts` 同口径）。 */
const QODER_REFRESH_MARGIN_MS = 5 * 60_000

/**
 * 「凭证缺少 uid」用的错误分类。
 *
 * ## 为什么**不能**用 `auth`
 *
 * `kind` 会被 `src/llm/adapter.ts` 原样 `toUpperCase()` 成 DSH 的失败码
 * （`:555` / `:811`：`code: event.failure.kind.toUpperCase()`），而 DSH 的
 * `failureMessage()` 对 `AUTH` **有特殊处理** —— 它**丢掉我们写的 message**，
 * 固定显示 `message.failure.auth` 的本地化文案。在 DSH 0.2.x 的 locale 里那是
 * **「API 密钥无效」**（`app.asar` 内 `"message.failure.auth": "API 密钥无效"`），
 * 并且 `displayFailure()` 对 `AUTH` 显式返回 `message: ""`（主动清空原文）。
 *
 * 于是：Qoder **压根没有 API key**（它用的是设备码换来的 `dt-...` 令牌），
 * 而用户被告知「API 密钥无效」—— 既指错方向，又把我们准备好的
 * 「请重新登录这个账号」整句吞掉。这正是用户报障里那句误导文案的来源。
 *
 * ## 为什么选 `bad_request`
 *
 * 「凭证缺 uid」是**本地状态不完整**，需要用户去账号页做一次操作才能修好，
 * 不是上游拒绝、也不是额度/网络问题。逐条排除：
 *
 * | kind | 为什么不合适 |
 * |---|---|
 * | `auth` | **就是它**：DSH 会替换文案成「API 密钥无效」（见上） |
 * | `quota` / `rate_limit` / `server` / `network` | 语义不符；且会让路由器**换号重试**，而换号并不能修复这个账号缺字段的事实 |
 * | `not_found` / `unsupported` | 会被当成「上游没这个能力」，但我们明明有；也永远不该出现 |
 * | `unknown` | 可重试（`isRetryable` 为真），会白试一轮 |
 * | **`bad_request`** | ✅ 语义是「请求（这里指本地请求上下文）本身有问题，**绝不能换号重试**」，`src/core/router.ts:17` 明确写着「不换号的情况：`bad_request`（请求本身错了，换号也一样错）」—— 正好匹配。且 DSH 对 `BAD_REQUEST` **没有**特殊处理（`app.asar` 里 `"BAD_REQUEST"` 出现 0 次），所以我们自己的 message 会**原样显示给用户**。 |
 *
 * ⚠️ 这是**用现有的 kind**，没有新增（新增会牵动 core 与 DSH 映射）。
 */
const QODER_MISSING_UID_KIND            = 'bad_request'


/**
 * 「今天的活动还没刷新」的提示。
 *
 * ⚠️ 必须与 {@link NOT_ACTIVATED_MESSAGE} 分开：前者「等一会儿就好」（可重试），
 * 后者要用户去官方客户端操作。判错的代价是方向性的 —— 说成「已领取」会让用户
 * 真的错过今天的额度。
 */
const NOT_REFRESHED_MESSAGE =
  `今天的每日活动尚未刷新（每日 ${QODER_CAMPAIGN_REFRESH_HOUR_UTC8}:00（UTC+8）刷新），` +
  '当前看到的是昨天那一轮，请稍后再来领取。'

/**
 * 账号尚未在 Qoder 侧「开通过」时的提示文案。
 *
 * ⚠️ **真实缺陷（参考实现用户报障，2026-09-26）**：经 GitHub 授权新注册的 Qoder
 * 账号尚未在 Qoder 侧开通每日领取，一键签到只说「当前没有可领取的活动」，
 * 用户不知道该怎么办。实测证明**不是设备身份问题**（4 个 uid 经 `runtime-info.exe`
 * 产出的 token/type 完全相同，即身份是设备级），而是该账号确实没有每日领取活动。
 *
 * 文案要**可操作**：看完应知道「去 IDE 登录一次」，而不是面对「没有可领取的活动」
 * 无从下手。
 */
const NOT_ACTIVATED_MESSAGE =
  '该账号尚未在 Qoder 侧开通每日领取（每日 100 Credits）。' +
  '请先用 Qoder 官方客户端登录一次该账号，开通后再回来领取。'

/** 从 JWT 载荷里取用户 id；取不到返回空串。 */
export function uidFromToken(token        )         {
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const json = Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')
    const payload          = JSON.parse(json)
    if (typeof payload !== 'object' || payload === null) return ''
    const record = payload                           
    for (const key of ['user_id', 'uid', 'userId', 'sub']) {
      const value = record[key]
      if (typeof value === 'string' && value !== '') return value
      if (typeof value === 'number') return String(value)
    }
  } catch {
    // 不是 JWT（或载荷不是 JSON）：交给调用方报错
  }
  return ''
}

/** 按账号 id 派生稳定的设备标识（同一账号每次重启都相同）。 */
export function machineIdOf(accountId        )         {
  const hex = createHash('sha256').update(`qoder:${accountId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * 一个模型**实际可选**的思考档位（逐字对齐参考实现 `qoderEffortsFor`）。
 *
 * ## 为什么必须把 `none` 追加进来（而不是在目录表里手写）
 *
 * 「关闭思考」**不在** `thinking_config.enabled.efforts` 里 —— 它由目录的
 * `disabled` 分支表达。官方客户端是在 `gU()` 里**运行时追加**的：
 *
 * ```js
 * gU(A){ let e=…efforts; return A.supports_disabled||A.supportsDisabled||e.includes("none")
 *   ? e : [...e,"none"] }
 * ```
 *
 * 所以这里的规则与本仓库 `vendor/qoder/qoder-product.ts` 的字段注释一致：
 * **`efforts` 表里不要手写 `none`**（那会与 `supportsDisable` 语义重复），
 * 而是在这里按 `supportsDisable` 追加一次。
 *
 * ## 两条必须守住的口径
 *
 * 1. **档位值必须落在上游白名单内**（`['none','low','medium','high','xhigh','max']`），
 *    不在的会被客户端 `ao()` **静默丢弃** —— 也就是说报一个上游不认的档位，
 *    用户选了等于没选，而且没有任何报错。
 * 2. **`supportsThinking` 为假不代表没有档位**：实测 CN 的 `performance` 是
 *    `is_reasoning: false` 但 `thinking_config.enabled` 为真，上游**确实**提供
 *    档位选择。所以这里只按 `efforts` / `supportsDisable` 判断，**不看**
 *    `supportsThinking`（那个字段只决定请求体里的 `isReasoning`）。
 */
export function qoderEffortsOf(model                    )           {
  const efforts = [...(model.efforts ?? [])]
  if (model.supportsDisable === true && !efforts.includes('none')) efforts.push('none')
  return efforts
}

/**
 * 当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **不要用目录里的 `promotion.active`**：那是「目录下发那一刻」的快照，
 * 客户端长时间不重启就会过期，会让用户在窗口外看到折后价（按折扣价预期、
 * 实际按原价计费）。窗口本身（`windowStart`/`windowEnd`）稳定，按当前时间算。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致），
 * 支持跨零点（如 22:00–08:00）。字段缺失或格式不对时回退到目录的 `active`。
 *
 * 逐字对齐参考实现 `dsh-our-free-model` 的 `promotionActiveNow`。
 */
export function promotionActiveNow(promotion                     , now      )          {
  const { windowStart, windowEnd } = promotion
  if (windowStart === undefined || windowEnd === undefined) return promotion.active === true
  const toMinutes = (hhmm        )                     => {
    const matched = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
    if (matched === null) return undefined
    const hour = Number(matched[1])
    const minute = Number(matched[2])
    return hour < 24 && minute < 60 ? hour * 60 + minute : undefined
  }
  const start = toMinutes(windowStart)
  const end = toMinutes(windowEnd)
  if (start === undefined || end === undefined) return promotion.active === true

  const utc8 = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes()
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

/** 某个模型此刻是否正在打折（没有 promotion 就是没打折）。 */
export function isPromotionActive(model                    , now      )          {
  const promo = model.promotion
  if (promo === undefined) return false
  if (promo.beforePromotionPriceFactor === undefined || promo.discountFactor === undefined) return false
  return promotionActiveNow(promo, now)
}

/**
 * 从上游响应里挖出用户 id。
 *
 * 不同端点的字段名不一样，实测：
 *   - `/sash/api/v2/me/usage`      → `qoderUsage.userId`
 *   - `/sash/api/v1/me/campaigns`  → 顶层 `uid`
 *
 * 所以按已知字段名**递归**找，而不是写死某一条路径（上游改层级也不会立刻崩）。
 */
export function findUserId(body         )         {
  const wanted = ['userId', 'user_id', 'uid']
  const visit = (value         , depth        )         => {
    if (depth > 6 || value === null || typeof value !== 'object') return ''
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 5)) {
        const hit = visit(item, depth + 1)
        if (hit !== '') return hit
      }
      return ''
    }
    const record = value                           
    for (const key of wanted) {
      const child = record[key]
      if (typeof child === 'string' && child !== '') return child
      if (typeof child === 'number') return String(child)
    }
    for (const child of Object.values(record)) {
      const hit = visit(child, depth + 1)
      if (hit !== '') return hit
    }
    return ''
  }
  return visit(body, 0)
}

/**
 * 此刻的**生效倍率**。
 *
 * 规则（逐字对齐参考实现的 `qoderDisplayName`）：
 *
 *   - 窗口内：`beforePromotionPriceFactor × discountFactor`（折后价）
 *   - 窗口外：`beforePromotionPriceFactor`（**原价**，不是采集到的折后价）
 *   - 没有 promotion：目录的 `priceFactor`
 *
 * ⚠️ 为什么不能直接用 `priceFactor`：它是**采集那一刻**的价，窗口一切换就失真。
 * 实测 `Qwen3.8-Max` 存的 `0.2` 是窗口内折后价，窗口外应为 `0.5`。
 */
export function effectiveMultiplier(model                    , now      )                     {
  const promo = model.promotion
  const before = promo?.beforePromotionPriceFactor
  const discount = promo?.discountFactor
  if (promo !== undefined && before !== undefined && discount !== undefined) {
    return isPromotionActive(model, now) ? Number((before * discount).toFixed(4)) : before
  }
  return typeof model.priceFactor === 'number' ? model.priceFactor : undefined
}

/**
 * 多模态 `content` → Qoder 认的 parts 数组。
 *
 * **只在确实有图时返回数组**：纯文本仍走字符串形态（上游对字符串兼容性最好）。
 * 返回 `undefined` 表示「调用方应降级成字符串」。
 *
 * 为什么要保留数组：上游 `serializeMessages` 已经把图片正确转成
 * `{type:'image_url',image_url:{url:'data:…'}}` 放进 content 数组，若这里把它
 * 压成纯文本，图片就在下游**静默消失**（参考实现记的「同型缺陷」之一：
 * 用户报障「发图片给 qwen3.8-flash，模型说没读到图片」）。
 */
function qoderContentParts(content         )                                             {
  if (!Array.isArray(content)) return undefined
  const parts                                 = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw     
                    
                    
                                                     
     
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image_url') {
      // 只搬协议认识的两个键：`detail` 缺省时不写该键（与客户端对齐）。
      const url = block.image_url?.url
      if (typeof url !== 'string' || url.length === 0) continue
      const detail = block.image_url?.detail
      parts.push({
        type: 'image_url',
        image_url: {
          url,
          ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
        },
      })
      hasImage = true
    }
  }
  return hasImage ? parts : undefined
}

/** 把 `content` 归一化成字符串（工具调用消息的正文是空串）。 */
function qoderContentText(content         )         {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (block)                                           =>
          typeof block === 'object' && block !== null && (block                      ).type === 'text',
      )
      .map((block) => String(block.text))
      .join('')
  }
  // `null`（assistant 只带 tool_calls 时的 OpenAI 规范值）与畸形值都退化为空串：
  // 客户端的 content 恒为字符串。
  return ''
}

/**
 * DSH 的 `payload.tools` → 加密端点认的 `tools[]`。
 *
 * ⚠️ **这是 `payload.tools` 的唯一出口。** 不下发它，模型在 wire 上看不到任何
 * 函数定义，只能把工具调用格式写进**正文** —— 用户报障「Qoder 输出一堆
 * `<｜｜DSML｜｜ invoke name="bash">`、任务实际什么都没执行」的根因就是这个。
 *
 * 入参是 OpenAI 形状（`{type:'function', function:{name,…}}`，与 `opencode.ts`
 * 的 `hasReadTool` 同口径）。`description` / `parameters` **缺省时该键不出现**
 * —— 不是填空串/空对象（客户端 `$Hc()` 的产物就是如此）。
 */
export function buildQoderTools(tools         )                   {
  if (!Array.isArray(tools)) return []
  const out                   = []
  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null) continue
    const fn = (raw                                                                                  )
      .function
    if (typeof fn?.name !== 'string' || fn.name === '') continue
    out.push({
      type: 'function',
      function: {
        name: fn.name,
        ...(typeof fn.description === 'string' && fn.description.length > 0
          ? { description: fn.description }
          : {}),
        ...(typeof fn.parameters === 'object' && fn.parameters !== null
          ? { parameters: fn.parameters                            }
          : {}),
      },
    })
  }
  return out
}

/**
 * 我们自己的消息 → Qoder 的 `QoderInferMessage`。
 *
 * ⚠️ **工具历史必须能往返**（与 {@link buildQoderTools} 属于同一类缺陷，
 * 参考实现把它记成「本文件第三个同型缺陷」）：
 *
 *   - assistant 带 `tool_calls` 要**原样保留** —— 丢了模型就看不到自己调用过
 *     什么，表现为**反复重调同一工具**或凭空编造结果；
 *   - `role:'tool'` 的 `tool_call_id` 要保留 —— 丢了工具结果无法与调用配对；
 *   - assistant **只有** `tool_calls`、`content` 为 `null` 时（OpenAI 规范值），
 *     整条消息**不能**被当成空消息丢掉。
 */
export function toInferHistory(messages                        )   
                  
                     
                              
  {
  const history                      = []
  let systemText                    
  let userText = ''
  for (const message of messages) {
    const parts = qoderContentParts(message.content)
    const content = parts === undefined ? qoderContentText(message.content) : parts
    if (message.role === 'system' || message.role === 'developer') {
      if (systemText === undefined) systemText = qoderContentText(message.content)
      continue
    }
    const toolCalls =
      Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? (message.tool_calls                        )
        : undefined
    const toolCallId =
      typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined
    // 三者皆空的消息没有承载意义（例如只带 reasoning 的帧），跳过以免发出
    // 「空 assistant」让上游困惑。⚠️ 判空必须把**图片**算作内容：
    // 只发一张图、不带文字的消息不能丢。
    const isEmpty = parts === undefined ? content.length === 0 : parts.length === 0
    if (isEmpty && toolCalls === undefined && toolCallId === undefined) continue
    history.push({
      role: message.role,
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    })
    if (message.role === 'user') userText = qoderContentText(message.content)
  }
  return {
    userText,
    ...(systemText === undefined ? {} : { systemText }),
    history,
  }
}

/**
 * Qoder 的**会话 id**：由会话内容派生的稳定 UUID。
 *
 * ## 为什么必须是确定性的
 *
 * 官方客户端的 `sessionId` 由**调用方传入、整段会话复用**（反混淆
 * `extensions/aicoding-agent/dist/extension.js` 的 `ChatIntegration.chatAsk`：
 * `const { sessionId: t, ... } = e` 之后原样透传；只有 `requestId` 每次
 * `generateUUID()`）。
 *
 * 而早先我们这里是 `crypto.randomUUID()` —— **每说一句话就换一个新会话 id**，
 * 那是最典型的爬虫指纹（真人客户端的会话 id 会稳定一整段对话）。
 *
 * ## 派生规则（只依赖会话内容）
 *
 * 取**第一条 user 消息**当种子 —— 与 `opencode.ts` 的 `conversationSignal()`
 * 同一个理由：用最后一条的话，对话越聊越长、每轮种子都变，等于没稳定。
 * 种子 → `sha256` → 前 16 字节 → 按 RFC 4122 拼成 UUID v4 形状
 * （官方这个字段是 UUID，形状必须像，不能塞一串 hex）。
 *
 * 不含任何时间/随机成分 ⇒ 同种子恒等、异种子必不同（碰撞概率 2^-122）。
 */
export function qoderSessionIdOf(messages                        , modelKey        )         {
  let seed = ''
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const text = qoderContentText(message.content)
    if (text.trim() !== '') {
      seed = text
      break
    }
  }
  // 一条 user 消息都没有（例如只有 system + tool 的续跑）：退到「模型 + 首条消息」，
  // 仍然是确定性的，不会退化成随机。
  if (seed === '') seed = `${modelKey}\u0000${JSON.stringify(messages.slice(0, 1))}`

  const digest = createHash('sha256').update(`qoder-session\u0000${seed}`).digest()
  // UUID v4 形状：版本位固定 4、变体位取 10xx —— 只改这两处，其余用摘要原值。
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16)
  bytes[6] = (bytes[6]  & 0x0f) | 0x40
  bytes[8] = (bytes[8]  & 0x3f) | 0x80
  const hex = Array.from(bytes, (b        ) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 这一轮是不是「接着上文说的」——官方 `isReply` 的语义。
 *
 * 官方默认 `false`（反混淆源码 `isReply: A = !1`），而早先我们恒传 `true`。
 * 判据：历史里**已经出现过 assistant 或 tool 消息** ⇒ 这是在续，`true`；
 * 否则（纯 user 首轮）⇒ `false`。
 *
 * ⚠️ 只看 assistant / tool，**不看有几条 user** ——「连续追问两条 user」
 * 在语义上仍是首轮发起，官方那边也是这么区分的。
 */
export function qoderIsReplyOf(messages                        )          {
  return messages.some((message) => message?.role === 'assistant' || message?.role === 'tool')
}

/**
 * 「凭证缺少 uid 且自动补齐失败」——**带 `kind` 的结构化错误**。
 *
 * 为什么不能只 `throw new Error(...)`：`requestChatStream` 的 catch 里没有 kind，
 * 早期只能兜底成 `auth`，于是一路变成 DSH 的「API 密钥无效」（见
 * {@link QODER_MISSING_UID_KIND} 的完整说明）。带上 kind 才能让用户看到实话。
 */
export class QoderMissingUidError extends Error {
           kind            = QODER_MISSING_UID_KIND
  constructor(message        ) {
    super(message)
    this.name = 'QoderMissingUidError'
  }
}

/** Qoder / Qoder CN 适配器。 */
export class QoderAdapter extends BaseAdapter {
                   product              
  /** 每个账号一个 WASM 上下文（构造有成本，缓存起来）。 */
                   clients = new Map                             ()
  /**
   * 缓存条目是用**哪个 token** 建的。
   *
   * 为什么需要：WASM 上下文在构造时就把 token 烘进了签名上下文
   * （`QoderEncryptedInfer.create({ user: { securityOauthToken: token } })`）。
   * token 续期后旧客户端仍然签着**旧令牌**，必须重建 —— 只清 `clients`
   * 而不比对 token，会在「同一个号换了 token 但 ID 不变」时继续用旧上下文。
   */
                   clientTokens = new Map                ()

  constructor(product              ) {
    super({
      id: product.id === 'qodercn' ? 'qoder-cn' : 'qoder',
      name: product.displayName,
      doc: product.authBase,
      credentialHint: '粘贴 security_oauth_token（JWT，需含 user_id）。',
      capabilities: CAPABILITIES,
      implemented: true,
    })
    this.product = product
  }

          tokenOf(record               )         {
    const token = record.credentials.token
    return typeof token === 'string' ? token : ''
  }

  /**
   * 对话（加密推理端点）上的 `User-Agent`。
   *
   * ## ⚠️ 这里原来**根本没有** UA —— 上游看到的是 `node`
   *
   * WASM 生成的 headers 里**不含** `User-Agent`（实测：19 个头，没有它），
   * 而早先我们把这批 headers 原样交给 `fetch` ⇒ Node 的 undici 会补上自己的
   * 默认值 **`User-Agent: node`**（实测抓过一次本地回环服务器，原文就是 `node`）。
   *
   * 「`User-Agent: node` 打在一个宣称来自桌面 IDE 的加密推理请求上」，
   * 比版本号写错严重得多 —— 它直接说明请求不是官方客户端发的。
   *
   * 版本号取 `product.clientVersion`（默认 `1.34.0`，来源见该字段的注释）。
   */
          chatUserAgent()         {
    return `${this.product.userAgentPrefix}/${this.product.clientVersion}`
  }

  // ── 登录（设备码 + PKCE） ──────────────────────────────────────────
  //
  // 流程：打开 `authBase/device/selectAccounts?...` → 用户在浏览器登录 →
  // 用户点「刷新登录状态」→ 宿主问一次 `openApiBase/api/v1/deviceToken/poll`。

  /** ① 生成授权链接（PKCE + nonce 只留在宿主会话里）。 */
  async beginLogin(_ctx                )                            {
    const session = createQoderDeviceSession(machineIdOf(this.id))
    const authUrl = buildQoderAuthUrl(session, this.product)
    return { authUrl, expiresInSec: 300, state: session }
  }

  /** ② 问一次 token：拿到就交给宿主落盘。 */
  async pollLogin(state         , ctx                )                           {
    const session = state                                  
    if (session === undefined || session === null) {
      return { status: 'failed', message: '登录会话状态丢失，请重新发起' }
    }
    let body          = null
    try {
      const send = ctx.fetch ?? fetch
      const response = await send(buildQoderPollUrl(session, this.product), {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': `${this.product.userAgentPrefix}/${this.product.clientVersion}` },
      })
      body = await response.json().catch(() => null)
      if (!response.ok) {
        return { status: 'pending', message: `还没检测到登录（HTTP ${response.status}），请先在浏览器完成登录` }
      }
    } catch (error) {
      return { status: 'pending', message: `网络错误，稍后再试：${error instanceof Error ? error.message : String(error)}` }
    }
    const envelope = body                             
    const payload = parseQoderTokenPayload(envelope?.data ?? body)
    if (payload.accessToken === '') {
      return { status: 'pending', message: '还没检测到登录，请先在浏览器完成登录' }
    }
    return {
      status: 'ready',
      message: '登录成功',
      credentials: {
        token: payload.accessToken,
        ...(payload.refreshToken === undefined || payload.refreshToken === '' ? {} : { refreshToken: payload.refreshToken }),
        ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
        /**
         * ⚠️ **`uid` 必须落盘**，它不在 token 里。
         *
         * Qoder 的设备码响应给的是 `dt-...` 这样的**不透明设备令牌**，不是 JWT ——
         * `uidFromToken()` 在它身上永远解不出东西。而加密推理要用 uid 派生
         * `encrypt_user_info`，缺了就签名无效。
         *
         * 参考实现（dsh-our-free-model 的 `qoder.ts`）把 `user_id` 从**设备码响应**
         * 里读出来单独存（`buildQoderCredential` 的 `uid` 字段），并在缺 uid 时
         * **明确报错**而不是发一个必然失败的请求。
         *
         * 早期这里漏存 → 每次对话都报「token 里解不出 user_id」，
         * 而用户明明刚登录成功。
         */
        ...(payload.uid === undefined || payload.uid === '' ? {} : { uid: payload.uid }),
      },
      ...(payload.userName === undefined || payload.userName === '' ? {} : { label: payload.userName }),
    }
  }

  /**
   * 模型目录：用产品兜底表（加密目录需另接解密，本期不做）。
   *
   * ⚠️ **没有账号（= 没有 token）时返回空列表**。这张表是「产品级目录」，
   * 跟账号无关 —— 但不登录就一个模型也调不动。早期没登录也会列 17 个模型，
   * 而且倍率全是「未知倍率」，用户以为是插件坏了（报障原话：
   * 「还没登录账号就拉取到了模型，但是倍率是未知」）。
   * 现在交给界面引导「先登录」，登录后再列。
   *
   * ## ⚠️ 只上报**厂商模型**，档位/路由名要滤掉（用户 2026-10-20 要求）
   *
   * 目录里的 `auto` / `ultimate` / `performance` / `efficient` / `smodel`(Sonus) /
   * `cmodel`(Cantus) 是 **Qoder 自己的档位（tier）与路由名**，不是任何厂商的模型
   * （官方文档把「档位」与「具体模型」分两张表列，倍率逐条对得上）。
   * 它们混在选择器里会让人以为可以直连。
   *
   * ⚠️ **是「不上报」而不是「删掉」**：这些条目仍留在
   * `vendor/qoder/qoder-product.ts` 的表里 —— 那张表同时被
   * `effectiveMultiplier` / `qoderEffortsOf` 等**按 id 查表**的路径使用，
   * 物理删除会让「用户以前勾选过 `smodel`」变成**悬空引用**。
   * 判据与官方依据写在 `QODER_NON_VENDOR_MODEL_IDS` 的注释里。
   *
   * ## 倍率怎么算（**不能直接用 `price_factor`**）
   *
   * `price_factor` 是**采集那一刻的生效价**，会随错峰窗口变化 —— 直接显示它，
   * 窗口切换后就失真了（窗口内看着便宜、实际按原价计费，反之亦然）。
   *
   * 参考实现（dsh-our-free-model 的 `qoderDisplayName` / `promotionActiveNow`）的做法：
   *
   *   - 窗口内：`beforePromotionPriceFactor × discountFactor`（折后价）
   *   - 窗口外：`beforePromotionPriceFactor`（**原价**）
   *   - 没有 promotion 的模型：`priceFactor`
   *
   * 实测关系式 `priceFactor === before × discount` 三条全部吻合 —— 所以
   * `Qwen3.8-Max` 目录里存的 `0.2` 是**22:00–08:00 窗口内的折后价**，
   * 窗口外（白天）正确的倍率是 **×0.5**。用户报的「正确倍率是 x0.5」就是这个。
   *
   * ## 「免费」只认 `price_factor === 0`
   *
   * `is_free` 的含义是「**免费额度模型**」——照样按倍率扣积分，只是额度由免费档供给。
   * 真正零成本的只有 `qfmodel`（Qwen3.8-Flash，`price_factor: 0`）。
   */
  async getModelMetaList(record               , ctx                )                       {
    if (this.tokenOf(record) === '') return []
    // 模型列表本身走兜底表（不发上游），但续期在这里顺手做掉：
    // 用户点开账号页看模型时就把登录态修好，进对话就不必再等一次续期往返。
    await this.ensureFreshCredential(record, ctx)
    const now = new Date()
    return (this.product.fallbackModels ?? [])
      // 档位/路由名不上报（仍留在表里，见上）。两份产品表共用这一处过滤。
      .filter((model) => isVendorModel(model.id))
      .map((model) => {
      const multiplier = effectiveMultiplier(model, now)
      const discounted = isPromotionActive(model, now)
      const efforts = qoderEffortsOf(model)
      return {
        id: model.id,
        name: model.name,
        agentId: this.id,
        agentName: this.name,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.supportsImage ? { inputModalities: ['text', 'image']                         } : {}),
        ...(model.supportsThinking ? { reasoning: true } : {}),
        // 思考档位：**必须报给核心层**，否则选择器里不会出现档位行。
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
        // 默认档：目录里的 `is_default` 就是官方客户端的选中项，照实上报
        // （不报的话核心层会用启发式猜一个，实测会把 `dfmodel` 的 max 猜成 low）。
        ...(model.defaultEffort !== undefined ? { defaultReasoningEffort: model.defaultEffort } : {}),
        ...(multiplier === undefined ? {} : { multiplier, multiplierSource: 'qoder:catalog' }),
        // 只有 0 才是真免费；`is_free` 另作说明，不影响「免费」标签。
        ...(multiplier === 0 ? { free: true } : {}),
        ...(model.isFree === true && multiplier !== 0 ? { description: '免费额度模型（仍按倍率扣积分）' } : {}),
        ...(discounted && model.promotion?.beforePromotionPriceFactor !== undefined
          ? {
              description:
                `${model.isFree === true ? '免费额度模型 · ' : ''}` +
                `错峰折扣中：原价 ×${model.promotion.beforePromotionPriceFactor} → 现价 ×${multiplier}`,
            }
          : {}),
      }
    })
  }

  /**
   * 取 uid：**优先用凭证里存的**，其次尝试从 JWT 解。
   *
   * 为什么这个顺序不能反：Qoder 设备码登录给的是 `dt-...` 不透明令牌，
   * JWT 解析必然失败；真正可靠的来源是登录响应里的 `user_id`（已落盘）。
   *
   * 两种来源都拿不到时返回空串，由调用方走 {@link resolveUid} 兜底。
   */
          uidOf(record               )         {
    const stored = record.credentials.uid
    if (typeof stored === 'string' && stored !== '') return stored
    return uidFromToken(this.tokenOf(record))
  }

  /**
   * 账号凭证（core 形状）→ Qoder 凭据（vendor 形状）。
   *
   * `machine_id` **不落盘**：它由账号 id 确定性派生（{@link machineIdOf}），
   * 每次现算即可，与「重启不变」等价。
   */
          qoderCredentialOf(record               )                  {
    const token = this.tokenOf(record)
    const credentials = record.credentials
    return {
      security_oauth_token: token,
      access_token: token,
      ...(typeof credentials.refreshToken === 'string' && credentials.refreshToken !== ''
        ? { refresh_token: credentials.refreshToken }
        : {}),
      ...(typeof credentials.expiresAt === 'number' ? { expire_time: credentials.expiresAt } : {}),
      machine_id: machineIdOf(record.id),
      ...(typeof credentials.uid === 'string' && credentials.uid !== '' ? { uid: credentials.uid } : {}),
      ...(typeof credentials.label === 'string' && credentials.label !== ''
        ? { nickname: credentials.label }
        : {}),
    }
  }

  /**
   * 确保登录态新鲜：**过期（或 5 分钟内将过期）就用 refresh_token 换一个新的**。
   *
   * ## 为什么 Qoder 必须有这个（真实缺陷，2026-10-24）
   *
   * 用户报障「Qoder 模型使用时提示『API 密钥无效』，重新添加账号后才可正常使用」。
   * 真实原因**不是** token 本身有问题，而是**链条上缺了自动续期**：
   *
   *   1. 老账号磁盘上**没有 `uid`**（早期版本漏存，见文件头）；
   *   2. 唯一能补 uid 的兜底是 {@link resolveUid}，它要**用 token 打上游**；
   *   3. token 一旦过期，`/sash/` 两个端点都回 `401 TOKEN_EXPIRE`，
   *      `resolveUid` 两次都拿不到东西 → 只能告诉用户「重新登录」
   *      —— 而实际上**换一次 token 就够了**。
   *
   * 也就是说：**`uid` 缺失本身是可自愈的，是「token 过期 + 无续期」把它变成了死结。**
   * 本方法补上那一环，并且**必须排在 {@link resolveUid} 之前**
   * （先让 token 活过来，兜底才有机会成功）。
   *
   * ## 三条口径
   *
   * - **失败不抛错**：网络抖动不该把整轮请求打断，返回后按原凭据继续试一次，
   *   让上游的 401 用它自己的话说话（与 `opencode.ts` 的 `ensureFreshCredentials` 同）。
   * - **`uid` 必须活下来**：宿主回写是 **merge** 语义（`{...旧, ...patch}`），
   *   所以 patch 里**不带** `uid` 就等于保留它；这里额外显式带上（当已知时），
   *   双向保证续期不会把加密推理必需的 uid 弄丢。
   * - **改了 token 就要扔掉缓存的 WASM 客户端**：那个客户端在构造时就把旧 token
   *   烘进了签名上下文（`QoderEncryptedInfer.create({ user: { securityOauthToken } })`），
   *   不重建的话续期等于没做。
   */
  async ensureFreshCredential(record               , ctx                )                {
    const credential = this.qoderCredentialOf(record)
    if (credential.security_oauth_token === '') return
    if (!isQoderRefreshable(credential)) return
    // 没有过期时间就「不知道」，不主动刷（避免每次请求都刷一次）。
    const expiresAt = credential.expire_time
    if (expiresAt === undefined || expiresAt - ctx.now() > QODER_REFRESH_MARGIN_MS) return

    let result
    try {
      result = await ctx.http(`${this.product.openApiBase}${QODER_REFRESH_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': `${this.product.userAgentPrefix}/${this.product.clientVersion}`,
        },
        body: JSON.stringify(qoderRefreshBody(credential)),
        timeoutMs: QODER_REQUEST_TIMEOUT_MS,
      })
    } catch (error) {
      ctx.log.warn(
        `账号 ${record.id} 的 Qoder 登录态续期失败 —— 本次先用旧 token`,
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    if (!result.ok) {
      // 401/403 = refresh_token 也废了，只能重新登录；5xx/429 = 可重试。
      ctx.log.warn(
        `账号 ${record.id} 的 Qoder 登录态续期被拒 —— 本次先用旧 token`,
        `HTTP ${result.status} ${(result.text ?? '').slice(0, 200)}`,
      )
      return
    }

    const payload = parseQoderTokenPayload(result.body)
    if (payload.accessToken === '') {
      ctx.log.warn(`账号 ${record.id} 的续期响应缺少访问令牌`, JSON.stringify(result.body).slice(0, 200))
      return
    }
    const refreshed = applyQoderRefresh(credential, payload)
    // 只带真正变化的字段；`uid` 显式回传（已知时），避免任何路径把它弄丢。
    const patch                          = {
      token: refreshed.security_oauth_token,
      ...(refreshed.refresh_token === undefined ? {} : { refreshToken: refreshed.refresh_token }),
      ...(refreshed.expire_time === undefined ? {} : { expiresAt: refreshed.expire_time }),
      ...(refreshed.uid === undefined ? {} : { uid: refreshed.uid }),
    }
    // ① 回写内存记录：本次调用链立刻用上新 token。
    record.credentials = { ...record.credentials, ...patch }
    // ② 请宿主加密落盘：重启后不用重新登录。
    try {
      ctx.onCredentialsRefreshed?.(record.id, patch)
    } catch (error) {
      ctx.log.warn(`账号 ${record.id} 的续期结果落盘失败`, error instanceof Error ? error.message : String(error))
    }
    // ③ 旧 WASM 客户端烘的是旧 token，必须重建。
    this.clients.delete(record.id)
    this.clientTokens.delete(record.id)
    ctx.log.info(
      `账号 ${record.id} 的 Qoder 登录态已自动续期`,
      refreshed.expire_time === undefined ? '' : `新的过期时间 ${new Date(refreshed.expire_time).toLocaleString()}`,
    )
  }

  /**
   * 补齐缺失的 **uid**：问一次上游的用量接口。
   *
   * 为什么要有这条兜底：`uid` 是**登录响应**里的字段，早期版本漏存了它 ——
   * 已经登录过的账号在磁盘上没有 uid，但**并不需要用户重新登录**：
   * `/sash/api/v2/me/usage`（以及 `/sash/api/v1/me/campaigns`）只认
   * `Bearer <device token>`，**不需要 WASM 签名**，响应里带 `userId` / `uid`。
   * （实测 2026-10-19：两个端点都回 200，userId 一致。）
   *
   * 拿到之后由调用方回写凭证，下次直接用，不再重复请求。
   *
   * ## ⚠️ 两个必须记住的口径（2026-10-24 真机复测）
   *
   * **① 必须用 `product.sashClientType`（`'10'`），不能复用
   * `clientMetadata.client_type`（`'5'`）。** 这两个是**不同身份**：
   * `clientMetadata.client_type` 是 CLI 身份（用于**推理请求体**的加密信封），
   * `sashClientType` 才是官方**桌面客户端**身份，而本函数打的两个端点都是 `/sash/`
   * 端点。`vendor/qoder/qoder-product.ts` 的 `sashClientType` 注释为此专门写了警告，
   * `vendor/qoder/qoder-credits.ts` 也是这么取的（那边已写对）。
   *
   * **② 但它不是「补不回 uid」的根因。** 实测（2026-10-24，本机国际版账号）：
   *
   * | 端点 | `'5'` | `'10'` |
   * |---|---|---|
   * | `/sash/api/v2/me/usage` | 200，**能取到 userId** | 200，能取到 userId |
   * | `/sash/api/v1/me/campaigns` | 200，`campaigns:0`（顶层仍有 `uid`） | 200，`campaigns:2` |
   *
   * 而本函数的**第一个**端点就是 `usage` —— 所以即便 clienttype 是 `'5'`，
   * 它在 token 活着时也照样能补到 uid。真正让兜底失效的是 **token 已过期**：
   * 用无效 token 复测，两个端点**都回 `401 TOKEN_EXPIRE`**（四组组合全 401），
   * 于是两次都 `continue` → 返回空串。
   * ⇒ 所以修「补不回 uid」的关键是 {@link ensureFreshCredential}（先让 token 活过来），
   * clienttype 只是把它改成与 `qoder-credits.ts` 一致、且让 campaigns 那条备份路径也真正可用。
   */
          async resolveUid(
    record               ,
    ctx                ,
  )                                           {
    const token = this.tokenOf(record)
    if (token === '') return { uid: '', reason: '凭证里没有 token' }
    let lastReason = '未知原因'
    for (const path of ['/sash/api/v2/me/usage', '/sash/api/v1/me/campaigns']) {
      try {
        const result = await ctx.http(`${this.product.openApiBase}${path}`, {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            // ⚠️ `/sash/` 端点要用**桌面客户端身份**（`'10'`），不是 CLI 身份（`'5'`）——
            // 理由见本方法文档的「①」。不要改回 `clientMetadata.client_type`。
            'cosy-clienttype': this.product.sashClientType,
            'user-agent': 'Qoder',
          },
        })
        if (!result.ok) {
          // ⚠️ 早期这里**连日志都没有**（直接 continue），于是「补不回来」只能靠猜
          // —— 用户报障时无从下手。现在把状态码与响应摘要记下来。
          lastReason = `HTTP ${result.status} ${(result.text ?? '').slice(0, 120)}`.trim()
          ctx.log.warn(`补齐 uid 失败（${path}）`, `账号 ${record.id}：${lastReason}`)
          continue
        }
        const uid = findUserId(result.body)
        if (uid !== '') {
          ctx.log.info(`已从上游补齐 uid（${path}）`, `account=${record.id}`)
          return { uid, reason: '' }
        }
        lastReason = '响应里没有 userId / uid 字段'
        ctx.log.warn(`补齐 uid 失败（${path}）`, `账号 ${record.id}：${lastReason}`)
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error)
        ctx.log.warn(`补齐 uid 失败（${path}）`, `账号 ${record.id}：${lastReason}`)
      }
    }
    return { uid: '', reason: lastReason }
  }

  // ───────────────────────────── 积分与每日领取 ─────────────────────────────
  //
  // 事实与端点全部记在 `src/vendor/qoder/qoder-credits.ts` 的文件头（含
  // 「machine 头不必带」这条与参考实现相左的本机实测）。这里只负责：
  //   ① 把 vendor 的纯函数接到 `ctx.http`；② 决定「今天」这一层的语义。

  /**
   * 问一次上游并解析 JSON；失败时给出可读原因。
   *
   * 用 `ctx.http`（带超时/错误分类/凭证脱敏）而不是裸 `fetch`：
   * 这三个端点都在**同一个 openApiBase** 上，超时与错误分类口径要与其它适配器一致。
   */
          async getJson(
    url        ,
    record               ,
    ctx                ,
  )                                                                                                         {
    const token = this.tokenOf(record)
    let result
    try {
      result = await ctx.http(url, {
        headers: qoderCreditsHeaders(this.product, token),
        timeoutMs: QODER_CREDITS_TIMEOUT_MS_FALLBACK,
      })
    } catch (error) {
      return {
        ok: false,
        kind: 'network',
        message: error instanceof Error ? error.message : String(error),
        status: 0,
      }
    }
    if (!result.ok) {
      return {
        ok: false,
        kind: result.kind,
        message: result.message ?? `HTTP ${result.status}`,
        status: result.status,
      }
    }
    if (typeof result.body !== 'object' || result.body === null) {
      return { ok: false, kind: 'unknown', message: '上游返回的不是 JSON 对象', status: result.status }
    }
    return { ok: true, body: result.body }
  }

  /** 拉活动列表；取不到返回 `{ ok: false }`（**不判定**，由调用方保守处理）。 */
          async loadCampaigns(
    record               ,
    ctx                ,
  )                                                                                                  {
    const response = await this.getJson(`${this.product.openApiBase}${QODER_CAMPAIGNS_PATH}`, record, ctx)
    if (!response.ok) return { ok: false, kind: response.kind, message: response.message }
    const parsed = parseQoderCampaigns(response.body)
    if (parsed === undefined) {
      return { ok: false, kind: 'unknown', message: '活动列表响应形状与预期不符' }
    }
    return { ok: true, parsed }
  }

  /** 拉原始用量响应体；取不到返回 undefined（`undefined` 与「余额 0」严格区分）。 */
          async loadUsageRaw(record               , ctx                )                   {
    const response = await this.getJson(`${this.product.openApiBase}${QODER_USAGE_PATH}`, record, ctx)
    return response.ok ? response.body : undefined
  }

  /**
   * 每日领取。
   *
   * ## 三条判据（每条都对应一个真实缺陷）
   *
   * **① 幂等看响应体的 `replayed`，不是 HTTP 状态码。**
   * 重复领取同样返回 200，但 `replayed:true`、不含 `benefit`、`claimedAt` 是旧时间。
   * 只看状态码会把「今天已领」误报成「领取成功 +100」。
   *
   * **② 活动每日 10:00（UTC+8）刷新，刷新前看到的 `CLAIMED` 属于昨天。**
   * 所以判「今天已领」必须先确认已刷新；刷新前一律 `coversToday: false` ——
   * 记账层据此**不记账**，当天 10 点后仍会真的去领。
   * 说成「今天已领」是不可逆的方向：用户以为不必再领，于是**整天漏掉 100 积分**。
   *
   * **③ 「未开通」与「今天已领」必须分开。**
   * 活动列表里没有 `CLAIM_BENEFIT` **且** 用量响应缺 `addOnQuota` 字段
   * （注意是**缺失**，不是 0）→ 账号还没在 Qoder 侧开通过，要用户去官方客户端登录一次。
   * 这一条带 `actionRequired: true`（UI 判布尔字段，不判文案）。
   * 判错方向的代价同样是用户真的错过当天额度。
   *
   * ## 取不到上游时**不判定**
   *
   * 活动列表或用量查询失败时，一律 `ok:false` + `kind`（真实失败），
   * 绝不猜成「已领」也绝不猜成「未开通」 —— 前者的代价是漏领，后者是误导用户去重新登录。
   */
  async checkIn(record               , ctx                )                         {
    const at = ctx.now()
    if (this.tokenOf(record) === '') {
      return { ok: false, supported: true, message: '没有 security_oauth_token', kind: 'auth', at }
    }
    // 签到要打 `/sash/` 端点，先确保登录态新鲜（详见 ensureFreshCredential）。
    await this.ensureFreshCredential(record, ctx)

    const loaded = await this.loadCampaigns(record, ctx)
    if (!loaded.ok) {
      // 取不到活动列表 → 不判定。
      return {
        ok: false,
        supported: true,
        message: `活动列表查询失败：${loaded.message}`,
        kind: loaded.kind,
        at,
      }
    }
    const parsed = loaded.parsed

    // ⚠️ 用 `core/time.ts` 的 UTC+8 判据，**不要**用 `new Date().getHours()`：
    // 活动按 UTC+8 结算，取本机时区会在用户出差/改时区时给出错的「今天」。
    const refreshed = hasQoderCampaignRefreshedToday(at)
    const claimable = claimableQoderCampaigns(parsed)

    // ── 有可领的：逐个领（一个账号可能同时有多个 CLAIM_BENEFIT 活动） ──
    if (claimable.length > 0) {
      let total = 0
      let claimedCount = 0
      let alreadyCount = 0
      let firstError                                                  

      for (const campaign of claimable) {
        const outcome = await this.claim(record, ctx, campaign.campaignId)
        if (outcome.kind === 'claimed') {
          total += outcome.amount
          claimedCount += 1
        } else if (outcome.kind === 'already-claimed') {
          alreadyCount += 1
        } else if (firstError === undefined) {
          firstError = { kind: outcome.kind_, message: outcome.message }
        }
      }

      if (claimedCount > 0) {
        return {
          ok: true,
          supported: true,
          credits: total,
          message: `领取成功，+${total} 积分`,
          // ⚠️ **成功也要带 `coversToday:false`**（刷新前）：领到的是**昨天那一轮**
          // 的补领 —— 它是一次真实动作（该如实报「领取成功」），但**不证明今天已被
          // 处理**。不带这个字段，记账层会把今天记成已签，于是 10 点刷新后的新额度
          // 再也没人去领 —— 正是本判据要防的那个「每天静默漏 100 积分」。
          // 参考实现把它叫 `stale` 并同样挂在成功分支上。
          ...(refreshed ? {} : { coversToday: false }),
          at,
        }
      }
      if (alreadyCount > 0 && firstError === undefined) {
        // 全都是 `replayed:true` —— 服务端说这一轮已经领过了。
        return {
          ok: true,
          supported: true,
          credits: 0,
          message: refreshed ? '今天已领取' : NOT_REFRESHED_MESSAGE,
          ...(refreshed ? {} : { coversToday: false }),
          at,
        }
      }
      if (firstError !== undefined) {
        // 失败分支**不带** `coversToday`：`ok:false` 本来就永不记账，
        // 标它只会让「没记账」这件事看起来像有别的含义（对齐参考实现）。
        return {
          ok: false,
          supported: true,
          message: `领取失败：${firstError.message}`,
          kind: firstError.kind,
          at,
        }
      }
    }

    // ── 没有可领的：区分「今天已领」/「还没刷新」/「未开通」/「本就没有」 ──
    const claimedBefore = hasClaimedQoderBenefit(parsed)

    if (claimedBefore) {
      if (refreshed) {
        return { ok: true, supported: true, credits: 0, message: '今天已领取', at }
      }
      // 刷新前看到的那条 CLAIMED 属于**昨天** —— 既不是「今天已领」，
      // 也不是「没有可领取的活动」，而是「等一会儿再来」。
      return {
        ok: true,
        supported: true,
        credits: 0,
        message: NOT_REFRESHED_MESSAGE,
        coversToday: false,
        at,
      }
    }

    // 没有已领的、也没有可领的 → 可能是「未开通」。要**两条判据同时满足**才提示，
    // 避免把「活动刚好在刷新中」误报成「未开通」而让用户白跑一趟官方客户端。
    const usageRaw = await this.loadUsageRaw(record, ctx)
    if (isQoderNotActivated(parsed, usageRaw)) {
      return {
        ok: false,
        supported: true,
        message: NOT_ACTIVATED_MESSAGE,
        // 「需要用户去别处操作」——UI 判这个布尔字段（不是判文案）。
        actionRequired: true,
        at,
      }
    }

    // 活动还没刷新时不报「没有可领取的活动」：那会让人以为今天没戏了。
    if (!refreshed) {
      return {
        ok: true,
        supported: true,
        credits: 0,
        message: NOT_REFRESHED_MESSAGE,
        coversToday: false,
        at,
      }
    }

    // 已刷新、已开通，但列表里既没有可领的、也没有已领的痕迹。
    //
    // ⚠️ 这里**必须**带 `coversToday: false`：我们**无法证明**今天这一轮被处理过
    // （服务端可能只是这一刻没下发），记账层据此不记账，当天稍后还会再来看一眼。
    // 参考实现的 `inactive` 同样不计入 `coversToday`（`channel-pack-rpc.ts` 的
    // `computeClaimSummary` 只在 `claimed`/`already-claimed` 两栏里数它）。
    //
    // 方向不能反：记成「今天已处理」而活动稍后才出现 → **整天漏领**；
    // 不记账最多是多查一次（只读请求，无副作用）。
    return {
      ok: true,
      supported: true,
      credits: 0,
      message: '当前没有可领取的活动',
      coversToday: false,
      at,
    }
  }

  /** 领一个活动；把上游结局翻译成我们需要的三态。 */
          async claim(
    record               ,
    ctx                ,
    campaignId        ,
  )          
                                         
                                 
                                                               
    {
    const token = this.tokenOf(record)
    const url = qoderClaimUrl(this.product, campaignId)
    let result
    try {
      result = await ctx.http(url, {
        method: 'POST',
        headers: { ...qoderCreditsHeaders(this.product, token), 'content-type': 'application/json' },
        // ⚠️ **空串**，不是 `'{}'`（抓包实测 `content-length: 0`）。
        body: '',
        timeoutMs: QODER_CREDITS_TIMEOUT_MS_FALLBACK,
      })
    } catch (error) {
      return { kind: 'unexpected', kind_: 'network', message: error instanceof Error ? error.message : String(error) }
    }

    if (!result.ok) {
      // 这里**不能**把 200 当成功：幂等判据是响应体的 `replayed`。
      // 非 2xx 时按上游给的错误分类如实回报（401/403 → auth，429 → rate_limit…）。
      return {
        kind: 'unexpected',
        kind_: result.kind,
        message: result.message ?? `HTTP ${result.status}`,
      }
    }

    // 200 也要落到 `interpretQoderClaim` 上：`replayed:true` 才是「今天已领」。
    const outcome = interpretQoderClaim(result.body)
    if (outcome.kind === 'claimed') return { kind: 'claimed', amount: outcome.amount }
    if (outcome.kind === 'already-claimed') return { kind: 'already-claimed' }
    return { kind: 'unexpected', kind_: 'unknown', message: outcome.message }
  }

  /**
   * 积分余额。
   *
   * ⚠️ **`remaining` 取 `addOnQuota.remaining`，不是 `userQuota`。**
   * 实测（2026-10-19，CN 真实账号）：`userQuota = {total:0, used:0, remaining:0}` 是
   * 恒为 0 的占位，真实可用的 858 积分在 `addOnQuota = {total:1000, used:142, remaining:858}`。
   * 只读 `userQuota` 会显示 0 积分（用户会以为额度被清空了）。
   *
   * `addOnQuota` 没下发时回退到 `userQuota`，再没有就用全部包之和 —— 但**不报 0**：
   * 一个包都解析不出来时给 `error`（「查不到」与「余额为 0」必须分开）。
   *
   * `extra` 里原样保留各包与账号信息，供 UI 展开。
   */
  async getQuota(record               , ctx                )                         {
    const at = ctx.now()
    const base                = { accountId: record.id, unit: 'credits', fetchedAt: at }
    if (this.tokenOf(record) === '') {
      return { ...base, error: '没有 security_oauth_token' }
    }
    // 额度查询也要打 `/sash/` 端点 —— 先确保登录态新鲜。
    await this.ensureFreshCredential(record, ctx)

    const response = await this.getJson(`${this.product.openApiBase}${QODER_USAGE_PATH}`, record, ctx)
    if (!response.ok) {
      // 401/403 与网络失败都给可读原因 —— 失败时 UI 要显示原因而不是 0。
      return { ...base, error: `额度查询失败：${response.message}` }
    }

    const body = response.body                           
    // 企业版不给额度数字，只给一个外部链接 —— 报 0 会误导用户以为没额度。
    if (body.displayMode === 'enterprise') {
      return {
        ...base,
        error: '企业版账号不提供积分数字，请在 Qoder 控制台查看用量',
        extra: { displayMode: 'enterprise', ...(typeof body.detailUrl === 'string' ? { detailUrl: body.detailUrl } : {}) },
      }
    }

    const usage = parseQoderUsage(body)
    if (usage === undefined) {
      return { ...base, error: '额度响应形状与预期不符（不是「余额为 0」）' }
    }

    // 主口径：addOnQuota（实测真实余额所在）。没有它才回退。
    const primary = usage.addOnQuota ?? usage.userQuota
    const remaining = primary === undefined ? qoderTotalRemaining(usage) : primary.remaining

    return {
      ...base,
      remaining,
      ...(primary === undefined ? {} : { total: primary.total, used: primary.used }),
      extra: {
        // 原样保留，UI 可展开：两个包的口径不同，分开列才不会让人误读。
        ...(usage.userQuota === undefined ? {} : { userQuota: usage.userQuota }),
        ...(usage.addOnQuota === undefined ? {} : { addOnQuota: usage.addOnQuota }),
        ...(usage.dedicated.length === 0 ? {} : { dedicatedResourcePackages: usage.dedicated }),
        ...(usage.userType === undefined ? {} : { userType: usage.userType }),
        ...(usage.expiresAt === undefined ? {} : { expiresAt: usage.expiresAt }),
        ...(usage.isQuotaExceeded === undefined ? {} : { isQuotaExceeded: usage.isQuotaExceeded }),
        /** 主口径来源，便于排查「为什么显示这个数」。 */
        remainingSource: primary === undefined ? '全部资源包之和' : usage.addOnQuota !== undefined ? 'addOnQuota' : 'userQuota',
      },
    }
  }

  /**
   * 校验：token 能解出 uid 才算可用（否则 WASM 签名必然无效）。
   */
  async validateCredentials(
    record               ,
    _ctx                ,
  )                                                               {
    const token = this.tokenOf(record)
    if (token === '') return { ok: false, message: '没有 security_oauth_token', kind: 'auth' }
    const uid = this.uidOf(record)
    if (uid === '') {
      return {
        ok: false,
        // 说清「重新登录」而不是「解不出 user_id」——后者用户无法自救。
        message: '凭证缺少 uid（Qoder 加密通道必需）—— 请到账号页重新登录一次这个账号',
        // 同 QODER_MISSING_UID_KIND：用 `auth` 会被 DSH 换成「API 密钥无效」，与事实不符。
        kind: QODER_MISSING_UID_KIND,
      }
    }
    return { ok: true, message: `凭证可用（uid=${uid}，本地校验）` }
  }

  /**
   * 懒建 WASM 客户端。
   *
   * ## 顺序很重要：**先续期，再补 uid**
   *
   * {@link ensureFreshCredential} 必须排在 {@link resolveUid} 前面 ——
   * token 过期时 `/sash/` 端点一律 `401`，兜底必然失败；先换到新 token，
   * 兜底才有机会成功。反过来写就会退化成「token 一过期就必须重新登录」
   * （这正是 2026-10-24 用户报障的成因）。
   *
   * 缺 uid 且补不回来时抛 {@link QoderMissingUidError}（带 `kind`），
   * 由 `requestChatStream` 原样透出 —— 用户看到的是「请重新登录这个账号」，
   * 而不是 DSH 对 `auth` 的固定文案「API 密钥无效」。
   */
          async clientFor(record               , ctx                )                               {
    // ⚠️ 先续期：token 过期会让下面所有上游调用（含补 uid）全部 401。
    await this.ensureFreshCredential(record, ctx)

    const token = this.tokenOf(record)
    const cached = this.clients.get(record.id)
    /**
     * 缓存是否还能用：**同一个 token** 才算命中。
     *
     * 为什么要比对 token 而不只看有没有缓存：WASM 上下文在构造时就把 token 烘进了
     * 签名上下文，token 一变（用户重新登录、宿主换了凭据）旧客户端就签着**旧令牌**。
     *
     * `known === undefined` 时**放行**：那说明这个条目不是本方法放进去的（本方法
     * 总是成对写 `clients` + `clientTokens`，续期也成对删），无从判断新旧，
     * 按「未知即沿用」处理。生产路径不会产生这种半填充状态。
     */
    const known = this.clientTokens.get(record.id)
    if (cached !== undefined && (known === undefined || known === token)) return cached

    let uid = this.uidOf(record)
    // 老账号（早期版本漏存 uid）**不用重新登录**：问一次上游补回来，并回写。
    if (uid === '') {
      const resolved = await this.resolveUid(record, ctx)
      uid = resolved.uid
      if (uid === '') {
        throw new QoderMissingUidError(
          '这个账号的凭证里缺少 uid（Qoder 加密通道签名必需），自动补齐也没成功' +
            `（上游返回：${resolved.reason}）。请到账号页重新登录一次这个账号。`,
        )
      }
    }
    // 回写：下次直接命中，不再多打一次上游。
    if (this.uidOf(record) !== uid && typeof ctx.onCredentialsRefreshed === 'function') {
      try {
        ctx.onCredentialsRefreshed(record.id, { uid })
      } catch (error) {
        ctx.log.debug('uid 回写失败（不影响本次请求）', error instanceof Error ? error.message : String(error))
      }
    }
    const client = await QoderEncryptedInfer.create({
      user: { uid, securityOauthToken: token },
      machineId: machineIdOf(record.id),
      metadata: this.product.clientMetadata,
      host: this.product.encryptedInferBase,
    })
    this.clients.set(record.id, client)
    this.clientTokens.set(record.id, token)
    ctx.log.debug(`Qoder WASM 上下文已建立 account=${record.id} uid=${uid}`)
    return client
  }

  /** 对话：WASM 加密请求 → 解密响应流 → 归一化事件。 */
  async *requestChatStream(
    payload             ,
    record               ,
    ctx                ,
    signal             ,
  )                             {
    let client                     
    try {
      client = await this.clientFor(record, ctx)
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          // ⚠️ 用错误**自带**的 kind（缺 uid → `bad_request`），不要写死 `auth`：
          // 写死会让 DSH 把我们的说明替换成「API 密钥无效」（见 QODER_MISSING_UID_KIND）。
          kind: error instanceof QoderMissingUidError ? error.kind : 'unknown',
          message: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        },
      }
      return
    }

    const { userText, systemText, history } = toInferHistory(payload.messages)
    /**
     * 思考档位从哪个字段取。
     *
     * ⚠️ **两个字段都要认**，这不是冗余：
     *   - `reasoning_effort` —— 核心层（`llm/adapter.ts`）翻译并下发时用的名字，
     *     与我们给上游的 OpenAI 兼容字段一致；
     *   - `reasoning` —— 早先的写法，手工构造 `ChatRequest` 的调用方（含测试）
     *     仍在用。
     *
     * 原先只读 `reasoning`，而核心层写的是 `reasoning_effort` ——
     * 后果是**用户在选择器里选了档位，Qoder 这边永远收不到**，
     * 静默按模型默认档跑（正是「模型调用」这条线上最典型的一类缺口：
     * 两端各自都对，接起来没接上）。
     */
    const requestedEffort =
      typeof payload.reasoning_effort === 'string'
        ? payload.reasoning_effort
        : typeof payload.reasoning === 'string'
          ? payload.reasoning
          : undefined
    let prepared
    try {
      prepared = client.prepareInfer({
        modelKey: payload.model,
        userText,
        ...(systemText === undefined ? {} : { systemText }),
        history,
        /**
         * ★ **会话 id 由会话内容派生**（同一段对话恒等，不同对话不同）。
         *
         * 早先这里是随机的（`crypto.randomUUID()`），等于「每说一句话换一个会话」——
         * 官方客户端的 sessionId 是整段会话复用的，见 `qoderSessionIdOf()` 的注释。
         */
        sessionId: qoderSessionIdOf(payload.messages, payload.model),
        /** ★ 首轮 `false`、续轮 `true`（官方默认就是 `false`）。 */
        isReply: qoderIsReplyOf(payload.messages),
        /**
         * ⚠️ **必须下发 tools，否则模型拿不到任何工具定义。**
         *
         * 用户报障（2026-10-24）：用 Qoder 跑任务，输出是一堆裸的
         * `<｜｜DSML｜｜ invoke name="bash">` 标记，任务实际什么都没执行。
         * 实测探针（带一个 bash 工具）显示模型自己说
         * 「I don't see any tools listed in my available functions」——
         * 因为这一行以前根本不存在，模型只能从训练里臆造工具调用格式。
         */
        tools: buildQoderTools(payload.tools),
        ...(payload.max_tokens === undefined ? {} : { maxTokens: payload.max_tokens }),
        ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
        /**
         * ⚠️ **`business` 必填 —— 漏了它 `qfmodel` / `dfmodel` 必然失败。**
         *
         * 用户报障（2026-10-20）：「Qoder CN 的模型发消息后没有回复，直接显示已完成；
         * Qoder 平台正常」，并明确纠正我：**「上游没问题，我在 Qoder CN 客户端里
         * 用这两个模型就没问题」**。
         *
         * 他是对的。真因就在这一行：不带 `business` 时服务端把请求路由到**故障节点**
         * `oa_qwen-plus-2025-04-28`，回 `[FAIL]node:... msg:Execution failed`。
         * 注意报错里的节点名是 `qwen-plus` —— 与我们发的 `qfmodel` 对不上，
         * 那正是「被路由到了别的节点」的指纹，而不是「这个模型坏了」。
         *
         * 其余模型（`auto` / `qmodel_38max` / `cmodel`）恰好不受影响，
         * 所以极易误判成「该模型服务端故障」—— 我上一轮就误判了。
         * 参考实现的注释里早就写明了这条，连「IDE 里同一模型完全正常」这句现象都一样。
         *
         * 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
         * —— 服务端按 `business.type` 选路由池，**缺字段会走异常分支**。
         * `agent` / `sec_scan` 等取值都能通，我们取 `agent`（与参考实现一致）。
         */
        business: { type: 'agent' },
      })
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          kind: 'unknown',
          message: `生成加密请求失败：${error instanceof Error ? error.message : String(error)}`,
          at: Date.now(),
        },
      }
      return
    }

    let response          
    try {
      const send = ctx.fetch ?? fetch
      response = await send(prepared.url, {
        method: 'POST',
        // ⚠️ WASM 签的 headers 必须原样透传（Authorization 是 `Bearer COSY.<载荷>.<签名>`）；
        // 但我们**必须补一个 User-Agent** —— 见下面那段注释。
        headers: { ...prepared.headers, 'user-agent': this.chatUserAgent() },
        body: prepared.body,
        signal,
      })
    } catch (error) {
      yield {
        type: 'error',
        failure: {
          kind: 'network',
          message: `连接上游失败：${error instanceof Error ? error.message : String(error)}`,
          at: Date.now(),
        },
      }
      return
    }

    if (!response.ok) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        // 读不到原文也没关系
      }
      yield {
        type: 'error',
        failure: {
          kind: this.detectError(response.status, text, response.headers),
          message: text.slice(0, 300) || `HTTP ${response.status}`,
          status: response.status,
          at: Date.now(),
        },
      }
      return
    }

    // 响应体是加密的：先解密成标准 SSE，再走通用解析。
    //
    // ─────────── usage（token 用量）帧：**不需要 `stream_options`** ───────────
    //
    // 曾经怀疑「token 拿不到是因为没请求 `stream_options.include_usage`」
    // （opencode / buddy 的请求体里都有这个字段）。**2026-10-20 真打上游实测否掉了这个怀疑**：
    //
    // | 模型 | 不带 stream_options | 带 stream_options.include_usage |
    // |---|---|---|
    // | auto / qmodel_38max / cmodel | 200 + **有** usage 帧 | 200 + 有 usage 帧 |
    // | performance / ultimate | 200 + 上游报 Unsupported model | 200 + 同样的报错 |
    // | qfmodel（免费） | 200 + 上游业务 400 | 200 + 同一个 400 |
    //
    // 两点结论：
    //   ① Qoder **接受**这个字段（一律 200，没有一次 400）—— 加它不会坏事；
    //   ② 但它**本就会**下发 `choices: []` + `usage` 的末帧，**没它也有** —— 加上是多余的。
    //
    // 所以**不加**：多一个上游不认的字段就多一份上游改协议时被 400 的风险，
    // 而它一个字节的收益都没有。（真要用，得改 `vendor/qoder/qoder-wasm.ts`
    // 的 `buildQoderInferPayload` —— 那是协议纯函数的写作用域，不在本次改动内。）
    //
    // ⚠️ 真正让 token 丢掉的**不是**这个字段，而是**采样时机**：
    // 实测 `auto` 的帧序是 `… text → finish → usage`，usage 比 finish **晚约 17ms**，
    // 而 `llm/adapter.ts` 原先收到 finish 就 `return` ⇒ 这一帧永远读不到。
    // 修在那边（收尾但不结束，最多再等 250ms）。**别再回头加这个字段。**
    const plain = unwrapQoderEnvelopeStream(response, 'qoder')
    let malformed = 0
    for await (const event of iterateSse(
      plain,
      (raw) => {
        malformed += 1
        if (malformed <= 3) ctx.log.debug('跳过一条无法解析的 SSE 事件', raw.slice(0, 200))
      },
      signal,
    )) {
      yield event
    }
    if (malformed > 0) ctx.log.warn(`本次流共跳过 ${malformed} 条无法解析的事件`)
  }
}


//# sourceURL=src/adapters/qoder.ts