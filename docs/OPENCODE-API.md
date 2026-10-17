# OpenCode 上游接口事实

这一份记录的是**核对过的**事实（来自官方文档与真实探测），
不是猜的、也不是从别人的实现里抄的。写在这里是为了：
新增/修改 OpenCode 适配器时**不用再查一遍**，也避免把「以为有」当成「有」。

---

## 1. 端点表

| 用途 | 端点 | 鉴权 | 核对方式 |
|---|---|---|---|
| 模型目录（公开） | `https://opencode.ai/inference/v1/models` | **不需要** | 实测 `GET` → 200，返回 `{object, data:[{id, object, created, owned_by}]}`，88 个模型 |
| 模型价格 / 元数据 | `https://models.dev/api.json` → `providers.opencode.models` | 不需要 | 实测 200；每个模型含 `name / description / cost{input,output} / limit{context,output} / modalities / reasoning` |
| 对话（OpenAI 兼容） | `https://opencode.ai/inference/openai/v1/chat/completions` | `Authorization: Bearer <Console 账号 token 或 API key>` | 官方文档「Endpoints」表；两种凭证都收（见 §1.5/§1.6） |
| 对话（Responses API） | `https://opencode.ai/inference/openai/v1/responses` | 同上 | 同上（GPT / Grok / Muse 系列走这条） |
| 对话（Anthropic） | `https://opencode.ai/inference/anthropic/v1/messages` | 同上 | 同上（Claude / Qwen 系列走这条） |
| 对话（Gemini） | `https://opencode.ai/inference/google/v1beta/models/<model>` | 同上 | 同上 |
| 工作区配置 | `https://opencode.ai/console/api/v2/config` | Bearer（**Inference 权限即可**） | 官方 Console API 文档；返回 `{providers:{opencode:{name,env,settings:{baseURL,apiKey},models:{...}}}}` |
| 额度 / 预算 | `https://opencode.ai/console/api/v1/budgets/members` | Bearer（**需要 All 权限**） | 官方 Budgets API 文档；返回数组，钱字段是 **microcents 十进制字符串** |
| 设备码登录 | `POST https://opencode.ai/console/auth/device/code`、`.../auth/device/token` | `client_id=opencode-cli` | **实测握手**，见 §1.6 |

**钱字段单位**：`1 美元 = 100,000,000 microcents`。本适配器的 `microCentsToUsd()`
就是干这个，并有单测。

---

## 1.5 鉴权事实：**免费模型要 key 吗？**（实测，2026-10-16）

先把最容易误传的一条钉死：

> **免费模型不要 API key、也不要登录。** 但要**按客户端形状发请求**。
> 形状不对，上游回的就是那句 `FreeTierError`。

不带任何凭证直打，本来会被拦：

| 请求 | 结果 |
|---|---|
| `GET /inference/v1/models`，**无凭证** | **200** —— 模型目录本来就公开 |
| `POST .../chat/completions` 免费模型、**无凭证、`stream:false`** | **403** `FreeTierError` |
| `POST .../chat/completions` 免费模型、**无凭证、`stream:true` 但没工具** | **403** `FreeTierError` |
| `POST .../chat/completions` 免费模型、**`stream:true` + `read` 工具 + 会话头** | **200 ✅** |

`FreeTierError` 的原文是营销话术（"…from within OpenCode"），
**它校验的是请求形状，不是客户端指纹**——消融实验见下一节。

## 1.6 免费层（匿名）通道：过门的三件事

依据来自 [jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api)（MIT）的
`internal/identity/request.go`、`internal/gateway/upstream.go`、`internal/httpx/client.go`，
**并逐项做了消融实验**（一次只去掉一样，看还过不过）：

| 条件 | 去掉会怎样 |
|---|---|
| **`stream: true`** | **403** —— 免费层只接受流式 |
| **`tools` 里有一个叫 `read` 的工具** | **403**（卡我最久的一项） |
| **`x-opencode-session` = 规范 `ses_…`** | **403** |
| `x-opencode-client: cli` + 客户端 UA | 过（不是唯一解，但按官方形状发最稳） |
| `Authorization` / `x-opencode-request` / `x-opencode-project` | **去掉照样过**（不必需） |

### session id 必须是「降序编码」

规范形状 `ses_<12 位小写 hex><14 位 Base62>`，那 12 位 hex 是官方
`Identifier.descending()` 的产物：`~(ts_ms << 12 | counter)` 取低 48 位
（counter 官方只发 1–63，所以低 12 位落在 `0xFC0–0xFFF`）。
2026-09-16 起，别的形状一律 403。

本插件用的是**真实毫秒时间戳**（比 opencode2api 用 hash 伪造更贴近官方行为），
并按**会话内容**做确定性派生 —— 同一段对话永远得到同一个 session，
上游的 prompt cache 亲和性才不会被每次打散。

### 实测通过的请求

```http
POST https://opencode.ai/inference/v1/chat/completions
content-type: application/json
accept: text/event-stream
x-opencode-client: cli
x-opencode-session: ses_eb8460ad4ffefwOXligfVk4H7s
x-opencode-session-id: ses_eb8460ad4ffefwOXligfVk4H7s
user-agent: opencode/latest/2.0.29/cli

{ "model":"deepseek-v4.1-flash-free", "stream":true,
  "tools":[{"type":"function","function":{"name":"read", …}}] }
```

真拿到 200 + 正文「收到」+ `reasoning_content` + usage（`cacheReadTokens` 也在）。

### 插件里怎么用

**什么都不用填。** 账号卡片里只填一个标签，凭证留空 → 点「添加」→ 直接用。

- 触发条件：`upstream.freeTierMode: 'auto'`（默认）—— **账号没有 token 时自动启用**；
  有 key 的账号走正常路径，一套指纹都不加，互不影响。
- 工具：DSH 本来就发一个叫 `read` 的工具，天然满足；万一某个预设把它裁掉了，
  适配器会**追加一个占位 `read`**（描述写着 DEPRECATED / 别调用）。
- `stream: true` 本来就是这个插件对话路径的固定行为。

### 边界（别夸大）

- **只对免费模型有效**。付费模型在免费通道上会直接 `401 AuthError: Missing API key`（实测）。
- 上游随时可能再改门禁形状。所以这份指纹**只在没有 key 时**启用，
  有 key 的账号完全不受影响；真被拒时错误信息会把三件事列出来
  （`FREE_TIER_MESSAGE`），不会让你瞎试。
- 想更稳（或上游又变了）：可以改用 **§1.7 的登录态**或**中转**。

## 1.7 另外两条路

| 走法 | 要什么 | 插件里怎么用 |
|---|---|---|
| **免费层指纹**（默认） | **什么都不用** | 账号凭证留空即可 |
| 设备码登录 | 一个 OpenCode 账号 | 账号卡片点「登录 OpenCode 账号（设备码）」→ 浏览器授权一次 |
| Console API key | 手动去 Keys 建 `oc_sk_…` | 填 token 字段 |
| **中转 / 反代** | 由中转决定 | 改「对话 base url」 |

### 设备码登录（RFC 8628）

```js
// 常量来自官方 CLI 二进制（MIT）：
var lo = "https://opencode.ai/console"   // console base
var ln = "opencode-cli"                  // 公开的 OAuth client_id
// POST {lo}/auth/device/code   body: client_id=ln&supports_org_scope=true
// POST {lo}/auth/device/token  grant_type=urn:ietf:params:oauth:grant-type:device_code
// refresh: 同一端点，grant_type=refresh_token
```

实测握手：

```
POST https://opencode.ai/console/auth/device/code
  → 200 {"device_code":"…","user_code":"SNDF-LJTG",
         "verification_uri_complete":"/console/device?user_code=…&client_id=opencode-cli",
         "expires_in":600,"interval":5}

POST https://opencode.ai/console/auth/device/token   （还没授权时）
  → 400 {"_tag":"DeviceTokenError","error":"authorization_pending"}

用户授权后同一个端点返回
  → 200 {"access_token":"…","refresh_token":"…","expires_in":…,"org_id":"…"}
```

三个容易踩的点：

1. `verification_uri_complete` 是**相对路径**，要用 `https://opencode.ai/console/` 去
   `new URL(...)` 解析 —— 官方 CLI 就是这么做的；
2. 未授权是 **HTTP 400** + `error: 'authorization_pending'`，属**正常中间态**，不是失败；
3. access token 会过期，用 refresh token 续；续到的新值**必须落盘**
   （走 `AdapterContext.onCredentialsRefreshed`），否则重启要重登。

## 1.8 另外两条通道（同一份指纹都能过）

| 通道 | base | 备注 |
|---|---|---|
| `/inference/v1/chat/completions` | `https://opencode.ai/inference/openai/v1` | 插件默认 |
| `/zen/v1/chat/completions` | `https://opencode.ai/zen/v1` | opencode2api 优先用这条（更宽松） |

两条都用同一套指纹通过（实测）。切通道只要改 `upstream.chatBaseUrl`。

## 2. 两条必须如实说清的事实

### 2.1 opencode.ai 官方 Console **没有每日签到**

官方文档里没有签到，Console API 里也没有签到端点。签到/积分这套玩法是
**国内反代平台**（把 opencode 能力再包一层的上游）的常见形态。

**本插件的做法**：

- 把签到路径做成可配的 `upstream.checkInPath`；
- 没配就去**探测**几个常见路径（`/api/user/checkin`、`/api/user/sign`、
  `/api/v1/checkin`、`/user/checkin`）；
- 都探不到 → 返回 `{ supported: false, message: '「OpenCode」的上游没有「每日签到」接口（这不是故障）' }`。

**绝不伪造一个假的签到** —— 那会让用户以为领到了积分。

### 2.2 官方 **没有活动任务** 接口

同理。`upstream.tasksPath` / `taskClaimPath` / `taskStatusPath` 可配（后两个支持
`{taskId}` 占位），探测不到就返回空列表 + 一句原因。

### 2.3 额度接口需要 **All 权限** 的 key

Inference-only 的 key 打 `/api/v1/budgets/members` 会 **403**。这时本插件：

- 额度显示「未知」（不是 0）；
- `error` 写清原因：「这个 key 没有「All」权限，读不到预算数据。到 OpenCode Console →
  Keys 给该服务账号开「All」权限，或在配置里填 upstream.quotaPath 指向你的上游额度接口。」

多成员时返回**工作区合计**（限额之和 − 已用之和）；有成员没有限额（`null`）时标 `unlimited`。

## 3. 模型价格的换算

证据（真实 `models.dev` 记录，截断）：

```json
{
  "id": "big-pickle",
  "name": "Big Pickle",
  "description": "Reasoning model for deliberate analysis, multi-step problem solving, and tool use",
  "reasoning": true,
  "interleaved": { "field": "reasoning_content" },
  "modalities": { "input": ["text"], "output": ["text"] },
  "limit": { "context": 200000, "input": 160000, "output": 32000 },
  "cost": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 }
}
```

关键点：

- **`interleaved.field = "reasoning_content"`** —— 思维链就在 delta 的这个字段里。
  本插件的 SSE 解析器按 `reasoning_content → reasoning → thinking → analysis`
  的顺序取第一个非空的（见 `src/core/sse.ts` 的 `REASONING_KEYS`）。
- `cost.input`/`cost.output` 是**美元 / 百万 token**；
- 免费模型 `cost` 全 0 → `free: true` → 选择器里显示「免费」。

倍率口径见 [`MODELS.md`](MODELS.md#4-倍率标签格式与口径)。

## 4. `/inference/v1/models` 的返回形状

**只有 4 个字段**（实测）：

```json
{ "id": "big-pickle", "object": "model", "created": 1792160902, "owned_by": "opencode" }
```

**没有显示名、没有价格、没有上下文长度。** 所以：

- 显示名与价格必须走 `models.dev`（或该账号的 Console 配置）；
- 两层都拿不到时，显示名从 id 猜（`prettifyModelId()` 带一份品牌大小写词典，
  免得 `deepseek` 被拼成 `Deepseek`），价格字段留空 → UI 显示「未知倍率」。

## 5. 用反代平台时改什么

国内常见的 opencode 反代会把 `/inference/...` 换成自己的地址，并加上签到/额度/任务接口。
在 Agent 标签页里改这几项即可（**不要改代码**）：

| 配置项 | 例子 |
|---|---|
| `upstream.chatBaseUrl` | `https://your-proxy.example/v1` |
| `upstream.apiBaseUrl` | `https://your-proxy.example` |
| `upstream.modelsUrl` | 可留空（留空回退官方；反代通常也有 `/v1/models`） |
| `upstream.checkInPath` | `/api/user/checkin` |
| `upstream.quotaPath` | `/api/user/self` |
| `upstream.tasksPath` | `/api/user/tasks` |
| `upstream.taskClaimPath` | `/api/user/tasks/{taskId}/claim` |
| `upstream.taskStatusPath` | `/api/user/tasks/{taskId}` |

`quotaPath` 的响应体解析是**通用**的（`parseGenericQuota()`），认这些形状：

```json
{ "data": { "quota": 100, "used_quota": 40 } }      // 常见的一种
{ "data": { "remaining": 60 } }
{ "balance": 12.5 }
{ "unlimited": true }
{ "credits": 500 }
```

## 6. 探测行为

`discoverCapability()` 在没配置路径时挨个试候选，**第一个非 404 的算命中**，
结果缓存 6 小时（`ctx.cache`）。命中与未命中都会写一条 info/debug 日志 ——
「没探到」这件事也能在日志里看到，不是静默的。

## 7. 改动这一份文档的规矩

改 OpenCode 适配器时，如果发现上面某条**与事实不符**：

1. 先用真实请求复核（`curl` 或 `node -e`）；
2. 改**代码**，再改**这一份文档**；
3. 如果复核结果是「端点不存在」，**不要**在文档里写「大概有」——
   写「不存在」并说明探测与降级路径。
