/**
 * TRAE **HTTP 层**错误分类。
 *
 * 移植自参考实现 `dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/trae-errors.ts`。
 *
 * ## 与那个参考实现的差异（刻意的）
 *
 * 参考实现分出一套自己的 `TraeErrorKind`（`hard-plan` / `soft-rate` / …），
 * 因为它有自己的账号池与冷却状态机。
 *
 * **我们不需要第二套词汇表**：本插件的核心层只认 `ErrorKind`
 * （见 `src/core/types.ts` 的说明：「核心层只按这个路由，永远不解析错误文案」）。
 * 多一层映射就多一处会漂的地方，而漂的表现是「同一个错误在路由器眼里
 * 与在日志里不是一回事」——排查时极其误导。
 *
 * 所以本模块的职责收窄成两件事：
 *
 * 1. 把 TRAE 的**响应体特征**（业务码 / 文案关键词）翻译成 `ErrorKind`；
 * 2. 保留参考实现点名的**判定顺序**（那是真实缺陷换来的，见下）。
 */

import type { ErrorKind } from '../../core/types.js'

/**
 * 会话死亡标记（对齐参考实现 `sessionDeadMarkers`）。
 *
 * ⚠️ 这些是**文案级**判据，只在 HTTP 401 时才看。放在这里是因为 TRAE 的
 * 401 响应体常常是 `{"message":"token 失效"}` 这种中文串，而通用分类器
 * （`src/core/errors.ts` 的 `AUTH_PATTERNS`）已经能覆盖大部分；
 * 这组额外标记是给「401 + 上游自己的文案」兜底的。
 */
const SESSION_DEAD_MARKERS: readonly string[] = [
  'login', 'token 失效', 'token invalid', 'session', 'unauthorized', '401',
]

/**
 * 按 HTTP 状态码 + 响应体原文判定 `ErrorKind`。
 *
 * ## 判定顺序（对齐参考实现 `Classify` + `SOLOStreamError.Kind`）
 *
 * 1. body 含 `1005` + `plan` → `quota`（Plan 权益不足，长冷却）
 * 2. body 含 `4008` → `quota`（`ide_credits` 耗尽）
 * 3. body 含 `4011` → `rate_limit`（频率超限）
 * 4. HTTP 401 → `auth`（会话失效，需重新登录）
 * 5. HTTP 429 → `rate_limit`
 * 6. HTTP 404 → `not_found`
 * 7. `>= 500` → `server`
 * 8. `>= 400` → `bad_request`
 * 9. 否则 `none`
 *
 * ⚠️ **第 2 步必须排在第 3 步之前**：两者可能同时出现在一个响应体里
 * （网关把多个错误码拼在 msg 中）。`quota` 需要长冷却，`rate_limit` 只需短冷却 ——
 * 让较轻的类别抢先命中，会让一个已耗尽额度的账号在 60 秒后被反复重试，
 * 用户看到的却是「稍后再试」。**更严重的分类必须优先。**
 *
 * ⚠️ 第 4 步的 401 刻意放在业务码判定**之后**：有的网关在额度耗尽时也回 401
 * （带上 4008 的文案），先看业务码能得到更准确的结论。
 *
 * @param status HTTP 状态码
 * @param body 响应体原文（JSON 或纯文本均可，只做子串匹配）
 */
export function classifyTraeError(status: number, body: string): ErrorKind {
  const lower = body.toLowerCase()

  // 1. Plan 权益不足（1005）。要求同时出现 `plan`，避免把别的含 1005 的
  //    数字串（如时间戳片段）误判。
  if ((body.includes('1005') || body.includes('"code":1005')) && lower.includes('plan')) {
    return 'quota'
  }

  // 2. 配额超限（4008，ide_credits 耗尽）。**必须先于 4011 判定**（见函数注释）。
  if (body.includes('4008') || body.includes('"code":4008')) return 'quota'

  // 3. 频率超限（4011）。
  if (body.includes('4011') || body.includes('"code":4011')) return 'rate_limit'

  // 4. 会话失效。
  if (status === 401) {
    for (const marker of SESSION_DEAD_MARKERS) {
      if (lower.includes(marker.toLowerCase())) return 'auth'
    }
    return 'auth'
  }

  // 5. 429 软限流。
  if (status === 429) return 'rate_limit'

  // 6. 404（能力探测里的正常结果，不是故障）。
  if (status === 404) return 'not_found'

  // 7. 5xx 上游故障。
  if (status >= 500) return 'server'

  // 8. 其他 4xx。
  // ⚠️ 这里回 `bad_request` 而不是 `unknown`：核心层对 `bad_request` 的语义是
  // 「**绝不能换号重试**，换号也错」。TRAE 的 4xx 绝大多数是请求本身的问题
  // （模型不可调用 4001 / 通道发错 4023），换账号确实是白费。
  if (status >= 400) return 'bad_request'

  return 'none'
}

/**
 * 该错误是否**值得换一个账号**再试。
 *
 * ⚠️ 与参考实现的 `shouldRotateTraeAccount`（「除 none 外都换」）**不同**：
 * 那是它自带账号池时的口径。我们的核心层用 `shouldSwitchAccount(kind)`
 * 统一决策（只有 `auth` / `rate_limit` / `quota` 才换号），
 * 而 `bad_request` 换号是**明确有害**的 —— 它会让一个「模型选错了」的请求
 * 把整个账号池轮一遍，然后每个账号各失败一次。
 *
 * 本函数只是把这个结论显式化，方便适配器与测试引用同一份判据。
 */
export function shouldRotateTraeAccount(kind: ErrorKind): boolean {
  return kind === 'auth' || kind === 'rate_limit' || kind === 'quota'
}
