/**
 * WorkBuddy / CodeBuddy 系的**思考档位**：从 `/v3/config` 读能力，并决定请求体里发什么。
 *
 * 事实来源：`dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/buddy.ts`
 * 的 `parseModelMeta()`（905-931 行）与 `buddy-adapter.ts` 的请求侧（1391-1418 行）。
 *
 * ## ★ 最重要的一条：`supportedEfforts` **只在模型真正支持多等级时才下发**
 *
 * 参考实现注释原文：
 * > `supportedEfforts` 是**可枚举**的等级列表，只在模型真正支持多等级时下发；
 * > 只有单一默认 effort 的模型（glm-5.1/kimi-*）此处缺省，**不暴露等级选择器**。
 *
 * 实测（2026-10-20，workbuddy-intl，`/v3/config` 28 条模型）：
 *
 * | 形态 | 条数 | 样本 |
 * |---|---|---|
 * | 有 `reasoning.supportedEfforts` | **19** | `hy3: ["low","high"]`、`gpt-5.6-sol: ["low","medium","high","xhigh","max"]` |
 * | 只有单一 `reasoning.effort` | 9 | `deepseek-v4.1-flash: {"effort":"high","summary":"auto"}` |
 *
 * ⇒ **没有 `supportedEfforts` 的模型必须继续没有档位行。**
 * 给它编一组（哪怕「看起来合理」）就是**谎报能力** —— 用户选了、上游 400，
 * 而他无从知道是插件编的。核心层 `efforts.length > 0` 的判据正是为此设计。
 *
 * ## 请求侧：`reasoning_effort` 是真正的开关，且**只发声明过的值**
 *
 * 参考实现的三站点实测（2026-09，直连 workbuddy 国际/中国 UA、codebuddy）：
 *
 * | 请求体 | `reasoning_content` |
 * |---|---|
 * | 裸请求（无 effort、无 thinking） | **恒为 0**（不思考） |
 * | 仅 `reasoning_effort: high` | **返回思考**（148~250 字符） |
 * | 仅 `thinking: {type:'enabled'}` | 仍为 0（**该字段单独无效**） |
 * | 两者都带 | 返回思考 |
 *
 * ⇒ **`reasoning_effort` 才是开关**；`thinking` 单独不生效，保留它是为对齐官方
 * 客户端出站形态。三站点行为一致 ⇒ 与 endpoint / UA 无关。
 *
 * 另一个必须防的：`reasoning_effort` 若发**该模型没声明过的值**，服务端会
 * **400**（非法参数）。所以下发前必须对照该模型声明的集合校验。
 */

/** 一个模型的思考相关字段（全部来自 `/v3/config` 的 `data.models[].reasoning`）。 */
                                       
     
                  
    
                                                    
                                              
                           
     
                             
                                             
                        
     
                              
    
                                                     
                                                           
                                                 
    
                                                       
                                       
                             
     
                       
 

/**
 * 从 `data.models[]` 的一个条目解析思考字段。
 *
 * 口径与参考实现 `parseModelMeta()` 逐条对齐：
 *   - `supportedEfforts` **是数组**且**过滤后仍有元素**时才取；
 *   - `defaultEffort` / `effort` 只在**非空字符串**时取；
 *   - 其余一律**缺省即 undefined，不猜**。
 */
export function parseReasoningFields(model                                     )                       {
  if (model === undefined) return {}
  const raw = model.reasoning
  if (typeof raw !== 'object' || raw === null) return {}
  const fields = raw                           
  const out                       = {}

  if (Array.isArray(fields.supportedEfforts)) {
    // ⚠️ 元素必须是非空**字符串**：上游偶尔会混进 null / 空串，
    // 直接把它们喂给核心层会让选择器里出现一个空行。
    const efforts = fields.supportedEfforts.filter(
      (item)                 => typeof item === 'string' && item.length > 0,
    )
    // 过滤后为空 = 视同没有这个字段（不出档位行），而不是给一个空列表。
    if (efforts.length > 0) out.supportedEfforts = efforts
  }
  if (typeof fields.defaultEffort === 'string' && fields.defaultEffort.length > 0) {
    out.defaultEffort = fields.defaultEffort
  }
  if (typeof fields.effort === 'string' && fields.effort.length > 0) {
    out.singleEffort = fields.effort
  }
  return out
}

/**
 * 该模型是不是 DeepSeek 系（只有 DeepSeek 需要 `thinking` 开关与强制档位）。
 *
 * 与参考实现同款判据：**模型 id 前缀**（`/^deepseek/i`），不看 UA / endpoint。
 */
export function isDeepSeekModel(modelId        )          {
  return /^deepseek/i.test(modelId.trim())
}

/** 请求体里该怎么发思考相关字段。 */
                                         
                                                          
                 
                                              
                   
     
                          
    
                                                      
                                          
             
     
                
 

/** {@link decideReasoningEffort} 的输入。 */
                                      
                       
                    
     
                
    
                                  
                                                  
                                                
                                                           
                                          
     
                               
                  
                        
                                       
                       
                       
                     
 

/**
 * 决定请求体里发什么档位 / 要不要带 `thinking`。
 *
 * 判定顺序（对齐参考实现 `buddy-adapter.ts:1404-1418`）：
 *
 *   1. `requested` **且该模型确实支持它** → 发 `requested`；
 *   2. `requested` 不被支持 → **不发**（发出去是 400），落到第 3 步的兜底；
 *   3. DeepSeek 系需要**补一个**档位 —— 否则请求体里只剩 `thinking`，
 *      而上游按「不思考」应答（实测）。回退顺序：
 *      **上游默认档 → 上游单一档 → `high`（若在支持集内）→ 支持集首个**。
 *
 * ⚠️ 第 3 步**绝不臆造模型未声明的档位**：`high` 只在它确实在 `supported` 里时才用；
 * `singleEffort` 是**上游自己声明的值**（实测 DeepSeek 两条都是 `high`），
 * 不是我们猜的 —— 这是它排在 `high` 硬编码之前的原因。
 *
 * ⚠️ `thinking` **只对 DeepSeek 加**（参考实现同款）。glm / kimi 等走各自的
 * `thinkingFormat`（默认开或 `enable_thinking`），不需要这个开关。
 */
export function decideReasoningEffort(input                     )                         {
  const { requested, supported, defaultEffort, singleEffort, isDeepSeek } = input
  const thinking = isDeepSeek

  // ── 1/2：调用方显式请求的档位 ──
  if (typeof requested === 'string' && requested !== '') {
    if (supported === undefined) {
      // 能力未知：原样放行（与核心层的口径一致）。
      return { effort: requested, thinking, reason: '能力未知，原样放行调用方请求的档位' }
    }
    if (supported.includes(requested)) {
      return { effort: requested, thinking, reason: '模型声明支持该档位，按请求下发' }
    }
    // 不被支持：绝不发（上游会 400）。DeepSeek 继续走下面的兜底。
    if (!isDeepSeek) {
      return { thinking, reason: `模型未声明档位「${requested}」，不下发` }
    }
  }

  // ── 3：DeepSeek 必须有一个档位，否则等于「不思考」 ──
  if (isDeepSeek) {
    const usable = supported ?? []
    // 上游默认档：只在确实在支持集里时才用（远端数据可能自相矛盾）。
    if (defaultEffort !== undefined && (usable.length === 0 || usable.includes(defaultEffort))) {
      return { effort: defaultEffort, thinking, reason: 'DeepSeek 未选档位，用上游声明的默认档' }
    }
    // 上游单一档位（实测 DeepSeek 两条的 `reasoning.effort` 都是 high）。
    if (singleEffort !== undefined) {
      return { effort: singleEffort, thinking, reason: 'DeepSeek 未选档位，用上游声明的单一档位' }
    }
    if (usable.includes('high')) {
      return { effort: 'high', thinking, reason: 'DeepSeek 未选档位，回退到 high（官方客户端口径）' }
    }
    if (usable.length > 0) {
      return { effort: usable[0], thinking, reason: 'DeepSeek 未选档位，回退到最低支持档' }
    }
    // 什么信息都没有：仍带 thinking（对齐官方客户端出站形态），
    // 但**不编造档位** —— 编了就可能 400。
    return { thinking, reason: 'DeepSeek 但拿不到任何档位信息，只带 thinking、不发档位' }
  }

  return { thinking, reason: '非 DeepSeek 且无可下发的档位' }
}


//# sourceURL=src/vendor/buddy/buddy-reasoning.ts