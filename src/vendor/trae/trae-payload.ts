/**
 * OpenAI 请求体 → TRAE **SOLO** 请求体的转换。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae.ts`
 * 「OpenAI → SOLO 载荷转换」一节。
 *
 * ## 为什么必须转换而不能透传
 *
 * OpenAI 的 `{model, messages, tools, tool_choice, stream}` 发过去上游不认：
 * 上游要的是 `function` / `config_name` 这些 SOLO 字段，且若干字段的**类型约定
 * 与 OpenAI 相反**（最典型的是 `tools[].function.parameters` 要**字符串**）。
 * 参考实现逐条对齐了 Go 端 `payload.go:PrepareBody` 的改写规则。
 *
 * 全部改写规则：
 * 1. `messages[].content` 字符串 → `[{type:"text",text:...}]`；已经是数组 → 透传
 * 2. `stream` 强制 `true`（非流式由服务端聚合）
 * 3. `model` → `config_name` + `model`（**双字段**）
 * 4. `function` 取所选通道，缺省 `solo_work_lite`
 * 5. `tools` / `tool_choice` 归一化（`"none"` 删 tools；`auto`/`required` 保留；
 *    `function` 提取 name）
 * 6. assistant 消息中的 `tool_calls`：`function` → **`function_call`**（SOLO 字段名）
 * 7. `tools[].function.parameters`：object → **JSON 字符串**（SOLO 要求）
 */

import { TRAE_DEFAULT_MODEL, TRAE_FUNCTION, TRAE_DEFAULT_MAX_COMPLETION_TOKENS, TRAE_MAX_CONTEXT_TOKENS, TRAE_MAX_OUTPUT_TOKENS, TRAE_MAX_PROMPT_TOKENS, TRAE_MAX_MODE_TYPE } from './trae-product.js'
import { readNumberField } from './trae-identity.js'

/** Max 模式的 `mode_type` 取值。 */
export const TRAE_MAX_MODE_TYPE_VALUE = TRAE_MAX_MODE_TYPE

/**
 * 构造把远程会话钉到 **Max 模式**（1M 上下文）的 wire 字段。
 *
 * ## 实测要点
 *
 * - ⚠️ **不能只调大 `max_tokens`**：上游按 `strategy=max` +
 *   `model_auto_selection.strategy=max` 判定「这是一个 Max 会话」，缺了它们
 *   只会被当成普通会话、按 200K 校验，然后拒绝 1M 的输入。
 * - `context_window_size` / `prompt_max_tokens` / `max_tokens` 三者要**成套**
 *   下发，远端按它们做准入校验（只发其中一个等于没发）。
 * - 只有远端明确标了 `display_config.max_mode === true` 的模型才能用；
 *   给未标记的模型硬套 Max 参数会被上游拒绝。**绝不为账号未标记的模型
 *   编造 Max 上限。**
 *
 * @param maxContext 该模型声明的 Max 窗口（远端 `context_window_tokens.max`）
 * @param outputMax Max 模式下的输出上限
 */
export function traeMaxModeFields(maxContext: number, outputMax?: number): Record<string, unknown> {
  const context = maxContext > 0 ? maxContext : TRAE_MAX_CONTEXT_TOKENS
  return {
    model_auto_selection: {
      strategy: 'max',
      fallback_to_advance_model: null,
      entitlement_id: null,
    },
    model_selection_strategy: 'max',
    mode_type: TRAE_MAX_MODE_TYPE,
    context_window_size: context,
    prompt_max_tokens: TRAE_MAX_PROMPT_TOKENS,
    max_tokens: outputMax !== undefined && outputMax > 0 ? outputMax : TRAE_MAX_OUTPUT_TOKENS,
  }
}

/**
 * 把请求的输出额度收敛到安全上限。
 *
 * 只收敛**正整数**；`undefined` / 非法值原样返回（**不编造数值**）。
 *
 * @param value 客户端要的 max_tokens
 * @param limit 上限；`<= 0` 表示不收敛
 */
export function clampTraeMaxTokens(
  value: number | undefined,
  limit: number = TRAE_DEFAULT_MAX_COMPLETION_TOKENS,
): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return value
  if (limit <= 0) return value
  return Math.min(value, limit)
}

/**
 * 将 OpenAI 格式的请求体转换为 SOLO 格式。
 *
 * @param openaiBody 原始 OpenAI 请求体
 * @param configName `config_name`（由 `resolveTraeModelTarget` 解析得到）
 * @param channel 聊天通道（`function`）。**同一模型只在列出它的通道里可调用**，
 *   故必须传入该模型所属通道；缺省回退 {@link TRAE_FUNCTION}。
 * @param maxModeFields 可选：Max 模式的成套字段（见 {@link traeMaxModeFields}）
 * @returns 转换后的 SOLO 请求体
 */
export function transformToSOLOBody(
  openaiBody: Record<string, unknown>,
  configName: string,
  channel?: string,
  maxModeFields?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...openaiBody,
    // ⚠️ **强制 true**：本适配器只对接流式路径（DSH 侧一律走流式）。
    // 透传客户端的 `false` 会让上游返回一次性 JSON，而我们的消费端按 SSE 解析。
    stream: true,
    function: channel !== undefined && channel.length > 0 ? channel : TRAE_FUNCTION,
  }

  // ── messages 转换 ──
  const msgs = body.messages
  if (Array.isArray(msgs)) {
    body.messages = msgs.map((msg) => transformSOLOMessage(msg as Record<string, unknown>))
  }

  // ── model → config_name + model（双字段）──
  const model = typeof body.model === 'string' ? body.model : ''
  // 支持 `__dev` 后缀消除（`custom_model_1M__dev` → `custom_model_1M`）。
  const baseModel = model.includes('__') ? (model.split('__')[0] ?? model) : model
  const resolved = configName.length > 0 ? configName : (baseModel.length > 0 ? baseModel : TRAE_DEFAULT_MODEL)
  body.config_name = resolved
  body.model = resolved

  // ── tool_choice 归一化 ──
  normalizeToolChoice(body)

  // ── tools.parameters 序列化 ──
  normalizeTools(body)

  // ── Max 模式字段（最后合并，避免被上面的改写覆盖）──
  if (maxModeFields !== undefined) {
    for (const [key, value] of Object.entries(maxModeFields)) body[key] = value
  }

  return body
}

/**
 * 转换单条消息（递归处理消息内容）。
 *
 * ⚠️ **`function` → `function_call`**：SOLO 用 `function_call`，OpenAI 用
 * `function`。发错字段名上游看不到工具定义（表现为「模型不调工具」，
 * 而不是报错 —— 这类静默失败最难查）。
 */
function transformSOLOMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...msg }

  // assistant 消息的 tool_calls: function → function_call
  if (result.role === 'assistant') {
    const tcs = result.tool_calls
    if (Array.isArray(tcs)) {
      const kept: unknown[] = []
      for (const tc of tcs) {
        if (typeof tc !== 'object' || tc === null) continue
        const t = { ...(tc as Record<string, unknown>) }
        // 把 function → function_call
        if (typeof t.function === 'object' && t.function !== null) {
          t.function_call = t.function
          delete t.function
        }
        // 无 function_call.name 的 tool_call 剔除：留着会让上游看到一个无名工具调用。
        const fc = t.function_call as Record<string, unknown> | undefined
        if (fc === undefined || typeof fc.name !== 'string' || fc.name.trim().length === 0) continue
        kept.push(t)
      }
      if (kept.length > 0) {
        result.tool_calls = kept
      } else {
        delete result.tool_calls
      }
    }
  }

  // content 转换：字符串 → [{type:"text",text:...}]
  const content = result.content
  if (content === null || content === undefined) {
    // 无 content 的消息（如纯 tool_calls 的 assistant）保持原样。
    // ⚠️ 不要补一个空数组：上游对「content: []」的处理与「无 content」不同。
  } else if (typeof content === 'string') {
    result.content = [{ type: 'text', text: content }]
  }
  // 已经是数组 → 透传（兼容多模态：OpenAI 的 `{type:'image_url',…}` 实测上游直接接受）

  return result
}

/**
 * tool_choice 归一化。
 *
 * 对齐 Go 端 `normalizeToolChoice`：
 * - `"none"` / `{type:"none"}` → 删 `tool_choice` + 删 `tools`
 * - `{type:"auto"/"required"}` → 字符串 `"auto"` / `"required"`
 * - `{type:"function",function:{name:"x"}}` → 字符串 `"x"`
 *
 * ⚠️ `"none"` 必须**连 `tools` 一起删**：上游看到 `tools` 非空就会尝试调用工具，
 * 只删 `tool_choice` 等于没禁掉。
 */
function normalizeToolChoice(body: Record<string, unknown>): void {
  const tc = body.tool_choice
  if (tc === undefined) return

  const suppress = (): void => {
    delete body.tools
    delete body.functions
  }

  if (typeof tc === 'string') {
    if (tc.toLowerCase().trim() === 'none') {
      delete body.tool_choice
      suppress()
    }
    return
  }

  if (typeof tc === 'object' && tc !== null) {
    const v = tc as Record<string, unknown>
    const typ = typeof v.type === 'string' ? v.type.toLowerCase().trim() : ''
    switch (typ) {
      case 'none':
        delete body.tool_choice
        suppress()
        break
      case 'auto':
      case 'required':
        body.tool_choice = typ
        break
      case 'function': {
        const fn = v.function as Record<string, unknown> | undefined
        let name = typeof fn?.name === 'string' ? fn.name : ''
        if (name.length === 0) name = typeof v.name === 'string' ? v.name : ''
        body.tool_choice = name.trim().length > 0 ? name.trim() : 'auto'
        break
      }
      default:
        delete body.tool_choice
    }
    return
  }

  // 其他类型（非标量）：删掉，别把一个上游不认识的值发出去。
  delete body.tool_choice
}

/**
 * `tools[].function.parameters` 序列化。
 *
 * ⚠️ **SOLO 上游要求 `parameters` 是 string 类型**，OpenAI 标准是 object，
 * 因此须把 parameters 对象序列化为 JSON 字符串。发 object 会被上游拒
 * （或更糟：静默忽略工具定义）。
 */
function normalizeTools(body: Record<string, unknown>): void {
  const raw = body.tools
  if (!Array.isArray(raw) || raw.length === 0) return

  const out: unknown[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const t = item as Record<string, unknown>
    const fn = t.function as Record<string, unknown> | undefined
    if (fn === undefined) continue
    const params = fn.parameters
    if (typeof params === 'object' && params !== null) {
      fn.parameters = JSON.stringify(params)
    }
    out.push(t)
  }
  if (out.length > 0) {
    body.tools = out
  } else {
    delete body.tools
  }
}

/**
 * 把我们的 `ChatRequest`（含私有的 reasoning 开关）落成 OpenAI 请求体。
 *
 * 只挑上游认的字段，**不整份透传** —— 我们的 `ChatRequest` 允许任意扩展键
 * （`[key: string]: unknown`），整份透传会把插件内部字段漏给上游。
 *
 * `max_tokens` 走 {@link clampTraeMaxTokens} 收敛（见该函数的说明）。
 */
export function buildOpenAiBody(payload: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (typeof payload.model === 'string') body.model = payload.model
  if (Array.isArray(payload.messages)) body.messages = payload.messages
  if (typeof payload.temperature === 'number') body.temperature = payload.temperature
  if (typeof payload.top_p === 'number') body.top_p = payload.top_p
  const clamped = clampTraeMaxTokens(readNumberField(payload, 'max_tokens'))
  if (clamped !== undefined) body.max_tokens = clamped
  if (payload.stop !== undefined) body.stop = payload.stop
  if (Array.isArray(payload.tools) && payload.tools.length > 0) body.tools = payload.tools
  if (payload.tool_choice !== undefined) body.tool_choice = payload.tool_choice
  /**
   * 推理强度档位 —— **透传 `reasoning_effort`**。
   *
   * ⚠️ 这里原先写着「档位由 DSH 通过上游字段下发」，但**没有任何地方在下发它**：
   * 核心层（`llm/adapter.ts`）把翻译好的档位放进 `payload.reasoning_effort`，
   * 而本函数把它丢掉了 —— 用户在档位选择器里选的值**根本到不了上游**，
   * 静默按模型默认档跑（与 Qoder 那处是同一类「接缝」缺口）。
   *
   * 值就是 TRAE 目录里 `reasoning_effort_config.options` 的**原始字符串**
   * （`light` / `high` / `extra_high`）。核心层已经做过「规范名 → 私有 id」的翻译，
   * 所以这里**不做白名单校验、也不再翻译** —— 再校验一次等于把两套口径叠起来，
   * 出分歧时没人说得清是哪一层改的。
   *
   * ⚠️ 只认字符串：核心层保证给的是「该模型声明过的档位」，给别的类型说明上游
   * 契约变了，那属于编程错误，不该悄悄塞进请求体。
   */
  if (typeof payload.reasoning_effort === 'string' && payload.reasoning_effort !== '') {
    body.reasoning_effort = payload.reasoning_effort
  }
  // ⚠️ 我们的 `reasoning`（布尔或旧式档位名）**不进** SOLO 载荷 —— 它不是上游字段，
  // 透传一个上游不认识的键只会增加被拒的面。（它与 `reasoning_effort` 的分工见上。）
  return body
}
