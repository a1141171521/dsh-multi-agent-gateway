/**
 * **GitHub 版本更新**：检查有没有新版本，并一键拉取。
 *
 * ## 为什么用 git 而不是 GitHub API
 *
 * 两条路都能拿到「最新版本号」，但只有一条能**真的把代码换掉**：
 *
 *   - GitHub REST API：需要处理匿名限流（60 次/小时/IP，实测会 403）、
 *     代理、以及「拿到 tarball 之后怎么安全替换」；
 *   - `git fetch/pull`：复用用户**已经配好**的凭据与代理，
 *     而且 `--ff-only` 天然保证「要么干净快进，要么不动」。
 *
 * 所以这里只做 git。不是 git 检出（例如 npm 安装、或本地 `link:` 但没 .git）
 * 时明确回 `supported: false`，让界面给「用 dsh plugin add 重装」的指引，
 * 而不是假装能更新。
 *
 * ## 安全边界
 *
 *   - 只用 `execFile`（不走 shell），参数逐个传，杜绝拼接注入；
 *   - 只在该插件自己的目录里跑；
 *   - `pull --ff-only`：本地有改动/分叉时**拒绝**，不会覆盖用户的东西；
 *   - 每条命令都有超时，卡住不会拖死宿主。
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一次检查的结果。 */
export interface UpdateStatus {
  /** 这个安装方式能不能自我更新（git 检出 = true）。 */
  supported: boolean
  /** 本地 `package.json` 的版本。 */
  current: string
  /** 远端分支上的版本；拿不到就是 null。 */
  latest: string | null
  /** 落后多少个提交。 */
  behind: number
  branch: string | null
  remote: string | null
  checkedAt: number
  /** 不支持或失败时的原因（界面直接显示）。 */
  error?: string
}

/** 更新结果。 */
export interface UpdateResult {
  ok: boolean
  from: string
  to: string
  /** git 的输出（截断），失败时给用户看原话。 */
  output: string
  error?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

/** 跑一条 git 命令，返回 stdout（失败时抛错，错误里带 stderr）。 */
function git(cwd: string, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = String(stderr || stdout || error.message).trim()
        reject(new Error(detail || error.message))
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

/** 读某个目录下 package.json 的 version；读不到返回空串。 */
export function readVersion(dir: string): string {
  try {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string') return version
    }
  } catch {
    // 读不到就是不知道版本，交给调用方显示 —
  }
  return ''
}

/** 解析 semver 的数值段（`1.2.3-beta.1` → [1,2,3]）。 */
export function semverParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isFinite(value) ? value : 0
    })
}

/**
 * 比较两个版本：`a > b` 返回正数，相等 0，小于负数。
 *
 * 只比数值段（`1.2.3` 对 `1.2.3-beta` 视为相等）—— 预发布标记的先后顺序
 * 在这里不影响「要不要更新」的判断，真正的判据是 `behind` 提交数。
 */
export function compareVersions(a: string, b: string): number {
  const left = semverParts(a)
  const right = semverParts(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 检查更新。
 *
 * 全程只读：`fetch` 会更新 `.git` 里的远端引用，但**不动工作区**。
 */
export async function checkUpdate(
  dir: string,
  options: { timeoutMs?: number } = {},
): Promise<UpdateStatus> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const current = readVersion(dir)
  const base: UpdateStatus = {
    supported: false,
    current,
    latest: null,
    behind: 0,
    branch: null,
    remote: null,
    checkedAt: Date.now(),
  }

  try {
    const inside = await git(dir, ['rev-parse', '--is-inside-work-tree'], timeoutMs)
    if (inside !== 'true') {
      return { ...base, error: '插件目录不是 git 检出，无法自我更新' }
    }
  } catch (error) {
    return {
      ...base,
      error: `插件目录不是 git 检出（${error instanceof Error ? error.message : String(error)}），请用 dsh plugin add 重装来更新`,
    }
  }

  let branch = ''
  let remote = ''
  try {
    branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs)
    remote = await git(dir, ['remote', 'get-url', 'origin'], timeoutMs)
  } catch (error) {
    return {
      ...base,
      error: `读不到远端信息：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    await git(dir, ['fetch', '--quiet', 'origin', branch], timeoutMs)
  } catch (error) {
    // fetch 失败通常是网络/代理问题。这里仍返回 supported=true ——
    // 界面要能显示「能更新，但这次检查失败」，而不是把功能整个藏掉。
    return {
      ...base,
      supported: true,
      branch,
      remote,
      error: `拉取远端失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let behind = 0
  try {
    const count = await git(dir, ['rev-list', '--count', `HEAD..origin/${branch}`], timeoutMs)
    behind = Number.parseInt(count, 10) || 0
  } catch {
    behind = 0
  }

  let latest: string | null = null
  try {
    const raw = await git(dir, ['show', `origin/${branch}:package.json`], timeoutMs)
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string') latest = version
    }
  } catch {
    // 远端没有 package.json 或读不到：latest 留 null，判据退回 behind
  }

  return {
    ...base,
    supported: true,
    latest,
    behind,
    branch,
    remote,
    checkedAt: Date.now(),
  }
}

/**
 * 一键更新：`git pull --ff-only`。
 *
 * 为什么是 `--ff-only`：本地有未提交改动、或历史分叉时，普通 `pull` 会
 * 产生一个合并提交甚至冲突 —— 那是**用户没要求**的仓库状态变更。
 * 快进不了就明确报错，让人自己决定。
 */
export async function applyUpdate(
  dir: string,
  options: { timeoutMs?: number } = {},
): Promise<UpdateResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const from = readVersion(dir)
  try {
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs)
    const output = await git(dir, ['pull', '--ff-only', 'origin', branch], timeoutMs)
    const to = readVersion(dir)
    return { ok: true, from, to, output: output.slice(0, 2000) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      from,
      to: from,
      output: message.slice(0, 2000),
      error: message,
    }
  }
}

/** 界面用的一句话摘要。 */
export function describeUpdate(status: UpdateStatus): string {
  if (!status.supported) return status.error ?? '这个安装方式不支持自我更新'
  if (status.error !== undefined) return status.error
  if (status.behind === 0) return `已是最新（${status.current}）`
  const latest = status.latest ?? '未知'
  return `有新版本：${status.current} → ${latest}（落后 ${status.behind} 个提交）`
}
