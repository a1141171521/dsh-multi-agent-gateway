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
                       
          
          
                
           
            
             
                 
               
                 
             

/** 该错误是否值得**换一个账号**再试一次。 */
export function shouldSwitchAccount(kind           )          {
  return kind === 'auth' || kind === 'rate_limit' || kind === 'quota'
}

/** 该错误是否值得**换账号重试之外**的直接重试（同号/同网关层）。 */
export function isRetryable(kind           )          {
  return kind === 'rate_limit' || kind === 'server' || kind === 'network' || kind === 'unknown'
}

/** 一次失败的完整描述（日志 / UI / 路由都用它）。 */
                              
                 
                 
                       
                 
                              
                       
                      
                    
            
 

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
                                     
                                                                           
                
                                       
                       
                                   
                    
                            
                  
                                        
                
                                                       
                 
               
                                  
                 
                        
 

/** 一个被管理的账号。落盘时 `credentials` 整体加密。 */
                                
                                              
            
                 
                
               
                                                 
                                 
                           
                  
                   
                   
                                             
                       
                                               
                     
                                               
                     
               
 

/** 账号健康状态：路由的输入之一。 */
                                
                   
                                                  
                                      
                       
                  
                             
                      
                             
                
                         
                   
                        
 

// ───────────────────────────── 额度 ─────────────────────────────

                                                                  

/** 一次额度快照。`remaining === undefined` 就代表「未知」。 */
                                
                   
                 
                    
                
               
                     
                              
                                 
                   
                             
                
 

// ───────────────────────────── 模型元数据 ─────────────────────────────

/**
 * 一个模型 + 它的归属分组 + 积分倍率。
 *
 * ⚠️ 这是「模型列表管理」的**唯一契约**：适配器的 `getModelMetaList()` 返回它，
 * 核心层把它渲染成 DSH 模型选择器里的分组与行标签。
 */
                            
                                      
            
                 
              
                       
                 
                             
                   
     
                                                
              
     
                     
                                                           
                           
                      
                        
                    
                                        
                                               
                     
     
                                       
    
                       
    
                                            
    
                     
                
                                                 
                                                             
                                 
    
                                      
                                                               
                                                           
                   
    
                                     
                                                                      
                                                      
                            
    
                                      
     
                             
     
                                                                 
    
                         
    
                                           
                                                                      
                                           
                                   
                                         
                                    
    
                                                            
                         
     
                                 
                       
                
                    
 

/** 倍率的格式化：`×2` / `×1.5` / `免费` / `未知倍率`。 */
export function formatMultiplier(multiplier                    , free          )         {
  if (free === true || multiplier === 0) return '免费'
  if (multiplier === undefined || multiplier === null || !Number.isFinite(multiplier)) return '未知倍率'
  const rounded = Math.round(multiplier * 100) / 100
  return `×${rounded}`
}

// ───────────────────────────── 活动任务 ─────────────────────────────

/** 任务类型：基础每日签到与活动任务是**两个独立模块**。 */
                                                       

/** 一个可参与的任务。 */
                             
                 
            
               
                      
                
                    
                 
                                        
                                  
                   
               
 

/** 任务执行 / 查询的结论。 */
                             
                
             
                          
                  
                  
                  
                     
              
               
            
 

/**
 * 签到结论。`supported: false` 是**一等公民**：上游没有签到接口时要如实说，不报故障。
 */
                                
             
                    
                  
                  
                  
     
                                      
    
                                             
    
                                                  
                                          
               
    
                                                     
                                                  
                                                
                                                    
    
                 
    
                                              
                          
    
                                          
                                                                
                                 
    
                                     
     
                       
     
                                                 
    
                     
                                                  
                                               
                               
    
                                                      
                                                         
                
     
                          
            
 

// ───────────────────────────── 对话 ─────────────────────────────

/** OpenAI 兼容的 message（本插件对外/对内都用这一套）。 */
                              
                                                              
                                                          
               
                       
                        
                             
                            
                        
 

/** 一次 completion 请求（OpenAI 兼容子集 + 常见扩展）。 */
                              
               
                         
                  
                      
                
                     
                          
                   
                       
                                     
                              
                        
 

/** 归一化后的流事件：网关层只认这几种。 */
                         
                                  
                                       
                                                                                             
                                        
                                      
                                           

                             
                     
                      
                      
                          
                          
                           
 

/** 非流式响应（网关内部归一化用，DSH 侧一律走流式）。 */
                               
             
               
              
                    
                       
                    
                       
 

// ───────────────────────────── 适配器能力 ─────────────────────────────

/**
 * 适配器自报能力。核心调度器**只按这个表决定挂不挂定时任务**，
 * 避免对着一个没有签到接口的上游每 5 分钟打一次。
 */
                                    
                
                  
                   
                
                     
                 
                              
                
                         
               
                 
                    
     
                                    
    
                                                    
                                                                 
                                         
    
                                        
                                        
                                                  
    
                                                              
                                            
                                                         
                                                      
    
                                                   
                                                
     
                       
                                                            
                                       
                                    
                                
 

// ───────────────────────────── 适配器接口 ─────────────────────────────

/** 适配器运行期依赖（由核心层注入，适配器不自己去 ctx.get）。 */
                                 
                            
                             
                 
             
                            
              
                           
                     
                      
               
     
                                
    
                                                      
                                                        
    
                               
     
                                                                             
     
                          
    
                                                          
                                                  
           
     
                                                           
 

/** 简易 KV 缓存接口（适配器用来缓存模型列表、倍率等）。 */
                               
                                    
                                                     
                           
                  
 

/** 带错误分类的 HTTP 调用。 */
                             
             
                
                 
                  
               
                       
              
                    
                       
                  
 

                      
              
                  
                        

                           
                 
                                  
               
                                             
                    
                                          
               
                      
 

/** 日志器（核心层实现，转 DSH 日志 + 环形缓冲给 UI）。 */
                         
                                                  
                                                 
                                                 
                                                  
                      
                              
 

/**
 * **统一 Agent 适配器接口**。
 *
 * 本期只有 OpenCode 是完整实现；Qoder / Qoder CN / Trae / WorkBuddy / WorkBuddy
 * International 是骨架（每个方法都实现了，但默认返回「不支持」，语义明确、
 * 不静默失败）。新增 Agent 时**不需要改核心调度代码**。
 */
                               
                     
                       
                          
                                          

             
                                        
                                                                                         
                               
                      
                          
                        
                                                                 

                 
                                               
                                                                             
                     
                                                                              
                      
                                                                                    

               
                        
                                                                                        
                     
                                                                                                
                       
                                                                                                  

             
                             
                    
                         
                          
                        
                        
                               

                                
                                                                         
 

// ───────────────────────────── 配置（解析后） ─────────────────────────────

                                      
                     
                   
                      
 

                                         
                  
                                                   
              
                                  
                         
 

                                      
                  
                         
                     
                     
                       
                          
                   
 

/**
 * 「模型选择器里暴露哪些模型」的策略。
 *
 * `free` 是默认值，因为它就是**免费层的用法**：不加这个过滤，选择器会被
 * 上游几十上百个模型塞满（实测 OpenCode 有 85 个），用户根本找不到免费的那几个。
 */
                              
                                   
                                                          
                    
 

/**
 * 按策略过滤模型列表（纯函数，可单测）。
 *
 * `free` 只留 `meta.free === true`；`selected` 严格按 id 匹配；
 * `all` 原样返回。列表为空时也如实返回空 —— 让选择器真的空着，
 * 而不是偷偷放开（静默放开比空列表更难排查）。
 */
export function selectExposedModels(list                      , policy             )              {
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
  list                      ,
  policy                                                        ,
)              {
  const hasDefault = Number.isFinite(policy.default) && policy.default > 0
  const overrideIds = Object.keys(policy.overrides ?? {})
  if (!hasDefault && overrideIds.length === 0) return [...list]
  return list.map((meta) => {
    const override = policy.overrides?.[meta.id]
    const window = typeof override === 'number' && override > 0 ? override : hasDefault ? policy.default : undefined
    return window === undefined ? meta : { ...meta, contextWindow: window }
  })
}

                                      
            
              
                  
     
                       
    
                                               
                                       
                                    
     
                  
                                     
                       
                                                                         
                         
                           
                     
     
                
    
                                          
                                  
     
                                                                       
                      
                                 
                        
                               
                      
                            
              
             
                                                                            
                       
                                 
                      
                         
                     
                                            
                       
                                                                         
                            
       
                    
                                      
                                             
                           
       
                                              
                                 
                        
                      
                      
                          
                           
   
                   
            
                   
                                             
                              
                  
                 
   
                          
                            
                             
                            
 

                                        
                                        
                 
                              
                 
                    
                     
                            
                     
                            
                               
 

/** 解析后的整插件配置（`config.ts` 的 `resolveConfig()` 产物）。 */
                                 
                  
                 
                  
                                
                                             
 


//# sourceURL=src/core/types.ts