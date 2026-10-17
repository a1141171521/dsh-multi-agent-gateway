/**
 * 日志系统。
 *
 * 两个出口，职责分开：
 *
 *   1. **DSH 日志** —— `ctx.logger`。给「插件到底在干什么」留证据，输出到 DSH 日志。
 *   2. **环形缓冲**（`LogRing`）—— 给客户端 UI 看。固定容量、进程内、不落盘。
 *      「执行日志单独记录：哪个账号、执行了哪个 Agent 的什么任务、是否成功、
 *       获取多少积分」这条要求由 `taskLog`（JSONL 落盘）+ 这个环形缓冲共同满足：
 *       UI 看最近的，落盘那份用于审计。
 *
 * 硬规则：**任何一条日志都不许出现完整凭证**。凭证一律经 `redactSecret`。
 */

import type { Logger } from './types.js'

/** 一条日志记录（会经 Remote 通道送到浏览器）。 */
export interface LogEntry {
  at: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  detail?: string
}

/** 环形缓冲：固定容量，超了丢最老的。 */
export class LogRing {
  private readonly capacity: number
  private readonly items: LogEntry[] = []
  private seq = 0

  constructor(capacity = 300) {
    this.capacity = Math.max(20, capacity)
  }

  push(entry: LogEntry): void {
    this.items.push(entry)
    this.seq += 1
    while (this.items.length > this.capacity) this.items.shift()
  }

  /** 取最近 n 条（新的在后）。 */
  tail(count = 100): LogEntry[] {
    const size = Math.max(1, Math.min(count, this.items.length))
    return this.items.slice(this.items.length - size)
  }

  /** 供 UI 判断「有没有新东西」。 */
  get version(): number {
    return this.seq
  }

  clear(): void {
    this.items.length = 0
    this.seq += 1
  }
}

/** DSH 侧日志器的最小形状（避免硬依赖具体实现）。 */
export interface DshLoggerLike {
  debug?(...args: unknown[]): void
  info?(...args: unknown[]): void
  warn?(...args: unknown[]): void
  error?(...args: unknown[]): void
}

/** 无 DSH 日志器时的兜底（测试/独立运行用）。 */
const CONSOLE_FALLBACK: DshLoggerLike = {
  debug: (...args: unknown[]) => console.debug('[multiagent]', ...args),
  info: (...args: unknown[]) => console.info('[multiagent]', ...args),
  warn: (...args: unknown[]) => console.warn('[multiagent]', ...args),
  error: (...args: unknown[]) => console.error('[multiagent]', ...args),
}

/**
 * 造一个 Logger：同时写 DSH 日志与环形缓冲。
 *
 * @param scope - 前缀（`agent:opencode` / `router` / `scheduler` …）。
 * @param ring - 环形缓冲（UI 数据源）。
 * @param dsh - DSH 日志器（可选）。
 * @param verbose - 是否输出 debug。
 */
export function createLogger(
  scope: string,
  ring: LogRing,
  dsh?: DshLoggerLike,
  verbose = false,
): Logger {
  const sink = dsh ?? CONSOLE_FALLBACK
  /**
   * 调宿主的日志方法。
   *
   * ⚠️ **必须 `fn.call(sink, text)`**，不能 `fn(text)`：`ctx.logger` 是 cordis 的
   * `LoggerService` 实例，它的方法要读 `this`；把方法摘下来裸调会抛错，
   * 结果所有日志都静默掉进兜底的 `console`（真机上表现为「DSH 日志里一条都没有」）。
   */
  const emit = (level: LogEntry['level'], text: string): void => {
    const fn = sink[level] ?? sink.info
    if (typeof fn !== 'function') {
      CONSOLE_FALLBACK.info?.(text)
      return
    }
    try {
      fn.call(sink, text)
    } catch {
      // 宿主日志器自己抛错绝不能把插件带崩。
      CONSOLE_FALLBACK.info?.(text)
    }
  }
  const write = (level: LogEntry['level'], message: string, rest: unknown[]): void => {
    if (level === 'debug' && !verbose) return
    let detail: string | undefined
    if (rest.length > 0) {
      const parts: string[] = []
      for (const item of rest) {
        if (item === undefined || item === '') continue
        try {
          parts.push(typeof item === 'string' ? item : JSON.stringify(item))
        } catch {
          parts.push(String(item))
        }
      }
      if (parts.length > 0) detail = parts.join(' ').slice(0, 2000)
    }
    const entry: LogEntry = { at: Date.now(), level, scope, message, ...(detail === undefined ? {} : { detail }) }
    ring.push(entry)
    emit(level, detail === undefined ? `[${scope}] ${message}` : `[${scope}] ${message} ${detail}`)
  }
  return {
    debug: (message, ...rest) => write('debug', message, rest),
    info: (message, ...rest) => write('info', message, rest),
    warn: (message, ...rest) => write('warn', message, rest),
    error: (message, ...rest) => write('error', message, rest),
    child: (inner: string) => createLogger(`${scope}:${inner}`, ring, dsh, verbose),
  }
}
