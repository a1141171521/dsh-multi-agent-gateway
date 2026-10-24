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
  /**
   * 落后多少个提交。
   *
   * ⚠️ 它是**唯一**的「要不要更新」判据；版本号只是给人看的标签。
   * 拿不到时保守留在 `0`，同时置 `error` —— 由 `available: false` +
   * `message` 把「没查出来」和「确实最新」区分开（见 `finalize()`）。
   */
  behind: number
  branch: string | null
  remote: string | null
  checkedAt: number
  /** 不支持或失败时的原因（界面直接显示）。 */
  error?: string
  /**
   * 有没有可拉取的更新（= `behind > 0`）。
   *
   * ⚠️ **判据就是 `behind`，不掺版本号比较**：本项目三个提交的 `package.json`
   * 一直都是 `0.1.0`、也没有 tag，所以「版本号相等但落后 2 个提交」是**常态**。
   * 用 `compareVersions` 当开关的话，这种仓库永远显示「已是最新」——
   * 那正是这次报障的现场（见 `compareVersions` 上面的注释）。
   *
   * 这个字段是**为客户端补的**：客户端徽标读 `available === true` 才显示「可更新」，
   * 而它以前压根没被下发过（`undefined === true` 恒 false）——
   * 于是「检查更新」这个功能**从来没生效过**，与落后多少提交无关。
   */
  available: boolean
  /**
   * 一句话人话摘要 —— **一律**走 `describeUpdate()`，不要在别处另写文案。
   *
   * 三种口径都收在里面：`已是最新（0.1.0）` / `有新版本：…（落后 N 个提交）` /
   * 以及失败原因（`拉取远端失败：…`、`无法判断落后多少：…`）。
   * 客户端直接显示它即可，不必再自己拼一遍「为什么没更新」。
   */
  message: string
}

/**
 * 还没补 `available` / `message` 的内部形态。
 *
 * 用它做唯一出口（`finalize`）的原因：这两个字段是**派生**的，散落在
 * 四个 `return` 上分别手写，早晚会漏一个 —— 而漏掉的那个就会退回
 * 「字段是 undefined、界面恒显示已是最新」这次报障的老路。
 */
type UpdateCore = Omit<UpdateStatus, 'available' | 'message'>

/**
 * 补齐派生字段：`available` 由 `behind` 算出，`message` 一律走 `describeUpdate()`。
 *
 * 把「字段一定存在」和「文案只有一份」这两条不变式收在一个函数里。
 */
function finalize(core: UpdateCore): UpdateStatus {
  const available = core.behind > 0
  const draft: UpdateStatus = { ...core, available, message: '' }
  return { ...draft, message: describeUpdate(draft) }
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

/**
 * 重试直连时的超时。
 *
 * ⚠️ 刻意比默认值短得多。实测（本机，GitHub 不可达时）：
 *   - 走一个死掉的回环代理：**~2 秒**就失败（端口直接拒绝连接）；
 *   - 强制直连：**~21 秒**才失败（TCP 连不上，等的是系统超时）。
 * 直连失败让用户干等 21 秒是不可接受的，所以重试给 10 秒就打住。
 */
const DIRECT_RETRY_TIMEOUT_MS = 10_000

/**
 * 「绕过代理」的 git 参数（空值覆盖仓库级/全局配置）。
 *
 * 本机实测有效：`git -c http.proxy= -c https.proxy= fetch ...` 确实不走代理。
 * ⚠️ 用 `-c` 而**不是**改 `.git/config` —— 后者是用户环境，改它越权了。
 */
const DIRECT_PROXY_OVERRIDE: readonly string[] = ['-c', 'http.proxy=', '-c', 'https.proxy=']

/** 一次 git 调用的结果（不抛错，便于按失败原因分支）。 */
export interface GitOutcome {
  ok: boolean
  stdout: string
  /** 失败时的原文：stderr → stdout → error.message 里第一个非空的。 */
  detail: string
  /** 是不是被超时杀掉的（此时 stderr 往往是**空的**，见 `describeFetchFailure`）。 */
  timedOut: boolean
}

/** 默认执行器：真的起一个 git 进程。 */
const runGitReal = (cwd: string, args: readonly string[], timeoutMs: number): Promise<GitOutcome> =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const out = String(stdout).trim()
        if (error === null) {
          resolve({ ok: true, stdout: out, detail: '', timedOut: false })
          return
        }
        // ⚠️ 超时被杀时 stderr 是空的（实测），只剩 error.message 里那串
        // "Command failed: git ..."。把它当 detail 会把**我们自己的命令行**
        // 显示给用户，既不解释问题也没法行动 —— 所以单独标记 timedOut，
        // 由文案层翻译成「连接超时」。
        const timedOut = (error as { killed?: boolean }).killed === true
        const detail = String(stderr || stdout || error.message).trim()
        resolve({ ok: false, stdout: out, detail, timedOut })
      },
    )
  })

/** 可替换的 git 执行器（**唯一**的执行入口）。 */
let gitRunner: typeof runGitReal = runGitReal

/** 跑一条 git 命令（结构化结果版）。 */
function runGitOutcome(
  cwd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GitOutcome> {
  return gitRunner(cwd, args, timeoutMs)
}

/**
 * 替换 git 执行器（**只给测试用**），返回还原函数。
 *
 * 为什么留这个缝：代理失败 / 重试直连那两条分支，真实验证要联网且要
 * 「Clash 一开一关」才造得出来；单测必须离线可跑，还要能稳定造出
 * 「代理挂了」和「代理挂了＋直连也挂了」两种局面。测试用**真实抓到的
 * git stderr 原文**驱动它，分支覆盖就是真的。生产路径永远用 `runGitReal`。
 */
export function __setGitRunnerForTest(runner: typeof runGitReal | null): () => void {
  const previous = gitRunner
  gitRunner = runner ?? runGitReal
  return () => {
    gitRunner = previous
  }
}

/** 跑一条 git 命令，返回 stdout（失败时抛错，错误里带 stderr）。 */
function git(cwd: string, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return runGitOutcome(cwd, args, timeoutMs).then((outcome) => {
    if (!outcome.ok) throw new Error(outcome.detail || 'git 命令失败')
    return outcome.stdout
  })
}

// ───────────────────────── 「连不上代理」的识别与翻译 ─────────────────────────

/**
 * **强特征**：出现即说明「这次请求确实走了代理，且代理没接住」。
 *
 * `over proxy <host>` 是最可靠的一条 —— 实测（本机）**只有真的走了代理才会出现**：
 *   - 代理挂着 + 代理没开 → `Failed to connect to github.com:443 **over proxy 127.0.0.1** … Could not connect to server`
 *   - 强制直连 + 也连不上 → `Failed to connect to github.com:443 after 21039 ms: Could not connect to server`（**没有** `over proxy`）
 * 所以它是区分「代理坏了」与「网线/直连坏了」的关键，别退化成只看后半句。
 */
const PROXY_STRONG_MARKERS: readonly string[] = [
  'over proxy',
  'proxy connect aborted',
  'econnrefused',
  'proxyconnect tcp',
]

/**
 * **弱特征**：连接层失败，但**无法区分**是代理的问题还是直连的问题 ——
 * 实测直连失败同样是这一句（`… after 21039 ms: Could not connect to server`）。
 *
 * 所以只有在「确实配了代理」时才能把它们归到代理头上，否则会把一次直连失败
 * 说成「代理没开」（用户去开代理，白折腾）。
 */
const PROXY_WEAK_MARKERS: readonly string[] = [
  'could not connect to server',
  'failed to connect to',
  'connection refused',
  'connection timed out',
]

/** 从代理串里取主机名（`http://127.0.0.1:7897` → `127.0.0.1`）。 */
export function proxyHostOf(proxy: string): string | null {
  const raw = proxy.trim()
  if (raw === '') return null
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    const host = url.hostname.toLowerCase()
    return host.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/**
 * 这个代理是不是**回环地址**（本机自己）。
 *
 * 只有回环代理才允许「连不上就试直连」：回环代理连不上，含义唯一 ——
 * 那个本地代理软件没开。非回环（公司代理 / 网关）连不上可能是网络策略，
 * **绝不能**绕过它去直连。
 */
export function isLoopbackProxy(proxy: string): boolean {
  const host = proxyHostOf(proxy)
  if (host === null) return false
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/** 把一段可能很长的 git stderr 压成能塞进设置页一行的短句。 */
export function shortenDetail(detail: string, max = 160): string {
  const oneLine = detail.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

/** 一次 fetch 失败的归类结论。 */
export interface FetchFailureInfo {
  /**
   * `proxy-unreachable` = 有**确凿**证据说明是代理的问题（见到 `over proxy` 这类强特征）；
   * `proxy-suspect` = 只是「连接类失败」且确实配了代理，但分不清是代理还是直连的问题；
   * `unknown` = 认不出来，保留原文。
   */
  kind: 'proxy-unreachable' | 'proxy-suspect' | 'unknown'
  /** 从 git 配置里**现取**的代理地址（取不到就是 null）。 */
  proxy: string | null
  /** 代理是回环地址（决定要不要试直连）。 */
  loopback: boolean
  /** 是否满足「重试直连」的**窄**条件。 */
  retryDirect: boolean
}

/**
 * 判断一次 fetch 失败是不是「连不上代理」。
 *
 * 判据全在 git 的原文里（**不看 exit code** —— 失败的 code 都一样）。
 *
 * 分三档而不是两档，是实测逼出来的（本机 2026-10-24 抓的原文对照）：
 *
 * | 场景 | stderr 关键片段 | 应当的结论 |
 * |---|---|---|
 * | 代理挂着+没开 | `… over proxy 127.0.0.1 … Could not connect to server` | **确凿**是代理 |
 * | 强制直连+连不上 | `… after 21039 ms: Could not connect to server`（**无** `over proxy`） | 别赖代理 |
 *
 * 只看 `Could not connect to server` 会把第二种错报成「代理没开」，
 * 用户跑去开代理白折腾 —— 所以**弱特征单独出现时不敢下结论**，只报「存疑」，
 * 且**不触发直连重试**（原因都没搞清就别动网络路径）。
 *
 * 认不出来时老老实实返回 `unknown`，绝不把未知失败说成「代理没开」。
 */
export function classifyFetchFailure(detail: string, proxy: string | null): FetchFailureInfo {
  const text = detail.toLowerCase()
  const loopback = proxy !== null && isLoopbackProxy(proxy)

  const strong = PROXY_STRONG_MARKERS.some((marker) => text.includes(marker))
  // 弱特征只在「确实配了代理」时才敢采纳 —— 否则直连失败会被误判（见上表第二行）。
  const weak = proxy !== null && PROXY_WEAK_MARKERS.some((marker) => text.includes(marker))

  if (strong) {
    return {
      kind: 'proxy-unreachable',
      proxy,
      loopback,
      // ★ 窄条件：确凿是代理问题 **且** 代理在回环地址上，才试直连。
      retryDirect: loopback,
    }
  }
  if (weak) {
    return { kind: 'proxy-suspect', proxy, loopback, retryDirect: false }
  }
  return { kind: 'unknown', proxy, loopback, retryDirect: false }
}

/**
 * 我们自己的命令行前缀。
 *
 * 超时被杀时 stderr 是空的，`error.message` 只剩 `Command failed: git …`——
 * 把**我们自己执行的命令**显示给用户，既不解释问题也没法行动。
 */
const COMMAND_FAILED_PREFIX = /^command failed:\s*git\b/i

/** 判断一段 detail 是不是「没有信息量」（我们自己的命令行 / 空）。 */
export function isUninformativeDetail(detail: string): boolean {
  const text = detail.trim()
  return text === '' || COMMAND_FAILED_PREFIX.test(text)
}

/**
 * 把 fetch 失败翻译成**可操作**的一句话。
 *
 * 四种情形分开说，且都不把 git 的 `fatal: unable to access …` 原样丢给用户
 * （那是真话但没法行动 —— 用户报障的正是「看完不知道要干什么」）。
 */
export function describeFetchFailure(input: {
  info: FetchFailureInfo
  /** 第一次（走代理）失败原文。 */
  proxyDetail: string
  /** 重试直连的结果；没重试就是 undefined。 */
  direct?: { ok: boolean; detail: string }
  /** 是否被超时杀掉（此时原文里没有有用信息）。 */
  timedOut: boolean
  /** 超时预算（秒），用于文案。 */
  timeoutMs: number
}): string {
  const { info, proxyDetail, direct, timedOut, timeoutMs } = input
  const seconds = Math.round(timeoutMs / 1000)

  // 超时：stderr 是空的，只剩我们自己的命令行 —— 直接说清是超时。
  if (timedOut && info.kind === 'unknown') {
    return `拉取远端失败：连接超时（${seconds} 秒内没完成）。检查网络后点「检查更新」重试。`
  }

  if (info.kind === 'unknown') {
    if (isUninformativeDetail(proxyDetail)) {
      return `拉取远端失败：原因未知（${seconds} 秒内未完成）。检查网络或代理后重试。`
    }
    return `拉取远端失败：${shortenDetail(proxyDetail)}`
  }

  const where = info.proxy === null ? '代理' : `代理 ${info.proxy}`

  // 存疑档：连接类失败 + 确实配了代理，但没能确证是代理的锅。
  // 话要说得像「可能」，不能替用户断定「代理没开」（他可能配着公司代理、
  // 而真正的问题是网络）。也**不重试** —— 原因不明时不动网络路径。
  if (info.kind === 'proxy-suspect') {
    return (
      `拉取远端失败：连不上${where}（本地代理软件没开？）。` +
      `也可能是网络本身不通 —— 请确认代理在运行；或临时改用直连重试。`
    )
  }

  const hint = '本地代理软件（Clash 等）可能没开'
  if (direct === undefined) {
    return (
      `拉取远端失败：连不上${where}（${hint}）。` +
      `开好后点「检查更新」重试；或临时 git config --unset http.proxy 改成直连。`
    )
  }

  if (direct.ok) {
    // 直连成功：明确告诉用户结果不是走常规路径来的。
    return `拉取远端失败：连不上${where}（${hint}）；已改用直连，以下结果按直连计算。`
  }

  // ★ 两次都失败：必须**同时**说清两次尝试，不能只报第二条。
  const directReason = isUninformativeDetail(direct.detail)
    ? `${Math.round(DIRECT_RETRY_TIMEOUT_MS / 1000)} 秒内没连上`
    : shortenDetail(direct.detail, 100)
  return `拉取远端失败：连不上${where}（${hint}）；改用直连也失败：${directReason}`
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
  const base: UpdateCore = {
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
      return finalize({ ...base, error: '插件目录不是 git 检出，无法自我更新' })
    }
  } catch (error) {
    return finalize({
      ...base,
      error: `插件目录不是 git 检出（${error instanceof Error ? error.message : String(error)}），请用 dsh plugin add 重装来更新`,
    })
  }

  let branch = ''
  let remote = ''
  try {
    branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs)
    remote = await git(dir, ['remote', 'get-url', 'origin'], timeoutMs)
  } catch (error) {
    return finalize({
      ...base,
      error: `读不到远端信息：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // ── fetch：失败时①翻译成可操作的话 ②回环代理才试直连 ──
  // 「已改用直连」这类**附带说明**：正常流程照走，但要记下来一路带到最终 message。
  let pendingFetchNote: string | undefined
  const fetchArgs = ['fetch', '--quiet', 'origin', branch]
  const outcome = await runGitOutcome(dir, fetchArgs, timeoutMs)

  if (!outcome.ok) {
    // 代理地址**现取**（不写死）：仓库级 / 全局都可能设，`http.proxy` 没有就试 `https.proxy`。
    const proxyConfig = await readProxyConfig(dir)
    const info = classifyFetchFailure(outcome.detail, proxyConfig.proxy)

    // ② 只在**窄条件**下重试：确认是代理问题 **且** 代理在回环地址上。
    //    非回环代理绝不重试 —— 那会绕过用户/公司的网络策略。
    //    超时（stderr 为空、认不出来）也不重试：连原因都不知道就别动网络路径。
    let direct: { ok: boolean; detail: string } | undefined
    if (info.retryDirect) {
      const retry = await runGitOutcome(dir, [...DIRECT_PROXY_OVERRIDE, ...fetchArgs], DIRECT_RETRY_TIMEOUT_MS)
      direct = { ok: retry.ok, detail: retry.detail }
      if (retry.ok) {
        // 直连成功：继续往下走「算 behind」的流程，把代理那份失败降级成一句说明。
        const note = describeFetchFailure({
          info,
          proxyDetail: outcome.detail,
          direct,
          timedOut: outcome.timedOut,
          timeoutMs,
        })
        pendingFetchNote = note
      }
    }

    if (direct === undefined || !direct.ok) {
      return finalize({
        ...base,
        supported: true,
        branch,
        remote,
        error: describeFetchFailure({
          info,
          proxyDetail: outcome.detail,
          ...(direct === undefined ? {} : { direct }),
          timedOut: outcome.timedOut,
          timeoutMs,
        }),
      })
    }
  }

  let behind = 0
  let behindError: string | undefined
  try {
    const count = await git(dir, ['rev-list', '--count', `HEAD..origin/${branch}`], timeoutMs)
    behind = Number.parseInt(count, 10) || 0
  } catch (error) {
    // ⚠️ 这里**必须**留一句 error，不能静默当成 0。
    // 静默的后果是 `behind === 0` ⇒ `describeUpdate()` 说「已是最新」——
    // 把「没查出来」谎报成「确认最新」，用户就再也不会去点更新了。
    behind = 0
    behindError = `无法判断落后多少：${error instanceof Error ? error.message : String(error)}`
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

  return finalize({
    ...base,
    supported: true,
    latest,
    behind,
    branch,
    remote,
    checkedAt: Date.now(),
    // 「已改用直连」这句只在真的发生过回落时才出现；它**优先于** behindError，
    // 因为它是用户更该知道的那件事（结果不是走常规路径来的）。
    ...(pendingFetchNote === undefined
      ? (behindError === undefined ? {} : { error: behindError })
      : { error: pendingFetchNote }),
  })
}

/**
 * 读本机生效的代理配置（**现取，不写死**）。
 *
 * 顺序：`http.proxy` → `https.proxy`。两者都可能是仓库级或全局的，
 * 交给 git 自己解析（`git config --get` 会按层级取生效值）。
 * 取不到（退出码非 0 / 输出为空）就是 null。
 */
async function readProxyConfig(dir: string): Promise<{ proxy: string | null }> {
  for (const key of ['http.proxy', 'https.proxy']) {
    const outcome = await runGitOutcome(dir, ['config', '--get', key], 5_000)
    if (outcome.ok && outcome.stdout.trim() !== '') return { proxy: outcome.stdout.trim() }
  }
  return { proxy: null }
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
