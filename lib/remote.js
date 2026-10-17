/**
 * 宿主 → 浏览器的 Remote 通道（客户端配置页的数据来源）。
 *
 * ## 为什么手写描述符
 *
 * DSH 的 Remote 走 Typert：宿主 `@Remote` 装饰器 → 构建期生成 `/remote` 产物 →
 * 客户端 `ctx.remote.$mount()`。那条流水线只在**源码版仓库**里存在，插件作者拿不到。
 * 但协议留了**运行时入口**：
 *
 * > any other owner calls `ctx.typert.register(contribution)` directly
 * > and receives the exact disposer that withdraws it.
 *
 * ## 四条实测过的契约（错一条就是「界面上什么都看不到」）
 *
 * 1. 贡献形状：`{ package, face: 'host'|'client', schemas, ... }`；
 *    **宿主读 `invocations`，客户端读 `descriptors`** —— 同一份描述符数组，
 *    字段名不同。写反了宿主会**静默收下**，所以装完必须回读自校验。
 * 2. codec 不要求 zod：只要 `{ mode: 'strict', typeSymbol, create: () => ({ parse }) }`。
 * 3. 路由要求 Service 带 `typertRemote` 绑定（`Object.freeze({service, serviceKey, namespace})`）。
 * 4. **每个参数都要 `source: 'json'`** —— 否则宿主把它当 lookup 参数去要 provider key，
 *    表现为「没参数的端点正常，一按按钮就报错」。
 *
 * ## 硬规则
 *
 * 返回给浏览器的**任何**东西都先过 `redactDeep`：凭证永远不出宿主进程。
 */

import { redactDeep } from './core/crypto.js'
import { ERROR_LABELS } from './core/errors.js'
                                                

/** 描述符归属的包名（与 npm 包名一致）。 */
export const REMOTE_PACKAGE = 'dsh-multi-agent-gateway'
/** 宿主侧 Cordis Service 键。 */
export const REMOTE_SERVICE_KEY = 'multiAgentGatewayRemote'
/** 客户端看到的命名空间：`ctx.remote.multiAgentGateway.<method>()`。 */
export const REMOTE_NAMESPACE = 'multiAgentGateway'

/**
 * 全部端点。名字即客户端方法名（`gateway/state` → `remote.multiAgentGateway.state()`）。
 *
 * 分成四类：
 *   - **读**：`state` / `logs` / `taskLog` / `models`
 *   - **账号**：`addAccount` / `updateAccount` / `removeAccount` / `setCredentials` / `testAccount`
 *   - **动作**：`checkIn` / `refreshQuota` / `runTasks` / `resumeAccount` / `resetHealth` / `tick`
 *   - **配置**：`routing`（读/写路由策略的运行时视图）
 */
export const REMOTE_ENDPOINTS = Object.freeze({
  state: `${REMOTE_NAMESPACE}/state`,
  logs: `${REMOTE_NAMESPACE}/logs`,
  taskLog: `${REMOTE_NAMESPACE}/taskLog`,
  models: `${REMOTE_NAMESPACE}/models`,
  addAccount: `${REMOTE_NAMESPACE}/addAccount`,
  updateAccount: `${REMOTE_NAMESPACE}/updateAccount`,
  removeAccount: `${REMOTE_NAMESPACE}/removeAccount`,
  setCredentials: `${REMOTE_NAMESPACE}/setCredentials`,
  testAccount: `${REMOTE_NAMESPACE}/testAccount`,
  checkIn: `${REMOTE_NAMESPACE}/checkIn`,
  refreshQuota: `${REMOTE_NAMESPACE}/refreshQuota`,
  runTasks: `${REMOTE_NAMESPACE}/runTasks`,
  resumeAccount: `${REMOTE_NAMESPACE}/resumeAccount`,
  resetHealth: `${REMOTE_NAMESPACE}/resetHealth`,
  tick: `${REMOTE_NAMESPACE}/tick`,
  clearTaskLog: `${REMOTE_NAMESPACE}/clearTaskLog`,
  /** OAuth 设备码登录：发起（返回 user_code 与授权链接，**不含 device_code**）。 */
  loginStart: `${REMOTE_NAMESPACE}/loginStart`,
  /** OAuth 设备码登录：轮询（成功后由宿主建账号，token 不回浏览器）。 */
  loginPoll: `${REMOTE_NAMESPACE}/loginPoll`,
  /** 取消一次登录会话。 */
  loginCancel: `${REMOTE_NAMESPACE}/loginCancel`,
})

/** 客户端页面要的方法集合（宿主要一一实现）。 */
                                       
                                     
                                                             
                                                                
                                                                                  
                                                                        
                                                                           
                                                                           
                                                                            
                                                                         
                                                                     
                                                                          
                                                                      
                                                                           
                                                                         
                                                                  
                                                                          
                                                                        
                                                                       
                                                                         
 

/** 造一个 strict codec（`create().parse(value)` 会在**宿主**解码参数时真的被调用）。 */
function strict(typeSymbol        , check                             )   
                
                    
                                                      
  {
  return { mode: 'strict', typeSymbol, create: () => ({ parse: (value) => check(value) }) }
}

/** 一个普通参数（**必须有 `source: 'json'`**）。 */
function jsonParam(name        , codec                           )                          {
  return { name, wire: name, source: 'json', codec }
}

const asObject = (value         )                          => {
  if (value === null || value === undefined) return {}
  if (typeof value !== 'object') throw new Error('期望一个对象参数')
  return value                           
}

const asJson = (value         )          => value

/** 描述符列表。 */
export function remoteDescriptors()                                 {
  const t = (name        )         => `${REMOTE_PACKAGE}/types#${name}`
  const base = (method        )                          => ({
    id: `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/${method}`,
    service: REMOTE_SERVICE_KEY,
    namespace: REMOTE_NAMESPACE,
    method,
    implementation: method,
    invocation: { kind: 'direct' },
  })
  const withInput = (method        )                          => ({
    ...base(method),
    parameters: [jsonParam('input', strict(t('Request'), asObject))],
    result: strict(t('Response'), asJson),
  })
  return [
    { ...base('state'), parameters: [], result: strict(t('State'), asJson) },
    withInput('logs'),
    withInput('taskLog'),
    withInput('models'),
    withInput('addAccount'),
    withInput('updateAccount'),
    withInput('removeAccount'),
    withInput('setCredentials'),
    withInput('testAccount'),
    withInput('checkIn'),
    withInput('refreshQuota'),
    withInput('runTasks'),
    withInput('resumeAccount'),
    withInput('resetHealth'),
    withInput('tick'),
    withInput('clearTaskLog'),
    withInput('loginStart'),
    withInput('loginPoll'),
    withInput('loginCancel'),
  ]
}

/**
 * 一份贡献。**两侧字段名不同**（宿主读 `invocations`，客户端读 `descriptors`）。
 *
 * @param face - 哪一侧的贡献。同 package 同 face 会被注册表判重，所以必须区分。
 */
export function remoteContribution(face                   )                          {
  const shared = { package: REMOTE_PACKAGE, face, schemas: []              }
  return face === 'host'
    ? { ...shared, invocations: remoteDescriptors() }
    : { ...shared, descriptors: remoteDescriptors() }
}

/** 造宿主侧 Service（`descriptor.service` 指向的那个对象）。 */
export function createRemoteService(impl                      )                          {
  const service                          = {}
  for (const key of Object.keys(REMOTE_ENDPOINTS)                                        ) {
    service[key] = async (input         )                   => {
      try {
        const value = await (impl[key]                             )(input ?? {})
        // 出口统一脱敏：凭证不许离开宿主进程。
        return redactDeep(value)
      } catch (error) {
        return {
          ok: false,
          error: redactDeep(error instanceof Error ? error.message : String(error)),
        }                                  
      }
    }
  }
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey: REMOTE_SERVICE_KEY, namespace: REMOTE_NAMESPACE }),
    enumerable: false,
  })
  return service
}

/** 最小上下文形状（避免硬依赖 cordis 类型）。 */
                                       
                                                                               
 

                              
                                                            
                                                     
                                                                   
            
                                                 
                                                   
   
 

/**
 * 装上宿主侧能力：**provide 服务** + **注册贡献** + **自校验**。
 *
 * 第三步不能省：写错字段名时宿主会静默收下，界面上表现为「卡片不出现」，
 * 而日志里什么都没有 —— 那是最难查的一类问题。这里注册完立刻回读：
 * `typert.local.get('<ns>/<method>')` 拿不到就判失败。
 */
export function installRemoteHost(
  ctx                      ,
  impl                      ,
  log                                                                                                      ,
)                                                         {
  if (typeof ctx.inject !== 'function') {
    return { ok: false, reason: '上下文没有 inject（拿不到 typert 服务）' }
  }
  let dispose                      = null
  let failure                = null
  try {
    ctx.inject(['typert'], (child             ) => {
      try {
        const service = createRemoteService(impl)
        const teardown                    = []
        child.effect?.(() => {
          if (typeof child.provide === 'function') child.provide(REMOTE_SERVICE_KEY, service)
          else if (typeof child.reflect?.provide === 'function') child.reflect.provide(REMOTE_SERVICE_KEY, service)
          else throw new Error('宿主上下文既没有 provide 也没有 reflect.provide')
        }, `${REMOTE_PACKAGE}: provide ${REMOTE_SERVICE_KEY}`)
        const registered = child.typert?.register?.(remoteContribution('host'))
        if (typeof registered === 'function') teardown.push(registered              )

        const missing           = []
        for (const [method, endpoint] of Object.entries(REMOTE_ENDPOINTS)) {
          let found         
          try {
            found = child.typert?.local?.get?.(endpoint)
          } catch (error) {
            missing.push(`${endpoint}（查表抛错：${error instanceof Error ? error.message : String(error)}）`)
            continue
          }
          if (found === undefined || found === null) missing.push(`${endpoint}（method=${method}）`)
        }
        if (missing.length > 0) {
          throw new Error(
            `贡献注册后端点仍不可路由：${missing.join('、')} —— 宿主读的是 contribution.invocations（客户端才是 descriptors）`,
          )
        }
        dispose = () => {
          for (const off of teardown.reverse()) {
            try {
              off()
            } catch {
              // 卸载期的失败只记不抛。
            }
          }
        }
        log.info(`客户端通道已装上：${Object.keys(REMOTE_ENDPOINTS).length} 个端点`)
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    })
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (failure !== null) return { ok: false, reason: failure }
  return { ok: true, ...(dispose === null ? {} : { dispose }) }
}

// ───────────────────────── 给 UI 的快照构造（纯函数，可单测） ─────────────────────────

/** 日志条目 → 客户端可读形状。 */
export function publicLogs(entries            )                                 {
  return entries.map((entry) => ({
    at: entry.at,
    level: entry.level,
    scope: entry.scope,
    message: entry.message,
    detail: entry.detail === undefined ? '' : entry.detail,
  }))
}

/** 错误分类 → 中文标签（UI 显示）。 */
export function errorLabel(kind                    )         {
  if (kind === undefined) return ERROR_LABELS.unknown
  return (ERROR_LABELS                          )[kind] ?? kind
}


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\remote.ts