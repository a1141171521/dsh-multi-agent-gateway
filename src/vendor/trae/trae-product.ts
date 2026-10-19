/**
 * TRAE（字节跳动 TRAE IDE）产品常量。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae-product.ts`
 * 与 `trae.ts` 的「端点路径」一节。**注释里保留了原实现踩过的坑与实测记录**——
 * 那是这份移植最有价值的部分，删掉它就等于把「为什么这么写」一起删了。
 *
 * ## 协议速览（来源见下方各条注释）
 *
 * | 用途 | 方法 | 路径 | Host | 认证 |
 * |------|------|------|------|------|
 * | 对话 | POST | `/api/agent/v3/llm_utils_chat` | `trae-api-cn.mchost.guru` | Cloud-IDE-JWT |
 * | 模型列表（**多通道**） | POST | `/api/ide/v1/batch_get_detail_param` | 同上 | Cloud-IDE-JWT |
 * | 模型列表（单通道） | POST | `/api/ide/v1/get_detail_param` | 同上 | Cloud-IDE-JWT |
 * | 换 token | POST | `/cloudide/api/v3/trae/oauth/ExchangeToken` | `api.trae.com.cn` | 用 refreshToken |
 * | 用户信息 | POST | `/cloudide/api/v3/trae/GetUserInfo` | 同上 | Cloud-IDE-JWT |
 * | 签到状态 | POST | `/trae/api/v2/ug/checkin_credits/status` | `api.trae.cn` | Cloud-IDE-JWT |
 * | 签到领取 | POST | `/trae/api/v2/ug/checkin_credits/claim` | 同上 | Cloud-IDE-JWT |
 * | 积分余额 | POST | `/trae/api/v2/pay/ide_user_ent_usage` | 同上 | Cloud-IDE-JWT |
 *
 * ⚠️ chat 端点返回**自定义 SSE 事件格式**（非 OpenAI 标准），必须独立解析再转换
 * （见 `trae-sse.ts`）。载荷也必须从 OpenAI 映射成 SOLO 格式（见 `trae-payload.ts`）。
 */

/** 对话端点（SOLO 自定义 SSE）。 */
export const TRAE_CHAT_PATH = '/api/agent/v3/llm_utils_chat'

/** 模型列表（单通道）。 */
export const TRAE_MODELS_PATH = '/api/ide/v1/get_detail_param'

/**
 * 模型列表（**多通道**，真实 CN IDE 用的端点）。
 *
 * 一次请求传多个 `functions`，响应 `function_configs[]` 为**每个通道各自一套**
 * 模型目录 —— 用它替代逐个通道调用 `get_detail_param`。
 */
export const TRAE_BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param'

/** ExchangeToken（refreshToken 换 accessToken）。 */
export const TRAE_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken'

/** 用户信息。 */
export const TRAE_USER_INFO_PATH = '/cloudide/api/v3/trae/GetUserInfo'

/** 签到状态。 */
export const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'

/** 签到领取。 */
export const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'

/** 积分余额。 */
export const TRAE_ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage'

/** 控制面请求超时（毫秒）；对话流式请求不适用。 */
export const TRAE_REQUEST_TIMEOUT_MS = 30_000

// ── Host ──

/** 上游 API 基址（Agent 服务：对话 + 模型列表）。 */
export const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru'

/** 签到 / 积分 / Ug 基址。 */
export const TRAE_UG_HOST = 'https://api.trae.cn'

/** OAuth / 认证基址（ExchangeToken / GetUserInfo）。 */
export const TRAE_OAUTH_HOST = 'https://api.trae.com.cn'

/** 登录门户基址（本期不做登录，仅作文档信息）。 */
export const TRAE_CONSOLE_HOST = 'https://www.trae.cn'

// ── 客户端标识 ──

/**
 * IDE 版本号（控制模型可用性）。
 *
 * ⚠️ **版本号是「模型可用的准入条件」**：上游按 `X-Ide-Version` /
 * `X-App-Version-Code` 决定哪些模型可以返回，版本过低时新模型会报
 * `4001 param is invalid`。参考实现记录：`0.1.52` / `20260811` 是实测能拿到
 * `glm-5.3` 的最低版本。
 */
export const TRAE_IDE_VERSION = '0.1.52'

/** IDE 版本号代码（日期式）。 */
export const TRAE_IDE_VERSION_CODE = '20260811'

/** `X-App-Id`。 */
export const TRAE_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/** User-Agent。 */
export const TRAE_USER_AGENT = 'Trae/0.1.52'

/** `X-Device-Brand`。 */
export const TRAE_DEVICE_BRAND = 'Apple'

/** `X-OS-Version`。 */
export const TRAE_OS_VERSION = 'macOS 15.7.4'

/**
 * **默认**对话通道（`function`），模型未标明所属通道时使用。
 *
 * ⚠️ 它不是「唯一的通道」—— 各通道模型集不同，真正的通道归属由远端目录的
 * 每条 `function` 决定（见 {@link TRAE_CHANNELS}）。
 */
export const TRAE_FUNCTION = 'solo_work_lite'

/** 默认 model（config_name）。对齐 Go 端 `DefaultConfigName`。 */
export const TRAE_DEFAULT_MODEL = 'glm-5.2'

/**
 * **可调用通道白名单**，**顺序即优先级**。
 *
 * ## 这不只是排序表，它同时是准入白名单
 *
 * 真实 CN IDE 用 `batch_get_detail_param` 一次查 22 个 function，每个 function
 * 各自一套模型目录。⚠️ 但上游下发的 22 个 function 里，**只有一部分**在本插件
 * 用的推理端点（`/api/agent/v3/llm_utils_chat`）下真正可调用。
 *
 * 参考实现的逐通道实测（2026-10-04，真实凭据，每个 function 各发一次最小请求）：
 *
 * | 结果 | function |
 * |---|---|
 * | ✅ 可调用（本表内容，15 个） | `solo_agent` / `solo_work_lite` / `solo_agent_remote` / `solo_work_remote` / `solo_agent_lite` / `solo_design_lite` / `solo_design_remote` / `solo_coder` / `chat_v3` / `builder_v3` / `git_ai` / `code_reviewer` / `code_review_summary` / `multimodal` / `system_diagnosis` |
 * | ❌ 稳定被拒 | `chat`（`4023 the model is unknown`）/ `builder`（`4001 param is invalid`）/ `inline_chat`（`3003 model service is unavailable`） |
 * | ⚪️ 目录恒空 | `ui_builder_v2` / `solo_builder` / `custom_agent_generation` / `utils` |
 *
 * ## 不把非白名单通道剔掉的代价（参考实现 Issue IKJOZ7）
 *
 * 早期实现让「目录声明了什么通道就照着发什么通道」，于是 38 条目录里有
 * **19 条（50%）**带着不可调用的 `function`，用户一选中就稳定失败 —— 而报错文案
 * （`the model is unknown` / `param is invalid`）指向**模型**，极易被误判成
 * 「这个模型坏了」。现在非白名单通道**整组丢弃**（连同其独有模型）。
 *
 * ⚠️ **丢弃是刻意的取舍**：`glm-5.1` / `DeepSeek-V4-Flash` 等模型同时也在通用通道
 * 里，故不受影响；只有「仅在不可调用通道里出现」的条目会被剔除 —— 那正是必然失败的那批。
 *
 * ⚠️ **顺序即优先级**：同一模型被多个白名单通道列出时，取更靠前者
 * （见 `parseTraeBatchModelList` 的合并规则 2）。`solo_agent` 排首位是对齐官方
 * Auto Mode 选择器。
 *
 * ⚠️ 可用 `DSH_TRAE_CHANNELS`（逗号分隔）覆盖 —— 但覆盖的是**整张白名单**，
 * 写错即过滤掉全部模型（这是有意的：宁可空目录，也不要再让不可调用的通道流出去）。
 */
export const TRAE_CHANNELS: readonly string[] = resolveChannelList(
  typeof process === 'undefined' ? undefined : process.env.DSH_TRAE_CHANNELS,
)

/** 解析 `DSH_TRAE_CHANNELS`；空/非法时回退默认通道列表。 */
function resolveChannelList(raw: string | undefined): readonly string[] {
  const fallback: readonly string[] = [
    // ── 通用通道（顺序即优先级）──
    'solo_agent',
    'solo_work_lite',
    'solo_agent_remote',
    'solo_work_remote',
    'solo_agent_lite',
    // ── 专用通道（只有通用通道都不含某模型时才会命中）──
    'chat_v3',
    'builder_v3',
    'solo_coder',
    'solo_design_lite',
    'solo_design_remote',
    'git_ai',
    'code_reviewer',
    'code_review_summary',
    'multimodal',
    'system_diagnosis',
  ]
  if (raw === undefined) return fallback
  const parsed = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  return parsed.length > 0 ? parsed : fallback
}

/**
 * `batch_get_detail_param` 请求体里的 `functions` 列表（**全部 22 个**）。
 *
 * ⚠️ **刻意传全部，而不是只传白名单里的 15 个**：真实 CN IDE（Trae CN.exe 3.3.94）
 * 传的就是全部 22 个。参考实现实测记录：只传聊天通道会让非聊天通道的条目在响应里
 * **出现位置错乱，甚至被解析器跳过**。所以「请求全部、解析时只消费白名单」。
 */
export const TRAE_BATCH_FUNCTIONS: readonly string[] = [
  'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder',
  'builder_v3', 'builder', 'chat', 'inline_chat', 'git_ai',
  'custom_agent_generation', 'utils', 'code_reviewer',
  'code_review_summary', 'solo_agent', 'solo_agent_remote',
  'solo_work_remote', 'solo_agent_lite', 'solo_work_lite',
  'solo_design_lite', 'solo_design_remote', 'multimodal',
  'system_diagnosis',
]

/**
 * 构造 `batch_get_detail_param` 的请求体。
 *
 * 逐字对齐真实 CN IDE 的载荷（见 {@link TRAE_BATCH_FUNCTIONS} 的说明）。
 */
export function buildTraeBatchModelsBody(): Record<string, unknown> {
  return {
    functions: [...TRAE_BATCH_FUNCTIONS],
    agent_type: '',
    current_config_info: { config_name: '', is_custom_model: false },
    mode_type: 0,
    access_type: 0,
    ab_force_vids: '',
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  }
}

// ── 兜底模型目录 ──

/**
 * 兜底模型目录中的一个条目。
 *
 * ⚠️ **数值是估值**，远端 `batch_get_detail_param` 可用时**完全采信远端**的
 * `context_window_tokens` 与 `max_tokens`。本表只在远端整体失败时顶替。
 */
export interface TraeFallbackModel {
  id: string
  name: string
  contextWindow: number
  /** 已知的上游内部/隐藏条目（远端不可用时也不该出现在目录里）。 */
  isHidden?: boolean
}

/**
 * 兜底模型目录（32 个）。
 *
 * 来源：参考实现 `handler.go:247-280` 的 staticModels，**2026-08 实测快照**。
 * 顺序照抄，不重排。
 *
 * ⚠️ 这是「远端目录整体拿不到」时的降级路径。它的存在价值是「至少让用户
 * 能选到一个大概率可用的模型」，不是「权威清单」——**不要**拿它去断言某个模型
 * 一定存在或一定免费（快照会过期：参考实现记录过一次快照在两天内就完全失效）。
 */
export const TRAE_FALLBACK_MODELS: readonly TraeFallbackModel[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200_000 },
  { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200_000 },
  { id: 'browser_use_subagent', name: 'Browser Use Subagent', contextWindow: 200_000, isHidden: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200_000 },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000 },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200_000 },
  { id: 'sagitta', name: 'Sagitta', contextWindow: 200_000 },
  { id: 'aquila', name: 'Aquila', contextWindow: 200_000 },
  { id: 'custom_model_gemini', name: 'Custom Gemini', contextWindow: 200_000 },
  { id: 'custom_model_placeholder', name: 'Custom Placeholder', contextWindow: 200_000 },
  { id: 'custom_model_1M_text', name: 'Custom 1M Text', contextWindow: 200_000 },
  { id: 'custom_model_1M', name: 'Custom 1M', contextWindow: 200_000 },
  { id: 'custom_model_kimi', name: 'Custom Kimi', contextWindow: 200_000 },
  { id: 'custom_model_claude', name: 'Custom Claude', contextWindow: 200_000 },
  { id: 'custom_model_gpt-5', name: 'Custom GPT-5', contextWindow: 200_000 },
  { id: 'custom_model_no-fc', name: 'Custom No-FC', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_chat', name: 'Custom DeepSeek Chat', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_reasoner', name: 'Custom DeepSeek Reasoner', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_v4', name: 'Custom DeepSeek V4', contextWindow: 200_000 },
  { id: 'explore_sub_agent_v13', name: 'Explore Sub Agent V13', contextWindow: 200_000, isHidden: true },
  { id: 'explore_sub_agent_v2', name: 'Explore Sub Agent V2', contextWindow: 200_000, isHidden: true },
  { id: 'summary', name: 'Summary', contextWindow: 200_000, isHidden: true },
]

/**
 * 远端不可用时的兜底输出上限（`max_tokens`）。
 *
 * ⚠️ 实测远端主流模型声明的是 **32000**；参考实现旧兜底值写的 128000 会让
 * DSH 索要一个上游不接受的值。远端可用时一律以远端为准。
 *
 * 不放进 `TRAE_FALLBACK_MODELS` 逐条声明，是因为各模型真实值并不一致
 * （4000 ~ 384000），逐条填只会编造出更细的假数据。
 */
export const TRAE_FALLBACK_MAX_OUTPUT_TOKENS = 32_000

/**
 * 单次请求输出额度的**安全上限**（对齐参考实现 `model_limits.py`）。
 *
 * 参考项目实测结论：Trae SOLO CN 的 agent-remote 模型单次响应上限为
 * **64000 tokens**，并明确写道：
 *
 * > Keep the local clamp below that ceiling so a client asking for 131072
 * > cannot push an upstream 4xx.
 *
 * 即：客户端索要 131072 会把上游直接打成 4xx。这里默认按同一口径收敛。
 */
export const TRAE_DEFAULT_MAX_COMPLETION_TOKENS = 64_000

// ── Max 模式（1M 上下文）──

/**
 * Max 模式的上下文窗口默认值（1M）。
 *
 * 显式开了 Max 模式的模型由远端 `context_window_tokens.max` 权威声明；
 * 该常量只在远端未声明时兜底。
 *
 * ⚠️ **不要把它当成常规窗口**：只有远端标了 `display_config.max_mode === true`
 * 的模型才走 Max（见 `traeMaxModeFields`）。给未标记的模型硬套 1M 会被上游拒绝。
 */
export const TRAE_MAX_CONTEXT_TOKENS = 1_000_000

/**
 * Max 模式的提示词预算（936K）。
 *
 * 对齐参考实现里的 `DEFAULT_MAX_PROMPT_TOKENS`：1M 总窗口里留给补全的部分，
 * 比总窗口小是刻意的（给输出留位）。
 */
export const TRAE_MAX_PROMPT_TOKENS = 936_000

/** Max 模式的输出上限（64K），对齐参考实现的 `DEFAULT_MAX_OUTPUT_TOKENS`。 */
export const TRAE_MAX_OUTPUT_TOKENS = 64_000

/** Max 模式的 `mode_type` 取值，对齐参考实现的 `DEFAULT_MAX_MODE_TYPE`。 */
export const TRAE_MAX_MODE_TYPE = 1
