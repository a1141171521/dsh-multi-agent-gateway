# 模型分组与倍率标签

这一份讲**「模型分组 + 倍率标签必须作用在 DSH 对话框原生模型下拉选择器」**
是怎么做到的 —— 以及为什么只能这么做。

---

## 1. DSH 模型选择器的真实数据流

从宿主源码核过（`@deepseek-ai/dsh-api-session-controller/lib/types/catalog.js`
的 `buildModelCatalog()` + `@deepseek-ai/dsh-client-ui-model-selection`）：

```ts
// 宿主：把「每一个已注册的 provider 路由」变成一个分组
const providers = ctx.llm.listProviders()            // [{ id, name }]
for (const provider of providers) {
  const models = await ctx.llm.listModels(provider.id)
  yield { kind: 'group', group: { id: provider.id, name: provider.name, models } }
}
// 客户端：MenuGroup(label = group.name) 渲染分组标题，model.name 渲染每一行
```

也就是说，选择器里**只有三样东西是我们能控制的**：

| 我们控制的 | 落到哪 |
|---|---|
| `providerInfo(provider).name` | **分组标题**（`OpenCode` / `Qoder` / …） |
| `listModels()` 返回的 `model.name` | **每一行的字**（倍率标签就在这里） |
| `listModels()` 返回的 `model.id` | 传给 `stream()` 的 model 参数 |

**没有任何「分组」字段可以填。** DSH 原生选择器的分组就是 provider 路由。
所以本插件的做法是唯一可行的做法：

> **一个 Agent 注册一个 provider 路由**（`multiagent-opencode`、`multiagent-qoder`…），
> 它的 `name` 就是分组标题；模型名里带倍率标签。

---

## 2. 分组：一个 Agent 一条 provider 路由

```ts
// src/index.ts
for (const agentId of runtime.registry.ids()) {
  if (!active) continue                                  // ← 未启用就干脆不注册
  const provider = `multiagent-${agentId}`               // multiagent-opencode
  llm.registerAdapter([provider], createLlmAdapter({
    agentId,
    displayName: 'OpenCode',                             // ← 分组标题
    labelWithAgent: true,
    ...
  }))
}
```

两条纪律：

1. **未启用的 Agent 不注册路由**。注册一条空路由只会让选择器里多出一个空分组
   （用户会以为坏了）。
2. **一条路由只能有一个 adapter**。重复注册会抛 `DUPLICATE_ADAPTER`，
   所以我们用 try/catch 包住并把失败写进日志，而不是让整个插件起不来。

## 3. 模型 id 的编码

选择器里选中的 id 会原样传给 `stream(options)`。因为一个 adapter 只服务一个
Agent，本来可以直接用上游模型 id；但为了**将来能把多个 Agent 合成一条路由**
（或者 UI 层面需要区分来源），这里统一编码成：

```
<agentId>/<上游模型 id>
```

例如 `opencode/deepseek-v4.1-flash-free`。`decodeModelId()` 反解回
`(agentId, upstreamModelId)`，`stream()` 里再拆开。

> 注意上游模型 id 自己可能带 `/`（例如 `openai/gpt-5.6-luna`），
> 所以反解只切**第一个** `/`。

## 4. 倍率标签：格式与口径

### 格式

任务书要求的形态是 `OpenCode · DeepSeek-R1 (×2)`，实现就是：

```ts
// src/llm/adapter.ts
export function renderModelLabel(meta, withAgentPrefix) {
  const tag = formatMultiplier(meta.multiplier, meta.free)
  const head = withAgentPrefix ? `${meta.agentName} · ${meta.name}` : meta.name
  return `${head} (${tag})`
}
```

| 情况 | 显示 |
|---|---|
| `multiplier: 0` 或 `free: true` | `(免费)` |
| `multiplier: 2` | `(×2)` |
| `multiplier: 1.5` | `(×1.5)` |
| `multiplier: undefined`（**价格拿不到**） | `(未知倍率)` |

**`unknown` 就写 `未知倍率`，不省略也不编造。** 省略了用户看不出差别，
编造会让人以为某模型很便宜。这是本项目的硬规则之一。

关掉「模型名带 Agent 前缀」后只剩 `DeepSeek-R1 (×2)` —— 因为分组标题已经写着
`OpenCode` 了，省下的横向空间能多显示几个字。

### 口径（OpenCode）

OpenCode 官方**不给「积分倍率」**，给的是**每百万 token 的美元价**。所以本插件把
「倍率」定义成**相对贵度**：

```
倍率 = round2( max(cost.input, cost.output) / baselineUsdPerMTok )
```

- `baselineUsdPerMTok` 默认 **1.2**（DeepSeek V4.1 Flash 的输出价），可以在
  Agent 的「倍率基准」里改；
- 价格全都为 0 → `free: true` → 显示「免费」；
- 价格源拿不到 → 不给倍率 → 显示「未知倍率」。

举例（基准 1.2）：

| 模型 | 输入/输出（$/M） | 倍率 |
|---|---|---|
| DeepSeek V4.1 Flash | 0.30 / 1.20 | ×1 |
| GLM 5.3 Flash | 0.15 / 0.50 | ×0.42 |
| MiniMax M3 | 0.30 / 1.20 | ×1 |
| Claude Opus 5 | 5.00 / 25.00 | ×20.83 |
| DeepSeek V4.1 Flash Free | 0 / 0 | 免费 |

> 对**真有积分倍率**的 Agent（Qoder 那类），适配器直接返回上游给的倍率数字即可，
> 不需要这套换算 —— 倍率只是 `ModelMeta.multiplier` 这一个字段，
> **怎么得到它由适配器自己决定**（`multiplierSource` 里写清来源）。

## 5. 模型从哪里来（OpenCode 的三层）

`src/adapters/opencode.ts` 的 `getModelMetaList()` 按优先级合并三层：

| 层 | 来源 | 给什么 | 是否需要鉴权 |
|---|---|---|---|
| ① | `https://opencode.ai/inference/v1/models` | 模型 **id 列表** | 不需要 |
| ② | `https://models.dev/api.json` → `providers.opencode.models` | 显示名、上下文、输入模态、**价格**（→ 倍率） | 不需要 |
| ③ | `https://opencode.ai/console/api/v2/config` | **这个工作区**真正可用的模型与显示名 | 需要该账号的 key |

- ① 一定有；② 挂了不影响可用性，只是倍率变「未知倍率」；
- ③ 拿不到（403/404）就退化成「公开目录」，并在 `description` 里标注来源；
- 结果缓存 6 小时（`ctx.cache`），落盘一份在 `state.json`（DSH 重启后选择器
  不会空掉）。

**只返回免费模型。** OpenCode 在本插件里是「免账号通道」（走免费层），付费模型在
免费通道上根本调不动，列出来只会把免费那几个淹没。所以过滤就放在
`getModelMetaList()` 里 —— 设置页的模型列表、勾选、探测、上报全都只看免费集合，
下游不用再各自判断一遍。判据两条，任一成立即算免费：

1. 价格源说 `max(input, output) === 0`（最准）；
2. id 以 `-free` 结尾（`deepseek-v4.1-flash-free`、`beam-free`）——

第 2 条是**兜底**：models.dev 抖动或新模型还没进价格表时，价格是 `undefined`
（≠ 免费），只认价格的话整个免费列表会突然空掉。反过来，**没价、id 也不带
`free` 的一律按付费过滤**（宁可少列一个，也不让付费模型混进免费通道）。

**模型列表为空时不会假装成功**：日志里会有 `「opencode」模型列表为空`，
页面点「列出模型」能看到真实的 HTTP 报错。

## 5.5 需要账号的平台：登录前**不列**模型

OpenCode 之外的平台（Qoder / Qoder CN / WorkBuddy / 国际版）走的是另一条路：

| 平台 | 模型目录从哪来 | 没登录时 |
|---|---|---|
| Qoder / Qoder CN | 插件内置的产品目录（`vendor/qoder` 的兜底表，含 `price_factor` 倍率） | 返回**空列表** |
| WorkBuddy / 国际版 | 上游 `GET /v3/config`，失败回退内置表 | 返回**空列表** |

没登录时返回空，不是「拉不到」，而是**故意不列**：目录是产品级的、登录前就存在，
但一个模型都调不动。提前列出来只会让用户看到一堆「未知倍率」，以为插件坏了
（真机报障原话：「还没登录账号就拉取到了模型，但是倍率是未知呢？太不友好了」）。

界面上对应两种模型卡片：

- **免账号平台**（OpenCode）：照常列模型，只有免费模型（见 §5）；
- **需要账号的平台**：没账号时模型卡片只写「未登录 · 登录后自动拉取」，
  不出现表格、不出现「拉取模型」、也不出现「测一次」。账号一加进来，
  客户端会自动重拉（`loadModelsIfNeeded` 的 key 里带账号数）。

## 5.6 Qoder 的倍率：随错峰窗口变化，**不能直接用 `price_factor`**

Qoder 目录里的 `price_factor` 是**采集那一刻的生效价**，会随错峰窗口变化。
`Qwen3.8-Max` 的 `promotion` 是「22:00–08:00、4 折、原价 0.5」，
目录里存的 `0.2` 是**窗口内的折后价** —— 白天直接显示 ×0.2 就错了。

算法（逐字对齐参考实现 `dsh-our-free-model` 的 `qoderDisplayName` / `promotionActiveNow`）：

| 情况 | 倍率 |
|---|---|
| 窗口内 | `beforePromotionPriceFactor × discountFactor`（折后价） |
| 窗口外 | `beforePromotionPriceFactor`（**原价**） |
| 无 promotion | 目录的 `priceFactor` |

两条硬规矩：

1. **不采信目录的 `promotion.active`** —— 那是下发时刻的快照，客户端不重启就会过期。
   按 `windowStart`/`windowEnd` **本地推算**（UTC+8，支持跨零点）。
2. **「免费」只认倍率 0**，不用 `is_free`。`is_free` 是「免费额度模型」，
   照样扣积分；真正零成本的只有 `qfmodel`（`price_factor: 0`）。

`is_free` 但倍率非 0 的模型会在 `description` 里注明「免费额度模型（仍按倍率扣积分）」；
折扣生效中会写「原价 ×0.5 → 现价 ×0.2」。

### Qoder 的 uid：不在 token 里，必须单独存

加密推理要用 `uid` 派生 `encrypt_user_info`，而**设备码登录给的是 `dt-...`
不透明令牌，不是 JWT** —— 从 token 里解 uid 永远失败。

| 来源 | 说明 |
|---|---|
| 登录响应的 `user_id` | 首选；`pollLogin()` 存成 `credentials.uid` |
| 凭证里已有的 `uid` | 老账号走这条 |
| `/sash/api/v2/me/usage` → `.qoderUsage.userId` | **兜底**：早期版本漏存 uid 的账号靠它补，不需要重新登录 |
| `/sash/api/v1/me/campaigns` → `.uid` | 同上，第二个兜底端点 |
| JWT 解析 | 最后尝试（手工粘贴 JWT 的老路径） |

两个兜底端点**只认 `Bearer <device token>`，不需要 WASM 签名**（实测 2026-10-19）。
补到之后通过 `ctx.onCredentialsRefreshed` 回写，下次直接命中。

## 6. 排序

`getModelMetaList()` 返回的顺序 = 选择器里的顺序：

1. **免费模型排最前**（对用户最有价值）；
2. 然后按倍率升序（便宜在前）；
3. 倍率都是未知时按模型 id 字典序。

分组顺序 = `llm.registerAdapter()` 的注册顺序 = `adapters/index.ts` 里的数组顺序
（OpenCode → Qoder → Qoder CN → Trae → WorkBuddy → WorkBuddy International）。
DSH 自己会把 `deepseek-account` / `deepseek-official` 排到最前面，其余保持注册顺序。

## 6.5 只上报我勾选的模型（默认一个都不报）

上游 OpenCode 目录实测 **85 个模型**，全塞进 DSH 的模型下拉里，免费的那几个会被彻底淹没。
所以每个 Agent 都有一份**上报策略**：

| `models.mode` | 行为 | 什么时候用 |
|---|---|---|
| `selected`（**默认**） | 只上报勾选列表里的 id；列表为空 = **一个都不报** | 你想精确控制下拉里有什么 |
| `free` | 只上报 `free === true` 的模型 | 匿名免费层，懒得一个个勾 |
| `all` | 全部上报 | 你要挑付费模型 |

> 默认从 `free` 改成 `selected` 是因为「没配过的平台会自己冒出模型」—— 用户明确要求
> **勾了并保存才出现**。旧配置里显式写了 `mode: free` 的仍然按 free 走。

```yaml
agents:
  opencode:
    exposeModels: true          # 总开关：关掉 = 一个都不上报
    models:
      mode: selected            # selected | free | all
      selected: "gpt-5.4,deepseek-v4.1-flash-free"   # 逗号或换行分隔
```

界面上：模型卡片里勾选 → 点「保存并生效」→ 选择器才更新。**没有「一键全选/按推荐
预选」按钮** —— 那个入口会把「选哪些模型」变成一个不由用户决定的结果，已经删掉；
要报哪几个就自己勾哪几个。OpenCode 的列表本身只有免费模型，所以也不再有
「只看免费」的过滤器（全是免费的，留着只会让人以为还有没显示的）。

> ⚠️ 勾选/输入走的是**原生 DOM 监听**（`addEventListener('change')`），不是 React
> 的 `onChange`。面板正文是 `innerHTML` 字符串，事件目标没有 React fiber；
> React 的 `onChange` 只在「目标节点是表单元素」时派发，目标被解析成根 div 后
> 一次都不会派发 —— 曾经因此出现「勾了模型，保存按钮永远是灰的」。

**两条路径是分开的，这是刻意的：**

- `runtime.modelsOf(agentId)` = 上游**一共有哪些**（设置页的勾选列表要全量，否则没得勾）；
- `runtime.exposedModelsOf(agentId)` = **实际上报**给选择器的（已按策略过滤）。

DSH 的模型下拉读的是后者（`createLlmAdapter` 的 `models()` → `listModels()` → `resolveModel()`）。
混成一个函数的话，要么选择器被 85 个模型塞满，要么设置页看不到可勾的项。

**边界**：

- 免费判据是「价格算出来是 0」**加上**「id 以 `-free` 结尾」两条（见 §5）。
  id 命中兜底判据的模型也会标上 `free: true`，所以 `free` 模式同样认得它们；
- `selected` 里写了不存在的 id：**不会**凭空造出来，也不会报错，就是不过滤出东西。
- 勾选列表里的「进下拉」一栏显示的是**当前实际上报的**，改完要**点保存**才生效。

## 7. 自检清单

改完模型相关代码后，按这个顺序验：

1. `node --test test/unit.test.mjs` —— `renderModelLabel` 的形态断言；
2. `node test/client.test.mjs` —— 客户端预览标签与服务端渲染一致；
3. 重启 DSH → 模型选择器里看分组标题与每行标签；
4. `cordis_inspect_query(host, Service, listService, {service:'llm'})` 之后
   `listModels('multiagent-opencode')` 看原始返回值。
