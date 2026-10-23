# WorkBuddy AI 国际版 — 模型请求体实测记录（5.5.2 / CLI 2.137.1）

> 抓包方式：本地捕获服务器 `127.0.0.1:8899` + `WORKBUDDY_CONFIG_DIR` 指向自制
> `models.json`（自定义模型），用真实客户端二进制 `WorkBuddyAI.exe` 以
> `ELECTRON_RUN_AS_NODE=1` 跑 `cli/bin/codebuddy -p "say ok" --model wb-probe`。
> 完整原始抓包：`C:/Users/Administrator/AppData/Local/Temp/wb-re-capture/captures/req-001.json`
> 脱敏样本：`docs/workbuddy-intl-capture/sample-headers.json`、`sample-request-body.json`

## 1. 出站端点与路由

- 自定义模型：请求发到 `models.json` 里 `url` 字段原样 + `/chat/completions`
  （客户端内置 `normalizeChatCompletionsUrl()`：自动剥重复的 `/chat/completions` 后缀再拼一次）。
- 官方模型（wb-fast / wb-balanced / deep-model）：发到产品端点（`https://www.workbuddy.ai`），
  走 `Authorization: Bearer <access_token>`（登录后 JWT），由 auth 拦截器注入。
- 国际版 product.json 顶层：`endpoint=https://www.workbuddy.ai`、`isOversea=true`、
  `deploymentType=SaaS`、`dataFolderName=.workbuddy-ai`。

## 2. 请求头（实测全量，35 个）

| 头 | 实测值（脱敏） | 说明 |
|---|---|---|
| `authorization` | `Bearer <API_KEY>` | 与 `x-api-key` 同值双发 |
| `x-api-key` | `<API_KEY>` | 自定义模型也带 |
| `x-conversation-id` | `<UUID>` | 一次会话稳定 |
| `x-conversation-request-id` | `<HEX32>` | 会话级 root request id |
| `x-conversation-message-id` | `<HEX32>` | 与 `x-request-id` 同值 |
| `x-request-id` | `<HEX32>` | 每次请求新值 |
| `x-root-request-id` | `<HEX32>` | = conversation-request-id |
| `x-agent-type` | `main` | |
| `x-agent-intent` | `craft` | 模式：craft/ask |
| `x-agent-purpose` | `conversation` | |
| `x-ide-type` / `x-ide-name` | `CLI` | 桌面端为 `IDE` |
| `x-ide-version` | `2.137.1` | CLI 版本，不是产品版本 5.5.2 |
| `x-codebuddy-request` | `1` | |
| `x-domain` | `www.workbuddy.ai` | 国内版为 `copilot.tencent.com` 系 |
| `x-product` | `SaaS` | 对话路径也发 `SaaS`（不是归属名） |
| `x-user-id` | `<UUID>` | 登录账号 uid（settings.json `legacyOwnerUid` 同源） |
| `user-agent` | `CLI/2.137.1 WorkBuddy AI/2.137.1` | |
| `traceparent` / `b3` / `x-b3-*` / `x-trace-id` | W3C + B3 双格式，trace-id = root request id | |
| `x-stainless-*` | `os/lang/runtime/arch/package-version/retry-count` | openai-node SDK 指纹（6.25.0） |
| `x-requested-with` | `XMLHttpRequest` | |
| `accept` | `application/json` | 流式与否由 body.stream 决定，响应才切 SSE |
| `content-type` | `application/json` | |

**多轮对话时**还会有：`x-parent-conversation-id`（compact/子会话派生时）。
**隐私模式**：去掉 `x-private-data`（对自定义模型客户端主动删）。

> 客户端支持环境变量 `CODEBUDDY_SKIP_INTERNAL_HEADERS=1` 一键剥掉上表大部分
> 内部头（含 x-user-id/x-domain/x-product/stainless 全套），仅留
> `x-skip-auth-interceptor: 1` —— 反代若要最小形态可用该开关对照。

## 3. 请求体（`POST /chat/completions`，实测 bodyBytes=110293）

```jsonc
{
  "model": "wb-probe",
  "messages": [
    { "role": "system", "content": "You are CodeBuddy Code. ... <content_policy> ... 约17k字符" },
    { "role": "user", "content": "<system-reminder data-role=\"memory\">... 约14k字符", "agent": "cli" }
  ],
  "tools": [ /* 23 个 function 工具，OpenAI 函数调用格式 */ ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "reasoning_effort": "high"
}
```

关键结论：

1. **`reasoning_effort` 在自定义模型上也发**（`high`，即使我们没在 models.json 里声明）。
   网关若原样透传给不支持该字段的模型会 400，需在反代层按模型档位决定剥离/改写。
2. **没有** `temperature` / `top_p` / `max_tokens` / `tool_choice` / `parallel_tool_calls` /
   `thinking` / `extra_vars`（extra_vars 只在 growthEvent 活动期合并进 body）。
3. user 消息带一个非标字段 **`agent: "cli"`**（上游形态标记，非 OpenAI 标准）。
4. system 提示词开头 `You are CodeBuddy Code.`，内含 `<content_policy>`（政治/色情/违法内容
   拒答策略）与 `<memory>`（`~/.codebuddy/projects/<slug>/memory` 记忆系统说明）。
5. tools 是标准 `{"type":"function","function":{...}}`，`parameters` 带
   `additionalProperties:false` 与 `$schema: draft-07`，`strict:false`。
6. 截断/压缩：`RequestBodyGzip: true`（productFeatures），但本次 110KB 请求**未压缩**
   （无 `Content-Encoding`），即纯 JSON 直发。

## 4. 与插件适配器（src/adapters/buddy.ts）的差异清单

| # | 客户端真实形态 | 改造前 | 处置 |
|---|---|---|---|
| 1 | `authorization` + `x-api-key` 双发 | 只发 `authorization` | 已补（仅国际版） |
| 2 | `x-agent-type: main` | 未发 | 已补 |
| 3 | `x-agent-intent: craft` | 未发 | 已补 |
| 4 | `x-request-id` + `x-conversation-message-id` 同值 | 未发这对 | 已补 |
| 5 | `x-ide-type/name: CLI`、版本 `2.137.1` | 产品名 + `1.106.1` | 已改（仅国际版对话） |
| 6 | `x-user-id`（登录 uid） | 未发 | 已补 |
| 7 | `traceparent` + `b3` 全套 | 未发 | 已补 |
| 8 | `x-stainless-*` 指纹 | 未发 | 已补 |
| 9 | body 带 `reasoning_effort` | 已实现（按档位） | 一致 ✅ |
| 10 | body 带 `stream_options.include_usage` | 未发 | 已补 |
| 11 | user 消息带 `agent: "cli"` | 未发 | 已补 |
| 12 | 首条 system 硬要求（国际版 11-128） | 已实现 withLeadingSystem ✅ | 一致 |
| 13 | `x-conversation-*` 三头 | 已按 product 开关 ✅ | 语义已纠正（见 §5） |
| 14 | 官方模型走产品端点 + JWT | 固定走官方 `/v2/chat/completions` | 语义一致（只做官方通道） |

## 5. 落地记录（2026-10-23，按上表改完）

改动文件：

- `src/vendor/buddy/buddy-client-shape.ts`（新增，纯函数）：`uuidFromSeed()` / `hex32()` /
  `newRequestId()` / `newSpanId()` / `traceHeadersOf()` / `stainlessHeadersOf()`，
  常量 `CLI_IDE_VERSION=2.137.1`、`UA_CLI_INTL`、`OPENAI_SDK_VERSION=6.25.0`、
  `CLIENT_NODE_VERSION=22.21.1`（`x-stainless-runtime-version` **钉抓包值**：
  客户端是 Electron 打包的 Node，任何机器都报同一个版本；宿主 Node 是 v24.x，
  照实报等于自曝「我不是那个客户端」）。
- `src/adapters/buddy.ts`：
  - `BuddyProduct` 新增 `chatIdentity` / `chatUserAgent`（**只给国际版填**）；
  - 新增 `buddyChatHeaders()`（对话路径专用），`buddyHeaders()` 与国内版**一行未动**；
  - `requestChatStream()` 改用 `buddyChatHeaders()`，id 语义按抓包纠正：
    conversation-id 用 UUID 形态且按账号稳定、root-request-id 按会话稳定、
    message-id/request-id 每次新值（32 位十六进制）；
  - 国际版 user 消息补 `agent: "cli"`（`withClientMessageShape()`）。
- `src/adapters/index.ts`：导出 `buddyChatHeaders` / `BuddyChatIds`。
- `test/adapters/buddy.test.mjs`：新增 4 条断言（客户端形态头全量、国内版保持旧形态、
  id 语义、`agent:"cli"`），并纠正原来「conversation-request-id 每次新值」的错误断言。

**刻意没跟的两处**（不是遗漏，是取舍）：

1. `thinking: {type:'enabled'}` **保留**：真实客户端不发它，但仓库里有三站点实测
   （`decideReasoningEffort` 的注释与单测）证明「DeepSeek 未选档时必须靠它」，
   删掉等于回退一个已验证的功能修复。它不在任何指纹字段里。
2. `x-private-data` **不发**：客户端官方请求会带，但内容是加密/不透明载荷，
   伪造一个错误值比缺这个头更容易被风控标记。

## 6. 复现抓包

```powershell
# 1) 捕获服务器
node C:\Users\Administrator\AppData\Local\Temp\wb-re-capture\server.mjs   # :8899

# 2) 指向捕获服务器的 models.json
$cfg = "C:\Users\Administrator\AppData\Local\Temp\wb-re-capture\config"

# 3) 用真实客户端跑一次
$env:ELECTRON_RUN_AS_NODE="1"
$env:WORKBUDDY_CONFIG_DIR=$cfg
& "D:\WorkBuddyAI\WorkBuddyAI.exe" `
  "D:\WorkBuddyAI\resources\app.asar.unpacked\cli\bin\codebuddy" `
  -p "say ok" --model wb-probe

# 产物：wb-re-capture\captures\req-NNN.json（含 method/url/headers/body 全量）
```

## 7. 静态侧证据（app.asar.unpacked/cli/dist/codebuddy.js）

- 请求管线：`mergeRequestProviderData` → URL 归一化 → 自定义头（`getCustomHeaders`）→
  删 authorization/user-agent 重注入 → `internalModelRequestHeaders`（volatile 插件态）→
  会话三头 + root/parent → agent-type → skip-headers 开关 → reasoning 注入 →
  自定义模型降级（剥图片/剥 tools）→ `modelRequestProcessors` 按优先级处理 → 发送。
- 头常量表（`X-Request-ID`/`X-Conversation-ID`/`X-Product`/`X-Private-Data`/`X-Model-ID`
  等）在 bundle @16262500 附近。
- 自定义模型判定：id 前缀 `custom:` / `CUSTOM_LOCAL_MODEL_PREFIX`，或
  `trustLevel===CUSTOM` / tags 含 `custom`；这类请求会剥 `x-private-data`、
  `supportsImages:false` 时把数组 content 拍平成字符串、`supportsToolCall:false` 且
  `SkipToolCallSupportCheck!==true` 时剥 `tools`/`tool_choice`。
- 国际版 product.json：`isOversea:true`、官方档位 `wb-fast/wb-balanced/deep-model`
  （`reasoning:{effort,summary}` 声明，`deep-model` 仅 reasoning）。

## 8. ⚠️ `x-api-key` 不能放 JWT（2026-10-23 真账号 A/B）

上线后第一条真实对话直接失败：界面「API 密钥无效」，网关记录 `status: 401`、
响应体 `{"message":"not_found"}`，账号连续 4 次失败被降权。用真账号 token 做了
一次逐头 A/B（`/v2/chat/completions`，同一 body，只改请求头）：

| 变体 | 结果 |
|---|---|
| A 改造前形态（authorization + 5 身份头 + conversation 三头） | **200** |
| B A + `x-api-key: <JWT>` | **401 `{"message":"not_found"}`** |
| C A + `x-product: SaaS` | 200 |
| D 新 CLI 形态（traces / stainless / x-codebuddy-request / ide=CLI）**去掉** `x-api-key` | **200** |
| E 适配器修复后整套 | **200** |

结论：**唯一**的毒头是 `x-api-key`。官方账号凭据是 JWT，放进这个头会被上游当成
「错误的 API key」，直接 401 且文案伪装成 not_found；抓包里那个 `x-api-key`
来自**自定义模型**的 `sk-…` key，不是官方 token。

修复：`buddyChatHeaders()` 只在 `token.startsWith('sk-')` 时才发 `x-api-key`；
其余新头（`x-product: SaaS`、`x-product-code` 省略、CLI 的 `x-ide-*`、链路头、
stainless 指纹、`accept: application/json`）经 D 组验证全部安全。

回归护栏：`test/adapters/buddy.test.mjs` 有两条断言钉住 —— JWT 凭据必须**不发**
`x-api-key`，`sk-…` 凭据照发。

