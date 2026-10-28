/**
 * 网关「渠道校验」（`code 11-128`）的两道判据。
 *
 * ## 为什么这个文件存在（用户报障，2026-10-25）
 *
 * 用户在国内版上收到：
 * ```
 * {"code":11-128,"msg":"Illegal API invocation from an unapproved channel",
 *  "displayMsg":{"zh":"请求被拦截，请重新发送"},
 *  "displayTips":{"en":"This call failed channel verification, …"}}
 * ```
 *
 * `displayMsg` 把两件互不相干的事包装成同一句「被拦截」，而它们**共用同一个 code**：
 *
 *   1. 指令消息的 `role` 是 `developer`；
 *   2. 指令消息以 DSH 的身份句 `You are an AI agent powered by DeepSeek Harness.` 开头。
 *
 * 判据 1 我们在**国际版**上实测过（2026-10-25，头固定只改 body）：
 * `developer` → 400 / `11-128`，同一条消息改成 `system` → 200。
 * 判据 2 由 `dsh-xdpool` 在**国内版**逐条实测（2026-10-21），详见
 * `src/vendor/buddy/buddy-channel-guard.ts` 的文件头。
 *
 * ## 这个文件守的是什么
 *
 * 不是「改写逻辑对不对」（那是实现细节），而是**出站报文里不能再出现这两样东西**。
 * 所以集成用例断言的是 `calls[0].body` 的实际字节 —— 一旦将来有人调整消息归一化的
 * 顺序、或者把 `guardChatMessages` 挪出链路，这些用例会立刻红。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { BuddyAdapter, BUDDY_CN, BUDDY_INTL } from '../lib/adapters/buddy.js'
import {
  HARNESS_IDENTITY_PHRASE,
  NEUTRAL_IDENTITY_PHRASE,
  NEUTRAL_PATH_MENTION_PHRASE,
  PATH_MENTION_PHRASE,
  carriesHarnessIdentity,
  guardChatMessages,
  rewriteHarnessIdentity,
  withInstructionRoles,
} from '../lib/vendor/buddy/buddy-channel-guard.js'

const PHRASE = HARNESS_IDENTITY_PHRASE
const NEUTRAL = NEUTRAL_IDENTITY_PHRASE
/** DSH 真实 system prompt 的开头形态：身份句 + 空行 + 其余段落。 */
const TAIL = '\n\nYou operate in a workspace and may call tools.'

// ───────────────────────── 守卫本体 ─────────────────────────

test('身份句被改写，同一条消息的其余内容原样保留', () => {
  const out = rewriteHarnessIdentity([{ role: 'system', content: PHRASE + TAIL }])
  assert.equal(out[0].content, NEUTRAL + TAIL)
  assert.equal(carriesHarnessIdentity(String(out[0].content)), false)
})

test('身份句夹在长 prompt 中间也改写（只看 messages[0] 会漏）', () => {
  const content = ['You are a coding agent.', '', 'The harness introduces itself:', PHRASE, '', 'Follow the user.'].join('\n')
  const out = rewriteHarnessIdentity([
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'system', content },
  ])
  assert.equal(carriesHarnessIdentity(String(out[1].content)), false)
  assert.match(String(out[1].content), /You are a coding agent\./)
  assert.match(String(out[1].content), /Follow the user\./)
  assert.match(String(out[1].content), new RegExp(NEUTRAL.replace('.', '\\.')))
})

test('分段 content 数组里的文本段也改写，分段结构不变', () => {
  const out = rewriteHarnessIdentity([{ role: 'system', content: [{ type: 'text', text: PHRASE + '\nbody' }] }])
  const content = out[0].content
  assert.ok(Array.isArray(content))
  assert.equal(content[0].text, NEUTRAL + '\nbody')
  assert.equal(content[0].type, 'text')
})

test('容忍句内折行、多余空格、大小写与缺句号', () => {
  for (const variant of [
    'You are an AI agent\npowered by DeepSeek Harness.',
    'You are an AI agent   powered by DeepSeek Harness',
    'you are an ai agent powered by deepseek harness.',
    'You\u00a0are\u00a0an\u00a0AI\u00a0agent\u00a0powered\u00a0by\u00a0DeepSeek\u00a0Harness.',
  ]) {
    const out = rewriteHarnessIdentity([{ role: 'system', content: variant }])
    assert.equal(String(out[0].content), NEUTRAL, `没改写：${JSON.stringify(variant)}`)
  }
})

test('用户消息与工具消息里引用这句话时原样保留', () => {
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: `what does "${PHRASE}" mean?` },
    { role: 'tool', content: PHRASE },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: PHRASE }) } }] },
  ]
  const out = rewriteHarnessIdentity(messages)
  assert.equal(out[1].content, `what does "${PHRASE}" mean?`)
  assert.equal(out[2].content, PHRASE)
  // 工具调用的参数不是散文，改进去等于把一次调用改坏
  assert.equal(JSON.stringify(out[3].tool_calls).includes(PHRASE), true)
})

test('纯函数：不改入参（payload 会被 spread 进 body、也会被日志/重试读到）', () => {
  const original = { role: 'system', content: PHRASE + TAIL }
  const messages = [original]
  const out = rewriteHarnessIdentity(messages)
  assert.equal(original.content, PHRASE + TAIL, '入参被就地改了')
  assert.notEqual(out[0], original)
  assert.equal(out[0].content, NEUTRAL + TAIL)
})

test('developer 角色改写为 system，其余字段不动', () => {
  const out = withInstructionRoles([{ role: 'developer', content: 'x', name: 'n' }])
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, 'x')
  assert.equal(out[0].name, 'n')
})

test('guardChatMessages 先换角色再改文本：developer 里的身份句也被覆盖', () => {
  const out = guardChatMessages([{ role: 'developer', content: PHRASE + TAIL }])
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, NEUTRAL + TAIL)
})

test('幂等：第二次调用结果完全相同', () => {
  const once = guardChatMessages([{ role: 'developer', content: PHRASE + TAIL }])
  const twice = guardChatMessages(once)
  assert.deepEqual(twice, once)
})

test('对缺 content / 非对象 / 空数组不抛错', () => {
  assert.deepEqual(guardChatMessages([]), [])
  assert.equal(guardChatMessages([{ role: 'system' }])[0].content, undefined)
  const odd = [{ role: 'system', text: PHRASE }]
  assert.equal(guardChatMessages(odd)[0].text, NEUTRAL)
})

// ───────────────────── 出站报文（真正的守门） ─────────────────────

/** 只跑 `requestChatStream` 的假 ctx：记下请求体，回一段最小 SSE。 */
function chatCtx() {
  const calls = []
  const store = new Map()
  return {
    calls,
    ctx: {
      config: { upstream: { apiBaseUrl: '' }, requestTimeoutMs: 5_000 },
      log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this } },
      http: async () => ({ ok: true, status: 200, kind: 'ok', body: { code: 0, data: {} }, headers: new Headers() }),
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), headers: init.headers ?? {}, body: init.body })
        return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
      cache: {
        get: (key) => store.get(key),
        set: (key, value) => { store.set(key, value) },
        delete: (key) => { store.delete(key) },
        keys: () => [...store.keys()],
      },
      now: () => 1_760_000_000_000,
    },
  }
}

function account(agentId, credentials = { token: 'fixture-token' }) {
  return { id: `${agentId}:fixture`, agentId, label: 'fixture', credentials, enabled: true, createdAt: 0, updatedAt: 0 }
}

/** 跑一次 chat 并把流消费完（不消费就不会触发 fetch）。 */
async function drainChat(adapter, ctx, messages, record) {
  const events = []
  for await (const event of adapter.requestChatStream(
    { model: 'default-model', messages },
    record,
    ctx,
    new AbortController().signal,
  )) {
    events.push(event)
  }
  return events
}

/** 取出发出去的 body。 */
function sentBody(calls) {
  assert.equal(calls.length, 1, `期望一次上游调用，实际 ${calls.length}`)
  return JSON.parse(calls[0].body)
}

for (const [name, product] of [['国内版', BUDDY_CN], ['国际版', BUDDY_INTL]]) {
  const adapter = new BuddyAdapter(product)
  const record = account(product.agentId)

  test(`★ ${name}出站报文：DSH 身份句不再出现`, async () => {
    const { ctx, calls } = chatCtx()
    await drainChat(adapter, ctx, [
      { role: 'system', content: PHRASE + TAIL },
      { role: 'user', content: 'hi' },
    ], record)

    const body = sentBody(calls)
    assert.equal(carriesHarnessIdentity(JSON.stringify(body)), false, '报文里还带着身份句 —— 网关会 400 / 11-128')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, NEUTRAL + TAIL)
    assert.equal(body.messages[1].content, 'hi')
  })

  test(`★ ${name}出站报文：developer 角色被降级成 system`, async () => {
    const { ctx, calls } = chatCtx()
    await drainChat(adapter, ctx, [
      { role: 'developer', content: PHRASE + TAIL },
      { role: 'user', content: 'hi' },
    ], record)

    const body = sentBody(calls)
    assert.equal(body.messages.some((m) => m.role === 'developer'), false, 'developer 角色没被换掉 —— 网关会 400 / 11-128')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(carriesHarnessIdentity(JSON.stringify(body)), false)
  })

  test(`★ ${name}出站报文：中途注入的 developer 指令也被处理`, async () => {
    // 长对话才会出现（工具增删 / 重复工具提醒 / 上下文更新）—— 正是「短对话正常、
    // 聊久了突然 400」的形态。
    const { ctx, calls } = chatCtx()
    await drainChat(adapter, ctx, [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'developer', content: PHRASE + TAIL },
      { role: 'user', content: 'c' },
    ], record)

    const body = sentBody(calls)
    assert.equal(body.messages.some((m) => m.role === 'developer'), false)
    assert.equal(carriesHarnessIdentity(JSON.stringify(body)), false)
    // 顺序与条数不变（只改角色与那一句，不增删消息）
    assert.equal(body.messages.length, 5)
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'system', 'user'])
  })

  test(`${name}出站报文：用户自己打的字不被改动`, async () => {
    const { ctx, calls } = chatCtx()
    const question = `what does "${PHRASE}" mean?`
    await drainChat(adapter, ctx, [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: question },
    ], record)
    assert.equal(sentBody(calls).messages[1].content, question)
  })
}

test('国际版：首条是 developer 时不会再多补一条 system', async () => {
  // 守卫先把 developer 换成 system，`withLeadingSystem` 随后看到的就是 system ——
  // 顺序写反会多出一条「You are a helpful assistant.」，把客户端的指令挤到第二位。
  const adapter = new BuddyAdapter(BUDDY_INTL)
  const { ctx, calls } = chatCtx()
  await drainChat(adapter, ctx, [{ role: 'developer', content: PHRASE + TAIL }, { role: 'user', content: 'hi' }], account('workbuddy-intl'))

  const body = sentBody(calls)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].content, NEUTRAL + TAIL)
})

test('国际版：首条是 user 时仍然补最小 system（另一条独立判据）', async () => {
  const adapter = new BuddyAdapter(BUDDY_INTL)
  const { ctx, calls } = chatCtx()
  await drainChat(adapter, ctx, [{ role: 'user', content: 'hi' }], account('workbuddy-intl'))

  const body = sentBody(calls)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'You are a helpful assistant.')
  assert.equal(body.messages[1].content, 'hi')
})

// ── 判据 3：路径说明句（2026-10-28 真机定位，见 docs/WORKBUDDY-CHANNEL-CHECK.md §11） ──

test('国内版：系统提示里的路径说明句必须被改写（否则每次对话都 400）', async () => {
  const adapter = new BuddyAdapter(BUDDY_CN)
  const { ctx, calls } = chatCtx()
  const system = [
    'Tokens prefixed with @ are paths the user explicitly referenced.',
    `${PATH_MENTION_PHRASE}; absolute paths identify files or directories on the host.`,
  ].join(' ')
  await drainChat(adapter, ctx, [{ role: 'system', content: system }, { role: 'user', content: 'hi' }], account('workbuddy'))

  const sent = sentBody(calls).messages[0].content
  assert.ok(!sent.includes(PATH_MENTION_PHRASE), `原句还在：${sent}`)
  assert.ok(sent.includes(NEUTRAL_PATH_MENTION_PHRASE), '改写后的句子要出现')
})

test('路径说明句：折行 / 大小写变体也命中，且改写幂等', () => {
  const folded = 'Relative   paths\nresolve from the workspace root'
  const once = rewriteHarnessIdentity([{ role: 'system', content: folded }])
  assert.equal(once[0].content, NEUTRAL_PATH_MENTION_PHRASE)
  const twice = rewriteHarnessIdentity(once)
  assert.equal(twice[0].content, once[0].content)
})

test('路径说明句：用户消息里出现时原样保留（只动指令通道）', () => {
  const out = rewriteHarnessIdentity([{ role: 'user', content: PATH_MENTION_PHRASE }])
  assert.equal(out[0].content, PATH_MENTION_PHRASE)
})
