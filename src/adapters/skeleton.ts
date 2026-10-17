/**
 * 骨架工厂。
 *
 * 五个待实现的 Agent（Qoder / Qoder CN / Trae / WorkBuddy / WorkBuddy 国际版）
 * 共用这一个工厂 —— 它们的差别只有 id / 显示名 / 文档地址 / 已知的上游形态，
 * 没有任何一条业务逻辑需要现在写。
 *
 * **为什么用工厂而不是五个空类**：空类会漂（五份 `unsupported` 文案改一处忘四处），
 * 而且「哪一条还没实现」会散在五个文件里。工厂把「未实现」这件事收成一个明确状态：
 * `implemented: false`，UI 上打「待实现」标，`capabilities.source: 'static'`。
 *
 * 每个骨架都**如实声明**了自己已知的信息（官方端点形状），
 * 这样真正动手时不用再查一遍。参考 `opencode.ts` 的完整实现。
 */

import { BaseAdapter } from './base.js'
import type { AgentCapabilities } from '../core/types.js'

/** 待实现 Agent 的静态描述。 */
export interface SkeletonSpec {
  id: string
  name: string
  /** 官方文档 / 控制台地址。 */
  doc?: string
  /** 上游形态（写进 capabilities.notes，UI 直接显示）。 */
  upstream: string
  /** 已知的鉴权形态。 */
  credentialHint: string
  /** 已知存在的能力（其余一律 false）。 */
  known?: Partial<Pick<AgentCapabilities, 'checkIn' | 'quota' | 'models' | 'tasks' | 'chat' | 'reasoning'>> & {
    /** 已知的默认端点（chat base url）。 */
    chatBaseUrl?: string
    /** 已知的默认 API base url。 */
    apiBaseUrl?: string
  }
}

/** 造一个骨架适配器。 */
export function createSkeleton(spec: SkeletonSpec): BaseAdapter {
  const known = spec.known ?? {}
  const notImplemented = `「${spec.name}」适配器尚未实现（本期只交付 OpenCode 的完整实现 + 其余 Agent 的标准化骨架）。` +
    `上游形态：${spec.upstream}` +
    (known.chatBaseUrl === undefined ? '' : `；已知对话端点：${known.chatBaseUrl}`) +
    (known.apiBaseUrl === undefined ? '' : `；已知控制台端点：${known.apiBaseUrl}`)

  const capabilities: AgentCapabilities = {
    // 骨架一律声明「不支持」，避免核心调度器对着一个没有实现的上游定时打请求。
    checkIn: known.checkIn ?? false,
    quota: known.quota ?? false,
    models: known.models ?? false,
    tasks: known.tasks ?? false,
    chat: known.chat ?? false,
    reasoning: known.reasoning ?? false,
    source: 'static',
    notes: {
      checkIn: notImplemented,
      quota: notImplemented,
      models: notImplemented,
      tasks: notImplemented,
      chat: notImplemented,
    },
  }
  return new BaseAdapter({
    id: spec.id,
    name: spec.name,
    ...(spec.doc === undefined ? {} : { doc: spec.doc }),
    credentialHint: spec.credentialHint,
    capabilities,
    implemented: false,
  })
}
