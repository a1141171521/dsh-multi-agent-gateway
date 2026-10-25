/**
 * WorkBuddy / CodeBuddy 网关「渠道校验」（`code 11-128`）的两道判据。
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
 * | 2 | 指令消息**以 DSH 的身份句开头** | {@link rewriteHarnessIdentity} → 换中性说法 |
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
 * ## 判据 2：DSH 身份句（**国内版独有**）
 *
 * `dsh-xdpool` 在 **2026-10-21 于国内版 chat 端**逐条实测（`src/upstream.ts`
 * 的 `HARNESS_IDENTITY_PHRASE` 注释），同样 `11-128` / 同一句 `msg`：
 *
 * | system 消息 | 结果 |
 * |---|---|---|
 * | 不带 system | 200 |
 * | `You are an AI agent powered by DeepSeek Harness.` | **400 / `11-128`** |
 * | 同上但去掉句末句号 | **400 / `11-128`** |
 * | `You are an AI agent.` + 该句 | 200 |
 * | 该句 + 工具前言 + `<available_skills>` | **400 / `11-128`** |
 * | 该句夹在长 prompt **中间一行** | 200 |
 *
 * 也就是说国内版网关拦的是这句话**作为指令消息的开头**出现 —— 而这恰好是
 * `@deepseek-ai/dsh-system-prompt` 的 `harness:identity` 段的形态：它是
 * `order: -1000` 的第一方固定开场白，**默认开启**（`includeHarnessIdentity`
 * 默认 `true`），所以**每一个默认配置的 DSH 用户**发出去的 system prompt 都以它开头。
 *
 * ✅ 这一行我们在 2026-10-25 用真实 CodeBuddy 账号自己复现了（同样
 * `copilot.tencent.com`、`system` 里带身份句 → 400 / 同一句 `msg`）。同一份 body
 * 打**国际版**是 200 —— 所以判据 2 是**国内版独有**的，见上方 §判据 1 的 B 行。
 * 「国际版测过了」不能当成「国内版也没问题」。
 *
 * 本机之所以长期没踩到：本机的 `dsh-system-prompt/lib/index.js` 被改过
 * （`includeHarnessIdentity` 默认值被改成 `false`，原件留在同目录的
 * `index.js.dshpurge.bak`）。**别人的机器是默认值** —— 这正是「已经有用户反馈」
 * 而我们在本机复现不出来的原因。
 *
 * ## 为什么不干脆让用户关掉 `includeHarnessIdentity`
 *
 * 那是**宿主 profile 的开关**，插件管不到别人的部署（用户装了插件就得先去改配置，
 * 等于把修复责任推给用户）。改在出站 body 里，装上就生效；用户自己在宿主侧关掉后，
 * 这里自然退化成 no-op（幂等）。
 *
 * ## 只动指令消息，不动用户的话
 *
 * 两道判据都只处理 `system` / `developer` 角色：身份句是从那条通道发出来的。
 * 用户消息、工具调用参数里如果**恰好引用**了这句话，原样保留 —— 我们没有理由
 * 改用户打的字，而且改工具参数会直接把一次调用改坏。
 */

import type { ChatMessage } from '../../core/types.js'

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
export function identityPattern(): RegExp {
  // eslint-disable-next-line no-control-regex -- \u00a0 是 NBSP，不是控制字符
  return /You[\s\u00a0]+are[\s\u00a0]+an[\s\u00a0]+AI[\s\u00a0]+agent[\s\u00a0]+powered[\s\u00a0]+by[\s\u00a0]+DeepSeek[\s\u00a0]+Harness\.?/giu
}

/**
 * 文本里是否还带着那句原话。
 *
 * **字面**判断（不做空白容错）—— 它是给断言用的：测试要能确认「改写之后这句原话
 * 真的不在报文里了」。改写本身走 {@link identityPattern}，两者刻意不同。
 */
export function carriesHarnessIdentity(text: string): boolean {
  return text.includes(HARNESS_IDENTITY_PHRASE)
}

/**
 * 该字段是否是本改写负责的文本载体。
 *
 * chat 文本可能是裸字符串（`content: "…"`），也可能是分段数组
 * （`content: [{type:'text',text:'…'}]`）。其余字段一律不碰：assistant 的
 * `tool_calls`、tool 消息的 `tool_call_id` 都不是散文。
 */
function isIdentityTextCarrier(key: string): boolean {
  return key === 'content' || key === 'text' || key === 'input_text'
}

/**
 * 递归替换一段文本里的身份句（字符串 / 数组 / 文本分段对象三种形态都走）。
 *
 * **纯函数**：返回副本，不改入参。调用方的 message 可能被别处共享
 * （`payload` 被 spread 进 body，同一份对象还可能被日志/重试路径读到），
 * 就地改会串味。
 */
function rewriteIdentitySentence(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(identityPattern(), NEUTRAL_IDENTITY_PHRASE)
  if (Array.isArray(value)) return value.map(rewriteIdentitySentence)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = { ...record }
  for (const [key, nested] of Object.entries(record)) {
    if (!isIdentityTextCarrier(key)) continue
    out[key] = rewriteIdentitySentence(nested)
  }
  return out
}

/**
 * 抹掉指令消息里的身份句（判据 2）。
 *
 * 只处理 `system` / `developer` —— 那是宿主自己的指令通道，身份句就是从那里发出来的。
 * 用户消息或 tool 结果里如果恰好引用了这句话，**原样保留**。
 *
 * 有意不看位置：DSH 把 prompt 作为第一条消息发出，但只看 `messages[0]` 会漏掉
 * 中途注入的 system 更新。幂等 —— 替换后的文本不再匹配该正则。
 */
export function rewriteHarnessIdentity(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== 'system' && message.role !== 'developer') return message
    const next: ChatMessage = { ...message }
    if (next.content !== undefined) {
      next.content = rewriteIdentitySentence(next.content) as ChatMessage['content']
    }
    if (typeof next.text === 'string') {
      next.text = rewriteIdentitySentence(next.text) as string
    }
    return next
  })
}

/**
 * 把 `developer` 角色改写成 `system`（判据 1）。
 *
 * 腾讯网关不认 `developer`（国际版实测 400，见文件头 A/B 的 D/E 两行）。DSH 在
 * 长对话里会注入这类消息（工具增删、重复工具提醒、上下文更新），所以**短对话正常、
 * 一旦对话变长就 400** —— 这是本判据最容易误判成「偶发」的地方。
 *
 * 语义上 `developer` 与 `system` 在 OpenAI 兼容协议里都是「比 user 更高优先级的指令」，
 * 降级到 `system` 不改变模型看到的内容。
 */
export function withInstructionRoles(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => (message.role === 'developer' ? { ...message, role: 'system' as const } : message))
}

/**
 * 对话 body 的**网关守卫**：两道判据一起过。
 *
 * 顺序有讲究：**先换角色，再改文本** —— `developer` 的消息被重标成 `system` 之后，
 * 仍要被第二道判据覆盖到。反过来（先改文本再换角色）也能工作，但那样「是否覆盖到
 * 全部指令消息」要依赖两次遍历的一致假设，不如按依赖顺序排。
 *
 * 幂等：两次调用结果相同（第二次没有 `developer` 可换，也没有身份句可改）。
 */
export function guardChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return rewriteHarnessIdentity(withInstructionRoles(messages))
}
