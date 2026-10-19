/**
 * 跨 provider 的**思考档位强度序**，以及「OpenAI 规范档位名 ↔ 各 provider
 * 私有 id」的双向翻译。
 *
 * 移植自参考实现 `dsh-our-free-model` 的 `vendor/channel-pack/src/reasoning-ladder.ts`
 * （MIT），语义逐条对齐。**理由一并搬过来** —— 这个模块的价值一半在代码、一半在
 * 下面这些「为什么」，丢了理由，下一个人就会把「同距取更强」改成「取更弱」。
 *
 * ## 为什么需要一张跨 provider 的表
 *
 * 各 provider 的档位 `id` 就是**上游的 wire 值**，彼此既不同名、也不同数量：
 *
 * | provider | 真实 id | 界面上显示的名字 |
 * |---|---|---|
 * | TRAE | `light` / `high` / `extra_high` | Light / High / Extra High |
 * | LobsterAI | `off` / `high` / `xhigh` | 关闭 / 高 / Max |
 * | Cline | `none` / `low` / `medium` / `high` / `max` | None / Low / Medium / High / Extra |
 * | Raccoon | `on` / `off` | 开启 / 关闭 |
 * | OpenCode | models.dev 的 `reasoning_options[].values`（**远端可刷新**） | 见下 |
 *
 * 而走 OpenAI 协议的客户端只有**一套固定的 8 档词汇**：
 * `none minimal low medium high xhigh max ultra`（Codex 的档位选择器、以及为它
 * 生成模型目录的 CC Switch 都是这 8 个）。
 *
 * 于是必然撞车：用户照着界面上看到的名字（Max / Extra / Extra High）填进客户端，
 * 网关却按 **id** 校验，`max` 撞 `xhigh`、`xhigh` 撞 `max`、`low` 撞 `light` ——
 * 结果是 **400 + 整轮对话不可用**，而用户从两端都看不出为什么。
 * （这不是配置错误：客户端**无法表达** `light` / `extra_high` / `on` 这类私有值。）
 *
 * ## 解法：网关承担翻译
 *
 * 强度序 + **同族就近**，把客户端给的规范名落到模型真正声明的 id 上。
 * 反向再由 {@link canonicalReasoningEffortFor} 给出「该填哪几个」，
 * 于是模型选择器的档位表与文档里的对照表都是这份表的机械投影，不需要人工对照。
 *
 * ⚠️ **本表是强度序的唯一权威**：适配器挑默认档、网关做翻译都读它。
 * 各写一份必然漂移，而漂移的症状是「同一个档位在两处算出不同结果」。
 *
 * ⚠️ 未登记的私有 id **不参与**就近匹配（见 {@link translateReasoningEffort}）：
 * 拿一个我们不知道强度的名字当候选，等于凭空猜一个强度。
 */

/**
 * 档位强度序（数值越大思考越强）。
 *
 * `0` 是特殊档：**关闭思考**。它自成「族」，与其余各档之间**不互相翻译** ——
 * 用户要「少想一点」绝不能得到「完全不想」（那是静默把功能关掉了），
 * 反之亦然。这条是硬规则，不是偏好：把「低」翻成「关」的后果是模型不再思考，
 * 而用户从界面上完全看不出发生了什么。
 *
 * | 名字 | 来源 |
 * |---|---|
 * | `off` / `none` | 「关闭思考」。Qoder / Cline / Raccoon 用前者，OpenAI 用后者 |
 * | `minimal` … `high` | OpenAI 通用档位 |
 * | `light` | TRAE 的最弱档（TRAE 自己的名字，比 `minimal` 强一点） |
 * | `on` | Raccoon 的「开启思考」——**没有强度语义**，故与 `high` 同序 |
 * | `extra_high` | TRAE 的最强档 |
 * | `xhigh` / `max` | OpenAI / 各家的高强档 |
 * | `ultra` | CC Switch 枚举里最强的一档（本仓库此前没有对应物，登记以便翻译） |
 */
export const REASONING_EFFORT_RANK: Readonly<Record<string, number>> = Object.freeze({
  off: 0,
  none: 0,
  minimal: 1,
  light: 2,
  low: 3,
  medium: 4,
  high: 5,
  // 「开启思考」没有强度语义 —— 与 high 同序，使它在规范名里反查成 `high`。
  on: 5,
  extra_high: 6,
  xhigh: 7,
  max: 8,
  ultra: 9,
})

/**
 * OpenAI 协议侧通用的 8 个规范档位名，**顺序即由弱到强**。
 *
 * CC Switch 的档位多选器就是这 8 个（含 `minimal` / `ultra`），
 * 故它就是「客户端能说出口的全部词汇」。
 */
export const CANONICAL_REASONING_EFFORTS: readonly string[] = Object.freeze([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])

/**
 * 档位 id → 中文展示名。
 *
 * DSH 客户端**直接渲染** `efforts[].name`（不本地化、不查字典），给英文就显示
 * 英文，所以这张表必须自己填。`minimal` / `xhigh` / `light` 等在没有官方译名时
 * **回退到 id 本身** —— 宁可显示 `xhigh` 也不编一个错译。
 */
const EFFORT_NAMES: Record<string, string> = {
  off: '关闭思考',
  none: '关闭思考',
  minimal: '最小',
  light: '轻',
  low: '低',
  medium: '中',
  high: '高',
  on: '开启思考',
  extra_high: '极高',
  xhigh: '极高',
  max: '最大',
  ultra: '极致',
}

/** 档位 id → 展示名（无官方中文时回退到 id 本身，不猜译名）。 */
export function reasoningEffortName(id: string): string {
  return EFFORT_NAMES[id] ?? id
}

/** 强度序里登记过的名字（= 我们认识它，不是拼写错误）。 */
export function isKnownReasoningEffort(effort: string): boolean {
  return reasoningRankOf(effort) !== undefined
}

/** 档位强度；未登记返回 undefined。 */
export function reasoningRankOf(effort: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(REASONING_EFFORT_RANK, effort)
    ? REASONING_EFFORT_RANK[effort]
    : undefined
}

/** 是否属于「关闭思考」族。 */
export function isThinkingOffEffort(effort: string): boolean {
  return reasoningRankOf(effort) === 0
}

/**
 * 翻译结果。
 *
 * - `exact`：模型声明的 id 里**就有**这个值，原样下发；
 * - `mapped`：认识这个名字、但模型用的是别的写法 → 就近落到同族的一档
 *   （`rank` 是**请求值**的强度，供日志/诊断用）；
 * - `unexpressible`：模型**没有这一族**的档位（例如给只声明 `high` 的 TRAE 要
 *   `none`）→ 调用方应**不下发**该参数并记日志；
 * - `unknown`：既没声明、也没登记过（拼写错误 / 客户端 bug）→ 调用方应**报错**。
 */
export type ReasoningEffortTranslation =
  | { kind: 'exact'; effort: string }
  | { kind: 'mapped'; effort: string; requested: string; rank: number }
  | { kind: 'unexpressible' }
  | { kind: 'unknown' }

/**
 * 把请求的档位翻译成模型**声明过的** id。
 *
 * 规则（三条，顺序即优先级）：
 * 1. **精确命中** `declared` → 原样。私有 id（`light` 等）由这一步通过，
 *    不要求它出现在强度序里；
 * 2. 是**登记过**的名字 → 在 `declared` 里就近取同族的一档。
 *    ⚠️ 只在**同族**内取：要「开思考」不会落到 `off`，反之亦然；
 * 3. 同族一个候选都没有 → `unexpressible`；连名字都不认识 → `unknown`。
 *
 * ⚠️ **同距时取更强的一档**（`rank` 大者胜）。依据是参考实现里既有的口径：
 * Raccoon 那处注释写着「未知档位一律按开启处理 —— 宁可多思考，不可静默关掉，
 * 用户看不到思考内容会以为模型坏了」。反过来（同距取弱）会在只有一个中间档的
 * 模型上把用户主动选的强度悄悄降一档。
 *
 * @param requested 请求的档位（客户端给的规范名，或上游私有 id）。
 * @param declared 模型**声明过**的档位 id 集合（`ModelMeta.reasoningEfforts`）。
 */
export function translateReasoningEffort(
  requested: string,
  declared: readonly string[],
): ReasoningEffortTranslation {
  if (declared.includes(requested)) return { kind: 'exact', effort: requested }
  const rank = reasoningRankOf(requested)
  if (rank === undefined) return { kind: 'unknown' }
  const wantOff = rank === 0
  let best: { effort: string; distance: number; rank: number } | undefined
  for (const candidate of declared) {
    const candidateRank = reasoningRankOf(candidate)
    // 未登记的私有 id 不参与匹配：不知道它的强度，猜出来的档位没有依据。
    if (candidateRank === undefined) continue
    if ((candidateRank === 0) !== wantOff) continue
    const distance = Math.abs(candidateRank - rank)
    if (best === undefined || distance < best.distance || (distance === best.distance && candidateRank > best.rank)) {
      best = { effort: candidate, distance, rank: candidateRank }
    }
  }
  if (best === undefined) return { kind: 'unexpressible' }
  return { kind: 'mapped', effort: best.effort, requested, rank }
}

/**
 * 反查：某个模型声明的 id，在 OpenAI 那 8 个规范名里**应该用哪个**。
 *
 * 用途是把「该填哪几个」机读化（模型选择器的档位行、文档里的对照表）。
 * 返回值保证**能反向译回原 id**（自洽），故客户端填这组值不会有任何降级 ——
 * 单测里有一条专门断言这个自洽性。
 *
 * 未登记且不是规范名的 id（上游新冒出来的档位）返回 undefined ——
 * 那种情况下「该填什么」我们确实不知道，不能编。
 */
export function canonicalReasoningEffortFor(effort: string): string | undefined {
  if (CANONICAL_REASONING_EFFORTS.includes(effort)) return effort
  const rank = reasoningRankOf(effort)
  if (rank === undefined) return undefined
  const wantOff = rank === 0
  let best: { canonical: string; distance: number; rank: number } | undefined
  for (const canonical of CANONICAL_REASONING_EFFORTS) {
    const canonicalRank = reasoningRankOf(canonical)
    // 规范名全部登记在强度序里；真缺了就当这档不可表达，而不是崩掉。
    if (canonicalRank === undefined) continue
    if ((canonicalRank === 0) !== wantOff) continue
    const distance = Math.abs(canonicalRank - rank)
    // 与正向翻译同一口径：同距取更强的一档，保证反查结果能译回原 id。
    if (best === undefined || distance < best.distance || (distance === best.distance && canonicalRank > best.rank)) {
      best = { canonical, distance, rank: canonicalRank }
    }
  }
  return best?.canonical
}

/**
 * 一个模型声明的档位表 → 选择器里该显示的档位行。
 *
 * ## 为什么不能直接把 `declared` 当选择器选项
 *
 * 选择器是 **OpenAI 协议侧**的 UI，只能渲染上面那 8 个规范词汇。
 * 上游声明的私有 id（`light` / `extra_high` / `on`）**不能**出现在选项里：
 * 用户选了 `light`，DSH 会把它原样回传成 `reasoningEffort`，而网关按 id 校验时
 * 它只在**这一个模型**上合法，换一个模型就是 400。规范化的选项才是可移植的。
 *
 * 于是对每个声明的 id 做反查、去重、按强度升序。空表表示**不声明** —
 * 调用方就不该给这个模型显示出档位行（而不是显示一个空选择器）。
 *
 * ⚠️ `off` / `none` 与其余档位**同时**出现是正常的：模型本来就声明了「关」这一族。
 * 去重靠 `canonicalReasoningEffortFor` 的返回值本身（`light` 与 `minimal` 会撞到
 * 同一个规范名，只留一个）。
 */
export function reasoningEffortsForDeclared(declared: readonly string[]): string[] {
  const out: string[] = []
  for (const id of declared) {
    const canonical = canonicalReasoningEffortFor(id)
    if (canonical === undefined) continue
    if (!out.includes(canonical)) out.push(canonical)
  }
  // 顺序即由弱到强 —— 与 CANONICAL_REASONING_EFFORTS 同序，UI 的排列才稳定。
  return CANONICAL_REASONING_EFFORTS.filter((effort) => out.includes(effort))
}

/**
 * 挑一个默认档位。
 *
 * **优先级：上游声明的默认 > 启发式。**
 *
 * `declaredDefault` 非空且能译回规范名时**一律用它** —— 那是上游（乃至官方客户端）
 * 真正会选的档位，拿启发式覆盖它会让同一个模型在插件里跑在别的档位上，
 * 而用户看不出差别在哪（实测 `dfmodel` 上游声明 `max`，启发式会挑 `low`）。
 *
 * 没声明时才启发式：优先 `medium`（OpenAI 惯用的中性档），
 * 没有就退到**已声明档位里最接近中性**的一档；一个档位都没有时返回 undefined
 * （调用方不下发 `defaultEffort`）。
 *
 * ⚠️ 不用「第一个」当默认：`declared` 是上游给的**原序**，没有任何顺序承诺
 * （models.dev 的 `reasoning_options[].values` 实测是弱→强，但那是巧合）。
 * 挑错默认档的后果是用户一开口就在「极致思考」上烧额度。
 */
export function defaultReasoningEffortFor(
  declared: readonly string[],
  declaredDefault?: string,
): string | undefined {
  const canonical = reasoningEffortsForDeclared(declared)
  if (canonical.length === 0) return undefined
  // ★ 上游声明过默认档就用它（前提是它能译回规范名、且真的在那个集合里）。
  if (typeof declaredDefault === 'string' && declaredDefault !== '') {
    const mapped = canonicalReasoningEffortFor(declaredDefault)
    if (mapped !== undefined && canonical.includes(mapped)) return mapped
  }
  if (canonical.includes('medium')) return 'medium'
  return canonical[Math.floor((canonical.length - 1) / 2)]
}
