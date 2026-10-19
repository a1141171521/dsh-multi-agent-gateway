# 已知问题 / 待修清单

**从上往下修**。每条都写清「现象 → 根因 → 已改了什么 → 还差什么」，
换一台机器也能直接接着干，不用重新调研。

状态图例：

| 标记 | 含义 |
|---|---|
| 🔴 | 有真机复现，**还没修好**（代码可能已经改了，但没验证过，不算修好） |
| 🟡 | 代码已改，只跑过单测/预览，**没在真机上确认** |
| 🟢 | 真机确认过 |

---

## 🟢 #0k 六个平台的签到 / 额度 / 模型调用按参考实现对齐（2026-10-19）

> 用户原话：「把我们所有平台的实现方案，均参考 dsh-our-free-model 来实现，
> 这个是一个已经跑通的插件，可以直接参考。尤其是签到，模型调用等等」

参考实现在 `E:\AIProject\DeepSeekPlugin\.scratch\dsh-our-free-model`（仓库外，MIT），
真正源码在 `vendor/channel-pack/src/*.ts`（144 个文件）。**它把「踩过的坑和为什么」
写在模块头注释里 —— 那是它最有价值的部分，本轮几乎所有结论都出自那些注释 + 真上游验证。**

### 本轮补齐的能力（之前全是 `supported: false`）

| 平台 | 签到 | 额度 | 说明 |
|---|---|---|---|
| Qoder / Qoder CN | ✅ 新增 | ✅ 新增 | `/sash/api/v1/me/campaigns` + `/sash/api/v2/me/usage` |
| WorkBuddy（国内） | ✅ 新增 | ✅ 新增 | 国内有签到；国际版**没有**签到接口 |
| WorkBuddy Intl | 按上游如实 false | ✅ 新增 | 余额两个版本都有，别因为「没签到」推断没余额 |
| Trae | ✅ 新增 | ✅ 新增 | 从骨架升级为真实现 |
| OpenCode | 本就是真实现 | 本就是真实现 | 官方 Console 没有签到接口（探测到才升级） |

### ★ 三条与参考实现说法**不符**的实机结论（以实机为准）

1. **Qoder 的 machine 头不是必需的。** 参考实现声称必须带 `Cosy-MachineToken` +
   `Cosy-MachineType`，否则只回 1 条 `VIEW_DETAILS`。本机实测（真实账号）：
   仅 `Cosy-ClientType: '10'` 就回 2 条含 `CLAIM_BENEFIT`；加了 machine 头结果**完全相同**。
   ⇒ 不实现 machine 头（本机那个身份来自 `runtime-info.exe`，与账号无关，加了只增加失败面）。
   但 `Cosy-ClientType` 必须是 `'10'`：用 `'5'` 时 `campaigns` 恒为空。

2. **Qoder「回放响应不含 benefit」是错的。** 参考实现说 `replayed:true` 时不含 `benefit`。
   本机真实响应**含**（`replayed:true` + 完整 `benefit` + 旧的 `claimedAt`）。
   这条危险在它恰好让两个"看起来对"的写法都变错：
   「有 benefit 就算成功」→ 每次谎报 +100；「没 benefit 就算回放」→ 本机永远不成立。
   ⇒ **判据只能是 `replayed` 布尔字段本身。**

3. **`VIEW_DETAILS` 纯展示活动也带 `claimStatus:"CLAIMED"`。**
   所以「先按 `actionType === 'CLAIM_BENEFIT'` 过滤」是**承重的** ——
   不先过滤，会在从没有过每日领取的账号上谎报「已领」。

### 本轮修掉的真实缺陷（都不是新功能，是错的）

| 缺陷 | 后果 |
|---|---|
| 签到幂等键用 **UTC 日**而非 UTC+8 业务日 | 每天 00:00–08:00（UTC+8）算成两天 ⇒ **跨零点重复领取** |
| 「今天已签」被当成「今天已处理」 | Qoder 活动 10:00（UTC+8）才刷新，上午看到的 CLAIMED 属昨天 ⇒ **每天静默漏领 100 积分** |
| 额度耗尽的冷却 30 分钟（参考 24 小时） | 空钱包账号被反复选中、反复 402 |
| `retry-after` 没有封顶 | 上游给 12 小时就锁 12 小时，UI 分不清「在等」与「卡死」 |
| `retry-after` 负数被 `Date.parse` 当 ISO 年份 | 抹成 0 = 「立即解除」⇒ 刚落限流的账号马上被重选，**无限空转** |
| 思考档位选择器写死 4 档（`off` 在主流档位表上是非法值） | 用户一选就 **400**，整轮对话不可用 |
| `reasoningEffort` 声明了却从不写进 payload | 用户选了档位，请求里**根本不带** ⇒ 静默丢弃 |
| OpenCode 额度错误按状态码判 | `FreeUsageLimitError` 带 403 时误判成 `auth` ⇒ 报「密钥无效」而账号其实好的 |

### ★ 一条新增的契约（`CheckInResult.coversToday`）

「今天已领」这句话**天然有歧义**：它只说明「服务端现在认为没有可领的了」。
在**活动按日定时刷新**的平台上，刷新前看到的「已领」属于**昨天那一轮**。

修法**不是**在核心层配一张「各平台刷新时刻表」（必然漂移），而是让**看得见该平台
刷新语义的那一层**自己回答 —— 新增 `coversToday`（缺省 `true`）与 `actionRequired`：

- `coversToday === false` ⇒ 记账层**故意不记**，当天稍晚会自动重试；
- `actionRequired === true` ⇒ 「你得先去别处操作」（如未开通每日领取），重试无用，
  UI 必须**单独、醒目**地展示，且判的是**布尔字段**不是 message 文案。

### 验证

- **真上游**：Qoder CN 额度读到真值 `remaining: 858`（取自 `addOnQuota`，
  `userQuota` 实测恒为 0 的占位）、签到正确识别「今天已领取」且**没误报 +100**、
  对话通（`dfmodel` → 「你好」，思维链也透出）；OpenCode 免费层零凭证实测通。
- **单测**：127（核心）+ 38（客户端）+ 227（各适配器/推理/记账）+ 冒烟，全绿。
- ⚠️ **WorkBuddy 与 Trae 没有真上游验证**（本机没有这两家的账号）——
  它们的解析规则只用参考实现里的**真实样本**做 fixture，尚未对过真上游。

### 思考档位这条链（第二轮补齐，2026-10-19）

「模型调用」不只是把请求转发出去 —— **用户能不能调思考强度**也在这条线上。
第二轮发现并修掉了三处断点，它们各自都能让档位「看起来有、其实没用」：

| 断点 | 后果 |
|---|---|
| 适配器从不把目录里的 `thinking_config.enabled.efforts` 报进 `ModelMeta` | 选择器里**一个档位行都没有**（参考实现把这记为用户报障） |
| 核心层写 `payload.reasoning_effort`，Qoder 只读 `payload.reasoning` | 用户选了档位，**请求里根本不带**，静默按默认档跑 |
| 档位行被包在 `if (meta.reasoning === true)` 里 | `is_reasoning:false` 但有档位的模型（CN 的 `performance`）**档位行被吞掉** |

还有一处**保真度**问题：目录里逐条抄了官方客户端的 `is_default`（`dfmodel` 是 `max`），
但没上报给核心层，于是核心层用启发式猜了一个 `low` —— 同一个模型在插件里「想得更少」，
而用户完全看不出差别。现在规则是**上游声明的默认优先于启发式**。

**TRAE 也有同型的两处**（第三轮补齐）：

| 断点 | 后果 |
|---|---|
| 目录解析早读出了 `reasoning_effort_config`（连合并规则都实现了），但适配器只压成 `reasoning: true` | 档位本身**从没进过 `ModelMeta`**，选择器里没有档位行 |
| `buildOpenAiBody` 把 `reasoning_effort` 丢掉了（注释还写着「由 DSH 下发」，但没有任何地方在下发） | 用户选了档位，**请求里根本不带** |

⚠️ TRAE 的档位是**私有 wire 值**（`light` / `high` / `extra_high`），
而 OpenAI 客户端只会说那 8 个规范名 —— 这正是 `core/reasoning.ts` 那张强度序表
存在的理由：**网关承担翻译**，适配器如实报 wire 值，核心层负责换算。

真上游验证（`.scratch/verify-effort-chain.mjs`，同一模型带档位 vs 不带）：

```
dfmodel       选择器行=[none,low,high,max]  defaultEffort=max   ← 与目录声明一致
qmodel_38max  选择器行=[none,low,medium,xhigh]  defaultEffort=xhigh
performance   选择器行=[none,low,medium,high,xhigh,max]  defaultEffort=medium  ← 曾被吞掉

带档位   → 加密请求体 1320 字节，思维链 30 字
不带档位 → 加密请求体 1256 字节，思维链 135 字
（字节数不同 = 档位真的进了加密请求；思维链长度不同 = 上游真的按档位跑了）
```

---

## 🟡 #0i Qoder 对话报「解不出 user_id」—— uid 从没被存下来

> 报障原话：现在对话还是不可以，提示「本轮运行失败 API 密钥无效」。
> （修完 #0f 后真实报错露出来了：`token 里解不出 user_id，无法生成签名`。）

### 根因

Qoder 设备码登录给的是 **`dt-...` 这样的不透明设备令牌，不是 JWT**。
而加密推理要用 `uid` 派生 `encrypt_user_info` —— 这个 `uid` **不在 token 里**，
它在**登录响应的 `user_id` 字段**里（参考实现 `dsh-our-free-model` 的
`parseQoderTokenPayload` 读的就是它）。

我们的 `pollLogin()` 只存了 `token` / `refreshToken` / `expiresAt`，
**把 `user_id` 丢了**；`clientFor()` 于是拿设备令牌去当 JWT 解，永远解不出 uid。

> 值得记一笔：`dsh-our-free-model` 的 `ensureUid()` 在缺 uid 时**明确报错**
> 而不是发一个必然失败的请求 —— 它的注释写着「否则服务端回
> `Signature invalid (101)`，用户看到的是『签名错误』而非『凭证不完整』，极难定位」。
> 我们这边是把错误露出了，但根因同样在「凭证不完整」。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `src/adapters/qoder.ts` | `pollLogin()` 把响应的 `user_id` 存成 `credentials.uid`。 |
| `src/adapters/qoder.ts` | 新增 `uidOf()`：**优先用凭证里存的 uid**，其次才尝试 JWT 解析（手工粘贴 JWT 的老路径仍然可用）。 |
| `src/adapters/qoder.ts` | 新增 `resolveUid()`：老账号（早期版本漏存）**不用重新登录** —— 问一次不需要 WASM 签名的用量接口把 uid 补回来，并通过 `ctx.onCredentialsRefreshed` **回写**，下次直接命中。 |
| `src/adapters/qoder.ts` | 新增 `findUserId()`：按 `userId` / `user_id` / `uid` 递归找（两个端点的形状不同）。 |
| `test/unit.test.mjs` | +2 条：登录响应里的 `user_id` 必须存成 uid；`findUserId` 对两种真实形状都认。 |

### 补 uid 用的是哪个端点（实测 2026-10-19）

两个都**只认 `Bearer <device token>`，不需要 WASM 签名**，返回的 uid 一致：

```
200 https://openapi.qoder.com.cn/sash/api/v2/me/usage      → .qoderUsage.userId
200 https://openapi.qoder.com.cn/sash/api/v1/me/campaigns  → .uid
```

真机验证（`.scratch/verify-uid-backfill.mjs`）：

```
账号 qoder-cn:qoder-cn-账号：token=dt-4OLYeuvgM... uid=null
  200 /sash/api/v2/me/usage → uid="019e88b9-1c04-7552-8feb-7b4a137d4c3d"
回写后账号里的 uid："019e88b9-1c04-7552-8feb-7b4a137d4c3d"
回写后校验：ok=true
✓ 老账号的 uid 能靠上游补齐并回写，不需要用户重新登录
```

---

## 🟡 #0j Qwen3.8-Max 的倍率不对：应是 ×0.5，显示成 ×0.2

> 报障原话：Qwen3.8-Max 倍率不对，正确倍率是 x0.5。

### 根因

`price_factor` 是**采集那一刻的生效价**，会随错峰窗口变化。`Qwen3.8-Max` 的
`promotion` 是「22:00–08:00、4 折、原价 0.5」——目录里存的 `0.2` 是**窗口内的折后价**；
**窗口外（白天）正确倍率是原价 ×0.5**。

上一轮我把 `price_factor` 直接当倍率显示，白天就显示成了 ×0.2。

### 参考实现怎么算（`dsh-our-free-model` 的 `qoderDisplayName` / `promotionActiveNow`）

```
窗口内：beforePromotionPriceFactor × discountFactor   （折后价）
窗口外：beforePromotionPriceFactor                    （原价）
无促销：priceFactor
```

并且**不采信目录的 `promotion.active`**（那是下发时刻的快照，客户端不重启就会过期），
而是按 `windowStart`/`windowEnd` **本地推算**（UTC+8，支持跨零点）。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `src/adapters/qoder.ts` | 新增 `promotionActiveNow()`（逐字对齐参考实现）、`isPromotionActive()`、`effectiveMultiplier()`；`getModelMetaList()` 改用 `effectiveMultiplier()`。 |
| `src/adapters/qoder.ts` | 折扣生效时在 `description` 里写清「原价 ×0.5 → 现价 ×0.2」。 |
| `test/unit.test.mjs` | +1 条：窗口内 0.2 / 窗口外 0.5 / 跨零点窗口 / 无促销模型不受影响。 |

### 验证

```
现在 UTC+8：17:44
Qwen3.8-Max：窗口内=false 倍率=×0.5（期望：白天窗口外 ×0.5）✓
22:00 UTC+8 → 0.2 ；10:00 UTC+8 → 0.5
```

---

## 🟡 #0f 选了 Qoder 模型对话报「API 密钥无效」

> 报障原话：我选择了 Qoder CN 的 deepseek 模型保存后，使用此模型进行对话，提示「本轮运行失败 API 密钥无效」。

### 根因（两处，缺一不可）

1. **账号的「对话」开关是关的**。`requests.jsonl` 里两条记录写着
   `「qoder-cn」下没有可用账号`。查账号文件：那个账号 `routeChat: false`，
   而 `accounts.routable()` 的判据是 `routeChat !== false` → 直接被排除在对话路由之外。
2. **错误被归成 `auth`**，DSH 把 `code === 'AUTH'` 直接渲染成「**API 密钥无效**」
   （`dsh-client-ui-chat` 的 `message.failure.auth`）—— 用户明明刚登录成功，
   却被指向「密钥」这个完全错误的方向。

### 为什么「对话」开关会变成关的

`publicAccount()` 原来把 `routeChat` **原样透传**：登录新建的账号这个字段是
`undefined`，界面 `toggle('对话', 'routeChat', account.routeChat)` 判的是
`on === true` → **画成「关」**。

但路由的真实语义是 `!== false` → **参与对话**。

> 界面显示的正好是真实行为的**反面**。用户看到「对话」是关的，本能地去点它 ——
> 点一下把 `undefined` 写成 `true`（其实没变），再点一下写成 `false`（真关上了）。
> 于是「本来能用」变成「不能用」，而且报错还说成密钥无效。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `src/runtime.ts` | `publicAccount()` 里三个开关全部返回**生效值**：`routeChat: record.routeChat !== false`、`autoCheckIn: tasks.checkInEnabledFor(record)`、`autoTasks: tasks.enabledFor(record)`。界面从此和路由同口径。 |
| `src/core/router.ts` | 新增 `describeNoCandidate()`：按现状分情况给话术（还没有账号 / 全被停用 / 对话开关是关的 / 凭证失效 / 已无其它号可换），每种都点名去哪儿点哪个开关。 |
| `src/core/router.ts` | 归类 `auth` → **`unsupported`**：配置没就绪不是凭证无效，DSH 会原样显示我们的话术而不是「API 密钥无效」。 |
| `test/unit.test.mjs` | +3 条：对话开关关掉时的归类与话术、停用/失效各自的话术、账号快照给生效值。 |

### 验证（真机已过）

`.scratch/verify-round3.mjs`（读**真实账号文件** + 真实上游）：

```
账号文件：解密成功，共 1 个
  - qoder-cn / Qoder CN 账号：routeChat 存储=true → 生效=true
qoder-cn 对话候选：1 个 qoder-cn:qoder-cn-账号
「有账号但停用」的结论：kind=unsupported
  message=「qoder-cn」的 1 个账号都被停用了 —— 到「账号」页重新启用
```

---

## 🟡 #0g Qwen3.8-Max 被标成「免费」

> 报障原话：Qoder CN 账户添加进来以后，为什么 Qwen3.8-Max 模型也显示免费。

**根因**：把目录里的 `is_free` 直接当成「免费」用了。

`is_free` 的真实含义是「**免费额度模型**」—— 它**照样按倍率扣积分**，只是额度由免费档供给。
真正零成本的只有 `qfmodel`（Qwen3.8-Flash，`price_factor: 0`）。

**已改**：`src/adapters/qoder.ts` 的免费判据改成**只有 `multiplier === 0`**；
`is_free` 的信息不丢，写进 `description`（「免费额度模型（仍按倍率扣积分）」）。

**验证**：Qoder CN 17 个模型里只有 `qfmodel(×0)` 标免费，且 17 个模型**全都有倍率**。

> ⚠️ 本条当时写的「`Qwen3.8-Max` 该显示 `×0.2`」是**错的**（那是窗口内折后价）——
> 正确倍率随错峰窗口变化，白天是 `×0.5`。见 **#0j**。

---

## 🟡 #0h 打开浏览器后弹框偏移太厉害

> 报障原话：浏览器网址打开后，弹框位置偏移太厉害。

**根因**：上一轮按原型给「已打开浏览器」的状态加了左移
（`.mag-overlay[data-side="1"]{justify-content:flex-start;padding-left:6%}`）。
原型里那是为了别压住浏览器窗口，但真机上 DSH 是全屏窗口 ——
在 1920 宽的屏上左移 6% 等于把弹框甩到最左边，看起来就是「跑偏了」。

**已改**：**去掉左移**，弹框永远居中（`data-side` 属性与对应样式一并删除）。
居中是可预期的，别再为「让位」动位置。

---

## 🟡 #0 勾选模型后保存按钮一直灰着（勾选根本没写进草稿）

> 报障原话：模型列表，勾选模型后，未出现保存按钮。
> （补充确认：保存条在，但按钮一直是灰的、点不动。）

**状态**：根因已定位并修好，单测覆盖了，**等一次真机刷新确认**。

### 根因

`87b0e0a` 把界面从「React JSX 渲染」改成「投影 → HTML 字符串 → `ROOT.innerHTML`」，
但事件还挂在 React 的 jsx 属性上（`<div class="mag-root" onClick onChange onInput>`）。

`innerHTML` 生成的节点**没有 React fiber**，React 会把事件目标解析成最近的有
fiber 的祖先 —— 也就是根 div。这对 `click`、`input` 没问题（普通事件插件会把
监听派发到根节点上）；但 **`onChange` 走的是 `ChangeEventPlugin`**，它只在
「解析出的目标节点是 input / select / textarea」时才派发。目标变成 div 之后，
**一次都不派发** —— 勾选框的 change 永远到不了 `toggleModel`。

于是：

1. 勾选框被浏览器原生勾上（视觉上「勾住了」）；
2. 草稿 `drafts` 里什么都没写；
3. `ops()` 为空 → `shell.dirty === false` → 保存按钮保持 `disabled`；
4. 用户看到的正是「勾选模型后没有保存按钮」。

同一个根因还带走了「只看免费」勾选框和上下文长度输入框。

### 已经用真浏览器验证过这条根因

`.scratch/react-onchange/index.html` 用 React 18.3.1 的最小复现页验证了三点
（同一形状：React 渲染的 div + `ref.current.innerHTML` 写入的复选框）：

| 写法 | 结果 |
|---|---|
| 只挂 React 的 `onChange`（旧写法） | **onChange 触发 0 次**；onClick 触发 1 次；复选框视觉上是勾上的 |
| 同一面板再挂原生 `addEventListener('change')` | 触发 1 次 —— 说明事件本身有、也冒泡，是 React 不派发 |
| 同一个 div 改用原生监听（新写法） | 触发 1 次 ✓ |

### 已改的地方

| 文件 | 改动 |
|---|---|
| `client/client.js` | 根节点改成**原生监听**：`ROOT.addEventListener('click' / 'change' / 'input')`，effect 清理时摘掉；jsx 上不再挂 `onClick/onChange/onInput`（否则合成事件 + 原生监听会把开关翻两次）。 |
| `test/client.test.mjs` | 新增回归测试：根节点不许再有 React 合成事件、三个原生监听必须齐全、模拟 change 后 `shell.dirty` 必须变 true、卸载后监听摘干净。 |
| `docs/MODELS.md` §6.5 | 记下「为什么必须用原生监听」，免得下次重写又踩。 |

### 验证

1. 刷新页面（客户端半边随页面重载；宿主侧改动要重启 DSH 才生效）；
2. 设置 → 多 Agent 网关 → **账号** → 勾一个模型；
3. 保存条应立刻变成「**1 项改动未保存**」，右侧「保存并生效」变蓝可点；
4. 点保存 → 变「已保存」，对话框模型下拉里出现该模型。

---

## 🟡 #0b OpenCode 只拉免费模型 / 去掉「按推荐预选」

同一轮的两个行为变更（不是 bug）：

- **宿主侧过滤**：`src/adapters/opencode.ts` 的 `getModelMetaList()` 只返回免费模型
  （判据：价格算出来是 0，或 id 以 `-free` 结尾；没价又不带 free 的按付费过滤）。
  免费判定的兜底不能在「价格源挂了」时把列表清空 —— 单测覆盖了这条。
- **客户端**：「按推荐预选 N 个」按钮已删除（`preselectModels` 一并删掉），
  「只看免费」勾选框只在平台真有付费模型时出现。

⚠️ 宿主侧过滤要**重启 DSH** 才生效（`lib/adapters/opencode.js` 是宿主进程里已加载的模块）。

---

## 🟡 #0c 没登录就把模型列出来，倍率全是「未知倍率」

> 报障原话：为什么 Qoder 等平台，还没登录账号就拉取到了模型，但是倍率是未知呢？太不友好了。

### 根因

两件事叠在一起：

1. **目录提前可见**。Qoder / WorkBuddy 的 `getModelMetaList()` 用的是**产品级兜底目录**
   （内置在插件里的 17 / 11 条），跟账号无关；而 `runtime.modelsOf()` 在没有账号时会
   拿一个**匿名占位记录**去调适配器 —— 于是没登录也照样拉出一张表。
2. **倍率没人填**。两个适配器返回 `ModelMeta` 时都没写 `multiplier`，
   界面显示的就是「未知倍率」。Qoder 的兜底目录里其实**有** `price_factor`（倍率）
   和 `is_free`，只是没用上。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `src/adapters/qoder.ts` | token 为空（= 没登录）直接返回 `[]`；有 token 时用目录的 `price_factor` 当倍率、`is_free` / `price_factor === 0` 标免费，`multiplierSource: 'qoder:catalog'`。 |
| `src/adapters/buddy.ts` | 一样：token 为空直接返回 `[]`（登录前一个都调不动）。 |
| `client/client.js` | 新增 `needsAccountFor()`：非免账号平台且没有账号时，模型卡片只给「先登录」引导（不拉、不列、不显示「拉取模型」）；`loadModelsIfNeeded()` 跳过这类平台，并把**账号数**放进防抖 key —— 登录成功后自动重拉。 |
| `test/unit.test.mjs` | +3 条：Qoder 没 token 返回空、有 token 时倍率与免费标记正确、WorkBuddy 没 token 返回空。 |
| `test/client.test.mjs` | +1 条：没登录的平台渲染「登录后自动拉取」引导，不出现模型行 / 测一次 / 拉取模型。 |

### 验证

1. **重启 DSH**（宿主侧适配器改了）；
2. 设置 → 多 Agent 网关 → **账号** → 切到 Qoder / WorkBuddy：
   模型卡片显示「**未登录 · 登录后自动拉取**」，没有模型行、没有「拉取模型」按钮；
3. 登录（或给账号填 token）后：模型自动出现，倍率是 `×0.5` / `×0.08` / `免费` 这种，
   不再是「未知倍率」。

---

## 🟡 #0d 「测一次」没有进行中状态；免账号平台压根没开始探

> 报障原话：opencode 测试模型的可用度，点完以后，没有状态显示正在测试，用户不知道有没有测试。

### 根因（两条，各自独立）

1. **没有行内反馈**：探测是**一次真实上游请求**（8 token、等首帧），十几秒很正常。
   客户端只在页面顶部画一行 `busy` 提示，模型表格里没有任何变化 ——
   用户点完看不出发生了什么，以为按钮没反应。
2. **免账号平台直接失败**：`runtime.probeModels()` 先用
   `router.candidates(agentId)` 选账号，一个账号都没有就 `return { ok: false,
   error: '…没有可用账号' }`。OpenCode 是**免账号通道**，本来就没有账号 ——
   所以「测一次」在 OpenCode 上**从来没有真正跑过**。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `src/runtime.ts` | `probeModels()` 选账号时**补匿名占位**（和 `modelsOf()` 同一套规则：路由账号 → 降权账号 → 匿名占位）。匿名记录会被适配器按 `freeTierMode` 自动补上免费层头。 |
| `client/client.js` | 控制器新增 `this.probing`（投影里是 `probing: [...]`）：探测中该行状态列显示「测试中」、按钮变禁用的「测试中…」；工具栏显示「正在测试 N 个模型…」；同一时间只跑一轮，其余行的「测一次」一并禁掉。 |
| `test/client.test.mjs` | +1 条：探测中渲染「测试中…」与进度说明、其余按钮禁用；没探测时每行都有「测一次」。 |

### 验证

1. **重启 DSH**；
2. 设置 → 多 Agent 网关 → 账号 → 模型表格点任意一行「测一次」；
3. 该行立刻变成「**测试中**」徽章 + 禁用的「**测试中…**」按钮，工具栏出现进度说明；
4. 几秒后变成「可用 · 612 ms」/「地区受限」/「不可用」（结论落 `probes.json`，刷新页面还在）。

---

## 🟡 #0e 登录弹框排版重做（挤成一团 → 一屏一件事）

> 报障原话：登录账号这个页面排版太丑了，优化一下。

### 之前为什么丑

上一版把**步骤、授权链接、主按钮、状态**全塞进 `padding:13px` 的弹框里，
而且链接框和主按钮**并排**：

- 主按钮「在浏览器打开」和说明「打不开？复制链接到手机…」挤在同一行，
  470px 宽的弹框里换行错位，按钮显得又小又重；
- URL 是 11px 等宽字塞在 `4px` 的内边距里，一行截断看不出重点；
- 状态区两行小字（「有效期 5 分钟」/「每 5 秒自动检查一次」）没有层次；
- 设备码（OpenCode 的 userCode）只作为一个小字塞在状态行里，用户根本注意不到。

### 这一版的排布

从上到下一条线，每块之间 14px：

1. **标题**：`● 登录 Qoder CN` + 平台类型标签 + 右上 ✕；
2. **引导语**：一句话说清「在浏览器里完成登录，本窗口自动检查」；
3. **步骤**：两条，圆圈 + 竖连接线，完成的那步变绿勾；
4. **设备码**（只有设备码登录才有）：单独一块、16px 等宽大字 + 独立「复制」按钮；
5. **授权链接**：框外有「授权链接」小标签，框内是等宽链接 + 复制；
6. **主按钮整行**：`在浏览器打开 ↗`，说明放在按钮正下方居中；
7. **状态卡**：主状态 + **剩余 m:ss** + 一条 3px 倒计时进度条 + 次要说明；
8. **页脚**：取消在左，主/次动作在右。

弹框本身：470 → **520px**、圆角 10 → 12px、内边距 13 → 16/18px、
`max-height:calc(100vh - 48px)` + 内部滚动（小窗口不被裁）。

两处顺手的行为修正：

- **倒计时是真的在走**：控制器在等授权时多存一个 `expiresAt`（绝对时刻），
  弹框每秒只更新「剩余时间 + 进度条」两个节点 —— **不整块重画**，
  否则每秒重建一次按钮，点击会丢、hover 会断；
- **打开浏览器后弹框左移**（`data-side="1"` → `justify-content:flex-start`），
  别压住浏览器窗口。这个行为原型里就有，但上一版只写了 `data-side` 没写样式，
  等于没生效。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `client/client.js` | 重写登录弹框的 CSS 段与 `loginModalHTML()`；新增 `mag-field / mag-codebox / mag-cta / mag-btn-block / mag-bar / mag-step-t`；`copyText()` 抽出（链接与设备码共用）；新增 `login-copy-code` 动作；`portalTick` 秒级只更新两个节点；`paintPortal` 内容没变就不重写 innerHTML。 |
| `src/login` 侧 | 无需改；`expiresAt` 由客户端在 `startLogin` 时按 `expiresInSec` 算出。 |
| `test/client.test.mjs` | +2 条：主按钮整行 / 倒计时绑定 / 终态不画等待区；设备码只在该形态出现（含独立复制按钮）。 |

### 验证

1. 刷新页面（只改了客户端半边）；
2. 账号页 → 任意平台「登录」：弹框应是 **520px 宽、纵向一条线**，
   主按钮占满一行，底部状态卡有倒计时和进度条；
3. OpenCode 的登录弹框应多出一块**设备码**（大字 + 复制按钮）；
4. 点「在浏览器打开」后，弹框应**左移**，不再压在浏览器窗口上。

> 几何自检（预览页 `preview/login-*.html`，用浏览器量到的真实盒子）：
> 弹框 522px、主按钮 520×38、进度条 492px、无横向溢出、两步、Qoder 无设备码块。

---

## 🔴 #1 对话框模型选择器里出现「没勾选、也没保存过」的模型

> 报障原话：很多模型我并没有选择并保存，但是现在在对话框选择模型的地方，
> 渲染的有这些平台的模型。

**状态**：根因已定位、代码已改，但**真机未验证** —— 而且这次改的是宿主侧
schema 默认值，**必须重启 DSH 才会加载**。所以仍按「未修好」记。
明天第一件事就是按下面「验证」那节跑一遍。

### 现象

- DSH 的模型选择器里出现 OpenCode 之外的平台模型（WorkBuddy / Qoder / 国际版的免费模型）；
- 插件设置页「账号」里这些平台却显示 `已勾选 0 / 共 10` —— 界面和下拉对不上；
- 「总览」KPI 的数字比下拉里实际能看到的条数多。

### 根因（两处独立缺陷）

1. **默认值太宽松**：`ModelPolicySchema.mode` 默认 `'free'`，含义是「免费模型自动上报」。
   用户 yml 里只给 `opencode` 写了 `models` 块，其它平台没有 `models` 块 → 走默认值 →
   免费模型**自动**进选择器。用户从没勾过、也没保存过，模型却出现了。
2. **连续勾选互相覆盖**：`toggleModel` 以「宿主已保存的 `selectedIds`」为基线，
   连续勾/取消多个时后一次把前一次覆盖掉 —— 勾 5 个保存后只剩 1 个。这条会让
   用户以为「保存没生效」，进而反复点保存，把更多平台写进配置。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `src/config.ts:203-216` | `mode` 默认 `'free'` → **`'selected'`**；`selected` 默认 `''`。即「**不勾不报**」。 |
| `src/runtime.ts:1224-1228` | 快照新增 `exposedCount` = 上游拉回来的 ∩ 上报策略；`exposeModels !== true` 时为 `0`。 |
| `client/client.js` | `toggleModel` 基线改为**草稿优先**（draft → 宿主 `selectedIds` → `modelSelection()`）；~~新增 `preselectModels(ids)` 与「按推荐预选 N 个」按钮~~（后来按用户要求删掉了，见 #0b）；总览 KPI 与平台健康表改读 `exposedCount`。 |
| `test/client.test.mjs` | 新增 4 条断言：schema 默认必须是 `selected`、默认勾选必须为空、连续取消不互相覆盖、~~`preselectModels` 只写草稿~~（该功能已删除，见 #0b）。 |
| `docs/MODELS.md` §6.5 | 上报规则表按「不勾不报」重写。 |

### 验证（明天按顺序做）

1. **重启 DSH**（不是刷新页面）。schema 默认值在宿主进程启动时解析，
   刷新页面只重载 client 半边，拿不到新默认值。
2. 设置 → 插件 → 多 Agent 网关 → **账号**。没配过 `models` 的平台
   （Qoder / WorkBuddy / WorkBuddy 国际版）应显示 `已勾选 0 / 共 N`。
3. 回对话框展开模型下拉：**只应出现 OpenCode 已保存的那两个** ——
   `deepseek-v4.1-flash-free`、`glm-5.3-flash-free`。

> 参考：这份配置在 `~/.dsh/profiles/desktop/cordis.patch.yml`，当前只有
> `opencode.models`（`mode: selected` + 两个模型）和 `qoder.tasks.enabled`，
> 其它平台**没有任何 `models` 块** —— 所以默认值就是唯一的开关。

### 如果重启后还复现，按这个顺序查

1. **yml 被写脏了**（最可能）。翻 `cordis.patch.yml` 对应平台的 `models:` 块：
   如果**显式**写了 `mode: free`（早期点过「保存并生效」就会被写进去），
   改 schema 默认值完全不管用 —— 需要改配置，或者加一段迁移把
   「显式 free + 用户没真正勾过」收敛掉。**先看这一步再动代码。**
2. **`exposeModels: false` 但 provider 还注册着**。`src/runtime.ts` 里
   `exposeModels !== true` 时应完全不注册 provider；若仍能看到该平台，
   说明注册没跟着配置走。
3. **DSH 自己的模型缓存**。宿主的模型目录可能按 provider 缓存，重启后仍留旧条目。
   试：清 `~/.dsh/profiles/desktop` 下与模型相关的缓存，或整目录重装一次。
4. **选择器不走 `exposedCount`**。界面已经改了，但如果 DSH 原生选择器的
   模型列表有别的来源，去查 `src/llm/adapter.ts` 的 `listModels`。

### 教训

**不要用「默认上报」当默认值。** 任何会自动出现在用户界面上的东西，
默认都必须是不出现，由用户显式打开。

---

## 🟡 #2 登录弹框的遮罩把整个屏幕遮住了

- **原因**：拿 `--dsw-alias-bg-overlay` 当遮罩用。这个 token 是**不透明的浮层表面**，
  不是半透明蒙版，铺满全屏就变成一块死板。
- **已改**：`.mag-overlay` 改用 `rgba(0,0,0,.45)`；点遮罩空白处 / ✕ / 取消 / Esc
  都走同一个 `closeLoginModal()`。登录弹框本身的排版在 #0e 里又重做了一遍。
- **还差**：真机看一眼遮罩下面能不能看到页面。弹框本身在 `document.body` 的 portal 里
  （`z-index: 1000`），因为设置页祖先有 `transform`/`overflow`，`position: fixed` 会被裁。

---

## 🟡 #3 设置页所有「开启 / 关闭」开关点了没反应

- **原因**：`fieldRowHTML` 读 `fieldState.value`，但宿主的真实形状是
  布尔字段 `{checked, changed}`、文本字段 `{text, changed}`。读不到 → 开关永远渲染成
  `aria-checked="false"`；而点击时算出的「设成 true」对本来就 true 的字段是空操作。
- **已改**：渲染和 `onSwitchClick`（读 `hit.state?.checked`）都按真实形状取值。
- **还差**：真机确认开关会翻面，且翻面后顶部出现「保存并生效」（保存栏由
  `shell.dirty` / `dirtyCount` 驱动，开关**不会**即时写入配置）。

---

## 🟡 #4 外链登录的自动轮询没有真机验证

`startLogin` 现在对**设备码**和**外链**两种形态都排每 3～5 秒一次的轮询（原型要求）。
代价是 WorkBuddy / Qoder 的 `/auth/token?state=` 会被一直问到过期。需要一次真人登录确认：

1. 授权完成后 3～5 秒内界面自己变绿（不用点「手动刷新」）；
2. 过期后停在 `expired`（灰），**不会**再变绿 —— 早期这里掉进 `else` 分支，
   过期反而渲染成绿色的「已添加账号」。

---

## 🟡 #5 深色主题只有近似色，没在真机核对

`scripts/preview.mjs` 用固定的 14 个 token 浅色值渲染成 `preview/*.html`，
深色用的是近似调色板。真实设备上的深色值没核对过，检查清单：边框、
次要文字、「浅色底 + 状态色」的徽章。

---

## 其它已知边界（不是 bug，别再查一遍）

- **Trae 适配器是骨架**，`visible: false`，界面看不到。实现后把 `trae` 加进
  `src/config.ts` 的 `DEFAULT_VISIBLE_AGENTS` 即可。
- **宿主端 `addAccount` / `setCredentials` 端点仍在**（`src/index.ts`），
  但界面已没有手动填 token / cookie 的入口 —— 保留给脚本用。
- **WorkBuddy 的签到 / 额度**上游没有公开接口，明确回报「不支持」。
- 改完 `src/` **必须先跑 `node scripts/build.mjs`** 再提交：`lib/` 是提交进仓库的
  构建产物，安装时不重新构建。`node scripts/build.mjs --check` 校验是否漂移。
