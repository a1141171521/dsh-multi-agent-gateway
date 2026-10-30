/**
 * 开关一个渠道的账号（**不改凭证、不删账号**）。
 *
 * 用途：某个账号被上游风控 / 临时不可用时，先把它从路由里摘出来，
 * 免得每次请求都先去撞它一次；申诉回来之后一条命令再打开。
 *
 * 用法：
 *   node scripts/account-toggle.mjs --list
 *   node scripts/account-toggle.mjs --agent workbuddy-intl --off
 *   node scripts/account-toggle.mjs --agent workbuddy-intl --on
 *
 * ⚠️ 直接写 `accounts.enc.json`（与插件同一套主密钥）。**运行中的 DSH 仍持有
 * 旧的内存副本**，所以改完要重启 DSH 才真正生效；反过来，如果这段时间里
 * 插件因为别的原因重写了账号文件，改动会被覆盖 —— 重启后再 --list 复核一次。
 *
 * 输出里账号 id 打码（真实 id 不进终端记录）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { AccountManager } from '../lib/core/accounts.js'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : fallback
}

const dataDir = arg('data', join(homedir(), '.dsh', 'multi-agent-gateway'))
const agent = arg('agent', '')
const wantList = argv.includes('--list')
const turnOn = argv.includes('--on')
const turnOff = argv.includes('--off')

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (m, ...r) => console.error('  [error]', m, ...r),
  child: () => log,
}

const state = { v: 1, updatedAt: 0, health: {}, quota: {}, models: {}, schedule: {} }
const manager = new AccountManager(dataDir, log, state)
const loaded = manager.load()
if (!loaded.ok) {
  console.error(`✗ 账号装载失败：${loaded.error}`)
  process.exit(1)
}

/** 真实 id 不进终端：只留渠道前缀 + 首字符。 */
const mask = (id) => id.replace(/:(.*)$/, (_, tail) => `:${tail.slice(0, 1)}***`)

const rows = manager.all().map((a, index) => ({
  index: index + 1,
  id: a.id,
  agentId: a.agentId,
  label: a.label,
  enabled: a.enabled !== false,
  routeChat: a.routeChat !== false,
}))

if (wantList || (agent === '' && !turnOn && !turnOff)) {
  for (const row of rows) {
    const flags = [row.enabled ? '启用' : '停用', row.routeChat ? '参与对话' : '不参与对话'].join(' / ')
    console.log(`  ${String(row.index).padStart(2)}  ${row.agentId.padEnd(16)} ${mask(row.id).padEnd(28)} ${flags}`)
  }
  console.log(`\n共 ${rows.length} 个账号（数据目录 ${dataDir}）`)
  process.exit(0)
}

if (agent === '' || (!turnOn && !turnOff)) {
  console.error('用法：node scripts/account-toggle.mjs --agent <渠道> --off|--on   （或 --list）')
  process.exit(1)
}

const targets = rows.filter((row) => row.agentId === agent)
if (targets.length === 0) {
  console.error(`✗ 没有 ${agent} 渠道的账号`)
  process.exit(1)
}

for (const target of targets) {
  manager.update(target.id, { enabled: turnOn })
  console.log(`  ${mask(target.id)} → ${turnOn ? '启用' : '停用'}`)
}
console.log('\n⚠️ 重启 DSH 后才生效（运行中的实例仍持有旧的内存副本）。')
