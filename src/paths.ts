/**
 * 路径解析。
 *
 * 数据目录的默认位置遵循 DSH 的约定：`<DSH_HOME>/multi-agent-gateway`。
 * `DSH_HOME` 由 DSH 自己注入环境变量（默认 `~/.dsh`），所以这里只读环境，
 * **完全不写死任何绝对路径**（跨机器/跨用户都能用）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 数据目录名。 */
export const DEFAULT_DATA_DIR_NAME = 'multi-agent-gateway'

/** DSH 的 HOME。读环境变量，读不到退到 `~/.dsh`。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 默认数据目录：`<DSH_HOME>/multi-agent-gateway`。 */
export function defaultDataDir(): string {
  return join(dshHome(), DEFAULT_DATA_DIR_NAME)
}

/** 当前 profile（用于诊断显示）。 */
export function dshProfile(): string | undefined {
  const value = process.env.DSH_PROFILE
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
