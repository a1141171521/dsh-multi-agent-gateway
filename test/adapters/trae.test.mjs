/**
 * Trae 适配器单测。
 *
 * ## ⚠️ 诚实声明：本机**没有 Trae 账号**，因此没有真上游验证
 *
 * 本文件里所有「上游响应」都是**从参考实现 `dsh-our-free-model` 的注释与源码里
 * 抄下来的真实抓包形状**，不是我自己编的。每处 fixture 都标了出处。
 *
 * 这一点很重要：**编出来的 fixture 只能证明代码符合我的想象，不能证明符合上游**。
 * 所以凡是参考实现没写过的形状，这里**不测**（宁可少一条断言，也不要一条
 * 把错误假设固化成「事实」的断言）。
 *
 * 出处速查（下文用 `[出处]` 标注）：
 *   - `trae.ts`         = 参考实现 `vendor/channel-pack/src/trae.ts`
 *   - `trae-credits.ts` = 同目录 `trae-credits.ts`
 *   - `trae-product.ts` = 同目录 `trae-product.ts`
 *   - `trae-adapter.ts` = 同目录 `trae-adapter.ts`
 *   - `trae-auth.ts`    = 同目录 `trae-auth.ts`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildTraeBatchModelsBody,
  TRAE_FALLBACK_MODELS,
  TRAE_CHANNELS,
  TRAE_BATCH_FUNCTIONS,
} from '../../lib/vendor/trae/trae-product.js'
import {
  readStringField,
  readNumberField,
  readBooleanField,
  parseTraeExchangeResponse,
  parseTraeUserInfoResponse,
  deriveMachineId,
  deriveDeviceId,
  deriveCheckinDeviceId,
  isTraeExpired,
  jwtExpiresAtMs,
  toTraeCredential,
} from '../../lib/vendor/trae/trae-identity.js'
import {
  traeSOLOHeaders,
  traeCheckinHeaders,
  deriveDeviceId15,
  deriveMarketUserId,
  deriveSessionId,
} from '../../lib/vendor/trae/trae-headers.js'
import {
  parseTraeBatchModelList,
  parseTraeModelList,
  readConsumptionRate,
  readActivityDiscount,
  normalizeTraeModelKey,
  resolveTraeModelTarget,
  isTraeModelCallable,
  declaresReasoningOptions,
  traeDisplayName,
} from '../../lib/vendor/trae/trae-catalog.js'
import {
  transformToSOLOBody,
  clampTraeMaxTokens,
  traeMaxModeFields,
  buildOpenAiBody,
} from '../../lib/vendor/trae/trae-payload.js'
import {
  TraeSseConverter,
  parseTraeSSELine,
  convertTraeSseLines,
  aggregateTraeSSE,
  normalizeTraeUsage,
  classifyTraeStreamError,
  isRotatableTraeStreamError,
} from '../../lib/vendor/trae/trae-sse.js'
import {
  readTraeClaimCode,
  classifyTraeCheckinError,
  isTraeCheckinBusy,
  parseTraeCheckinStatus,
  parseTraeCreditBalance,
  readCheckinGeneration,
  checkinGenerationPayload,
} from '../../lib/vendor/trae/trae-credits.js'
import { classifyTraeError, shouldRotateTraeAccount } from '../../lib/vendor/trae/trae-errors.js'
import { TraeAdapter } from '../../lib/adapters/trae.js'

// ───────────────────────── 测试脚手架 ─────────────────────────

/** 静默日志器（测试里不需要输出）。 */
const silent = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silent },
}

/** 内存缓存（与 `src/core/cache.ts` 的 MemoryCache 同形）。 */
function memoryCache() {
  const store = new Map()
  return {
    get(key) { return store.get(key)?.value },
    set(key, value) { store.set(key, { value }) },
    delete(key) { store.delete(key) },
    keys() { return [...store.keys()] },
  }
}

/** 造一个假的 `ctx`（`http` 走 `route(url)` 回调；`fetch` 用于流式路径）。 */
function makeCtx({ route, fetchImpl } = {}) {
  const calls = []
  const ctx = {
    calls,
    config: {
      id: 'trae',
      name: 'Trae',
      upstream: {},
      credits: { unit: 'credits', baselineUsdPerMTok: 1, round: 2 },
      requestTimeoutMs: 30_000,
    },
    log: silent,
    cache: memoryCache(),
    now: () => 1_760_000_000_000,
    async http(url, init) {
      calls.push({ url, init })
      if (route === undefined) {
        return { ok: false, status: 500, kind: 'server', headers: new Headers(), body: undefined, text: '' }
      }
      return route(url, init)
    },
  }
  if (fetchImpl !== undefined) ctx.fetch = fetchImpl
  return ctx
}

/** 造账号记录。 */
function account(credentials = { token: 'FAKE.TOKEN.X', uid: '1234567890' }, id = 'trae:a1') {
  return {
    id,
    agentId: 'trae',
    label: 'a1',
    credentials,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** 把行数组包成一个 SSE `Response`（可指定分块大小）。 */
function sseResponse(lines, { chunkSize } = {}) {
  const text = lines.join('\n')
  const bytes = new TextEncoder().encode(text)
  const size = chunkSize ?? bytes.length
  let offset = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

// ═══════════════════════ 一、JSON 安全读取 ═══════════════════════

test('JSON 读取：数字兼容、严格布尔、缺失不伪装', () => {
  // [出处] trae.ts:1425-1453 的三个 reader。
  assert.equal(readStringField({ a: 'x' }, 'a'), 'x')
  assert.equal(readStringField({ a: 12 }, 'a'), '12', '数字要能当字符串读')
  assert.equal(readStringField({ a: null }, 'a'), '', 'null 不能变成字符串 null')
  assert.equal(readStringField({}, 'a'), '')

  assert.equal(readNumberField({ a: '0.08' }, 'a'), 0.08, '字符串形态的数字要认')
  assert.equal(readNumberField({ a: ' 42 ' }, 'a'), 42)
  assert.equal(readNumberField({ a: 'abc' }, 'a'), undefined)
  assert.equal(readNumberField({ a: '' }, 'a'), undefined, '空串不是 0')
  assert.equal(readNumberField({ a: '0x10' }, 'a'), undefined, '十六进制串不能当数字')

  assert.equal(readBooleanField({ a: true }, 'a'), true)
  assert.equal(readBooleanField({ a: false }, 'a'), false)
  assert.equal(readBooleanField({ a: 'true' }, 'a'), true)
  assert.equal(readBooleanField({ a: 1 }, 'a'), true)
  assert.equal(readBooleanField({ a: 0 }, 'a'), false)
  // 核心判据：「上游没说」与「上游说 false」是两回事。
  assert.equal(readBooleanField({}, 'a'), undefined)
  assert.equal(readBooleanField({ a: '' }, 'a'), undefined, '空串不该被当成 false')
})

// ═══════════════════════ 二、模型目录（batch） ═══════════════════════

/**
 * batch 端点的**真实响应形状**。
 *
 * [出处] trae.ts:1147-1158 的注释：
 * 「响应形如 `{ function_configs: [{ function, config_info_list: [...] }, …] }`，
 *  每个 function 各自一套模型目录」。
 *
 * 条目字段名取自 [出处] trae.ts:1056-1121 的 `parseTraeConfigEntry`
 * 与 trae.ts:716-796 的 `TraeRemoteModel` 注释。
 * 具体数值（200000 / 1000000 / 32000 / 64000 / 0.08 / 0.5）也来自那些注释里的实测记录。
 */
function batchFixture() {
  return {
    function_configs: [
      {
        function: 'solo_agent',
        config_info_list: [
          {
            config_name: 'glm-5.2',
            usage: 'chat_completion',
            config_switch: true,
            is_invisible_to_user: false,
            // [出处] trae.ts:648：真实条目形如 {dev:200000, max:1000000}
            context_window_tokens: { dev: 200000, max: 1000000 },
            // [出处] trae.ts:880：config_name__dev / config_name__max 约定
            model_detail_list: [
              { model_name: 'glm-5.2__dev', max_tokens: 32000 },
              { model_name: 'glm-5.2__max', max_tokens: 64000 },
            ],
            display_config: {
              display_name: 'GLM-5.2',
              is_custom_model: false,
              max_mode: true,
              multimodal: true,
              tool_response_multimodal: false,
            },
            // [出处] trae.ts:954-957：这是一个 JSON 字符串，不是对象
            display_contact_config: JSON.stringify({
              consumption_rate: { enable: true, data: { rate: 0.08 } },
            }),
            // [出处] trae.ts:726-731：真实形状
            reasoning_effort_config: {
              default_level: 'high',
              options: ['light', 'high', 'extra_high'],
              support_thinking: true,
            },
          },
          {
            // [出处] trae.ts:1244：usage 非 chat_completion 的条目要被排除
            config_name: 'summary_thing',
            usage: 'summary',
            config_switch: true,
            display_config: { display_name: 'Summary' },
          },
          {
            // [出处] trae.ts:1242：config_switch === false 表示上游已停用
            config_name: 'retired-model',
            usage: 'chat_completion',
            config_switch: false,
            display_config: { display_name: 'Retired' },
          },
          {
            // [出处] trae.ts:1246：is_invisible_to_user === true 是官方隐藏条目
            config_name: 'internal-subagent',
            usage: 'chat_completion',
            config_switch: true,
            is_invisible_to_user: true,
            display_config: { display_name: 'Internal' },
          },
          {
            // [出处] trae.ts:659-664：is_custom_model 为 true 的条目必然调不通
            config_name: 'custom_model_gemini',
            usage: 'chat_completion',
            config_switch: true,
            display_config: { display_name: 'Custom Gemini', is_custom_model: true },
          },
        ],
      },
      {
        // [出处] trae-product.ts:109-111：chat / builder / inline_chat 稳定被拒，
        // 不在白名单里 → 整组丢弃。
        function: 'chat',
        config_info_list: [
          {
            config_name: 'only-in-chat-channel',
            usage: 'chat_completion',
            config_switch: true,
            display_config: { display_name: 'Only In Chat' },
          },
        ],
      },
      {
        function: 'solo_work_lite',
        config_info_list: [
          {
            // 同一模型、**空档位**：按规则 1「空档位不得覆盖有档位」，
            // 不能把 solo_agent 里那条带 reasoning 的覆盖掉。
            // [出处] trae.ts:1169-1177（issue IKI7WT/IKILR7）
            config_name: 'glm-5.2',
            usage: 'chat_completion',
            config_switch: true,
            display_config: { display_name: 'GLM-5.2' },
            display_contact_config: JSON.stringify({
              consumption_rate: { enable: true, data: { rate: 0.5 } },
            }),
          },
        ],
      },
    ],
  }
}

test('batch 模型目录：白名单准入 + 三条硬性过滤', () => {
  const models = parseTraeBatchModelList(batchFixture())
  const ids = models.map((m) => m.id).sort()

  // 只留下 glm-5.2 与 custom_model_gemini：
  //   - summary_thing     → usage 非 chat_completion
  //   - retired-model     → config_switch === false
  //   - internal-subagent → is_invisible_to_user === true
  //   - only-in-chat-channel → 所在通道 chat 不在白名单
  assert.deepEqual(ids, ['custom_model_gemini', 'glm-5.2'])

  // 白名单**同时是准入表**：非白名单通道的独有模型整个消失。
  assert.equal(models.some((m) => m.id === 'only-in-chat-channel'), false,
    '不在白名单通道里的模型必须被剔除（否则用户一选中就必然失败）')
})

test('batch 模型目录：空档位不覆盖有档位（issue IKI7WT/IKILR7 回归）', () => {
  const models = parseTraeBatchModelList(batchFixture())
  const glm = models.find((m) => m.id === 'glm-5.2')
  assert.ok(glm !== undefined)

  // [出处] trae.ts:1253-1265 的合并规则 1 与 2。
  assert.equal(glm.function, 'solo_agent', '有档位的那条必须胜出')
  assert.deepEqual(glm.reasoningConfig?.options, ['light', 'high', 'extra_high'])
  // 连带证据：那条的倍率是 0.08（solo_agent），不是 0.5（solo_work_lite）。
  // 原实现无条件「后覆盖前」，这里会变成 0.5 —— 那正是被修掉的缺陷。
  assert.equal(glm.creditsRate, 0.08, '整条择优，不是只搬 reasoningConfig')
})

test('batch 模型目录：context_window 取 dev 而不是 max', () => {
  // [出处] trae.ts:644-651：dev=200000 恒定可用，max=1000000 需开 Max 模式。
  const glm = parseTraeBatchModelList(batchFixture()).find((m) => m.id === 'glm-5.2')
  assert.equal(glm.contextWindow, 200000)
  assert.equal(glm.maxContextWindow, 1000000, 'max 窗口要单独存，不能混进 contextWindow')
})

test('batch 模型目录：model_detail_list 按 __dev / __max 后缀取值', () => {
  // [出处] trae.ts:885-899。
  const glm = parseTraeBatchModelList(batchFixture()).find((m) => m.id === 'glm-5.2')
  assert.equal(glm.maxOutputTokens, 32000, '常规输出上限取 __dev 那条')
  assert.equal(glm.maxModeOutputTokens, 64000, 'Max 模式输出上限取 __max 那条')
})

test('batch 模型目录：图片能力逐模型判定，两个字段不合并', () => {
  // [出处] trae.ts:738-777
  const glm = parseTraeBatchModelList(batchFixture()).find((m) => m.id === 'glm-5.2')
  assert.equal(glm.multimodal, true)
  assert.equal(glm.toolResponseMultimodal, false, '两个字段是独立的，不能合并判断')
})

test('batch 模型目录：响应形状不对时返回空数组而不是抛错', () => {
  assert.deepEqual(parseTraeBatchModelList(null), [])
  assert.deepEqual(parseTraeBatchModelList(undefined), [])
  assert.deepEqual(parseTraeBatchModelList('nope'), [])
  assert.deepEqual(parseTraeBatchModelList({}), [])
  assert.deepEqual(parseTraeBatchModelList({ function_configs: 'nope' }), [])
})

test('模型目录请求体：传全部 22 个 function，不是只传白名单', () => {
  // [出处] trae-auth.ts:670-675：真实 CN IDE 传的是全部 22 个；
  // 只传聊天通道会让非聊天通道的条目在响应里位置错乱。
  const body = buildTraeBatchModelsBody()
  assert.equal(body.functions.length, 22)
  assert.deepEqual(body.functions, [...TRAE_BATCH_FUNCTIONS])
  // 白名单是 15 个，与请求的 22 个是两码事。
  assert.equal(TRAE_CHANNELS.length, 15, '白名单是 15 个可调用通道')
  for (const channel of ['chat', 'builder', 'inline_chat']) {
    assert.ok(body.functions.includes(channel), `${channel} 要在请求里`)
    assert.equal(TRAE_CHANNELS.includes(channel), false, `${channel} 不能进白名单`)
  }
})

test('单通道模型目录：get_detail_param 也能解析（兜底路径）', () => {
  // [出处] trae.ts:1127：{ config_info_list: [...] }
  const models = parseTraeModelList({
    config_info_list: [
      { config_name: 'glm-5', display_config: { display_name: 'GLM-5' } },
      { config_name: '', display_config: { display_name: 'no id' } },
    ],
  })
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'glm-5')
  assert.equal(models[0].function, undefined, '单通道路径没有通道信息')
})

// ═══════════════════════ 三、倍率与折扣 ═══════════════════════

test('倍率解析：display_contact_config 是 JSON 字符串，rate=0 合法', () => {
  // [出处] trae.ts:952-966：三条判据，其中 rate=0 是合法值（免费）。
  const ok = readConsumptionRate({
    display_contact_config: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0.08 } } }),
  })
  assert.equal(ok, 0.08)

  // rate=0 是免费，必须返回 0 而不是 undefined。
  const free = readConsumptionRate({
    display_contact_config: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0 } } }),
  })
  assert.equal(free, 0, 'rate=0 是合法的免费倍率，不能被大于 0 过滤掉')

  // enable: false → 不显示（而不是当成 0）。
  assert.equal(readConsumptionRate({
    display_contact_config: JSON.stringify({ consumption_rate: { enable: false, data: { rate: 0.08 } } }),
  }), undefined)

  assert.equal(readConsumptionRate({ display_contact_config: 'not json' }), undefined)
  assert.equal(readConsumptionRate({ display_contact_config: JSON.stringify({}) }), undefined)
  assert.equal(readConsumptionRate({}), undefined)
})

test('倍率展示：0 显示免费，undefined 显示无倍率', () => {
  // [出处] trae-adapter.ts:591-602 的 traeDisplayName。
  assert.equal(traeDisplayName({ id: 'x', name: 'X', creditsRate: 0 }), 'X · 免费')
  assert.equal(traeDisplayName({ id: 'x', name: 'X', creditsRate: 0.08 }), 'X · x0.08')
  assert.equal(traeDisplayName({ id: 'x', name: 'X' }), 'X', '没有倍率就不加后缀')
  assert.equal(
    traeDisplayName({ id: 'x', name: 'X', creditsRate: 0.08, originalCreditsRate: 0.13 }),
    'X · x0.13→x0.08',
  )
})

test('活动折扣：discount_type=none 不算折扣，已过期也不算', () => {
  // [出处] trae.ts:986-1000：三条判据 + end_at 过期判定。
  const nowSec = 1_790_000_000

  assert.equal(readActivityDiscount({
    display_contact_config: JSON.stringify({
      activity_discount: {
        enable: true,
        data: { current: { discount_type: 'none', before_consumption_rate: 0.13, consumption_rate: 0.13 } },
      },
    }),
  }, nowSec), undefined, 'discount_type=none 不是折扣')

  assert.equal(readActivityDiscount({
    display_contact_config: JSON.stringify({
      activity_discount: {
        enable: true,
        data: { current: { discount_type: 'limited', before_consumption_rate: 0.13, consumption_rate: 0.13 } },
      },
    }),
  }, nowSec), undefined, '没降价就不算折扣')

  const active = readActivityDiscount({
    display_contact_config: JSON.stringify({
      activity_discount: {
        enable: true,
        data: {
          current: { discount_type: 'limited', before_consumption_rate: 0.13, consumption_rate: 0.08 },
          limited: { end_at: nowSec + 1000 },
        },
      },
    }),
  }, nowSec)
  assert.equal(active?.originalRate, 0.13)
  assert.equal(active?.endsAtSec, nowSec + 1000)

  // 已过期 → 整个折扣视为不存在。
  assert.equal(readActivityDiscount({
    display_contact_config: JSON.stringify({
      activity_discount: {
        enable: true,
        data: {
          current: { discount_type: 'limited', before_consumption_rate: 0.13, consumption_rate: 0.08 },
          limited: { end_at: nowSec - 1 },
        },
      },
    }),
  }, nowSec), undefined, '过期折扣不能展示')
})

// ═══════════════════════ 四、model → config_name 映射 ═══════════════════════

test('模型 id 归一化：__ 后缀、下划线、大小写', () => {
  // [出处] trae.ts:33：Go 端 mapModel 做「__dev 后缀去除、下划线→横线归一化、
  // 大小写不敏感匹配」三件事。
  assert.equal(normalizeTraeModelKey('custom_model_1M__dev'), 'custom-model-1m')
  assert.equal(normalizeTraeModelKey('DeepSeek-V4-Pro'), 'deepseek-v4-pro')
  assert.equal(normalizeTraeModelKey('deepseek_v4_pro'), 'deepseek-v4-pro')
  assert.equal(normalizeTraeModelKey('GLM-5.2'), 'glm-5.2')
  assert.equal(normalizeTraeModelKey('  glm-5.2  '), 'glm-5.2')
})

test('model → config_name：精确命中 / 归一化命中 / 兜底', () => {
  const catalog = [
    { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', function: 'solo_agent_remote' },
    { id: 'glm-5.2', name: 'GLM-5.2', function: 'solo_agent' },
  ]

  assert.deepEqual(resolveTraeModelTarget('glm-5.2', catalog, 'solo_work_lite'), {
    configName: 'glm-5.2',
    channel: 'solo_agent',
  })

  // 归一化命中 → 用**目录里的原始 id**，不是归一化后的串。
  assert.deepEqual(resolveTraeModelTarget('deepseek_v4_pro', catalog, 'solo_work_lite'), {
    configName: 'DeepSeek-V4-Pro',
    channel: 'solo_agent_remote',
  })
  assert.deepEqual(resolveTraeModelTarget('DEEPSEEK-V4-PRO', catalog, 'solo_work_lite'), {
    configName: 'DeepSeek-V4-Pro',
    channel: 'solo_agent_remote',
  })
  assert.deepEqual(resolveTraeModelTarget('DeepSeek-V4-Pro__dev', catalog, 'solo_work_lite'), {
    configName: 'DeepSeek-V4-Pro',
    channel: 'solo_agent_remote',
  })

  // 目录为空（还没拉到）→ 回退去后缀的原值 + 默认通道，**不报错**。
  assert.deepEqual(resolveTraeModelTarget('some-model__dev', [], 'solo_work_lite'), {
    configName: 'some-model',
    channel: 'solo_work_lite',
  })

  assert.equal(resolveTraeModelTarget('', [], 'solo_work_lite').configName, 'glm-5.2')
})

test('可调用判定：undefined 放行，false / true 才拦', () => {
  // [出处] trae.ts:812-830：未声明一律放行。
  assert.equal(isTraeModelCallable({ id: 'a', name: 'A' }), true, '未声明要放行')
  assert.equal(isTraeModelCallable({ id: 'a', name: 'A', isCustomModel: true }), false)
  assert.equal(isTraeModelCallable({ id: 'a', name: 'A', isCustomModel: false }), true)
  assert.equal(isTraeModelCallable({ id: 'a', name: 'A', isEnabled: false }), false)
  assert.equal(isTraeModelCallable({ id: 'a', name: 'A', isEnabled: true }), true)

  // isHidden **不**参与可调用判定（那是「官方选择器不展示」，两个独立维度）。
  assert.equal(isTraeModelCallable({ id: 'a', name: 'A', isHidden: true }), true,
    'isHidden 是「官方隐藏」不是「不可调用」')
})

test('思考档位可声明性：配置存在但 support_thinking=false 不算', () => {
  // [出处] trae.ts:1274-1289。
  assert.equal(declaresReasoningOptions({ id: 'a', name: 'A' }), false)
  assert.equal(declaresReasoningOptions({
    id: 'a', name: 'A', reasoningConfig: { options: [] },
  }), false, '空档位不算')
  assert.equal(declaresReasoningOptions({
    id: 'a', name: 'A', reasoningConfig: { options: ['high'], supportThinking: false },
  }), false, 'support_thinking=false 不算（否则等于没修）')
  assert.equal(declaresReasoningOptions({
    id: 'a', name: 'A', reasoningConfig: { options: ['light', 'high'], supportThinking: true },
  }), true)
})

// ═══════════════════════ 五、载荷转换（OpenAI → SOLO） ═══════════════════════

test('载荷转换：model → config_name + model 双字段，stream 强制 true', () => {
  // [出处] trae.ts:1528-1577 的 7 条改写规则。
  const solo = transformToSOLOBody(
    { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: false },
    'glm-5.2',
    'solo_agent',
  )
  assert.equal(solo.config_name, 'glm-5.2')
  assert.equal(solo.model, 'glm-5.2', 'model 与 config_name 是双字段')
  assert.equal(solo.stream, true, 'stream 必须强制 true（我们只走流式路径）')
  assert.equal(solo.function, 'solo_agent')
  assert.deepEqual(solo.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

test('载荷转换：通道缺省回退 solo_work_lite', () => {
  // [出处] trae.ts:1463-1468：Function = "solo_work_lite"，其他值实测无效。
  assert.equal(transformToSOLOBody({ model: 'x', messages: [] }, 'x', '').function, 'solo_work_lite')
  assert.equal(transformToSOLOBody({ model: 'x', messages: [] }, 'x').function, 'solo_work_lite')
})

test('载荷转换：assistant 的 tool_calls 用 function_call 字段名', () => {
  // [出处] trae.ts:1582-1621：SOLO 用 function_call，OpenAI 用 function。
  const solo = transformToSOLOBody({
    model: 'x',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_image', arguments: '{}' } },
        ],
      },
    ],
  }, 'x')
  const msg = solo.messages[0]
  assert.equal(msg.tool_calls.length, 1)
  assert.deepEqual(msg.tool_calls[0].function_call, { name: 'read_image', arguments: '{}' })
  assert.equal(msg.tool_calls[0].function, undefined, 'function 字段要被替换掉')
})

test('载荷转换：无名的 tool_call 被剔除', () => {
  // [出处] trae.ts:1598-1600。
  const solo = transformToSOLOBody({
    model: 'x',
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', function: { arguments: '{}' } },
          { id: 'call_2', function: { name: 'good', arguments: '{}' } },
        ],
      },
    ],
  }, 'x')
  assert.equal(solo.messages[0].tool_calls.length, 1)
  assert.equal(solo.messages[0].tool_calls[0].function_call.name, 'good')

  const none = transformToSOLOBody({
    model: 'x',
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c', function: {} }] }],
  }, 'x')
  assert.equal(none.messages[0].tool_calls, undefined)
})

test('载荷转换：tools.parameters 序列化成字符串', () => {
  // [出处] trae.ts:1681-1709：SOLO 要求 parameters 是 string 类型。
  const solo = transformToSOLOBody({
    model: 'x',
    messages: [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'w',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ],
  }, 'x')
  assert.equal(typeof solo.tools[0].function.parameters, 'string')
  assert.deepEqual(JSON.parse(solo.tools[0].function.parameters), {
    type: 'object',
    properties: { city: { type: 'string' } },
  })
})

test('载荷转换：tool_choice 归一化', () => {
  // [出处] trae.ts:1623-1679。
  const withTools = () => [{ type: 'function', function: { name: 'f', parameters: {} } }]

  const none = transformToSOLOBody({ model: 'x', messages: [], tools: withTools(), tool_choice: 'none' }, 'x')
  assert.equal(none.tool_choice, undefined)
  assert.equal(none.tools, undefined, 'none 必须连 tools 一起删')

  const noneObj = transformToSOLOBody({ model: 'x', messages: [], tools: withTools(), tool_choice: { type: 'none' } }, 'x')
  assert.equal(noneObj.tool_choice, undefined)
  assert.equal(noneObj.tools, undefined)

  assert.equal(transformToSOLOBody({ model: 'x', messages: [], tool_choice: { type: 'auto' } }, 'x').tool_choice, 'auto')
  assert.equal(transformToSOLOBody({ model: 'x', messages: [], tool_choice: { type: 'required' } }, 'x').tool_choice, 'required')
  assert.equal(
    transformToSOLOBody({ model: 'x', messages: [], tool_choice: { type: 'function', function: { name: 'f' } } }, 'x').tool_choice,
    'f',
  )
  assert.equal(
    transformToSOLOBody({ model: 'x', messages: [], tool_choice: { type: 'function', function: {} } }, 'x').tool_choice,
    'auto',
  )
})

test('载荷转换：max_tokens 收敛到 64000 上限', () => {
  // [出处] trae.ts:1386-1420：客户端索要 131072 会把上游打成 4xx。
  assert.equal(clampTraeMaxTokens(131072), 64000)
  assert.equal(clampTraeMaxTokens(1000), 1000, '小的不动')
  assert.equal(clampTraeMaxTokens(undefined), undefined, '不编造数值')
  assert.equal(clampTraeMaxTokens(0), 0, '非正数原样返回')
  assert.equal(clampTraeMaxTokens(-5), -5)
  assert.equal(clampTraeMaxTokens(131072, 0), 131072, 'limit=0 表示不收敛')
})

test('载荷转换：Max 模式三件套必须成套下发', () => {
  // [出处] trae.ts:1491-1525：只调大 max_tokens 不行，远端按 strategy=max 判定。
  const fields = traeMaxModeFields(1_000_000, 64_000)
  assert.equal(fields.model_auto_selection.strategy, 'max')
  assert.equal(fields.model_selection_strategy, 'max')
  assert.equal(fields.mode_type, 1)
  assert.equal(fields.context_window_size, 1_000_000)
  assert.equal(fields.prompt_max_tokens, 936_000)
  assert.equal(fields.max_tokens, 64_000)
  assert.equal(traeMaxModeFields(0).context_window_size, 1_000_000)
})

test('载荷转换：buildOpenAiBody 不整份透传内部字段', () => {
  const body = buildOpenAiBody({
    model: 'x',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
    max_tokens: 999999,
    reasoning: 'high',
    someInternalFlag: true,
  })
  assert.equal(body.model, 'x')
  assert.equal(body.temperature, 0.5)
  assert.equal(body.max_tokens, 64000, 'max_tokens 要收敛')
  assert.equal(body.reasoning, undefined, '内部字段不能透传')
  assert.equal(body.someInternalFlag, undefined)
})

// ─────────────── 推理强度档位：目录声明 + 请求下发的完整链 ───────────────

/**
 * 真实缺口（2026-10-19）：TRAE 的目录解析**早就**读出了 `reasoning_effort_config`
 * （连「空档位不得覆盖有档位」的合并规则都实现了），但适配器只把它压成一个
 * `reasoning: true` 布尔 —— 档位本身**从来没进过 `ModelMeta`**，于是选择器里
 * 一个档位行都没有。参考实现把这条记为用户报障（issue IKI7WT/IKILR7）。
 */
test('适配器：把远端推理档位报进 ModelMeta（不报就永远没有档位行）', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: batchFixture(), text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const models = await adapter.getModelMetaList(account(), ctx)
  const glm = models.find((m) => m.id === 'glm-5.2')
  assert.ok(glm, 'glm-5.2 应在目录里')
  assert.equal(glm.reasoning, true)
  // [出处] trae.ts:726-731 的真实形状：options 是**私有 wire 值**。
  assert.deepEqual(glm.reasoningEfforts, ['light', 'high', 'extra_high'])
  assert.equal(glm.defaultReasoningEffort, 'high', '远端 default_level 要照实上报')
})

test('适配器：目录里没声明档位的模型不出档位（不编造能力）', async () => {
  // 自建最小目录：一条有档位、一条没有，正好对照。
  // （`batchFixture()` 里唯一存活的 `glm-5.2` 是有档位的那条，
  //   所以对照组必须另造 —— 这也顺带证明测试不是「全都取不到」而假绿。）
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        return {
          ok: true, status: 200, kind: 'none', headers: new Headers(), text: '',
          body: {
            function_configs: [{
              function: 'solo_agent',
              config_info_list: [
                {
                  config_name: 'with_tiers',
                  usage: 'chat_completion',
                  config_switch: true,
                  display_config: { display_name: 'With Tiers' },
                  reasoning_effort_config: { default_level: 'high', options: ['light', 'high'], support_thinking: true },
                },
                {
                  // 目录里没有 `reasoning_effort_config` → 远端未声明可用档位。
                  config_name: 'no_tiers',
                  usage: 'chat_completion',
                  config_switch: true,
                  display_config: { display_name: 'No Tiers' },
                },
                {
                  // `support_thinking: false` → 明确说不支持思考，即使给了 options 也不算。
                  config_name: 'thinking_off',
                  usage: 'chat_completion',
                  config_switch: true,
                  display_config: { display_name: 'Thinking Off' },
                  reasoning_effort_config: { options: ['light', 'high'], support_thinking: false },
                },
              ],
            }],
          },
        }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const models = await adapter.getModelMetaList(account(), ctx)
  const byId = new Map(models.map((m) => [m.id, m]))

  // 对照组：有声明的那条必须有档位。
  assert.deepEqual(byId.get('with_tiers').reasoningEfforts, ['light', 'high'])
  assert.equal(byId.get('with_tiers').defaultReasoningEffort, 'high')
  // 没声明 → 不编造。
  assert.equal(byId.get('no_tiers').reasoningEfforts, undefined, '没声明档位时不该编造')
  assert.equal(byId.get('no_tiers').defaultReasoningEffort, undefined)
  // support_thinking=false → 明确不支持，不出档位。
  assert.equal(byId.get('thinking_off').reasoningEfforts, undefined, 'support_thinking=false 时不出档位')
})

test('适配器：default_level 不在 options 内时不下发默认档', async () => {
  // ⚠️ DSH 会直接拿 defaultEffort 发请求，给一个不存在的档位会抛
  // `UNSUPPORTED_REASONING_EFFORT`（参考实现注释里点名过这个坑）。
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        return {
          ok: true, status: 200, kind: 'none', headers: new Headers(), text: '',
          body: {
            function_configs: [{
              function: 'solo_agent',
              config_info_list: [{
                config_name: 'weird_model',
                usage: 'chat_completion',
                config_switch: true,
                display_config: { display_name: 'Weird' },
                // 默认档 `ultra` 不在 options 内 —— 畸形但真实可能出现的形状。
                reasoning_effort_config: { default_level: 'ultra', options: ['light', 'high'], support_thinking: true },
              }],
            }],
          },
        }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const models = await adapter.getModelMetaList(account(), ctx)
  const weird = models.find((m) => m.id === 'weird_model')
  assert.ok(weird, 'weird_model 应在目录里')
  assert.deepEqual(weird.reasoningEfforts, ['light', 'high'], '档位本身照报')
  assert.equal(weird.defaultReasoningEffort, undefined, '默认档不在集合内 → 不下发，交给核心层启发式')
})

test('载荷转换：reasoning_effort 必须真的进 SOLO 载荷', () => {
  // 真实缺口：核心层把翻译好的档位放进 `payload.reasoning_effort`，
  // 而 buildOpenAiBody 把它丢掉了 —— 用户选了档位，**请求里根本不带**。
  const body = buildOpenAiBody({
    model: 'x',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'extra_high',
    // 我们的内部字段仍然不许透传。
    reasoning: 'high',
  })
  assert.equal(body.reasoning_effort, 'extra_high', '档位要原样透传给上游（私有 id，不再翻译）')
  assert.equal(body.reasoning, undefined, '内部字段仍然不能透传')
})

test('载荷转换：档位缺省/非字符串时不下发该键', () => {
  for (const value of [undefined, '', null, 1, true, {}]) {
    const body = buildOpenAiBody({ model: 'x', messages: [], reasoning_effort: value })
    assert.equal('reasoning_effort' in body, false, `reasoning_effort=${JSON.stringify(value)} 不该出现在请求体里`)
  }
})

// ═══════════════════════ 六、SSE 转换（核心回归） ═══════════════════════

test('SSE 解析：event + data 行的 JSON', () => {
  // [出处] trae-adapter.ts:1248-1264 的事件格式注释。
  const ev = parseTraeSSELine('output', '{"response":"你好","reasoning_content":"想想"}')
  assert.equal(ev.event, 'output')
  assert.equal(ev.response, '你好')
  assert.equal(ev.reasoningContent, '想想')

  const usage = parseTraeSSELine('token_usage', '{"prompt_tokens":21,"completion_tokens":142}')
  assert.equal(usage.usage.prompt_tokens, 21)

  assert.equal(parseTraeSSELine('done', '{"finish_reason":"stop"}').finishReason, 'stop')

  const err = parseTraeSSELine('error', '{"code":4008,"message":"quota exceeded"}')
  assert.equal(err.errorCode, 4008)
  assert.equal(err.errorMessage, 'quota exceeded')

  // 坏 JSON：不丢事件本身（仍然要能知道「上游开工了」）。
  const bad = parseTraeSSELine('output', '{not json')
  assert.equal(bad.event, 'output')
  assert.equal(bad.response, undefined)
})

test('SSE 工具调用：function_call → function，清掉 SOLO 专属字段', () => {
  // [出处] trae.ts:1779-1801 的 normalizeTraeToolCalls。
  const ev = parseTraeSSELine('output', JSON.stringify({
    tool_calls: [{ index: 0, id: 'call_1', function_call: { name: 'f', arguments: '{}', namespace: 'ns', partial_arguments: 'x' } }],
  }))
  assert.deepEqual(ev.toolCalls[0].function, { name: 'f', arguments: '{}' })
  assert.equal(ev.toolCalls[0].function_call, undefined)
})

/**
 * ★★★ **回归用例（插件级硬规则）** ★★★
 *
 * 我们插件曾有一个真实缺陷：**流式正文被冲掉**。根因是 DSH 宿主的 `block-end`
 * 是**覆盖式赋值**而不是关闭信号，传空串会把之前所有 `text-delta` 整个丢掉。
 * 症状：「流式有字，一调工具 / 一收尾就变空」。
 *
 * 本用例证明：**多段 text 拼接后正文完整**。
 * 详见 `src/llm/adapter.ts:399-420` 与 `src/vendor/trae/trae-sse.ts` 的模块注释。
 */
test('★ 回归：多段 text 拼接后正文完整（block-end 覆盖式赋值那条坑）', () => {
  const lines = [
    'event:metadata',
    'data:{"session_id":"s1"}',
    '',
    'event:output',
    'data:{"response":"第一段"}',
    '',
    'event:output',
    'data:{"response":"，第二段"}',
    '',
    'event:output',
    'data:{"response":"，第三段。"}',
    '',
    'event:token_usage',
    'data:{"prompt_tokens":10,"completion_tokens":20}',
    '',
    'event:done',
    'data:{"finish_reason":"stop"}',
    '',
  ]

  const events = [...convertTraeSseLines(lines)]
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
  assert.equal(text, '第一段，第二段，第三段。')

  // 逐事件透出：三段各自成事件，不是一个「最后一段」。
  assert.equal(events.filter((e) => e.type === 'text').length, 3)

  // ★ 关键：**累积缓冲**里的正文与流出的正文完全一致。
  // 这正是「自己攒完整正文」那条纪律的证据 —— 收尾时不依赖增量拼接的边界。
  const agg = aggregateTraeSSE(lines)
  assert.equal(agg.content, '第一段，第二段，第三段。')
  assert.equal(agg.finishReason, 'stop')
  assert.equal(agg.usage.outputTokens, 20)
})

test('★ 回归：工具调用与正文共存，互不冲掉', () => {
  // [出处] trae-adapter.ts:1421-1434 的注释：同一个 `output` 事件确实可能
  // **同时**携带 reasoning_content 与 tool_calls（实测复现）。
  // 参考实现踩过的坑：用 `continue` 会跳过同帧位于其后的分支，把工具吞掉。
  const lines = [
    'event:output',
    'data:{"response":"我要调用工具。"}',
    '',
    'event:output',
    'data:{"response":"正在查询…","reasoning_content":"先想一下","tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"get_weather","arguments":"{\\"city\\""}}]}',
    '',
    'event:output',
    'data:{"tool_calls":[{"index":0,"function_call":{"arguments":":\\"北京\\"}"}}]}',
    '',
    'event:done',
    'data:{"finish_reason":"tool_calls"}',
    '',
  ]

  const conv = new TraeSseConverter()
  const events = []
  for (const line of lines) events.push(...conv.feedLine(line))
  events.push(...conv.finish())

  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
  const reasoning = events.filter((e) => e.type === 'reasoning').map((e) => e.text).join('')
  const tools = events.filter((e) => e.type === 'tool_call')

  // ★ 正文完整（两段都在）。
  assert.equal(text, '我要调用工具。正在查询…')
  // ★ 思维链完整，且**没有被正文覆盖**。
  assert.equal(reasoning, '先想一下')
  // ★ 工具调用也在，且参数跨帧拼完整。
  assert.equal(tools.length, 2)
  assert.equal(tools[0].name, 'get_weather')
  assert.equal(tools[0].id, 'call_1')
  assert.equal(tools[0].argumentsDelta + tools[1].argumentsDelta, '{"city":"北京"}')
  // ★ 三者同时存在 —— 这就是「互不冲掉」。
  assert.ok(text.length > 0 && reasoning.length > 0 && tools.length > 0)

  // 缓冲里的完整正文与流出的一致。
  assert.equal(conv.text, '我要调用工具。正在查询…')
  assert.equal(conv.reasoning, '先想一下')
})

test('★ 回归：思维链与正文各自独立累积，不互相赋值', () => {
  const lines = [
    'event:output',
    'data:{"reasoning_content":"思考A"}',
    '',
    'event:output',
    'data:{"response":"正文B"}',
    '',
    'event:output',
    'data:{"reasoning_content":"思考C"}',
    '',
    'event:output',
    'data:{"response":"正文D"}',
    '',
    'event:done',
    'data:{"finish_reason":"stop"}',
    '',
  ]
  const conv = new TraeSseConverter()
  for (const line of lines) conv.feedLine(line)
  conv.finish()
  assert.equal(conv.reasoning, '思考A思考C', '思维链要跨帧累积')
  assert.equal(conv.text, '正文B正文D', '正文要跨帧累积，不能被思维链冲掉')
})

test('SSE：工具名未到达前不发任何事件（避免空名字 tool-call 污染会话）', () => {
  // [出处] trae-adapter.ts:1474-1479：名称为空前不发射任何 chunk ——
  // BlockAssembler 会把没有 block-end 的 partial 也组装成空名字，
  // 污染会话后让下游端点以 400 拒绝请求。
  const conv = new TraeSseConverter()
  // 先来的只有 arguments，没有 name（真实 SOLO 事件总是带 `event:` 行）。
  const first = [
    ...conv.feedLine('event:output'),
    ...conv.feedLine('data:{"tool_calls":[{"index":0,"function_call":{"arguments":"{"}}]}'),
    ...conv.feedLine(''),
  ]
  assert.deepEqual(first, [], '名字没到之前一个事件都不发')

  const second = [
    ...conv.feedLine('event:output'),
    ...conv.feedLine('data:{"tool_calls":[{"index":0,"id":"call_9","function_call":{"name":"f","arguments":"}"}}]}'),
    ...conv.feedLine(''),
  ]
  assert.equal(second.length, 1)
  assert.equal(second[0].type, 'tool_call')
  assert.equal(second[0].name, 'f')
  assert.equal(second[0].id, 'call_9')
  assert.equal(second[0].argumentsDelta, '{}', '之前攒下的 arguments 要一起发出')
})

test('SSE：没有 event 行的 data 块被丢弃（无法解释的块不猜）', () => {
  // 上游每个事件块都带 `event:` 行。只有 data 而没有类型声明的块**无法解释** ——
  // 猜一个类型（例如沿用上一条的名字）在错的时候会静默产出错误的事件，
  // 比直接丢弃更难查。这条断言把这个取舍固定下来。
  const conv = new TraeSseConverter()
  conv.feedLine('data:{"response":"没有类型声明"}')
  assert.deepEqual(conv.feedLine(''), [])
  assert.equal(conv.text, '', '没有 event 行的块不进缓冲')
  assert.equal(conv.sawUpstreamEvent, false, '也不算「上游开工了」')
})

test('SSE：data 跨行累积而不是覆盖', () => {
  // [出处] trae-adapter.ts:1565：SOLO data 可跨行拼接。
  const conv = new TraeSseConverter()
  conv.feedLine('event:output')
  conv.feedLine('data:{"response":"跨')
  conv.feedLine('data:行拼接"}')
  const events = conv.feedLine('')
  assert.equal(events.length, 1)
  assert.equal(events[0].text, '跨行拼接')
})

test('SSE：跨 chunk 的 UTF-8 残字节不能变乱码', async () => {
  const lines = [
    'event:output', 'data:{"response":"中文流式测试"}', '',
    'event:done', 'data:{"finish_reason":"stop"}', '',
  ]
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('batch_get_detail_param')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { function_configs: [] }, text: '' }
      }
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
    // 每次只喂 1 个字节 —— 最坏情况的分块。
    fetchImpl: async () => sseResponse(lines, { chunkSize: 1 }),
  })
  const events = []
  for await (const ev of adapter.requestChatStream({ model: 'glm-5.2', messages: [] }, account(), ctx, new AbortController().signal)) {
    events.push(ev)
  }
  const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
  assert.equal(text, '中文流式测试', '逐字节分块也不能出乱码')
})

test('SSE：usage 里 reasoning_tokens 计入 completion，不重复相加', () => {
  // [出处] trae-adapter.ts:1278-1281：reasoning_tokens 计入 completion_tokens。
  const usage = normalizeTraeUsage({ prompt_tokens: 21, completion_tokens: 142, reasoning_tokens: 40 })
  assert.equal(usage.inputTokens, 21)
  assert.equal(usage.outputTokens, 142, '不能把 reasoning 再加一遍')
  assert.equal(usage.reasoningTokens, 40)
  assert.equal(usage.totalTokens, 163)
})

test('SSE：流内错误码分类，4001/4023 不换号', () => {
  // [出处] trae-adapter.ts:1540-1551。
  assert.equal(classifyTraeStreamError(1005), 'quota')
  assert.equal(classifyTraeStreamError(4008), 'quota')
  assert.equal(classifyTraeStreamError(4011), 'rate_limit')
  assert.equal(classifyTraeStreamError(4001), 'bad_request')
  assert.equal(classifyTraeStreamError(4023), 'bad_request')
  assert.equal(classifyTraeStreamError(3003), 'server')
  assert.equal(classifyTraeStreamError(9999), 'unknown')

  assert.equal(isRotatableTraeStreamError(1005), true)
  assert.equal(isRotatableTraeStreamError(4008), true)
  assert.equal(isRotatableTraeStreamError(4011), true)
  assert.equal(isRotatableTraeStreamError(4001), false, '4001 换号也没用')
  assert.equal(isRotatableTraeStreamError(4023), false)
})

test('SSE：event:error 如实透出，且归类到正确 ErrorKind', () => {
  // [出处] trae-adapter.ts:1262-1263 的事件样例。
  const events = [...convertTraeSseLines([
    'event:error', 'data:{"code":4008,"message":"quota exceeded"}', '',
  ])]
  const err = events.find((e) => e.type === 'error')
  assert.ok(err !== undefined)
  assert.equal(err.failure.kind, 'quota')
  assert.match(err.failure.message, /4008/)
  assert.match(err.failure.message, /quota exceeded/, '原始文案要带出来（不许吞错）')
})

test('SSE：一个事件都没收到时 sawUpstreamEvent 为 false', () => {
  // [出处] trae-adapter.ts:1330-1340：上游有时「HTTP 200 但一个事件都不发」。
  const conv = new TraeSseConverter()
  conv.finish()
  assert.equal(conv.sawUpstreamEvent, false)

  const conv2 = new TraeSseConverter()
  conv2.feedLine('event:metadata')
  conv2.feedLine('data:{"x":1}')
  conv2.feedLine('')
  assert.equal(conv2.sawUpstreamEvent, true, 'metadata 也算上游开工了')
})

// ═══════════════════════ 七、签到与余额 ═══════════════════════

test('业务码：字符串形态要认，字段缺失当成功', () => {
  // [出处] trae-credits.ts:121-132 readClaimCode。
  assert.equal(readTraeClaimCode({ code: 0 }), 0)
  assert.equal(readTraeClaimCode({ code: 9074 }), 9074)
  assert.equal(readTraeClaimCode({ code: '9074' }), 9074, '后端可能以字符串返回业务码')
  assert.equal(readTraeClaimCode({}), 0, '成功响应本来就不带 code')
  assert.equal(readTraeClaimCode({ code: 'abc' }), -1, '认不出的码不能当成成功')
  assert.equal(readTraeClaimCode({ code: null }), -1)
})

test('签到错误分类与冷却时长', () => {
  // [出处] trae-credits.ts:74-100（对齐 trae-mate cooldown.rs）。
  assert.deepEqual(classifyTraeCheckinError(200, 1005), { type: 'PlanLimit', cooldownSecs: 43_200 })
  assert.deepEqual(classifyTraeCheckinError(429, 0), { type: 'SoftRate', cooldownSecs: 60 })
  assert.deepEqual(classifyTraeCheckinError(401, 0), { type: 'SessionDead', cooldownSecs: -1 })
  assert.deepEqual(classifyTraeCheckinError(404, 0), { type: 'NotFound', cooldownSecs: 60 })
  assert.deepEqual(classifyTraeCheckinError(503, 0), { type: 'Server', cooldownSecs: 600 })
  assert.deepEqual(classifyTraeCheckinError(400, 0), { type: 'Client', cooldownSecs: 600 })
  assert.deepEqual(classifyTraeCheckinError(200, 9074), { type: 'BusinessError', cooldownSecs: 300 })
  assert.deepEqual(classifyTraeCheckinError(200, 0), { type: 'Unknown', cooldownSecs: 0 })
})

test('9074 是可重试的（设备级限流，不是判死）', () => {
  // [出处] trae.ts:1326-1332：9074 的限流范围是 device_id 而非账号。
  assert.equal(isTraeCheckinBusy(9074), true)
  assert.equal(isTraeCheckinBusy(0), false)
  assert.equal(isTraeCheckinBusy(1005), false)
})

test('签到状态解析：checked_in 必须严格 true', () => {
  // [出处] trae-credits.ts:19-21 与 :286-287。
  const status = parseTraeCheckinStatus({ checked_in: true, credits: 150, enable: true, streak_days: 3, total_credits: 900 })
  assert.equal(status.todayCheckedIn, true)
  assert.equal(status.dailyCredit, 150)
  assert.equal(status.active, true)
  assert.equal(status.streakDays, 3)
  assert.equal(status.totalCredits, 900)

  // 字段缺失 → 保守地**不**声称「已签到」（否则用户真的领不到）。
  const missing = parseTraeCheckinStatus({ enable: true })
  assert.equal(missing.todayCheckedIn, false, '缺失时不能声称已签到')
  assert.equal(missing.dailyCredit, 0)
})

test('积分余额：多包求和、包名取 display_desc、到期秒转毫秒', () => {
  // [出处] trae-credits.ts:316-381：
  //   - 包名用 display_desc（base.name 实测为 undefined）
  //   - expire_time 是**秒级**（实测 1790783999 = 2026-09-30 23:59:59）
  //   - 「每月登录赠送」500 与「签到奖励」150 是实测的包名与数值
  const balance = parseTraeCreditBalance({
    user_entitlement_pack_list: [
      {
        entitlement_base_info: { display_desc: '每月登录赠送', quota: { credits_limit: 500 } },
        usage: { credits_amount: 120 },
        expire_time: 1790783999,
      },
      {
        entitlement_base_info: { display_desc: '签到奖励', quota: { credits_limit: 150 } },
        usage: { credits_amount: 0 },
      },
      {
        entitlement_base_info: { display_desc: '空包', quota: { credits_limit: 0 } },
      },
    ],
  })
  assert.ok(balance !== undefined)
  assert.equal(balance.packages.length, 2, 'credits_limit 不大于 0 的占位包要跳过')
  assert.equal(balance.total, 380 + 150)
  assert.equal(balance.packages[0].name, '每月登录赠送')
  assert.equal(balance.packages[0].remaining, 380)
  assert.equal(balance.packages[0].total, 500)
  assert.equal(balance.packages[0].used, 120)
  // 秒 → 毫秒必须 ×1000，否则显示落在 1970 年。
  assert.equal(balance.packages[0].deductionEndTime, 1790783999000)
  assert.equal(balance.packages[1].deductionEndTime, undefined, '没有 expire_time 就不设')
})

test('积分余额：拿不到包时返回 undefined（不伪造零余额）', () => {
  assert.equal(parseTraeCreditBalance({}), undefined)
  assert.equal(parseTraeCreditBalance({ user_entitlement_pack_list: [] }), undefined)
  assert.equal(parseTraeCreditBalance({ user_entitlement_pack_list: [{ junk: 1 }] }), undefined)
})

test('签到设备轮换代次：读写往返', () => {
  assert.equal(readCheckinGeneration(undefined), 0)
  assert.equal(readCheckinGeneration({}), 0)
  assert.equal(readCheckinGeneration({ generation: 3 }), 3)
  assert.equal(readCheckinGeneration({ generation: -1 }), 0, '负数当 0')
  assert.equal(readCheckinGeneration({ generation: 'x' }), 0)
  assert.deepEqual(checkinGenerationPayload(2), { generation: 2 })
  assert.deepEqual(checkinGenerationPayload(-5), { generation: 0 })
})

// ═══════════════════════ 八、HTTP 错误分类 ═══════════════════════

test('HTTP 错误分类：业务码优先于状态码', () => {
  // [出处] trae-errors.ts:62-125 的判定顺序。
  assert.equal(classifyTraeError(200, '{"code":1005,"message":"plan limit reached"}'), 'quota')
  assert.equal(classifyTraeError(200, '{"code":4008}'), 'quota')
  assert.equal(classifyTraeError(200, '{"code":4011}'), 'rate_limit')
  // 4008 必须先于 4011 判定（两者可能同现，严重的优先）。
  assert.equal(classifyTraeError(200, '{"code":4008,"msg":"also 4011"}'), 'quota',
    '更严重的分类必须优先命中')

  assert.equal(classifyTraeError(401, 'token 失效'), 'auth')
  assert.equal(classifyTraeError(429, ''), 'rate_limit')
  assert.equal(classifyTraeError(404, ''), 'not_found')
  assert.equal(classifyTraeError(503, ''), 'server')
  assert.equal(classifyTraeError(400, ''), 'bad_request')
  assert.equal(classifyTraeError(200, ''), 'none')
})

test('HTTP 错误分类：只有 auth/rate_limit/quota 值得换号', () => {
  // 与参考实现的 shouldRotateTraeAccount（除 none 外都换）刻意不同：
  // bad_request 换号是明确有害的，会让「模型选错了」把整池账号轮一遍各失败一次。
  assert.equal(shouldRotateTraeAccount('auth'), true)
  assert.equal(shouldRotateTraeAccount('rate_limit'), true)
  assert.equal(shouldRotateTraeAccount('quota'), true)
  assert.equal(shouldRotateTraeAccount('bad_request'), false)
  assert.equal(shouldRotateTraeAccount('server'), false)
  assert.equal(shouldRotateTraeAccount('none'), false)
})

// ═══════════════════════ 九、凭据与设备身份 ═══════════════════════

test('设备身份：按账号确定性派生，各账号互不相同', () => {
  const m1 = deriveMachineId('trae:a1')
  const m2 = deriveMachineId('trae:a2')
  const d1 = deriveDeviceId('trae:a1')
  const d2 = deriveDeviceId('trae:a2')

  // 32 位 hex（TRAE 的 device_id 是 openssl rand -hex 16 的产物）。
  assert.match(m1, /^[0-9a-f]{32}$/, 'machine_id 必须是 32 hex')
  assert.match(d1, /^[0-9a-f]{32}$/, 'device_id 必须是 32 hex')

  // 确定性：同一账号永远同一个值（重启不变）。
  assert.equal(deriveMachineId('trae:a1'), m1)
  assert.equal(deriveDeviceId('trae:a1'), d1)

  // 各账号必须互不相同 —— 共用 device_id 会让第二个账号报「该设备已签到」。
  assert.notEqual(d1, d2, '两个账号的签到设备号不能相同')
  assert.notEqual(m1, m2)
  assert.notEqual(m1, d1, 'machine_id 与 device_id 不能是同一个值')
})

test('签到设备轮换：代次变则设备号变，代次 0 保持原值', () => {
  // [出处] trae.ts:1350-1356：派生结果由 (device_id, generation) 唯一决定。
  const base = 'a'.repeat(32)
  assert.equal(deriveCheckinDeviceId(base, 0), base, '代次 0 原样返回')
  assert.equal(deriveCheckinDeviceId(base, -1), base)
  const gen1 = deriveCheckinDeviceId(base, 1)
  const gen2 = deriveCheckinDeviceId(base, 2)
  assert.match(gen1, /^[0-9a-f]{32}$/)
  assert.notEqual(gen1, base, '轮换必须真的换一个值')
  assert.notEqual(gen1, gen2)
  assert.equal(deriveCheckinDeviceId(base, 1), gen1, '同一代次反复算得同一个值')
})

test('签到头：确定性派生 + 代次真的参与派生', () => {
  // [出处] trae.ts:281-314 的 traeCheckinHeaders（约 20 个客户端头）。
  const credential = {
    access_token: 'tok', refresh_token: '', uid: 'u1',
    machine_id: 'm'.repeat(32), device_id: 'd'.repeat(32),
  }
  const h = traeCheckinHeaders(credential, 'u1')
  assert.equal(h.Authorization, 'Cloud-IDE-JWT tok')
  assert.equal(h['X-User-Region'], 'CN')
  assert.equal(h['X-Device-Id'], deriveDeviceId15('u1'))
  assert.match(h['X-Device-Id'], /^\d{15}$/, '签到设备号是 15 位数字')
  assert.equal(h['X-Market-User-Id'], deriveMarketUserId('u1'))
  assert.equal(h['Vscode-Sessionid'], deriveSessionId('u1'))
  assert.ok(h['X-Request-Id'].length > 0)
  assert.ok(h['X-Tt-Trace-Id'].startsWith('00-'))

  // 代次必须真的改变设备号 —— 否则「9074 后轮换」是个空动作。
  const h2 = traeCheckinHeaders(credential, 'u1', 1)
  assert.notEqual(h2['X-Device-Id'], h['X-Device-Id'], '轮换代次必须改变签到设备号')

  assert.deepEqual(traeCheckinHeaders(credential, 'u1')['X-Device-Id'], h['X-Device-Id'])
  assert.notEqual(traeCheckinHeaders(credential, 'u2')['X-Device-Id'], h['X-Device-Id'])

  assert.match(deriveDeviceId15('u1'), /^\d{15}$/)
})

test('SOLO 头：同一个 token 出现在三个头里，含设备指纹', () => {
  // [出处] trae.ts:204-236：实测缺任一个都可能被上游拒绝。
  const credential = {
    access_token: 'tok', refresh_token: '', uid: 'u1',
    machine_id: 'm'.repeat(32), device_id: 'd'.repeat(32),
  }
  const h = traeSOLOHeaders(credential, true)
  assert.equal(h.Authorization, 'Cloud-IDE-JWT tok')
  assert.equal(h['X-Cloudide-Token'], 'tok')
  assert.equal(h['X-Ide-Token'], 'tok')
  assert.equal(h['X-Uid'], 'u1')
  assert.equal(h['X-Machine-Id'], credential.machine_id)
  assert.equal(h['X-Device-Id'], credential.device_id)
  assert.equal(h.Accept, 'text/event-stream')
  assert.equal(traeSOLOHeaders(credential, false).Accept, 'application/json')
  // 空设备指纹不塞空头。
  const bare = traeSOLOHeaders({ access_token: 't', refresh_token: '', uid: 'u', machine_id: '', device_id: '' }, false)
  assert.equal(bare['X-Machine-Id'], undefined)
  assert.equal(bare['X-Device-Id'], undefined)
})

test('凭据映射：从我们的扁平凭证组装，缺失设备指纹走派生', () => {
  const c = toTraeCredential(
    { token: 'tok', refreshToken: 'rt', expiresAt: 1_700_000_000_000, uid: 'u1' },
    { machineId: 'M'.repeat(32), deviceId: 'D'.repeat(32) },
  )
  assert.equal(c.access_token, 'tok')
  assert.equal(c.refresh_token, 'rt')
  assert.equal(c.expires_at, '1700000000000')
  assert.equal(c.uid, 'u1')
  assert.equal(c.machine_id, 'M'.repeat(32), '没存过就用派生的')
  assert.equal(c.device_id, 'D'.repeat(32))

  // 存过的优先。
  const stored = toTraeCredential(
    { token: 'tok', uid: 'u1', machine_id: 'S'.repeat(32), device_id: 'T'.repeat(32) },
    { machineId: 'M'.repeat(32), deviceId: 'D'.repeat(32) },
  )
  assert.equal(stored.machine_id, 'S'.repeat(32))
  assert.equal(stored.device_id, 'T'.repeat(32))
})

test('过期判定：解析不出过期时间时不判过期', () => {
  // 不透明 token（非 JWT）+ 没有 expires_at：不能判死，最多多试一次由 401 定论。
  assert.equal(isTraeExpired({ access_token: 'opaque', refresh_token: '', uid: 'u', machine_id: '', device_id: '' }), false)

  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString('base64url')
  const jwt = `h.${payload}.s`
  assert.equal(jwtExpiresAtMs(jwt), 1_700_000_000_000)
  assert.equal(jwtExpiresAtMs('not-a-jwt'), undefined)
  assert.equal(jwtExpiresAtMs('a.b'), undefined, '载荷不是 JSON 时返回 undefined')

  // 秒 / 毫秒 / ISO 三种 expires_at 形态。
  const base = { access_token: jwt, refresh_token: '', uid: 'u', machine_id: '', device_id: '' }
  assert.equal(isTraeExpired({ ...base, expires_at: '1700000000' }, 1_800_000_000_000), true)
  assert.equal(isTraeExpired({ ...base, expires_at: '1700000000000' }, 1_800_000_000_000), true)
  assert.equal(isTraeExpired({ ...base, expires_at: '2099-01-01T00:00:00Z' }, 1_800_000_000_000), false)
})

test('ExchangeToken / GetUserInfo 响应解析', () => {
  // [出处] trae.ts:433-435 与 :473-476 的上游形状。
  const ex = parseTraeExchangeResponse({
    Result: { Token: 'newtok', RefreshToken: 'newrt', TokenExpireAt: 1_800_000_000, TokenExpireDuration: 3600 },
  })
  assert.equal(ex.accessToken, 'newtok')
  assert.equal(ex.refreshToken, 'newrt')
  assert.equal(ex.tokenExpireAt, 1_800_000_000)
  assert.equal(parseTraeExchangeResponse({ Result: { RefreshToken: 'x' } }), undefined)
  assert.equal(parseTraeExchangeResponse({}), undefined)

  // [出处] trae.ts:477-492：字段名是 NonPlainTextMobile / NonPlainTextEmail。
  const info = parseTraeUserInfoResponse({
    Result: { UserID: '26815487395', ScreenName: '用户26815487395', NonPlainTextMobile: '130******00', EnterpriseID: 'e1' },
  })
  assert.equal(info.uid, '26815487395')
  assert.equal(info.phone, '130******00')
  assert.equal(info.enterpriseId, 'e1')
  assert.equal(parseTraeUserInfoResponse({ Result: {} }), undefined)
})

// ═══════════════════════ 十、适配器接线 ═══════════════════════

test('适配器：能力声明如实（含「请手工粘贴 token」）', () => {
  const adapter = new TraeAdapter()
  assert.equal(adapter.id, 'trae')
  assert.equal(adapter.implemented, true)
  assert.equal(adapter.capabilities.checkIn, true)
  assert.equal(adapter.capabilities.quota, true)
  assert.equal(adapter.capabilities.models, true)
  assert.equal(adapter.capabilities.chat, true)
  assert.equal(adapter.capabilities.reasoning, true)
  // 上游没有独立的活动任务体系 —— 不编一个出来。
  assert.equal(adapter.capabilities.tasks, false)
  assert.equal(adapter.capabilities.source, 'static')

  // ★ 如实声明没有登录流程（不假装有登录）。
  const loginNote = adapter.capabilities.notes.login
  assert.ok(loginNote !== undefined)
  assert.match(loginNote, /手工|粘贴/, '必须写明「请手工粘贴 token」')
  assert.ok(adapter.capabilities.notes.credentials !== undefined)
})

test('适配器：没有 token 时模型目录为空（不列出调不动的模型）', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx()
  const models = await adapter.getModelMetaList(account({}), ctx)
  assert.deepEqual(models, [])
  assert.equal(ctx.calls.length, 0, '没有 token 时一次上游请求都不该发')
})

test('适配器：远端目录失败时退回兜底目录（不带倍率）', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      return { ok: false, status: 500, kind: 'server', headers: new Headers(), body: undefined, text: 'boom' }
    },
  })
  const models = await adapter.getModelMetaList(account(), ctx)
  assert.ok(models.length > 0, '远端失败要退回兜底目录')
  // 兜底表没有倍率信息 → 留空（UI 显示「未知倍率」），不编一个。
  assert.equal(models.every((m) => m.multiplier === undefined), true)
  assert.equal(models.every((m) => m.free === undefined), true)
  const fallbackHidden = TRAE_FALLBACK_MODELS.filter((m) => m.isHidden === true).map((m) => m.id)
  assert.ok(fallbackHidden.length > 0)
  for (const id of fallbackHidden) {
    assert.equal(models.some((m) => m.id === id), false, `${id} 是隐藏条目，不该出现`)
  }
})

test('适配器：模型目录走 batch 端点，倍率与图片能力逐条带上', async () => {
  const adapter = new TraeAdapter()
  let batchCalls = 0
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        batchCalls += 1
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: batchFixture(), text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const models = await adapter.getModelMetaList(account(), ctx)
  assert.equal(batchCalls, 1)

  const glm = models.find((m) => m.id === 'glm-5.2')
  assert.ok(glm !== undefined)
  assert.equal(glm.agentId, 'trae')
  assert.equal(glm.multiplier, 0.08)
  assert.equal(glm.multiplierSource, 'trae:consumption_rate')
  assert.deepEqual(glm.inputModalities, ['text', 'image'], 'multimodal=true 要声明 image')
  assert.equal(glm.reasoning, true)
  assert.equal(glm.contextWindow, 200000)
  assert.equal(glm.maxTokens, 32000)

  // is_custom_model=true 的条目不能出现在界面上（它必然调不通）。
  assert.equal(models.some((m) => m.id === 'custom_model_gemini'), false)

  // 目录有缓存：第二次调用不再打上游。
  await adapter.getModelMetaList(account(), ctx)
  assert.equal(batchCalls, 1, '第二次应命中缓存')
})

test('适配器：签到——已签到如实报今天已领，而不是虚假成功', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('checkin_credits/status')) {
        // [出处] trae-credits.ts:19-21
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { checked_in: true, credits: 150, enable: true }, text: '' }
      }
      throw new Error(`不该请求 ${url}`)
    },
  })
  const result = await adapter.checkIn(account(), ctx)
  assert.equal(result.ok, true)
  assert.equal(result.supported, true)
  assert.equal(result.credits, 0, '已签到就该报 0，而不是编一个 +150')
  assert.match(result.message, /已经签到/, '要说清是「已签到」而不是「签到成功」')
  // 已签到时**不该**再打 claim（避免无谓的写操作）。
  assert.equal(ctx.calls.some((c) => c.url.includes('/claim')), false,
    '今天已签到就不该再发 claim 请求')
})

test('适配器：签到成功——领取后补查状态拿真实积分数', async () => {
  const adapter = new TraeAdapter()
  let statusCalls = 0
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('checkin_credits/status')) {
        statusCalls += 1
        const body = statusCalls === 1
          ? { checked_in: false, credits: 150, enable: true }
          : { checked_in: true, credits: 150, enable: true }
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body, text: '' }
      }
      if (url.includes('checkin_credits/claim')) {
        // [出处] trae-credits.ts:281-283：claim 的完整响应就是 {"code":0,"message":"success"}
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { code: 0, message: 'success' }, text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const result = await adapter.checkIn(account(), ctx)
  assert.equal(result.ok, true)
  assert.equal(result.credits, 150, '必须从 status 端点补查（claim 响应里没有积分数）')
  assert.match(result.message, /150/)
  assert.equal(statusCalls, 2, '领取后要补查一次状态')
})

test('适配器：签到命中 9074——轮换设备号 + 归类 rate_limit（不判死）', async () => {
  const adapter = new TraeAdapter()
  const deviceIds = []
  const ctx = makeCtx({
    route: (url, init) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('checkin_credits/status')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { checked_in: false, credits: 150, enable: true }, text: '' }
      }
      if (url.includes('checkin_credits/claim')) {
        deviceIds.push(init.headers['X-Device-Id'])
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { code: 9074, message: '签到人数过多' }, text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const record = account()

  const first = await adapter.checkIn(record, ctx)
  assert.equal(first.ok, false)
  assert.equal(first.supported, true)
  assert.equal(first.kind, 'rate_limit', '9074 归类限流（可换号），不是 unknown')
  assert.match(first.message, /签到人数过多/)
  assert.match(first.message, /轮换/)

  // ★ 第二次必须用一个**新的设备号** —— 这就是「轮换不是空动作」的证据。
  const second = await adapter.checkIn(record, ctx)
  assert.equal(second.ok, false)
  assert.equal(deviceIds.length, 2)
  assert.notEqual(deviceIds[0], deviceIds[1], '命中 9074 后必须换一个签到设备号')
  assert.match(deviceIds[0], /^\d{15}$/)
  assert.match(deviceIds[1], /^\d{15}$/)
})

test('适配器：签到——缺少 uid 时明确报错，不发必然被拒的请求', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        // 上游也补不到 uid（例如 token 不是 Trae 的）。
        return { ok: false, status: 401, kind: 'auth', headers: new Headers(), body: undefined, text: 'unauthorized' }
      }
      throw new Error(`不该请求 ${url}`)
    },
  })
  const result = await adapter.checkIn(account({ token: 'bad', uid: '' }), ctx)
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'auth')
  assert.match(result.message, /uid/)
  assert.equal(ctx.calls.some((c) => c.url.includes('/claim')), false, '不能发必然失败的 claim')
})

test('适配器：签到——上游没有签到活动时如实说，不报故障', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('checkin_credits/status')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { checked_in: false, credits: 0, enable: false }, text: '' }
      }
      throw new Error(`不该请求 ${url}`)
    },
  })
  const result = await adapter.checkIn(account(), ctx)
  assert.equal(result.ok, false)
  assert.equal(result.supported, true, '有签到接口，只是这个账号没活动')
  assert.match(result.message, /没有开启签到活动/)
  assert.match(result.message, /不是故障/, '要说清这不是故障')
})

test('适配器：额度——多包求和，原始包留在 extra 里', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url, init) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('ide_user_ent_usage')) {
        // [出处] trae-credits.ts:314：body 必须含 require_usage:true。
        assert.deepEqual(JSON.parse(init.body), { require_usage: true, req_source: 2 })
        return {
          ok: true, status: 200, kind: 'none', headers: new Headers(), text: '',
          body: {
            user_entitlement_pack_list: [
              { entitlement_base_info: { display_desc: '每月登录赠送', quota: { credits_limit: 500 } }, usage: { credits_amount: 120 } },
              { entitlement_base_info: { display_desc: '签到奖励', quota: { credits_limit: 150 } }, usage: { credits_amount: 0 } },
            ],
          },
        }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  const quota = await adapter.getQuota(account(), ctx)
  assert.equal(quota.unit, 'credits')
  assert.equal(quota.remaining, 530)
  assert.equal(quota.total, 650)
  assert.equal(quota.used, 120)
  assert.equal(quota.error, undefined)
  assert.equal(Array.isArray(quota.extra.packages), true)
  assert.equal(quota.extra.packages.length, 2)
})

test('适配器：额度——没有令牌时给出可操作的说明', async () => {
  const adapter = new TraeAdapter()
  const quota = await adapter.getQuota(account({}), makeCtx())
  assert.equal(quota.unit, 'credits')
  assert.equal(quota.remaining, undefined, '拿不到就是 undefined，不是 0')
  assert.match(quota.error, /token/)
})

test('适配器：对话——空响应如实报可重试，而不是回复为空', async () => {
  // [出处] trae-adapter.ts:1330-1340 + 1591-1604。
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { function_configs: [] }, text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
    fetchImpl: async () => sseResponse([], {}),
  })
  const events = []
  for await (const ev of adapter.requestChatStream({ model: 'glm-5.2', messages: [] }, account(), ctx, new AbortController().signal)) {
    events.push(ev)
  }
  const err = events.find((e) => e.type === 'error')
  assert.ok(err !== undefined, '空响应必须报错，不能静默结束')
  assert.equal(err.failure.kind, 'network', '归 network（可重试）')
  assert.match(err.failure.message, /没有下发任何事件|可重试/)
})

test('适配器：对话——流内错误透出，且已流出的正文不被吞掉', async () => {
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { function_configs: [] }, text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
    // 上游确实用 HTTP 200 + 流内错误下发额度错误。
    fetchImpl: async () => sseResponse([
      'event:output', 'data:{"response":"起头"}', '',
      'event:error', 'data:{"code":4008,"message":"quota exceeded"}', '',
    ], {}),
  })
  const events = []
  for await (const ev of adapter.requestChatStream({ model: 'glm-5.2', messages: [] }, account(), ctx, new AbortController().signal)) {
    events.push(ev)
  }
  // 正文照常透出（不能因为后面出错就把已流出的字吞掉）。
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), '起头')
  const err = events.find((e) => e.type === 'error')
  assert.ok(err !== undefined)
  assert.equal(err.failure.kind, 'quota')
})

test('适配器：对话——请求体经 SOLO 转换，通道来自目录', async () => {
  const adapter = new TraeAdapter()
  let sentBody
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '1234567890' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: batchFixture(), text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body)
      return sseResponse(['event:output', 'data:{"response":"ok"}', '', 'event:done', 'data:{"finish_reason":"stop"}', ''], {})
    },
  })
  for await (const _ of adapter.requestChatStream(
    { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], stream: true },
    account(),
    ctx,
    new AbortController().signal,
  )) { /* 消费掉 */ }

  assert.ok(sentBody !== undefined)
  assert.equal(sentBody.config_name, 'glm-5.2')
  assert.equal(sentBody.model, 'glm-5.2')
  assert.equal(sentBody.stream, true)
  // ★ 通道来自目录里那条（solo_agent），不是写死的默认值。
  assert.equal(sentBody.function, 'solo_agent')
  assert.deepEqual(sentBody.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

test('适配器：detectError 认 TRAE 业务码（HTTP 200 里的额度错误）', () => {
  const adapter = new TraeAdapter()
  assert.equal(adapter.detectError(200, { code: 4008 }, new Headers()), 'quota')
  assert.equal(adapter.detectError(200, { code: 1005, message: 'plan' }, new Headers()), 'quota')
  assert.equal(adapter.detectError(401, 'token 失效', new Headers()), 'auth')
  assert.equal(adapter.detectError(404, '', new Headers()), 'not_found')
})

test('适配器：validateCredentials 用 GetUserInfo 真的验一次', async () => {
  const adapter = new TraeAdapter()
  const okCtx = makeCtx({
    route: () => ({
      ok: true, status: 200, kind: 'none', headers: new Headers(), text: '',
      body: { Result: { UserID: '1234567890', ScreenName: '用户1', NonPlainTextMobile: '130******00' } },
    }),
  })
  const good = await adapter.validateCredentials(account(), okCtx)
  assert.equal(good.ok, true)
  assert.match(good.message, /130\*\*\*\*\*00|凭证可用/)

  // 没有 token → 不请求上游。
  const emptyCtx = makeCtx()
  const missing = await adapter.validateCredentials(account({}), emptyCtx)
  assert.equal(missing.ok, false)
  assert.equal(emptyCtx.calls.length, 0)

  // 上游拒绝。
  const badCtx = makeCtx({
    route: () => ({ ok: false, status: 401, kind: 'auth', headers: new Headers(), body: undefined, text: 'unauthorized' }),
  })
  const bad = await adapter.validateCredentials(account(), badCtx)
  assert.equal(bad.ok, false)
  assert.equal(bad.kind, 'auth')
})

test('适配器：补齐的 uid 会回写（签到设备身份依赖它）', async () => {
  const adapter = new TraeAdapter()
  const patches = []
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: { Result: { UserID: '999', NonPlainTextMobile: '131******11' } }, text: '' }
      }
      if (url.includes('batch_get_detail_param')) {
        return { ok: true, status: 200, kind: 'none', headers: new Headers(), body: batchFixture(), text: '' }
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  ctx.onCredentialsRefreshed = (accountId, patch) => { patches.push({ accountId, patch }) }

  const record = account({ token: 'tok' }) // 没有 uid
  await adapter.getModelMetaList(record, ctx)
  assert.equal(patches.length, 1)
  assert.equal(patches[0].patch.uid, '999')
  assert.equal(patches[0].patch.phone, '131******11')
  assert.equal(patches[0].accountId, record.id)
})

test('适配器：getCredentials 带上派生出来的设备指纹', async () => {
  const adapter = new TraeAdapter()
  const credentials = await adapter.getCredentials(account({ token: 'tok' }))
  assert.equal(credentials.token, 'tok')
  assert.equal(credentials.machine_id, deriveMachineId('trae:a1'))
  assert.equal(credentials.device_id, deriveDeviceId('trae:a1'))
})

// ═══════════════════════ 十一、约束检查 ═══════════════════════

test('凭据不会出现在日志里（硬规则：任何日志不许出现完整凭证）', async () => {
  const SECRET = 'SUPER-SECRET-TOKEN-abcdef123456'
  const seen = []
  const loudLog = {
    debug(...args) { seen.push(args.join(' ')) },
    info(...args) { seen.push(args.join(' ')) },
    warn(...args) { seen.push(args.join(' ')) },
    error(...args) { seen.push(args.join(' ')) },
    child() { return loudLog },
  }
  const adapter = new TraeAdapter()
  const ctx = makeCtx({
    route: (url) => {
      if (url.includes('GetUserInfo')) {
        return { ok: false, status: 401, kind: 'auth', headers: new Headers(), body: undefined, text: 'unauthorized' }
      }
      return { ok: false, status: 500, kind: 'server', headers: new Headers(), body: undefined, text: 'boom' }
    },
  })
  ctx.log = loudLog
  await adapter.checkIn(account({ token: SECRET, uid: '' }), ctx)
  assert.equal(seen.some((line) => line.includes(SECRET)), false, '日志里出现了完整 token')
})
