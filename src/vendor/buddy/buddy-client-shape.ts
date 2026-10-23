/**
 * WorkBuddy 客户端出站形态（纯函数）。
 *
 * ## 事实来源
 *
 * 2026-10-23 对本机 WorkBuddy AI 国际版 5.5.2（内嵌 CLI 2.137.1）的真机抓包：
 * 用 `WORKBUDDY_CONFIG_DIR` 把自定义模型指到本地捕获服务器，真实二进制发一次
 * `POST /chat/completions`，拿到 35 个头 + 110KB body。记录见
 * `docs/WORKBUDDY-INTL-REQUEST.md`，脱敏样本在 `docs/workbuddy-intl-capture/`。
 *
 * 抓包里能直接读出的形态常量（改之前先回看样本，不要凭印象）：
 *
 *   x-ide-type / x-ide-name   CLI
 *   x-ide-version             2.137.1（= CLI 版本，不是桌面端产品版本 5.5.2）
 *   user-agent                CLI/2.137.1 WorkBuddy AI/2.137.1
 *   x-product                 SaaS
 *   accept                    application/json（流式由 body.stream 决定，不靠 Accept）
 *   x-codebuddy-request       1
 *   x-requested-with          XMLHttpRequest
 *   x-agent-type / -intent    main / craft
 *   x-request-id              与 x-conversation-message-id 同值（32 位十六进制）
 *   x-conversation-request-id 与 x-root-request-id 同值（每次会话稳定）
 *   x-stainless-*             openai-node SDK 指纹（package-version 6.25.0）
 *   traceparent / b3 / x-b3-* / x-trace-id   双格式链路头，trace-id = root request id
 *
 * 这些函数只产**值**，怎么拼进请求头由 `src/adapters/buddy.ts` 决定 —— 这样可以单测，
 * 也不会把传输细节和值生成缠在一起。
 */

import { createHash, randomUUID } from 'node:crypto'

/** 内嵌 CLI 版本（抓包 `x-ide-version` / UA 的版本段）。 */
export const CLI_IDE_VERSION = '2.137.1'

/** 国际版 CLI 的真实 UA。国内版是 CodeBuddy IDE，另一套，不在这里。 */
export const UA_CLI_INTL = `CLI/${CLI_IDE_VERSION} WorkBuddy AI/${CLI_IDE_VERSION}`

/** openai-node 版本（抓包 `x-stainless-package-version`）。 */
export const OPENAI_SDK_VERSION = '6.25.0'

/**
 * 客户端自带运行时版本（抓包 `x-stainless-runtime-version: v22.21.1`）。
 *
 * ⚠️ 用**抓包值**而不是 `process.versions.node`：真实客户端是 Electron 打包的
 * Node，任何机器上都是同一个版本；我们跑在宿主 Node 上（这里 v24.x），
 * 照实报等于自己声明「我不是那个客户端」。要改就改这个常量，别改调用点。
 */
export const CLIENT_NODE_VERSION = '22.21.1'

/** 抓包里 `x-agent-type` 的取值（主 agent）。 */
export const AGENT_TYPE_MAIN = 'main'

/** 抓包里 `x-agent-intent` 的取值（craft 模式；ask 模式才是 `ask`）。 */
export const AGENT_INTENT_CRAFT = 'craft'

/** sha256 十六进制。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** 取 sha256 前 32 位十六进制 —— 与客户端 request id 同形。 */
export function hex32(seed: string): string {
  return sha256Hex(seed).slice(0, 32)
}

/**
 * 由种子派生一个 **UUID v4 形态**的稳定 id。
 *
 * 为什么不用 `randomUUID()`：会话 id 必须按账号稳定（前缀缓存 + 「一次对话一个 id」
 * 的语义），而客户端发的是 UUID 形态（`bff4befa-1477-4313-85ab-bf9e436f4502`）。
 * 自己发 32 位无连字符的十六进制虽然也能通，但形态与真实客户端不一致 —— 这类差异
 * 正是风控最容易拿来做指纹的地方。
 *
 * 版本位 / 变体位按 RFC 4122 写死（`4` 与 `8..b`），其余位来自种子。
 */
export function uuidFromSeed(seed: string): string {
  const hex = hex32(seed).split('')
  hex[12] = '4'
  hex[16] = '89ab'[parseInt(hex[16] ?? '0', 16) % 4] ?? '8'
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/**
 * 每次请求一个新的 message / request id（32 位十六进制，无连字符）。
 *
 * 抓包里 `x-request-id` 与 `x-conversation-message-id` 是同一条 32 位十六进制，
 * 由客户端的 `crypto.randomUUID()` 去掉连字符得到（或等价实现）。
 */
export function newRequestId(): string {
  return randomUUID().replace(/-/g, '')
}

/** 一次请求一个新的 span id（16 位十六进制）。 */
export function newSpanId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * 链路追踪头（W3C + B3 双格式，客户端两个都发）。
 *
 * 抓包里的对应关系：
 * - `traceparent: 00-<traceId>-<spanId>-01`
 * - `b3: <traceId>-<spanId>-1-<parentSpanId>`
 * - `x-b3-traceid` / `x-b3-parentspanid` / `x-b3-spanid` / `x-b3-sampled: 1`
 * - `x-trace-id: <traceId>`
 *
 * `traceId` 用的是**本次会话的 root request id**（抓包里 x-trace-id 与
 * x-conversation-request-id 同值），所以同一次对话的链路天然串起来。
 */
export function traceHeadersOf(traceId: string, spanId: string, parentSpanId: string): Record<string, string> {
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'x-b3-traceid': traceId,
    'x-b3-parentspanid': parentSpanId,
    'x-b3-spanid': spanId,
    'x-b3-sampled': '1',
    'x-trace-id': traceId,
  }
}

/**
 * openai-node 的 stainless 指纹头。
 *
 * 客户端每个模型请求都带这 7 个头；少一组不会 4xx，但它们是「这请求确实是
 * OpenAI SDK 发的」的最直接证据。
 *
 * 版本段默认用抓包里的**客户端内置运行时**（`v22.21.1`），平台/架构取当前进程的
 * 真实值（客户端在什么机器上跑就报什么，这两项本来就该跟机器走）。
 */
export function stainlessHeadersOf(
  nodeVersion: string = CLIENT_NODE_VERSION,
  platform: string = process.platform,
  arch: string = process.arch,
): Record<string, string> {
  const os = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'MacOS' : 'Linux'
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch
  return {
    'x-stainless-arch': cpu,
    'x-stainless-lang': 'js',
    'x-stainless-os': os,
    'x-stainless-package-version': OPENAI_SDK_VERSION,
    'x-stainless-retry-count': '0',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': `v${nodeVersion}`,
  }
}
