/**
 * `dsh-multi-agent-gateway` 的宿主入口。
 *
 * ## 整体架构（分层模块化，新增 Agent 只加适配器）
 *
 * ```
 *                       ┌──────────────────────── DSH ────────────────────────┐
 *   对话请求 ──▶ ctx.llm ──▶ llm/adapter.ts（每 Agent 一个 provider 路由）
 *                       │            │                                    │
 *                       │            ▼                                    │
 *   模型选择器 ◀──────────│   runtime.ts（总装：模型缓存 / 分组 / 倍率标签）     │
 *                       │            │                                    │
 *   客户端配置页 ◀── remote.ts ─┼──▶ core/router.ts  多账号路由（换号/降权/恢复）│
 *                       │            ├──▶ core/scheduler.ts 定时任务管理器     │
 *                       │            ├──▶ core/tasks.ts  活动任务引擎          │
 *                       │            └──▶ core/accounts.ts 账号（加密落盘）     │
 *                       │                       │                          │
 *                       │                       ▼                          │
 *   工具 ◀───────────────┘            adapters/*.ts（每 Agent 一个适配器）      │
 *                       └────────────────────────────────────────────────────┘
 * ```
 *
 * ## 关键装配顺序（顺序错了会「看起来装上了其实没装」）
 *
 *   1. 造 `GatewayRuntime`（读账号、建缓存、注册适配器）；
 *   2. 先 `registerAdapter` 给 DSH —— 模型选择器才有分组；
 *   3. 再注册工具与客户端通道（`typert` 可能比 `llm` 晚到，用 `ctx.inject` 等）；
 *   4. 最后 `runtime.start()` 起调度器（此时账号已就绪，job 计划才是对的）。
 */

import { Config, resolveConfig, type PluginConfig } from './config.js'
import { GatewayRuntime } from './runtime.js'
import { builtinAdapters } from './adapters/index.js'
import { createLlmAdapter, encodeModelId } from './llm/adapter.js'
import { installRemoteHost, type RemoteImplementation } from './remote.js'
import { registerTools } from './tools.js'
import { validateAdapter } from './core/registry.js'
import { DEFAULT_DATA_DIR_NAME, defaultDataDir } from './paths.js'
import { selectExposedModels } from './core/types.js'
import type { AgentAdapter, ModelMeta, ModelPolicy } from './core/types.js'

/** 插件名（Cordis loader 读这个）。 */
export const name = 'dsh-multi-agent-gateway'

/**
 * 依赖声明。
 *
 * ⚠️ **cordis 的 `inject` 只认两种形状**（`Inject.resolve()`）：
 *   1. 字符串数组 —— 每个都是**硬依赖**；
 *   2. 对象映射 —— 键是服务名，值是拦截配置（`null` = 默认）。
 *
 * 所以**没有** `{ required: [...], optional: [...] }` 这种写法。写错了不会报错，
 * 而是让插件永远停在 `pending (waiting for services: required, optional)` ——
 * 加载器把 `required` / `optional` 当成了两个服务名（真机踩过）。
 *
 * 结论：`llm` 走 hard dependency（没有它这个插件没有意义），
 * 其余服务一律用 **`ctx.get(name)`**（"Read a service from the store without the
 * inject requirement"）或 `ctx.inject([...], cb)` 延迟接入。
 */
export const inject = ['llm']

/**
 * 取一个**可选**服务。
 *
 * 为什么不能裸访问 `ctx.tools`：context 的 getter 会对没有注入的服务抛
 * `cannot get property "xxx" without inject`。可选依赖必须走 `ctx.get()`。
 */
function optionalService<T>(ctx: ApplyContext, name: string): T | undefined {
  try {
    return (ctx.get?.(name) as T | undefined) ?? undefined
  } catch {
    return undefined
  }
}

export { Config }

/** 每个 Agent 的 provider 路由 id：`multiagent-<agentId>`。 */
export function providerIdOf(agentId: string): string {
  return `multiagent-${agentId}`
}

/** DSH 上下文的最小形状（结构化声明，避免 import 宿主包）。 */
interface ApplyContext {
  llm?: {
    registerAdapter(providers: string[], adapter: unknown): { (): void; replace(providers: string[]): void }
    registerModelDiscovery?(
      settingsNs: string,
      discover: (request: unknown, signal?: AbortSignal) => Promise<unknown[]>,
    ): () => void
  }
  tools?: { register(definition: Record<string, unknown>): () => void }
  logger?: {
    debug?: (...args: unknown[]) => void
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
  get?(name: string): unknown
  inject?(names: string[] | Record<string, string[]>, callback: (child: ApplyContext) => void): unknown
  effect?(callback: () => void | (() => void), label?: string): unknown
  on?(name: string, listener: (...args: unknown[]) => void): unknown
  fiber?: { entry?: { options?: { id?: string } } }
}

/** 插件运行期句柄（测试用）。 */
export interface PluginHandle {
  runtime: GatewayRuntime
  dispose(): void
  reload(): void
}

/**
 * 解析宿主的日志器。
 *
 * cordis 的 `ctx.logger` 是**可调用的** `LoggerService`：`ctx.logger(name)`
 * 返回一个绑定到该名字的 logger，而 `ctx.logger.info(...)` 也能用。
 * 两种写法都试一遍；都拿不到就退到插件自己的环形缓冲（界面照样能看到日志）。
 */
function resolveDshLogger(ctx: ApplyContext): ApplyContext['logger'] {
  const raw = ctx.logger
  if (raw === undefined || raw === null) return undefined
  try {
    if (typeof raw === 'function') {
      const named = (raw as unknown as (suffix: string) => ApplyContext['logger'])(name)
      if (named !== undefined && named !== null) return named
    }
  } catch {
    // 调用失败就退回原对象。
  }
  return raw
}

/** 上一次 apply 的句柄（诊断/测试用）。 */
let lastHandle: PluginHandle | null = null

/** 取上一次装的句柄（没有则 null）。 */
export function currentHandle(): PluginHandle | null {
  return lastHandle
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 已经过 schema 处理的配置（volatile 字段是引用对象）。
 */
export function apply(ctx: ApplyContext, config: PluginConfig = {}): PluginHandle {
  const dshLogger = resolveDshLogger(ctx)
  const adapters: AgentAdapter[] = builtinAdapters()

  // 适配器自检：缺方法时**在装载阶段**就报出来，而不是等第一次调用。
  const broken: string[] = []
  for (const adapter of adapters) {
    const check = validateAdapter(adapter)
    if (!check.ok) broken.push(`${adapter.id}: 缺少 ${check.missing.join(', ')}`)
  }
  if (broken.length > 0) dshLogger?.error?.(`[${name}] 适配器接口不完整：${broken.join('；')}`)

  const resolved = resolveConfig(config, {
    knownAgentIds: adapters.map((adapter) => adapter.id),
    defaultDataDir: defaultDataDir(),
  })

  if (!resolved.enabled) {
    dshLogger?.warn?.(`[${name}] 插件在配置里被关闭（enabled: false），不注册任何 provider`)
  }

  const runtime = new GatewayRuntime({ config: resolved, dshLogger, adapters })
  const disposers: Array<() => void> = []

  // ────────── ① LLM provider 注册（模型分组 + 倍率标签的落点） ──────────
  const routes = new Map<string, { handle: { (): void; replace(providers: string[]): void } | null; agentId: string }>()
  const registerRoutes = (): void => {
    const llm = ctx.llm
    if (llm === undefined) {
      dshLogger?.error?.(`[${name}] 宿主没有 llm 服务 —— 模型分组无法上报`)
      return
    }
    for (const agentId of runtime.registry.ids()) {
      const provider = providerIdOf(agentId)
      const existing = routes.get(provider)
      // 读 `runtime.config`（而不是 `apply` 里捕获的那份）——
      // 配置热更新后 `enabled` 可能已经变了，捕获值会让路由注册停在旧判断上。
      const active = runtime.config.enabled && runtime.isAgentActive(agentId)
      if (!active) {
        // 不活跃的 Agent 直接**不注册路由**（注册一条空路由只会让选择器里多一个空分组）。
        if (existing?.handle !== undefined) {
          existing.handle()
          routes.delete(provider)
        }
        continue
      }
      if (existing?.handle !== undefined) continue
      const adapter = createLlmAdapter({
        agentId,
        // 传**取值函数**而不是当时的值：适配器实例是注册时建好的，
        // 捕获字符串/布尔会让「分组名」和「带前缀」两项配置改完不生效。
        displayName: () => runtime.agentConfig(agentId).name,
        labelWithAgent: () => runtime.agentConfig(agentId).labelWithAgent,
        accounts: runtime.accounts,
        router: runtime.router,
        adapterOf: (id) => runtime.registry.get(id),
        contextOf: (id) => runtime.contextOf(id),
        modelsOf: (id, force) => runtime.modelsOf(id, force),
        exposedModelsOf: (id, force) => runtime.exposedModelsOf(id, force),
        log: runtime.logger.child(`llm:${agentId}`),
      })
      try {
        const handle = llm.registerAdapter([provider], adapter)
        routes.set(provider, { handle, agentId })
        dshLogger?.info?.(`[${name}] 已注册 provider 路由「${provider}」（分组：${runtime.agentConfig(agentId).name}）`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        dshLogger?.error?.(`[${name}] 注册 provider 路由「${provider}」失败：${message}`)
        runtime.logger.error(`注册 provider 路由失败：${provider}`, message)
      }
    }
  }
  registerRoutes()

  // ────────── ② 模型发现（让「添加 provider」的配置界面也能列模型） ──────────
  try {
    const settingsNs = ctx.fiber?.entry?.options?.id ?? name
    ctx.llm?.registerModelDiscovery?.(settingsNs, async () => {
      const list: ModelMeta[] = await runtime.allModels()
      return list.map((meta) => ({
        id: encodeModelId(meta.agentId, meta.id),
        name: meta.name,
        ...(meta.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow }),
        ...(meta.maxTokens === undefined ? {} : { maxTokens: meta.maxTokens }),
        ...(meta.inputModalities === undefined ? {} : { inputModalities: meta.inputModalities }),
      }))
    })
  } catch (error) {
    dshLogger?.warn?.(
      `[${name}] 注册模型发现失败（不影响模型选择器）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // ────────── ③ 工具 ──────────
  const tools = optionalService<{ register(definition: Record<string, unknown>): () => void }>(ctx, 'tools')
  if (tools !== undefined) {
    try {
      disposers.push(
        ...registerTools({
          runtime,
          register: (definition) => tools.register(definition),
        }),
      )
      dshLogger?.info?.(`[${name}] 已注册 5 个工具`)
    } catch (error) {
      dshLogger?.error?.(`[${name}] 注册工具失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    runtime.logger.debug('这个部署没有 tools 服务，跳过工具注册')
  }

  // ────────── ④ 客户端通道（设置页的数据来源） ──────────
  const remoteImpl: RemoteImplementation = {
    state: () => runtime.snapshotState(),
    logs: (input) => runtime.snapshotLogs(typeof input?.count === 'number' ? input.count : 120),
    taskLog: (input) => runtime.taskLog(typeof input?.count === 'number' ? input.count : 40),
    models: async (input) => {
      const agentId = typeof input?.agentId === 'string' ? input.agentId : undefined
      const force = input?.force === true
      const list = agentId === undefined ? await runtime.allModels(force) : await runtime.modelsOf(agentId, force)
      const policy: ModelPolicy =
        agentId === undefined ? { mode: 'all', selected: [] } : runtime.agentConfig(agentId).models
      const exposed = agentId === undefined ? list : selectExposedModels(list, policy)
      const shape = (meta: (typeof list)[number]) => ({
        id: meta.id,
        name: meta.name,
        agentId: meta.agentId,
        agentName: meta.agentName,
        multiplier: meta.multiplier ?? null,
        multiplierSource: meta.multiplierSource ?? null,
        free: meta.free === true,
        description: meta.description ?? null,
        contextWindow: meta.contextWindow ?? null,
      })
      // 返回**全量 + 策略 + 实际上报的 id**：
      //   - 勾选列表要知道上游一共有哪些（`models`）；
      //   - 界面要标出「哪些现在真的进了选择器」（`exposedIds`）。
      return {
        agentId: agentId ?? null,
        models: list.map(shape),
        exposedIds: exposed.map((meta) => meta.id),
        policy,
      }
    },
    addAccount: (input) =>
      runtime.addAccount({
        agentId: String(input?.agentId ?? ''),
        label: String(input?.label ?? ''),
        credentials: {
          ...(typeof input?.token === 'string' && input.token !== '' ? { token: input.token } : {}),
          ...(typeof input?.cookie === 'string' && input.cookie !== '' ? { cookie: input.cookie } : {}),
          ...(typeof input?.headersJson === 'string' && input.headersJson.trim() !== ''
            ? { headers: JSON.parse(input.headersJson) as Record<string, string> }
            : {}),
        },
        ...(typeof input?.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        ...(typeof input?.routeChat === 'boolean' ? { routeChat: input.routeChat } : {}),
        ...(typeof input?.autoCheckIn === 'boolean' ? { autoCheckIn: input.autoCheckIn } : {}),
        ...(typeof input?.autoTasks === 'boolean' ? { autoTasks: input.autoTasks } : {}),
        ...(typeof input?.note === 'string' ? { note: input.note } : {}),
      }),
    updateAccount: (input) =>
      runtime.updateAccount(String(input?.id ?? ''), {
        ...(typeof input?.label === 'string' ? { label: input.label } : {}),
        ...(typeof input?.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        ...(typeof input?.routeChat === 'boolean' ? { routeChat: input.routeChat } : {}),
        ...(typeof input?.autoCheckIn === 'boolean' ? { autoCheckIn: input.autoCheckIn } : {}),
        ...(typeof input?.autoTasks === 'boolean' ? { autoTasks: input.autoTasks } : {}),
        ...(typeof input?.note === 'string' ? { note: input.note } : {}),
      }),
    removeAccount: (input) => ({ ok: runtime.removeAccount(String(input?.id ?? '')) }),
    setCredentials: (input) =>
      runtime.setCredentials(String(input?.id ?? ''), {
        ...(typeof input?.token === 'string' && input.token !== '' ? { token: input.token } : {}),
        ...(typeof input?.cookie === 'string' && input.cookie !== '' ? { cookie: input.cookie } : {}),
      }),
    testAccount: (input) => runtime.testAccount(String(input?.id ?? '')),
    checkIn: (input) =>
      runtime.runCheckIn({
        ...(typeof input?.agentId === 'string' ? { agentId: input.agentId } : {}),
        ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
        ...(input?.force === true ? { force: true } : {}),
      }),
    refreshQuota: (input) =>
      runtime.refreshQuotas(typeof input?.agentId === 'string' ? input.agentId : undefined),
    runTasks: (input) =>
      runtime.runTasks({
        ...(typeof input?.agentId === 'string' ? { agentId: input.agentId } : {}),
        ...(typeof input?.accountId === 'string' ? { accountId: input.accountId } : {}),
      }),
    resumeAccount: (input) => ({ ok: runtime.resumeTasks(String(input?.accountId ?? '')) }),
    resetHealth: (input) => ({ ok: runtime.resetHealth(String(input?.accountId ?? '')) }),
    tick: () => runtime.tick(),
    clearTaskLog: () => ({ ok: runtime.clearTaskLog() }),
    // ── OAuth 设备码登录（「不需要 API key」的正解） ──
    loginStart: (input) =>
      runtime.loginStart(
        String(input?.agentId ?? 'opencode'),
        typeof input?.label === 'string' ? input.label : undefined,
      ),
    loginPoll: (input) => runtime.loginPoll(String(input?.loginId ?? '')),
    loginCancel: (input) => ({ ok: runtime.loginCancel(String(input?.loginId ?? '')) }),
  }
  const installed = installRemoteHost(ctx, remoteImpl, {
    info: (message, ...rest) => runtime.logger.info(message, ...rest),
    warn: (message, ...rest) => runtime.logger.warn(message, ...rest),
  })
  if (!installed.ok) {
    // 不是致命错误：宿主没有 typert（或被拒）时，只是设置页拿不到数据。
    runtime.logger.warn(`客户端通道未能装上：${installed.reason ?? '未知原因'}`)
    dshLogger?.warn?.(`[${name}] 客户端通道未装上：${installed.reason ?? '未知原因'}`)
  } else if (installed.dispose !== undefined) {
    disposers.push(installed.dispose)
  }

  // ────────── ⑤ 定时调度 ──────────
  runtime.start()

  // ────────── ⑤b 卸载钩子 ──────────
  // ⚠️ 把 `dispose` 挂到 `ctx.effect` 上：**cordis 不会**替我们调用 `apply` 的返回值，
  // 只有 effect 里的清理函数会在 fiber 销毁（卸载 / HMR 重载）时被调用。
  // 少了这一步，定时器会一直挂着、状态也不会 flush。
  ctx.effect?.(
    () => () => {
      runtime.dispose()
    },
    `${name}: runtime lifecycle`,
  )

  // ────────── ⑥ 配置热更新 ──────────
  //
  // ⚠️ 这里**必须重解析整份配置**，不能只重建定时计划。
  // 只在 `apply()` 时解析一次的后果（实测踩到）：
  // 用户在设置页把「模型上报策略」改成「只报我勾选的」→ 保存成功 → 对话框下拉纹丝不动，
  // 因为运行中的实例还揣着启动时那份 `mode: free`。
  //
  // 宿主把 volatile 字段做成「活引用」，所以拿**同一个 config 对象**重新
  // `resolveConfig()` 就能读到新值；再 `reconfigure()` 换进实例即可。
  ctx.on?.('loader/volatile-update', () => {
    try {
      const next = resolveConfig(config, {
        knownAgentIds: adapters.map((adapter) => adapter.id),
        defaultDataDir: defaultDataDir(),
      })
      runtime.reconfigure(next)
      // Agent 的启用/禁用可能一起变了，路由要跟着增删。
      registerRoutes()
      // ⚠️ 顺序很重要：DSH 的模型下拉是在收到 `llm/adapters-updated` 时才重读目录的。
      // `replace()` 正好会发这个事件（与首次注册同一条路径）。必须在 `reconfigure`
      // **之后**踢，否则刷出来还是旧集合 —— 那就变成「保存了、下拉没变」的老毛病。
      for (const [provider, entry] of routes) {
        try {
          entry.handle?.replace?.([provider])
        } catch (error) {
          runtime.logger.warn(`通知模型目录刷新失败：${provider}`, error instanceof Error ? error.message : String(error))
        }
      }
      runtime.logger.info('配置已热更新（模型上报策略 / 上游地址 / 定时计划均已生效）')
    } catch (error) {
      runtime.logger.error('配置热更新失败', error instanceof Error ? error.message : String(error))
    }
  })

  const handle: PluginHandle = {
    runtime,
    dispose: () => {
      for (const off of disposers.reverse()) {
        try {
          off()
        } catch {
          // 卸载期失败只记不抛。
        }
      }
      for (const route of routes.values()) {
        try {
          route.handle?.()
        } catch {
          // 同上。
        }
      }
      routes.clear()
      runtime.dispose()
      if (lastHandle === handle) lastHandle = null
    },
    reload: () => {
      runtime.refreshSchedule()
      registerRoutes()
    },
  }
  lastHandle = handle
  dshLogger?.info?.(
    `[${name}] 已装载：${adapters.length} 个适配器，${runtime.accounts.all().length} 个账号，` +
      `${routes.size} 个 provider 路由，数据目录 ${resolved.dataDir}`,
  )
  return handle
}

/**
 * ⚠️ **`Config` 必须放进 `export default`。**
 *
 * cordis loader 的 `unwrapExports()` 是：
 * ```
 * exports = exports.default ?? exports
 * if (!exports.__esModule) return exports
 * return exports.default ?? exports
 * ```
 * 也就是说它有 `default` 就**只认 default**，named export 一概不看。
 * 而 `dsh-settings` 的 `describe()` 第一步就取 `entry.fiber.runtime.Config`，
 * 取到 `undefined` 立刻 `return []` —— 插件再正常也不会出现在设置页里。
 */
export default { name, inject, apply, Config }

export { GatewayRuntime } from './runtime.js'
export { builtinAdapters, OpenCodeAdapter, SKELETON_IDS, OPENCODE_OAUTH } from './adapters/index.js'
export { formatMultiplier } from './core/types.js'
export { ERROR_LABELS as errorLabels } from './core/errors.js'
export { DEFAULT_DATA_DIR_NAME }
export * from './paths.js'
