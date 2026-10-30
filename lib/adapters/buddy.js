/**
 * WorkBuddy / CodeBuddy 系（腾讯）适配器。
 *
 * 事实来源：`dsh-our-free-model` 的 `vendor/channel-pack/src/{product,buddy-adapter,buddy}.ts`
 * （MIT，已逐条核对端点、头名与产品参数）。这里只保留**本插件用得到**的部分：
 *
 *   - 对话：`POST {endpoint}/v2/chat/completions`（标准 OpenAI Chat Completions + SSE）
 *   - 模型：`GET  {endpoint}/v3/config` → `data.agents[].models[]` + `data.models[]`
 *   - 鉴权：`Authorization: Bearer <access_token>`
 *
 * ## 为什么有 5 个自定义头
 *
 * 腾讯这套网关按**客户端身份**做用量归因（后台「使用端」列）。少发任一个，
 * 请求可能仍能通，但后台归因为 `-`，且部分模型线会拒绝：
 *
 *   X-Domain       与 endpoint 必须一致（凭据里的 domain 是登录时的快照，会过期）
 *   X-Product-Code `codebuddy`（国内）/ `workbuddy`（国际）
 *   X-Product      归属名，**不是部署类型**（历史实现发成 SaaS，归因不到产品）
 *   X-IDE-Name / X-IDE-Type / X-IDE-Version  客户端形态
 *   User-Agent     国际版按模型族分档（GPT/Gemini/Claude 与国内系不同形态）
 *
 * ## 能力按**产品**区分（这是本文件最容易搞错的地方）
 *
 * 「WorkBuddy」在这个插件里指**两个不同产品**，它们的能力**不一样**：
 *
 * | 能力 | 国内（CodeBuddy，copilot.tencent.com） | 国际（WorkBuddy AI，www.workbuddy.ai） |
 * |---|---|---|
 * | 每日签到 | **有** | **没有**（内核里连 `checkin-status` / `daily-checkin` 的字面量都不存在） |
 * | 积分余额 | 有（`get-user-resource`） | **也有**（同端点、同结构，只有 baseURL 不同） |
 * | 对话 / 模型 | 有 | 有 |
 *
 * ⚠️ 所以 `CAPABILITIES` **不能是一份常量给两个产品共用** —— 那样必然有一边在撒谎。
 * 现在由 {@link capabilitiesFor} 按产品各算一份，实例各持一份（不共用同一个对象，
 * 否则改一个会串到另一个）。
 *
 * ⚠️ 「国际版没有签到」**不等于**「国际版查不到余额」：两者是**彼此独立**的能力
 * （参考实现 2026-09-15 实测结论）。不要因为前者顺手把后者也关掉。
 *
 * ## ⚠️ 国际版 checkIn 的守卫（参考实现自己承认的洞，我们这次先补上）
 *
 * 参考实现里 workbuddy 的「不支持签到」守卫是**本功能上线后才补的**。它原来的代码
 * 会落到 buddy 产品分支、**真去发一个必然失败的签到请求**。客户端从不调用它
 * （能力表写着 false），所以这个洞一直没被触发 —— 但只要有人调一次，就会打一次
 * **真实的上游请求**（用国际版凭据去发国内版端点）。
 *
 * 本实现的守卫在 {@link BuddyAdapter.checkIn} 的**最前面**：国际版**一个上游请求
 * 都不发**就返回 `supported: false`，并有单测断言底层 http 调用次数为 0
 * （`test/adapters/buddy.test.mjs`，用假 ctx 记录每次调用）。
 */

import { BaseAdapter } from './base.js'
import { isAbortError, parseRequestId, parseResetAtFromBody, parseRetryAfter } from '../core/errors.js'
import { iterateSse } from '../core/sse.js'
import { unsupportedReason } from './messages.js'
import {
  formatCreditsRate,
  normalizeCreditsRate,
  normalizeDiscountedRate,
  parseModelPromotions,
} from '../vendor/buddy/buddy-rate.js'
import {
  decideReasoningEffort,
  isDeepSeekModel,
  parseReasoningFields,
} from '../vendor/buddy/buddy-reasoning.js'
import {
  AGENT_INTENT_CRAFT,
  AGENT_TYPE_MAIN,
  CLI_IDE_VERSION,
  UA_CLI_INTL,
  hex32,
  newRequestId,
  newSpanId,
  stainlessHeadersOf,
  traceHeadersOf,
  uuidFromSeed,
} from '../vendor/buddy/buddy-client-shape.js'
import { guardChatMessages } from '../vendor/buddy/buddy-channel-guard.js'
import {
  CHECKIN_ACTIVITY_STATUS_PATH,
  DAILY_CHECKIN_PATH,
  USER_RESOURCE_PATH,
  formatCreditAmount,
  normalizeCreditUnit,
  parseCheckinStatus,
  parseClaimOutcome,
  parseCreditBalance,
} from './buddy-credits.js'
                                                           
import {
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  LOGIN_ACCOUNT_PATH,
  accountLabelOf,
  buildCredentials,
  decorateLoginUrl,
  parseAccountPayload,
  parseTokenPayload,
  responseCode,
  responseData,
  responseMessage,
} from '../vendor/buddy/buddy-login.js'
                                                                         
             
                
                 
                    
              
                
            
            
                
              
                         

/** 一个 Buddy 系产品的全部差异配置。 */
                               
                      
                                         
                     
                  
                   
                                              
                  
                     
                         
                       
                   
                                                 
                                                                      
     
                      
    
                                                                
                                                                
                   
    
                                             
                                                
                      
     
                          
     
                                                
    
                                                        
                                
    
                                         
                                             
     
                              
                                                          
                        
     
                                                                             
    
                                  
                                                                                        
    
                                                
                                              
                                           
     
                                      
     
                                             
                                                        
    
                                               
                              
                                                  
    
                                                   
                                                     
     
                                   
     
                    
    
                                                        
                                                         
                                                                           
                    
    
                                                             
                                 
     
                  
                   
                   
                      
                                                    
                     
                                                  
                        
   
                                                               
                        
 

const UA_INTL = 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2'
const UA_CN = 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/5.5.2'

/**
 * `X-Product` 在**签到/余额**端点上发送的值。
 *
 * ⚠️ 语义上是「部署类型」，而 `X-Product` 按对话路径的注释应当是**归属名** ——
 * 参考实现这两条路径不一致，详见 {@link BuddyAdapter} 的 `creditsHeaders` 说明。
 * 这里照抄实测过的那一个取值。
 */
const BUDDY_DEPLOYMENT_TYPE = 'SaaS'

/**
 * 国际版缺失 system 时补的最小可用 system。
 *
 * 出处：参考实现的 `account-probe.ts:123`（`PROBE_SYSTEM`），注释说明它「对齐
 * `tests/e2e/buddy-pool-probe.e2e.spec.ts` 与 `scripts/verify-max-tokens.mjs`
 * 里已被验证可用的同一句」。国际版网关只要求 `messages[0].role === 'system'`，
 * **不校验内容** —— 所以选最小、最中性的这句，不要夹带任何业务指令。
 */
const BUDDY_MINIMAL_SYSTEM = 'You are a helpful assistant.'

/** 国内版（copilot.tencent.com）。 */
export const BUDDY_CN               = {
  agentId: 'workbuddy',
  displayName: 'WorkBuddy',
  endpoint: 'https://copilot.tencent.com',
  apiDomain: 'copilot.tencent.com',
  platform: 'ide',
  productCode: 'codebuddy',
  attributionName: 'CodeBuddy',
  clientVersion: '1.106.1',
  userAgent: 'CodeBuddyIDE/1.106.1',
  userAgentByModelFamily: [],
  hasDailyCheckin: true,
  // 国内版不追加会话参数（参考实现 product.ts:282 `appendSessionParams: false`）。
  appendSessionParams: false,
  // 国内版**不需要**渠道校验用的三个头（缺了也不 400）——但**需要**会话标识三件套
  // 才能命中前缀缓存，否则每轮都按全新会话全量计费（见 sendConversationHeaders 注释）。
  requiresConversationHeaders: false,
  sendConversationHeaders: true,
}

/** 国际版（www.workbuddy.ai）。 */
export const BUDDY_INTL               = {
  agentId: 'workbuddy-intl',
  displayName: 'WorkBuddy International',
  endpoint: 'https://www.workbuddy.ai',
  apiDomain: 'www.workbuddy.ai',
  platform: 'workbuddy-ai',
  productCode: 'workbuddy',
  attributionName: 'WorkBuddy',
  clientVersion: '5.5.2',
  userAgent: UA_INTL,
  userAgentByModelFamily: [
    { match: 'gpt-', ua: UA_INTL },
    { match: 'gemini-', ua: UA_INTL },
    { match: 'claude-', ua: UA_INTL },
    { match: 'glm-', ua: UA_CN },
    { match: 'hy', ua: UA_CN },
    { match: 'kimi-', ua: UA_CN },
    { match: 'minimax-', ua: UA_CN },
  ],
  // 国际版内核里没有签到接口（只有 get-dosage-notify 用量通知）⇒ 不发请求。
  hasDailyCheckin: false,
  // 国际版**必须**追加会话参数（参考实现 product.ts:405-406）。
  appendSessionParams: true,
  pluginVersion: '5.5.2',
  // ⚠️ 国际版**必须**带三个 conversation 头，否则 400 + code 11128「渠道校验」。
  requiresConversationHeaders: true,
  // 对话路径按内嵌 CLI 的真实形态发（2026-10-23 真机抓包，见
  // docs/WORKBUDDY-INTL-REQUEST.md）。注意与上面 `userAgent`（桌面端形态）
  // **故意不同**：`/v3/config` 与签到/余额走桌面端形态，chat 走 CLI 形态。
  chatUserAgent: UA_CLI_INTL,
  chatIdentity: {
    ideType: 'CLI',
    ideName: 'CLI',
    ideVersion: CLI_IDE_VERSION,
    xProduct: 'SaaS',
    productCode: false,
    // ⚠️ 不要给对话路径加 `x-api-key: <JWT>`：上游会判成「错误的 API key」→
    // 401 `{"message":"not_found"}`（2026-10-23 真账号 A/B 实测）。适配器只在
    // 凭据本身是 `sk-…` API key 时才发这个头。
  },
}

export const BUDDY_PRODUCTS                          = [BUDDY_CN, BUDDY_INTL]

/**
 * 内置兜底模型表。
 *
 * 只在 `/v3/config` 拉不到时使用。id 与上下文长度都来自参考实现的实测表，
 * **不编造**：这里没有的模型就是没有。
 */
/**
 * 内置模型表（`/v3/config` 拉不到时用）。
 *
 * ⚠️ `efforts` 只填**实测过的**值（2026-10-30 抓 `/v3/config` 得到）：
 *   - 国内版 `hy4-preview`：`["high"]`，默认 `high`（issue #4 的实测）；
 *   - 国际版 `hy4-preview` / `hy3` / `deepseek-v4.1-flash*`：见各项。
 * 没测过的**留空**，别照同族猜（猜错会让用户选到一个上游会 400 的档位）。
 */
const FALLBACK_MODELS         
         
                 
              
                
                         
                   
                                
                               
                     
                          
    
  = {
  workbuddy: [
    { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, images: true, efforts: ['high'], defaultEffort: 'high' },
    { id: 'hy3', name: 'Hy3', contextWindow: 192_000, images: true },
    { id: 'hy3-x', name: 'Hy3', contextWindow: 192_000, images: true },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, images: true },
    { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, images: true },
    { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, images: true },
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, images: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, images: true },
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, images: true },
    { id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1_000_000, images: true },
    { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, images: true },
  ],
  'workbuddy-intl': [
    { id: 'default-model', name: 'Auto', contextWindow: 176_000, images: true },
    { id: 'fast-model', name: 'Fast', contextWindow: 200_000, images: true },
    { id: 'balanced-model', name: 'Balanced', contextWindow: 256_000, images: true },
    { id: 'primary-model', name: 'Primary', contextWindow: 272_000, images: true },
    { id: 'deep-model', name: 'Deep', contextWindow: 176_000, images: true },
    { id: 'hy4-preview-f', name: 'Hy4 preview', contextWindow: 1_000_000, images: true, efforts: ['high'], defaultEffort: 'high' },
    { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, images: true, efforts: ['high'], defaultEffort: 'high' },
    { id: 'hy3', name: 'Hy3', contextWindow: 192_000, images: true, efforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, images: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    { id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash (SG)', contextWindow: 1_000_000, images: true, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  ],
}

/** 不是真实对话模型的 id（自动选择 / 补全 / 生图）。 */
function isNonChatModel(id        )          {
  if (id === 'auto') return true
  return /^(nes-|completion-)/i.test(id)
}

/**
 * 取第一个非空字符串；都没有返回 `undefined`。
 *
 * 用于「同一个含义有几种字段名」的取值（见 `creditsHeaders` 的说明）。
 * 刻意不用 `??`：字段存在但是**空串**时，`??` 会把它当成有值，于是发出一个空头。
 */
function firstNonEmpty(...values           )                     {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** 按模型族挑 UA。 */
export function userAgentFor(product              , modelId        )         {
  for (const rule of product.userAgentByModelFamily) {
    if (modelId.startsWith(rule.match)) return rule.ua
  }
  return product.userAgent
}

/**
 * 从 `/v3/config` 响应解析可对话模型。
 *
 * 三处来源按优先级合并：`data.agents[].models[]`（主对话清单）→ `data.models[]`
 * （其余可用模型）→ `productFeaturesConfig.ModelTrialBanner.banners[].targetModelId`
 * （只由试用横幅下发的模型）。解析失败返回空数组，调用方回退内置表。
 */
export function parseModelsFromConfig(body         )              {
  if (typeof body !== 'object' || body === null) return []
  const data = (body                           ).data
  if (typeof data !== 'object' || data === null) return []
  const record = data                           

  const metaById = new Map                                 ()
  if (Array.isArray(record.models)) {
    for (const item of record.models) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item                           
      if (typeof entry.id === 'string') metaById.set(entry.id, entry)
    }
  }

  const ids           = []
  const push = (id         )       => {
    if (typeof id !== 'string' || id === '' || isNonChatModel(id)) return
    if (!ids.includes(id)) ids.push(id)
  }

  if (Array.isArray(record.agents)) {
    for (const agent of record.agents) {
      if (typeof agent !== 'object' || agent === null) continue
      const models = (agent                           ).models
      if (Array.isArray(models)) for (const id of models) push(id)
    }
  }
  for (const id of metaById.keys()) push(id)

  const features = record.productFeaturesConfig
  if (typeof features === 'object' && features !== null) {
    const banner = (features                           ).ModelTrialBanner
    if (typeof banner === 'object' && banner !== null) {
      const banners = (banner                           ).banners
      if (Array.isArray(banners)) {
        for (const item of banners) {
          if (typeof item !== 'object' || item === null) continue
          push((item                           ).targetModelId)
        }
      }
    }
  }

  // 促销（活动价）按模型 id 索引。⚠️ **只取此刻生效的**：`modelPromotions` 里
  // 有时间窗口（`schedule` / `validFrom` / `validUntil`）与 `enabled` 两类过滤，
  // 全交给 `parseModelPromotions`（参考实现逐条实测换来的）。
  const promotions = parseModelPromotions(record)

  return ids.map((id) => {
    const meta = metaById.get(id) ?? {}
    const contextWindow = typeof meta.maxInputTokens === 'number' ? meta.maxInputTokens : undefined
    const images = meta.supportsImages === true
    const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : id

    // 倍率：`data.models[].credits`（实测 `"x0.29"` / `"x0.34 credits"` / `"x0.00"`）。
    //
    // ⚠️ **解析不出就是 `undefined`（不放 `multiplier` 键），绝不回退成 1** ——
    //    核心层的口径是 `undefined` = 未知（UI 显示「未知倍率」）、`0` = 免费，
    //    两者不能混。编造倍率比不显示更糟（参考实现注释原文）。
    const rate = normalizeCreditsRate(meta.credits)
    const discounted = promotions.get(id)
    // 展示文案保留「原价→促销价」两段（见 formatCreditsRate 的说明）。
    const rateText = formatCreditsRate(rate, discounted)

    // 生效价（用户**实际会付**的那个）：有促销就用促销价，否则用原价。
    // ⚠️ 方向不能反 —— 拿原价当 `multiplier` 会让打了折的模型显示成原价，
    //    用户按原价预期、实际按折扣计费时反而以为「倍率不准」。
    const effective = discounted ?? rate

    // 思考档位：`data.models[].reasoning.supportedEfforts` / `defaultEffort`。
    //
    // ⚠️ **只在 `supportedEfforts` 真的下发时才报 `reasoningEfforts`** ——
    // 这是本字段唯一正确的用法。实测（2026-10-20，国际版 `/v3/config` 28 条）：
    // **19 条有它、9 条没有**。没有的那 9 条（含用户问的 `deepseek-v4.1-flash`
    // 与 `-sg`，它们只有 `{"effort":"high","summary":"auto"}`）**必须继续没有档位行**：
    // 参考实现注释明说该字段「只在模型真正支持多等级时下发」，
    // 给它编一组（哪怕看起来合理）就是**谎报能力** —— 用户选了、上游 400，
    // 而他无从知道那是插件编的。核心层 `efforts.length > 0` 的判据正是为此设计。
    const reasoning = parseReasoningFields(meta)

    return {
      id,
      name,
      agentId: '',
      agentName: '',
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(images ? { inputModalities: ['text', 'image']                         } : {}),
      ...(meta.reasoning === undefined ? {} : { reasoning: true }),
      ...(reasoning.supportedEfforts === undefined ? {} : { reasoningEfforts: reasoning.supportedEfforts }),
      ...(reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: reasoning.defaultEffort }),
      ...(effective === undefined
        ? {}
        : {
            multiplier: effective.value,
            // `0` = 免费。用 `free` 标出来，让核心层的 `formatMultiplier`
            // 与倍率无关地也能显示「免费」（它的判据是 `free === true || multiplier === 0`）。
            ...(effective.value === 0 ? { free: true } : {}),
            multiplierSource: 'buddy:config',
          }),
      // ⚠️ **只在促销真的改变了价格时**才写 description。
      //
      // 两个都要排除的噪音情形：
      //   1. 无促销 —— 倍率本身已经渲染成 `(×0.34)`，再写「倍率 x0.34」纯属噪音；
      //   2. **促销后价格与促销前相同** —— 实测（2026-10-20）`hy3` / `deepseek-v4.1-flash`
      //      / `step-5-preview` 的 `credits` 本来就是 `"x0.00"`（免费），而活动又给
      //      一个 `factor: 0` 的免费，于是文案拼成 `x0.00→免费` —— 「免费→免费」，
      //      信息量为零，还会让用户以为漏看了什么。
      //
      // 有**实质**促销时则必须写：界面只显示一个促销价，用户无从判断这是不是活动价、
      // 也无从对账（原价丢了就核不出来）。
      ...(discounted !== undefined && rateText !== undefined && discounted.value !== rate?.value
        ? { description: `倍率 ${rateText}` }
        : {}),
    }
  })
}

/**
 * 一次请求要带的头（凭证 + 身份归因 + 会话）。
 *
 * ## ⚠️ 三个会话头：国际版的**渠道校验**门槛（真实缺陷，2026-10-20）
 *
 * 用户报障原文：`{"code":11128,"msg":"request illegal"}` +
 * 「This call failed channel verification, possibly because it was not sent from
 * an offici[al channel]」。
 *
 * 上游把它伪装成「内容被拦截」，但**决定性 A/B 实验**（真实 workbuddy-intl 账号，
 * 只差请求头）证明它是**渠道校验**：
 *
 * | 请求头 | 结果 |
 * |---|---|
 * | 只有下面那 10 个身份头 | ✗ HTTP 400 `code=11128` |
 * | ＋`X-Conversation-ID` | ✗ HTTP 400 `code=11128` |
 * | ＋**三个**会话头 | ✓ **HTTP 200** |
 *
 * 即**必须同时带齐三个**，缺任一个都不行。参考实现（`buddy-adapter.ts:1792-1796`）
 * 也只对国际版加。
 *
 * ## ⚠️ `11128` 有**两个互不相干的子原因**，修好头只是解决了第一个
 *
 * 这一点很容易看漏，因为**修头之前两个原因的报错文案是同一句笼统话**
 * （"Request blocked…channel verification"），**根本分不出来**；修好之后
 * `msg` 才变成**具体**的，第二个子原因才暴露出来。实测（真实账号，headers 齐）：
 *
 * | 消息形态 | 结果 |
 * |---|---|
 * | ① 首条是 **user**（不带 system） | ✗ `11128` msg=**"first message is not system prompt"** |
 * | ② 首条是 system（中性） | ✓ HTTP 200，正文正常 |
 * | ③ system 里含内容指纹句 | ✗ `11128` msg=**"Illegal API invocation from an unapproved channel"** |
 * | ④ 指纹句放在 **user** 里 | ✓ HTTP 200（印证参考实现：**只拦 system**） |
 *
 * 于是：
 *   1. **缺三个会话头** → 本函数修（渠道校验）；
 *   2. **首条不是 system**（仅国际版硬要求）→ 见 {@link BuddyAdapter.requestChatStream}
 *      里的补 system 逻辑；
 *   3. **内容指纹** → **我们不需要处理**：DSH 的提示词不含该句，实测 200。
 *      参考实现确实有一层「内容指纹剥离」，但那是**另一回事**，别顺手搬进来
 *      （会给上游加没人验证过的行为）。
 *
 * ⚠️ **顺序依赖很值得留**：同一个错误码在修掉第一层之前会**掩盖**第二层。
 * 排查这类「一个码多个原因」的缺陷时，先把**结构性**的那层（头/参数）
 * 修掉并重新测量，再去解释文案 —— 否则会拿着被掩盖的文案去猜内容。
 *
 * @param sessionId - 会话标识。同一次会话内**稳定**（换了它前缀缓存会失效，
 *   但更重要的是保持「一次对话一个 id」的语义）。见 {@link BuddyAdapter} 的字段说明。
 * @param messageId - 本条消息的 id（每次调用**新值**）。
 * @param requestId - 本次请求的 id（每次调用**新值**）。
 */
export function buddyHeaders(
  product              ,
  token        ,
  modelId        ,
  session                                                              ,
)                         {
  const headers                         = {
    authorization: `Bearer ${token}`,
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'x-domain': product.apiDomain,
    'x-product-code': product.productCode,
    'x-product': product.attributionName,
    'x-agent-purpose': 'conversation',
    'x-ide-name': product.attributionName,
    'x-ide-type': product.attributionName,
    'x-ide-version': product.clientVersion,
    'user-agent': userAgentFor(product, modelId),
  }
  // 三个会话头**只对需要它的产品加**（国际版走 `buddyChatHeaders` 自己那一套）。
  if (product.requiresConversationHeaders && session !== undefined) {
    headers['x-conversation-id'] = session.sessionId
    headers['x-conversation-message-id'] = session.messageId
    headers['x-conversation-request-id'] = session.requestId
  }
  // 前缀缓存用的会话三件套（国内版）：实测**三头齐发**才命中，只发一个仍是 0%。
  if (product.sendConversationHeaders === true && session !== undefined) {
    headers['x-conversation-id'] = session.sessionId
    headers['x-conversation-request-id'] = session.requestId
    headers['x-root-request-id'] = session.requestId
  }
  return headers
}

/** 一次对话请求要带的三个 id（形态见 {@link buddyChatHeaders}）。 */
                               
                              
                        
                                             
                       
                                          
                   
 

/**
 * **对话请求**要带的头 —— 按「内嵌 CLI 客户端」的真实形态发（2026-10-23 真机抓包，
 * `docs/WORKBUDDY-INTL-REQUEST.md` + `docs/workbuddy-intl-capture/`）。
 *
 * ## 为什么单独一个函数，不改 `buddyHeaders`
 *
 * `buddyHeaders` 同时服务 `/v3/config` 等非对话路径，那边的形态**没有**抓包
 * （只有参考实现的桌面端形态），而且已被实测验证可用。把对话路径独享的真实
 * 形态放新函数里，`/v3/config` 与国内版**一行都不动** —— 最小爆炸半径。
 *
 * ## 与真实客户端逐条对齐（抓包 = 35 个头）
 *
 * | 头 | 客户端真实形态 | 说明 |
 * |---|---|---|
 * | `authorization` | `Bearer <token>` | 官方账号是 JWT |
 * | `x-api-key` | 仅 `sk-…` 凭据 | ⚠️ JWT 塞进去 = 401 `{"message":"not_found"}`（A/B 实测） |
 * | `accept` | `application/json` | **不是** `text/event-stream`；流式由 body.stream 决定 |
 * | `x-requested-with` | `XMLHttpRequest` | |
 * | `x-codebuddy-request` | `1` | |
 * | `x-agent-type` | `main` | |
 * | `x-agent-intent` | `craft` | 对话路径的取值 |
 * | `x-agent-purpose` | `conversation` | 与旧形态一致 |
 * | `x-conversation-id` | UUID，按会话稳定 | |
 * | `x-conversation-request-id` = `x-root-request-id` | 32 hex，按会话稳定 | 是同一条 root id |
 * | `x-conversation-message-id` = `x-request-id` | 32 hex，每次新值 | 是同一条 message id |
 * | `traceparent` / `b3` / `x-b3-*` / `x-trace-id` | trace-id = root request id | 链路天然串起一次对话 |
 * | `x-stainless-*` | openai-node 指纹 | 7 个，见 {@link stainlessHeadersOf} |
 * | `x-user-id` | 登录账号 uid | 有才发 |
 * | `x-ide-*` | `CLI` / `CLI` / `2.137.1` | **不是** 产品名 + 桌面端版本 |
 * | `x-product` | `SaaS` | 抓包实测；国际版 CLI 不发 `x-product-code` |
 * | `user-agent` | `CLI/2.137.1 WorkBuddy AI/2.137.1` | |
 *
 * ⚠️ `x-private-data`（`X-Private-Data`）**刻意不发**：客户端对官方请求会带它，
 * 但内容不可复现 —— 伪造一个错误的内容比缺一个头更容易被风控盯上。
 *
 * ⚠️ 国内版（`requiresConversationHeaders: false` 且无 `chatIdentity`）原样走
 * {@link buddyHeaders}：那边没有抓包依据，不加没验证过的头。
 */
export function buddyChatHeaders(
  product              ,
  token        ,
  modelId        ,
  ids              ,
  userId         ,
)                         {
  // 国内版 / 未配置对话形态的产品：保持旧形态（五个身份头 + Bearer），
  // 但**把会话三件套传进去** —— 否则前缀缓存 key 缺失，每轮都按全新会话计费。
  if (product.chatIdentity === undefined) {
    return buddyHeaders(product, token, modelId, {
      sessionId: ids.conversationId,
      messageId: ids.messageId,
      requestId: ids.rootRequestId,
    })
  }

  const identity = product.chatIdentity
  const headers                         = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
    'x-domain': product.apiDomain,
    ...(identity.productCode ? { 'x-product-code': product.productCode } : {}),
    'x-product': identity.xProduct ?? product.attributionName,
    'x-agent-purpose': 'conversation',
    'x-agent-type': AGENT_TYPE_MAIN,
    'x-agent-intent': AGENT_INTENT_CRAFT,
    'x-ide-name': identity.ideName,
    'x-ide-type': identity.ideType,
    'x-ide-version': identity.ideVersion,
    'user-agent': product.chatUserAgent ?? userAgentFor(product, modelId),
    // ⚠️ `x-api-key` **只对 API key 形态的凭据发**（`sk-…`）。
    // 官方账号 token 是 JWT：把它塞进这个头，上游当成「错误的 API key」直接
    // 401 `{"message":"not_found"}`（2026-10-23 真账号 A/B 实测，见
    // docs/WORKBUDDY-INTL-REQUEST.md §8）。抓包里那个头来自**自定义模型**的 key。
    ...(token.startsWith('sk-') ? { 'x-api-key': token } : {}),
    // 三个会话头：会话 id 稳定；root 与 message 两条**不是同一个值**
    // （抓包：root/conversation-request-id 稳定，message/request-id 每次新值）。
    'x-conversation-id': ids.conversationId,
    'x-conversation-request-id': ids.rootRequestId,
    'x-root-request-id': ids.rootRequestId,
    'x-conversation-message-id': ids.messageId,
    'x-request-id': ids.messageId,
  }
  // 账号 uid 有才发（与 creditsHeaders 同款口诀：空串头比缺头更坏事）。
  if (userId !== undefined && userId !== '') headers['x-user-id'] = userId
  // 链路头：trace-id 用 root request id（抓包里两者同值），span 每次新值。
  const spanId = newSpanId()
  const parentSpanId = newSpanId()
  Object.assign(headers, traceHeadersOf(ids.rootRequestId, spanId, parentSpanId))
  // SDK 指纹：openai-node 的 stainless 头族。
  Object.assign(headers, stainlessHeadersOf())
  return headers
}

/** 从 `{code, data, message}` 信封里取 data。 */
function unwrapData(body         )                                 {
  if (typeof body !== 'object' || body === null) return null
  const data = (body                           ).data
  if (typeof data !== 'object' || data === null) return null
  return data                           
}

/**
 * 把上游的拒绝报文变成**人能读**的一句话。
 *
 * ## 为什么不能直接 `text.slice(0, 300)`
 *
 * 腾讯的错误体是 JSON，`code 11-128` 那条的第 300 个字符正好落在
 * `displayTips.en` 中间（`…possibly beca`）—— 用户截给我们的、以及插件事后
 * 记进请求日志的，都是这个被切断的样子。而**恰恰是后半句在解释「为什么被拒」**。
 * 2026-10-28 国内版那次 11-128 就栽在这上面：只看到「渠道校验失败」，
 * 原因全被切掉了。
 *
 * 所以这里解析出结构化字段，拼成 `code · msg｜中文提示｜英文提示（requestId）`；
 * 解析不出来才退回原文（仍然截断 —— 上游可能回一整页 HTML，不能原样灌进日志）。
 */
export function describeBuddyErrorBody(text        , status        )         {
  const trimmed = text.trim()
  const fallback = trimmed === '' ? `HTTP ${status}` : `HTTP ${status} ${trimmed.slice(0, 300)}`
  let body         
  try {
    body = JSON.parse(trimmed)
  } catch {
    return fallback
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fallback
  const record = body                           
  /** 按顺序收集**去重后的**非空字符串；`displayMsg` / `displayTips` 是 `{zh,en}`。 */
  const gather = (values           )           => {
    const out           = []
    for (const value of values) {
      if (typeof value !== 'string') continue
      const one = value.trim()
      if (one !== '' && !out.includes(one)) out.push(one)
    }
    return out
  }
  const display = (key        )           => {
    const value = record[key]
    if (value === null || typeof value !== 'object') return []
    const copy = value                           
    return gather([copy.zh, copy.en])
  }
  const code = record.code === undefined ? '' : String(record.code)
  const head = [code, typeof record.msg === 'string' ? record.msg.trim() : ''].filter((one) => one !== '').join(' · ')
  const tips = [...display('displayMsg'), ...display('displayTips')]
  // 跨字段也要去重：`msg` 与 `displayMsg.zh` 经常是同一句。
  const parts           = []
  for (const one of [head, ...tips]) {
    if (one !== '' && !parts.includes(one)) parts.push(one)
  }
  if (parts.length === 0) return fallback
  const requestId = typeof record.requestId === 'string' && record.requestId !== '' ? `（requestId=${record.requestId}）` : ''
  return `${parts.join('｜')}${requestId}`
}

/** 把上游响应压成一句话（错误展示用，截断 200 字）。 */
function summarize(body         )         {
  if (typeof body === 'string') return body.slice(0, 200)
  try {
    const text = JSON.stringify(body)
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return ''
  }
}

/**
 * 按**产品**算能力表。
 *
 * ⚠️ 不要把这份表变回「两个产品共用的常量」：国内有签到、国际没有，共用一份
 * 必然有一边在撒谎。这里的差异**只有 `checkIn` 一项**，其余两项产品相同。
 *
 * `quota` 两个产品都是 `true` —— 见 `buddy-credits.ts` 的 `USER_RESOURCE_PATH`
 * 说明：余额查询两边都实现，与签到是**彼此独立**的能力。
 */
export function capabilitiesFor(product              )                    {
  return {
    checkIn: product.hasDailyCheckin,
    quota: true,
    models: true,
    tasks: false,
    chat: true,
    reasoning: true,
    source: 'static',
    notes: {
      checkIn: product.hasDailyCheckin
        ? '每日签到（POST /v2/billing/meter/daily-checkin）。幂等判据是响应体 code 10001，不是 HTTP 状态码'
        : '该产品没有签到接口（国际版内核里不存在 checkin-status / daily-checkin），调用时不会向上游发任何请求',
      quota: '积分余额（POST /v2/billing/meter/get-user-resource）。取本计费周期口径 CycleCapacityRemain，只累加有效包',
      tasks: '上游没有活动任务接口',
    },
  }
}

/** WorkBuddy / WorkBuddy International 适配器。 */
export class BuddyAdapter extends BaseAdapter {
                   product              
  /** 上一次 `getModelMetaList()` 是不是用的内置表（见 `modelListSource()`）。 */
          modelListFromFallback = false

  constructor(product              ) {
    super({
      id: product.agentId,
      name: product.displayName,
      doc: product.endpoint,
      credentialHint: '粘贴 access_token（Bearer）。免费额度见上游账号页。',
      // 能力表按产品算：国内有签到、国际没有（见 capabilitiesFor 的说明）。
      capabilities: capabilitiesFor(product),
      implemented: true,
    })
    this.product = product
  }

  /**
   * 三个会话头用的会话标识（`X-Conversation-ID` / 前缀缓存 key）。
   *
   * ## 为什么按账号**确定性派生**，而不是随机 / 落盘
   *
   * 参考实现是「进程启动时 `crypto.randomUUID()` 一次，整个进程复用」。
   * 我们不能照抄这个「一次」的粒度，因为参考实现一个进程只服务**一个**凭据，
   * 而我们一个适配器实例服务**多个账号**：
   *
   *   - **随机 + 每次请求新值** —— 不行：这个 id 同时是前缀缓存的 key
   *     （参考实现把它作为 `prompt_cache_key` 下发，实测同一段 8k 前缀：
   *     不带 → `prompt_cache_hit_tokens=0`、`credit=0.34`；带 → `hit_tokens=7808`、
   *     `credit=0.02`，**费用差约 17 倍**）。每次新值等于**彻底放弃缓存**。
   *   - **随机 + 进程内稳定** —— 可行，但重启后变化；且多账号共用一个实例时
   *     会把不同账号的会话混成同一个 key（前缀缓存是**按账号**隔离的，
   *     共用 key 没有正确性问题，但让缓存命中统计失去意义）。
   *   - **按账号派生（选它）** —— 同一账号每次重启得到同一个 id（`sha256(agentId:accountId)`
   *     取前段），于是前缀缓存跨重启也能命中；不同账号天然不同。
   *     仓库里已有同款先例：`src/adapters/qoder.ts` 的 `machineIdOf(accountId)`。
   *
   * 不需要落盘（它是**纯函数**，没有迁移/清理问题），也不需要存进凭据。
   *
   * ⚠️ 形态对齐抓包：客户端发的是 **UUID**（`bff4befa-1477-4313-85ab-bf9e436f4502`），
   * 所以用 `uuidFromSeed()` 把同一份哈希格式化成 UUID v4 形态（版本位/变体位写死）。
   * 确定性不变（同一账号每次重启同一个 id），只是**外形**换成客户端的样子。
   */
          sessionIdOf(record               )         {
    return uuidFromSeed(`buddy:${this.product.agentId}:${record.id}`)
  }

  /**
   * 会话的 **root request id**（`x-conversation-request-id` = `x-root-request-id`）。
   *
   * 抓包里它**每次会话稳定**（`752abbd0…`），而 `x-request-id` /
   * `x-conversation-message-id` 每次调用新值 —— 现在的实现把这两件事做对了：
   * root 按会话派生、message 每次随机。
   *
   * 它同时是链路头的 `trace-id`（客户端发 `x-trace-id` 与它同值），于是同一次
   * 对话的所有请求在服务端的 trace 视图里天然串成一条。
   */
          rootRequestIdOf(record               )         {
    return hex32(`buddy-root:${this.product.agentId}:${this.sessionIdOf(record)}`)
  }

  /** 思考档位在 `ctx.cache` 里的键（**按产品**隔离：两个产品的模型池不同）。 */
          reasoningCacheKey()         {
    return `buddy:reasoning:${this.product.agentId}`
  }

  /**
   * 把 `/v3/config` 里每个模型的思考字段存进缓存，供请求侧查。
   *
   * 为什么需要缓存：请求侧（`requestChatStream`）只看得到 `payload.model`，
   * **拉不到模型目录**（那是一次额外的上游请求，不能每个 chat 都打一遍）。
   * 而「能不能发 `reasoning_effort`」必须知道该模型声明了什么 ——
   * 发它没声明过的值上游会 **400**。
   *
   * ⚠️ 缓存**缺失**时的行为是「放行」而不是「拦下」，见 {@link effortsOf}。
   */
          cacheReasoning(ctx                , body         )       {
    const data = (body                                         )?.data
    const models = (data                                           )?.models
    if (!Array.isArray(models)) return
    const table                                                                                          = {}
    for (const item of models) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item                           
      const id = entry.id
      if (typeof id !== 'string' || id === '') continue
      const fields = parseReasoningFields(entry)
      // 三条都缺就别存 —— 存一个空对象等于「确认该模型没有档位」，
      // 而事实可能是「上游这条目录里没写」。区分见 effortsOf 的说明。
      if (fields.supportedEfforts === undefined && fields.defaultEffort === undefined && fields.singleEffort === undefined) {
        continue
      }
      table[id] = {
        ...(fields.supportedEfforts === undefined ? {} : { supported: fields.supportedEfforts }),
        ...(fields.defaultEffort === undefined ? {} : { defaultEffort: fields.defaultEffort }),
        ...(fields.singleEffort === undefined ? {} : { singleEffort: fields.singleEffort }),
      }
    }
    // TTL 与模型目录缓存同量级（5 分钟）：上游改档位不是高频事件，
    // 但也不能永久缓存（新模型上线后要能自己好）。
    ctx.cache.set(this.reasoningCacheKey(), table, 5 * 60_000)
  }

  /**
   * 查某模型声明了什么档位（`undefined` = **不知道**）。
   *
   * ⚠️ **两种「没有」必须分开**（与 `decideReasoningEffort` 的 `supported` 同款口径）：
   *   - 缓存里**根本没有这个模型**（目录没拉到 / 还没拉过 / 新模型）⇒ 返回 `undefined`
   *     ⇒ 调用方**放行**用户请求的档位。拦下来等于把用户的显式选择静默丢掉，
   *     而我们其实只是「不知道」。
   *   - 缓存里有这个模型、但它**没有** `supported` 字段 ⇒ 返回 `[]`
   *     ⇒ 调用方**不下发**请求的档位（上游对该字段会校验，发没声明过的值 = 400）。
   */
          effortsOf(ctx                , modelId        )                                                                                               {
    const table = ctx.cache.get                                                                                         (
      this.reasoningCacheKey(),
    )
    if (table === undefined) return undefined
    const entry = table[modelId]
    if (entry === undefined) return undefined
    return {
      supported: entry.supported ?? [],
      ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }),
      ...(entry.singleEffort === undefined ? {} : { singleEffort: entry.singleEffort }),
    }
  }

  /**
   * 保证 `messages[0]` 是 `system`（**仅国际版**）。
   *
   * ## 为什么需要它（真实缺陷，`11128` 的第二个子原因）
   *
   * WorkBuddy 国际版网关**强制要求首条消息是 `role:'system'`**，否则：
   * ```
   * HTTP 400  {"code":11128,"msg":"first message is not system prompt"}
   * ```
   * 而 `displayMsg` 把它**伪装成安全策略拦截**（「请求被安全策略拦截，请稍后重试
   * 或联系支持」）—— 与真实的限流/可用性**毫无关系**，极易误判。
   *
   * ## 为什么会在我们这里踩到
   *
   * `src/llm/adapter.ts` 的 `toOpenAiMessages()` **只在 `options.system` 非空时**
   * 才 unshift 一条 system。DSH 有时不带 system（或 system 为空串），
   * 于是 wire 上首条就是 `user` ⇒ **必踩这个 400**。
   *
   * 参考实现在**适配器内部**兜了同一层（`buddy-adapter.ts:1350-1352`）：
   * ```ts
   * if (this.product.id === 'workbuddy' && (messages.length === 0 || messages[0].role !== 'system')) {
   *   messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
   * }
   * ```
   *
   * ⚠️ 三条与参考实现逐条对齐的口径：
   *   1. **只对国际版**补（`requiresConversationHeaders` 的产品）。参考实现实测
   *      `copilot.tencent.com`（国内版）无此要求 —— 无 system 也 200。
   *   2. **只在首条不是 system 时**补；**已有 system 原样保留**（不覆盖、不追加第二条）。
   *   3. 内容用最小可用句 `'You are a helpful assistant.'` —— 这句在参考实现的
   *      e2e 与多个脚本里被反复验证可用（见 `account-probe.ts:123` 的 `PROBE_SYSTEM`）。
   *
   * ⚠️ **不要顺手把「内容指纹剥离」也搬进来**：参考实现里确实有那一层，
   * 但实测 DSH 的提示词不含指纹句（200 正常），搬进来只会给上游加没人验证过的行为。
   */
          withLeadingSystem(messages                         )                          {
    if (!this.product.requiresConversationHeaders) return messages
    const first = messages[0]
    if (first !== undefined && first.role === 'system') return messages
    return [{ role: 'system', content: BUDDY_MINIMAL_SYSTEM }, ...messages]
  }

  /**
   * 给 user 消息补客户端的**形态标记** `agent: "cli"`（仅国际版）。
   *
   * 抓包里每条 user 消息都带这个非标字段（客户端内部消息格式透传出来的），
   * system 消息没有。官方网关既然收客户端的请求就必须容忍它 —— 补上它把
   * 请求体形状也拉到客户端的样子；国内版没有抓包依据，不加。
   */
          withClientMessageShape(messages                         )                          {
    if (!this.product.requiresConversationHeaders) return messages
    return messages.map((m) => (m.role === 'user' ? { ...m, agent: 'cli' } : m))
  }

  /** 端点：配置里填了 `apiBaseUrl` 就用它（接自有反代），否则用内置产品地址。 */
          baseUrl(ctx                )         {
    const configured = ctx.config.upstream.apiBaseUrl.trim()
    return (configured !== '' ? configured : this.product.endpoint).replace(/\/+$/, '')
  }

          tokenOf(record               )         {
    const token = record.credentials.token
    return typeof token === 'string' ? token : ''
  }

  /**
   * 签到/余额这类**业务接口**的头族。
   *
   * 头**集合**与参考实现的 `credits.ts` → `checkinHeaders`（第 275–292 行）逐条对齐：
   * `Authorization` / `Accept` / `Content-Type` / `X-Domain` / `X-Product` /
   * `X-Product-Code` / `User-Agent`（+ 可选的 `X-User-Id`、`X-Enterprise-Id`、
   * `X-Tenant-Id`）。**没有多加一个头**。
   *
   * ⚠️ **不含 `X-Device-Token`（图灵盾）**：静态分析曾认为该头是主要门槛，但实测
   * 三种请求头组合调用状态接口全部 200，且完全不带该头的请求真实领取成功
   * （code:0, credit:100）并可见状态翻转。故不引入 native SDK。（参考实现实测结论。）
   *
   * ⚠️ **不含 `X-Agent-Purpose` / `X-IDE-*`**：那三个是**对话**请求的形态头，
   * 参考实现的 `checkinHeaders` 里没有，这里也不加。
   *
   * ## ⚠️ 一个必须说清的**分歧**：`X-Product` 到底发什么
   *
   * 参考实现**自己内部就不一致**，两条路径发了不同的值：
   *
   * | 路径 | 出处 | `X-Product` 的值 |
   * |---|---|---|
   * | 对话 | `buddy-adapter.ts:1787` | `product.attributionName`（`CodeBuddy` / `WorkBuddy`） |
   * | 签到 / 余额 | `credits.ts:281` | `BUDDY_DEPLOYMENT_TYPE` = **`SaaS`** |
   *
   * 而 `buddy-adapter.ts:1781` 的注释明确说：`X-Product` 是**归属名**，
   * 「历史实现发成 `SaaS`（部署类型语义）导致后台归因不到产品」。也就是说
   * **对话路径把这件事修过了，签到路径没修**（`buddy-oauth.ts:375` 也仍是 `SaaS`）。
   *
   * **我们这里照抄 `SaaS`**，理由不是「它更对」，而是它是**唯一被实测验证过能通的
   * 取值** —— `credits.ts` 模块头记录的「真实领取成功（code:0, credit:100）」
   * 那次请求，`X-Product` 发的就是 `SaaS`。而发 `attributionName` 在签到端点上
   * **没有任何实测证据**。
   *
   * 取舍是**不对称**的：照抄 `SaaS` 最坏的结果是后台「使用端」列显示 `-`（纯展示
   * 归因问题）；换成 `attributionName` 若被端点校验，最坏结果是签到与额度**整个不可用**。
   * 本机没有 WorkBuddy 账号，无法验证后者 —— 所以选**有证据的那个**。
   *
   * ☞ 待办（留给 Lead 决定，不在本任务写作用域内）：若将来能用真实账号验证
   * `attributionName` 在签到端点上也通，应把两处统一成归属名，并回报给参考实现。
   */
          creditsHeaders(record               )                         {
    const headers                         = {
      authorization: `Bearer ${this.tokenOf(record)}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'x-domain': this.product.apiDomain,
      // 见上方「X-Product 到底发什么」：照抄参考实现 credits.ts 的实测取值。
      'x-product': BUDDY_DEPLOYMENT_TYPE,
      'x-product-code': this.product.productCode,
      'user-agent': this.product.userAgent,
    }
    // 账号/企业标识可选（没有就不发）—— 参考实现同样只在这两个字段非空时才带上：
    // 空串头发出去会被网关当成「有值但为空」，反而坏事。
    // ⚠️ 两种命名都认：参考实现用 snake_case（`user_id` / `enterprise_id`），
    //    而本插件其他适配器的习惯是短名（如 Qoder 的 `uid`）。手工粘贴凭据的用户
    //    可能写成任一种，认两种不会错，只认一种会静默少发头。
    const userId = firstNonEmpty(record.credentials.user_id, record.credentials.userId)
    if (userId !== undefined) headers['x-user-id'] = userId
    const enterpriseId = firstNonEmpty(record.credentials.enterprise_id, record.credentials.enterpriseId)
    if (enterpriseId !== undefined) {
      headers['x-enterprise-id'] = enterpriseId
      headers['x-tenant-id'] = enterpriseId
    }
    return headers
  }

  /**
   * 模型目录：`GET /v3/config`。失败回退内置表，但**不假装成功**。
   *
   * ⚠️ **没有 token（= 还没登录）时返回空列表**：内置表是产品级目录，登录前也
   * 拿得到，但一个模型都调不动；列出来只有一堆「未知倍率」，用户会以为已经能用
   * （报障原话：「还没登录账号就拉取到了模型，但是倍率是未知」）。
   */
  async getModelMetaList(record               , ctx                )                       {
    const token = this.tokenOf(record)
    if (token === '') return []
    const url = `${this.baseUrl(ctx)}/v3/config`
    let parsed              = []
    this.modelListFromFallback = false
    try {
      const send = ctx.fetch ?? fetch
      const response = await send(url, {
        method: 'GET',
        headers: buddyHeaders(this.product, token, ''),
      })
      if (response.ok) {
        const body          = await response.json()
        parsed = parseModelsFromConfig(body)
        // 顺手把「每个模型声明了什么档位」缓存起来 —— 请求侧要用它决定发不发
        // `reasoning_effort`（发模型没声明过的值会 400）。
        // 见 `effortsOf()` 的说明：拿不到缓存时**放行**而不是拦下。
        this.cacheReasoning(ctx, body)
      } else {
        this.modelListFromFallback = true
        ctx.log.warn(
          `/v3/config 返回 ${response.status}，回退内置模型表`,
          '本次模型能力（思考档位 / 上下文）可能不完整，界面上的档位选择会受影响',
        )
      }
    } catch (error) {
      this.modelListFromFallback = true
      ctx.log.warn(
        `/v3/config 拉取失败，回退内置模型表：${error instanceof Error ? error.message : String(error)}`,
        '本次模型能力（思考档位 / 上下文）可能不完整，界面上的档位选择会受影响',
      )
    }

    const source =
      parsed.length > 0
        ? parsed
        : (FALLBACK_MODELS[this.product.agentId] ?? []).map((item) => ({
            id: item.id,
            name: item.name,
            agentId: this.id,
            agentName: this.name,
            contextWindow: item.contextWindow,
            ...(item.images ? { inputModalities: ['text', 'image']                         } : {}),
            // ⚠️ 回退表也必须带档位声明：DSH 核心层把 `reasoning === undefined`
            // 当成「不支持任何档位」，用户一配 `reasoningEffort` 就整轮抛
            // `UNSUPPORTED_REASONING_EFFORT`（issue #4）。没测过的模型留空。
            ...(item.efforts === undefined ? {} : { reasoningEfforts: [...item.efforts] }),
            ...(item.defaultEffort === undefined ? {} : { defaultReasoningEffort: item.defaultEffort }),
          }))

    // 归属字段由核心层统一填，这里只保证 id/name/窗口/能力。
    return source.map((meta) => ({ ...meta, agentId: this.id, agentName: this.name }))
  }

  /**
   * 上一次 `getModelMetaList()` 的数据来源。
   *
   * `'fallback'` = 内置表（目录没拉到）。运行时据此**不要**拿它覆盖落盘缓存：
   * 一份缺 reasoning 的 11 条表盖掉 21 条真实目录，会把「偶发网络失败」变成
   * 「档位永久丢失」，直到下次成功拉取为止。
   */
  modelListSource()                      {
    return this.modelListFromFallback ? 'fallback' : 'live'
  }

  // ───────────────────────── 每日签到 ─────────────────────────

  /**
   * 每日签到。
   *
   * 事实来源：`dsh-our-free-model` 的 `vendor/channel-pack/src/credits.ts`（MIT），
   * 端点为对 WorkBuddy 5.5.6 逆向 + 2026-09-14 真实请求实测。
   *
   * 两段式：先查 `checkin-activity-status`（**权威**状态源），再按需 `daily-checkin`。
   * 先查状态能省掉一次无效的领取请求（活动未开 / 今天已领时直接短路）。
   *
   * ⚠️ **第一步就是产品守卫**：没有签到接口的产品在这里返回，**不发任何上游请求**。
   * 理由见文件头「国际版 checkIn 的守卫」—— 少了它就会用国际版凭据去打国内版端点，
   * 必然失败，而且是一次**真实**的上游请求。
   */
  async checkIn(record               , ctx                )                         {
    const at = ctx.now()

    // ① 产品守卫。**必须放在任何网络调用之前**，且不能靠「试一次再判」——
    //    「不支持」是产品事实，不是探测结果。
    if (!this.product.hasDailyCheckin) {
      return {
        ok: false,
        supported: false,
        message: `${unsupportedReason(this.name, '每日签到')}。该产品只在 CodeBuddy（国内版）提供签到，国际版内核里没有签到接口`,
        at,
      }
    }

    const token = this.tokenOf(record)
    if (token === '') {
      return { ok: false, supported: true, message: '没有 access_token，请先填凭证', kind: 'auth', at }
    }

    const base = this.baseUrl(ctx)
    const headers = this.creditsHeaders(record)

    // ② 状态预检。拿不到状态（status === null）**不判定**，继续尝试领取 ——
    //    「不知道」不等于「不能领」，交给领取接口以响应体 code 定夺。
    const statusResult = await ctx.http(`${base}${CHECKIN_ACTIVITY_STATUS_PATH}`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    if (!statusResult.ok) {
      // 状态查询本身失败：如实回报故障，不猜「今天已领」。
      // （404 例外见下：端点不存在 = 该产品没有签到，不是故障。）
      if (statusResult.kind === 'not_found') {
        return {
          ok: false,
          supported: false,
          message: `${unsupportedReason(this.name, '每日签到')}（${CHECKIN_ACTIVITY_STATUS_PATH} 返回 404）`,
          at,
        }
      }
      return {
        ok: false,
        supported: true,
        message: statusResult.message ?? `签到状态查询失败（HTTP ${statusResult.status}）`,
        kind: statusResult.kind,
        at,
      }
    }

    const status = parseCheckinStatus(statusResult.body)
    if (status !== null) {
      if (!status.active) {
        // 「活动没开」有两类语义，这里只报**等一会儿**那类（`actionRequired` 缺省
        // false）。真正「需要用户去别处操作」的情形要在拿到证据后再标，
        // 见 `buddy-credits.ts` 的 `parseClaimOutcome` 说明。
        return {
          ok: false,
          supported: true,
          message: status.activityName !== '' ? `签到活动「${status.activityName}」当前未开启，稍后再试` : '签到活动当前未开启，稍后再试',
          at,
        }
      }
      if (status.todayCheckedIn) {
        // ⚠️ 这是**幂等命中**，不是失败：ok:true。
        // `coversToday` 缺省 true —— WorkBuddy 是普通每日签到，按服务端日结算，
        // 没有「固定时刻刷新」那类歧义（Qoder 才有，见 core/types.ts）。
        const parts = [`今天已签到`]
        if (status.todayCredit > 0) parts.push(`今日已领 ${formatCreditAmount(status.todayCredit)} 积分`)
        if (status.streakDays > 0) parts.push(`连续 ${status.streakDays} 天`)
        return { ok: true, supported: true, credits: 0, message: parts.join('，'), at }
      }
    }

    // ③ 领取。
    const claimResult = await ctx.http(`${base}${DAILY_CHECKIN_PATH}`, {
      method: 'POST',
      headers,
      body: '{}',
    })
    // ⚠️ **不能只看 HTTP 状态码**：重复领取是 400 + code 10001。所以即便 `!ok`
    //    也要解析响应体 —— 幂等判据在 body 里。
    const outcome = parseClaimOutcome(claimResult.body)
    return this.toCheckInResult(outcome, claimResult, at)
  }

  /** 把领取结论翻成 {@link CheckInResult}。 */
          toCheckInResult(
    outcome                   ,
    response                                                                    ,
    at        ,
  )                {
    switch (outcome.kind) {
      case 'claimed':
        return {
          ok: true,
          supported: true,
          credits: outcome.credit,
          message:
            outcome.credit > 0
              ? `签到成功，+${formatCreditAmount(outcome.credit)} 积分${
                  outcome.streakDays > 0 ? `（连续 ${outcome.streakDays} 天）` : ''
                }`
              : `签到成功${outcome.delayedMessage !== undefined ? `：${outcome.delayedMessage}` : '（本次未读回到账积分数）'}`,
          at,
        }
      case 'already-claimed':
        // 400 + code 10001 落在这里。**这是成功而不是失败** —— 报成失败会让
        // 自动签到把它记为故障并反复重试。
        return { ok: true, supported: true, credits: 0, message: outcome.message, at }
      case 'inactive':
        return {
          ok: false,
          supported: true,
          message: outcome.message,
          ...(outcome.actionRequired === true ? { actionRequired: true } : {}),
          at,
        }
      default: {
        // 真实失败。业务码非 0 且不属于上面几类。
        //
        // ⚠️ 响应体不是 JSON 时（`code: -1`）**优先用 HTTP 层的原因**：凭据过期时
        // 腾讯网关返回的是 **HTML 错误页**而不是 JSON。若照搬解析层的「不是 JSON 对象」，
        // 用户既不知道发生了什么，也看不出该重新登录（参考实现里这条是真实缺陷：
        // 用户看到的就是 `Unexpected token '<'` 那句）。
        const httpFailed = !response.ok
        let message = outcome.message
        if (httpFailed && response.kind === 'auth') {
          message = `凭据已失效（HTTP ${response.status}），请重新登录该账号`
        } else if (httpFailed && outcome.code === -1) {
          message = response.message ?? `领取失败（HTTP ${response.status}）`
        }
        return {
          ok: false,
          supported: true,
          message,
          // 业务码非 0 且不属于上面几类 = 真实失败。kind 优先用 HTTP 层分类，
          // 但 400 会被分类成 `bad_request` —— 那正是「不能换号重试」的语义，
          // 对未知业务码是合适的保守选择。
          kind: response.ok ? 'unknown' : response.kind,
          at,
        }
      }
    }
  }

  // ───────────────────────── 积分余额 ─────────────────────────

  /**
   * 积分余额。
   *
   * ⚠️ **两个产品通用**：`get-user-resource` 在 CodeBuddy 中国版与 WorkBuddy 国际版
   * 都实现，请求头与响应结构完全一致，只有 baseURL 不同。**不要**因为「国际版没有
   * 签到」就顺手把余额也关掉 —— 两者是彼此独立的能力（参考实现 2026-09-15 实测）。
   *
   * 取**本计费周期口径**（`CycleCapacityRemain`）而不是终身口径，只累加**有效**包：
   * 理由见 `buddy-credits.ts` 的 `parseCreditPackage` / `parseCreditBalance`。
   * 这与 IDE 顶部的 "Credits Balance" 一致，用户可直接核对。
   */
  async getQuota(record               , ctx                )                         {
    const at = ctx.now()
    const token = this.tokenOf(record)
    if (token === '') {
      return { accountId: record.id, unit: 'credits', fetchedAt: at, error: '没有 access_token，请先填凭证' }
    }

    const result = await ctx.http(`${this.baseUrl(ctx)}${USER_RESOURCE_PATH}`, {
      method: 'POST',
      headers: this.creditsHeaders(record),
      body: '{}',
    })
    if (!result.ok && result.kind === 'not_found') {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt: at,
        error: `${unsupportedReason(this.name, '额度查询')}（${USER_RESOURCE_PATH} 返回 404）`,
      }
    }
    if (!result.ok) {
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt: at,
        error: result.message ?? `额度查询失败（HTTP ${result.status}）`,
      }
    }

    const balance = parseCreditBalance(result.body, at)
    if (balance === null) {
      // 「查不到」与「余额为 0」必须分开：把解析失败显示成 0 积分会误导用户。
      return {
        accountId: record.id,
        unit: 'credits',
        fetchedAt: at,
        error: '上游返回的积分数据无法解析（可能是响应结构变了）',
      }
    }

    // `extra` 原样保留逐包明细，供 UI 展开。包名与单位都保留**服务端原值**
    // （单位不做归一化 —— 归一化只在「当分组键/展示名用」那一步做）。
    const activeCount = balance.packages.filter((pkg) => pkg.active).length
    return {
      accountId: record.id,
      unit: 'credits',
      remaining: balance.total,
      fetchedAt: at,
      extra: {
        packages: balance.packages,
        expiredTotal: balance.expiredTotal,
        packageCount: balance.packages.length,
        activePackageCount: activeCount,
        // 展示口径的单位（`credit` / `credits` 归一成一个分组键，见 normalizeCreditUnit）。
        displayUnit: normalizeCreditUnit(balance.packages.find((pkg) => pkg.active)?.unit ?? ''),
      },
    }
  }

  // ── 登录（external-link-v2 轮询式，**四步**） ──────────────────────
  //
  // 完整流程（参考实现 buddy-oauth.ts 的 `runBuddyLoginFlow`，MIT）：
  //
  //   ① POST /v2/plugin/auth/state?platform=<platform> → {state, authUrl}
  //   ② decorateLoginUrl：国际版给 authUrl 追加 version + loginSessionId
  //   ③ 用户在浏览器打开 authUrl 完成登录
  //   ④ GET  /v2/plugin/auth/token?state=<state>     → token
  //   ⑤ GET  /v2/plugin/login/account?state=<state>  → 账号信息（uid/企业/类型）
  //   ⑥ buildCredentials：token + account 合成凭据
  //
  // ⚠️ **我们原先只做了 ①③④，缺 ②⑤⑥** —— 那正是「授权完却没加进账号」的成因：
  //    - 缺 ②：国际版用户点开的登录页缺会话参数；
  //    - 缺 ⑤：账号信息（uid/企业）从来没被取过；
  //    - 更致命的是 ④ 的**字段名读错**（见 `vendor/buddy/buddy-login.ts` 的文件头：
  //      上游回 camelCase `accessToken`，我们读的是 snake_case `access_token`）
  //      ⇒ 恒判「还没检测到登录」，永远 pending。
  //
  // 宿主的分工：`beginLogin` 只负责 ①②；③④⑤ 都在 `pollLogin` 里做（用户点一次
  // 「刷新登录状态」就问一轮）。**不起定时器** —— 关掉页面后还在后台打上游是浪费。

  /** ① 拿 authUrl 与 state，② 按产品装饰 URL。 */
  async beginLogin(ctx                )                            {
    const url = `${this.baseUrl(ctx)}/v2/plugin/auth/state?platform=${encodeURIComponent(this.product.platform)}`
    const send = ctx.fetch ?? fetch
    const response = await send(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-domain': this.product.apiDomain,
        'x-no-authorization': 'true',
        'x-no-user-id': 'true',
        'x-no-enterprise-id': 'true',
        'x-no-department-info': 'true',
        'user-agent': this.product.userAgent,
      },
    })
    const body          = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`auth/state HTTP ${response.status}：${summarize(body)}`)
    }
    const data = unwrapData(body)
    const state = typeof data?.state === 'string' ? data.state : ''
    const rawAuthUrl = typeof data?.authUrl === 'string' ? data.authUrl : ''
    if (state === '' || rawAuthUrl === '') throw new Error('auth/state 响应缺少 state / authUrl')

    // ② 装饰登录 URL。⚠️ **返回装饰后的 URL**（用户点的是它，不是原始的），
    //    但 `state` 原样保留 —— 后续两步用的是 state，与 URL 装饰无关。
    const authUrl = decorateLoginUrl(rawAuthUrl, this.product)
    if (authUrl !== rawAuthUrl) {
      // 只记「追加了参数」这件事，**不要把完整 authUrl 写进日志**：它带着 state，
      // 等同于一次性的登录凭据。
      ctx.log.info(`[${this.name}] 登录链接已追加会话参数（version / loginSessionId）`)
    }
    ctx.log.info(`[${this.name}] 已生成登录链接，请在浏览器打开`)
    // 5 分钟：与参考实现的登录超时一致
    return { authUrl, expiresInSec: 300, state }
  }

  /**
   * ④ 问一次 token，⑤ 拿到就问一次 account，⑥ 合成凭据。
   *
   * ## 为什么这一步要做三件事而不是一件
   *
   * 上游把「登录完成」拆成两个端点，且**账号信息（uid/企业）只在第二个端点里**。
   * 只调第一个就返回 ready 的话，账号能建起来但**没有 uid** —— 而 uid 是后续
   * 请求要带 `X-User-Id` 的来源。所以必须两步都走完才回 ready。
   *
   * ## 判据（重要，别退回旧写法）
   *
   * 上游用 **HTTP 200 + `body.code`** 报「还没好」（实测：
   * `{"code":11217,"msg":"11217:login ing..."}`）。所以**不能只看 HTTP 状态**，
   * 也不能靠「`data` 取不到 ⇒ 就当 pending」这种副作用 —— 那会在
   * 「响应形状变了」「换成非 200」时静默错判。这里**显式**判 `code`：
   *   - `11217` ⇒ pending（用户还没授权，正常中间态）
   *   - 其他非 0 ⇒ **failed**（别静默 pending 到超时，用户会以为是自己的问题）
   */
  async pollLogin(state         , ctx                )                           {
    const key = this.loginStateOf(state)
    if (key === '') return { status: 'failed', message: '登录会话状态丢失，请重新发起' }

    // ④ token
    const tokenStep = await this.fetchLoginToken(key, ctx)
    if (tokenStep.status !== 'ok') return tokenStep.result

    // ⑤ account（拿不到就**不返回 ready** —— 见下面 12151 的说明）
    const accountStep = await this.fetchLoginAccount(key, tokenStep.token.accessToken, ctx)
    if (accountStep.status !== 'ok') return accountStep.result

    // ⑥ 合成凭据。走到这里 accessToken 必然非空（上面已挡过），
    //    所以**绝不会**加进一个空 token 的账号。
    const credentials = buildCredentials(tokenStep.token, accountStep.account)
    const label = accountLabelOf(credentials)
    return {
      status: 'ready',
      message: '登录成功',
      credentials,
      ...(label === '' ? {} : { label }),
    }
  }

  /** 从宿主存下来的 `state` 里取出这一轮的 session key。 */
          loginStateOf(state         )         {
    if (typeof state === 'string') return state
    const session = state                                   
    return typeof session?.state === 'string' ? session.state : ''
  }

  /**
   * ④ `GET /v2/plugin/auth/token?state=`。
   *
   * 未就绪（`code: 11217`）与网络抖动都算 `pending` —— 用户点一次问一次，
   * 不该因为一次网络失败就把整个登录会话判死。但**业务码非 0 且非 11217 是 failed**。
   */
          async fetchLoginToken(
    key        ,
    ctx                ,
  )                                                                                                                       {
    const url = `${this.baseUrl(ctx)}/v2/plugin/auth/token?state=${encodeURIComponent(key)}`
    const send = ctx.fetch ?? fetch
    let response          
    try {
      response = await send(url, {
        method: 'GET',
        headers: { 'x-no-authorization': 'true', 'user-agent': this.product.userAgent },
      })
    } catch (error) {
      return {
        status: 'stop',
        result: { status: 'pending', message: `网络错误，稍后再试：${error instanceof Error ? error.message : String(error)}` },
      }
    }
    const body          = await response.json().catch(() => null)

    // ⚠️ **先判业务码，不论 HTTP 状态**：上游用 200 + code 报「还没好」（实测）。
    const code = responseCode(body)
    if (code === CODE_TOKEN_NOT_READY) {
      return { status: 'stop', result: { status: 'pending', message: '还没检测到登录，请先在浏览器完成登录' } }
    }
    if (code !== 0) {
      // 其他非 0 业务码 = 真失败。静默 pending 会让用户对着「一直在等」干等到超时。
      return {
        status: 'stop',
        result: {
          status: 'failed',
          message: `auth/token 失败（HTTP ${response.status}，code ${code}）：${responseMessage(body) || summarize(body)}`,
        },
      }
    }
    // 非 2xx 且没有业务码：传输层问题，报失败并带上状态码（别伪装成 pending）。
    if (!response.ok) {
      return {
        status: 'stop',
        result: { status: 'failed', message: `auth/token HTTP ${response.status}：${summarize(body)}` },
      }
    }
    // 200 且 code 为 0（或压根没有 code 字段）：看 data。
    const data = responseData(body)
    if (data === null) {
      return { status: 'stop', result: { status: 'pending', message: '还没检测到登录，请先在浏览器完成登录' } }
    }
    const token = parseTokenPayload(data, ctx.now())
    if (token.accessToken === '') {
      // ⚠️ 形状不符（既没有 camelCase 也没有 snake_case 的 token 字段）——
      // 报 failed 而不是 pending：一直 pending 会让人以为是自己没登录成功，
      // 真因是响应结构变了，必须让这句话浮出来。
      return {
        status: 'stop',
        result: {
          status: 'failed',
          message: `auth/token 已返回数据但没有 access token 字段（响应结构可能变了）：${summarize(data)}`,
        },
      }
    }
    return { status: 'ok', token }
  }

  /**
   * ⑤ `GET /v2/plugin/login/account?state=`。
   *
   * 头族照参考实现 `getAccount`（`buddy-oauth.ts:246-265`）：
   * `X-Domain` 取 **token 下发的 domain 优先**（该值是服务端**本次刚下发**的权威值，
   * 不是跨产品迁移后会过期的历史快照 —— 与 `creditsHeaders` 那里「以产品为准」的
   * 方向**故意不同**，差异只在兜底取谁），加 Bearer token 与两个 `X-No-*` 头。
   *
   * ⚠️ **拿不到账号就不返回 ready**：账号信息（uid/企业）只有这里有，
   * 缺了它建出来的账号没有 uid，后续请求带不上 `X-User-Id`。
   * `12151`（账户信息尚未完成）是**正常中间态** ⇒ pending。
   */
          async fetchLoginAccount(
    key        ,
    accessToken        ,
    ctx                ,
  )                                                                                                                           {
    const url = `${this.baseUrl(ctx)}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(key)}`
    const send = ctx.fetch ?? fetch
    let response          
    try {
      response = await send(url, {
        method: 'GET',
        headers: {
          'x-domain': this.product.apiDomain,
          authorization: `Bearer ${accessToken}`,
          'x-no-user-id': 'true',
          'x-no-enterprise-id': 'true',
          'user-agent': this.product.userAgent,
        },
      })
    } catch (error) {
      // token 已经拿到了，别因为一次网络抖动让用户重来一遍登录。
      return {
        status: 'stop',
        result: { status: 'pending', message: `已登录，但读取账号信息时网络出错，请再点一次「刷新登录状态」：${error instanceof Error ? error.message : String(error)}` },
      }
    }
    const body          = await response.json().catch(() => null)
    const code = responseCode(body)
    if (code === CODE_ACCOUNT_NOT_READY) {
      return { status: 'stop', result: { status: 'pending', message: '已登录，正在读取账号信息，请再点一次「刷新登录状态」' } }
    }
    if (code !== 0) {
      return {
        status: 'stop',
        result: {
          status: 'failed',
          message: `读取账号信息失败（HTTP ${response.status}，code ${code}）：${responseMessage(body) || summarize(body)}`,
        },
      }
    }
    if (!response.ok) {
      return {
        status: 'stop',
        result: { status: 'failed', message: `读取账号信息失败（HTTP ${response.status}）：${summarize(body)}` },
      }
    }
    const data = responseData(body)
    if (data === null) {
      return { status: 'stop', result: { status: 'pending', message: '已登录，正在读取账号信息，请再点一次「刷新登录状态」' } }
    }
    return { status: 'ok', account: parseAccountPayload(data) }
  }

  /** 校验：能拿到 `/v3/config` 200 就算凭证可用。 */
  async validateCredentials(
    record               ,
    ctx                ,
  )                                                               {
    const token = this.tokenOf(record)
    if (token === '') return { ok: false, message: '没有 access_token，请先填凭证', kind: 'auth' }
    try {
      const send = ctx.fetch ?? fetch
      const response = await send(`${this.baseUrl(ctx)}/v3/config`, {
        method: 'GET',
        headers: buddyHeaders(this.product, token, ''),
      })
      if (response.ok) return { ok: true, message: '凭证可用（/v3/config 200）' }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: `凭证被拒：HTTP ${response.status}`, kind: 'auth' }
      }
      return { ok: false, message: `上游返回 HTTP ${response.status}`, kind: 'unknown' }
    } catch (error) {
      return { ok: false, message: `连接失败：${error instanceof Error ? error.message : String(error)}`, kind: 'network' }
    }
  }

  /** 对话：标准 OpenAI Chat Completions + SSE。 */
  async *requestChatStream(
    payload             ,
    record               ,
    ctx                ,
    signal             ,
  )                             {
    const token = this.tokenOf(record)
    if (token === '') {
      yield { type: 'error', failure: { kind: 'auth', message: '没有 access_token', at: Date.now() } }
      return
    }
    const url = `${this.baseUrl(ctx)}/v2/chat/completions`
    // 思考档位 / DeepSeek 的 thinking 开关。
    //
    // ⚠️ 这一段是**修「模型不思考」的关键**（参考实现三站点实测，2026-09）：
    //   - 裸请求（无 `reasoning_effort`）→ `reasoning_content` **恒为 0**；
    //   - 仅 `thinking:{type:'enabled'}` → **仍为 0**（该字段单独无效）；
    //   - 仅 `reasoning_effort` → 返回思考；两者都带 → 返回思考。
    //   即 **`reasoning_effort` 才是开关**，`thinking` 保留是为对齐官方客户端出站形态。
    //
    // 而 `reasoning_effort` 又**只发模型声明过的值**（否则服务端 400），
    // 全部判定收在 `decideReasoningEffort` 里（纯函数，可单测）。
    const declaredReasoning = this.effortsOf(ctx, payload.model)
    const reasoning = decideReasoningEffort({
      requested: typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort : undefined,
      ...(declaredReasoning === undefined ? {} : { supported: declaredReasoning.supported }),
      ...(declaredReasoning?.defaultEffort === undefined ? {} : { defaultEffort: declaredReasoning.defaultEffort }),
      ...(declaredReasoning?.singleEffort === undefined ? {} : { singleEffort: declaredReasoning.singleEffort }),
      isDeepSeek: isDeepSeekModel(payload.model),
    })
    ctx.log.debug(`[${this.name}] 思考档位：${reasoning.reason}`, `model=${payload.model}`)

    const body                          = {
      ...payload,
      model: payload.model,
      // 消息归一化三层，**顺序有依赖**，别随手调换：
      //   ① `guardChatMessages` —— 网关守卫（`developer` → `system`，抹掉 DSH 身份句）。
      //      必须是第一层：它把 `developer` 换成 `system` 之后，下一层的「首条是不是
      //      system」判断才会看到真实形态。见 `vendor/buddy/buddy-channel-guard.ts`
      //      的文件头（`code 11-128` 的两个成因与实测表）。
      //   ② `withLeadingSystem` —— 国际版硬要求首条是 system（否则 400
      //      `first message is not system prompt`）。
      //   ③ `withClientMessageShape` —— 给 user 消息补客户端形态标记 `agent:"cli"`。
      messages: this.withClientMessageShape(this.withLeadingSystem(guardChatMessages(payload.messages))),
      stream: true,
      stream_options: { include_usage: true },
      // `reasoning_effort` 覆盖 payload 里那个（核心层可能带了不可移植的原始值）。
      ...(reasoning.effort === undefined ? {} : { reasoning_effort: reasoning.effort }),
      ...(reasoning.thinking ? { thinking: { type: 'enabled' } } : {}),
    }
    // ⚠️ 核心层可能塞了一个**模型不支持**的 `reasoning_effort`（例如它拿不到我们的
    // 档位声明时原样放行）。上面已经重新算过，这里必须把旧值清掉 ——
    // 否则 spread 之后又会被 `undefined` 覆盖不成，留下一个会 400 的值。
    if (reasoning.effort === undefined) delete body.reasoning_effort
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key]

    let response          
    // 提到 try 外面只是为了让 400 分支将来能拿到同一份请求头（不重建，避免与真正发出去的漂移）。
    let requestHeaders                         = {}
    try {
      const send = ctx.fetch ?? fetch
      // id 语义按抓包对齐：conversation-id / root-request-id 按会话稳定，
      // message-id / request-id **每次新值**（32 位十六进制，无连字符）。
      requestHeaders = buddyChatHeaders(
        this.product,
        token,
        payload.model,
        {
          conversationId: this.sessionIdOf(record),
          rootRequestId: this.rootRequestIdOf(record),
          messageId: newRequestId(),
        },
        firstNonEmpty(record.credentials.user_id, record.credentials.userId, record.credentials.uid),
      )
      response = await send(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      // 用户取消 ≠ 网络故障：单独的 kind，路由层不换号、不记账、不冷却。
      const aborted = isAbortError(error, signal)
      yield {
        type: 'error',
        failure: {
          kind: aborted ? 'aborted' : 'network',
          message: aborted ? '已取消' : `连接上游失败：${error instanceof Error ? error.message : String(error)}`,
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
        // 读不到原文也没关系，状态码足够分类
      }
      let parsed          = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // 可能是 HTML 错误页，保留原文
      }
      /**
       * 退避时长与 requestId：**头 + 体两条都要读**。
       *
       * WorkBuddy 的 429 **不带** `Retry-After`（也没有 `X-RateLimit-*`），重置时刻
       * 写在报文里（`…将在 2026-09-30 02:30:30 UTC+8 重置…`）。只读头 ⇒ 永远退到
       * 默认 300s 冷却，上游说「几小时后」，插件按「5 分钟后」放回去反复撞墙。
       */
      const now = Date.now()
      const retryAfterMs = parseRetryAfter(response.headers, now) ?? parseResetAtFromBody(parsed, now)
      const headerRequestId = parseRequestId(response.headers)
      const bodyRequestId =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed                           ).requestId
          : undefined
      const requestId =
        headerRequestId ?? (typeof bodyRequestId === 'string' && bodyRequestId !== '' ? bodyRequestId : undefined)
      yield {
        type: 'error',
        failure: {
          kind: this.detectError(response.status, parsed, response.headers),
          message: describeBuddyErrorBody(text, response.status),
          status: response.status,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(requestId === undefined ? {} : { requestId }),
          at: now,
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
    if (malformed > 0) ctx.log.warn(`本次流共跳过 ${malformed} 条无法解析的事件`)
  }
}


//# sourceURL=src/adapters/buddy.ts