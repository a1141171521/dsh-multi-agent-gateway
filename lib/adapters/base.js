/**
 * 适配器骨架基类。
 *
 * 提供**两样东西**，让新增 Agent 的成本降到最低：
 *
 *   1. 一套**安全的默认实现**：默认全部返回「上游不支持」而不是抛错。
 *      这保证一个只写了一半的适配器也不会把 DSH 弄崩，而且每一处
 *      「没实现」都在 UI 上看得见（硬规则：不许静默失败）。
 *   2. 一套**通用工具**：`getCredentials()` / `detectError()` /
 *      `validateCredentials()` 的默认实现，OpenCode 那类 OpenAI 兼容上游
 *      基本不用重写。
 *
 * 新增一个 Agent 的最小工作量（完整例子见 `docs/EXTENDING.md`）：
 *
 * ```ts
 * export class MyAdapter extends BaseAdapter {
 *   constructor() {
 *     super({
 *       id: 'my-agent',
 *       name: 'My Agent',
 *       doc: 'https://example.com/api',
 *       capabilities: { checkIn: false, quota: true, models: true, tasks: false, chat: true, reasoning: true, source: 'probe' },
 *     })
 *   }
 *   override async getModelMetaList(record, ctx) { ... }
 *   override async getQuota(record, ctx) { ... }
 *   override async *requestChatStream(payload, record, ctx, signal) { ... }
 * }
 * ```
 */

import { classify } from '../core/errors.js'
import { authHeaders } from '../core/http.js'
import { unsupportedReason } from './messages.js'
             
                     
                
                 
               
                    
              
                
            
            
                
              
             
             
                         

/** 造适配器需要的静态信息。 */
                                  
            
              
                                        
              
                          
                         
                                 
                                               
                       
 

export class BaseAdapter                         {
           id        
           name        
           doc                    
           credentialHint                    
           capabilities                   
  /** `false` = 骨架适配器（本期未实现业务逻辑）。 */
           implemented         

  constructor(init                 ) {
    this.id = init.id
    this.name = init.name
    this.doc = init.doc
    this.credentialHint = init.credentialHint
    this.capabilities = init.capabilities
    this.implemented = init.implemented ?? false
  }

  // ───────────────────── 凭证 ─────────────────────

  /** 默认：直接返回账号里存的凭证。需要派生（例如把 token 拆进自定义头）的子类可覆盖。 */
  async getCredentials(record               )                              {
    return record.credentials
  }

  /**
   * 默认校验：只检查「有没有凭证」。
   *
   * 真正的有效性由子类实现（一次轻量的真实请求）。**默认实现不撒谎**：
   * 它只说「本地看起来有凭证」，并把这句话写清楚。
   */
  async validateCredentials(
    record               ,
    _ctx                ,
  )                                                               {
    const credentials = record.credentials
    if (typeof credentials.token === 'string' && credentials.token !== '') {
      return { ok: true, message: '本地已存 token（未向上游验证）' }
    }
    if (typeof credentials.cookie === 'string' && credentials.cookie !== '') {
      return { ok: true, message: '本地已存 cookie（未向上游验证）' }
    }
    return { ok: false, message: '没有 token / cookie，请先填凭证', kind: 'auth' }
  }

  // ───────────────────── 基础每日任务 ─────────────────────

  async checkIn(_record               , _ctx                )                         {
    return { ok: false, supported: false, message: unsupportedReason(this.name, '每日签到'), at: Date.now() }
  }

  async getQuota(record               , _ctx                )                         {
    return {
      accountId: record.id,
      unit: 'unknown',
      fetchedAt: Date.now(),
      error: unsupportedReason(this.name, '额度查询'),
    }
  }

  async getModelMetaList(_record               , _ctx                )                       {
    return []
  }

  // ───────────────────── 活动任务 ─────────────────────

  async fetchAvailableTasks(_record               , _ctx                )                        {
    return []
  }

  async executeTask(task            , _record               , _ctx                )                      {
    return {
      taskId: task.id,
      ok: false,
      message: unsupportedReason(this.name, '活动任务执行'),
      kind: 'unsupported',
      retryable: false,
      at: Date.now(),
    }
  }

  async checkTaskStatus(taskId        , _record               , _ctx                )                      {
    return {
      taskId,
      ok: false,
      message: unsupportedReason(this.name, '任务状态查询'),
      kind: 'unsupported',
      retryable: false,
      at: Date.now(),
    }
  }

  // ───────────────────── 对话 ─────────────────────

  // eslint-disable-next-line require-yield
  async *requestChatStream(
    _payload             ,
    _record               ,
    _ctx                ,
    _signal             ,
  )                             {
    yield {
      type: 'error',
      failure: {
        kind: 'unsupported',
        message: unsupportedReason(this.name, '对话转发'),
        at: Date.now(),
      },
    }
  }

  // ───────────────────── 错误分类 ─────────────────────

  /** 默认就是核心分类器；有私有错误码的子类覆盖它。 */
  detectError(status        , body         , headers         )            {
    return classify(status, body, headers)
  }

  // ───────────────────── 给子类的工具 ─────────────────────

  /** 凭证 → 请求头。 */
            headersOf(credentials                    )                         {
    return authHeaders(credentials)
  }
}


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\adapters\base.ts