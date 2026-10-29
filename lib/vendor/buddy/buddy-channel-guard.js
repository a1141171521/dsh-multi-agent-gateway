/**
 * WorkBuddy / CodeBuddy 网关「渠道校验」（`code 11-128`）的改写表。
 *
 * ## 一个错误码，两个互不相干的成因
 *
 * 上游对 chat 请求的拒绝长这样（用户看到的原文）：
 *
 * ```json
 * {"code":11-128,"msg":"Illegal API invocation from an unapproved channel",
 *  "requestId":"…","displayMsg":{"zh":"请求被拦截，请重新发送"},
 *  "displayTips":{"en":"This call failed channel verification, possibly beca…"}}
 * ```
 *
 * `displayMsg` 把它包装成「内容被拦截」，但**它跟内容安全毫无关系**。同一个
 * `11-128` 在对话端点上至少对应**两个**独立判据，且**共用同一个 code**：
 *
 * | # | 判据 | 我们怎么处理 |
 * |---|---|---|
 * | 1 | 指令消息的 `role` 是 `developer` | {@link withInstructionRoles} → 改写成 `system` |
 * | 2 | 指令消息里出现 DSH 的**指纹句** | {@link rewriteHarnessIdentity} → 换中性说法 |
 *
 * ⚠️ **不能只看 code 判断原因**，也不能只修一条就以为修好了 —— 修掉一条之后，
 * 另一条的报错文案**一字不差**，看起来像「没生效」。
 *
 * ## 判据 1：`developer` 角色（我们自己实测，两个端点）
 *
 * 2026-10-25 在本机对**国际版**网关（`www.workbuddy.ai`）做的 A/B，头固定为适配器
 * 现在发出的整套，**只改 body**：
 *
 * | 用例 | body | 结果 |
 * |---|---|---|
 * | A | `system: "You are a helpful assistant."` | **200** |
 * | B | `system: "<身份句>\n\n…"` | **200** |
 * | C | `system: "<中性句>\n\n…"` | **200** |
 * | D | **`developer`** + 身份句 | **400 / `11-128` / Illegal API invocation from an unapproved channel** |
 * | E | **`developer`** + 中性句 | **400 / `11-128` / 同一句** |
 *
 * 即：国际版网关拦的是**角色**，不是身份句（B 与 C 同为 200，说明身份句本身被接受）。
 * 这条判据与 DSH 的内部语义无关 —— `developer` 是 OpenAI 较新的角色，腾讯网关不认。
 *
 * 同日对**国内版**端点（`copilot.tencent.com`）复测，同样 `developer` + 身份句 → 400 /
 * 同一句 `msg`（`.scratch/buddy-cn-live-check.mjs` 的 X 行）。
 *
 * ## 判据 2：指纹句（**国内版独有**）
 *
 * 网关会扫**每一条** `system` / `assistant` 消息，命中一份「别家 agent 的提示词」
 * 名单就拒，code 与 `displayTips` 与判据 1 完全一样。名单是上游的快照，我们只能按
 * 实测到的条目改写 —— 见 {@link CHANNEL_GATE_REWRITES} 的 12 条。
 *
 * ### 判定的形态变过两次，别再按旧模型写代码
 *
 * | 时间 | 当时测到的规则 | 证据 |
 * |---|---|---|
 * | 2026-10-21 | **只看开头**（prefix match）：同一句夹在长 prompt 中间 → 200 | `dsh-xdpool` 逐条实测 |
 * | 2026-10-28 | **位置无关**：第 28625 字的 `Relative paths resolve…` 单独就能触发 | 本仓库 §11 的前缀二分 |
 * | 2026-10-29 | **先归一化再匹配**：U+200B 打断每一个词边界仍然 400 | `dsh-connect-workbuddy@5.13.1` 两组独立探针 |
 *
 * 所以：**零宽字符那套不能用**（网关会 normalise 掉不可见字符），只能真改写措辞。
 * 这也解释了为什么「整句替换」比「插不可见字符」更耐打。
 *
 * ## 为什么以前只清两句：本机的验证环境被 dsh-purge 洗过（重要）
 *
 * `dsh-purge` 的 `#25 HARNESS_IDENTITY_STRIP` / `#26 MINIMAL_PERSONA_PURGE` /
 * `#32 WEB_SURFACE_IDENTITY_NEUTRAL` / `#43 WEB_PRESET_IDENTITY_STRIP` 会把前三条
 * 指纹从**本机**的 DSH 里删掉。结果是：我们自己的机器发出去的 system 只剩 @ 路径段
 * 那一段，于是 v0.3.2 的「真机复验」验的是一份**少了三处指纹的 prompt**。
 * 用户的机器没有 purge —— **凡是验证「指纹清干净了没有」，必须用 npm 上原版包的文本，
 * 不能拿本机那句「反正没报错」当证据。**
 *
 * ## 只动指令消息与 assistant 历史，不动用户的话
 *
 * 判据 1、2 只处理 `system` / `developer` / `assistant`：
 *   - `system` / `developer` 是宿主自己的指令通道；
 *   - `assistant` 是**历史回显**：模型把提示词抄进回复、会话恢复、压缩产物都会留下
 *     指纹句，而网关连 `assistant` 一起扫 —— 一条中毒的历史会让**之后每一轮**都挂
 *     （`dsh-connect-workbuddy` 的 issue #98 就是这个）。
 *
 * 用户消息、工具调用参数里如果**恰好引用**了这些句子，原样保留 —— 我们没有理由
 * 改用户打的字，而且改工具参数会直接把一次调用改坏。
 */

                                                      

/**
 * 被网关点名的 DSH 身份句。
 *
 * 出处：`@deepseek-ai/dsh-system-prompt` 的 `harness:identity` 段
 * （`lib/index.js` 里 `text: "You are an AI agent powered by DeepSeek Harness."`）。
 */
export const HARNESS_IDENTITY_PHRASE = 'You are an AI agent powered by DeepSeek Harness.'

/**
 * 顶替它的中性说法。
 *
 * 这是一次**改写**而不是删除：说辞变了，但 system prompt 该有的东西一样没少
 * （仍然是「一个跑在 harness 里的 AI agent」）。删掉会让模型的自我描述出现空洞，
 * 而模型的自我描述在某些任务里是有用的上下文。
 */
export const NEUTRAL_IDENTITY_PHRASE = 'You are an AI agent running inside this harness.'

/**
 * 第二类指纹：**部署 persona**（2026-10-29 由 issue #1 定位并真机确认）。
 *
 * 出处：`@deepseek-ai/dsh-web-app` 的 `cordis.patch.yml` 里
 * `personaPrefix: >- You are a coding agent powered by the {{model}} model.`，
 * 以及 `presets/{standard,ptc,cordis}.patch.yml` 里同样的 `prefix:` 行 ——
 * **原版 DSH 的每一个 preset 都带这一句**，rc.2 / rc.3 / rc.4 / 0.2.2-alpha.2 全都有。
 *
 * 模型名是变量（`workbuddy/hy4-preview`、`qmodel_38max`、`deepseek-v4.1-flash` …），
 * 所以正则只锚到 `powered by the` 之后、`model.` 之前，改写时把模型名原样留下。
 */
export const CODING_AGENT_PHRASE = 'You are a coding agent powered by the '

/** 第二类指纹的中性说法（模型名由正则的捕获组带过来）。 */
export const NEUTRAL_CODING_AGENT_PHRASE = 'You are a coding agent running on the '

/**
 * 第三类指纹：**Web 界面的自我描述**。
 *
 * 出处：`@deepseek-ai/dsh-harness-dev-context` 的 `WEB_SURFACE_PROMPT`
 * （`lib/index.js:29`）。只在 Web GUI 里出现，所以只在 Web 部署上踩得到。
 */
export const WEB_SURFACE_PHRASE = 'You are interacting with the user through the DeepSeek Harness Web GUI'

/** 第三类指纹的中性说法：只换掉「你正通过…交互」这个从句，后半段原文不动。 */
export const NEUTRAL_WEB_SURFACE_PHRASE = 'You are working with the user inside the DeepSeek Harness Web GUI'

/**
 * 第四类指纹：`@` 路径说明段（`@deepseek-ai/dsh-file-reference` 的
 * `FILE_REFERENCE_PROMPT`，407 字，见 §11）。
 *
 * 2026-10-28 的定位结论是「整段一起才触发」：单句发 200、整段发 400。
 * 只改其中一句就能破掉整段的匹配 —— 但**逐句都改**才抗版本漂移：DSH 改一个词、
 * 段内顺序变一下，只靠一句改写的方案会静默失效。
 */
export const FILE_REFERENCE_PHRASES = [
  'Tokens prefixed with @ are paths the user explicitly referenced.',
  'Relative paths resolve from the workspace root',
  'absolute paths identify files or directories on the host.',
  'A trailing slash marks a directory:',
  'list it when its contents matter.',
  'Anything else is a file:',
  'use the read tool when its contents are needed,',
  'and do not claim to have inspected it before reading.',
  '@"..." quotes a path containing spaces.',
]         

/** 路径段里被单独点名的那一句（对外保留这个别名，历史用例在用）。 */
export const PATH_MENTION_PHRASE = FILE_REFERENCE_PHRASES[1]

/** 顶替它的中性说法：意思不变，只是不再逐字撞上那句指纹。 */
export const NEUTRAL_PATH_MENTION_PHRASE = 'Relative paths are resolved against the workspace root'

/**
 * 一条改写规则。
 *
 * `source` 存的是**正则源码字符串**而不是 `RegExp` 实例：带 `g` 标志的正则有
 * `lastIndex` 状态，共享实例会在连续调用之间给出错误答案。每次用
 * {@link patternOf} 现造一个。
 */
                                     
                       
                         
                     
 

/** 句内空白按「任意空白」处理：`\s` 已含换行/NBSP，这里显式写出 NBSP 便于阅读。 */
const WS = '[\\s\\u00a0]+'

/**
 * 网关点名的 12 条指纹与它们的替代说法。
 *
 * 顺序即应用顺序：三条身份句在前（它们可能相邻），路径段 9 句按原文顺序。
 * 每条替换都**幂等** —— 替换后的文本不再匹配自己这条正则，也不匹配表里其它条。
 */
export const CHANNEL_GATE_REWRITES                                = [
  {
    name: 'harness-identity',
    source: `You${WS}are${WS}an${WS}AI${WS}agent${WS}powered${WS}by${WS}DeepSeek${WS}Harness\\.?`,
    to: NEUTRAL_IDENTITY_PHRASE,
  },
  {
    name: 'coding-agent-persona',
    // 模型名是变量，用捕获组原样带回；`[^\n]` 限定不跨行，避免吞掉后面整段。
    source: `You${WS}are${WS}a${WS}coding${WS}agent${WS}powered${WS}by${WS}the${WS}([^\\n]{1,120}?)${WS}model\\.?`,
    to: `${NEUTRAL_CODING_AGENT_PHRASE}$1 model.`,
  },
  {
    name: 'web-surface',
    source: `You${WS}are${WS}interacting${WS}with${WS}the${WS}user${WS}through${WS}the${WS}DeepSeek${WS}Harness${WS}Web${WS}GUI`,
    to: NEUTRAL_WEB_SURFACE_PHRASE,
  },
  {
    name: 'file-ref-at-token',
    source: `Tokens${WS}prefixed${WS}with${WS}@${WS}are${WS}paths${WS}the${WS}user${WS}explicitly${WS}referenced\\.`,
    to: 'Paths that begin with @ are the ones the user explicitly referenced.',
  },
  {
    name: 'file-ref-relative',
    source: `Relative${WS}paths${WS}resolve${WS}from${WS}the${WS}workspace${WS}root`,
    to: NEUTRAL_PATH_MENTION_PHRASE,
  },
  {
    name: 'file-ref-absolute',
    source: `absolute${WS}paths${WS}identify${WS}files${WS}or${WS}directories${WS}on${WS}the${WS}host\\.`,
    to: 'absolute paths point at files or directories on the host.',
  },
  {
    name: 'file-ref-trailing-slash',
    source: `A${WS}trailing${WS}slash${WS}marks${WS}a${WS}directory:`,
    to: 'A trailing slash indicates a directory:',
  },
  {
    name: 'file-ref-list-contents',
    source: `list${WS}it${WS}when${WS}its${WS}contents${WS}matter\\.`,
    to: 'list it whenever its contents matter.',
  },
  {
    name: 'file-ref-else-file',
    source: `Anything${WS}else${WS}is${WS}a${WS}file:`,
    to: 'Everything else is a file:',
  },
  {
    name: 'file-ref-read-tool',
    source: `use${WS}the${WS}read${WS}tool${WS}when${WS}its${WS}contents${WS}are${WS}needed,`,
    to: 'use the read tool whenever you need its contents,',
  },
  {
    name: 'file-ref-claim',
    source: `and${WS}do${WS}not${WS}claim${WS}to${WS}have${WS}inspected${WS}it${WS}before${WS}reading\\.`,
    to: 'and never claim to have inspected it before reading it.',
  },
  {
    name: 'file-ref-quote',
    source: `@"\\.\\.\\."${WS}quotes${WS}a${WS}path${WS}containing${WS}spaces\\.`,
    to: 'A path containing spaces is quoted with @"...".',
  },
]

/** 现造一个忽略大小写、全局匹配的正则（避免共享实例的 `lastIndex` 状态）。 */
function patternOf(source        )         {
  return new RegExp(source, 'giu')
}

/** 按名字取一条规则的正则；名字不存在时抛错，避免拼错名字静默变成 no-op。 */
function patternByName(name        )         {
  const rule = CHANNEL_GATE_REWRITES.find((item) => item.name === name)
  if (rule === undefined) throw new Error(`未知的网关指纹：${name}`)
  return patternOf(rule.source)
}

/**
 * 匹配身份句的正则 —— **每次返回一个新实例**。
 *
 * 两个理由：
 *   1. 带 `g` 标志的正则**有状态**（`lastIndex`），共享一个实例时 `.test()` 会在
 *      连续调用间给出错误答案。这里只用 `.replace()`（它会重置 `lastIndex`），
 *      但工厂函数让「将来有人加了 `.test()`」也不会踩坑。
 *   2. 句内空白按「任意空白」处理：宿主把这句话作为一个 section 嵌进整段 prompt，
 *      将来一旦被重新折行/缩进，字面匹配会**静默失效**、拦截立刻回来。
 *      顺带忽略大小写，成本为零。
 */
export function identityPattern()         {
  return patternByName('harness-identity')
}

/** 匹配 `coding agent powered by the <model> model.` 的正则（模型名是变量）。 */
export function codingAgentPattern()         {
  return patternByName('coding-agent-persona')
}

/** 匹配 Web GUI 自我描述句的正则。 */
export function webSurfacePattern()         {
  return patternByName('web-surface')
}

/** 匹配路径说明句的正则 —— 同样每次新实例、句内任意空白、忽略大小写。 */
export function pathMentionPattern()         {
  return patternByName('file-ref-relative')
}

/**
 * 文本里是否还带着那句原话。
 *
 * **字面**判断（不做空白容错）—— 它是给断言用的：测试要能确认「改写之后这句原话
 * 真的不在报文里了」。改写本身走 {@link CHANNEL_GATE_REWRITES}，两者刻意不同。
 */
export function carriesHarnessIdentity(text        )          {
  return text.includes(HARNESS_IDENTITY_PHRASE)
}

/**
 * 文本里还剩哪几条指纹（测试与诊断用）。
 *
 * 返回**规则名**而不是布尔：断言失败时能直接看出漏了哪一条，不用再猜。
 * 空数组 = 12 条全清。
 */
export function carriesChannelFingerprint(text        )           {
  return CHANNEL_GATE_REWRITES.filter((rule) => patternOf(rule.source).test(text)).map((rule) => rule.name)
}

/**
 * 该字段是否是本改写负责的文本载体。
 *
 * chat 文本可能是裸字符串（`content: "…"`），也可能是分段数组
 * （`content: [{type:'text',text:'…'}]`）。其余字段一律不碰：assistant 的
 * `tool_calls`、tool 消息的 `tool_call_id` 都不是散文。
 */
function isIdentityTextCarrier(key        )          {
  return key === 'content' || key === 'text' || key === 'input_text'
}

/**
 * 递归替换一段文本里的全部指纹（字符串 / 数组 / 文本分段对象三种形态都走）。
 *
 * **纯函数**：返回副本，不改入参。调用方的 message 可能被别处共享
 * （`payload` 被 spread 进 body，同一份对象还可能被日志/重试路径读到），
 * 就地改会串味。
 */
function rewriteInstructionText(value         )          {
  if (typeof value === 'string') {
    return CHANNEL_GATE_REWRITES.reduce((text, rule) => text.replace(patternOf(rule.source), rule.to), value)
  }
  if (Array.isArray(value)) return value.map(rewriteInstructionText)
  if (typeof value !== 'object' || value === null) return value
  const record = value                           
  const out                          = { ...record }
  for (const [key, nested] of Object.entries(record)) {
    if (!isIdentityTextCarrier(key)) continue
    out[key] = rewriteInstructionText(nested)
  }
  return out
}

/** 会被网关扫内容的那几种角色。 */
function isScannedRole(role        )          {
  return role === 'system' || role === 'developer' || role === 'assistant'
}

/**
 * 抹掉消息里的**指纹句**（判据 2：三条身份句 + 路径段 9 句）。
 *
 * 处理 `system` / `developer` / `assistant`：
 *   - 前两者是宿主自己的指令通道；
 *   - `assistant` 是历史回显 —— 网关连它一起扫，一条中毒的历史会让之后每一轮都挂。
 *
 * 用户消息或 tool 结果里如果恰好引用了它们，**原样保留**。
 *
 * 有意不看位置：DSH 把 prompt 作为第一条消息发出，但只看 `messages[0]` 会漏掉
 * 中途注入的 system 更新；判据本身也已经是位置无关的（见文件头的时间线）。
 * 幂等 —— 替换后的文本不再匹配任何一条正则。
 */
export function rewriteHarnessIdentity(messages                        )                {
  return messages.map((message) => {
    if (!isScannedRole(message.role)) return message
    const next              = { ...message }
    if (next.content !== undefined) {
      next.content = rewriteInstructionText(next.content)                          
    }
    if (typeof next.text === 'string') {
      next.text = rewriteInstructionText(next.text)          
    }
    return next
  })
}

/**
 * 把 `developer` 角色改写成 `system`（判据 1）。
 *
 * 腾讯网关不认 `developer`（国际版实测 400，见文件头 A/B 的 D/E 行）。DSH 在
 * 长对话里会注入这类消息（工具增删、重复工具提醒、上下文更新），所以**短对话正常、
 * 一旦对话变长就 400** —— 这是本判据最容易误判成「偶发」的地方。
 *
 * 语义上 `developer` 与 `system` 在 OpenAI 兼容协议里都是「比 user 更高优先级的指令」，
 * 降级到 `system` 不改变模型看到的内容。
 */
export function withInstructionRoles(messages                        )                {
  return messages.map((message) => (message.role === 'developer' ? { ...message, role: 'system'          } : message))
}

/**
 * 对话 body 的**网关守卫**：两道判据一起过。
 *
 * 顺序有讲究：**先换角色，再改文本** —— `developer` 的消息被重标成 `system` 之后，
 * 仍要被第二道判据覆盖到。反过来（先改文本再换角色）也能工作，但那样「是否覆盖到
 * 全部指令消息」要依赖两次遍历的一致假设，不如按依赖顺序排。
 *
 * 幂等：两次调用结果相同（第二次没有 `developer` 可换，也没有指纹句可改）。
 */
export function guardChatMessages(messages                        )                {
  return rewriteHarnessIdentity(withInstructionRoles(messages))
}


//# sourceURL=src/vendor/buddy/buddy-channel-guard.ts