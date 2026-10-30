/**
 * 商汤小浣熊适配器单测。
 *
 * ## 这份 fixture 的出处（**全部来自本机真打**，2026-10-27）
 *
 * 本机装了 `商汤小浣熊 1.1.3`（Electron），登录态在
 * `~/.office-raccoon/agent/config/auth.json`。下面每一条「上游响应」都是
 * 拿那个 token 真打 `https://xiaohuanxiong.com` 抄回来的**真实报文**，
 * 不是编的：
 *
 * | fixture | 出处 |
 * |---|---|
 * | `CATALOG_BODY` | `GET /api/web/llm/v2/model_catalog` 200，10 个模型 |
 * | `BALANCE_BODY` | `GET /api/web/points/v1/balance` 200 |
 * | `GRANT_TRUE / GRANT_FALSE` | `POST /api/web/desktop/v1/login/points/grant` 200 |
 * | `AUTH_401_*` | 无 token / 空 Bearer / 假 token 三种 401 |
 * | `EFFORT_400` | `reasoning_effort: 'off'` 的 400（serde 枚举原文） |
 * | `TOOL_STREAM` | 真流：`finish_reason: "tool_calls"` + 思维链 + usage |
 * | `REASON_STREAM` | 真流：`reasoning_content` + `content` + usage |
 *
 * ⚠️ 凡是**没真打过的形状**，这里不测 —— 编出来的 fixture 只能证明代码符合
 * 我的想象，不能证明符合上游。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RaccoonAdapter,
  RACCOON_AUTH_FILE_CANDIDATES,
  RACCOON_BUSINESS_CODES,
  RACCOON_LOGIN_APP_NAME,
  RACCOON_LOGIN_EXPIRES_SEC,
  RACCOON_ORIGIN,
  RACCOON_PATHS,
  RACCOON_USER_AGENT,
  RACCOON_GRANT_HEADERS,
  buildRaccoonAuthorizeUrl,
  classifyRaccoonBody,
  describeRaccoonError,
  jwtExpiresAtMs,
  parseRaccoonBalance,
  parseRaccoonCallback,
  parseRaccoonCatalog,
  readRaccoonTokenFromAuthFile,
  startRaccoonLoopback,
  toRaccoonModelMeta,
} from '../../lib/adapters/raccoon.js'
import { CANONICAL_REASONING_EFFORTS } from '../../lib/core/reasoning.js'
import { iterateSse } from '../../lib/core/sse.js'

const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent } }

/**
 * 造一个**不读本机文件**的适配器。
 *
 * ⚠️ 这个包装不是洁癖：`RaccoonAdapter` 的默认候选路径里有
 * `~/.office-raccoon/agent/config/auth.json`，而**开发机上真的存在这个文件**
 * （用户装了客户端并登录过）。用默认构造器的话，「账号没填 token」这条路径
 * 会读到真 token 然后真打上游 —— 测试既不可复现，又会在 CI 上直接失败。
 * 所以凡是测「无凭证」分支的用例都必须用它。
 */
function isolated() {
  return new RaccoonAdapter({ authFileCandidates: [] })
}

/** 一个带显式 token 的账号（不走「读客户端文件」那条路，测试要可复现）。 */
function accountWith(token = 'test-token') {
  return {
    id: 'raccoon:me',
    agentId: 'raccoon',
    label: 'me',
    enabled: true,
    routeChat: true,
    credentials: token === '' ? {} : { token },
  }
}

/** 造一个 AdapterContext：`http` 按脚本回，`fetch` 用于流式。 */
function makeCtx({ http, fetch } = {}) {
  return {
    config: {
      requestTimeoutMs: 30_000,
      upstream: {
        chatBaseUrl: `${RACCOON_ORIGIN}${RACCOON_PATHS.chatBase}`,
        apiBaseUrl: RACCOON_ORIGIN,
        modelsUrl: '',
      },
      credits: { unit: 'credits', baselineUsdPerMTok: 1.2, round: 2 },
    },
    log: silent,
    cache: (() => {
      const store = new Map()
      return {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value),
        delete: (key) => store.delete(key),
        keys: () => [...store.keys()],
      }
    })(),
    now: () => Date.now(),
    http: http ?? (async () => ({ ok: true, status: 200, kind: 'none', headers: new Headers(), body: {}, text: '' })),
    ...(fetch === undefined ? {} : { fetch }),
  }
}

// ───────────────────────── 真报文 fixture ─────────────────────────

/** 真：`GET /api/web/llm/v2/model_catalog`（截取了 10 个模型里的 4 个，字段逐字保留）。 */
const CATALOG_BODY = {
  code: 0,
  message: 'success',
  data: {
    categories: [
      {
        type: 'chat',
        default_model: 'raccoon-8c4485',
        models: [
          {
            name: 'raccoon-8c4485',
            description: 'Raccoon-Work',
            visible: false,
            billing_category: 'normal',
            model_name: 'raccoon-8c4485',
            display_description: '适合复杂办公任务、代码开发、调试和图像识别等任务',
            tags: ['general', 'office', 'code', 'vision', 'debug', 'analysis', 'html', 'reasoning', 'auto'],
            ability_level: 3,
            params: { context_window: 1000000, max_tokens: 100000 },
            billing_multiplier: 1,
            billing_effective_multiplier: 1,
            billing_status: 'normal',
            billing_status_note: '',
            billing_discounts: [],
          },
          {
            name: 'sn-sensenova-6-8-flash',
            description: 'SenseNova-6.8-Flash',
            visible: true,
            billing_category: 'lite',
            model_name: 'sn-sensenova-6-8-flash',
            display_description: '适合通用对话、内容处理等轻量任务',
            tags: ['general', 'chat', 'rewrite', 'summary', 'fast', 'vision', 'fast'],
            ability_level: 2,
            params: { context_window: 256000, max_tokens: 63999 },
            billing_multiplier: 0,
            billing_effective_multiplier: 0,
            billing_status: 'normal',
            billing_status_note: '',
            billing_discounts: [],
          },
          {
            name: 'sn-glm-5-3',
            description: 'GLM-5.3',
            visible: true,
            billing_category: 'normal',
            model_name: 'sn-glm-5-3',
            display_description: '适合复杂办公任务、代码开发和综合分析等任务',
            tags: ['general', 'office', 'code', 'vision', 'debug', 'analysis', 'html', 'reasoning'],
            ability_level: 3,
            params: { context_window: 1000000, max_tokens: 100000 },
            billing_multiplier: 1,
            billing_effective_multiplier: 0.75,
            billing_status: 'normal',
            billing_status_note: '',
            billing_discounts: [],
          },
          {
            name: 'sn-deepseek-v4-1-flash-1017',
            description: 'DeepSeek-V4.1-Flash',
            visible: true,
            billing_category: 'normal',
            model_name: 'sn-deepseek-v4-1-flash-1017',
            display_description: '适合通用对话、代码开发、复杂分析和推理任务',
            tags: ['general', 'code', 'html', 'analysis', 'reasoning', 'auto'],
            ability_level: 3,
            params: { context_window: 1000000, max_tokens: 100000 },
            billing_multiplier: 0,
            billing_effective_multiplier: 0,
            billing_status: 'normal',
            billing_status_note: '',
            billing_discounts: [],
          },
        ],
      },
    ],
  },
}

/**
 * 真：`GET /api/web/points/v1/balance` 200。
 *
 * ⚠️ **字段名/类型/层级取自真机，数值已脱敏**（原来是本机账号的真实余额与
 * 账户 id —— 本仓库是公开的，不能带出去）。脱敏只动数字，
 * 因为这组用例断言的是「解析行为」：哪个字段映射到 `remaining`、
 * `0` 与 `undefined` 怎么分、`extra` 原样保留 —— 这些都与具体数值无关。
 */
const BALANCE_BODY = {
  code: 0,
  message: 'success',
  data: {
    available_points: 5000,
    daily_points: 500,
    monthly_points: 0,
    reward_points: 4500,
    topup_points: 0,
    enterprise_topup_points: 0,
    total_chargeable_points: 5000,
    enterprise_reserved: false,
    topup_frozen: false,
    owner_type: 'users',
    owner_id: 900001,
  },
}

/**
 * ⚠️ **只有 `GRANT_FALSE` 是本机真打到的**（2026-10-27，本机今天已领过，
 * 所以只见到 `{granted: false, popup: null}`）。
 *
 * `GRANT_TRUE` 是**按字段语义构造的最小形状** —— `granted: true` 那条分支
 * 当天打不出来（服务端已判「今天没有可领的」）。所以：
 *   - 它只能证明「代码把 `granted: true` 当作领到了」，**不能**证明上游真会这么回；
 *   - `popup` 里那个对象也是构造的，只为覆盖 `describePopup` 的防御式提取。
 * 这条限制写在这里，是为了不让下一个人把 fixture 当成上游契约引用。
 */
const GRANT_TRUE = { code: 0, message: 'success', data: { granted: true, popup: { title: '登录奖励', points: 50 } } }
const GRANT_FALSE = { code: 0, message: 'success', data: { granted: false, popup: null } }

/** 真：三种鉴权 401。 */
const AUTH_401_EMPTY = { code: 200001, message: 'authorization_empty_error', details: 'authorization empty' }
const AUTH_401_INVALID = { code: 200002, message: 'authorization_invalid_error', details: 'authorization invalid' }
const AUTH_401_VERIFY = { code: 200003, message: 'authorization_verify_error', details: 'authorization verify failed' }

/** 真：`reasoning_effort: 'off'` 的 400 原文。 */
const EFFORT_400 = {
  error: {
    code: '400',
    message:
      'Failed to deserialize the JSON body into the target type: reasoning_effort: unknown variant `off`, ' +
      'expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`, `max` at line 1 column 223 ' +
      '(request_id: 00000000-0000-4000-8000-000000000000) (type: invalid_request_error)',
  },
}

/**
 * 真：一次带工具调用的流（`sn-deepseek-v4-1-flash` + `get_weather`）。
 *
 * 逐字取自本机抓到的帧（首帧只带 `role`，尾帧 `delta:{}` + `usage`，最后 `[DONE]`）。
 */
const TOOL_STREAM = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sn-deepseek-v4-1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sn-deepseek-v4-1-flash","choices":[{"index":0,"delta":{"reasoning_content":"需要查天气"}}]}',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sn-deepseek-v4-1-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_00_luxz73k0e6chx9u0ekh8hw23","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sn-deepseek-v4-1-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \\"Beijing\\"}"}}]}}]}',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sn-deepseek-v4-1-flash","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"sn-deepseek-v4-1-flash","choices":[{"index":0,"delta":{}}],"usage":{"completion_tokens":51,"prompt_tokens":300,"total_tokens":351,"completion_tokens_details":{"reasoning_tokens":40}}}',
  'data: [DONE]',
].join('\n\n') + '\n\n'

/**
 * 真：一次纯文本流。
 *
 * ⚠️ 注意 usage 帧排在 `finish_reason` **之后**（本平台就是这么发的，
 * 与 `docs` 里记录的「usage 比 finish 晚」那条坑同形）。
 */
const TEXT_STREAM = [
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"sn-deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"sn-deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{"reasoning_content":"我是"}}]}',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"sn-deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{"reasoning_content":" AI 助手。"}}]}',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"sn-deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{"content":"我是由深度求索"}}]}',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"sn-deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{"content":"创造的 AI 助手。"}}]}',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"sn-deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":2,"model":"sn-deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{}}],"usage":{"completion_tokens":93,"prompt_tokens":34,"total_tokens":127,"completion_tokens_details":{"reasoning_tokens":71}}}',
  'data: [DONE]',
].join('\n\n') + '\n\n'

/** 把一串 SSE 文本包成 `Response`。 */
function sseResponse(text, status = 200) {
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

/** 跑一次 chat，收齐事件。 */
async function drain(adapter, ctx, payload, record = accountWith()) {
  const events = []
  for await (const event of adapter.requestChatStream(
    payload,
    record,
    ctx,
    new AbortController().signal,
  )) {
    events.push(event)
  }
  return events
}

// ───────────────────────── 纯函数 ─────────────────────────

test('auth.json：认 access_token / token / auth_token 三个别名，空值当没有', () => {
  assert.equal(readRaccoonTokenFromAuthFile({ access_token: 'a' }), 'a')
  assert.equal(readRaccoonTokenFromAuthFile({ token: ' b ' }), 'b')
  assert.equal(readRaccoonTokenFromAuthFile({ auth_token: 'c' }), 'c')
  // 真机上 `auth.json` 是 `{access_token, office_identity}`；缺 token 就是没有。
  assert.equal(readRaccoonTokenFromAuthFile({ office_identity: 'personal' }), undefined)
  assert.equal(readRaccoonTokenFromAuthFile({ access_token: '   ' }), undefined)
  assert.equal(readRaccoonTokenFromAuthFile(null), undefined)
  assert.equal(readRaccoonTokenFromAuthFile('str'), undefined)
})

test('auth.json：候选路径覆盖环境变量与两种默认布局，且不重复', () => {
  // 前两条依赖环境变量（本机没设就不出现），后两条是固定兜底。
  const tail = RACCOON_AUTH_FILE_CANDIDATES.slice(-2)
  assert.match(tail[0], /\.office-raccoon[\\/]agent[\\/]config[\\/]auth\.json$/)
  assert.match(tail[1], /\.box-agent[\\/]config[\\/]auth\.json$/)
  assert.equal(new Set(RACCOON_AUTH_FILE_CANDIDATES).size, RACCOON_AUTH_FILE_CANDIDATES.length)
})

test('JWT：解出 exp（秒）→ 毫秒；解不出来返回 undefined 而不是抛', () => {
  // 造一个只有 payload 的假 JWT（签名不参与解析）。
  const payload = Buffer.from(JSON.stringify({ iss: 'xiaohuanxiong.com/iam', exp: 1795680437 })).toString('base64url')
  const token = `header.${payload}.sig`
  assert.equal(jwtExpiresAtMs(token), 1_795_680_437_000)
  assert.equal(jwtExpiresAtMs('not-a-jwt'), undefined)
  assert.equal(jwtExpiresAtMs('a.b'), undefined)
  assert.equal(jwtExpiresAtMs('a.@@@@.c'), undefined)
  // 没有 exp 的（例如普通 API key）也不能抛。
  const noExp = Buffer.from(JSON.stringify({ sub: 'x' })).toString('base64url')
  assert.equal(jwtExpiresAtMs(`h.${noExp}.s`), undefined)
})

test('目录解析：只认 type=chat 的分类，default_model 不在列表里就退回第一个', () => {
  const parsed = parseRaccoonCatalog(CATALOG_BODY)
  assert.notEqual(parsed, undefined)
  assert.equal(parsed.defaultModel, 'raccoon-8c4485')
  assert.equal(parsed.models.length, 4)

  // 默认模型被删掉 → 退回第一个非空名字（客户端同口径）。
  const body = structuredClone(CATALOG_BODY)
  body.data.categories[0].default_model = 'not-exist'
  assert.equal(parseRaccoonCatalog(body).defaultModel, 'raccoon-8c4485')

  // 业务码非 0 → undefined（不是空列表，是「拿不到」）。
  assert.equal(parseRaccoonCatalog({ code: 200001, message: 'authorization_empty_error' }), undefined)
  // 没有 chat 分类 → undefined。
  assert.equal(parseRaccoonCatalog({ code: 0, data: { categories: [{ type: 'image', models: [] }] } }), undefined)
  // 空模型列表 → undefined。
  assert.equal(parseRaccoonCatalog({ code: 0, data: { categories: [{ type: 'chat', models: [] }] } }), undefined)
  // 非对象 → undefined。
  assert.equal(parseRaccoonCatalog('nope'), undefined)
  assert.equal(parseRaccoonCatalog(null), undefined)
})

test('★ 倍率三态：实付 0 = 免费；实付 0.75 = ×0.75；字段缺失 = 未知（不写 0）', () => {
  const rows = parseRaccoonCatalog(CATALOG_BODY).models
  const byName = new Map(rows.map((row) => [row.name, row]))

  const sensenova = toRaccoonModelMeta(byName.get('sn-sensenova-6-8-flash'), 'raccoon', '商汤小浣熊', 1)
  assert.equal(sensenova.multiplier, 0)
  assert.equal(sensenova.free, true, '实付 0 必须标成免费')

  // 标价 1、实付 0.75：取**实付**，否则用户看到的价比真实扣费高。
  const glm = toRaccoonModelMeta(byName.get('sn-glm-5-3'), 'raccoon', '商汤小浣熊', 1)
  assert.equal(glm.multiplier, 0.75)
  assert.equal(glm.free, undefined)

  // 字段缺失 → 整个键不出现（= 未知倍率）。绝不写 0。
  const noPrice = toRaccoonModelMeta({ name: 'x' }, 'raccoon', '商汤小浣熊', 1)
  assert.equal('multiplier' in noPrice, false, '缺价格时不能写 multiplier 键')
  assert.equal(noPrice.free, undefined)
})

test('目录行：上下文 / max_tokens / 展示名 / 内部档标记都按真报文取', () => {
  const rows = parseRaccoonCatalog(CATALOG_BODY).models
  const byName = new Map(rows.map((row) => [row.name, row]))
  const deepseek = toRaccoonModelMeta(byName.get('sn-deepseek-v4-1-flash-1017'), 'raccoon', '商汤小浣熊', 7)
  assert.equal(deepseek.id, 'sn-deepseek-v4-1-flash-1017')
  // `description` 是上游给的模型名（`DeepSeek-V4.1-Flash`），比 id 好看。
  assert.equal(deepseek.name, 'DeepSeek-V4.1-Flash')
  assert.equal(deepseek.contextWindow, 1_000_000)
  assert.equal(deepseek.maxTokens, 100_000)
  assert.equal(deepseek.updatedAt, 7)
  assert.equal(deepseek.agentId, 'raccoon')
  assert.equal(deepseek.agentName, '商汤小浣熊')

  // `raccoon-*` 是官方客户端隐藏的内部自动路由档：仍上报，但描述里说清楚。
  const internal = toRaccoonModelMeta(byName.get('raccoon-8c4485'), 'raccoon', '商汤小浣熊', 7)
  assert.match(internal.description, /内部自动路由/)
  assert.match(internal.description, /适合复杂办公任务/)

  // 没名字的行直接丢掉（畸形数据，不是策略）。
  assert.equal(toRaccoonModelMeta({ name: '' }, 'raccoon', '商汤小浣熊', 1), undefined)
  assert.equal(toRaccoonModelMeta({}, 'raccoon', '商汤小浣熊', 1), undefined)
})

test('★ 思考档位：上游接受的就是那 8 个规范名，所以声明全集', () => {
  const rows = parseRaccoonCatalog(CATALOG_BODY).models
  const meta = toRaccoonModelMeta(rows[0], 'raccoon', '商汤小浣熊', 1)
  // 与上游 serde 枚举（none/minimal/low/medium/high/xhigh/ultra/max）同集。
  assert.deepEqual([...meta.reasoningEfforts].sort(), [...CANONICAL_REASONING_EFFORTS].sort())
})

test('★ 思维链能力按实测标：raccoon-* 不吐思维链，sn-* 吐', () => {
  const rows = parseRaccoonCatalog(CATALOG_BODY).models
  const byName = new Map(rows.map((row) => [row.name, row]))
  for (const id of ['raccoon-8c4485', 'raccoon-19b265', 'raccoon-405a1c']) {
    const meta = toRaccoonModelMeta({ name: id }, 'raccoon', '商汤小浣熊', 1)
    assert.equal(meta.reasoning, false, `${id} 实测思维链恒为 0`)
  }
  for (const id of ['sn-deepseek-v4-1-flash-1017', 'sn-glm-5-3', 'sn-kimi-k3', 'sn-sensenova-6-8-flash']) {
    const meta = toRaccoonModelMeta({ name: id }, 'raccoon', '商汤小浣熊', 1)
    assert.equal(meta.reasoning, true, `${id} 实测会吐 reasoning_content`)
  }
  // 没实测过的模型（上游新上架）**不猜**：`reasoning` 留空。
  const unknown = toRaccoonModelMeta({ name: 'sn-brand-new-model' }, 'raccoon', '商汤小浣熊', 1)
  assert.equal('reasoning' in unknown, false)
  assert.equal(byName.size, 4)
})

test('★ 视觉能力按实测标：只有实测通过的模型才有 image 模态', () => {
  const deepseek = toRaccoonModelMeta({ name: 'sn-deepseek-v4-1-flash-1017' }, 'raccoon', '商汤小浣熊', 1)
  assert.deepEqual(deepseek.inputModalities, ['text', 'image'])
  // `sn-glm-5-3` 的 tags 里写着 vision，但真发图片是 400 —— 不按 tag 猜。
  const glm = toRaccoonModelMeta({ name: 'sn-glm-5-3' }, 'raccoon', '商汤小浣熊', 1)
  assert.equal(glm.inputModalities, undefined)
})

test('业务码 → 分类：三个鉴权码都是 auth，组织码是 bad_request（不是 auth）', () => {
  assert.equal(classifyRaccoonBody(AUTH_401_EMPTY), 'auth')
  assert.equal(classifyRaccoonBody(AUTH_401_INVALID), 'auth')
  assert.equal(classifyRaccoonBody(AUTH_401_VERIFY), 'auth')
  assert.equal(classifyRaccoonBody({ code: 200020 }), 'bad_request')
  assert.equal(classifyRaccoonBody({ code: 200022 }), 'bad_request')
  assert.equal(classifyRaccoonBody({ code: 100001 }), 'bad_request')
  assert.equal(classifyRaccoonBody({ code: 0 }), 'none')
  // 没见过的码 → undefined（交给核心分类器，别自己瞎判）。
  assert.equal(classifyRaccoonBody({ code: 999999 }), undefined)
  assert.equal(classifyRaccoonBody({}), undefined)
  assert.equal(classifyRaccoonBody(null), undefined)
  // 表里每个码都得有分类（防止加了码忘了填）。
  for (const code of Object.keys(RACCOON_BUSINESS_CODES)) {
    assert.notEqual(classifyRaccoonBody({ code: Number(code) }), undefined, `业务码 ${code} 没分类`)
  }
})

test('错误文案：优先 details，其次 message，带上业务码；都没有就 undefined', () => {
  assert.equal(
    describeRaccoonError(AUTH_401_VERIFY),
    '[200003] authorization_verify_error：authorization verify failed',
  )
  assert.equal(describeRaccoonError({ code: 1, details: 'only details' }), '[1] only details')
  assert.equal(describeRaccoonError({ code: 1, message: 'only message' }), '[1] only message')
  assert.equal(describeRaccoonError({ code: 1 }), undefined)
  assert.equal(describeRaccoonError(null), undefined)
})

test('余额解析：available_points 是剩余；业务码非 0 当拿不到', () => {
  const balance = parseRaccoonBalance(BALANCE_BODY)
  assert.equal(balance.available, 5000)
  assert.equal(balance.daily, 500)
  assert.equal(balance.reward, 4500)
  assert.equal(balance.topup, 0)
  // 原始字段原样保留，UI 可展开看。
  assert.equal(balance.extra.owner_id, 900001)

  assert.deepEqual(parseRaccoonBalance({ code: 200001, message: 'x' }), {})
  assert.deepEqual(parseRaccoonBalance({ code: 0 }), {})
  assert.deepEqual(parseRaccoonBalance(null), {})
})

// ───────────────────────── 适配器：凭证 ─────────────────────────

test('凭证：账号里填了就用它；没填才回落到客户端登录态', async () => {
  const adapter = isolated()
  const ctx = makeCtx()
  const explicit = await adapter.getCredentials(accountWith('explicit-token'), ctx)
  assert.equal(explicit.token, 'explicit-token')
})

test('校验凭证：没有 token 时明确说「也没找到客户端登录态」，而不是只说缺 token', async () => {
  const adapter = isolated()
  const ctx = makeCtx()
  const verdict = await adapter.validateCredentials(accountWith(''), ctx)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.kind, 'auth')
  assert.match(verdict.message, /token 为空/)
  assert.match(verdict.message, /客户端的登录态/)
})

test('★ 校验凭证：余额接口 200 → ok，并把可用积分说出来', async () => {
  const adapter = isolated()
  let seenUrl = ''
  let seenAuth = ''
  const ctx = makeCtx({
    http: async (url, init) => {
      seenUrl = url
      seenAuth = init.headers.authorization
      return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: BALANCE_BODY, text: '' }
    },
  })
  const verdict = await adapter.validateCredentials(accountWith('tok'), ctx)
  assert.equal(verdict.ok, true)
  assert.match(verdict.message, /5000/)
  assert.equal(seenUrl, `${RACCOON_ORIGIN}${RACCOON_PATHS.balance}`)
  assert.equal(seenAuth, 'Bearer tok')
})

test('校验凭证：401 业务码 200003 → kind=auth，文案带上游原文', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    http: async () => ({ ok: false, status: 401, kind: 'auth', headers: new Headers(), body: AUTH_401_VERIFY, text: '' }),
  })
  const verdict = await adapter.validateCredentials(accountWith('bad'), ctx)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.kind, 'auth')
  assert.match(verdict.message, /authorization_verify_error/)
})

// ───────────────────────── 适配器：额度 / 签到 ─────────────────────────

test('额度：remaining 用 available_points；原始字段进 extra', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    http: async () => ({ ok: true, status: 200, kind: 'none', headers: new Headers(), body: BALANCE_BODY, text: '' }),
  })
  const snapshot = await adapter.getQuota(accountWith('tok'), ctx)
  assert.equal(snapshot.unit, 'credits')
  assert.equal(snapshot.remaining, 5000)
  assert.equal(snapshot.error, undefined)
  assert.equal(snapshot.extra.daily_points, 500)
})

test('额度：拿不到时 error 说原因，remaining 保持 undefined（不是 0）', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    http: async () => ({ ok: false, status: 401, kind: 'auth', headers: new Headers(), body: AUTH_401_EMPTY, text: '' }),
  })
  const snapshot = await adapter.getQuota(accountWith('tok'), ctx)
  assert.equal(snapshot.remaining, undefined)
  assert.match(snapshot.error, /authorization_empty_error/)
})

test('额度：没有 token 时不打上游，直接说缺凭证', async () => {
  const adapter = isolated()
  let called = false
  const ctx = makeCtx({ http: async () => { called = true; throw new Error('不该被调用') } })
  const snapshot = await adapter.getQuota(accountWith(''), ctx)
  assert.equal(called, false)
  assert.match(snapshot.error, /token 为空/)
})

test('★ 签到：granted=true → ok 且 coversToday（领到了）', async () => {
  const adapter = isolated()
  let method = ''
  const ctx = makeCtx({
    http: async (_url, init) => {
      method = init.method
      return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: GRANT_TRUE, text: '' }
    },
  })
  const result = await adapter.checkIn(accountWith('tok'), ctx)
  assert.equal(result.ok, true)
  assert.equal(result.supported, true)
  assert.equal(result.coversToday, true)
  // 上游给了 popup 文案就带出来（它是用户唯一能看到的「领到了什么」）。
  assert.match(result.message, /登录奖励/)
  assert.equal(method, 'POST')
})

test('★ 签到：granted=false → 不是故障，但也不谎报领到；且当天不再重试', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    http: async () => ({ ok: true, status: 200, kind: 'none', headers: new Headers(), body: GRANT_FALSE, text: '' }),
  })
  const result = await adapter.checkIn(accountWith('tok'), ctx)
  assert.equal(result.ok, false, '没领到就不能报 ok')
  assert.equal(result.supported, true, '上游有这个接口，不能报「不支持」')
  assert.equal(result.coversToday, true, '当天不会再变，别让调度器反复打')
  assert.match(result.message, /granted: false/)
})

test('签到：业务码非 0 → 按业务码分类（auth 才是 auth）', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    http: async () => ({ ok: false, status: 401, kind: 'auth', headers: new Headers(), body: AUTH_401_VERIFY, text: '' }),
  })
  const result = await adapter.checkIn(accountWith('tok'), ctx)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'auth')
})

// ───────────────────────── 适配器：模型目录 ─────────────────────────

test('模型目录：上报全部 10 个（不做策略过滤），按实付倍率升序', async () => {
  const adapter = isolated()
  let seenUrl = ''
  const ctx = makeCtx({
    http: async (url) => {
      seenUrl = url
      return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: CATALOG_BODY, text: '' }
    },
  })
  const list = await adapter.getModelMetaList(accountWith('tok'), ctx)
  assert.equal(seenUrl, `${RACCOON_ORIGIN}${RACCOON_PATHS.catalog}`)
  assert.equal(list.length, 4)
  // 免费的（实付 0）排前面，其余按倍率升序。
  assert.deepEqual(list.map((item) => item.id), [
    'sn-deepseek-v4-1-flash-1017',
    'sn-sensenova-6-8-flash',
    'sn-glm-5-3',
    'raccoon-8c4485',
  ])
})

test('模型目录：命中缓存后不再打上游', async () => {
  const adapter = isolated()
  let calls = 0
  const ctx = makeCtx({
    http: async () => {
      calls += 1
      return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: CATALOG_BODY, text: '' }
    },
  })
  await adapter.getModelMetaList(accountWith('tok'), ctx)
  await adapter.getModelMetaList(accountWith('tok'), ctx)
  assert.equal(calls, 1)
})

test('模型目录：失败返回空数组并记 warn（不抛错、不缓存空结果）', async () => {
  const adapter = isolated()
  const warnings = []
  let calls = 0
  const ctx = makeCtx({
    http: async () => {
      calls += 1
      return { ok: false, status: 401, kind: 'auth', headers: new Headers(), body: AUTH_401_EMPTY, text: '' }
    },
  })
  ctx.log = { ...silent, warn: (message) => warnings.push(message) }
  assert.deepEqual(await adapter.getModelMetaList(accountWith('tok'), ctx), [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /模型目录/)
  // 失败不写缓存 —— 一次抖动不该让选择器空 10 分钟。
  await adapter.getModelMetaList(accountWith('tok'), ctx)
  assert.equal(calls, 2)
})

// ───────────────────────── 适配器：对话流 ─────────────────────────

test('★ 纯文本流：思维链与正文都透出，finish 在 usage 之前也要收全', async () => {
  const adapter = isolated()
  const ctx = makeCtx({ fetch: async () => sseResponse(TEXT_STREAM) })
  const events = await drain(adapter, ctx, {
    model: 'sn-deepseek-v4-1-flash-1017',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  })
  const reasoning = events.filter((event) => event.type === 'reasoning').map((event) => event.text).join('')
  const text = events.filter((event) => event.type === 'text').map((event) => event.text).join('')
  assert.equal(reasoning, '我是 AI 助手。')
  assert.equal(text, '我是由深度求索创造的 AI 助手。')
  const usage = events.find((event) => event.type === 'usage')
  assert.equal(usage.usage.inputTokens, 34)
  assert.equal(usage.usage.outputTokens, 93)
  assert.equal(usage.usage.reasoningTokens, 71)
  assert.equal(events.filter((event) => event.type === 'finish').length, 1)
})

test('★ 工具流：tool_calls 的 id/name/arguments 分段拼得起来，finish_reason=tool_calls', async () => {
  const adapter = isolated()
  const ctx = makeCtx({ fetch: async () => sseResponse(TOOL_STREAM) })
  const events = await drain(adapter, ctx, {
    model: 'sn-deepseek-v4-1-flash',
    messages: [{ role: 'user', content: 'weather?' }],
    stream: true,
  })
  const calls = events.filter((event) => event.type === 'tool_call')
  // fixture 里是两帧：第一帧带 id+name+arguments 前半，第二帧只带 arguments 后半。
  assert.equal(calls.length, 2)
  assert.equal(calls[0].id, 'call_00_luxz73k0e6chx9u0ekh8hw23')
  assert.equal(calls[0].name, 'get_weather')
  // 第二帧没有 id / name —— 拼装必须靠 index，不能靠「每帧都带全」。
  assert.equal(calls[1].id, undefined)
  assert.equal(calls[1].name, undefined)
  const args = calls.map((call) => call.argumentsDelta ?? '').join('')
  assert.deepEqual(JSON.parse(args), { city: 'Beijing' })
  const finish = events.find((event) => event.type === 'finish')
  assert.equal(finish.reason, 'tool_calls')
})

test('对话：请求体带 stream:true、不带 stream_options（上游本来就发 usage）', async () => {
  const adapter = isolated()
  let sentBody = null
  let sentUrl = ''
  const ctx = makeCtx({
    fetch: async (url, init) => {
      sentUrl = url
      sentBody = JSON.parse(init.body)
      return sseResponse(TEXT_STREAM)
    },
  })
  await drain(adapter, ctx, {
    model: 'sn-deepseek-v4-1-flash-1017',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    temperature: 0.3,
  })
  assert.equal(sentUrl, `${RACCOON_ORIGIN}${RACCOON_PATHS.chat}`)
  assert.equal(sentBody.stream, true, '无论调用方怎么写，都必须走流式')
  assert.equal('stream_options' in sentBody, false, '上游本来就发 usage，不加这个字段')
  assert.equal(sentBody.temperature, 0.3)
})

test('对话：请求头对齐客户端（UA=node、不发 X-Client-*、不发 X-Org-Code）', async () => {
  const adapter = isolated()
  let sentHeaders = null
  const ctx = makeCtx({
    fetch: async (_url, init) => {
      sentHeaders = init.headers
      return sseResponse(TEXT_STREAM)
    },
  })
  await drain(adapter, ctx, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(sentHeaders.authorization, 'Bearer test-token')
  assert.equal(sentHeaders.accept, 'text/event-stream')
  assert.equal(sentHeaders['content-type'], 'application/json')
  // ⚠️ 必须是 `node`：官方客户端的 JS 请求走的也是 undici，实测它的 UA 就是这个字面量。
  assert.equal(sentHeaders['user-agent'], RACCOON_USER_AGENT)
  for (const key of Object.keys(sentHeaders)) {
    assert.equal(/^x-client-/.test(key), false, `对话接口客户端不带 X-Client-*，我们也不带`)
    assert.equal(key === 'x-org-code', false, '不该发 X-Org-Code（个人账号会 400）')
  }
})

// ───────────────────── 指纹：与官方客户端逐字对齐 ─────────────────────

/**
 * ## 为什么这组用例值得单独存在
 *
 * 「我们发出去的指纹是什么」这件事**读代码推不出来**：
 * undici 在调用方没给 `user-agent` 时会自己补一个 `node`，
 * 而 `core/http.ts` 又会给没带 UA 的调用补 `dsh-multi-agent-gateway/<版本>`。
 * 两条路径的默认值**不一样**，所以「对话不带、额度带」这种分裂只有抓包能发现。
 *
 * 实测（本地 HTTP 捕获，不是推断）：
 *
 * | 请求 | 修之前 | 修之后 = 官方客户端 |
 * |---|---|---|
 * | 对话（裸 fetch） | `user-agent: node` | `node` ✅ 本来就对 |
 * | 额度 / 目录 / 签到（`ctx.http`） | **`dsh-multi-agent-gateway/0.2.2`** | `node` |
 *
 * 修之前那四条元数据请求等于向网关点名「我是个第三方反代工具，版本 0.2.2」。
 */
test('★ 元数据请求（额度/目录）的 UA 必须是 node，不得出现插件名', async () => {
  const adapter = isolated()
  const seen = []
  const ctx = makeCtx({
    http: async (_url, init) => {
      seen.push(init.headers ?? {})
      return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: BALANCE_BODY, text: '' }
    },
  })
  await adapter.getQuota(accountWith('tok'), ctx)
  await adapter.validateCredentials(accountWith('tok'), ctx)

  assert.ok(seen.length >= 2, '两条请求都应被捕获')
  for (const headers of seen) {
    assert.equal(headers['user-agent'], 'node')
    const ua = String(headers['user-agent'] ?? '')
    assert.equal(/dsh-multi-agent-gateway/i.test(ua), false, `UA 里不该出现插件名：${ua}`)
    assert.equal(/0\.\d+\.\d+/.test(ua), false, `UA 里不该带插件版本号：${ua}`)
  }
})

test('★ 只有签到带 X-Client-*（客户端也只在它上面带）', async () => {
  const adapter = isolated()
  let grantHeaders = null
  const ctx = makeCtx({
    http: async (url, init) => {
      if (url.includes(RACCOON_PATHS.loginGrant)) grantHeaders = init.headers ?? {}
      return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: GRANT_FALSE, text: '' }
    },
  })
  await adapter.checkIn(accountWith('tok'), ctx)

  assert.notEqual(grantHeaders, undefined, '签到请求应被捕获')
  assert.equal(grantHeaders['x-client-platform'], RACCOON_GRANT_HEADERS['x-client-platform'])
  assert.equal(grantHeaders['x-client-version'], RACCOON_GRANT_HEADERS['x-client-version'])
  assert.equal(grantHeaders['user-agent'], 'node')
  // 但**不是**整套四件套：客户端在这条上只发两个。
  assert.equal('x-client-name' in grantHeaders, false, '客户端签到请求不带 X-Client-Name')
  assert.equal('x-client-page' in grantHeaders, false, '客户端签到请求不带 X-Client-Page')
})

test('★ 常量与实测一致：UA 与指纹头的值不许随手改错', () => {
  // 这两条值来自抓包，改它们必须有新的实测依据。
  assert.equal(RACCOON_USER_AGENT, 'node')
  assert.deepEqual(RACCOON_GRANT_HEADERS, {
    'x-client-platform': 'desktop-windows',
    'x-client-version': '1.1.3',
  })
})

test('对话：401 业务码 → kind=auth，文案带业务码与上游原话', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    fetch: async () => new Response(JSON.stringify(AUTH_401_VERIFY), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  })
  const events = await drain(adapter, ctx, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  const error = events.find((event) => event.type === 'error')
  assert.notEqual(error, undefined)
  assert.equal(error.failure.kind, 'auth')
  assert.equal(error.failure.status, 401)
  assert.match(error.failure.message, /200003/)
  assert.match(error.failure.message, /authorization verify failed/)
})

test('对话：400 serde 枚举错误 → bad_request（换号也没用，不能白换）', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    fetch: async () => new Response(JSON.stringify(EFFORT_400), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  })
  const events = await drain(adapter, ctx, {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'off',
  })
  const error = events.find((event) => event.type === 'error')
  assert.equal(error.failure.kind, 'bad_request')
})

test('对话：429 + retry-after 必须透出 retryAfterMs（裸 fetch 绕开了 core/http）', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    fetch: async () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '120' },
    }),
  })
  const events = await drain(adapter, ctx, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  const error = events.find((event) => event.type === 'error')
  assert.equal(error.failure.kind, 'rate_limit')
  assert.equal(error.failure.retryAfterMs, 120_000)
})

test('对话：429 没有 retry-after 头时，从报文里的「retry after:12s」算出 retryAfterMs', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    fetch: async () => new Response(
      JSON.stringify({ code: '200103', msg: 'limiter_request_error：request exceed max time, retry after:12s' }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    ),
  })
  const events = await drain(adapter, ctx, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  const error = events.find((event) => event.type === 'error')
  assert.equal(error.failure.kind, 'rate_limit')
  assert.equal(error.failure.retryAfterMs, 12_000)
})

test('对话：没有 token 时直接报 auth，一个字节都不发出去', async () => {
  const adapter = isolated()
  let called = false
  const ctx = makeCtx({ fetch: async () => { called = true; throw new Error('不该被调用') } })
  const events = await drain(adapter, ctx, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, accountWith(''))
  assert.equal(called, false)
  assert.equal(events[0].type, 'error')
  assert.equal(events[0].failure.kind, 'auth')
})

test('对话：网络异常 → kind=network（可重试，账号不降权）', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    fetch: async () => {
      throw new Error('ECONNRESET')
    },
  })
  const events = await drain(adapter, ctx, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(events[0].failure.kind, 'network')
  assert.match(events[0].failure.message, /ECONNRESET/)
})

test('对话：上游断流（没给 finish_reason）也要补一个 finish，DSH 才能收尾', async () => {
  const adapter = isolated()
  const cut = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"半句话"}}]}\n\n'
  const ctx = makeCtx({ fetch: async () => sseResponse(cut) })
  const events = await drain(adapter, ctx, { model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(events.filter((event) => event.type === 'text').length, 1)
  assert.equal(events.filter((event) => event.type === 'finish').length, 1)
})

// ───────────────────────── 能力声明 ─────────────────────────

test('能力：有签到、有额度、有模型、有对话；没有活动任务；不是免账号', () => {
  const adapter = isolated()
  assert.equal(adapter.id, 'raccoon')
  assert.equal(adapter.name, '商汤小浣熊')
  assert.equal(adapter.implemented, true)
  assert.equal(adapter.capabilities.checkIn, true)
  assert.equal(adapter.capabilities.quota, true)
  assert.equal(adapter.capabilities.models, true)
  assert.equal(adapter.capabilities.chat, true)
  assert.equal(adapter.capabilities.reasoning, true)
  assert.equal(adapter.capabilities.tasks, false, '上游没有活动任务体系，不能编')
  assert.equal(adapter.capabilities.accountFree, false, '没有 token 一律 401')
  // 每一项都得有一句人话解释（UI 直接显示，回答「为什么这项是灰的」）。
  for (const key of ['checkIn', 'quota', 'models', 'tasks', 'chat', 'reasoning', 'login', 'credentials']) {
    assert.equal(typeof adapter.capabilities.notes[key], 'string')
    assert.ok(adapter.capabilities.notes[key].length > 10, `notes.${key} 太短`)
  }
})

test('活动任务：沿用基类的「上游没有这个接口（不是故障）」语义，不抛错', async () => {
  const adapter = isolated()
  const ctx = makeCtx()
  assert.deepEqual(await adapter.fetchAvailableTasks(accountWith('tok'), ctx), [])
  const result = await adapter.executeTask({ id: 't1', title: 'x', kind: 'activity' }, accountWith('tok'), ctx)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unsupported')
  assert.match(result.message, /不是故障/)
})

// ───────────────────── 登录：本机回环 + 授权码（2026-10-28 真机验通后补的） ─────────────────────

/** 造一个只有 `exp` 的假 JWT（`jwtExpiresAtMs` 只解 payload，不验签）。 */
function fakeJwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `header.${payload}.signature`
}

test('授权链接：五个参数齐全 —— 少一个 desktop_callback 服务端就只回 state 不回 code', () => {
  const url = buildRaccoonAuthorizeUrl('http://127.0.0.1:23456/auth/callback', 'a'.repeat(64))
  const parsed = new URL(url)
  assert.equal(`${parsed.origin}${parsed.pathname}`, `${RACCOON_ORIGIN}/authorize`)
  assert.equal(parsed.searchParams.get('login_source'), 'desktop')
  assert.equal(parsed.searchParams.get('desktop_callback'), 'loopback')
  assert.equal(parsed.searchParams.get('appname'), RACCOON_LOGIN_APP_NAME)
  assert.equal(parsed.searchParams.get('state'), 'a'.repeat(64))
  assert.equal(parsed.searchParams.get('redirect'), 'http://127.0.0.1:23456/auth/callback')
})

test('回调解析：正常回调给出 code；路径不对 / state 不对一律当作「不是我们的」', () => {
  const state = 'b'.repeat(64)
  assert.deepEqual(
    parseRaccoonCallback(`/auth/callback?code=abc123&state=${state}`, '/auth/callback', state),
    { code: 'abc123' },
  )
  assert.equal(
    parseRaccoonCallback(`/auth/callback?code=abc&state=${'c'.repeat(64)}`, '/auth/callback', state),
    null,
  )
  assert.equal(parseRaccoonCallback(`/auth/callback?code=abc&state=${state}`, '/other', state), null)
  // 长度不等时不能让 timingSafeEqual 抛 RangeError —— 必须安静地判成「不是我们的」。
  assert.equal(parseRaccoonCallback(`/auth/callback?code=abc&state=${state.slice(1)}`, '/auth/callback', state), null)
})

test('回调解析：有 state 没 code / 上游明确报错 → 说清楚，不装作还在等', () => {
  const state = 'd'.repeat(64)
  const noCode = parseRaccoonCallback(`/auth/callback?state=${state}`, '/auth/callback', state)
  assert.ok(typeof noCode.error === 'string' && noCode.error.includes('code'))
  const denied = parseRaccoonCallback(
    `/auth/callback?state=${state}&error=access_denied&error_description=nope`,
    '/auth/callback',
    state,
  )
  assert.ok(typeof denied.error === 'string' && denied.error.includes('access_denied'))
})

test('回环接收器：真能收到 code，且只收一次（错 state 直接 404，收完就关）', async () => {
  const state = 'e'.repeat(64)
  const receiver = await startRaccoonLoopback({ state, timeoutMs: 5000 })
  try {
    assert.match(receiver.redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    assert.equal(receiver.code, '')

    const wrong = await fetch(`${receiver.redirect}?code=zzz&state=${'0'.repeat(64)}`)
    assert.equal(wrong.status, 404, 'state 不对必须拒绝')
    assert.equal(receiver.code, '', '错 state 不能把 code 记下来')

    const good = await fetch(`${receiver.redirect}?code=xyz789&state=${state}`)
    assert.equal(good.status, 200)
    assert.equal(receiver.code, 'xyz789')
  } finally {
    receiver.close()
  }
})

test('beginLogin：给出的是 /authorize 链接，state 里带着可关闭的回环句柄', async () => {
  const adapter = isolated()
  const start = await adapter.beginLogin(makeCtx())
  try {
    assert.ok(start.authUrl.startsWith(`${RACCOON_ORIGIN}/authorize?`), start.authUrl)
    assert.ok(start.authUrl.includes('desktop_callback=loopback'))
    assert.equal(start.expiresInSec, RACCOON_LOGIN_EXPIRES_SEC)
    assert.match(start.state.loopback.redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  } finally {
    start.state.loopback.close()
  }
})

test('pollLogin：没收到 code 时是 pending，且提示里带等待秒数（不是干等）', async () => {
  const adapter = isolated()
  const start = await adapter.beginLogin(makeCtx())
  try {
    const outcome = await adapter.pollLogin({ ...start.state, startedAt: Date.now() - 3000 }, makeCtx())
    assert.equal(outcome.status, 'pending')
    assert.match(outcome.message, /授权页/)
    assert.match(outcome.message, /已等待 \d+ 秒/)
  } finally {
    start.state.loopback.close()
  }
})

test('pollLogin：收到 code 就去换令牌，成功后返回 ready、带有效期与账号标签', async () => {
  const adapter = isolated()
  const token = fakeJwt(1_900_000_000)
  const httpCalls = []
  const ctx = makeCtx({
    http: async (url, init) => {
      httpCalls.push({ url, body: init?.body })
      return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { code: 0, data: { access_token: token, refresh_token: token } }, text: '' }
    },
  })
  const start = await adapter.beginLogin(ctx)
  try {
    // 模拟浏览器带着 code 回调（真机验过：code 46 字符、state 64 字符）。
    const callback = await fetch(`${start.state.loopback.redirect}?code=${'f'.repeat(46)}&state=${start.state.expectedState}`)
    assert.equal(callback.status, 200)

    const outcome = await adapter.pollLogin(start.state, ctx)
    assert.equal(outcome.status, 'ready')
    assert.equal(outcome.credentials.token, token)
    assert.equal(outcome.credentials.expiresAt, 1_900_000_000_000)
    // ⚠️ refresh_token 与 access_token 同值（实测），所以**不许**写成 refreshToken 骗人。
    assert.equal(outcome.credentials.refreshToken, undefined)

    // 换令牌一次 + 拿昵称一次（`labelForToken` 会再问一次 `/user_info`）。
    const exchange = httpCalls.find((call) => call.url.endsWith('/api/web/auth/v1/login_with_authorization_code'))
    assert.ok(exchange !== undefined, `没有打换令牌接口：${httpCalls.map((c) => c.url).join(', ')}`)
    assert.equal(JSON.parse(exchange.body).authorization_code, 'f'.repeat(46))
    assert.ok(httpCalls.some((call) => call.url.endsWith('/api/web/auth/v1/user_info')))
  } finally {
    start.state.loopback.close()
  }
})

test('pollLogin：换令牌失败要把上游原因说出来，不能报「成功」', async () => {
  const adapter = isolated()
  const ctx = makeCtx({
    http: async () => ({ ok: false, status: 400, kind: 'auth', headers: new Headers(), body: { code: 200003, message: 'authorization verify failed' }, text: '' }),
  })
  const start = await adapter.beginLogin(ctx)
  try {
    await fetch(`${start.state.loopback.redirect}?code=bad&state=${start.state.expectedState}`)
    const outcome = await adapter.pollLogin(start.state, ctx)
    assert.equal(outcome.status, 'failed')
    assert.match(outcome.message, /200003|authorization verify failed/)
  } finally {
    start.state.loopback.close()
  }
})
