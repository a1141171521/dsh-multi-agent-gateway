/**
 * 内置适配器清单 —— **新增一个 Agent 只需要动这个文件（加一行）**。
 *
 * 顺序 = DSH 模型选择器里的分组顺序（`llm.listProviders()` 按注册顺序返回）。
 */

import { OpenCodeAdapter } from './opencode.js'
import { builtinSkeletons } from './skeletons.js'
                                                    

/**
 * 全部内置适配器。
 *
 * 本期：OpenCode 完整实现，其余五个是标准化骨架（每个方法都实现了，
 * 默认返回「上游不支持」，语义明确、不静默失败）。
 */
export function builtinAdapters()                 {
  return [new OpenCodeAdapter(), ...builtinSkeletons()]
}

export { OpenCodeAdapter, builtinSkeletons }
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


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\adapters\index.ts