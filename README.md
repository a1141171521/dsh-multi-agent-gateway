# dsh-multi-agent-gateway

**DSH 的多 Agent 通用 API 反代网关 Provider 插件。**

一个插件管起所有「AI Agent 平台」的账号：统一账号管理、每日签到、额度/积分拉取、
活动任务自动执行、多账号智能路由；同时把各平台的模型**按 Agent 分组**上报到 DSH
对话框的**原生模型选择器**，并在每个模型名后标注**积分消耗倍率**。

不是独立 Nginx，也不是外部代理进程 —— 请求全部在插件内部转发，账号凭证只存在本机。

## 界面：五页 + 浏览器登录

设置页现在是**独立一页**（设置 → 多 Agent 网关），内部按「你此刻要回答的问题」分五页：

| 页 | 回答什么问题 |
|---|---|
| **总览** | 现在健康吗？刚才那条花了多少？ |
| **账号** | 这个平台有哪些账号 / 模型？ |
| **任务** | 签到和活动任务跑得怎么样？ |
| **日志** | 刚才那次为什么失败？ |
| **设置** | 那些不常动的东西（含版本更新） |

**添加账号不用手抄 token**：账号页点「打开登录页」→ 浏览器里完成平台登录 → 回来点
「刷新登录状态」→ 插件自己去换 token 并建账号（token 不经过浏览器，加密落盘）。

| 平台 | 登录形态 |
|---|---|
| OpenCode | 设备码（显示 user_code，前端自动轮询） |
| WorkBuddy / 国际版 | 外链（`auth/state` → 打开登录页 → `auth/token?state=`） |
| Qoder / Qoder CN | 设备码 + PKCE |

> 外链形态**不自动轮询** —— 用户可能在浏览器里待几分钟，后台一直打上游纯属浪费。

**模型表**按「免费 → 厂商 → 倍率」排序，默认勾选免费模型（没有免费就全不勾），
每行可单独改上下文长度、可单独「测一次」，状态列显示 可用 / 地区受限 / 不可用 / 未探测。

## 💬 DeepSeek Harness 插件交流群

欢迎加入 **DeepSeek Harness 插件交流 QQ 群**——插件开发、模型接入、推理档位、
第三方厂商配置等话题都可以在这里交流，本插件的问题与建议也欢迎直接进群反馈：

> ## 🐧 QQ 群号：`1105449571`
>
> 打开 QQ → 搜索群号 **1105449571** 即可加入（进群请备注「dsh 插件」）

群内可交流：插件开发经验、模型接入与档位配置、DSH 使用技巧、新功能需求投票等。

---

## 它解决什么

| 你现在的麻烦 | 这个插件怎么办 |
|---|---|
| 有 5 个平台、十几个账号，每个平台一套登录/签到/查额度 | 一个配置页全管起来，按 Agent 分组 |
| 某个号限流了 / 额度用完了，会话当场报错 | 同 Agent 内自动换号重试，用户无感 |
| 每天要手动去点签到、领活动任务积分 | 定时任务自动跑，流水可查 |
| 模型下拉里一堆同名模型，看不出哪个贵 | 按 Agent 分组，后面缀 `(×2)` / `(免费)` |

## 支持情况

| Agent | 状态 | 签到 | 额度 | 模型 | 活动任务 | 对话 |
|---|---|---|---|---|---|---|
| **OpenCode** | ✅ 完整实现 | 取决于上游¹ | ✅ | ✅ | 取决于上游¹ | ✅ 流式 + 思维链 |
| Qoder | 🧩 骨架 | — | — | — | — | — |
| Qoder CN | 🧩 骨架 | — | — | — | — | — |
| Trae | 🧩 骨架 | — | — | — | — | — |
| WorkBuddy | 🧩 骨架 | — | — | — | — | — |
| WorkBuddy International | 🧩 骨架 | — | — | — | — | — |

> ¹ **opencode.ai 官方 Console 没有签到接口，也没有活动任务接口。**
> 这两项是国内反代平台常见的形态，所以本插件把接口路径做成**可配置**的：
> 你填了 `upstream.checkInPath` / `tasksPath` 就真去调；没填就明确回报
> 「上游没有这个接口（这不是故障）」，**绝不伪造签到结果**。
> 详见 [`docs/OPENCODE-API.md`](docs/OPENCODE-API.md)。

### 「免费模型不要 key」——对，插件做到了**一个字段都不用填**

**不登录、不填 API key、不填凭证** —— 账号卡片里只填一个标签就完事，
模型选择器里选 `OpenCode · xxx (免费)` 直接聊。

为什么以前会 403、现在能过：上游那句 `FreeTierError`（*"can only be used from
within OpenCode"*）是**营销话术**，它实际校验的是**请求形状**。消融实验实测出来的
**过门三件事**：

| 条件 | 去掉会怎样 |
|---|---|
| `stream: true` | **403** —— 免费层只接受流式 |
| 请求里有一个叫 `read` 的工具 | **403** |
| 规范的 `x-opencode-session`（`ses_…` 降序编码） | **403** |

其余（`Authorization`、`x-opencode-request`、`x-opencode-project`）**去掉照样过**。

插件在「账号没有 key」时自动补齐这三样（`upstream.freeTierMode: 'auto'` 默认值），
`stream: true` 本来就是它的固定行为，`read` 工具 DSH 本来就发 —— 所以是真的零配置。
机制细节、实测报文、消融表见 [`docs/OPENCODE-API.md`](docs/OPENCODE-API.md) §1.5–1.6。

**实测证据**（`npm run test:free`）：空凭证账号 → 200 → 正文「收到」+
`reasoning_content` + usage，**全程没有任何 key**。

**边界**：匿名通道**只对免费模型有效**；付费模型在它上面会直接
`401 Missing API key`。要用付费模型就走登录/API key。上游随时可能再改门禁 ——
被拒时错误信息会把那三件事列出来，不会让你瞎试。

**另外**：模型目录完全免凭证，所以模型选择器里的分组与倍率
**一个账号都不加也能显示**，只是发不出请求。

「骨架」= 标准化接口**全部实现**，但默认返回「上游不支持」。语义明确、不静默失败；
填上真实的端点与凭证即可工作。扩展方法见 [`docs/EXTENDING.md`](docs/EXTENDING.md)。

## 快速开始

```powershell
# 1) 装进当前 profile（会自动应用 bundle patch）
dsh plugin --profile desktop add D:\AI\DeepseekPlugin\dsh-multi-agent-gateway

# 2) 重启 DSH 桌面端（客户端 bundle 要重新加载）

# 3) 打开 设置 → 插件 → 多 Agent 网关，填账号
```

详细步骤见 [`docs/INSTALL.md`](docs/INSTALL.md)。

## 文档地图

| 文档 | 内容 |
|---|---|
| [`docs/INSTALL.md`](docs/INSTALL.md) | 安装 / 卸载 / 升级 / 目录结构 / 常见安装问题 |
| [`docs/USAGE.md`](docs/USAGE.md) | 添加账号、看积分、配自动任务、调账号路由 |
| [`docs/MODELS.md`](docs/MODELS.md) | 模型分组与倍率标签是怎么进到 DSH 原生选择器的 |
| [`docs/OPENCODE-API.md`](docs/OPENCODE-API.md) | OpenCode 上游的真实接口事实（含核对过的端点表） |
| [`docs/EXTENDING.md`](docs/EXTENDING.md) | **新增一个 Agent 适配器要写什么**（含完整模板） |
| [`docs/ERROR-HANDLING.md`](docs/ERROR-HANDLING.md) | 账号降级、重试规则、任务失败与熔断 |
| [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md) | **已知问题 / 待修清单**（含验证步骤与排查顺序） |
| [`docs/NEXT-PHASE.md`](docs/NEXT-PHASE.md) | 本期刻意没做的功能，以及做它们需要的条件 |

## 架构（分层模块化）

```
                        ┌──────────────────────── DSH ────────────────────────┐
   对话请求 ──▶ ctx.llm ──▶ src/llm/adapter.ts（每 Agent 一个 provider 路由）
                        │            │                                    │
                        │            ▼                                    │
   模型选择器 ◀───────────│  src/runtime.ts（总装：模型缓存 / 分组 / 倍率标签）   │
                        │            │                                    │
   客户端配置页 ◀─ src/remote.ts ─┼─▶ core/router.ts  多账号路由（换号/降权/恢复）│
                        │            ├─▶ core/scheduler.ts 定时任务管理器    │
                        │            ├─▶ core/tasks.ts  活动任务引擎         │
                        │            └─▶ core/accounts.ts 账号（AES-256-GCM）│
                        │                       │                          │
                        │                       ▼                          │
   工具 ◀────────────────┘            src/adapters/*.ts（每 Agent 一个适配器） │
                        └────────────────────────────────────────────────────┘
```

**新增 Agent 只需要在 `src/adapters/` 加一个文件 + 在 `adapters/index.ts` 加一行。**
核心调度（路由 / 定时 / 任务 / 网关 / UI）一行都不用改。

## 数据落在哪

默认 `<DSH_HOME>/multi-agent-gateway`（`DSH_HOME` 一般是 `~/.dsh`）：

| 文件 | 内容 | 丢了会怎样 |
|---|---|---|
| `.master-key` | AES-256-GCM 主密钥（0600） | **账号密文再也解不开**，要重录 |
| `accounts.enc.json` | 账号与凭证（整份加密） | 要重录账号 |
| `state.json` | 额度缓存、健康、模型缓存、任务游标（明文、无敏感信息） | 重算，无损失 |
| `task-log.jsonl` | 任务执行流水（可删） | 历史记录没了 |

**安全边界（说清楚，不吹）**：密文与密钥分文件，防的是「配置被云同步 / 被 grep 到明文
token / 备份泄露」。它**不是硬件密钥库** —— 能读该目录的本机进程同样能读密钥。

## 开发

```powershell
node scripts/build.mjs      # TypeScript → lib/（零依赖，用 Node 自带的类型擦除）
npm test                    # 单元测试 72 + 客户端契约 15 + 冒烟
node test/live-opencode.mjs # 真机管线：打真实 OpenCode 目录核倍率（需要联网，只读公开接口）
```

改完 `src/` **必须重新构建**（`lib/` 是产物）；改完 `client/` 也要重跑构建，
然后重启 DSH（宿主在启动时扫描 `dsh.client` 声明）。

### 已验证

| 验证 | 结果 |
|---|---|
| `node scripts/build.mjs` | 26 个 TS 文件 → `lib/`，零不可擦除语法 |
| 单元测试 | **72/72** 通过 |
| 客户端契约测试 | **24/24** 通过（端点、描述符、volatile 路径、真 `apply(ctx)`、**无参端点零参数**、真渲染 ModelList） |
| 假宿主冒烟 | 通过（provider 路由 / 5 个工具 / **模型上报策略真的改变选择器内容** / 密文落盘） |
| **真机免费层**（`npm run test:free`，联网） | **空凭证账号 → 200 → 正文「收到」+ 思维链 + usage，全程零 key** |
| 真机管线（`npm run test:live`，联网） | 真实模型目录 + 倍率；设备码登录实测发起成功、未授权正确返回 `pending` |
| 真实 DSH 进程（headless profile） | 通过（**零 `did not activate`、零配置校验错误**） |
| **真实浏览器**（Edge + 真 web profile） | 通过 —— 客户端 bundle 在 boot combo 里、`apply` 正常激活、控制台零本插件错误 |

### 模型不是全塞进去：默认只报**免费**的

上游实测 85 个模型，全进下拉的话免费那几个会被淹没。所以每个 Agent 有一份上报策略
（设置页里就是三个按钮 + 一个带搜索的勾选列表）：`free`（默认）/ `selected` / `all`。
详见 [`docs/MODELS.md`](docs/MODELS.md) §6.5。

## 📣 加入交流

对 DeepSeek Harness 插件开发、多 Agent 网关接入感兴趣？欢迎加入交流群一起讨论：

**QQ 群：`1105449571`**（QQ 内搜索群号即可加入，进群请备注「dsh 插件」）

群内分享：插件开发经验、模型接入与倍率配置、多账号管理与路由调优、DSH 使用技巧。
如果这个插件帮到了你，也欢迎进群反馈问题、提建议、参与新功能投票 🌟

## License

MIT
