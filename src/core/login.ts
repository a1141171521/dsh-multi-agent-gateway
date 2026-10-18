/**
 * **通用登录会话**：适配器只提供「拿一个授权链接」和「问一次结果」两步，
 * 宿主负责会话状态、过期与落盘。
 *
 * 为什么抽象成两步而不是让适配器自己轮询：
 *
 *   1. 轮询的节奏由**界面**决定（用户点了「刷新登录状态」才问一次），
 *      适配器不该自己起定时器 —— 用户关掉页面后还在后台打上游是浪费；
 *   2. `state` / `device_code` 这类中间凭据**只留在宿主进程内**，
 *      永远不回浏览器（浏览器只拿到 authUrl 与展示用文案）。
 *
 * 三种平台的形态都能塞进这个接口：
 *   - OpenCode：设备码（userCode + verificationUrl）
 *   - WorkBuddy：external-link（authUrl + state）
 *   - Qoder：设备码 + PKCE（authUrl + state）
 */

import type { AccountCredentials } from './types.js'

/** 发起登录的产物。 */
export interface LoginStartResult {
  /** 让用户在浏览器打开的地址。 */
  authUrl: string
  /** 给用户看的设备码（没有就是 undefined）。 */
  userCode?: string
  /** 有效期（秒）。 */
  expiresInSec: number
  /** 宿主内部保留的会话状态（**不回浏览器**）。 */
  state: unknown
}

/** 问一次登录结果。 */
export interface LoginPollResult {
  status: 'pending' | 'ready' | 'failed' | 'expired'
  /** 给用户看的话（失败原因 / 等待提示）。 */
  message?: string
  /** `ready` 时给出的凭证，由宿主加密落盘。 */
  credentials?: AccountCredentials
  /** 账号默认标签（昵称等；没有就用「<平台> 账号」）。 */
  label?: string
}

/** 适配器可选实现的登录能力。 */
export interface LoginCapability {
  /** 发起一次登录；返回浏览器地址与会话状态。 */
  beginLogin(ctx: unknown): Promise<LoginStartResult>
  /** 问一次结果（幂等；`pending` 表示用户还没完成）。 */
  pollLogin(state: unknown, ctx: unknown): Promise<LoginPollResult>
}
