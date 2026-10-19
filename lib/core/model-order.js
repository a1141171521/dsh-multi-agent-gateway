/**
 * 模型列表的**排序、厂商识别与默认勾选**（纯函数，可单测）。
 *
 * ## 为什么要有这一层
 *
 * 上游一次给 80+ 个模型，顺序是它自己的（大致按内部 id 排）。直接照着渲染，
 * 用户看到的是「免费的和 ×2.4 的混在一起」，找起来靠眼睛扫。
 *
 * 现在固定成一条规则：
 *
 *   1. **免费的排最前**（这一版的主要用法就是免费层）；
 *   2. 其次**按厂商聚簇**（同一家的模型连在一起，`deepseek-*` 不会散落在三处）；
 *   3. 厂商内部**按倍率升序**（便宜的在前），未知倍率排最后；
 *   4. 倍率相同按显示名。
 *
 * ## 默认勾选
 *
 * 「默认选免费模型；没有免费的就一个都不选」——
 * 注意这**不是**一条新规则，而是既有 `mode: 'free'` 的语义。
 * 这里把它抽成函数，是为了让「勾选框显示什么」和「实际会上报什么」
 * 用的是同一份判断（否则界面勾着 3 个、下拉里却是 9 个）。
 */

                                           

/**
 * 已知厂商表：前缀 → 厂商。
 *
 * 只用来**聚合**与**显示**，不参与鉴权或路由判断 —— 认不出来的模型会退化成
 * 「id 的第一段」，照样排序、照样能用。
 */
const VENDORS                                                                             = [
  { key: 'deepseek', label: 'DeepSeek', prefixes: ['deepseek'] },
  { key: 'zhipu', label: '智谱', prefixes: ['glm', 'chatglm', 'zhipu'] },
  { key: 'moonshot', label: '月之暗面', prefixes: ['kimi', 'moonshot'] },
  { key: 'alibaba', label: '阿里', prefixes: ['qwen', 'qwq', 'tongyi'] },
  { key: 'openai', label: 'OpenAI', prefixes: ['gpt', 'codex', 'davinci', 'o1', 'o3', 'o4'] },
  { key: 'anthropic', label: 'Anthropic', prefixes: ['claude'] },
  { key: 'google', label: 'Google', prefixes: ['gemini', 'gemma', 'palm'] },
  { key: 'nvidia', label: 'NVIDIA', prefixes: ['nemotron'] },
  { key: 'xiaomi', label: '小米', prefixes: ['mimo'] },
  { key: 'meituan', label: '美团', prefixes: ['longcat'] },
  { key: 'bytedance', label: '字节', prefixes: ['doubao', 'skylark', 'seed'] },
  { key: 'minimax', label: 'MiniMax', prefixes: ['minimax', 'abab'] },
  { key: 'stepfun', label: '阶跃', prefixes: ['step'] },
  { key: 'baichuan', label: '百川', prefixes: ['baichuan'] },
]

/**
 * 从模型 id 认厂商。
 *
 * 规则：取 id 的第一段（`-` / `.` / `_` / `/` 之前）做**前缀**匹配
 * （`qwen3.8-flash` 的第一段是 `qwen3`，得用 `startsWith` 才认得出 `qwen`）；
 * 匹配不到就用第一段本身当厂商名（`big-pickle` → `big`），
 * 保证「同一家的排在一起」这条对未知厂商也成立。
 */
export function vendorOf(id        )                                 {
  const head = String(id ?? '')
    .trim()
    .toLowerCase()
    .split(/[-._/]/)[0] ?? ''
  if (head === '') return { key: '~', label: '其他' }
  for (const vendor of VENDORS) {
    if (vendor.prefixes.some((prefix) => head.startsWith(prefix))) {
      return { key: vendor.key, label: vendor.label }
    }
  }
  return { key: head, label: head }
}

/** 免费判定：上游标了免费，或倍率明确是 0。 */
export function isFreeModel(meta                                        )          {
  return meta.free === true || meta.multiplier === 0
}

/** 倍率排序值：未知倍率排最后。 */
function multiplierRank(meta                               )         {
  const value = meta.multiplier
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

/**
 * 模型选择器里的顺序：免费 → 厂商 → 倍率 → 名称。
 *
 * 返回新数组，不改入参（调用方常把上游缓存直接传进来）。
 */
export function sortForPicker                                                                  (list              )      {
  return [...list].sort((left, right) => {
    const freeDelta = (isFreeModel(left) ? 0 : 1) - (isFreeModel(right) ? 0 : 1)
    if (freeDelta !== 0) return freeDelta

    const leftVendor = vendorOf(left.id)
    const rightVendor = vendorOf(right.id)
    if (leftVendor.key !== rightVendor.key) {
      // 认得出的厂商排在「退化名」前面，避免 `big` / `space` 这类散名插到中间。
      const leftKnown = VENDORS.some((vendor) => vendor.key === leftVendor.key) ? 0 : 1
      const rightKnown = VENDORS.some((vendor) => vendor.key === rightVendor.key) ? 0 : 1
      if (leftKnown !== rightKnown) return leftKnown - rightKnown
      return leftVendor.label.localeCompare(rightVendor.label, 'zh-Hans-CN')
    }

    const rankDelta = multiplierRank(left) - multiplierRank(right)
    if (rankDelta !== 0 && !Number.isNaN(rankDelta)) return rankDelta < 0 ? -1 : 1

    return String(left.name ?? left.id).localeCompare(String(right.name ?? right.id), 'zh-Hans-CN')
  })
}

/**
 * 当前**实际会上报**的模型 id（mode 感知）。
 *
 * 界面上的勾选框必须显示这一份 —— 否则 `mode: 'free'` 时勾选框全空、
 * 下拉里却有 9 个，用户会以为坏了。
 */
export function effectiveSelectedIds(
  list                                                          ,
  policy                                                                    ,
)           {
  if (policy.mode === 'all') return list.map((meta) => meta.id)
  if (policy.mode === 'free') return list.filter((meta) => isFreeModel(meta)).map((meta) => meta.id)
  const wanted = new Set(policy.selected)
  return list.filter((meta) => wanted.has(meta.id)).map((meta) => meta.id)
}

/**
 * 首次打开时该预勾哪些：**免费模型**；一个都没有就空着（默认不选）。
 *
 * 只用于「用户还没做过选择」的时刻，别拿它覆盖已有的 `selected`。
 */
export function defaultSelectedIds(
  list                                                          ,
)           {
  return list.filter((meta) => isFreeModel(meta)).map((meta) => meta.id)
}


//# sourceURL=src/core/model-order.ts