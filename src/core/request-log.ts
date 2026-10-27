/**
 * **逐请求采样**：把每一次对话调用记成一行，供「日志」页与「总览」的 KPI 使用。
 *
 * ## 为什么要记
 *
 * 出问题时用户能给的只有一句「刚才报错了」。没有逐请求记录，就只能靠猜：
 * 是哪个平台、哪个模型、哪个账号、耗时多少、首字等了多久、上游原话是什么。
 *
 * ## 记什么（以及刻意不记什么）
 *
 * 记：时间、平台、模型、账号、结果、耗时、首字、速度、token 细分、倍率、失败原因。
 * **不记**：请求体、响应体、任何凭证。日志是给排查用的，不是抓包。
 *
 * ## 速度怎么算
 *
 * `tps = 输出 token / 解码耗时`，而解码耗时 = 总耗时 − 首字延迟。
 * 拿总耗时当分母会把首字延迟算进速度里，长提示的请求会被严重低估；
 * 窗口过短（< 50ms）时不给结论（`undefined`），否则一个 1ms 的窗口能算出
 * 几万 tok/s，把整页的均值带飞。
 */

import { JsonlLog } from './store.js'
import type { ErrorKind, Logger } from './types.js'

/** 一条请求记录。字段全部是可选的「不知道就不写」，不拿 0 冒充未知。 */
export interface RequestLogEntry {
  /** 记录时间（毫秒）。 */
  ts: number
  /** 平台 id（`opencode` / `workbuddy` …）。 */
  agentId: string
  /** 平台展示名。 */
  agentName: string
  /** 模型 id（**上游的目录 key**，如 `qfmodel`）。 */
  model: string
  /**
   * 模型的**展示名**（如 `Qwen3.8-Flash`）—— 与 DSH 选择器里显示的一致。
   *
   * ⚠️ 为什么必须单独存一个：目录 key（`qfmodel`）和选择器里的名字
   * （`Qwen3.8-Flash`）**完全是两套词汇**，用户报障过「日志里的模型名
   * 全部都是 qfmodel，并不是真实选中的模型名称」—— 其实记的是**对的**，
   * 只是那不是他在界面上看到的那个名字，两者对不上就等于「看不懂」。
   * 取不到时留空，界面退回显示 id（绝不编一个名字出来）。
   */
  modelName?: string
  /**
   * 用的哪个账号；**没有任何账号参与**时写 `null`。
   *
   * ⚠️ 这里的 `null` 有两种来源，必须分得清（2026-10-27 修）：
   *
   *   1. **免账号通道**（OpenCode 那类）—— 本来就不需要账号，`null` 是常态；
   *   2. **请求在选号阶段就失败了** —— 一个候选都没有，根本没轮到某个账号。
   *
   * 旧实现还有第三种，而且是最常见的一种：**失败时一律写成 `null`**。
   * 成因是 `adapter.ts` 只在**成功之后**才把 `outcome.accountId` 赋给
   * `accountId`，而失败分支在赋值**之前**就 `settle(false)` 了 ——
   * 于是「429 触发了限流，是哪个号」这个用户最想知道的信息，恰恰在失败时全丢。
   * 现在失败时从 `outcome.attempts` 的**最后一次尝试**里取，见 `adapter.ts` 的 `settle`。
   */
  accountId: string | null
  /** 是否成功。 */
  ok: boolean
  /** 总耗时（毫秒）。 */
  durationMs: number
  /** 首字延迟（毫秒）。没出字就是 undefined。 */
  ttftMs?: number
  /** 解码速度（token/秒）。样本不足时为 undefined。 */
  tps?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  /** 该模型的倍率（0 = 免费）。 */
  multiplier?: number
  free?: boolean
  /**
   * 失败分类（`ErrorKind`）。**只有失败时才有**。
   *
   * 为什么要单独记一个 `kind`，而不靠界面去解析 `error` 字符串：界面上要做的
   * 是「鉴权失效 / 触发限流 / 触发风控 / 额度耗尽」四种**完全不同**的处置
   * （重新登录 / 等一会儿 / 换号 / 换号或充值），用正则猜上游原话迟早会猜错，
   * 而 `kind` 在宿主侧是**已经分好的类**（`outcome.failure.kind`），现成的。
   *
   * 记录口径与 `ERROR_LABELS` 一致；界面侧用 `client.js` 的 `FAILURE_TEXT`
   * 翻成一句话（两份必须一起改，`test/client.test.mjs` 有覆盖用例）。
   */
  errorKind?: ErrorKind
  /** 失败原因（上游原话，截断到 300 字）。 */
  error?: string
}

/** 汇总视图（总览页的 KPI 与汇总表）。 */
export interface RequestSummary {
  total: number
  /** 今天的请求数（按本地日期切）。 */
  today: number
  ok: number
  failed: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  /** 平均首字延迟；没有样本时 null。 */
  avgTtftMs: number | null
  /** 平均解码速度；没有样本时 null。 */
  avgTps: number | null
  byModel: Array<{
    agentId: string
    model: string
    calls: number
    failed: number
    inputTokens: number
    outputTokens: number
    ttftMs: number | null
    tps: number | null
  }>
  byAgent: Array<{ agentId: string; agentName: string; calls: number; failed: number; models: number }>
  /** 最近一条（总览的「最近一回合」）。 */
  last: RequestLogEntry | null
}

/** 解码速度的下限：窗口短于此就不给结论。 */
const MIN_DECODE_MS = 50

/** 算一个请求的速度；样本不足返回 undefined。 */
export function computeTps(input: {
  durationMs: number
  ttftMs?: number
  outputTokens?: number
}): number | undefined {
  const { durationMs, ttftMs, outputTokens } = input
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) return undefined
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) return undefined
  const decodeMs = durationMs - ttftMs
  if (!Number.isFinite(decodeMs) || decodeMs < MIN_DECODE_MS) return undefined
  return Math.round((outputTokens / (decodeMs / 1000)) * 10) / 10
}

/** 本地日期键（用于「今天」）。 */
function dayKey(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/** 平均值的辅助：忽略 undefined，空集返回 null。 */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const value of values) sum += value
  return Math.round((sum / values.length) * 10) / 10
}

/**
 * 请求日志：内存环形缓冲 + JSONL 追加落盘。
 *
 * 内存里保存最近 `maxEntries` 条（新的在前），查询与汇总都走内存；
 * 磁盘只是为了让重启后还能看到昨天的记录。
 */
export class RequestLog {
  private readonly file: JsonlLog
  private readonly maxEntries: number
  private readonly log: Logger | undefined
  /** 新的在前。 */
  private entries: RequestLogEntry[] = []

  constructor(path: string, options: { maxEntries?: number; log?: Logger } = {}) {
    this.maxEntries = Math.max(50, Math.floor(options.maxEntries ?? 2000))
    this.log = options.log
    // 磁盘上限比内存略大，滚动时不至于把内存里还在显示的记录也删掉。
    this.file = new JsonlLog(path, Math.floor(this.maxEntries * 1.5), options.log)
    this.load()
  }

  /** 从磁盘恢复最近若干条（新的在前）。 */
  private load(): void {
    const rows = this.file.tail(this.maxEntries) as RequestLogEntry[]
    this.entries = rows
      .filter((row) => row !== null && typeof row === 'object' && typeof (row as RequestLogEntry).ts === 'number')
      .reverse()
    if (this.entries.length > 0) this.log?.debug(`请求日志已载入 ${this.entries.length} 条`)
  }

  /** 记一条。返回落库后的记录（补齐 ts）。 */
  record(input: Omit<RequestLogEntry, 'ts'> & { ts?: number }): RequestLogEntry {
    const entry: RequestLogEntry = {
      ...input,
      ts: typeof input.ts === 'number' ? input.ts : Date.now(),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      ...(input.ttftMs === undefined ? {} : { ttftMs: Math.max(0, Math.round(input.ttftMs)) }),
      ...(input.error === undefined ? {} : { error: String(input.error).slice(0, 300) }),
    }
    this.entries.unshift(entry)
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries
    this.file.append(entry)
    return entry
  }

  /** 分页查询（新的在前）。 */
  list(options: { limit?: number; offset?: number } = {}): { total: number; entries: RequestLogEntry[] } {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 20)))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    return { total: this.entries.length, entries: this.entries.slice(offset, offset + limit) }
  }

  /** 清空（内存 + 磁盘）。 */
  clear(): void {
    this.entries = []
    this.file.clear()
  }

  /** 汇总。 */
  summary(now = Date.now()): RequestSummary {
    const today = dayKey(now)
    let ok = 0
    let failed = 0
    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let todayCount = 0
    const ttfts: number[] = []
    const tpss: number[] = []
    const models = new Map<string, RequestSummary['byModel'][number]>()
    /** 每个模型的 ttft / tps 样本，边遍历边收集（避免再扫一遍全表）。 */
    const samples = new Map<string, { ttft: number[]; tps: number[] }>()
    const agents = new Map<string, { agentId: string; agentName: string; calls: number; failed: number; models: Set<string> }>()

    for (const entry of this.entries) {
      if (dayKey(entry.ts) === today) todayCount += 1
      if (entry.ok) ok += 1
      else failed += 1
      inputTokens += entry.inputTokens ?? 0
      outputTokens += entry.outputTokens ?? 0
      reasoningTokens += entry.reasoningTokens ?? 0
      if (typeof entry.ttftMs === 'number') ttfts.push(entry.ttftMs)
      if (typeof entry.tps === 'number') tpss.push(entry.tps)

      const modelKey = `${entry.agentId}\u0000${entry.model}`
      const modelRow = models.get(modelKey) ?? {
        agentId: entry.agentId,
        model: entry.model,
        calls: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        ttftMs: null,
        tps: null,
      }
      modelRow.calls += 1
      if (!entry.ok) modelRow.failed += 1
      modelRow.inputTokens += entry.inputTokens ?? 0
      modelRow.outputTokens += entry.outputTokens ?? 0
      models.set(modelKey, modelRow)

      const bucket = samples.get(modelKey) ?? { ttft: [], tps: [] }
      if (typeof entry.ttftMs === 'number') bucket.ttft.push(entry.ttftMs)
      if (typeof entry.tps === 'number') bucket.tps.push(entry.tps)
      samples.set(modelKey, bucket)

      const agentRow = agents.get(entry.agentId) ?? {
        agentId: entry.agentId,
        agentName: entry.agentName,
        calls: 0,
        failed: 0,
        models: new Set<string>(),
      }
      agentRow.calls += 1
      if (!entry.ok) agentRow.failed += 1
      agentRow.models.add(entry.model)
      agents.set(entry.agentId, agentRow)
    }

    // 每个模型的均值单独算（不能用全局均值糊过去）
    for (const [key, row] of models) {
      const bucket = samples.get(key)
      row.ttftMs = bucket === undefined ? null : mean(bucket.ttft)
      row.tps = bucket === undefined ? null : mean(bucket.tps)
    }

    return {
      total: this.entries.length,
      today: todayCount,
      ok,
      failed,
      inputTokens,
      outputTokens,
      reasoningTokens,
      avgTtftMs: mean(ttfts),
      avgTps: mean(tpss),
      byModel: [...models.values()].sort((left, right) => right.calls - left.calls),
      byAgent: [...agents.values()]
        .map((row) => ({
          agentId: row.agentId,
          agentName: row.agentName,
          calls: row.calls,
          failed: row.failed,
          models: row.models.size,
        }))
        .sort((left, right) => right.calls - left.calls),
      last: this.entries[0] ?? null,
    }
  }
}
