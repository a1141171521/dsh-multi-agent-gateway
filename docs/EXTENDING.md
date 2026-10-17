# 扩展开发：新增一个 Agent 适配器

**目标：加一个 Agent 只改两个文件，核心调度代码一行不动。**

```
src/adapters/<your-agent>.ts     ← 新文件：你的适配器
src/adapters/index.ts            ← 加一行：builtinAdapters() 里带上它
```

再改三处，配置与界面才认得它（**这三处是「声明」，不是「逻辑」**）：

```
src/config.ts 的 AGENT_UPSTREAM_DEFAULTS / AGENT_DISPLAY_NAMES  ← 默认上游地址与显示名
src/config.ts 的 Config.agents                                  ← 加一个固定键
client/client.js 的 AGENTS                                      ← 客户端标签页顺序
```

> ⚠️ **为什么 `Config.agents` 必须是固定键而不是 `Schema.dict`**：宿主对 volatile
> 字段有硬校验 —— *volatile fields require a fixed object path without an enclosing
> volatile field*。用 dict 会出现 `agents.*.enabled` 这种通配路径，宿主**直接拒绝
> 整份配置**（`ValidationError: invalid config`），插件起不来。真机踩过。
>
> 第三方适配器（运行期注册、不想改本仓库）走 `Config.extraAgents`
> （一个 `Schema.dict(Schema.any())`，不做 volatile）：**只能通过
> `cordis.patch.yml` 写**，功能等价。

---

## 1. 标准化接口（全 9 个方法）

每个适配器都必须实现 `src/core/types.ts` 的 `AgentAdapter`：

| 方法 | 职责 | 什么时候被调用 |
|---|---|---|
| `getCredentials(record, ctx)` | 取出/派生实际用于请求的凭证 | 每次请求前 |
| `validateCredentials(record, ctx)` | 真实打一次上游，验证凭证 | 页面「测活」+ 降权恢复探测 |
| `checkIn(record, ctx)` | **每日签到** | 定时任务 + 「立即签到」 |
| `getQuota(record, ctx)` | **剩余积分 / 可用额度** | 定时任务 + 「刷新额度」 + 路由排序 |
| `getModelMetaList(record, ctx)` | **模型元数据（含积分倍率）** | 模型选择器 + 配置页 |
| `fetchAvailableTasks(record, ctx)` | 拉取可参与的活动任务 | 活动任务轮询 |
| `executeTask(task, record, ctx)` | 执行任务并领奖 | 活动任务轮询 + 工具 |
| `checkTaskStatus(taskId, record, ctx)` | 查询任务完成状态 | 工具 / 补查 |
| `requestChatStream(payload, record, ctx, signal)` | 转发一次流式 completion | 每次对话 |
| `detectError(status, body, headers)` | 把响应分类成 `ErrorKind` | 每次失败 |

**核心层只按 `ErrorKind` 做决策**，所以私有错误码只需要在 `detectError()` 里加一条规则。

---

## 2. 最小可用模板

```ts
// src/adapters/my-agent.ts
import { BaseAdapter } from './base.js'
import { missingCredentialReason, unsupportedReason } from './messages.js'
import { iterateSse } from '../core/sse.js'
import { authHeaders, mergeHeaders } from '../core/http.js'
import type {
  AccountRecord, AdapterContext, AgentCapabilities,
  ChatRequest, CheckInResult, ErrorKind, ModelMeta, QuotaSnapshot,
  StreamEvent, TaskRecord, TaskResult,
} from '../core/types.js'

export class MyAgentAdapter extends BaseAdapter {
  constructor() {
    const capabilities: AgentCapabilities = {
      checkIn: false,     // ← 上游有没有签到接口？没有就 false（核心层不会安排签到定时任务）
      quota: true,
      models: true,
      tasks: false,
      chat: true,
      reasoning: false,
      source: 'static',
      notes: {
        checkIn: '上游没有签到接口；若有，请在配置里填 upstream.checkInPath',
        reasoning: '上游不返回思维链',
      },
    }
    super({
      id: 'my-agent',                 // ← agentId，会变成 provider 路由 multiagent-my-agent
      name: 'My Agent',               // ← 模型选择器里的分组标题
      doc: 'https://my-agent.example/docs/api',
      credentialHint: '登录后在 控制台 → API Keys 里取 token',
      capabilities,
      implemented: true,
    })
  }

  // ── 凭证 ────────────────────────────────────────────────
  override async validateCredentials(record: AccountRecord, ctx: AdapterContext) {
    const token = typeof record.credentials.token === 'string' ? record.credentials.token.trim() : ''
    if (token === '') return { ok: false, message: missingCredentialReason(this.name, 'token'), kind: 'auth' as ErrorKind }
    const result = await ctx.http(`${ctx.config.upstream.apiBaseUrl}/api/me`, { headers: this.headersOf({ token }) })
    return result.ok ? { ok: true, message: '凭证有效' } : { ok: false, message: result.message, kind: result.kind }
  }

  // ── 额度 ────────────────────────────────────────────────
  override async getQuota(record: AccountRecord, ctx: AdapterContext): Promise<QuotaSnapshot> {
    const result = await ctx.http(`${ctx.config.upstream.apiBaseUrl}/api/quota`, {
      headers: this.headersOf(record.credentials),
    })
    if (!result.ok) {
      return {
        accountId: record.id,
        unit: 'unknown',
        fetchedAt: Date.now(),
        error: result.message ?? `HTTP ${result.status}`,   // ← 拿不到就给原因，不要用 0 冒充
      }
    }
    const remaining = Number(result.body?.remaining)
    return {
      accountId: record.id,
      unit: 'credits',
      ...(Number.isFinite(remaining) ? { remaining } : {}),
      fetchedAt: Date.now(),
      ...(Number.isFinite(remaining) ? {} : { error: '上游响应里没有 remaining 字段' }),
    }
  }

  // ── 模型 + 倍率 ──────────────────────────────────────────
  override async getModelMetaList(record: AccountRecord, ctx: AdapterContext): Promise<ModelMeta[]> {
    const cached = ctx.cache.get<ModelMeta[]>('my-agent:models')
    if (cached !== undefined) return cached
    const result = await ctx.http(`${ctx.config.upstream.apiBaseUrl}/api/models`, {
      headers: this.headersOf(record.credentials),
    })
    if (!result.ok) {
      ctx.log.warn('拉模型列表失败', result.message ?? `HTTP ${result.status}`)
      return []
    }
    const rows = Array.isArray(result.body) ? result.body : []
    const list: ModelMeta[] = rows.map((row: Record<string, unknown>) => {
      // 上游直接给倍率就原样用；不给就干脆不给（UI 会显示「未知倍率」）。
      const ratio = Number(row.creditRatio)
      const meta: ModelMeta = {
        id: String(row.id),
        name: String(row.name ?? row.id),
        agentId: this.id,
        agentName: this.name,
        updatedAt: Date.now(),
      }
      if (Number.isFinite(ratio)) {
        meta.multiplier = ratio
        meta.multiplierSource = '上游接口:creditRatio'
        if (ratio === 0) meta.free = true
      }
      return meta
    })
    ctx.cache.set('my-agent:models', list, 6 * 3600_000)
    return list
  }

  // ── 对话（流式） ─────────────────────────────────────────
  override async *requestChatStream(
    payload: ChatRequest,
    record: AccountRecord,
    ctx: AdapterContext,
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const url = `${ctx.config.upstream.chatBaseUrl}/chat/completions`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: mergeHeaders(this.headersOf(record.credentials), { 'content-type': 'application/json' }),
        body: JSON.stringify({ ...payload, stream: true }),
        signal,
      })
    } catch (error) {
      yield { type: 'error', failure: { kind: 'network', message: String(error), at: Date.now() } }
      return
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      yield {
        type: 'error',
        failure: {
          kind: this.detectError(response.status, text, response.headers),
          message: text.slice(0, 300) || `HTTP ${response.status}`,
          status: response.status,
          at: Date.now(),
        },
      }
      return
    }
    // `iterateSse` 已经把「跨分片 / 心跳 / 坏事件 / [DONE]」全处理好了。
    yield* iterateSse(response, (raw) => ctx.log.debug('跳过坏事件', raw.slice(0, 120)), signal)
  }

  // ── 错误分类（可选：只加你自己的私有码） ────────────────
  override detectError(status: number, body: unknown, headers: Headers): ErrorKind {
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
    if (/my_quota_code/.test(text)) return 'quota'
    return super.detectError(status, body, headers)
  }
}
```

然后在 `src/adapters/index.ts`：

```ts
import { MyAgentAdapter } from './my-agent.js'

export function builtinAdapters(): AgentAdapter[] {
  return [new OpenCodeAdapter(), new MyAgentAdapter(), ...builtinSkeletons()]
  //                                     ^^^^^^^^^^^^^^ 就这一行
}
```

再在 `src/config.ts` 补两份默认值（否则上游地址是空字符串）：

```ts
export const AGENT_UPSTREAM_DEFAULTS: Record<string, Record<string, string>> = {
  // ...
  'my-agent': {
    chatBaseUrl: 'https://my-agent.example/v1',
    apiBaseUrl: 'https://my-agent.example',
    modelsUrl: 'https://my-agent.example/v1/models',
  },
}
export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  // ...
  'my-agent': 'My Agent',
}
```

最后 `node scripts/build.mjs`。

---

## 3. 从骨架开始（更省事）

五个待实现的 Agent 已经是骨架了。要把它变成真实现，**不用新写一个类**，
直接在那个文件里改：

```ts
// src/adapters/skeletons.ts
const TRAE: SkeletonSpec = { /* ... */ }
```

→ 改成

```ts
// src/adapters/trae.ts
import { BaseAdapter } from './base.js'
export class TraeAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'trae',
      name: 'Trae',
      capabilities: { /* 探测/写死 */ },
      implemented: true,
    })
  }
  // 只实现你需要的几个方法；其余继承 BaseAdapter 的「上游不支持」默认实现
}
```

然后把 `skeletons.ts` 里那个条目删掉、在 `index.ts` 里换成新类。
`BaseAdapter` 的默认实现会保证：**没实现的方法返回明确的「上游不支持」，而不是抛错。**

---

## 4. 什么时候「返回不支持」而不是「抛错」

这条决定了核心调度器的行为，写错了会把好功能熔断掉：

| 情况 | 正确做法 | 错误做法的后果 |
|---|---|---|
| 上游没有签到接口 | `{ supported: false, message: '…（这不是故障）' }` | 抛错 → 每 24 小时一次失败 → 5 次后 job 被暂停 |
| key 没有查额度的权限 | `quota.error = '权限不足：…'`（`unit: 'unknown'`） | 抛错 → 账号被降权 |
| 上游不支持这个模型的图片输入 | `ErrorKind: 'unsupported'` | 记成 `bad_request` → 换号重试，浪费其它账号额度 |
| 网络抖动 / 上游 5xx | `ErrorKind: 'network'` / `'server'` | 记成 `auth` → 账号被误判死 |

## 5. 并发与限速（框架已替你做了）

**不要在适配器里自己 sleep / 重试 / 限速。** 这些全在核心层：

| 你需要的 | 框架提供的 |
|---|---|
| 每账号每分钟最多 N 次请求 | `runtime.awaitRateLimit(accountId)` —— 但对话路径已经自动做了；活动任务路径由调度器串行化 |
| 任务并发上限 | `tasks.concurrency` + `Semaphore` |
| 失败重试 | `TaskEngine.runOne()`（配 `retryDelaySec`） |
| 换账号重试 | `AccountRouter.execute()` |
| 结果缓存 | `ctx.cache.get/set(key, value, ttlMs)` |

你只要**如实地把错误分类报出来**就够了。

## 6. 测试你的适配器

至少写这三个：

```js
// 1) 接口完整性
import { validateAdapter } from '../lib/core/registry.js'
assert.equal(validateAdapter(new MyAgentAdapter()).ok, true)

// 2) 「上游不支持」必须是明确结论而不是异常
const result = await adapter.checkIn(record, ctx)
assert.equal(result.supported, false)
assert.match(result.message, /这不是故障/)

// 3) 错误分类（喂真实的错误 body）
assert.equal(adapter.detectError(403, { code: 'my_quota_code' }, new Headers()), 'quota')
```

`node --test test/` 会自动带上它们。

## 7. 提交前自检清单

- [ ] `node scripts/build.mjs` 通过（说明没有不可擦除的 TypeScript 语法）；
- [ ] `node --test test/` 全绿；
- [ ] `node test/smoke.mjs` 通过（假宿主完整装一遍）；
- [ ] `node test/client.test.mjs` 通过（如果你动了 `AGENTS` / 配置字段）；
- [ ] 新 Agent 的分组标题、模型标签形态符合 `docs/MODELS.md`；
- [ ] 每一个「拿不到」都给了**人话原因**，没有一个静默的 `return []`；
- [ ] 没有任何一条日志/返回值里出现完整凭证（做错的话 `redactDeep` 也救不了你 ——
      它是出口才跑的，你在适配器里 `ctx.log.info(token)` 就直接泄了）。
