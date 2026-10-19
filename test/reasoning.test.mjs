/**
 * 思考档位翻译（`src/core/reasoning.ts`）的单测。
 *
 * 移植自参考实现 `dsh-our-free-model` 的 `reasoning-ladder.ts`。这里逐条盯住
 * **每条规则**，因为它们的失败方式全都一样：**静默**。翻错了不会抛错，只会让
 * 上游回一个 400（整轮对话不可用），或者更糟 —— 用户选了「低」，拿到「关闭」，
 * 界面上一片正常。
 *
 * 所以本文件不是「覆盖率作业」，而是把参考实现注释里那几条理由钉成断言：
 *   1. 精确命中优先（私有 id 原样通过）
 *   2. 同族就近
 *   3. **关闭族与思考族不互译**（要「少想一点」绝不能得到「完全不想」）
 *   4. **同距取更强**（宁可多思考，不可静默关掉）
 *   5. 未登记的私有 id **不参与**就近匹配
 *   6. 反查自洽（反查结果能正译回原 id）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REASONING_EFFORT_RANK,
  CANONICAL_REASONING_EFFORTS,
  isKnownReasoningEffort,
  isThinkingOffEffort,
  reasoningRankOf,
  reasoningEffortName,
  translateReasoningEffort,
  canonicalReasoningEffortFor,
  reasoningEffortsForDeclared,
  defaultReasoningEffortFor,
} from '../lib/core/reasoning.js'

// ───────────────────────── 强度序 ─────────────────────────

test('强度序：登记了各家私有 id，且 off/none 同为 0', () => {
  // 各 provider 的真实 wire 值都必须登记，否则它们会被当成「拼写错误」报 unknown。
  for (const id of ['off', 'none', 'minimal', 'light', 'low', 'medium', 'high', 'on', 'extra_high', 'xhigh', 'max', 'ultra']) {
    assert.equal(typeof reasoningRankOf(id), 'number', `${id} 应该登记在强度序里`)
  }
  // 「关闭」族的两个名字都是 0。
  assert.equal(reasoningRankOf('off'), 0)
  assert.equal(reasoningRankOf('none'), 0)
  // 「开启思考」没有强度语义 —— 与 high 同序（这样它反查成 high）。
  assert.equal(reasoningRankOf('on'), reasoningRankOf('high'))
})

test('强度序：整体单调，且 extra_high 介于 high 与 xhigh 之间', () => {
  const order = ['off', 'minimal', 'light', 'low', 'medium', 'high', 'extra_high', 'xhigh', 'max', 'ultra']
  for (let i = 1; i < order.length; i += 1) {
    const prev = reasoningRankOf(order[i - 1])
    const cur = reasoningRankOf(order[i])
    assert.ok(cur > prev, `${order[i]}(${cur}) 应强于 ${order[i - 1]}(${prev})`)
  }
})

test('规范档位就是 OpenAI 协议侧那 8 个，顺序由弱到强', () => {
  assert.deepEqual([...CANONICAL_REASONING_EFFORTS], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  for (let i = 1; i < CANONICAL_REASONING_EFFORTS.length; i += 1) {
    assert.ok(
      reasoningRankOf(CANONICAL_REASONING_EFFORTS[i]) > reasoningRankOf(CANONICAL_REASONING_EFFORTS[i - 1]),
      '规范名必须严格递增',
    )
  }
})

test('辅助判据：isKnownReasoningEffort / isThinkingOffEffort', () => {
  assert.equal(isKnownReasoningEffort('light'), true)
  assert.equal(isKnownReasoningEffort('banana'), false)
  assert.equal(isThinkingOffEffort('off'), true)
  assert.equal(isThinkingOffEffort('none'), true)
  assert.equal(isThinkingOffEffort('low'), false)
  // 原型链上的键不能被当成登记过的档位（防 `constructor` / `toString` 之类）。
  assert.equal(isKnownReasoningEffort('constructor'), false)
  assert.equal(isKnownReasoningEffort('toString'), false)
  assert.equal(reasoningRankOf('constructor'), undefined)
})

test('档位展示名：有中文给中文，没有就回退 id 本身（不猜译名）', () => {
  assert.equal(reasoningEffortName('high'), '高')
  assert.equal(reasoningEffortName('none'), '关闭思考')
  // 未登记 → 回退 id，而不是编一个错译。
  assert.equal(reasoningEffortName('banana'), 'banana')
})

// ───────────────────────── 规则 1：精确命中 ─────────────────────────

test('规则1 精确命中：模型声明过就原样下发，不做任何翻译', () => {
  const cases = [
    ['medium', ['low', 'medium', 'high']],
    ['none', ['none', 'low', 'high']],
    ['xhigh', ['low', 'xhigh']],
  ]
  for (const [requested, declared] of cases) {
    assert.deepEqual(translateReasoningEffort(requested, declared), { kind: 'exact', effort: requested })
  }
})

test('规则1 精确命中优先于就近：私有 id 不要求它出现在强度序里', () => {
  // 上游新冒出来的私有档位，我们**不认识**它的强度 —— 但模型自己声明了它，
  // 说明它是合法 wire 值，必须原样通过（不能因为「强度序里没有」就报 unknown）。
  const declared = ['magic_mode', 'medium']
  assert.deepEqual(translateReasoningEffort('magic_mode', declared), { kind: 'exact', effort: 'magic_mode' })
})

// ───────────────────────── 规则 2：同族就近 ─────────────────────────

test('规则2 同族就近：TRAE 的 light ↔ OpenAI 的 low/minimal', () => {
  // TRAE 只声明 light/high/extra_high。客户端说 low 或 minimal，都该落到 light。
  const trae = ['light', 'high', 'extra_high']
  assert.deepEqual(translateReasoningEffort('low', trae), { kind: 'mapped', effort: 'light', requested: 'low', rank: 3 })
  // minimal(1) → light(2) 距离 1；high(5) 距离 4 ⇒ 取 light。
  assert.deepEqual(translateReasoningEffort('minimal', trae), { kind: 'mapped', effort: 'light', requested: 'minimal', rank: 1 })
})

test('规则2 同族就近：`max` 撞 `xhigh` 这类「撞车」被翻译掉，不会 400', () => {
  // 这是本模块存在的**根本理由**：客户端只有 8 个规范名，而上游的写法不同名。
  // Cline 声明 none/low/medium/high/max —— 客户端说 xhigh，要落到 max。
  const cline = ['none', 'low', 'medium', 'high', 'max']
  assert.deepEqual(translateReasoningEffort('xhigh', cline), { kind: 'mapped', effort: 'max', requested: 'xhigh', rank: 7 })
  // LobsterAI 声明 off/high/xhigh —— 客户端说 max，要落到 xhigh。
  const lobster = ['off', 'high', 'xhigh']
  assert.deepEqual(translateReasoningEffort('max', lobster), { kind: 'mapped', effort: 'xhigh', requested: 'max', rank: 8 })
  // 客户端说 ultra，LobsterAI 最强只有 xhigh ⇒ 落到 xhigh（就近到底，不报错）。
  assert.deepEqual(translateReasoningEffort('ultra', lobster), { kind: 'mapped', effort: 'xhigh', requested: 'ultra', rank: 9 })
})

test('规则2 off 与 none 属于同一族，可以互译', () => {
  // 「关闭族不互译」指的是**不与思考族互译**；族内 off↔none 是同一个意思。
  assert.deepEqual(translateReasoningEffort('off', ['none', 'low']), { kind: 'mapped', effort: 'none', requested: 'off', rank: 0 })
  assert.deepEqual(translateReasoningEffort('none', ['off', 'high']), { kind: 'mapped', effort: 'off', requested: 'none', rank: 0 })
})

// ───────────────────────── 规则 3：关闭族不互译 ─────────────────────────

test('规则3 关闭族不互译：给只声明 high 的模型要 none → unexpressible（不下发，不是就近顶替）', () => {
  // ★ 这是「要少想一点，绝不能得到完全不想」的落点。
  // 若这里返回 mapped→high，用户会得到**完全相反**的语义，而且界面上看不出来。
  const trae = ['light', 'high', 'extra_high']
  assert.deepEqual(translateReasoningEffort('none', trae), { kind: 'unexpressible' })
  assert.deepEqual(translateReasoningEffort('off', trae), { kind: 'unexpressible' })
})

test('规则3 反向同样不互译：给只有 off 的模型要 high → unexpressible', () => {
  // Raccoon 这类只有 on/off 的模型，若只声明了 off，要 high 不能顶替成 off ——
  // 那等于把用户的「高强度思考」静默关成「完全不想」。
  assert.deepEqual(translateReasoningEffort('high', ['off']), { kind: 'unexpressible' })
  assert.deepEqual(translateReasoningEffort('medium', ['none']), { kind: 'unexpressible' })
})

test('规则3 关闭族不互译：单档模型两个方向都不越族', () => {
  // 只有 medium 的模型：两边都不可表达，且**绝不能**互相顶替。
  for (const requested of ['none', 'off']) {
    assert.deepEqual(translateReasoningEffort(requested, ['medium']), { kind: 'unexpressible' }, `${requested} 不该落到 medium`)
  }
  assert.deepEqual(translateReasoningEffort('high', ['none']), { kind: 'unexpressible' })
})

// ───────────────────────── 规则 4：同距取更强 ─────────────────────────

test('规则4 同距取更强：medium 在 low(3)/high(5) 之间等距 → 取 high', () => {
  // ★ 依据是参考实现里 Raccoon 那处注释：「未知档位一律按开启处理 ——
  // 宁可多思考，不可静默关掉，用户看不到思考内容会以为模型坏了」。
  // 反过来（同距取弱）会在只有一个中间档的模型上把用户主动选的强度悄悄降一档。
  assert.deepEqual(translateReasoningEffort('medium', ['low', 'high']), {
    kind: 'mapped',
    effort: 'high',
    requested: 'medium',
    rank: 4,
  })
})

test('规则4 同距取更强：不对称的等距也要取更强的一侧', () => {
  // low(3) 到 minimal(1) 与 high(5) 都是距离 2 ⇒ 取 high。
  assert.deepEqual(translateReasoningEffort('low', ['minimal', 'high']), {
    kind: 'mapped',
    effort: 'high',
    requested: 'low',
    rank: 3,
  })
  // 结论与 declared 的**书写顺序无关**（不能靠「先到先得」定胜负）。
  assert.deepEqual(translateReasoningEffort('low', ['high', 'minimal']), {
    kind: 'mapped',
    effort: 'high',
    requested: 'low',
    rank: 3,
  })
})

test('规则4 非等距时正常就近，不被「取更强」影响', () => {
  // medium(4)：low(3) 距离 1 比 high(5) 距离 1 是等距（上一条测了）；
  // 这里换成距离不同的组合，必须严格就近。
  assert.deepEqual(translateReasoningEffort('medium', ['low', 'ultra']), {
    kind: 'mapped',
    effort: 'low',
    requested: 'medium',
    rank: 4,
  })
})

// ───────────────────────── 规则 5：未登记 id 不参与匹配 ─────────────────────────

test('规则5 未登记的私有 id 不参与就近匹配（不知道强度就不猜）', () => {
  // declared 里有 `banana`（未登记）。它是**距离最近**的候选吗？我们不知道 ——
  // 所以它必须被完全忽略，落到真正登记过的 `high` 上。
  const declared = ['banana', 'high']
  assert.deepEqual(translateReasoningEffort('low', declared), {
    kind: 'mapped',
    effort: 'high',
    requested: 'low',
    rank: 3,
  })
})

test('规则5 声明里只有未登记 id 时 → unexpressible（而不是随便挑一个）', () => {
  assert.deepEqual(translateReasoningEffort('medium', ['banana', 'kiwi']), { kind: 'unexpressible' })
})

test('规则5 请求的档位不认识 → unknown（调用方应报错，不是静默丢弃）', () => {
  assert.deepEqual(translateReasoningEffort('banana', ['low', 'medium', 'high']), { kind: 'unknown' })
  // 空声明 + 不认识的请求 ⇒ unknown 优先于 unexpressible：
  // 「连名字都不认识」是调用方的 bug，「模型没这族」是能力限制，两者要分开报。
  assert.deepEqual(translateReasoningEffort('banana', []), { kind: 'unknown' })
})

test('边界：空声明 + 认识的档位 → unexpressible', () => {
  assert.deepEqual(translateReasoningEffort('medium', []), { kind: 'unexpressible' })
})

// ───────────────────────── 规则 6：反查自洽 ─────────────────────────

test('规则6 反查：规范名原样返回自己', () => {
  for (const canonical of CANONICAL_REASONING_EFFORTS) {
    assert.equal(canonicalReasoningEffortFor(canonical), canonical)
  }
})

test('规则6 反查：私有 id 落到最近（同距取更强）的规范名', () => {
  // light(2) → minimal(1)/low(3) 等距 ⇒ 取更强的 low。
  assert.equal(canonicalReasoningEffortFor('light'), 'low')
  // extra_high(6) → high(5)/xhigh(7) 等距 ⇒ 取更强的 xhigh。
  assert.equal(canonicalReasoningEffortFor('extra_high'), 'xhigh')
  // on(5) → 与 high 同序 ⇒ high。
  assert.equal(canonicalReasoningEffortFor('on'), 'high')
  // off(0) 与 none(0) 同序 ⇒ none（族内）。
  assert.equal(canonicalReasoningEffortFor('off'), 'none')
})

test('规则6 反查：未登记的 id 返回 undefined（「该填什么」我们不知道，不能编）', () => {
  assert.equal(canonicalReasoningEffortFor('banana'), undefined)
  assert.equal(canonicalReasoningEffortFor(''), undefined)
})

test('规则6 ★ 反查自洽：反查结果正译回原 id，不产生任何降级', () => {
  // 这条是「客户端填这组值不会有降级」的机器化证明。
  const privateIds = ['light', 'on', 'extra_high', 'off', 'xhigh', 'max', 'ultra', 'none', 'minimal', 'low', 'medium', 'high']
  for (const id of privateIds) {
    const canonical = canonicalReasoningEffortFor(id)
    assert.notEqual(canonical, undefined, `${id} 应该能反查`)
    const back = translateReasoningEffort(canonical, [id])
    assert.ok(
      back.kind === 'exact' || (back.kind === 'mapped' && back.effort === id),
      `${id} → 反查 ${canonical} → 正译应回到 ${id}，实得 ${JSON.stringify(back)}`,
    )
  }
})

test('规则6 反查在整张声明表上自洽（模拟真实模型目录）', () => {
  const catalogs = [
    ['none', 'low', 'medium', 'high', 'xhigh'], // gpt-5.4 实测形状
    ['minimal', 'low', 'medium', 'high'], // gpt-5-nano 实测形状
    ['low', 'medium', 'high', 'xhigh', 'max'], // claude-opus 实测形状
    ['light', 'high', 'extra_high'], // TRAE
    ['off', 'high', 'xhigh'], // LobsterAI
    ['none', 'low', 'medium', 'high', 'max'], // Cline
  ]
  for (const declared of catalogs) {
    for (const id of declared) {
      const canonical = canonicalReasoningEffortFor(id)
      assert.notEqual(canonical, undefined, `${declared.join('/')} 里的 ${id} 应能反查`)
      // 反查出来的规范名，正译回这张表必须命中同一档（exact 或 mapped 到原 id）。
      const back = translateReasoningEffort(canonical, declared)
      assert.ok(
        back.kind === 'exact' || back.kind === 'mapped',
        `${id} → ${canonical} → 在 [${declared.join(',')}] 上应可表达，实得 ${JSON.stringify(back)}`,
      )
      assert.equal(back.effort, id, `${id} → ${canonical} → 应回到 ${id}，实得 ${back.effort}`)
    }
  }
})

// ───────────────────────── 选择器档位表 ─────────────────────────

test('选择器档位表：只出模型真有的档位，且按弱→强排序', () => {
  // 原先是写死的 off/low/medium/high —— 用户选了上游不认的值就是 400。
  assert.deepEqual(reasoningEffortsForDeclared(['none', 'low', 'medium', 'high', 'xhigh']), [
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  // 书写顺序被打乱也要按强度序输出（UI 排列必须稳定）。
  assert.deepEqual(reasoningEffortsForDeclared(['high', 'none', 'low']), ['none', 'low', 'high'])
})

test('选择器档位表：私有 id 归一化，不会泄漏到选择器里', () => {
  // ⚠️ 关键：`light` / `extra_high` **不能**出现在选项里。用户选了 `light`，
  // DSH 会原样回传，而它只在**这一个模型**上合法，换个模型就是 400。
  const out = reasoningEffortsForDeclared(['light', 'high', 'extra_high'])
  assert.ok(!out.includes('light'), 'light 不该泄漏到选择器')
  assert.ok(!out.includes('extra_high'), 'extra_high 不该泄漏到选择器')
  for (const id of out) assert.ok(CANONICAL_REASONING_EFFORTS.includes(id), `${id} 必须是规范名`)
  // light→low、extra_high→xhigh，high 原样。
  assert.deepEqual(out, ['low', 'high', 'xhigh'])
})

test('选择器档位表：两个私有 id 撞到同一规范名时只留一个', () => {
  // light(2)→low(3) 与 minimal(1)→? 这里用确定会撞的组合：off 与 none 都→none。
  assert.deepEqual(reasoningEffortsForDeclared(['off', 'none']), ['none'])
})

test('选择器档位表：未登记 / 空表 → 空数组（= 不声明，UI 不出档位行）', () => {
  assert.deepEqual(reasoningEffortsForDeclared([]), [])
  assert.deepEqual(reasoningEffortsForDeclared(['banana', 'kiwi']), [])
  // 混着来：认识的留着，不认识的丢掉。
  assert.deepEqual(reasoningEffortsForDeclared(['banana', 'high']), ['high'])
})

test('默认档位：优先 medium，没有就取中位', () => {
  assert.equal(defaultReasoningEffortFor(['low', 'medium', 'high']), 'medium')
  // 没有 medium ⇒ 取已归一化档位的中位（不是「第一个」—— 声明顺序无任何承诺）。
  assert.equal(defaultReasoningEffortFor(['minimal', 'low', 'high', 'xhigh']), 'low')
  assert.equal(defaultReasoningEffortFor(['low', 'high']), 'low')
  // 空 ⇒ undefined（调用方不下发 defaultEffort）。
  assert.equal(defaultReasoningEffortFor([]), undefined)
  assert.equal(defaultReasoningEffortFor(['banana']), undefined)
})

test('默认档位不能是「关闭」以外的乱档，且必须真能下发', () => {
  // 挑出来的默认档必须能被正译回这张表 —— 否则选择器一开就是 400。
  const catalogs = [
    ['none', 'low', 'medium', 'high', 'xhigh'],
    ['minimal', 'low', 'medium', 'high'],
    ['light', 'high', 'extra_high'],
    ['off', 'high', 'xhigh'],
  ]
  for (const declared of catalogs) {
    const fallback = defaultReasoningEffortFor(declared)
    assert.notEqual(fallback, undefined)
    const back = translateReasoningEffort(fallback, declared)
    assert.ok(back.kind === 'exact' || back.kind === 'mapped', `${fallback} 在 [${declared}] 上应可表达`)
  }
})

// ───────────────────── 上游声明的默认档优先于启发式 ─────────────────────

/**
 * 真实缺陷（2026-10-19 实测）：Qoder 兜底目录逐条抄了官方客户端的
 * `thinking_config.enabled.efforts.<key>.is_default`，但适配器**没把它报上来**，
 * 于是核心层的启发式接管 —— `dfmodel` 上游声明 `max`，启发式挑 `low`。
 *
 * 后果：同一个模型在插件里「想得更少」，而用户完全看不出差别在哪。
 * 所以规则是「**上游声明过就用它**」，启发式只在没声明时兜底。
 */
test('上游声明的默认档优先于启发式', () => {
  const declared = ['high', 'max', 'low', 'none']
  // 没有声明时的启发式：没有 medium，取中间 → low（这就是那个 bug 的现象）。
  assert.equal(defaultReasoningEffortFor(declared), 'low')
  // 上游声明 max → 必须用 max，不能被启发式覆盖。
  assert.equal(defaultReasoningEffortFor(declared, 'max'), 'max')
  // 上游声明 low → 用 low。
  assert.equal(defaultReasoningEffortFor(declared, 'low'), 'low')
})

test('上游声明的默认档若不可表达，安全退回启发式（不是报错）', () => {
  const declared = ['high', 'max', 'low', 'none']
  // 拼写错误 / 未登记的私有 id → 退回启发式，而不是下发一个上游不认的值。
  assert.equal(defaultReasoningEffortFor(declared, 'banana'), 'low')
  assert.equal(defaultReasoningEffortFor(declared, 'light'), 'low')
  // 空串按「没声明」处理。
  assert.equal(defaultReasoningEffortFor(declared, ''), 'low')
  assert.equal(defaultReasoningEffortFor(declared, undefined), 'low')
  // 声明了「关闭族」，而模型只有思考族 → 反查得到规范名但不在集合里 → 退回启发式。
  assert.equal(defaultReasoningEffortFor(['high', 'max'], 'none'), 'high')
})

test('声明的默认档必须落在该模型自己的档位集合里', () => {
  // 各平台真实形状：声明值可能用私有 id 写，反查后要落回集合。
  // ⚠️ `xhigh` **本身就是规范名**（在 CANONICAL_REASONING_EFFORTS 里），
  // 所以它反查成自己、且正好在集合里 → 原样采用（这一条我曾经写错过：
  // 以为它会反查成 `max`）。
  assert.equal(defaultReasoningEffortFor(['xhigh', 'low', 'medium'], 'xhigh'), 'xhigh')
  // 私有 id `light` 反查成 `low`，落回集合 → 采用 `low`（Trae 的真实形状）。
  assert.equal(defaultReasoningEffortFor(['light', 'high', 'extra_high'], 'light'), 'low')
  // 私有 id `extra_high` 反查成 `xhigh`，也落在同一集合里 → 采用 `xhigh`。
  assert.equal(defaultReasoningEffortFor(['light', 'high', 'extra_high'], 'extra_high'), 'xhigh')
  // 真正「反查后落到集合外」的情形：集合里没有该强度族。
  // `none` 反查成 `none`，而集合只有思考族 → 退回启发式（不是下发 none）。
  assert.equal(defaultReasoningEffortFor(['light', 'high', 'extra_high'], 'none'), 'high')
})

// ───────────────────────── 强度序表本身 ─────────────────────────

test('强度序是冻结的，且查表不吃原型链', () => {
  assert.equal(Object.isFrozen(REASONING_EFFORT_RANK), true)
  assert.equal(Object.isFrozen(CANONICAL_REASONING_EFFORTS), true)
  // 冻结 ≠ 原型链安全：`reasoningRankOf` 用的是 `hasOwnProperty.call`，
  // 所以 `constructor` / `toString` 这类继承来的键不会被误判成「登记过的档位」。
  // 用 `in` 或直接下标读就会中招（它们会返回函数/真值）。
  for (const protoKey of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(reasoningRankOf(protoKey), undefined, `${protoKey} 不该被当成档位`)
  }
})
