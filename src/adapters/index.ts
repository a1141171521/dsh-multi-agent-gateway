/**
 * 内置适配器清单 —— **新增一个 Agent 只需要动这个文件（加一行）**。
 *
 * 顺序 = DSH 模型选择器里的分组顺序（`llm.listProviders()` 按注册顺序返回）。
 */

import { OpenCodeAdapter } from './opencode.js'
import { BuddyAdapter, BUDDY_CN, BUDDY_INTL } from './buddy.js'
import { QoderAdapter, QODER_CN } from './qoder.js'
import { TraeAdapter } from './trae.js'
import { RaccoonAdapter } from './raccoon.js'
import { QODER } from '../vendor/qoder/qoder-product.js'
import { builtinSkeletons } from './skeletons.js'
import type { AgentAdapter } from '../core/types.js'

/** 这一期已经**真实现**的平台（其余仍是骨架）。 */
const IMPLEMENTED_IDS = new Set([
  'opencode',
  'qoder',
  'qoder-cn',
  'trae',
  'workbuddy',
  'workbuddy-intl',
  'raccoon',
])

/**
 * 固定顺序 = `src/config.ts` 里 `agents` 的键顺序 = 模型选择器的分组顺序。
 *
 * ⚠️ **不能按「先实现的后写」来拼**：注册顺序一变，对话框里分组的位置就变，
 * 而配置里的键顺序没变 —— 两侧漂移会让「设置页第 2 个平台」和
 * 「选择器第 2 个分组」不是同一个东西。
 *
 * ⚠️ **新平台一律追加到末尾**：插在中间会让所有已有用户的分组位置集体后移，
 * 而他们没有任何办法察觉「我的 OpenCode 怎么跑第 3 去了」。
 */
const AGENT_ORDER = [
  'opencode',
  'qoder',
  'qoder-cn',
  'trae',
  'workbuddy',
  'workbuddy-intl',
  'raccoon',
] as const

/**
 * 全部内置适配器。
 *
 * 七个平台**全部真实现**（2026-10-27 加入商汤小浣熊后不再有骨架）：
 * OpenCode、Qoder（国内 / 国际）、Trae、WorkBuddy（国内 / 国际）、商汤小浣熊。
 *
 * 骨架工厂（`builtinSkeletons()`）仍然保留 —— 它是**新增平台时的起点**
 * （`docs/EXTENDING.md` 有流程），只是当前没有平台停在骨架状态。
 */
export function builtinAdapters(): AgentAdapter[] {
  const byId = new Map<string, AgentAdapter>()
  byId.set('opencode', new OpenCodeAdapter())
  byId.set('qoder', new QoderAdapter(QODER))
  byId.set('qoder-cn', new QoderAdapter(QODER_CN))
  byId.set('trae', new TraeAdapter())
  byId.set('workbuddy', new BuddyAdapter(BUDDY_CN))
  byId.set('workbuddy-intl', new BuddyAdapter(BUDDY_INTL))
  byId.set('raccoon', new RaccoonAdapter())
  for (const skeleton of builtinSkeletons()) {
    if (!IMPLEMENTED_IDS.has(skeleton.id)) byId.set(skeleton.id, skeleton)
  }
  return AGENT_ORDER.map((id) => byId.get(id)).filter((item): item is AgentAdapter => item !== undefined)
}

export { OpenCodeAdapter, builtinSkeletons, BuddyAdapter, BUDDY_CN, BUDDY_INTL }
export { QoderAdapter, QODER_CN }
export { TraeAdapter }
export { RaccoonAdapter }
export { parseModelsFromConfig, buddyHeaders, buddyChatHeaders, userAgentFor } from './buddy.js'
export type { BuddyChatIds, BuddyProduct } from './buddy.js'
export { BaseAdapter } from './base.js'
export { createSkeleton } from './skeleton.js'
export { SKELETON_IDS } from './skeletons.js'
export {
  OPENCODE_DEFAULTS,
  OPENCODE_OAUTH,
  OPENCODE_FREE_TIER,
  FREE_TIER_READ_TOOL,
  microCentsToUsd,
  multiplierOf,
  prettifyModelId,
  parseTasks,
  extractCredits,
  isFreeTierError,
  describeOpenCodeError,
  FREE_TIER_MESSAGE,
  canonicalSessionId,
  shapeFreeTierRequest,
} from './opencode.js'
