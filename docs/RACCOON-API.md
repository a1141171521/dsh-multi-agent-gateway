# 商汤小浣熊（Raccoon Office）反代说明

**目标客户端**：商汤小浣熊 `1.1.3`（Electron，包名 `@raccoon/office-desktop`，
`clientName: raccoon-work`）。

本文记录**从客户端产物里读出来的协议事实** + **本机真打验证的结果**。
每一条都标了出处；没有出处的不写。

> ⚠️ 阅读顺序建议：先看「四条被否掉/纠正的假设」，那是省时间的部分 ——
> 它们看起来都像对的，实测全不对。

---

## 1. 端点与鉴权

站点根 `https://xiaohuanxiong.com`（客户端 `.env.electron` 的
`NEXT_PUBLIC_API_URL`；也是 `hostedGateway.ts` 的兜底 origin）。

| 用途 | 端点 | 鉴权 | 实测 |
|---|---|---|---|
| 对话（OpenAI 兼容 SSE） | `POST /api/web/llm/v2/chat/completions` | Bearer | 200 `text/event-stream` |
| 模型目录 | `GET /api/web/llm/v2/model_catalog` | Bearer（**要**） | 200，10 个模型 |
| 积分余额 | `GET /api/web/points/v1/balance` | Bearer | 200 |
| 积分流水 | `GET /api/web/points/v2/bills?paging.limit=N&type=all` | Bearer | 200 |
| 登录积分发放 | `POST /api/web/desktop/v1/login/points/grant` | Bearer | 200 `{granted, popup}` |
| 账号信息 | `GET /api/web/auth/v1/user_info` | Bearer | 200 `{id, name, phone}` |
| 图片生成 | `POST /api/web/llm/v2/images/gen` | Bearer | 未接 |

出处：
- `dist/electron/main.cjs` L154：`var UPSTREAM = "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions"`
- `build/electron/main/client/models/hostedModels.js` L13：`CATALOG_ENDPOINT = '/api/web/llm/v2/model_catalog'`
- `build/electron/main/client/models/hostedModels.js` L131：`remoteBaseUrl: \`${origin}/api/web/llm/v2\``
- 积分三个端点来自 asar 里的 `class ... extends a.nC { static get baseUrl(){ return \`${hj()}/api/web/points\` } ... }`
  （`POINTS_SERVICE`，`getBalance()` → `/v1/balance`，`getBills()` → `/v2/bills`）
- `login/points/grant` 来自 Cloud 首页的 `useEffect`（登录后弹「积分到账」）

鉴权头：`Authorization: Bearer <access_token>`，token 是 IAM JWT
（`iss: xiaohuanxiong.com/iam`，`sub: pu-xxx`，有效期**30 天**）。

---

## 2. 四条被实测否掉/纠正的假设

前三条都是从客户端源码里**看起来**成立的推断，真打之后全错；
第四条是抓包之后纠正了**本文档上一版自己的结论**。

> 第四条（`user-agent`）尤其值得看 —— 它说明「只读代码得出的指纹结论」
> 可以对一半、错一半，成因写在那一节末尾。

### ① `X-Client-*` 请求头**不是**必需的

客户端有一套指纹头（`build/shared/client/requestHeaders.js` 的
`buildClientHeaders`）：

```
X-Client-Name: raccoon-work
X-Client-Platform: desktop-windows
X-Client-Version: 1.1.3
X-Client-Page: background
```

看起来像「必须来自客户端」。实测四种组合：

| 请求头 | 结果 |
|---|---|
| 只带 `Authorization` | **200** |
| `Authorization` + 真指纹 | 200 |
| `Authorization` + 假指纹（`probe` / `linux` / `0.0.1`） | 200 |
| 只带指纹、不带 `Authorization` | **401** `authorization_empty_error` |

⇒ 上游**没有**按这套头做门禁。但「不需要」不等于「可以到处乱发」——
全仓查实际使用点，这套头只出现在两类请求上：

| 客户端请求 | 带 `X-Client-*` 吗 |
|---|---|
| 内容检测 `build/electron/main/security/safetyReview.js` | 带（`clientRequestHeaders()`） |
| 手机互联 `desktopTrustedDeviceApi` / `pairingApi` / `httpsDesktopRelayApi` | 带 |
| 模型目录 / 积分余额 / 账单（`fetchWithAuth`） | **不带** |
| 网页端登录积分发放 `login/points/grant` | **只带** `X-Client-Platform` + `X-Client-Version` |

⇒ 所以本适配器**按端点分别对齐**：只在 `checkIn` 带那两个头，其余端点一个都不带。
「为了像客户端就把四件套全发出去」恰恰不像客户端——在客户端不发的端点上多发一套就是。

### ④ `user-agent`：两边都是 `node`，但我们的非对话路径原来在自报家门

这条是后来抓包才发现的，**原先的结论是错的**。

客户端 JS 侧的请求走 Electron 主进程的全局 `fetch`（undici），而 undici 在
调用方没给 UA 时补的是字面量 `node`。用**它自己安装目录里的那个 exe**
（`ELECTRON_RUN_AS_NODE=1 商汤小浣熊.exe`，Node 24 / Electron 41）向本地捕获
服务器发一次，抓到的就是这个：

```
### /via-global-fetch          ← 官方客户端那套栈
  accept: */*
  accept-encoding: gzip, deflate
  accept-language: *
  authorization: Bearer CLIENT-STACK-PROBE
  connection: keep-alive
  content-type: application/json
  sec-fetch-mode: cors
  user-agent: node
```

而本插件：

| 路径 | 走的实现 | 修之前的 UA | 修之后 |
|---|---|---|---|
| 对话（裸 `fetch`） | undici | `node` ✅ 本来就一致 | `node` |
| 额度 / 目录 / 签到 / 测活（`ctx.http`） | `core/http.ts` | **`dsh-multi-agent-gateway/0.2.2`** | `node` |

`core/http.ts` 那个默认 UA 是给自家排查用的合理默认，但落到这条链路上，等于
**向网关点名「我是一个叫 dsh-multi-agent-gateway 的第三方反代工具，版本 0.2.2」**——
比官方客户端那句朴素的 `node` 醒目得多。修法：适配器显式设
`user-agent: node`（`RACCOON_USER_AGENT`）。

> ⚠️ 这个坑的成因值得记一句：**同一个插件里两条 HTTP 路径的默认 UA 不一样**。
> 只读代码（或只抓一条请求）都会得出片面的结论——看 `headersOf` 会觉得
> 「我们什么都不发，那两边都是 `node`」，实际只有对话那一边是。
> 要判断发了什么，只能抓包。

### 关于「能不能不被风控」——如实说：不能保证

改头只是把**一眼可见的第三方标记**拿掉。真正决定会不会被风控的是**行为**，
其中一条还是结构性的、伪装解决不了：

| 风险面 | 说明 | 能做的 |
|---|---|---|
| **同一个 token 两个栈** | 插件与官方客户端共用同一账号、同一出口 IP。同时用就是「一个账号、两套不同 HTTP 栈交错发请求」——**这不是改头能消除的** | 别把插件和客户端当两路并发流量一起压 |
| 请求节奏 | 人有间隔，脚本可以秒级连发 | `rateLimitPerMinute`（默认 60/账号）、`gateway.maxConcurrentRequests`（默认 4）比头重要得多 |
| 请求形态 | DSH 每轮重发整段会话历史 + 自己的工具集，长度与工具形状都和官方 agent 不同 | 无法对齐，只能靠别高频 |
| 消费曲线 | 跑付费模型是**真扣用户积分** | 默认 `models.mode: 'free'` 只上报 ×0 的三个模型，正好避开这条 |

已经做进去的减害项：`coversToday: true` 让签到**不会**当天反复打；
`risk_control` 独立分类 + 30 分钟冷却 + **不对同号重试**。

**还有一处对不齐，且没抓到样本**：官方客户端的**对话**请求其实不是
这个 Electron 进程发的，而是 `box-agent-acp.exe`（PyInstaller 打的 Python 包，
内含 `httpx` + OpenAI/Anthropic SDK）。它的 UA 与 `x-stainless-*` 由 Python 那套栈
决定。所以「对话请求与官方逐字节相同」这句话**不成立**，别这么写。
要抓到它，得改客户端的 `api_base` 指到本地并驱动它发一轮。

### ② `X-Org-Code` 不能乱发

客户端在 `office_identity === 'personal'` 时**根本不发**这个头
（`hostedModels.js` L25-29 的三元表达式）。手工塞 `X-Org-Code: personal`：

```
400 {"code":200022,"message":"org_not_found_error","details":"org not found"}
```

⇒ 个人账号一律不带。企业账号才需要，且值应当是真实的 `org_code`。

### ③ `stream_options.include_usage` 不需要

客户端两种写法都有（它自己的 `hostedModels` 不带，别的路径带）。实测带与不带，
最后一帧 `usage` 都在，`completion_tokens_details.reasoning_tokens` 也在。

⇒ **不发这个字段**。少一个字段就少一份上游改协议时被 400 的面。

---

## 3. 报文形状

### `model_catalog`

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "categories": [
      {
        "type": "chat",
        "default_model": "raccoon-8c4485",
        "models": [
          {
            "name": "sn-deepseek-v4-1-flash-1017",
            "description": "DeepSeek-V4.1-Flash",
            "visible": true,
            "billing_category": "normal",
            "model_name": "sn-deepseek-v4-1-flash-1017",
            "display_description": "适合通用对话、代码开发、复杂分析和推理任务",
            "tags": ["general", "code", "html", "analysis", "reasoning", "auto"],
            "ability_level": 3,
            "params": { "context_window": 1000000, "max_tokens": 100000 },
            "billing_multiplier": 0,
            "billing_effective_multiplier": 0,
            "billing_status": "normal",
            "billing_status_note": "",
            "billing_discounts": []
          }
        ]
      }
    ]
  }
}
```

**倍率取 `billing_effective_multiplier`（实付）而不是 `billing_multiplier`（标价）**
—— `sn-glm-5-3` 上两者是 `1` vs `0.75`，只有实付能回答「这一轮扣多少」。

`billing_effective_multiplier === 0` **真的免费**（`sn-deepseek-v4-1-flash-1017`、
`sn-sensenova-6-8-flash`、`sn-sensenova-6-8-flash-lite`）。
字段**缺失**才是「未知倍率」—— 两者在界面上的画法完全不同（`免费` vs `未知倍率`）。

`visible: false` 的三个 `raccoon-*` 是**官方客户端隐藏的内部自动路由档**，
但仍然可调（逐个实测 200）。本适配器照常上报，只在描述里标注。

### 本机实测的 10 个模型（2026-10-27）

| id | 实付倍率 | 思维链 | 上下文 |
|---|---|---|---|
| `sn-deepseek-v4-1-flash-1017` | **×0**（免费） | 有 | 1,000,000 |
| `sn-sensenova-6-8-flash` | **×0**（免费） | 有 | 256,000 |
| `sn-sensenova-6-8-flash-lite` | **×0**（免费） | 有 | 256,000 |
| `sn-glm-5-3-flash` | ×0.2 | 有 | 1,000,000 |
| `sn-deepseek-v4-1-flash` | ×0.25 | 有 | 1,000,000 |
| `sn-glm-5-3` | ×0.75 | 有 | 1,000,000 |
| `sn-kimi-k3` | ×1 | 有 | 1,000,000 |
| `raccoon-8c4485`（隐藏档） | ×1 | **无** | 1,000,000 |
| `raccoon-19b265`（隐藏档） | ×1 | **无** | 1,000,000 |
| `raccoon-405a1c`（隐藏档） | ×1 | **无** | 1,000,000 |

> 思维链那一列**按实测填**，不按 `tags` 猜：`sn-sensenova-6-8-flash` 的 tags 里
> 没有 `reasoning`，但它**会**吐 `reasoning_content`；`raccoon-*` 的 tags 里有
> `reasoning`/`analysis`，实测思维链**恒为 0**。

### `chat/completions`

标准 OpenAI 兼容流。首帧只带 `role`，正文在 `delta.content`，
思维链在 `delta.reasoning_content`，工具调用是标准 `delta.tool_calls`，
末帧 `delta:{}` + `usage`，最后 `data: [DONE]`。

```text
data: {"id":"chatcmpl-1","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
data: {"id":"chatcmpl-1",...,"choices":[{"index":0,"delta":{"reasoning_content":"需要查天气"}}]}
data: {"id":"chatcmpl-1",...,"choices":[{"index":0,"delta":{"content":"我是"}}]}
data: {"id":"chatcmpl-1",...,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: {"id":"chatcmpl-1",...,"choices":[{"index":0,"delta":{}}],"usage":{"completion_tokens":93,"prompt_tokens":34,"total_tokens":127,"completion_tokens_details":{"reasoning_tokens":71}}}
data: [DONE]
```

工具调用实测可用（含**多轮**：第二轮带 `role: 'tool'` 回填后正常收尾）：

```text
finish_reason: "tool_calls"
tool_calls: [{"index":0,"id":"call_00_...","function":{"name":"get_weather","arguments":"{\"city\": \"Beijing\"}"}}]
```

视觉：`sn-deepseek-v4-1-flash-1017` 接受 `image_url` data URI（200）；
`sn-glm-5-3` 同请求 **400**（`rejected by an internal MaaS component`）。
所以只对实测通过的模型标 `inputModalities: ['text','image']`，**不按 tag 猜**。

---

## 4. ⚠️ usage 帧比 finish 晚 0.5–3.7 秒

这是本平台**最反直觉**的一条，也是唯一需要改动核心层的地方。

本机 8 次采样：

| 模型 | finish → usage 间隔 |
|---|---|
| `sn-deepseek-v4-1-flash-1017` ×6 | 472 / 1421 / 1970\* / 2315 / 2515 / 3418 / 3709 / 3744 ms |
| `sn-sensenova-6-8-flash-lite` | 3418 ms |
| `raccoon-8c4485` | 1970 ms |

（\* `raccoon-8c4485` 那次）最小 472ms，最大 3744ms，**均值 ≈ 2.4s**。

对比 Qoder 只晚 **17ms**。原来的 `USAGE_DRAIN_MS = 250` 是给 Qoder 那类平台调的，
用来等小浣熊等于**永远等不到** —— 症状就是日志里「输入 / 输出 / 速度」三列恒为 `—`
（这个缺陷用户报过一次）。

**修法**：窗口下放到 `AgentCapabilities.usageDrainMs`，由适配器声明自己上游的形状。
小浣熊声明 `5000`（实测最大值 + 三成余量），其余平台继续用默认 250ms。
不能全局抬到 5s —— 那会让所有快平台**每一轮**收尾都多挂最多 5 秒。

---

## 5. 登录：本机回环 + 授权码（与客户端同一条路）

客户端用的是**标准授权码 + 本机回环重定向**（`build/electron/main/client/account/webLogin.js`
/ `webLoginLoopback.js`）：`/authorize` 上带 `state` 与 `redirect`，回调打到
`127.0.0.1:<随机端口>`，再用 code 换 token。这就是 RFC 8252 给原生应用定的那套，
**不需要 client_secret，谈不上伪造**。

> ⚠️ 本文第一版写的是「没有公开的 OAuth 端点 → 硬造就是伪造客户端 → 只能读 auth.json」。
> **那个判断是错的**：把「没有设备码」当成了「没有可用授权方式」。2026-10-28 真机验通后改掉。

### 5.1 三步

1. 起一个**只绑 `127.0.0.1`** 的临时服务，端口交给系统分配（客户端自己也是 `listen(0)`，所以服务端必须接受任意回环端口）；
2. 打开
   `https://xiaohuanxiong.com/authorize?login_source=desktop&appname=商汤小浣熊客户端&desktop_callback=loopback&state=<64 hex>&redirect=http://127.0.0.1:<port>/auth/callback`；
3. 用户在浏览器登录 → 带 `?code=&state=` 跳回来 → `POST /api/web/auth/v1/login_with_authorization_code {authorization_code}` 换令牌。

**两个参数少一个就废**：`login_source=desktop`、`desktop_callback=loopback`。
少了后者，服务端按自定义协议 `office-raccoon://` 那条路处理，回调**只回 state 不回 code**，
浏览器停在「缺少 code」（第一次探针就是这么失败的）。

`state` 必须服务端随机生成、回调时**逐字节比对**（先比长度再 `timingSafeEqual`，
否则长度不等会让它抛 `RangeError`）。

### 5.2 兜底：仍然认客户端的 auth.json

回环起不来时（端口被禁 / 沙箱不允许 listen）退回老路：打开 `/login`，读客户端写的文件。
插件**只读**，不写不改。候选路径（按序）：

```
$BOX_AGENT_CONFIG_DIR/auth.json
$BOX_AGENT_HOME/config/auth.json
~/.office-raccoon/agent/config/auth.json   ← 本机实际位置
~/.box-agent/config/auth.json
```

出处：`build/electron/main/agent/boxAgentProfilePath.js` 的 `resolveBoxAgentHome`
+ `boxAgentAuthFile.js` 的 `getBoxAgentAuthPath`。客户端写文件时自己会
`mkdirSync(recursive)` 建目录、写完 `rename`；**插件永远不会创建这个目录**。

### 5.3 ⚠️ 续期仍然是 30 天

令牌是 **IAM JWT，有效期 30 天**。`auth.json` 里没有 `refresh_token`；
而授权码接口**返回的 `refresh_token` 与 `access_token` 一字不差**（实测：两者都 432 字符、同值），
拿它打 `/api/web/auth/v1/refresh` 只会原样换回同一个令牌、`exp` 不变。

⇒ **没有可用续期**。到期重新登录一次 —— 现在是一次点击，不是手工贴 token。

### 5.4 实测记录（2026-10-28）

```
GET /authorize?...desktop_callback=loopback&redirect=http://127.0.0.1:<port>/auth/callback
  → 登录 → 回环收到 ?code=<46 字符>&state=<64 字符>
  → POST /api/web/auth/v1/login_with_authorization_code
     HTTP 200  {"code":0,"data":{"access_token":"<432>","refresh_token":"<432，同值>"}}
  → GET /api/web/points/v1/balance  HTTP 200
```

---

## 6. 签到 = 登录积分发放

`POST /api/web/desktop/v1/login/points/grant` 返回：

```json
{"code":0,"message":"success","data":{"granted":true,"popup":{...}}}
{"code":0,"message":"success","data":{"granted":false,"popup":null}}
```

客户端每次启动都会 POST 一次（Cloud 首页的 `useEffect`），服务端自己保证幂等。

本适配器的判定：

| 上游返回 | 插件结论 |
|---|---|
| `granted: true` | `ok: true` + `coversToday: true`（真领到了） |
| `granted: false` | `ok: false` + `supported: true` + `coversToday: true`（今天没有可领的，重试不会变） |

**`granted: false` 不报 `ok: true`** —— 没领到就是没领到，谎报会让用户以为积分到账了。
但也不报「故障」：上游有这个接口，只是今天没东西可领。

> `popup` 在 `granted: true` 时的形状**没有实测样本**（本机今天已领过）。
> 所以 `describePopup()` 只做防御式提取（字符串直接用 / 对象里找 `title`/`message` 等），
> 认不出就不带，**绝不 `String(popup)`**（那会把 `[object Object]` 糊到界面上）。

---

## 7. 错误码

| HTTP | `code` | `message` | 分类 |
|---|---|---|---|
| 401 | `200001` | `authorization_empty_error` | `auth` |
| 401 | `200002` | `authorization_invalid_error` | `auth` |
| 401 | `200003` | `authorization_verify_error` | `auth` |
| 400 | `200020` | `org_code_empty_error` | `bad_request` |
| 400 | `200022` | `org_not_found_error` | `bad_request` |
| 400 | `100001` | `params_empty_error` | `bad_request` |

⚠️ **业务码与 HTTP 状态码是两套东西**：所有鉴权失败都是 `HTTP 401 + code 2000xx`，
但同一个 `code` 也可能出现在 `HTTP 200` 的响应体里（客户端代码里
`payload?.code !== 0` 就抛错）。所以判据顺序是**先认业务码**，认不出再交给
核心的 `classify()`（按状态 + 文案）。

### `reasoning_effort` 的枚举是硬校验的

非法值的 400 原文：

```
Failed to deserialize the JSON body into the target type:
reasoning_effort: unknown variant `off`, expected one of
`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`, `max`
```

这 8 个值与 `core/reasoning.ts` 的 `CANONICAL_REASONING_EFFORTS` **完全同集**
（只是顺序不同）⇒ 本平台的档位翻译是**恒等映射**，不需要 `light`/`on` 那类私有 id 的落位。

> ⚠️ 这个 400 是**请求体反序列化**阶段报的，发生在模型路由**之前** ——
> 所以它只证明「**参数**被全局接受」，**不能**推出「每个模型都会因此改变行为」。
> 实测同一个值在不同模型上效果差异很大（`sn-deepseek` 上 `max` 的思维链明显更长，
> `raccoon-*` 上压根不吐思维链）。所以 `reasoningEfforts` 对所有模型如实声明这 8 档，
> 而 `reasoning`（会不会吐思维链）按实测逐模型给。

### ⚠️ 一个未解的现象：`reasoning_effort` 的非法值偶尔放行

同一个非法值（`off` / `bogus`）连发多次，结果是**不确定**的：
有时 400（serde 枚举），有时 200。**未定位原因**（猜测是网关多副本、校验严格度不同）。

这不影响本适配器：我们只发那 8 个合法值。但**不要**据此认为「非法值也能用」——
它是偶发的，而失败的那一半是**整轮对话 400**。

---

## 8. 复现这些结论

```powershell
# 单测（不打网络，用真报文 fixture）
node --test test/adapters/raccoon.test.mjs

# 真机活体（需要本机装了客户端并登录过）
node test/live-raccoon.mjs
```

`test/live-raccoon.mjs` 会真打：目录、余额、签到、流式文本、工具调用，
以及**经 DSH LLM 适配器装配链路**跑一轮（含请求日志采样断言）。
