/**
 * TRAE 远端模型目录解析。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae.ts`
 * 的「模型目录」一节。**这里每一条判据都是实测换来的**，注释保留了理由。
 *
 * 端点：`POST {agentHost}/api/ide/v1/batch_get_detail_param`
 * 响应：`{ function_configs: [{ function, config_info_list: [...] }, …] }`
 * —— **每个 function 各自一套模型目录**，不是一份扁平清单。
 */

import { TRAE_CHANNELS, TRAE_DEFAULT_MODEL } from './trae-product.js'
import { parseJsonObject, readBooleanField, readNumberField, readStringField } from './trae-identity.js'

/** 推理强度配置（`reasoning_effort_config`）。 */
                                      
                                                          
                       
                                         
                            
                                                         
                           
 

/** TRAE 远端模型条目。 */
                                  
                                                        
            
                                            
              
     
                                                            
    
                                                               
                                                        
                                        
     
                        
                                                                     
                          
     
                                                              
                               
    
                                                    
                                                   
    
                                             
                                                            
                       
     
                         
     
                                        
    
                                                
                                                                       
                                                 
     
                   
                                                           
                    
                                                    
                     
     
                                                               
    
                                                            
                                                           
    
                                                     
                                                                   
                   
     
                      
                                                       
                              
                                                
                            
     
                                                        
    
                                                               
                                                                  
                   
     
                
                                           
                                       
     
                                                      
    
                                   
    
                                              
                                                              
                                               
                                        
                        
    
                                                          
                                       
                                   
                                                   
                     
     
                      
     
                                                                   
    
                                                  
                                                                                    
     
                                  
                                                                 
                   
                                                                  
                           
                                                           
                              
 

/**
 * 读取 `context_window_tokens.dev`（缺失时回退 `max`）。
 *
 * ⚠️ 与 {@link readMaxContextWindowField} 分开：那个取 `max`（仅 Max 模式可用），
 * 本函数取 `dev`（默认可用）。**两者绝不能混用**。
 */
function readContextWindowField(entry                         )                     {
  const raw = entry.context_window_tokens ?? entry.ContextWindowTokens
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw                           
  const value = readNumberField(record, 'dev')
    ?? readNumberField(record, 'Dev')
    ?? readNumberField(record, 'max')
    ?? readNumberField(record, 'Max')
  return value !== undefined && value > 0 ? Math.trunc(value) : undefined
}

/** 读取 `context_window_tokens.max`（Max 模式专用窗口，通常 1000000）。 */
function readMaxContextWindowField(entry                         )                     {
  const raw = entry.context_window_tokens ?? entry.ContextWindowTokens
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw                           
  const value = readNumberField(record, 'max') ?? readNumberField(record, 'Max')
  return value !== undefined && value > 0 ? Math.trunc(value) : undefined
}

/**
 * 读取 `model_detail_list[].max_tokens`。
 *
 * 多条明细时优先取 `model_name` 以 `preferredSuffix` 结尾的那条（对齐上游的
 * `config_name__dev` / `config_name__max` 约定），否则取第一条。
 *
 * @param preferredSuffix 优先匹配的后缀，默认 `__dev`（常规模式）；传 `__max`
 *   即取 Max 模式那条明细的输出上限。
 */
function readDetailMaxTokens(entry                         , preferredSuffix = '__dev')                     {
  const raw = entry.model_detail_list ?? entry.ModelDetailList
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const details = raw.filter(
    (item)                                  => typeof item === 'object' && item !== null,
  )
  const preferred = details.find((item) => readStringField(item, 'model_name').endsWith(preferredSuffix))
  const chosen = preferred ?? details[0]
  if (chosen === undefined) return undefined
  const value = readNumberField(chosen, 'max_tokens') ?? readNumberField(chosen, 'MaxTokens')
  return value !== undefined && value > 0 ? Math.trunc(value) : undefined
}

/**
 * 读取 `reasoning_effort_config`。
 *
 * 真实形状：`{ default_level, options: ["light","high","extra_high"], support_thinking }`。
 * `options` 同时兼容**字符串数组**（实测形态）与**对象数组**（`{level,...}`，
 * 防御性兼容 —— 若上游改成双字段形态也不会解析成空）。
 *
 * 一个字段都没有时返回 `undefined`（而不是空配置）：调用方据此不声明
 * `reasoning`，避免给用户一个发了也没用的档位选择器。
 */
function readReasoningEffortConfig(entry                         )                                  {
  const raw = entry.reasoning_effort_config ?? entry.ReasoningEffortConfig
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw                           

  const options           = []
  const rawOptions = record.options ?? record.Options
  if (Array.isArray(rawOptions)) {
    for (const item of rawOptions) {
      if (typeof item === 'string' && item.trim().length > 0) {
        options.push(item.trim())
      } else if (typeof item === 'object' && item !== null) {
        // 对象形态兜底：优先 wire 值 openclawLevel，其次产品侧 level。
        const obj = item                           
        const wire = readStringField(obj, 'openclawLevel')
          || readStringField(obj, 'level')
          || readStringField(obj, 'Level')
        if (wire.trim().length > 0) options.push(wire.trim())
      }
    }
  }

  const defaultLevel = readStringField(record, 'default_level') || readStringField(record, 'DefaultLevel')
  const supportThinking = readBooleanField(record, 'support_thinking')
    ?? readBooleanField(record, 'SupportThinking')

  if (options.length === 0 && defaultLevel.length === 0 && supportThinking === undefined) return undefined
  return {
    options,
    ...(defaultLevel.length > 0 ? { defaultLevel } : {}),
    ...(supportThinking === undefined ? {} : { supportThinking }),
  }
}

/**
 * 解析 `display_contact_config` 里的**消耗倍率**。
 *
 * ## 为什么必须单独一个函数
 *
 * `display_contact_config` 是**一个 JSON 字符串**（不是对象）：
 * ```json
 * "{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.08}},\"multimodal\":{...}}"
 * ```
 * 直接读 `entry.display_contact_config.consumption_rate` 永远得到 undefined。
 *
 * ## 三条判据（缺一不可）
 *
 * 1. `consumption_rate.enable !== false` —— 上游显式关闭时**不显示**，而不是当成 0；
 * 2. `data.rate` 是**有限非负数**（实测形态是裸数字 `0.08`，不是字符串 `"x0.08"`）；
 * 3. ⚠️ **`rate: 0` 是合法值**（免费），不能用 `> 0` 过滤 —— 这是
 *    「恰好漏掉用户最关心的免费模型」的经典坑。
 *
 * 解析失败一律返回 undefined（**不编造倍率**：宁可只显示模型名）。
 */
export function readConsumptionRate(entry                         )                     {
  const raw = entry.display_contact_config ?? entry.DisplayContactConfig
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const config = parseJsonObject(raw)
  if (config === undefined) return undefined
  const rate = config.consumption_rate ?? config.ConsumptionRate
  if (typeof rate !== 'object' || rate === null) return undefined
  const rateRecord = rate                           
  if (readBooleanField(rateRecord, 'enable') === false) return undefined
  const data = rateRecord.data ?? rateRecord.Data
  if (typeof data !== 'object' || data === null) return undefined
  const value = readNumberField(data                           , 'rate')
  return value !== undefined && value >= 0 ? value : undefined
}

/**
 * 解析 `activity_discount` —— 只在**当前确实生效**时返回原价与截止时间。
 *
 * ## 为什么不能只看 `enable: true`
 *
 * 实测陷阱：`enable` 为 `true` 但**当前并没有折扣**。`off_peak` 型条目形如
 * `{type:"none", before:0.13, after:0.13, discount:100}` —— `discount: 100`
 * 表示「无折扣」（百分比制），`before === after`。若照显会显示
 * `x0.13→x0.13`，让用户以为有活动。处理方式必须与 Qoder 的
 * `promotion.active === false` 一致：**不展示**。
 *
 * 三条判据：
 * 1. `activity_discount.enable !== false`；
 * 2. `data.current` 存在，且 `discount_type` **不是 `"none"`**；
 * 3. `before_consumption_rate` 是有限正数，且**严格大于** `after`（真正的降价）。
 *
 * `end_at`（Unix 秒）仅 `limited` 型带；**已过期**时整个折扣视为不存在 ——
 * 否则用户会按折扣价预期、实际被按原价计费。
 */
export function readActivityDiscount(
  entry                         ,
  nowSec         = Math.floor(Date.now() / 1000),
)                                                           {
  const raw = entry.display_contact_config ?? entry.DisplayContactConfig
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const config = parseJsonObject(raw)
  if (config === undefined) return undefined
  const discount = config.activity_discount ?? config.ActivityDiscount
  if (typeof discount !== 'object' || discount === null) return undefined
  const discountRecord = discount                           
  if (readBooleanField(discountRecord, 'enable') === false) return undefined
  const data = discountRecord.data ?? discountRecord.Data
  if (typeof data !== 'object' || data === null) return undefined
  const dataRecord = data                           
  const current = dataRecord.current ?? dataRecord.Current
  if (typeof current !== 'object' || current === null) return undefined
  const currentRecord = current                           
  // `discount_type: "none"` = 当前无活动（实测 off_peak 型即为此）。
  const type = (readStringField(currentRecord, 'discount_type')
    || readStringField(currentRecord, 'discountType')).trim().toLowerCase()
  if (type.length === 0 || type === 'none') return undefined
  const before = readNumberField(currentRecord, 'before_consumption_rate')
    ?? readNumberField(currentRecord, 'beforeConsumptionRate')
  const after = readNumberField(currentRecord, 'consumption_rate')
    ?? readNumberField(currentRecord, 'consumptionRate')
  // 必须是真的降价：before 有值、为正、且严格大于 after。
  if (before === undefined || before <= 0) return undefined
  if (after !== undefined && before <= after) return undefined
  // 截止时间：取 data 下任意带 end_at 的子对象（limited / 未来的新活动类型）。
  let endsAtSec                    
  for (const value of Object.values(dataRecord)) {
    if (typeof value !== 'object' || value === null) continue
    const end = readNumberField(value                           , 'end_at')
      ?? readNumberField(value                           , 'endAt')
    if (end !== undefined && end > 0) { endsAtSec = end; break }
  }
  // 已过期的活动不再是「当前生效」。
  if (endsAtSec !== undefined && endsAtSec <= nowSec) return undefined
  return endsAtSec === undefined ? { originalRate: before } : { originalRate: before, endsAtSec }
}

/** 解析单条 `config_info_list` 条目（两个端点的条目形状一致）。 */
function parseTraeConfigEntry(
  entry                         ,
  channel                    ,
  nowSec        ,
)                              {
  const id = readStringField(entry, 'config_name') || readStringField(entry, 'ConfigName')
  if (id.length === 0) return undefined
  const display = entry.display_config ?? entry.DisplayConfig
  const displayRecord = typeof display === 'object' && display !== null
    ? (display                           )
    : undefined
  const name = displayRecord !== undefined
    ? readStringField(displayRecord, 'display_name') || id
    : id
  // 所有标志「上游没说」都保持 undefined（不填 false）：过滤方只挡明确命中者。
  const isCustomModel = displayRecord === undefined
    ? undefined
    : readBooleanField(displayRecord, 'is_custom_model')
      ?? readBooleanField(displayRecord, 'IsCustomModel')
  const isHidden = readBooleanField(entry, 'is_invisible_to_user')
    ?? readBooleanField(entry, 'IsInvisibleToUser')
  const isEnabled = readBooleanField(entry, 'config_switch')
    ?? readBooleanField(entry, 'ConfigSwitch')
  const usage = readStringField(entry, 'usage') || readStringField(entry, 'Usage')
  const contextWindow = readContextWindowField(entry)
  const maxOutputTokens = readDetailMaxTokens(entry)
  // Max 模式三件套：开关 / 1M 窗口 / Max 那条明细的输出上限。
  const maxMode = displayRecord === undefined
    ? undefined
    : readBooleanField(displayRecord, 'max_mode') ?? readBooleanField(displayRecord, 'MaxMode')
  const maxContextWindow = readMaxContextWindowField(entry)
  const maxModeOutputTokens = readDetailMaxTokens(entry, '__max')
  // 图片能力（逐模型，见 `TraeRemoteModel.multimodal` 的说明）。
  // `multimodal` 与 `tool_response_multimodal` 是**两个独立字段**，不可合并。
  const multimodal = displayRecord === undefined
    ? undefined
    : readBooleanField(displayRecord, 'multimodal') ?? readBooleanField(displayRecord, 'Multimodal')
  const toolResponseMultimodal = displayRecord === undefined
    ? undefined
    : readBooleanField(displayRecord, 'tool_response_multimodal')
      ?? readBooleanField(displayRecord, 'ToolResponseMultimodal')
  const reasoningConfig = readReasoningEffortConfig(entry)
  // 计费：`display_contact_config` 里的倍率与活动折扣（两次 JSON.parse）。
  const creditsRate = readConsumptionRate(entry)
  const discount = readActivityDiscount(entry, nowSec)
  return {
    id,
    name,
    ...(channel === undefined ? {} : { function: channel }),
    ...(isCustomModel === undefined ? {} : { isCustomModel }),
    ...(isHidden === undefined ? {} : { isHidden }),
    ...(isEnabled === undefined ? {} : { isEnabled }),
    ...(usage.length > 0 ? { usage } : {}),
    ...(reasoningConfig === undefined ? {} : { reasoningConfig }),
    ...(maxMode === undefined ? {} : { maxMode }),
    ...(multimodal === undefined ? {} : { multimodal }),
    ...(toolResponseMultimodal === undefined ? {} : { toolResponseMultimodal }),
    ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
    ...(maxModeOutputTokens === undefined ? {} : { maxModeOutputTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(creditsRate === undefined ? {} : { creditsRate }),
    ...(discount === undefined ? {} : { originalCreditsRate: discount.originalRate }),
    ...(discount?.endsAtSec === undefined ? {} : { discountEndsAtSec: discount.endsAtSec }),
  }
}

/**
 * 该条目**能否真正声明出思考档位**。
 *
 * 判据必须与适配器的 `reasoningFor` 完全一致（配置存在 + 未显式
 * `support_thinking: false` + `options` 非空）。⚠️ 只判「配置存在」是不够的：
 * `{support_thinking: false, options: []}` 与 `{support_thinking: false,
 * options: ['high']}` 都「存在配置」，但前者在适配器里仍会返回 `undefined`
 * （UI 依旧显示「未提供推理等级」）——若按「存在即优先」合并，就会选中这种
 * 条目、等于没修。
 */
export function declaresReasoningOptions(model                 )          {
  const config = model.reasoningConfig
  if (config === undefined) return false
  if (config.supportThinking === false) return false
  return config.options.length > 0
}

/**
 * 解析 `batch_get_detail_param`（**多通道**）响应。
 *
 * ## 合并规则（**修正后**，参考实现 issue IKI7WT/IKILR7「模型缺少思考强度」）
 *
 * 同一个 `config_name` 出现在多个 function 中时，按下列优先级取**一条**条目：
 *
 * 1. **空档位不得覆盖有档位**：候选与已选条目各自「能否声明出思考档位」由
 *    {@link declaresReasoningOptions} 判定。已选条目有档位而候选没有时**保留已选条目**。
 * 2. **两侧都声明档位时按 `channelPriority` 取更靠前者**（「顺序即优先级」）。
 * 3. **其余情形保持既有「后覆盖前」语义**（含两侧都无档位），以免造成与本缺陷
 *    无关的通道迁移。
 *
 * ⚠️ 原实现是**无条件「后面的覆盖前面的」**，其注释假设「后面的条目带着更完整的
 * 配置」——**该假设与真实数据相反**：上游把空档位的 `solo_work_lite` /
 * `solo_design_remote` 等条目排在**最后**，于是信息更全的条目被覆盖成更空的条目。
 * 实测 13 个模型因此丢掉 `reasoning_effort_config`。
 *
 * ⚠️ **档位必须与 `function` 同源**：发档位的通道必须正是声明支持它的通道，
 * 否则上游按 `support_thinking:false` 处理（甚至回流内 4001）。故这里整条择优，
 * 而不是把 `reasoningConfig` 单独搬运到另一条条目上。
 *
 * ## 四条硬性过滤（合并时执行）
 *
 * - **`function` 不在 `channelPriority`（可调用通道白名单）内**的整组跳过
 * - `usage` 非 `chat_completion` 的排除
 * - `config_switch === false`（上游已停用）排除
 * - `is_invisible_to_user === true`（官方隐藏）排除
 *
 * ⚠️ **第一条是参考实现 Issue IKJOZ7 的修复点**：`channelPriority` 此前**只用于
 * 排序**，不参与准入 —— 于是「目录声明了什么通道，就照着发什么通道」，
 * 而 22 个 function 里有一半在本插件的推理端点下不可调用。用户选中那些模型必然
 * 失败，且错误文案指向**模型**、极易被误判成「这个模型坏了」。
 * 现在它**同时是白名单**：不在表内的通道**整个丢弃**（连同其独有模型）。
 *
 * @param channelPriority **可调用通道白名单**，下标越小优先级越高。同时承担
 *   两个职责：不在表内的通道被丢弃；同一模型被多个表内通道列出时取更靠前者。
 *   覆盖它会改变**准入集合**，不只是顺序。
 */
export function parseTraeBatchModelList(
  body         ,
  channelPriority                    = TRAE_CHANNELS,
  nowSec         = Math.floor(Date.now() / 1000),
)                    {
  if (typeof body !== 'object' || body === null) return []
  const record = body                           
  const groups = record.function_configs ?? record.FunctionConfigs
  if (!Array.isArray(groups)) return []

  /** 通道优先级下标（同样即白名单成员资格；非成员返回 -1 由调用处丢弃）。 */
  const rankOf = (channel        )         => channelPriority.indexOf(channel)

  const byId = new Map                         ()
  /** 已选条目所在通道的优先级（仅用于规则 2 的择优）。 */
  const chosenRank = new Map                ()
  for (const group of groups) {
    if (typeof group !== 'object' || group === null) continue
    const g = group                           
    const channel = readStringField(g, 'function') || readStringField(g, 'Function')
    // ⚠️ 白名单准入（Issue IKJOZ7）：未声明的通道、以及**不在白名单内的通道**
    // 整组跳过 —— 后者的模型发出去必然被上游拒。
    // 未声明 `function` 的组同样跳过：无通道可用时无法构造合法请求，
    // 让它进目录只会变成一个「能选中但发不出去」的条目。
    if (channel.length === 0 || rankOf(channel) < 0) continue
    const list = g.config_info_list ?? g.ConfigInfoList
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const model = parseTraeConfigEntry(item                           , channel, nowSec)
      if (model === undefined) continue
      // ⚠️ 硬性过滤：三条独立条件，缺一不可，不设外部开关。只在此处（batch 端点
      // 解析时）执行，单通道的 `get_detail_param` 已按场景筛选过，不需要。
      //
      // 1. usage 必须是 `chat_completion`：batch 端点是全功能配置表，包含
      //    summary / fast_apply / custom_model / multimodal 等非对话用途条目；
      // 2. config_switch 必须开启：上游已停用；
      // 3. is_invisible_to_user 不得为 true：内部子代理、标题生成等不应出现在
      //    对话面板中。
      if (model.usage !== undefined && model.usage !== 'chat_completion') continue
      if (model.isEnabled === false) continue
      if (model.isHidden === true) continue
      const incumbent = byId.get(model.id)
      if (incumbent === undefined) {
        byId.set(model.id, model)
        chosenRank.set(model.id, rankOf(channel))
        continue
      }
      // ⚠️ 规则 1 与 2，详见函数注释。
      const incumbentHasEffort = declaresReasoningOptions(incumbent)
      const candidateHasEffort = declaresReasoningOptions(model)
      // 规则 1：空档位不得覆盖有档位。
      if (incumbentHasEffort && !candidateHasEffort) continue
      // 规则 2：两侧都有档位时按通道优先级取更靠前者（档位与 function 同源）。
      if (incumbentHasEffort && candidateHasEffort) {
        if (rankOf(channel) >= (chosenRank.get(model.id) ?? 0)) continue
      }
      // 规则 3：其余情形沿用既有的「后覆盖前」。
      byId.set(model.id, model)
      chosenRank.set(model.id, rankOf(channel))
    }
  }
  return [...byId.values()]
}

/**
 * 解析 `get_detail_param`（单通道）响应。
 *
 * 上游形状：`{ config_info_list: [{ config_name, display_config: {...}, model_detail_list: [...] }] }`
 *
 * ⚠️ 本插件主路径用 batch 端点（见 {@link parseTraeBatchModelList}）。
 * 保留这个解析器是为了兜底：若 batch 端点整体失败，可退回单通道端点取一份
 * 不带通道信息的目录（此时所有模型回退默认通道）。
 */
export function parseTraeModelList(
  body         ,
  nowSec         = Math.floor(Date.now() / 1000),
)                    {
  if (typeof body !== 'object' || body === null) return []
  const record = body                           
  const list = record.config_info_list ?? record.ConfigInfoList ?? record.data
  if (!Array.isArray(list)) return []

  const models                    = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const model = parseTraeConfigEntry(item                           , undefined, nowSec)
    if (model !== undefined) models.push(model)
  }
  return models
}

/**
 * 该条目是否**可调用**（本插件的硬性过滤）。
 *
 * 两个标志各自独立、都必须放行：
 * - `isCustomModel`：需用户在 IDE 内自行配置 → 本插件必然调不通（流内 `4001`）
 * - `isEnabled === false`：上游已停用
 *
 * 未声明（`undefined`）一律**放行**：宁可多留一个模型，也不要因缺字段误删整批。
 *
 * ⚠️ **`isHidden` 不在这里判定** —— 它表示「官方客户端的选择器不展示」，
 * 与「能不能调用」是**两个独立维度**。实测 `glm-5.1` 就是「可调用但被官方隐藏」。
 * 把它并进可用性判定会连带删掉一批**能用的**模型。
 */
export function isTraeModelCallable(model                 )          {
  return model.isCustomModel !== true && model.isEnabled !== false
}

/**
 * 模型 id → `config_name` 的归一化匹配键。
 *
 * 归一化三步（对齐参考实现注释里描述的 Go 端 `handler.go:mapModel`）：
 * 1. **去掉 `__` 后缀** —— `custom_model_1M__dev` / `…__max` 是上游给
 *    `model_detail_list` 用的明细后缀，不是模型 id 的一部分；
 * 2. **下划线 → 横线** —— 目录里两种写法混用（`DeepSeek-V4-Pro` vs
 *    `deepseek_v4_pro`）；
 * 3. **转小写** —— 大小写不敏感匹配。
 *
 * 归一化后仍不匹配时调用方回退原值（见 `resolveTraeConfigName`），
 * **绝不编造一个目录里没有的名字**。
 */
export function normalizeTraeModelKey(model        )         {
  const withoutSuffix = model.includes('__') ? (model.split('__')[0] ?? model) : model
  return withoutSuffix.trim().replace(/_/g, '-').toLowerCase()
}

/**
 * 把请求里的 model 解析成上游要的 `config_name` 与通道。
 *
 * ## 为什么不能直接把 model 透传
 *
 * 上游真正认的字段是 `config_name`，且**大小写 / 分隔符都不保证与目录一致**；
 * 客户端（DSH）传来的 model 还可能带 `__dev` 之类的明细后缀。
 * 参考实现记录了 Go 端 `mapModel` 的三步归一化（见 {@link normalizeTraeModelKey}）。
 *
 * ## 匹配策略（逐级退化，每级都可解释）
 *
 * 1. **精确命中**目录里的 id → 用它（最常见，目录里的 id 就是 config_name）；
 * 2. **归一化命中** → 用目录里那条的**原始 id**（把 `deepseek_v4_pro` 映射回
 *    `DeepSeek-V4-Pro`），而不是用归一化后的串；
 * 3. 都没命中 → 回退**去掉 `__` 后缀的原值**；原值为空则回退
 *    {@link TRAE_DEFAULT_MODEL}。
 *
 * 第 3 步刻意不报错：目录可能只是没拉到（网络问题），而请求本身也许仍然可用
 * —— 让上游的 `4001` / `4023` 给出真结论，比插件自己先拒一次更有信息量。
 *
 * @param model 客户端传来的 model（可能带 `__dev` 后缀、大小写不同）
 * @param catalog 远端目录（可能为空 = 还没拉到）
 * @param fallbackChannel 目录里查不到时用的默认通道
 */
export function resolveTraeModelTarget(
  model        ,
  catalog                            ,
  fallbackChannel        ,
)                                          {
  const exact = catalog.find((item) => item.id === model)
  if (exact !== undefined) {
    return {
      configName: exact.id,
      channel: exact.function !== undefined && exact.function.length > 0 ? exact.function : fallbackChannel,
    }
  }
  const key = normalizeTraeModelKey(model)
  const normalized = catalog.find((item) => normalizeTraeModelKey(item.id) === key)
  if (normalized !== undefined) {
    return {
      // ⚠️ 用**目录里的原始 id**，不是归一化后的串：上游只认它自己下发的名字。
      configName: normalized.id,
      channel: normalized.function !== undefined && normalized.function.length > 0
        ? normalized.function
        : fallbackChannel,
    }
  }
  const stripped = model.includes('__') ? (model.split('__')[0] ?? model) : model
  return {
    configName: stripped.length > 0 ? stripped : TRAE_DEFAULT_MODEL,
    channel: fallbackChannel,
  }
}

/**
 * 模型的展示名：带倍率后缀（对齐参考实现 `traeDisplayName`）。
 *
 * ⚠️ `0` 是**合法**倍率（免费），必须与「没有倍率」区分开 ——
 * 用 `if (!rate)` 会把免费模型显示成「无倍率」。
 */
export function traeDisplayName(model                 )         {
  const rate = model.creditsRate
  if (rate === undefined) return model.name
  const current = rate === 0 ? '免费' : `x${rate}`
  const original = model.originalCreditsRate
  if (original !== undefined && original > rate) {
    return `${model.name} · x${original}→${current}`
  }
  return `${model.name} · ${current}`
}


//# sourceURL=src/vendor/trae/trae-catalog.ts