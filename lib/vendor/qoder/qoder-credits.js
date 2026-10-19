/**
 * Qoder 积分余额查询与每日领取 —— **协议层**（纯函数，无 I/O、不依赖 `src/core`）。
 *
 * 事实来源：`dsh-our-free-model`（MIT）的 `vendor/channel-pack/src/qoder-credits.ts`，
 * 并**以本机实测为准**修正了它的一处结论（见下面「machine 头」一节）。
 *
 * ## 端点（2026-10-19 本机真实账号复测，CN）
 *
 * ```
 * GET  {openApiBase}/sash/api/v2/me/usage                    → 余额
 * GET  {openApiBase}/sash/api/v1/me/campaigns                → 活动列表（含每日领取）
 * POST {openApiBase}/sash/api/v1/me/campaigns/{id}/claim     → 领取，**请求体为空串**
 * ```
 *
 * 三个端点都**不需要 WASM 签名**，只要 `Bearer <token>` + `Cosy-ClientType`。
 * 这一点与模型列表端点不同 —— 早期因为只按 `/api/` 前缀找而误判「Qoder 无积分端点」。
 *
 * ## ⚠️ machine 头：参考实现说必需，**本机实测证明不必**（以实测为准）
 *
 * 参考实现声称 `Cosy-MachineToken` + `Cosy-MachineType` 必需，否则服务端只回一条
 * `VIEW_DETAILS`（它的 2026-09-25 消融实验，据此专门移植了 `qoder-machine.ts`）。
 *
 * 本机 2026-10-19 用真实账号对 `/sash/api/v1/me/campaigns` 重做同一实验：
 *
 * | 请求头 | 结果 |
 * |---|---|
 * | 仅 `Cosy-ClientType: '10'` | `campaigns=2`，**含 `CLAIM_BENEFIT`** |
 * | 再加 `MachineToken` + `MachineType` | 结果**完全相同**（`campaigns=2`，含 `CLAIM_BENEFIT`） |
 * | 仅 `Cosy-ClientType: '5'` | `campaigns=0`、`showCampaign:false` |
 *
 * 结论有两条，都要照做：
 *
 *   1. **`Cosy-ClientType: '10'` 是必需的**（取 `product.sashClientType`，桌面客户端
 *      身份）。用 `clientMetadata.client_type`（`'5'` = CLI 身份）会让服务端恒回
 *      `campaigns:[]` —— 这正是参考实现早先把每日领取登记成 false 的原因。
 *   2. **machine 头不要加**。它在 CN 上不改变响应，只增加失败面；而且我们
 *      `qoder-machine.ts` 产出的是**本机 `runtime-info.exe` 的身份**，与账号无关
 *      （实测该模块在本机解析出的 `machineToken` / `machineType` 都是 `undefined`，
 *      带上去等于发两个 `undefined` 头）。少一个身份来源就少一处会失效的东西。
 *
 * ## 余额在 `addOnQuota` 里，不在 `userQuota`
 *
 * 实测响应（2026-10-19，CN，真实账号）：
 *
 * ```json
 * { "displayMode": "qoder",
 *   "qoderUsage": {
 *     "userId": "019e88b9-…", "userType": "personal_standard", "usageType": "credits",
 *     "totalUsagePercentage": 0.15, "isQuotaExceeded": false,
 *     "expiresAt": 253402214400000,
 *     "userQuota":  { "total": 0,    "used": 0,   "remaining": 0,   "percentage": 0,    "unit": "credits" },
 *     "addOnQuota": { "total": 1000, "used": 142, "remaining": 858, "percentage": 0.15, "unit": "credits" } } }
 * ```
 *
 * `userQuota` 在这个账号上是**恒为 0 的占位**，真实可用的 858 积分在 `addOnQuota`。
 * 只读 `userQuota` 会显示 0（与其它 provider 的「漏读某一层」是同一类缺陷）。
 *
 * ## 幂等判据是响应体的 `replayed`，不是 HTTP 状态码
 *
 * 重复领取**同样返回 200**，但 `replayed: true`，`claimedAt` 是上一次领取的旧时间。
 * 只看状态码会把「今天已领」误报成「领取成功 +100」。
 *
 * ⚠️ **本机实测补充（2026-10-19）：`replayed:true` 的响应里 `benefit` 仍然存在。**
 * 参考实现说回放响应「**不含 `benefit`**」，本机真实账号打出来的是：
 *
 * ```json
 * { "grantId": "01a15366-…", "status": "CLAIMED", "replayed": true,
 *   "benefit": { "kind": "CREDITS", "amount": 100, … },   ← 参考实现说这里没有，实测有
 *   "campaignVersion": 2,
 *   "claimedAt": "2026-10-19T09:02:38.233484Z",   ← 上一次的旧时间（本次请求在其后约 2 小时）
 *   "grantedAt": "2026-10-19T09:02:38.459564Z",
 *   "expiresAt": "2026-11-18T09:02:38.233484Z" }
 * ```
 *
 * 这条差异很危险，因为它**恰好会让一个看起来对的写法变错**：
 *
 *   - 写「有 `benefit` 就算成功」→ 把「今天已领」误报成 **+100**（每次都谎报）；
 *   - 写「没 `benefit` 就算回放」→ 参考实现的口径，在本机**永远不成立**，
 *     于是重复领取全被当成成功。
 *
 * 所以判据**只能是 `replayed` 这个布尔字段本身**，`benefit` 的有无不能当判据。
 * 参考实现抓包（2026-09-21，国际版）当时确实不含 `benefit` —— 说明这个字段
 * 的上游行为变过或分环境，**更说明不能拿它当判据**。
 *
 * ## 领取响应（参考实现抓包，2026-09-21，首次领取）
 *
 * ```json
 * { "grantId": "01a0c475-…", "status": "CLAIMED", "replayed": false,
 *   "benefit": { "kind": "CREDITS", "amount": 100,
 *                "modelScope": { "modelSeries": { "key": "ALL_MODELS" } },
 *                "validity": { "mode": "RELATIVE_DAYS", "days": 30 } },
 *   "campaignId": "01a0bf8d-…", "campaignKey": "act-20260921-308", "campaignVersion": 1,
 *   "claimedAt": "2026-09-21T14:54:12.176671Z", "grantedAt": "2026-09-21T14:54:12.393072Z",
 *   "expiresAt": "2026-10-21T14:54:12.176671Z" }
 * ```
 *
 * ⚠️ **请求体必须是空串**（抓包里 `content-length: 0`），不是 `"{}"`。源码里领取走
 * `POST` 但无 payload；发一个未经验证的 body 属额外风险，故照实发空。
 *
 * ## ⚠️ `actionType` 过滤是承重的：`VIEW_DETAILS` 也会带 `claimStatus: "CLAIMED"`
 *
 * 本机 2026-10-19 原始响应里，**两条**活动都是 `claimStatus: "CLAIMED"`：
 *
 * ```
 * · CLAIM_BENEFIT / act-20261013-146   ← 每天领 100 Credits（已领）
 * · VIEW_DETAILS  / act-20260901-922   ← 「专业版首月 Credits 翻倍」（纯展示，也标了 CLAIMED）
 * ```
 *
 * 所以「有没有 `claimStatus === 'CLAIMED'`」**不能**单独作判据 —— 必须**先**按
 * `actionType === 'CLAIM_BENEFIT'` 过滤。拿纯展示活动的 `CLAIMED` 去推断「今天已领」，
 * 会在一个从没有过每日领取的账号上谎报已领。参考实现的 `benefitCampaigns` 先过滤
 * `actionType` 正是这个道理（它的注释没写这一条，本机数据才看得出来）。
 *
 * ## 为什么这套东西非做不可
 *
 * `/sash/api/v1/me/campaigns` 早期实测返回
 * `{"showCampaign":false,"claimable":false,"campaigns":[]}`，据此误判
 * 「Qoder 无签到端点」并把每日领取登记为 false。真相是**那天已领**；活动状态是
 * **每日 10:00（UTC+8）刷新**的（服务端原文就在响应里：
 * `"每日 10:00（UTC+8）刷新，领取后 30 天有效"`）。
 */

                                                      

/** 用量接口路径（挂 `openApiBase`）。 */
export const QODER_USAGE_PATH = '/sash/api/v2/me/usage'
/** 活动列表路径（挂 `openApiBase`）；领取路径是它 + `/{campaignId}/claim`。 */
export const QODER_CAMPAIGNS_PATH = '/sash/api/v1/me/campaigns'
/** 单次请求超时（毫秒）。与参考实现一致。 */
export const QODER_CREDITS_TIMEOUT_MS = 15_000

/** 可领取的活动动作类型。`VIEW_DETAILS` 是纯展示，**不该尝试领取**。 */
export const QODER_ACTION_CLAIM_BENEFIT = 'CLAIM_BENEFIT'
/** 「这条已经领过了」的 `claimStatus` 取值（实测值）。 */
export const QODER_CLAIM_STATUS_CLAIMED = 'CLAIMED'
/** 「现在可以领」的 `claimStatus` 取值（参考实现抓包的领取前状态）。 */
export const QODER_CLAIM_STATUS_CLAIMABLE = 'CLAIMABLE'

/**
 * `/sash/` 端点（用量、活动、领取）的公共请求头。
 *
 * ⚠️ **只带 `Cosy-ClientType: '10'`，不带 machine 头** —— 实测依据见文件头。
 * 用 `clientMetadata.client_type`（`'5'`）会让活动列表恒为空。
 */
export function qoderCreditsHeaders(product              , token        )                         {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    // 桌面 app 身份（`'10'`）。服务端据此进入活动下发分支。
    'cosy-clienttype': product.sashClientType,
    // CN asar 里 sash 请求头 UA 恒为 `"Qoder"`。
    'user-agent': 'Qoder',
  }
}

/** 领取某个活动的 URL。`campaignId` 是 UUID，仍做一次编码以免上游改形状时拼出坏 URL。 */
export function qoderClaimUrl(product              , campaignId        )         {
  return `${product.openApiBase}${QODER_CAMPAIGNS_PATH}/${encodeURIComponent(campaignId)}/claim`
}

/** 安全读数字字段（容忍字符串与缺失）；无法解析时返回 undefined。 */
function readNumber(source         , key        )                     {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source                           )[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 安全读字符串字段。 */
function readString(source         , key        )                     {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source                           )[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 读嵌套一层的 `benefit.amount`。 */
function benefitAmount(item         )                     {
  if (typeof item !== 'object' || item === null) return undefined
  return readNumber((item                           ).benefit, 'amount')
}

// ───────────────────────────── 余额 ─────────────────────────────

/** 一个额度包（`userQuota` / `addOnQuota` 归一化后的形状）。 */
                                    
                               
              
              
               
              
                   
 

/** 解析后的用量响应。 */
                             
                      
                 
                   
                    
                           
                                            
                               
                                
                                
                         
                                
                                                        
                        
                        
                              
 

/**
 * 把一个 quota 对象转成 {@link QoderQuotaPackage}。
 *
 * `remaining` 优先取服务端字段；缺失时按 `total - used` 算。
 * **负值一律 clamp 到 0**：服务端在超额扣费 / 计量回滚下可能下发负值，
 * 原样透出会让界面显示「-12.5 积分」。
 *
 * 三个字段全缺失时返回 undefined（这个包没下发），与「包存在但都是 0」区分开。
 */
function toPackage(name        , quota         )                                {
  const total = readNumber(quota, 'total')
  const used = readNumber(quota, 'used')
  const remainingRaw = readNumber(quota, 'remaining')
  if (total === undefined && used === undefined && remainingRaw === undefined) return undefined
  const totalValue = Math.max(0, total ?? 0)
  const usedValue = Math.max(0, used ?? 0)
  return {
    name,
    unit: readString(quota, 'unit') ?? 'credits',
    remaining: remainingRaw !== undefined ? Math.max(0, remainingRaw) : Math.max(0, totalValue - usedValue),
    total: totalValue,
    used: usedValue,
  }
}

/**
 * 解析 `/sash/api/v2/me/usage` 的响应；形状非法时返回 undefined。
 *
 * 返回 undefined 表示**查不到**（形状与预期不符），与「余额为 0」严格区分 ——
 * 后者会让用户以为额度被清空了。
 */
export function parseQoderUsage(body         )                         {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const root = body                           
  const usage = root.qoderUsage
  if (typeof usage !== 'object' || usage === null) return undefined
  const record = usage                           

  const dedicated                      = []
  if (Array.isArray(record.dedicatedResourcePackages)) {
    for (const item of record.dedicatedResourcePackages) {
      const pkg = toPackage(readString(item, 'name') ?? readString(item, 'id') ?? '专用资源包', item)
      if (pkg !== undefined) dedicated.push(pkg)
    }
  }

  const userQuota = toPackage('套餐额度', record.userQuota)
  const addOnQuota = toPackage('资源包', record.addOnQuota)

  return {
    ...(readString(root, 'displayMode') === undefined ? {} : { displayMode: readString(root, 'displayMode')  }),
    ...(readString(record, 'userId') === undefined ? {} : { userId: readString(record, 'userId')  }),
    ...(readString(record, 'userType') === undefined ? {} : { userType: readString(record, 'userType')  }),
    ...(readNumber(record, 'expiresAt') === undefined ? {} : { expiresAt: readNumber(record, 'expiresAt')  }),
    ...(typeof record.isQuotaExceeded === 'boolean' ? { isQuotaExceeded: record.isQuotaExceeded } : {}),
    ...(userQuota === undefined ? {} : { userQuota }),
    ...(addOnQuota === undefined ? {} : { addOnQuota }),
    dedicated,
    // ⚠️ 判「字段是否存在」而不是「值是否为 0」：见 `isQoderNotActivated`。
    hasAddOnQuota: record.addOnQuota !== undefined && record.addOnQuota !== null,
    ...(readString(record, 'detailUrl') === undefined ? {} : { enterpriseDetailUrl: readString(record, 'detailUrl')  }),
  }
}

/** 全部额度包的剩余之和（UI 展开用；主口径见适配器的 `remaining` 取值注释）。 */
export function qoderTotalRemaining(usage            )         {
  let sum = 0
  for (const pkg of [usage.userQuota, usage.addOnQuota, ...usage.dedicated]) {
    if (pkg !== undefined) sum += pkg.remaining
  }
  return sum
}

// ───────────────────────────── 活动列表 ─────────────────────────────

/** 一个活动条目（`campaigns[]` 的一项，只保留实现需要的字段）。 */
                                
                    
                      
     
                                                        
                                   
    
                                                                 
          
     
                     
                                    
                      
                                
                 
 

/**
 * 活动列表的一次解析结果。
 *
 * ⚠️ `claimable` 为 false **不代表没有活动** —— 实测「今天已领」之后服务端可能回
 * `showCampaign:false, claimable:false, campaigns:[]`，所以「无活动」与「已领完」
 * 在响应上无法仅凭这两个布尔区分。不要据此下结论。
 */
                                 
                       
                    
                            
 

/** 解析 `/sash/api/v1/me/campaigns` 的响应；形状非法时返回 undefined。 */
export function parseQoderCampaigns(body         )                             {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const root = body                           
  const campaigns                  = []
  if (Array.isArray(root.campaigns)) {
    for (const item of root.campaigns) {
      const id = readString(item, 'campaignId')
      if (id === undefined) continue
      const key = readString(item, 'campaignKey')
      const actionType = readString(item, 'actionType')
      const claimStatus = readString(item, 'claimStatus')
      const amount = benefitAmount(item)
      campaigns.push({
        campaignId: id,
        ...(key === undefined ? {} : { campaignKey: key }),
        ...(actionType === undefined ? {} : { actionType }),
        ...(claimStatus === undefined ? {} : { claimStatus }),
        ...(amount === undefined ? {} : { amount }),
      })
    }
  }
  return {
    showCampaign: root.showCampaign === true,
    claimable: root.claimable === true,
    campaigns,
  }
}

/**
 * 当前**可以领**的活动：`CLAIM_BENEFIT` 且 `CLAIMABLE`。
 *
 * 先过滤 `actionType` 再判状态，两步都不能省（见 {@link QoderCampaign.actionType}）。
 */
export function claimableQoderCampaigns(parsed                )                  {
  return parsed.campaigns.filter(
    (item) => item.actionType === QODER_ACTION_CLAIM_BENEFIT && item.claimStatus === QODER_CLAIM_STATUS_CLAIMABLE,
  )
}

/**
 * 「有领分类活动**已经领过**」——已领的可靠判据（领取前后对照见参考实现抓包：
 * 领取前 `CLAIMABLE`、领取后 `CLAIMED`）。
 *
 * ⚠️ 它**只对「活动刷新之后」成立**：刷新前看到的那条 `CLAIMED` 属于**昨天**。
 * 是否已刷新的判断在**适配器**里做（那里才能 import `core/time.ts`），
 * 本模块只回答「列表里有没有已领的领分类活动」。
 *
 * ⚠️ 同样**不能**写成「没有可领项即为 true」：那还可能只是
 * ① 未到刷新时刻、② 请求头不全导致服务端没下发、③ 该账号本就无此活动。
 */
export function hasClaimedQoderBenefit(parsed                )          {
  return parsed.campaigns.some(
    (item) => item.actionType === QODER_ACTION_CLAIM_BENEFIT && item.claimStatus === QODER_CLAIM_STATUS_CLAIMED,
  )
}

/**
 * 判断账号是否「尚未在 Qoder 侧开通每日领取」。
 *
 * 判据（两条**同时**满足才算，避免误报）：
 *   1. 活动列表里**没有**任何 `CLAIM_BENEFIT`（连已领的也没有）；
 *   2. 用量响应里 `addOnQuota` 字段**不存在**（注意是**缺失**，不是 0）。
 *
 * ⚠️ 第 2 条必须用「字段是否存在」而非「remaining 是否为 0」：后者对
 * 「额度用光」与「从未开通」不可区分，会把用光额度的老账号误报成未开通。
 *
 * @param campaigns 活动列表（`undefined` 表示未取到，此时**不判定**）
 * @param usageBody 用量**原始**响应体（`undefined` / 形状不可用时不判定）
 */
export function isQoderNotActivated(campaigns                            , usageBody         )          {
  // 取不到活动列表时无法判定 —— 保守返回 false（宁可少提示，不可误报）
  if (campaigns === undefined) return false
  if (campaigns.campaigns.some((item) => item.actionType === QODER_ACTION_CLAIM_BENEFIT)) return false

  // 用量响应不可用时无法判定
  if (typeof usageBody !== 'object' || usageBody === null) return false
  const usage = (usageBody                           ).qoderUsage
  if (typeof usage !== 'object' || usage === null) return false
  // `addOnQuota` 存在（哪怕是 0）即说明账号已开通 → 不是「未开通」
  return (usage                           ).addOnQuota === undefined
}

// ───────────────────────────── 领取 ─────────────────────────────

/** 领取响应里我们需要的字段。 */
                                   
                 
                                                              
                    
                                                              
                 
 

/** 解析 claim 响应；形状非法时返回空对象（调用方按「没读到」处理）。 */
export function parseQoderClaimResult(body         )                   {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return {}
  const root = body                           
  const status = readString(root, 'status')
  const amount = benefitAmount(root)
  return {
    ...(status === undefined ? {} : { status }),
    ...(typeof root.replayed === 'boolean' ? { replayed: root.replayed } : {}),
    ...(amount === undefined ? {} : { amount }),
  }
}

/**
 * 把领取响应判成三种结局之一。
 *
 * ⚠️ **顺序不能反**：先看 `replayed`，再看 `status`。重复领取同样返回 200，
 * 但 `replayed:true` **不含 `benefit`** —— 先判 `status` 会把「今天已领」
 * 误报成「领取成功 +0」。
 */
                               
                                       
                               
                                           

/** 从原始响应体得出领取结局。 */
export function interpretQoderClaim(body         )                    {
  const result = parseQoderClaimResult(body)
  if (result.replayed === true) return { kind: 'already-claimed' }
  if (result.status !== undefined && result.status !== QODER_CLAIM_STATUS_CLAIMED) {
    return { kind: 'unexpected', message: `领取未成功（status=${result.status}）` }
  }
  return { kind: 'claimed', amount: result.amount ?? 0 }
}


//# sourceURL=src/vendor/qoder/qoder-credits.ts