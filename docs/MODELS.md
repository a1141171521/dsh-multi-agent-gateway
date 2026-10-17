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

**模型列表为空时不会假装成功**：日志里会有 `「opencode」模型列表为空`，
页面点「列出模型」能看到真实的 HTTP 报错。

## 6. 排序

`getModelMetaList()` 返回的顺序 = 选择器里的顺序：

1. **免费模型排最前**（对用户最有价值）；
2. 然后按倍率升序（便宜在前）；
3. 倍率都是未知时按模型 id 字典序。

分组顺序 = `llm.registerAdapter()` 的注册顺序 = `adapters/index.ts` 里的数组顺序
（OpenCode → Qoder → Qoder CN → Trae → WorkBuddy → WorkBuddy International）。
DSH 自己会把 `deepseek-account` / `deepseek-official` 排到最前面，其余保持注册顺序。

## 6.5 只上报我勾选的模型（默认就不是「全部」）

上游 OpenCode 目录实测 **85 个模型**，全塞进 DSH 的模型下拉里，免费的那几个会被彻底淹没。
所以每个 Agent 都有一份**上报策略**（设置页里就是那三个按钮 + 勾选列表）：

| `models.mode` | 行为 | 什么时候用 |
|---|---|---|
| `free`（**默认**） | 只上报 `free === true` 的模型 | 匿名免费层 —— 这就是这个插件的主场景 |
| `selected` | 只上报勾选列表里的 id | 你有 key，只想用其中几个 |
| `all` | 全部上报（旧行为） | 你要挑付费模型 |

```yaml
agents:
  opencode:
    exposeModels: true          # 总开关：关掉 = 一个都不上报
    models:
      mode: free                # free | selected | all
      selected: "gpt-5.4,deepseek-v4.1-flash-free"   # 逗号或换行分隔
```

**两条路径是分开的，这是刻意的：**

- `runtime.modelsOf(agentId)` = 上游**一共有哪些**（设置页的勾选列表要全量，否则没得勾）；
- `runtime.exposedModelsOf(agentId)` = **实际上报**给选择器的（已按策略过滤）。

DSH 的模型下拉读的是后者（`createLlmAdapter` 的 `models()` → `listModels()` → `resolveModel()`）。
混成一个函数的话，要么选择器被 85 个模型塞满，要么设置页看不到可勾的项。

**边界**：

- `free` 判据是「倍率算出来是 0」（`cost.input` 与 `cost.output` 都是 0），不是看名字里有没有 `free`。
  名字带 `free` 但**取不到价格**的模型会落进「未知倍率」，**不会**被 `free` 模式选中 ——
  宁可让你手动勾，也不假装它免费。
- `selected` 里写了不存在的 id：**不会**凭空造出来，也不会报错，就是不过滤出东西。
- 勾选列表里的「进下拉」一栏显示的是**当前实际上报的**，改完要**点保存**才生效。

## 7. 自检清单

改完模型相关代码后，按这个顺序验：

1. `node --test test/unit.test.mjs` —— `renderModelLabel` 的形态断言；
2. `node test/client.test.mjs` —— 客户端预览标签与服务端渲染一致；
3. 重启 DSH → 模型选择器里看分组标题与每行标签；
4. `cordis_inspect_query(host, Service, listService, {service:'llm'})` 之后
   `listModels('multiagent-opencode')` 看原始返回值。
