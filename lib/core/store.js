/**
 * 状态持久化。
 *
 * 三份文件，职责与「丢了会怎样」都不同：
 *
 *   - `accounts.enc.json` —— 账号（凭证整体加密）。**真源**。丢了 = 要重新录账号。
 *   - `state.json`       —— 额度缓存、账号健康、模型缓存、任务历史摘要、游标。
 *                           派生视图：丢了会重算（额度下一次拉取就回来）。
 *   - `task-log.jsonl`   —— 任务执行流水（追加写，审计用）。派生视图，可删。
 *
 * 写入策略：
 *   - `state.json` **防抖 + 原子替换**（写临时文件再 rename），DSH 崩溃不会写出半个 JSON；
 *   - `task-log.jsonl` 追加写，超限自动滚动（保留最近 N 行），不会无限长大；
 *   - 全部操作失败都**抛给调用方并记日志**，不静默吞（硬规则：不许静默失败）。
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
                                        

/** 原子写：先写 `.tmp` 再 rename。 */
export function writeJsonAtomic(path        , value         )       {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

/** 读 JSON；文件不在或坏了返回 `fallback`（并把坏文件改名为 `.corrupt`，不销毁证据）。 */
export function readJsonSafe   (path        , fallback   , log         )    {
  try {
    if (!statSync(path).isFile()) return fallback
  } catch {
    return fallback
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))     
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log?.error(`状态文件解析失败，已改用默认值：${path}`, message)
    try {
      renameSync(path, `${path}.corrupt`)
    } catch {
      // 改名失败也不影响继续跑。
    }
    return fallback
  }
}

/**
 * 防抖写入器：短时间内的多次 `schedule()` 只落一次盘。
 *
 * 为什么必须防抖：额度/健康状态在一次路由里可能被改十几次，每次都同步写盘
 * 会把 IO 打满，而且 DSH 主线程会被拖住。
 */
export class DebouncedWriter {
                   path        
                   delayMs        
                   log                    
          timer                        = null
          pending                         = null

  constructor(path        , delayMs = 800, log         ) {
    this.path = path
    this.delayMs = delayMs
    this.log = log
  }

  /** 安排一次写入；`producer` 在真正落盘那一刻才求值（拿到的永远是最新状态）。 */
  schedule(producer               )       {
    this.pending = producer
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      const job = this.pending
      this.pending = null
      if (job === null) return
      try {
        writeJsonAtomic(this.path, job())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log?.error(`状态写入失败：${this.path}`, message)
      }
    }, this.delayMs)
    // 别因为一个待落盘的状态把进程钉住。
    this.timer.unref?.()
  }

  /** 立刻落盘（插件卸载 / 用户点「保存」时用）。 */
  flush()       {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const job = this.pending
    this.pending = null
    if (job === null) return
    try {
      writeJsonAtomic(this.path, job())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log?.error(`状态写入失败（flush）：${this.path}`, message)
    }
  }

  /** 停掉定时器（卸载时调用）。 */
  dispose()       {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }
}

/** 追加式 JSONL，带滚动上限。 */
export class JsonlLog {
                   path        
                   maxLines        
                   log                    
          lines = -1

  constructor(path        , maxLines = 2000, log         ) {
    this.path = path
    this.maxLines = maxLines
    this.log = log
  }

  /** 追加一条记录。 */
  append(record         )       {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8')
      if (this.lines < 0) this.lines = this.countLines()
      else this.lines += 1
      if (this.lines > this.maxLines) this.rotate()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log?.warn(`任务日志追加失败：${this.path}`, message)
    }
  }

  /** 读最近 n 条（新的在后）。 */
  tail(count = 100)            {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const all = raw.split('\n').filter((line) => line.trim() !== '')
      const slice = all.slice(Math.max(0, all.length - count))
      const out            = []
      for (const line of slice) {
        try {
          out.push(JSON.parse(line))
        } catch {
          out.push({ parseError: true, line: line.slice(0, 400) })
        }
      }
      return out
    } catch {
      return []
    }
  }

          countLines()         {
    try {
      return readFileSync(this.path, 'utf8').split('\n').filter((line) => line.trim() !== '').length
    } catch {
      return 0
    }
  }

  /** 超过上限就把旧文件删掉重来（保留最近 maxLines/2 条）。 */
          rotate()       {
    try {
      const keep = this.tail(Math.floor(this.maxLines / 2))
      const temp = `${this.path}.${process.pid}.tmp`
      writeFileSync(temp, keep.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8')
      renameSync(temp, this.path)
      this.lines = keep.length
      this.log?.debug(`任务日志已滚动：${this.path}`, `${keep.length} 行`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log?.warn(`任务日志滚动失败：${this.path}`, message)
    }
  }

  /** 物理删除（UI 上的「清空记录」）。 */
  reset()       {
    try {
      unlinkSync(this.path)
    } catch {
      // 文件本来就不在，忽略。
    }
    this.lines = 0
  }
}


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\core\store.ts