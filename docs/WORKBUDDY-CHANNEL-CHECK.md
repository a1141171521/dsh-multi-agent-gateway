# 渠道校验 `code 11-128`：一个错误码，两个成因

> 用户报障（2026-10-25，**国内版**）：
>
> ```
> 处理失败
> ● 本轮运行失败  {"code":11-128,"msg":"Illegal API invocation from an unapproved channel",
>                  "requestId":"8da3eb5c-e4f6-4447-9db5-3cf07f8ba160",
>                  "displayMsg":{"en":"Request blocked. Please send it again",
>                                "zh":"请求被拦截，请重新发送",
>                                "zh-hant":"請求已被攔截，請重新傳送"},
>                  "displayTips":{"en":"This call failed channel verification, possibly beca…"}}   BAD_REQUEST
> ```

`displayMsg` / `displayTips` 把它包装成「内容被拦截 / 渠道校验失败」，**但这不是内容安全**，
也不是限流、不是凭据问题。同一个 `11-128` 在 `/v2/chat/completions` 上至少对应**两个独立判据**，
它们**共用同一个 code、同一句 msg** —— 所以修掉一条之后，另一条的报错**一字不差**，
看起来像「改了没生效」。

| # | 判据 | 我们怎么处理 | 代码 |
|---|---|---|---|
| 1 | 指令消息的 `role` 是 `developer` | 改写成 `system` | `withInstructionRoles()` |
| 2 | 指令消息**以 DSH 身份句开头** | 换中性说法 | `rewriteHarnessIdentity()` |

两者都在 `src/vendor/buddy/buddy-channel-guard.ts`，由 `guardChatMessages()` 一次过，
在 `BuddyAdapter.requestChatStream()` 里作为**消息归一化的第一层**接入（顺序有依赖，见 §5）。

---

## 1. 判据 1：`developer` 角色（本机实测，国际版）

2026-10-25，本机对 `https://www.workbuddy.ai/v2/chat/completions` 做 A/B：
**请求头固定**为适配器现在发出的整套（`buddyChatHeaders()`），**只改 body**。
脚本 `.scratch/buddy-identity-ab.mjs`，账号为真实 workbuddy-intl 凭据。

| 用例 | `messages` | HTTP | 响应 |
|---|---|---|---|
| A | `system: "You are a helpful assistant."` + `user` | **200** | 正常 SSE |
| B | `system: "<身份句>\n\nYou operate…"` + `user` | **200** | 正常 SSE |
| C | `system: "<中性句>\n\nYou operate…"` + `user` | **200** | 正常 SSE |
| D | **`developer`** + 身份句 + `user` | **400** | `11-128` / Illegal API invocation from an unapproved channel |
| E | **`developer`** + 中性句 + `user` | **400** | 同上，**一字不差** |

三条结论，逐条都有上面的数据支撑：

1. 国际版网关**拦角色**：`developer` 一律 400，与内容无关（D 与 E 同错）。
2. 国际版网关**不拦身份句**：B 与 C 同为 200。
3. 这个 400 的文案与用户截图**完全一致** —— 同一个 code、同一句 msg。

### 国内版复测（2026-10-25 12:44，真实 CodeBuddy 账号）

拿到国内版账号后对 `https://copilot.tencent.com/v2/chat/completions` 做了同样的
控制组实验（`.scratch/buddy-cn-live-check.mjs`，头用适配器实际发出的那套，只改 body）：

| 用例 | `messages` | HTTP | 响应 |
|---|---|---|---|
| X | **`developer`** + 身份句 + `user` | **400** | `11-128` / Illegal API invocation from an unapproved channel |
| Y | `system` + **身份句** + `user` | **400** | **同一句** |
| Z | 走 `BuddyAdapter`（同样三条消息） | **200** | 正常 SSE |

于是两条判据在**国内版上都被我们直接测到了**，不再只是转述参考实现：

- X 证明国内版也拦 `developer`（与国际版同）；
- Y 证明国内版**还**拦身份句 —— 而国际版不拦（§1 的 B）；
- Z 证明守卫把两条同时消掉之后，上游正常返回。

⚠️ Y 与 §1 的 B **只差一个端点**，结论却相反：同一个 `system` 内容，国际版 200、
国内版 400。所以「国际版测过了」**不能**当成「国内版也没问题」——这是本缺陷最贵的教训。

### 为什么这个缺陷会「偶发」

DSH 在**长对话**里才会注入 `developer` 消息（工具增删、重复工具提醒、上下文更新），
短对话一条都没有。表现就是「刚装上能用，聊久了突然被拦」，极容易被误判成
「上游抽风」或「账号被风控」。

---

## 2. 判据 2：DSH 身份句（**国内版**）

`dsh-xdpool` 在 2026-10-21 于**国内版** chat 端逐条实测（`src/upstream.ts` 的
`HARNESS_IDENTITY_PHRASE` 注释，原文表格照录）：

| system 消息 | 结果 |
|---|---|
| 不带 system | 200 |
| `You are a helpful assistant.` | 200 |
| `You are an AI agent powered by DeepSeek Harness.` | **400 / `11-128`** |
| 同上但去掉句末句号 | **400 / `11-128`** |
| `You are an AI agent.` + 该句 | 200 |
| 该句 + 工具前言 + `<available_skills>` | **400 / `11-128`** |
| 该句夹在长 prompt **中间一行** | 200 |

即国内版拦的是这句话**作为指令消息的开头**出现。而这句话恰好是
`@deepseek-ai/dsh-system-prompt` 的 `harness:identity` 段：

> ✅ 本机 2026-10-25 用真实 CodeBuddy 账号在 `copilot.tencent.com` 上复现了这一行
> （§1 的 Y 用例：`system` 里带身份句 → 400 / 同一句 `msg`）。同一份 body 打国际版
> 是 200（§1 的 B），所以这条判据是**国内版独有**的。

- 它是 `order: -1000` 的第一方固定开场白；
- **默认开启**（`includeHarnessIdentity` 默认 `true`）；
- 所以**每一个默认配置的 DSH 用户**，system prompt 都以它开头。

> 该仓库的修复脚本 `scripts/fix-xdpool-channel-check.mjs` 就是为此而生（最新提交
> `4558c5b`「新增一键修复网关拦截的脚本，取代两个旧脚本」）：它已经处理了
> `developer` 角色，用户却仍然报同一句错误 —— 剩下的就是这一条。

### 为什么本机复现不出来（重要，别再被骗一次）

本机的 `dsh-system-prompt/lib/index.js` **被改过**：

| | 原件（`lib/index.js.dshpurge.bak`） | 本机现役（`lib/index.js`） |
|---|---|---|
| 默认值 | `includeHarnessIdentity: z.boolean().default(true)` | `.default(false)` |
| 注入条件 | `if (config.includeHarnessIdentity)` | `if (config.includeHarnessIdentity ?? false)` |

所以本机发出去的 system prompt **本来就不含这句话**，本地测试永远 200。
**别人的机器是默认值** —— 这正是「用户反馈了、我们复现不出来」的原因。

## 3. 为什么不干脆让用户关掉 `includeHarnessIdentity`

那是**宿主 profile 的开关**，插件管不到别人的部署：让用户先去改宿主配置，等于把
修复责任推给用户，而且绝大多数人根本不知道有这个开关。

改在出站 body 里，装上就生效；用户自己在宿主侧关掉之后，这里自然退化成 no-op
（改写是幂等的，见 `test/channel-guard.test.mjs`）。

## 4. 为什么是「改写」而不是「删除」

改写保留了原意（仍然是「一个跑在 harness 里的 AI agent」），system prompt 该有的东西
一样没少；删除会让模型的自我描述出现空洞，而自我描述在某些任务里是有用的上下文。

| | 文本 |
|---|---|
| 原句 | `You are an AI agent powered by DeepSeek Harness.` |
| 改写后 | `You are an AI agent running inside this harness.` |

## 5. 落地记录

改动文件：

- `src/vendor/buddy/buddy-channel-guard.ts`（新增，纯函数）
  - `identityPattern()` —— **每次返回新正则**：带 `g` 的正则有 `lastIndex` 状态，
    共享实例会在连续调用间给出错误答案；句内空白按「任意空白」匹配，将来宿主重新
    折行也不会静默失效。
  - `rewriteHarnessIdentity()` / `withInstructionRoles()` / `guardChatMessages()` ——
    **纯函数**，返回副本不改入参（`payload` 会被 spread 进 body，同一份对象还可能
    被日志与重试路径读到，就地改会串味）。
  - `carriesHarnessIdentity()` —— 字面判断，专供断言。
- `src/adapters/buddy.ts` —— `requestChatStream()` 的消息归一化变成三层，
  **顺序有依赖**：
  ```
  guardChatMessages         ① developer → system，抹掉身份句
    → withLeadingSystem     ② 国际版硬要求首条是 system
      → withClientMessageShape  ③ user 消息补 agent:"cli"
  ```
  ① 必须在 ② 之前：如果首条原本是 `developer`，① 先把它换成 `system`，② 才会
  看到真实形态、不会多补一条 `You are a helpful assistant.` 把客户端指令挤到第二位。
  （`test/channel-guard.test.mjs` 有一条用例专门钉这个顺序。）
- `test/channel-guard.test.mjs`（新增，20 条）
  - 守卫本体：改写范围 / 分段 content / 折行与大小写 / 幂等 / 纯函数 / 不动用户与工具参数；
  - **出站报文**：国内版与国际版各四条，断言 `calls[0].body` 的实际字节里
    既没有 `developer` 也没有那句身份句。
- `package.json` —— `npm test` 纳入新套件，另加 `npm run test:channel-guard`。

## 6. 只动指令消息，不动用户的话

两道判据都只处理 `system` / `developer` 角色 —— 身份句是从那条通道发出来的。
用户消息、tool 结果、工具调用参数里如果**恰好引用**了这句话，原样保留：

- 没有理由改用户打的字；
- 改工具调用参数（`tool_calls[].function.arguments` 是 JSON 字符串）会把一次调用改坏。

`rewriteIdentitySentence()` 只递归 `content` / `text` / `input_text` 三个载体字段，
其余键一律不碰。

## 7. 自查方法

想确认自己这台机器发出去的报文长什么样：

```bash
node --test test/channel-guard.test.mjs        # 20 条，含出站报文断言
```

线上判断：若仍报 `11-128` 且 `msg` 为 `Illegal API invocation from an unapproved channel`，
按顺序排除

1. 报文里还有 `developer` 角色？（`grep '"role":"developer"'` 请求体）
2. 报文里还有 `You are an AI agent powered by DeepSeek Harness.`？
3. 两者都干净 → 说明是**第三个**我们还没见过的成因，请带着 `requestId` 反馈。

## 8. 与「三个会话头」那条判据的关系（别混）

同一批 `11-128` 还有一条**国际版专属**判据：缺 `X-Conversation-ID` /
`X-Conversation-Request-ID` / `X-Conversation-Message-ID` 任一个都 400。它已经在
`docs/WORKBUDDY-INTL-REQUEST.md` 里记录并实现（`requiresConversationHeaders`）。

三条判据的区别在 `msg` 与产品上：

| 判据 | 产品 | `msg` |
|---|---|---|
| 三个会话头缺失 | 国际版 | `request illegal` / 早期 `conversation id missing` |
| `developer` 角色 | **国际版 + 国内版（两端本机实测）** | `Illegal API invocation from an unapproved channel` |
| DSH 身份句 | **国内版（本机实测）**；国际版不拦 | 同上 |
| 首条不是 system | 国际版 | `first message is not system prompt` |

⚠️ 最后两条的 `msg` **完全相同**，只能靠「改一条、重测一次」逐层剥离 ——
这就是为什么这个缺陷值得单独一篇文档。

## 9. 覆盖情况与残留

已由**本机实测**覆盖（2026-10-25）：

| 判据 | 端点 | 实测方式 |
|---|---|---|
| `developer` 角色 | 国际版 `www.workbuddy.ai` | `.scratch/buddy-identity-ab.mjs`（D/E 两行） |
| `developer` 角色 | 国内版 `copilot.tencent.com` | `.scratch/buddy-cn-live-check.mjs`（X 行） |
| DSH 身份句 | 国内版 | 同上（Y 行） |
| 守卫生效 | 两端 | 同上（Z 行）+ `test/channel-guard.test.mjs` 的出站报文断言 |

仍然没有证据的部分：

- **国际版是否也拦身份句**：§1 的 B 说明**不拦**。仍两边都改写 —— 抹掉的是一个真实
  存在的指纹，且成本为零。
- **国内版是否也需要三个会话头**：没有证据说需要（`dsh-xdpool` 对两个产品都发，且
  他们的国内用户没有报过 `conversation id missing`），因此国内版的头**一行未动**。
- **是否还有第三个成因**：`msg` 相同的前提下无法排除。若两端都确认报文已净化却仍报
  同一个 `msg`，那就是新成因，需要带 `requestId` 反馈（见 §7）。

---

## 10. 2026-10-28：国内版再现同一条报错（未能复现，先修了「看不见原因」）

用户报障：国内版对话失败，`code 11-128` / 同一句 `msg`，`requestId=<略>`。

排查过程与结论：

| 检查 | 结果 |
|---|---|
| 全量请求日志（1383 条） | 当天 14:24:58 连两条 `risk_control` 失败，**1.2 秒后同一账号同一模型成功**（161→57 tokens） |
| 报文净化 | 出站 body 里既无 `developer` 也无身份句 —— 守卫生效，§7 的自查 1、2 都过关 |
| **11 次真机复打** | 顺序 6 次、并发 3 次、重复同一份 body 2 次、长 system + 工具表 + `developer` —— **全部 200** |
| 参数扫描 | `max_tokens` 8192/32000/64000、`temperature`/`top_p`、penalties、`stop`、`reasoning_effort=high` —— **全部 200** |

同一份报文在 1.6 秒内**既被拒又被接受** ⇒ 判据在服务端状态，不在报文里。
按 §7 的三步排除法，第 3 步成立：这是第三个成因，且不在我们可控范围。

### 顺带修掉一个确定的缺陷：错误原文被截断

旧实现是 `message: text.slice(0, 300)`（`src/adapters/buddy.ts` 的 400 分支）。
腾讯的错误体是 JSON，第 300 个字符**正好落在 `displayTips.en` 中间**（`…possibly beca`）
—— 用户截图、请求日志、错误提示三处看到的都是这半句，而恰恰是后半句在解释「为什么被拒」。

现在改成 `describeBuddyErrorBody()`：解析 `code / msg / displayMsg / displayTips / requestId`
拼成一行可读文本（中英文都留、重复的去掉），解析不出来才退回截断原文。
用例在 `test/adapters/buddy-error.test.mjs`（6 条）。

> 当天下午就抓到了真正的第三个成因，见 §11 —— 本文档至此不再有「未知成因」这一栏。

---

## 11. 判据 3：DSH 系统提示里的**路径说明句**（2026-10-28 真机定位，已修）

用户复测：**国内版每发一条对话都 400**，而我用真账号连打 19 次全 200。
差别只可能在报文内容，于是让用户重启后抓了一次**真实报文**。

### 定位过程（这套方法可复用）

| 步骤 | 做法 | 结果 |
|---|---|---|
| 1 | 把真机失败请求的 body 落到本机（临时诊断，用完已删） | 132 KB，14 条消息，82 个工具 |
| 2 | **原样重放**（只把 Authorization 换成真 token，不经过适配器） | **400 复现**，同样的 `11-128` |
| 3 | 去掉 `tools`、消息只留 system + 最后一条 | 仍 400 |
| 4 | system 换成中性短句 / 截到 2000 字 | **200** ⇒ 触发点在 system 里 |
| 5 | 对 system 做前缀二分 | 落在第 28625–28656 字之间 |
| 6 | 把那一段（407 字）单独打 | 400 |
| 7 | 段内只把 `resolve from` 改成 `resolves from` | **200** |
| 8 | 35 k 的 system 只改这一句，连打两次 | 全 200 |

### 触发句

```
Relative paths resolve from the workspace root
```

出处是 DSH 系统提示里「@ 引用 / 路径」那一段的第二句：

> Tokens prefixed with @ are paths the user explicitly referenced. **Relative paths resolve from the workspace root**; absolute paths identify files or directories on the host. …

这是**每个默认配置的 DSH 用户**都会发出去的一句，所以国内版是「每条对话都失败」而不是偶发。

### 判据性质：语义指纹，不是精确黑名单

同一句单独发（`Relative paths resolve from the workspace root; …`）→ 200；
放回那段里 → 400；把 `resolve` 改成 `resolves` → 200；把最后一句删掉 → 仍 400。
即网关用的是**语义/近似匹配**，判定「这段写法不像自家客户端」。所以：
差一个词能过，但换个写法也可能再撞上；真机验证才是唯一标准。

### 修法

`src/vendor/buddy/buddy-channel-guard.ts` 新增判据 3：

| 原句 | 改写后 |
|---|---|
| `Relative paths resolve from the workspace root` | `Relative paths are resolved against the workspace root` |

与判据 2 共用同一条改写通道（只动 `system` / `developer` 的 `content`/`text`，用户消息原样保留），
正则按「任意空白 + 忽略大小写」匹配，幂等。

### 验证

- 出站报文断言：`test/channel-guard.test.mjs` 新增 3 条（原句必须消失、改写句必须在、折行/幂等/用户消息不动），该套件 20 → 23；
- **真机回归**：把用户那次失败的真实 body 直接喂给适配器 → 200，正文正常返回，日志确认出站 system 里已无原句；
- 全量：宿主 666/666、客户端 85/85、冒烟通过。

### 仍然没做的

对 `11-128` 加同账号一次短退避重试 —— 这次是**确定性**失败，重试没用，所以更没必要为它破
「`risk_control` 一律不重试」的规矩。


