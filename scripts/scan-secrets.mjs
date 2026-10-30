/**
 * 公开仓库脱敏扫描：提交前跑一次。
 *
 * ## 为什么需要
 *
 * 本仓库是**公开**的（GitHub public）。真机抓包得到的 uid / token / 余额 /
 * request_id 一旦进了 fixture 或文档，就永远留在了 git 历史里 —— 事后删文件
 * 也扫不掉，只能改历史。所以必须在 `git add` 之前拦。
 *
 * 人眼不可靠：一份 20KB 的 fixture 里混进一个 32 位 request-id，review 时
 * 根本看不出来。这里只做**机械可判**的那部分，判不了的留给清单里的人工项。
 *
 * ## 用法
 *
 *   node scripts/scan-secrets.mjs        # 扫描（发现 error 级问题则退出码 1）
 *
 * 想放过某一行（比如文档里就要写一个示例手机号），在该行任意位置加
 * `scan-ignore` 注释即可。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 扫描范围：会被发布或会被公开阅读的内容。`lib`/`src` 是源码（只有字段名，没有值）。 */
const TARGETS = ['test', 'docs', 'scripts', 'README.md', 'plugin.json', 'package.json', 'cordis.patch.yml']
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt', '.html', '.css'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'prototype'])

/** 造出来的假值不算泄露。命中值里带这些词就放过。 */
const FAKE_HINT = /(test|fake|dummy|sample|redact|example|smoke|placeholder|mock|fixture|secret|xxx)/i

/**
 * 一眼假的形态：纯数字（`12345678901234567`）、8 个以上重复字符
 * （`aaaa…`、`0000…0001`）。真实 uid / request-id 不会长这样。
 */
function isSynthetic(value) {
  if (/^[0-9]+$/.test(value)) return true
  return /(.)\1{7,}/.test(value)
}

const RULES = [
  {
    level: 'error',
    name: '手机号',
    hint: '真机账号的手机号',
    re: /(?:^|[^0-9A-Za-z])(1[3-9][0-9]{9})(?![0-9A-Za-z])/g,
  },
  {
    level: 'error',
    name: 'Bearer',
    hint: 'Authorization 头里的真 token',
    re: /Bearer\s+([A-Za-z0-9._-]{20,})/g,
  },
  {
    level: 'error',
    name: '凭证赋值',
    hint: 'token / cookie / apiKey 被赋了一个长值',
    re: /(?:token|cookie|authorization|api[_-]?key|secret|password)\s*[:=]\s*['"`]([A-Za-z0-9._\-+/=]{24,})['"`]/gi,
  },
  {
    level: 'error',
    name: '邮箱',
    hint: '真机账号绑定的邮箱',
    re: /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    allow: /@(example\.(com|org|net)|test\.(local|com)|invalid|localhost|users\.noreply\.github\.com)$/i,
  },
  {
    level: 'warn',
    name: '疑似真 ID',
    hint: 'uid / requestId / sessionId 被赋了一个像真的值',
    skipSynthetic: true,
    re: /(?:uid|userId|accountId|requestId|rootRequestId|conversationId|sessionId)\s*[:=]\s*['"`]([A-Za-z0-9_-]{10,})['"`]/g,
  },
  {
    level: 'warn',
    name: '疑似真余额',
    hint: '积分 / 余额写成了具体数字',
    scope: 'docs',
    re: /(?:available_points|availablePoints|balance|credits)\s*[:=]\s*([1-9][0-9]{2,})/g,
  },
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(full)
      continue
    }
    if (!TEXT_EXT.has(extname(full))) continue
    if (info.size > 2 * 1024 * 1024) continue
    yield full
  }
}

/** 命中值脱敏后再打印 —— 扫描器自己的输出不许再泄露一次。 */
function mask(value) {
  const text = String(value)
  if (text.length <= 8) return text
  return `${text.slice(0, 4)}…${text.slice(-2)}（${text.length} 位）`
}

const hits = []

for (const target of TARGETS) {
  const full = join(root, target)
  let info
  try {
    info = statSync(full)
  } catch {
    continue
  }
  const files = info.isDirectory() ? [...walk(full)] : [full]
  for (const file of files) {
    const rel = relative(root, file)
    // 文档正文里出现具体数字才可疑；测试用例里的 100 / 5000 天生是编的。
    const inDocs = !rel.startsWith('test') && !rel.startsWith('scripts')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (line.includes('scan-ignore')) return
      if (line.length > 4000) return
      for (const rule of RULES) {
        if (rule.scope === 'docs' && !inDocs) continue
        rule.re.lastIndex = 0
        let match
        while ((match = rule.re.exec(line)) !== null) {
          const value = match[1] ?? match[0]
          if (FAKE_HINT.test(value)) continue
          if (rule.skipSynthetic && isSynthetic(value)) continue
          if (rule.allow && rule.allow.test(value)) continue
          hits.push({
            level: rule.level,
            rule: rule.name,
            hint: rule.hint,
            where: `${rel}:${index + 1}`,
            value: mask(value),
          })
          if (match[0].length === 0) break
        }
      }
    })
  }
}

const errors = hits.filter((hit) => hit.level === 'error')
const warns = hits.filter((hit) => hit.level === 'warn')

for (const hit of hits) {
  const mark = hit.level === 'error' ? '✗' : '⚠'
  console.log(`${mark} [${hit.rule}] ${hit.where}  ${hit.value}`)
  if (hit.level === 'error') console.log(`    ${hit.hint}：确认是假值就换成占位符，或在该行加 scan-ignore`)
}

if (hits.length === 0) {
  console.log('✓ 脱敏扫描通过：没有发现真机标识 / 凭证 / 余额。')
} else {
  console.log(`\n共 ${errors.length} 个 error、${warns.length} 个 warn。`)
  if (warns.length > 0 && errors.length === 0) {
    console.log('warn 需要人眼确认一遍（多半是 fixture 里的假 ID，确认后不用改）。')
  }
}

process.exitCode = errors.length > 0 ? 1 : 0
