/**
 * 五个待实现 Agent 的骨架声明。
 *
 * 每个条目都是**一个 Object 字面量**：加一个新 Agent 只在这里加一项，
 * 再去 `adapters/index.ts` 的数组里带上它 —— 核心调度代码零改动。
 *
 * 下方注释里的上游形态是公开可查的常识性描述（留作实现时的起点），
 * **没有**写任何私有/逆向得到的东西；真正实现时应当以官方文档为准。
 */

import { createSkeleton,                   } from './skeleton.js'
                                            

/** Qoder（阿里云旗下的 AI 编程工具）。 */
const QODER               = {
  id: 'qoder',
  name: 'Qoder',
  doc: 'https://qoder.com/',
  upstream: 'Qoder 桌面/网页端，接口为自有 REST + SSE，鉴权通常是登录后的 bearer 或 cookie；有每日签到与积分（Credits）体系。',
  credentialHint: '登录 Qoder 后从浏览器/客户端的请求头里取 authorization 或 cookie，粘贴到本插件的账号里。',
  known: { checkIn: true, quota: true, models: true, chat: true, reasoning: true },
}

/** Qoder 国内版（与 Qoder 国际版是两套独立域名与账号体系）。 */
const QODER_CN               = {
  id: 'qoder-cn',
  name: 'Qoder CN',
  doc: 'https://qoder.com/',
  upstream: 'Qoder 国内站，独立域名与账号体系，接口形状与 Qoder 相近但路径/字段不同；有签到与积分倍率概念。',
  credentialHint: '国内站登录后的凭证（bearer / cookie）。与 Qoder 国际版的账号不通用。',
  known: { checkIn: true, quota: true, models: true, chat: true, reasoning: true },
}

/** Trae（字节跳动的 AI IDE）。 */
const TRAE               = {
  id: 'trae',
  name: 'Trae',
  doc: 'https://www.trae.ai/',
  upstream: 'Trae IDE / SOLO，请求走自有网关，鉴权通常是登录态 token；模型列表由服务端按账号下发。',
  credentialHint: '登录 Trae 后的 access token（请求头里的 authorization）。',
  known: { quota: true, models: true, chat: true },
}

/** WorkBuddy（国内版）。 */
const WORKBUDDY               = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  doc: 'https://www.workbuddy.ai/',
  upstream: 'WorkBuddy 国内站，自有 REST 接口；有按日发放的额度/积分，常见签到式领取。',
  credentialHint: '登录后的 bearer token 或 cookie。',
  known: { checkIn: true, quota: true, models: true, chat: true },
}

/** WorkBuddy 国际版（与国内版分开的账号体系）。 */
const WORKBUDDY_INTL               = {
  id: 'workbuddy-intl',
  name: 'WorkBuddy International',
  doc: 'https://www.workbuddy.ai/',
  upstream: 'WorkBuddy 国际站，账号与国内站不通用；接口为自有 REST + SSE。',
  credentialHint: '国际站登录后的 bearer token 或 cookie。',
  known: { quota: true, models: true, chat: true, reasoning: true },
}

/** 全部骨架。 */
export function builtinSkeletons()                {
  return [QODER, QODER_CN, TRAE, WORKBUDDY, WORKBUDDY_INTL].map((spec) => createSkeleton(spec))
}

/** 供测试断言「五个骨架都在」。 */
export const SKELETON_IDS = [QODER.id, QODER_CN.id, TRAE.id, WORKBUDDY.id, WORKBUDDY_INTL.id]         


//# sourceURL=D:\AI\DeepseekPlugin\dsh-multi-agent-gateway\src\adapters\skeletons.ts