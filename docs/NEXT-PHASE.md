# 下一期实现清单

本文件记录**本期刻意没做**的东西，以及做它们需要的具体条件。写清楚是为了下一次
不用重新调研一遍。

> **有 bug 先看 [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md)**。那里是「要修的」，
> 本文件是「没做的」「做了一半的」。别把待修问题记到这里。

---

## 1. Qoder / Qoder CN（**已完成**，见下）

Qoder 的对话走加密端点，必须带 WASM 生成的签名：

```
Authorization: Bearer COSY.<载荷>.<签名>
```

用普通 `Bearer <access_token>` 会直接 `403 Signature invalid (101)`；模型目录也是
加密的。实现方式：把参考实现（`dsh-our-free-model`，MIT，<https://github.com/Ebony-Vinyl/dsh-our-free-model>）的
`qoder-wasm.ts` / `qoder-machine.ts` / `qoder-product.ts` / `qoder-envelope.ts` /
`qoder.ts` 与 `qoder-auth-wasm.wasm`（298 KB）**原样**搬进 `src/vendor/qoder/`，
本插件只写一层薄适配器（`src/adapters/qoder.ts`）。

> 这份参考实现也是 Qoder 的**行为口径来源**（MIT，可放心照抄结论）：
> 倍率怎么随错峰窗口变（`qoderDisplayName` / `promotionActiveNow`）、
> uid 为什么必须单独存（`ensureUid`）—— 见 KNOWN-ISSUES #0i / #0j 与 MODELS.md §5.6。
> 本地副本：`E:\AIProject\DeepSeekPlugin\.scratch\dsh-our-free-model\`
> （**在仓库外**，不会被提交；需要时重新 clone 即可）。

搬运时改了两处（都写进了文件注释）：

| 改动 | 原因 |
|---|---|
| `QoderEncryptedInfer` 的**参数属性**改成显式字段赋值 | 参数属性是**不可擦除**语法，本插件用 `stripTypeScriptTypes` 剥类型构建，会直接报错 |
| 去掉 `import { LlmError } from '@deepseek-ai/dsh-llm'` | 那是**宿主**的包，本插件不依赖它；全文件只用它抛一条错误，换成普通 `Error` 语义不变 |

`scripts/build.mjs` 增加了 `.wasm` 资产复制（WASM 桥按 `import.meta.url` 找同目录的
wasm 文件，所以必须跟到 `lib/`）。

**验收**：`QoderEncryptedInfer.create()` + `prepareInfer()` 能产出
`https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?...`
与 `Bearer COSY.<载荷>.<签名>`，并带 20 个 `Cosy-*` 身份头（已固化为单测）。

**边界**：模型目录用产品兜底表（加密目录解密未接）；签到/额度未接；
凭证需要 `security_oauth_token`（JWT，内含 `user_id`），缺 uid 时在发请求前就报错，
不让用户对着 403 猜。

---

## 2. Trae（协议层已实现，默认隐藏）

适配器可运行（模型目录 / 签到 / 余额 / 流式对话），但**本机没有 Trae 账号、一次真上游
都没打过**，所以 `visible: false`，界面上不出现 —— 不把没验证过的东西摆给用户。

真机验证通过后，把 `trae` 加进 `src/config.ts` 的 `DEFAULT_VISIBLE_AGENTS` 即可显示，
别处不用改。

---

## 3. 本地 OpenAI 兼容网关（后续计划）

目标：起一个本地端点，让 Cursor / VS Code / 任意 OpenAI SDK 也能用上这些账号与免费模型。

- `POST /v1/chat/completions`（流式，复用现有 `core/router.ts` 与各适配器）
- `GET /v1/models`（复用现有模型目录与上报策略）
- 端口可配、默认只绑 `127.0.0.1`，加一层本地 key，防止同机其他程序白用
- 参考实现另有局域网中继与密钥轮换，按需再做

前置条件基本就绪：路由、六个适配器、SSE、额度与降权都在，缺的只是外面的 HTTP 层。

---

## 4. WorkBuddy / CodeBuddy 的签到与额度（已完成）

已接：签到、余额、模型目录、流式对话。国际版上游确实没有签到接口，如实回报「不支持」。

---

## 5. 界面

本期已完成五页（总览 / 账号 / 任务 / 日志 / 设置）。还没做的：

- **页面切换的记忆**：现在刷新回到「总览」，可以像参考实现那样存 localStorage；
- **热力图 / 趋势曲线**：日志页已有明细表，图表是锦上添花；
- **请求日志的自动刷新开关**：现在只能手动刷新。

---

## 6. 版本更新

已实现：设置页「版本更新」卡片 → `git fetch` 比对 → 一键 `git pull --ff-only`。

边界（刻意如此）：

- **只支持 git 检出**。npm 安装或 `link:` 但没有 `.git` 的目录会明确回报
  `supported: false`，并提示用 `dsh plugin add` 重装 —— 不假装能更新；
- **`--ff-only`**：本地有未提交改动或历史分叉时**拒绝**更新，不覆盖用户的东西；
- 更新完**必须重启 DSH**：宿主在启动时加载 `lib/`，换磁盘文件不会让已加载的
  模块重新执行。卡片上会显示这句提示。

---

## 7. 界面改版后剩下的尾巴（2026-10-18）

这一轮把 client 半边整体重写成「投影 → HTML 字符串 + 事件委托」，界面对齐原型
（[`docs/prototype/app.html`](prototype/app.html)），并删掉了用不上的东西。仍待办：

### 7.1 宿主端的 addAccount / setCredentials 端点还留着

界面已经**没有**「手动填 token / cookie」的入口 —— 所有账号都走登录流程。
但这两个 Remote 端点仍在（src/index.ts），保留的原因是程序化使用（脚本 / 工具）
仍可能需要。要不要彻底删掉，等有人确认「只用登录」之后再定。

### 7.2 外链登录的自动轮询只在代码层面改过，没有真机验证

startLogin 现在对设备码与外链两种形态**都**排自动轮询（原型要求）。代价是
WorkBuddy / Qoder 的 /auth/token?state= 会被每 5 秒问一次，最长问到过期。
需要一次真人登录确认：
1. 授权完成后 3～5 秒内界面自己变绿；
2. 过期后停在 expired 而不是无限轮询。

### 7.3 Trae 已实现但默认隐藏

适配器已实现（模型目录 / 签到 / 余额 / 流式对话），但尚无真机验证，所以 `visible: false`。
真机验证通过后加进 DEFAULT_VISIBLE_AGENTS 即可显示。

### 7.4 模板预览只有浅色

scripts/preview.mjs 用固定的 14 个 token 浅色值渲染。深色主题下是否协调，
只能靠真机看 —— 真机检查清单：边框、次要文字、「浅色底 + 状态色」的徽章。
