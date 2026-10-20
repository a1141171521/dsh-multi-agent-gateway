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
2. 设置 → 免费模型聚合器 → **账号** → 勾一个模型；
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
2. 设置 → 免费模型聚合器 → **账号** → 切到 Qoder / WorkBuddy：
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
2. 设置 → 免费模型聚合器 → 账号 → 模型表格点任意一行「测一次」；
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
2. 设置 → 插件 → 免费模型聚合器 → **账号**。没配过 `models` 的平台
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

## 🟢 #0r WorkBuddy 的思考档位：19 个模型被我们吃掉（2026-10-20，已修并真机验证）

> 用户问：「为什么 workbuddy 的 deepseek 模型不能调整思考等级呢？ qoder 的就可以呢」

**答案是两件事叠在一起**：一个是我们的 bug（影响 **19 个**模型），
一个是用户恰好试到了上游**本来就锁死单档**的那两条。

### ① 真 bug：我们从没给 WorkBuddy 报过 `reasoningEfforts`

核心层（`src/llm/adapter.ts:258-268`）出不出档位行，**只**取决于一个字段：
```ts
const declared = Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []
if (reasoningEffortsForDeclared(declared).length > 0) { out.reasoning = … }
```
而 `src/adapters/buddy.ts` **从头到尾没设置过 `reasoningEfforts`**
（它只设过 `reasoning: true`，那只表示「会吐思维链」，**不是档位列表**）。

对比 Qoder：`qoderEffortsOf()` 报了它 ⇒ 有档位行。
**所以这不是上游差异，是我们漏了这个字段。**

### 上游其实**有**档位信息（Lead 真打 `/v3/config`，HTTP 200）

字段路径：**`data.models[].reasoning.supportedEfforts`**（可能带 `reasoning.defaultEffort`）。
**19 条模型带它**（`hy3: [low,high]`、`gpt-5.6-sol: 5 档`、`glm-5.2: [high,xhigh]`…），
而 `parseModelsFromConfig()` **完全没碰 `reasoning` 对象**（只读了窗口/图片/名字/倍率）。

### ② 不是 bug：DeepSeek 那两条上游**明确**只给一个固定值

```json
"reasoning": { "effort": "high", "summary": "auto" },
"onlyReasoning": true,        ← 连「关掉思考」都不允许
                              ← 注意：**没有** supportedEfforts
```
参考实现注释（原文）：`supportedEfforts` 是**可枚举**的等级列表，
**只在模型真正支持多等级时下发**；只有单一默认 effort 的模型此处缺省、**不暴露等级选择器**。

⇒ **没有 `supportedEfforts` 就必须继续没有档位行。**
给它编一组就是**谎报能力**：用户选了、上游 400，而他无从知道是插件编的。

（Qoder 的 DeepSeek 有 4 档含「关闭」，是因为 Qoder 目录**下发了** `efforts`
—— 同一模型在不同平台能力不同，属正常。）

### 请求侧的两条实测结论（照参考实现 `buddy-adapter.ts:1395-1418`）

- `reasoning_effort` **只发上游声明过的值**，否则服务端 400；
- ⚠️ **DeepSeek 系模型必须同时带 `thinking: { type: 'enabled' }`**：
  实测三站点一致 —— **只带 `thinking` 不生效**、**只带 `reasoning_effort` 才是真开关**，
  两者**都带**才返回思考。没选档位时要**补一个**（默认档 → `high` → 最低支持档），
  否则上游按「不思考」应答。

### ⚠️ 一个只有「真 wire」才抓得到的坑

请求体是 `{ ...payload, ... }` 拼的，而核心层在**拿不到我们的档位声明**时会
**原样放行**用户请求的档位 ⇒ `payload.reasoning_effort` 里可能有个该模型不支持的值。
适配器重算后若只写 `...(effort === undefined ? {} : {...})`，
**spread 不会删掉旧键** —— 非法值会留在 body 里、上游 400。
必须显式 `delete body.reasoning_effort`。已修并用 wire 用例钉住。

### 兜底表：**故意不补**静态档位

参考实现那张 `REASONING_EFFORTS` 表写着 `deepseek-v4.1-flash: [low,high,max]`，
而**上游今天根本没给这条模型档位** —— 正好证明静态表会漂移。
`FALLBACK_MODELS` 一行没动。

### 验证

| 项 | 结果 |
|---|---|
| 有档位的模型数 | ✅ **0 → 19**（独立探针 `.scratch/verify-buddy-efforts.mjs`） |
| DeepSeek 那两条 | ✅ **仍然没有档位行**（上游锁死单档，正确行为） |
| `hy3` / `gpt-5.6-sol` 档位逐条对照上游声明 | ✅ `[low,high]` / 5 档 |
| 没有任何模型拿到空数组档位 | ✅（空数组 = 谎报） |
| wire 请求体 8 个 case（含 `hy3+max` 被拦下、DeepSeek 补 `high`+`thinking`） | ✅ |
| 全量回归 | ✅ **478 宿主 + 63 客户端 + 冒烟** |

⚠️ 国内版仍只有单测（TLS 被劫持，非插件问题）。
⚠️ **没复测**：`reasoning_effort` 是否真的改变上游 `reasoning_content` 长度
—— 那是参考实现的三站点实测结论，本轮未复验。

---

## 🟢 #0q WorkBuddy 11128 渠道校验 + 倍率缺失（2026-10-20，已修并真机验证）

> 用户原话：「1.使用workbuddy国际版调用模型失败 '本轮运行失败{"code":11128,
> "msg":"request illegal",…"displayMsg":{…"zh":"请求被拦截，请重新发送"…},
> "displayTips":{…"This call failed channel verification, possibly because it was not
> sent from an offici'… 2.workbuddy和国际版拉取到的模型，倍率全是未知」

### 缺陷 A：11128 —— **错误文案是骗人的，两个子原因，第一个掩盖第二个**

**① 缺三个会话头**（Lead 用真实账号做 A/B，只差请求头）：

| 请求头 | 结果 |
|---|---|
| 我们原有的 10 个身份头 | ✗ 400 `code=11128` |
| ＋`X-Conversation-ID` | ✗ 400 `code=11128` |
| ＋**三个** conversation 头 | ✓ **200** |

必须**同时**带齐（缺任一都不行）：
`X-Conversation-ID` / `X-Conversation-Message-ID` / `X-Conversation-Request-ID`。
参考实现 `buddy-adapter.ts:1792-1796`，**只对国际版加**。我们一个都没有。

**② 首条消息必须是 `system`**（同样只有国际版强制）。
⚠️ **这一条在修好①之前根本看不出来** —— 修头前，所有情况都报同一句笼统的
`"Request blocked…(channel verification)"`，分不出原因；修头后 `msg` 才变具体：

| 消息形态（headers 已齐） | 结果 |
|---|---|
| 首条是 `user` | ✗ `11128` msg=**"first message is not system prompt"** |
| 首条是 `system`（中性 / 空串 / DSH 真实提示词） | ✓ 200 |
| system 里含内容指纹句 | ✗ `11128` msg=**"Illegal API invocation from an unapproved channel"** |
| 指纹句放在 `user` 里 | ✓ 200（印证参考实现：只拦 system） |

`src/llm/adapter.ts` 的 `toOpenAiMessages()` **只在 `options.system` 非空时才 unshift system**，
所以 system 为空时首条就是 `user` ⇒ 必踩②。已在国际版的 `requestChatStream` 里兜一层
（首条不是 system 就补一句最小可用的），**已有 system 原样保留、只对国际版做**。

**★ 本节最值得记的一条**：**同一个错误码在修掉第一层之前会掩盖第二层。**
而且参考实现里确实存在两个真·内容级机制（`account-probe.ts` 的首条 system 要求、
`tencent-fingerprint.ts` 的 system 模板句），特别容易误判 ——
Lead 一开始就把「首条必须是 system」当成**已排除**（因为修头前测它也是 400），
是修完头之后再测才发现它其实**也是真的**。

> ⚠️ 内容指纹那条**我们不需要处理**：DSH 的提示词不含该句，实测 DSH 真实
> system（完整 `prompt-inject.md`）返回 200。**不要顺手把剥离逻辑搬进来** ——
> 那是给上游加一条没人验证过的改写。

**为什么必须是那三个头**：文本里写着 *"not sent from an official channel"*，
是**渠道校验**（请求头身份），不是内容审核。

### 缺陷 B：倍率全是「未知」——根本没读 `credits`

上游 `/v3/config` 的 `data.models` **28 条，每条都有 `credits`**：
```
default-model            credits=""              ← 空串 = 未知（上游就没给）
fast-model               credits="x0.34 credits" ← 带单位后缀
deepseek-v4.1-flash      credits="x0.00"         ← 0 = 免费（合法值）
hy4-preview              credits="x0.29"
```
`parseModelsFromConfig()` **压根没读这个字段**，`FALLBACK_MODELS` 也没有倍率
⇒ 核心层拿不到 `multiplier` ⇒ 全显示「未知倍率」。

已照参考实现补齐 `normalizeCreditsRate` / `normalizeDiscountedRate` / `normalizeRate`
（**两套相反写法**：模型的 `credits` 是 `x` **在前**、促销的 `discountedCredits` 是 `x` **在后**，
**不能共用一个正则**，早期版本只认前缀导致促销价全部静默丢失）。

真上游读数：国际版 **28 条里 27 条有倍率**（唯一未知的 `default-model` 上游本就没给），
范围 `×0.03` ~ `×6.67`。

**三条硬要求**（都落进单测）：
- 解析不出 → `undefined`，**绝不回退成 `x1`**（编造倍率比不显示更糟）；单测断言
  **不能是 1、也不能是 0**；
- `"x0.00"` / `"0x"` → `0` + `free: true`（免费是合法值，不是缺失）；
- `credits=""` / 字段缺失 → **连 `multiplier` 键都不放**。

顺带修掉一个**只有真数据才暴露**的坑：`hy3` / `deepseek-v4.1-flash` 等
`credits` 本来就是 `x0.00`，活动又给 `factor: 0` ⇒ 拼出「免费→免费」这种零信息文案。
改成只在促销**真的改变了价格**时才写 description。

### `sessionId` 为什么不用随机值

`X-Conversation-ID` 同时是**前缀缓存的 key**（参考实现实测：同一段 8k 前缀，
不带它 `prompt_cache_hit_tokens=0`、`credit=0.34`；带上 `hit_tokens=7808`、`credit=0.02`
—— **费用差约 17 倍**）。所以**绝不能每次请求新值**。
参考实现「进程启动一次 UUID」在它那里够用（一进程一凭据），
我们一个适配器实例服务**多账号**，照抄会让不同账号共用一个 key ⇒
改为**按账号确定性派生**（`sha256('buddy:<agentId>:<accountId>')` 前 32 位十六进制，
与既有 `machineIdOf` 同款）：跨重启仍命中缓存、账号间天然隔离、且不用落盘。

### 验证

| 项 | 结果 |
|---|---|
| 走**适配器**真跑完整 chat（国际版） | ✅ 正文「收到」，三个头都在 |
| 不带 system（真实触发场景） | ✅ 守卫补上后 200（修前是 400） |
| 已有 system | ✅ 原样保留、未被覆盖 |
| 倍率真上游 | ✅ 28 条里 27 条有倍率；`default-model` 正确留在「未知」 |
| 反证：headers 齐但仍不带 system | ✅ 400 `"first message is not system prompt"` —— 证明守卫不是空动作 |
| 全量回归 | ✅ **452 宿主 + 63 客户端 + 冒烟** |

⚠️ **国内版全部只有单测**：`copilot.tencent.com` 在本机 TLS 握手失败
（`ERR_SSL_PACKET_LENGTH_TOO_LONG`；`curl.exe` 也失败 `SEC_E_INVALID_TOKEN`），
域名被解析到 `123.6.x` 的 `share.dnse5.com` ——
**本机网络 / DNS 劫持，不是插件 bug，不要去「修」它**。
因此国内版拉不到真模型，走**兜底表**，而兜底表**故意不带倍率**
（编一个就是骗用户）⇒ 国内版显示「未知倍率」是**当前正确行为**。

---

## 🟡 #0p 隐藏 Trae / 排除非厂商模型 / WorkBuddy 登录（2026-10-20）

> 用户原话：「1. Sonus、Auto这些不是厂商的模型，直接排除掉
> 2. workbuddy授权登录后，并没有加入账号进来 WorkBuddy International也是同样的问题
> 3. trae没有实现，把trae直接隐藏掉」

### ① Trae 隐藏（✅ 已改）

- `src/config.ts` 的 `DEFAULT_VISIBLE_AGENTS` 去掉 `'trae'`。
- **隐藏 ≠ 删除**：`TraeAdapter` 仍在注册表里、`IMPLEMENTED_IDS` 里也仍有它，
  只是默认 `visible=false` + `enabled=false`，于是 `isAgentActive()` 为假
  ⇒ 不注册 provider、不进模型选择器、设置页不露出。将来真机验证过，
  把 `'trae'` 加回那一行即可。
- `visible` 是 volatile 字段，**显式配置优先于默认值** ——
  用户若在 `cordis.patch.yml` 里写了 `agents.trae.visible: true` 仍会显示
  （「默认值」与「强制值」是两件事）。已用测试钉住这条边界。
- 验证：`.scratch/verify-trae-hidden.mjs` 14/14；`test/unit.test.mjs` 新增一条回归
  （同时钉「默认隐藏」「其余 5 个不受连累」「协议层仍在」「显式配置可覆盖」）。

### ② 排除非厂商模型（✅ 已改）

- 排除了 6 条：`auto`(Auto)、`ultimate`(Ultimate)、`performance`(Performance)、
  `efficient`(Efficient)、`smodel`(Sonus)、`cmodel`(Cantus)。
  这些是 Qoder 自己的**档位 / 路由名**，不是厂商模型。
- **依据是官方的，不是靠名字猜的**：Qoder 官方文档把两者分成两张表，
  标题原文就是「Choose a **tier**」与「Select a specific model」，
  且官方档位倍率与本表 `priceFactor` **逐条精确命中**
  （Auto ~0.5×/0.5、Ultimate ~2.0×/2、Fast 原 Performance 1.1×/1.1、Efficient ~0.3×/0.3）。
  另有官方公告《Qoder Tier Upgrade: Performance Becomes Fast》，
  正文写明 *"A tier lets Qoder **route by policy**"* —— 路由语义，不是具体模型。
- **实现是「不上报」而不是「删除」**：新增 `QODER_NON_VENDOR_MODEL_IDS` +
  `isVendorModel()`，在 `getModelMetaList()` 里一行 `.filter()`。
  底层条目一条没删（协议层照旧认识它们），
  按 id 查表的 `effectiveMultiplier` / `qoderEffortsOf` 对 6 个 id 仍正常
  —— 否则「用户以前勾选过 `smodel`」会变成**悬空引用**。
- 选常量集合而非逐条加标记，是因为**未登记 id 默认放行**：
  将来上游新增厂商模型会默认显示，而不是被静默隐藏（隐藏新模型用户根本发现不了）。
- 验证：两个产品现在都恰好上报 **11 条厂商模型**、零档位泄漏
  （`.scratch/probe-picker-ids.mjs`）；`test/adapters/qoder.test.mjs` 42 → 51 条。

### ③ WorkBuddy 登录（🟡 buddy-dev 在处理）

- **登录是四步，我们只做了两步**。参考实现 `runBuddyLoginFlow`：
  `fetchAuthState → decorateLoginUrl → loopGetToken → getAccount → buildCredential`，
  我们缺 `decorateLoginUrl` 与 `getAccount`。
  - `getAccount`（参考 `buddy-oauth.ts:231-290`）：
    `GET {endpoint}/v2/plugin/login/account?state=<state>` ——
    **账号信息（uid / 企业 / 域）在这一步才拿到**。
  - `decorateLoginUrl`：国际版必须给登录 URL 追加 `version` + `loginSessionId`，
    国内版不追加；**只追加参数、不得重建 URL**。
    我们全仓没有这个逻辑 ⇒ 极可能就是「授权完仍是 pending」的直接原因。
- ⚠️ **国内版在本机打不通**（实测）：`copilot.tencent.com` 的 TLS 握手失败
  （`ERR_SSL_PACKET_LENGTH_TOO_LONG`；`curl.exe` 同样失败 `SEC_E_INVALID_TOKEN`）。
  该域名被解析到 `123.6.x` 的 `share.dnse5.com` ——
  **本机网络 / DNS 劫持，不是我们的 bug，不要去「修」它**。国内版只能单测。
  国际版 `auth/state` 实测可用（HTTP 200）。
- ⚠️ 上游用 **`HTTP 200 + body.code`** 报「还没好」：
  `{"code":11217,"msg":"11217:login ing..."}`。
  现有代码只在**非 200** 时读 `code === 11217`，靠 `unwrapData` 返回 null
  这个**副作用**恰好判对 —— **行为对但很脆**，已要求改成显式判 `body.code`。

### ④ ★ 顺带发现一个既有接线缺陷（未修，待用户决定）

`src/adapters/qoder.ts` 的 `QODER_CN = { ...QODER, … }` 摊开的是**国际版**产品对象，
所以 **`qoder-cn` 实际用的是国际版那 17 条表**，`vendor/qoder/qoder-product.ts` 里
那份**真正的 CN 表（14 条）从来没被用上**。

Lead 独立复核（读构建产物）：
```
vendor 国际版表条数: 17
vendor CN 表条数   : 14
适配器 QODER_CN 实际用的表条数: 17
适配器 CN 用的是不是国际版那份？ true
CN 独有、国际版没有的 id: [ 'q37fmodel', 'gm51model' ]
```

后果：CN 独有的 `q37fmodel`(Qwen3.7-Flash) 与 `gm51model`(GLM-5.2) 用户**看不到**；
`mmodel` 显示成国际版的 **MiniMax-M3**，而 CN 实测是 **MiniMax-M2.7**；
两个产品上报的列表**逐条相同**（各 11 条）—— 这就是最直接的证据。

**没有擅自修**：修它会**改变用户可见的模型列表**（CN 多出 2 条、`mmodel` 改名），
属于产品决策，等用户拍板。

---

## 🟢 #0o 请求日志缺「业务路由字段」+ 日志显示上游目录 key（2026-10-20，已修并真机验证）

> 用户原话（同时纠正了上一轮的误判）：
> 「1. 请求日志的模型名全部都是 'qfmodel'，并不是真实选中的模型名称。
> 2. **上游没问题，我在 Qoder CN 客户端中使用这两个模型就没问题**」

### ★ 用户是对的，我上一轮判断错了

上一轮我把 `qfmodel` / `dfmodel` 的 `[FAIL]…Execution failed` 归因为
**「这两个模型在上游本身就是坏的」**（#0n 的「遗留」一节就是这么写的）。
**这个结论是错的。** 用户用官方客户端实测这两个模型完全正常，
而抓包与源码都指向同一个被漏掉的字段。

**真因：请求体缺 `business`。**

服务端按 `business.type` 选路由池（源码 `MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`），
**缺字段会走异常分支** —— 把请求路由到故障节点 `oa_qwen-plus-2025-04-28`，
回 `[FAIL]node:… msg:Execution failed`。

三个「极易误判成上游故障」的假象：

| 假象 | 真相 |
|---|---|
| 报错里的节点是 **`qwen-plus`**，与我们发的 `qfmodel` 对不上 | 那正是「**被路由到了别的节点**」的指纹，不是「这个模型坏了」 |
| 只有 `qfmodel` / `dfmodel` 踩中，`auto` / `qmodel_38max` 恰好正常 | 换池路由对**部分模型**恰好无害，于是看起来像个别模型的服务端故障 |
| 官方 IDE / 客户端里同一模型完全正常 | 官方客户端**带了** `business`，我们没带 |

⚠️ 参考实现的注释里**早就写明了这一条**，而且连现象描述都一样
（「`qfmodel` 曾因此被误判为『服务端故障』（而 IDE 里同一模型完全正常）」）。
我们移植时漏了这个字段 —— **「上游报错」不等于「上游有问题」，
先确认自己发的东西和官方客户端一致。**

**修法**：`prepareInfer({ …, business: { type: 'agent' } })`（与参考实现一致）。
一行修复，`qfmodel` / `dfmodel` / `auto` 三个模型真机全部出正文。

### 缺陷 B：日志显示的是上游目录 key，不是用户看到的名字

- **用户看到**：选择器里写着 `Qwen3.8-Flash`，日志里却全是 `qfmodel`。
- **真相**：记录**没错** —— `qfmodel` 就是目录 key、也正是发上游的值。
  问题是它**在界面上不可见**，两套词汇对不上，用户自然认为记错了。
  （已验证：17 个模型的 id 全部唯一、`encode/decode` 往返一致、
  日志忠实记录 DSH 传进来的值 —— 所以这不是「记错了」，是「读不懂」。）
- **修法**：采样**同时记两个字段** ——
  `model`（目录 key，排查时看的仍然是它）+ `modelName`（展示名，与选择器一致）；
  界面优先显示 `modelName`，把 key 放进 `title`；
  取不到展示名时**不写**这个键、退回显示 id —— **绝不拿 id 冒充名字**。

### 验证

| 项 | 结果 |
|---|---|
| `qoder-cn/qfmodel` 真机 | ✅ 出正文「你好」（修前是 `Execution failed`） |
| `qoder-cn/dfmodel` 真机 | ✅ 出正文 |
| `qoder-cn/auto` 真机 | ✅ 出正文（没被改坏） |
| 变量对照（`.scratch/probe-qfmodel-vars.mjs`） | ✅ 加 `business` 前后 8 个组合全部由 ✗ 转 ✓ |
| 日志 id ↔ 展示名 | ✅ `.scratch/probe-logged-model.mjs` `modelName=Qwen3.8-Flash` |
| 选择器 id 唯一性与往返 | ✅ 17/17 唯一、`encode→decode→encode` 全部一致 |
| 全量回归 | ✅ **387 宿主 + 63 客户端 + 冒烟** |

### 一条方法教训

**「上游报错」≠「上游有问题」。** 判断前必须先证明
「我们发的东西与官方客户端一致」。本轮两个假象（节点名对不上、只有部分模型失败）
都被我当成了「上游故障」的证据，其实它们恰恰是「我们漏了字段」的证据。
**参考实现注释里已经写过的坑，移植时要逐条对照，不能只抄正常路径。**

---

## 🔴 #0n Qoder CN 的模型「没有回复，直接显示已完成」（2026-10-20 —— **根因见 #0o**）

> ⚠️ **本节的现象描述仍然有效，但「上游侧遗留」那个结论已被 #0o 推翻。**
> 真正的原因是**请求体缺 `business`**，不是上游模型坏了。修在 #0o。

> 用户原话：「此对话选择 Qoder CN 的模型，发送消息后，没有显示收到回复，
> 直接显示了已完成。Qoder 平台下的模型就没问题」

### 现象与定位

- `qoder-cn` + `qfmodel` / `dfmodel` 发消息 → **界面显示「已完成」但一个字都没有**；
  同一账号的 `qoder`（国际版）正常，`qoder-cn` 的 `auto` 也正常。
  `requests.jsonl` 里那几行是 `ok:true` **且没有 `ttftMs` / token** ——
  「成功但零正文」的指纹。
- 抓原始帧（`.scratch/probe-raw-frames.mjs`，包一层 `ctx.fetch`）看到上游在
  **HTTP 200** 的流里回业务错误：
  ```
  {"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null",
   "statusCodeValue":400,"statusCode":"BAD_REQUEST"}
  ```
  也就是说 **`qfmodel` / `dfmodel` 这两个模型在上游侧本身就是坏的**。

### 根因（我们的缺陷：把错误静默丢掉了）

`unwrapQoderEnvelopeStream` 把这帧**保真**转成
`{code, message, type:'model_error'}`（这一步是对的），
但 `src/core/sse.ts` 的 `translateChunk` **只认 `parsed.error`**：

- 没有 `error` 字段 → 不命中；
- 没有 `choices` → 也不命中；
- 于是整帧被当成「**合法但空的 chunk**」丢掉，流随后照常 `finish(stop)`。

DSH 收到「成功 + 零正文」⇒ 界面上就是「已完成，没有回复」。

**这比直接报错危害大得多**：报错用户至少知道要重试，
**静默成功会被当成模型真没话说**。

### 为什么移植时会漏

参考实现（`.scratch/dsh-our-free-model/.../openai-compat.ts`）对同一形态**有显式分支**，
注释里写着：

> 若只判 `statusCodeValue >= 400`，**整帧会被静默丢弃**
>（真实缺陷：网关形态的排队错误因此既不被识别、连报错都没有）

即参考实现早就踩过这个坑并修好了，我们移植 `translateChunk` 时**漏了那条判据**。

### 已改

`translateChunk` 增加「网关形态 / 信封剥离后」的错误分支，判据覆盖两种来源：
- `type === 'model_error'`（**信封剥离后 `statusCodeValue` 已被吃掉**，只判状态码会漏）；
- `statusCodeValue >= 400` 或带 `stackTrace`（直连网关时的形态）。

同时把 `message` / `statusCodeValue` / `stackTrace` / `type` 加进 `OpenAiChunk`
（它们不在 OpenAI 协议里，是这条链路自己的形状，声明出来免得到处 `as` 强转）。

### 顺带修掉一个既有的会崩的边界

`translateChunk('null')` 原先**直接抛**
`Cannot read properties of null (reading 'error')` —— `JSON.parse('null')` 得到 `null`，
而后面每处都读 `parsed.xxx`。

这条路径**真的会走到**：Qoder 信封里 `body: null` 的心跳帧经 `JSON.stringify` 就是
字符串 `'null'`。目前没炸只是因为 `classifyInner` 在**上游**把心跳提前丢了 ——
但 `translateChunk` 是导出给所有适配器用的通用函数，
任何人直接喂它一帧 `null` 就会抛，而异常会一路冒到流消费处，
把「跳过一帧」升级成「整轮对话失败」。
**通用解析器不该依赖调用方替它挡住非对象 JSON**。已加一道非对象短路。

### ⚠️ 防过度修正

新分支必须**只**认真正的错误帧，否则正常对话会被中断。已钉住边界：
- 正常 `choices` 帧 → 照常出正文；
- 只有 `message`、既无状态码也无 `type`/`stackTrace` 的帧 → **不算错误**（返回空数组）；
- 心跳帧（`null` / `{}`）→ 仍返回空数组（**issue IKJOZ8 不能回归**）。

### 验证

| 项 | 结果 |
|---|---|
| 端到端（真实信封字节 → `unwrapQoderEnvelopeStream` → `iterateSse`） | ✅ `.scratch/verify-envelope-error.mjs` 7/7 |
| `qoder-cn/qfmodel` 真机复打 | ✅ 现在**报出上游原文**而不是静默成功 |
| `qoder-cn/auto` 真机复打 | ✅ 正常出正文（没被误判成错误） |
| 全量回归 | ✅ **383 宿主 + 62 客户端 + 冒烟** |
| 真机界面 | ⏳ 待重启 DSH 后确认「报错文案真的显示出来了」 |

### ~~遗留（上游侧，不是我们的 bug）~~ —— **此结论已作废，见 #0o**

> ⚠️ 我原先在这里写「`qfmodel` / `dfmodel` 在上游本身就是坏的」，
> **这是错的**。用户用官方客户端实测这两个模型完全正常。
> 真因是**我们的请求体缺 `business` 字段**，导致请求被路由到故障节点。
> **一行修复即可，不需要等上游。** 保留这段是为了记住这个误判。

~~`qfmodel` / `dfmodel` 在上游**本身就是坏的**（`Execution failed: null`）。
我们现在的正确行为是**把上游原文如实报出来**。用户若想用这两个模型，
得等上游修；换 `auto` / `qmodel_38max` / `cmodel` 是好的。~~

本节的另一部分（**错误帧不能被静默丢掉**）**仍然有效且已修** ——
它保证的是「以后任何上游错误都会如实报出来」，与根因是什么无关。

---

## 🟡 #0m 第四轮真机反馈：提示不消失 / 任务流水 NaN / 日志三列空 / 侧栏入口（2026-10-20，代码全改完待真机）

> 用户原话（重启 DSH 后实测，三条已修的先确认有效：开关画对了、额度 900 积分、
> 签到成功）：
> 「1. 切换选项卡后，这个提示在顶部一直存在。2. 任务中 时间为 NaN。3. 日志中 速度，
> 输入，输出为 - 倍率为未知。4. 能否参考我现在已经安装的插件市场的这个插件，
> 在上面有个提示，是否添加到左侧导航栏进行管理，如果添加后，像这个插件市场一样，
> 直接加到此处」

### 缺陷 A：动作提示跟着用户跑到别的页面（✅ 已改）

- **现象**：点「刷新额度」后顶出一条「1 个账号额度已更新…」，切到「任务」页它还在。
- **根因**：`actionMessage` 是**一次性**反馈（「刚才那一下干了什么」），属于触发它的那一页；
  但 `setPage()` 没清它，`noteHTML()` 又无条件渲染。
- **已改**：`setPage()` 里清掉 `actionMessage`。
- **验证**：`test/client.test.mjs` 有回归用例（走真实 `run` → 切页 → 断言消失）。

### 缺陷 B：任务流水的时间画成「NaN:NaN:NaN」（✅ 已改，两个叠加的原因）

- **根因一（字段名读错）**：宿主 `TaskLogRecord`（`src/core/tasks.ts:42`）写进 task-log 的
  字段是 **`at` / `message` / `credits`**，而客户端读的是 **`ts` / `detail` / `error`** ——
  三个全错。于是时间取到 `undefined`、详情列永远空白。
- **根因二（兜底是假的）**：`clockText()` 只 `try/catch`，但
  **`new Date(undefined)` 与 `new Date(NaN)` 都不抛异常** —— 它们产出 Invalid Date，
  `getHours()` 返回 `NaN`，于是「兜底」根本没兜住，直接画成 `NaN:NaN:NaN`。
- **已改**：读 `job.at`（保留 `ts` 兼容）；`clockText` 先判 `Number.isFinite(ts) && ts > 0`
  再判 `Number.isNaN(d.getTime())`，取不到就画「—」；详情读 `message` 并把 `credits` 标成 `+100`。
- **验证**：回归用例用**从本机真实 `task-log.jsonl` 抄下来的行**做 fixture；
  另有一条专门喂 7 种非法时间戳（`undefined`/`null`/`NaN`/`0`/`-1`/`'abc'`/`{}`）断言不出现 NaN。

### 缺陷 C：日志页「速度 / 输入 / 输出」为 —、「倍率」未知（✅ 已改）

- **根因（宿主侧，三处，比最初判断的更靠后一层）**：
  1. **`settle()` 根本没放 `multiplier` / `free`** —— `RequestLogEntry` 有这两个字段、
     客户端也在读，但采样时从来没写过。
  2. **`startedAt` 取晚了**：原先它在 `router.execute` **之后**取，于是
     `ttftMs` 恒为 **0**、「等首字」那整段被排除在计时外，`durationMs` 只算
     「首字之后」（实测 679ms vs 真实 2044ms）。这一条决定了「速度」列。
  3. **usage 帧排在 `finish` 之后** —— 实测帧序
     `… #16 text → #17 finish(stop) → #18 usage{input:15, output:54}`，
     usage 比 finish **晚 17ms**；而 `case 'finish'` 里 `settle()` 后直接 `return`，
     那一帧**永远读不到** ⇒ `inputTokens` / `outputTokens` / `tps` 恒缺。
- ⚠️ **我最初的判断是错的，记在这里免得后人重走**：我以为是「Qoder 没请求
  `stream_options.include_usage`」。**真打上游 5 个模型对照后否掉了**——
  Qoder **本就会**下发 usage 末帧，带不带这个字段都一样（带上一律 200、
  没有一次 400，但**完全是多余的**）。所以**故意没加**它，理由与实测表写在
  `src/adapters/qoder.ts` 的注释里。**别再回头加这个字段。**
- **已改**：`settle()` 补倍率（三态：有倍率 → 两键都写；没倍率但上游标免费 →
  只写 `free:true`；**都没有 → 两键都不写**，绝不拿 0 冒充未知）；
  `startedAt` 前移到 `router.execute` 之前；`finish` 改成「**收尾但不结束**」
  （关块 + 最多再等 `USAGE_DRAIN_MS = 250ms` 只为收那一帧 usage，然后才 `settle()`
  并补发 usage chunk）；抽出**幂等**的 `closeBlocks()` 给三条收尾路径共用
  （否则 finish 后 drain 窗口内又来 error 会关两次块，第二个空正文的 `block-end`
  正好又踩「覆盖式赋值冲掉正文」那条老坑）。
- **顺带修**：「上游断流没给 finish」原先**块根本不关**（正文丢一截）。
- **真实落盘对照**（字段数 7 → 14）：
  ```json
  {"agentId":"qoder-cn","model":"auto","ok":true,"durationMs":2431,"ttftMs":2030,
   "inputTokens":15,"outputTokens":37,"reasoningTokens":34,"multiplier":0.5,
   "free":false,"tps":92.3}
  ```
- **延迟代价已量化**（真上游跑 3 次）：最后一个 block-end → 流真正结束，
  推迟仅 **11 / 2 / 16 ms**，用户感觉不到。
- ⚠️ **超时判据必须在 `iterator.next()` 那一层用 `Promise.race`**，
  不能写成循环体里的 `if (Date.now() > drainUntil)` ——
  `for await` 卡在 `next()` 上时循环体根本不执行，那种写法对着
  「发完 finish 就挂住连接」的上游会**永远等下去**。已用「永久挂住的假适配器」
  钉了一条回归（实测 259ms 收尾）。

### 缺陷 D：入口加进左侧导航栏（✅ 已改）

- 参考用户已装的 `dshmarket`（v1.66.42，截图里那个插件市场）。
  **两个槽位必须成对注册、共用同一个 id**：
  `main`（keyed，key = 面板 id）= 点侧栏后右侧显示什么；
  `sidebar.panellist`（list，id = **同一个字符串**）= 左侧那一行。
  宿主靠这两个值相等把「点了哪一行」与「渲染哪个面板」对上；不等就是
  「侧栏多一行、点了没反应」**且不报错**。
- **三态语义**：`chosen`（用户表过态没有）与 `enabled`（他要不要）是两件事。
  「没回答过」≠「选了关」—— 只存一个布尔的话，「默认显示」永远做不到。
  默认值口径：**没回答过时，只有当侧栏是唯一入口才显示**（设置页入口在时不抢那一行）。
  坏数据 / localStorage 抛异常一律退化成「从没回答过」——
  误判成「选了关」会让入口**永久消失**且用户不知道自己何时关过。
- **防竞态用 `epoch`**：慢的初始 load 回来时对不上号就整个丢掉。
- **持久化用 localStorage**，没加配置字段（加 volatile 要改宿主并重建 `lib/`）。
- **优雅退化**：`ctx.slots.inject('sidebar.panellist', …)` 的契约是「等这个槽位被声明」，
  旧宿主上**一次都不执行** → 两个槽位一个都不注册、不抛错，设置页入口照旧，
  设置页那张卡片画出 disabled 开关 + 诚实说明缺哪个槽位。
- **`order: 20`** = 排在宿主自带的「插件」(0) 与「定时任务」(10) 之后。
- ⚠️ 侧栏**视觉观感**（图标位置/配色）没在真机核对 —— 图标是自绘 SVG
  （require 宿主图标集要改 `package.json` 的 externals）。需要刷页面看一眼。

### 缺陷 E：`test/adapters/opencode.test.mjs` 的假 router 形状是错的（✅ 已改）

这一条是**修 C 时被顶出来的既有假通过**，值得单独记：

- 该测试的假 `router.execute` 写的是 `value: await run(…)` —— 把 `run()` 的
  **整个返回对象**（`{ok, value:{events}}`）又塞回 `value`，于是
  `outcome.value.events` 是 `undefined`。真 router 是
  `return { ok: true, value: outcome.value, … }`（`src/core/router.ts:305`），
  **要解开一层**。
- 它一直没暴露，是因为旧 `pump` 把「取迭代器」放在 `try` 里，那个 TypeError
  被 catch 当成「上游报错」，而测试只断言「发出了什么 effort」、不看结果 —— **假通过**。
  修 C 把迭代器挪到 `try` 外，才把它顶出来（5 条档位用例一起红）。
- **定位方法**（可复用）：开一个 `git worktree` 到 HEAD 跑一遍确认干净 →
  把工作区的 `lib/llm/adapter.js` 注入进去 → 5 条复现 ⇒ 锁定是那个文件。
- 已按真 router 的形状修好 fixture，并把这段经过写进测试注释。

### 本轮的验证强度（诚实记录）

| 项 | 手段 | 结果 |
|---|---|---|
| 全量回归 | `npm test` | ✅ **382 宿主 + 62 客户端 + 冒烟** |
| 构建一致性 | `build --check` / `client.js` vs `lib/client.js` hash | ✅ exit 0 / identical |
| 采样与倍率 | 真上游落盘 `requests.jsonl`（7 → 14 字段） | ✅ 见上 |
| `stream_options` 假设 | 真打 5 个模型做带/不带对照 | ✅ **假设被否掉，故意不加** |
| drain 延迟 | 真上游 3 次量化 | ✅ 11 / 2 / 16 ms |
| 侧栏槽位成对注册 | 独立探针 `.scratch/verify-sidebar.mjs` | ✅ 7/7 |
| 侧栏三态 + 防竞态 | 同上（直接驱动控制器） | ✅ 5/5 |
| 旧宿主退化 | 同上 | ✅ 3/3 |
| localStorage 坏掉 | 同上（4 种坏输入） | ✅ 4/4 |
| NaN / 提示不消失 | 独立探针 `.scratch/verify-round6.mjs` | ✅ 7/7 |
| 侧栏**视觉观感** | **未做** —— 需刷页面人工看 | ⏳ |

### 一条方法上的教训（第二次了，写下来）

**「全绿」不等于「测到了」**，本轮又抓到一类新花样：**假 fixture**。
`opencode.test.mjs` 的假 router 形状不对，而旧代码用 `try` 把异常吞了，
于是测试**一直是绿的**、测的却不是真东西。三个 teammate 合计跑了
**12 组变异测试**（4 + 8），另有多次「真打上游对照」把**我自己写错的根因判断**
否掉（`stream_options` 那条）。

**结论**：凡要证明「某条链路修好了」，用例必须**从头走到尾**
（真实入口 → 真实派发 → 真实结果），且**假替身必须复刻真契约的形状** ——
形状错了不报错，只会静默地测错东西。

## 🟡 #0l 任务页两个开关「不生效」+ 额度没有手动刷新入口（2026-10-20）

> 用户原话：「1.任务列表下的 每日签到 和 活动任务按钮不生效
> 2.账号的额度未拉取，能否加个按钮，手动可以刷新额度」

### 缺陷 A：任务页的开关恒画成关闭（🟡 已改，待真机确认）

- **现象**：切到「任务」页，「每日签到」「活动任务」两个开关**永远画成关闭**、
  徽标永远「已关闭」；点它们也看不出效果。同一个页面的 4 个 kv（签到时间 /
  轮询间隔 / 并发上限 / 失败暂停）也**永远显示兜底默认值**，与真实配置不符。
- **根因**：`tasksHTML()` 里的 `valueOf()` 读 `hit.state?.value`，但
  `GatewayPanel.fieldState()` 给的是 **bool → `{checked, changed}`、
  其它 → `{text, changed}`**，两种都没有 `.value`。于是 `textOf(undefined) === ''`，
  `onOf()` 恒为 `false`。**全文件 grep `.state?.value` 只有这一处** ——
  设置页（`fieldRowHTML`）早就用对了形状，任务页漏改。
- **真实回路（比「开关坏了」更准确）**：`onSwitchClick` 的取反依据是
  `hit.state?.checked`（**形状本来就是对的**），而坏的只有渲染。所以交互方向
  正确交替，但**界面画的值与真实值相反**。后果是：配置里本来开着的签到，
  用户看到的是「已关闭」，照着界面点一下反而把它**悄悄改成关**；再点一下才回来。
  用户感知就是「点了没生效」。
  ⚠️ 早期把这条误判成「取反依据也坏了、永远算成 true」，是错的 ——
  `onSwitchClick` 从来没读错形状，别再照那个错版本去改。
- **已改**：`tasksHTML` 按真实形状取值（`stateOf` / `onOf` / `valueOf` 三个小函数），
  口径与 `fieldRowHTML` 完全一致。
- **顺带修掉的一条既有缺陷**：`inject().run` 只声明了 **3 个形参**
  `(label, method, input)`，而调用方一直按 4 个实参写
  （`props.run(label, method, input, describeXxx)`）—— 第 4 个被**静默吞掉**，
  `run()` 里 `typeof describe === 'function'` 永远为 false。
  也就是说 **`describeCheckIn` 从写出来那天起就没生效过**，签到一直只显示
  「签到 完成」，用户分不清「领到了」与「今天已领」。现已转发 `describe`。
- **还差**：真机确认开关翻面、徽标与 kv 显示真实值。

### 缺陷 B：额度只能等定时拉取，没有手动入口（🟡 已改，待真机确认）

- **现象**：账号页「额度」列一直是「未拉取」，用户没有地方可以主动拉一次。
- **根因（两层）**：
  1. 宿主的 `refreshQuota` 端点**早就存在**，客户端的 `ENDPOINTS` 数组里也有，
     但**整个客户端没有任何按钮、也没有 click 分支调用它** —— 纯粹是入口漏了。
  2. `quotaView()` 把三种截然不同的情形画得几乎一样：`remaining: 0` 给**绿色 ok**
     语气、`quota.error` 塞进大多数调用点根本不渲染的 `hint` 里、
     上游真的会下发的 `extra.isQuotaExceeded` 从没露过面。于是「没拉到」
     「拉到了真的是 0」「已用尽」在界面上分不开。
- **实测依据**（2026-10-20，本机真实 qoder 账号，探针 `.scratch/probe-quota-shape.mjs`）：
  `GET https://openapi.qoder.sh/sash/api/v2/me/usage` → 200，
  `userQuota = {total:0, used:0, remaining:0}`、**`addOnQuota` 字段不存在**、
  `isQuotaExceeded: true`、`displayMode: "qoder"`。
  也就是说这个账号回的就是 **0**，我们**没有读错层** ——
  但 `isQuotaExceeded: true` 这条上游判定以前完全没显示出来。
  （CN 账号的余额在 `addOnQuota`，见 #0k；两个产品的响应形状不同，别互相套用。）
- **已改**：
  - 宿主 `refreshQuotas()` 支持按**单账号**刷新：`{ accountId }` 优先且
    **不过滤 `enabled`**（用户点名要刷就刷；不存在则返回空数组、不抛错）；
    `{ agentId }` → 该平台启用账号；都缺省 → 全部启用账号。
    返回项字段是**冻结契约**（客户端按它渲染），逐字段钉在 `test/quota-refresh.test.mjs`。
  - 客户端账号页加两个入口：卡片头「刷新额度」（不带 `data-id` → 刷本平台全部）、
    每个账号行「刷新额度」（带 `data-id` → 只刷那一个）；
    新增 `describeQuotaRefresh()` 把结果翻成「N 个账号额度已更新：主号 858 积分、
    小号 0 积分（已用尽）。第一个失败原因：…」。
  - `quotaView()` 分四种状态且都给 tone，hint 一律带「上次拉取 <时间>」；
    账号行的额度挂 `title`，悬停能看原因。
  - **额度的 tone 以前是「死的」**：`quotaView` 早就算好了 tone，但调用点只取
    `.text`，于是「已用尽（warn）」和「一切正常（ok）」在屏幕上**长得一模一样**
    —— 用户报的「分不清」正是这么来的。现改用 `quotaBadge()` 把 tone 真正画出来
    （`quotaText()` 已无引用，一并删掉）。
- **还差**：真机点一次按钮，确认账号表里额度从「未拉取」变成具体数字、
  且提示语说清了是「0（已用尽）」还是「拉取失败：<原因>」。

### 本轮的验证强度（诚实记录）

| 项 | 手段 | 结果 |
|---|---|---|
| 宿主筛选语义 | 从**构建产物** `lib/` 走真实 `GatewayRuntime`，6 项断言 | ✅ 全过 |
| 宿主返回形状 | 逐字段断言 + 变异测试（4 个变异体各自被抓） | ✅ 全过 |
| 客户端渲染 | 独立探针 `.scratch/verify-tasks-switch.mjs` | ✅ 全过 |
| 客户端修复 | 8 组变异测试（每处单独改回坏的样子） | ✅ 8/8 被抓 |
| 全量回归 | `npm test` | ✅ 368 宿主 + 49 客户端 + 冒烟 |
| 真上游额度 | `multiagent_quota refresh=true`（本机 qoder 账号） | ✅ 形状与冻结契约一致 |
| 真机界面 | **未做** —— 需要重启 DSH 后人工点一次 | ⏳ |

### 一条方法上的教训（值得留着）

「全绿」不等于「测到了」。本轮有三个用例一开始是**假通过**，都是靠**变异测试**
（把修复单独改回坏的样子，看用例是否真的变红）才发现的：

1. 「点击分发」那条用 `panel.toggle()` 直接调控制器，**绕过了 `onSwitchClick`
   与根节点 click 监听** —— 而缺陷的原发地正是那条派发路径；
2. `run.length >= 4` 只证明**形参个数**，证明不了 `describe` 真的流到
   `actionMessage`（bug 恰在转发那一层）；
3. `description` 里的两个「锚点」在原文里根本不存在（记错了），
   照抄描述写出来的断言测的不是真东西。

**结论**：凡是要证明「某条链路修好了」，用例必须**从头走到尾**（真实入口 →
真实派发 → 真实结果），不能从中间某层接进去。

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
