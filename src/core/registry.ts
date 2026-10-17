/**
 * 适配器注册表。
 *
 * 这是「**新增 Agent 只需要新增适配器，不用改动主框架**」的机械保证：
 *
 *   - 核心层（路由器 / 调度器 / 网关 / LLM 适配器 / UI）只通过
 *     `registry.get(agentId)` 拿一个 `AgentAdapter`；
 *   - `builtinAdapters()` 是唯一的「内置清单」，加一个 Agent 只改那个数组；
 *   - 运行期也可以用 `registry.register()` 插第三方适配器（给以后的外部扩展留口）。
 */

import type { AgentAdapter } from './types.js'

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>()
  private readonly order: string[] = []

  /** 注册（同 id 覆盖，便于热改）。 */
  register(adapter: AgentAdapter): void {
    if (!this.adapters.has(adapter.id)) this.order.push(adapter.id)
    this.adapters.set(adapter.id, adapter)
  }

  /** 批量注册。 */
  registerAll(adapters: AgentAdapter[]): void {
    for (const adapter of adapters) this.register(adapter)
  }

  /** 取一个适配器。 */
  get(agentId: string): AgentAdapter | undefined {
    return this.adapters.get(agentId)
  }

  /** 全部适配器（按注册顺序）。 */
  list(): AgentAdapter[] {
    return this.order.map((id) => this.adapters.get(id)).filter((item): item is AgentAdapter => item !== undefined)
  }

  /** 全部 agentId（按注册顺序）。 */
  ids(): string[] {
    return [...this.order]
  }

  /** 有没有这个 agentId。 */
  has(agentId: string): boolean {
    return this.adapters.has(agentId)
  }

  /** 卸载一个（第三方适配器退出时用）。 */
  unregister(agentId: string): boolean {
    const existed = this.adapters.delete(agentId)
    if (existed) {
      const index = this.order.indexOf(agentId)
      if (index >= 0) this.order.splice(index, 1)
    }
    return existed
  }
}

/**
 * 校验一个适配器是否把**全部**标准化接口都实现了。
 *
 * 为什么要有这一步：少实现一个方法时，JS 只会在**第一次调用**那一刻才报
 * 「xxx is not a function」，而那时用户已经在等结果了。这里在装载阶段就
 * 把缺的方法名一次性列出来。
 */
export function validateAdapter(adapter: AgentAdapter): { ok: boolean; missing: string[] } {
  const required: Array<keyof AgentAdapter> = [
    'id',
    'name',
    'capabilities',
    'getCredentials',
    'validateCredentials',
    'checkIn',
    'getQuota',
    'getModelMetaList',
    'fetchAvailableTasks',
    'executeTask',
    'checkTaskStatus',
    'requestChatStream',
    'detectError',
  ]
  const missing: string[] = []
  for (const key of required) {
    const value = (adapter as unknown as Record<string, unknown>)[key as string]
    if (value === undefined || value === null) missing.push(String(key))
  }
  if (adapter.capabilities === undefined) missing.push('capabilities')
  return { ok: missing.length === 0, missing }
}
