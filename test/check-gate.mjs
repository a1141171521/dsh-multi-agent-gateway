/**
 * 裸 HTTP 打一次免费层，用来分辨「是 IP 被限流」还是「插件的问题」。
 *
 * 判据：本文件**不 import 任何插件代码**。
 *   · 403 而 /models 目录 200  → 本机出口 IP 被免费层限流，等或换 IP；
 *   · 200                        → 免费层通，若插件仍报错才该查插件。
 *
 * 用法：node test/check-gate.mjs
 */
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function base62(seed, width) {
  let h = 2166136261
  for (const c of seed) h = (Math.imul(h, 131) + c.charCodeAt(0)) >>> 0
  let out = ''
  for (let i = 0; i < width; i += 1) {
    h = (Math.imul(h ^ (i + 7), 1103515245) + 12345) >>> 0
    out += B62[h % 62]
  }
  return out
}
function session(seed) {
  const time = (~((BigInt(Date.now()) << 12n) | 1n) & 0xffffffffffffn).toString(16).padStart(12, '0')
  return `ses_${time}${base62(seed, 14)}`
}

const READ = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from the filesystem',
    parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
  },
}

const sid = session(`recheck-${Math.random()}`)
const started = Date.now()
const response = await fetch('https://opencode.ai/inference/openai/v1/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-opencode-client': 'cli',
    'user-agent': 'opencode/latest/2.0.29/cli',
    'x-opencode-session': sid,
    'x-opencode-session-id': sid,
    'x-session-affinity': sid,
    'X-Session-Id': sid,
  },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: '只回答两个字：收到' }],
    stream: true,
    max_tokens: 16,
    tools: [READ],
  }),
  signal: AbortSignal.timeout(45000),
})
const text = await response.text()
console.log(`${response.ok ? '✅' : '❌'} status=${response.status}  用时 ${Date.now() - started}ms`)
if (response.ok) {
  const pieces = text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => {
      try {
        const parsed = JSON.parse(line.slice(6))
        const delta = parsed.choices?.[0]?.delta ?? {}
        return `${delta.reasoning_content ? 'R' : ''}${delta.content ?? ''}`
      } catch {
        return ''
      }
    })
    .join('')
  console.log(`   流里有内容：${JSON.stringify(pieces.slice(0, 60))}`)
} else {
  console.log(`   ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
}
