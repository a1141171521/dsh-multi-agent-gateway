/**
 * 图片生成（文字 → 图片）。
 *
 * ## 为什么单独一层
 *
 * 生图跟「多账号路由」没有关系：它不挑账号、不走 `core/router.ts`、不落 `accounts.enc.json`。
 * 塞进适配器体系只会让 `AgentAdapter` 接口多出一堆没人实现的方法。所以这里是**一个独立的
 * 小模块**，`tools.ts` 只做参数校验与结果渲染。
 *
 * ## 接口形状（OpenAI Images 兼容）
 *
 * ```
 * POST {baseUrl}/v1/images/generations
 * Authorization: Bearer <key>
 * { "model": "...", "prompt": "...", "n": 1, "size": "1024x1024", "response_format": "b64_json" }
 * ```
 *
 * ⚠️ **`response_format` 必须是 `b64_json`。** 用 `url` 时 ClawHUD 返回的是它自己的
 * 内网直链（`http://100.107.100.40:10009/v1/media/images/img_xxx`，Tailscale `100.x` 段），
 * 本机根本连不上 —— 实测 `Invoke-WebRequest` 直接「无法连接到远程服务器」。
 * 也就是说 url 模式**只在和那台机器同一个 tailnet 里**才有意义；默认一律走 base64，
 * 拿到字节自己落盘，不依赖任何回源。
 *
 * ## 密钥从哪里来（三级回退）
 *
 *   1. 插件配置 `imageGen.apiKey`（设置页可写，`volatile`）；
 *   2. 进程环境变量 `CLAWHUD_API_KEY` / `IMAGE_API_KEY` / `OPENAI_API_KEY`；
 *   3. `.env` 文件（插件目录上一级 → 插件目录 → 数据目录 → `~/.dsh`）。
 *
 * 三级都为空时**不抛错**：工具会返回「没配密钥」，并带上查过哪些路径，
 * 让用户知道该改哪里，而不是看一条 `401 Unauthorized` 猜半天。
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ResolvedImageGenConfig } from './types.js'

/** 默认上游（ClawHUD）。 */
export const DEFAULT_IMAGE_BASE_URL = 'https://api.clawhud.com/'

/** 默认模型（本机实测出货的就是这个）。 */
export const DEFAULT_IMAGE_MODEL = 'grok-imagine-image-2.0'

/** 默认尺寸。 */
export const DEFAULT_IMAGE_SIZE = '1024x1024'

/** 一次最多生成几张（上游没说上限，这里自己收口，免得一次请求打太久）。 */
export const MAX_IMAGE_COUNT = 4

/** 无密钥时要查的环境变量名，按优先级排列。 */
export const IMAGE_KEY_ENV_NAMES: readonly string[] = ['CLAWHUD_API_KEY', 'IMAGE_API_KEY', 'OPENAI_API_KEY']

/** 配置输入形状（`config.ts` 里 `imageGen` 段的静态类型）。 */
export interface ImageGenConfigInput {
  enabled?: unknown
  baseUrl?: unknown
  apiKey?: unknown
  model?: unknown
  size?: unknown
  outputDir?: unknown
  timeoutMs?: unknown
  envFile?: unknown
}

/** 一次生成的请求参数。 */
export interface GenerateImageRequest {
  prompt: string
  /** 覆盖配置里的尺寸（`1024x1024` 这类）。 */
  size?: string
  /** 覆盖配置里的模型。 */
  model?: string
  /** 生成几张（1~{@link MAX_IMAGE_COUNT}）。 */
  n?: number
  /** 覆盖落盘目录。 */
  outputDir?: string
  /** 只生成一张时，指定完整落盘路径。 */
  savePath?: string
}

/** 落盘后的一个文件。 */
export interface GeneratedImageFile {
  path: string
  bytes: number
  mimeType: string
  sha256: string
}

/** 生成结果（成功与失败同一个形状，`ok` 区分）。 */
export interface GenerateImageOutcome {
  ok: boolean
  model: string
  prompt: string
  elapsedMs: number
  files: GeneratedImageFile[]
  /** 上游改写后的提示词（有些平台会返回，ClawHUD 目前返回空串）。 */
  revisedPrompt?: string
  /** 落盘目录。 */
  outputDir?: string
  /** 失败原因（给人看的一句话）。 */
  error?: string
  /** 上游 HTTP 状态码（网络层失败时没有）。 */
  status?: number
  /** 上游返回的正文片段（排错用，已截断）。 */
  detail?: string
  /** 密钥来源：config / env / env-file / none。 */
  apiKeySource?: string
}

/** 从任意输入读字符串（`volatile` 包装、undefined 都能吃）。 */
function textOf(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return textOf((value as { get: () => unknown }).get(), fallback)
  }
  return fallback
}

/** 从任意输入读布尔。 */
function boolOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return boolOf((value as { get: () => unknown }).get(), fallback)
  }
  return fallback
}

/** 从任意输入读数字。 */
function numOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return numOf((value as { get: () => unknown }).get(), fallback)
  }
  return fallback
}

/**
 * 插件根目录。
 *
 * `src/core/imagegen.ts` 与 `lib/core/imagegen.js` **相对根的深度相同**，
 * 所以同一个表达式在源码态和构建产物里都对 —— 不存在「开发时找得到、装完找不到」。
 */
export function pluginRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/**
 * 解析一份 `.env` 文本。
 *
 * 只认最朴素的 `KEY=VALUE`：`#` 开头是注释，允许行内两侧空格，允许整体被单/双引号包住。
 * **不做**变量展开、不支持多行值 —— 这不是 dotenv 的替代品，只是把用户手写的几行读进来。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    // 允许 `export KEY=VALUE`（从 shell 脚本里复制过来时常见）。
    const body = line.startsWith('export ') ? line.slice(7).trim() : line
    const at = body.indexOf('=')
    if (at <= 0) continue
    const key = body.slice(0, at).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = body.slice(at + 1).trim()
    if (value.length >= 2) {
      const first = value[0]
      const last = value[value.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * 依次尝试的 `.env` 路径（去重，保持顺序）。
 *
 * 顺序就是优先级：显式配置的 `envFile` 永远第一个。
 */
export function envFileCandidates(input: { envFile?: unknown; dataDir?: string }): string[] {
  const out: string[] = []
  const push = (path: string): void => {
    if (path !== '' && !out.includes(path)) out.push(path)
  }
  const explicit = textOf(input.envFile, '').trim()
  if (explicit !== '') push(isAbsolute(explicit) ? explicit : resolve(pluginRoot(), explicit))
  // 插件目录上一级：本项目把 `.env` 就放在 `D:\AI\DeepseekPlugin\.env`（插件在它的子目录里）。
  push(resolve(pluginRoot(), '..', '.env'))
  push(join(pluginRoot(), '.env'))
  if (typeof input.dataDir === 'string' && input.dataDir !== '') push(join(input.dataDir, '.env'))
  push(join(homedir(), '.dsh', '.env'))
  return out
}

/** 读第一个存在的 `.env`，返回它的键值与路径（都没有就是空）。 */
export function loadEnvFile(input: { envFile?: unknown; dataDir?: string }): {
  path: string
  values: Record<string, string>
} {
  for (const path of envFileCandidates(input)) {
    try {
      if (!existsSync(path)) continue
      return { path, values: parseEnvFile(readFileSync(path, 'utf8')) }
    } catch {
      // 权限 / 编码问题：换下一个候选，别让「读不到 .env」挡掉整个工具。
    }
  }
  return { path: '', values: {} }
}

/**
 * 解析运行期配置。
 *
 * `known env` 的优先级：显式配置 > 进程环境变量 > `.env`。
 * 返回里的 `apiKeySource` 是**诊断用的**：用户问「为什么还是 401」时，
 * 一眼就能看出密钥到底是从哪儿取的。
 */
export function resolveImageGenConfig(
  input: ImageGenConfigInput | undefined,
  options: { dataDir: string },
): ResolvedImageGenConfig {
  const configKey = textOf(input?.apiKey, '').trim()
  let apiKey = configKey
  let apiKeySource: ResolvedImageGenConfig['apiKeySource'] = configKey === '' ? 'none' : 'config'
  if (apiKey === '') {
    for (const name of IMAGE_KEY_ENV_NAMES) {
      const value = process.env[name]
      if (typeof value === 'string' && value.trim() !== '') {
        apiKey = value.trim()
        apiKeySource = 'env'
        break
      }
    }
  }
  if (apiKey === '') {
    const file = loadEnvFile({ envFile: input?.envFile, dataDir: options.dataDir })
    for (const name of IMAGE_KEY_ENV_NAMES) {
      const value = file.values[name]
      if (typeof value === 'string' && value.trim() !== '') {
        apiKey = value.trim()
        apiKeySource = 'env-file'
        break
      }
    }
  }
  return {
    enabled: boolOf(input?.enabled, true),
    baseUrl: textOf(input?.baseUrl, '').trim() || DEFAULT_IMAGE_BASE_URL,
    apiKey,
    apiKeySource,
    model: textOf(input?.model, '').trim() || DEFAULT_IMAGE_MODEL,
    size: textOf(input?.size, '').trim() || DEFAULT_IMAGE_SIZE,
    // 留空 = 运行时用 `<dataDir>/images`（这里不拼，免得配置里存了绝对路径又跟着机器走）。
    outputDir: textOf(input?.outputDir, '').trim(),
    timeoutMs: Math.max(5000, numOf(input?.timeoutMs, 180_000)),
    envFile: textOf(input?.envFile, '').trim(),
    dataDir: options.dataDir,
  }
}

/**
 * 拼出 `images/generations` 的完整地址。
 *
 * 用户可能把 base 写成 `https://x/`、`https://x`、`https://x/v1` 三种样子，
 * 全都得能落到同一个端点上。
 */
export function imagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') throw new Error('图片接口 baseUrl 为空')
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/images/generations`
  return `${trimmed}/v1/images/generations`
}

/** mime → 扩展名。认不出来的按 jpg 存（ClawHUD 目前只回 jpeg）。 */
export function extensionFor(mimeType: string): string {
  const mime = mimeType.toLowerCase()
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  return 'jpg'
}

/** 本地时间戳 `20261031-230732`（文件名用，人一眼能看出是哪天生成的）。 */
export function stampOf(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** 截断过长的上游正文（错误详情不要塞满整个上下文）。 */
function clip(text: string, limit = 800): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`
}

/** 从上游 JSON 里挖出错误信息（各家字段名不太一样，能捞就捞）。 */
function errorMessageOf(json: unknown): string {
  if (json === null || typeof json !== 'object') return ''
  const record = json as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  if (typeof record.message === 'string') return record.message
  return ''
}

/**
 * 生图主流程：请求 → 拿 base64 → 落盘。
 *
 * 不抛异常：任何失败都折成 `{ ok: false, error }`，因为调用方是工具，
 * 工具抛错在界面上只剩一句 `Error: ...`，看不到「查了哪些 .env」「上游说了什么」。
 */
export async function generateImages(
  config: ResolvedImageGenConfig,
  request: GenerateImageRequest,
  log?: (message: string) => void,
): Promise<GenerateImageOutcome> {
  const startedAt = Date.now()
  const prompt = String(request.prompt ?? '').trim()
  const model = (request.model ?? '').trim() || config.model
  const size = (request.size ?? '').trim() || config.size
  const count = Math.min(MAX_IMAGE_COUNT, Math.max(1, Math.floor(request.n ?? 1)))
  const base: GenerateImageOutcome = {
    ok: false,
    model,
    prompt,
    elapsedMs: 0,
    files: [],
    apiKeySource: config.apiKeySource,
  }

  if (!config.enabled) {
    return { ...base, elapsedMs: Date.now() - startedAt, error: '图片生成在配置里被关闭了（imageGen.enabled: false）' }
  }
  if (prompt === '') {
    return { ...base, elapsedMs: Date.now() - startedAt, error: 'prompt 不能为空' }
  }
  if (config.apiKey === '') {
    const tried = envFileCandidates({ envFile: config.envFile, dataDir: config.dataDir })
    return {
      ...base,
      elapsedMs: Date.now() - startedAt,
      error:
        '没有可用的 API key：配置 imageGen.apiKey、环境变量 ' +
        `${IMAGE_KEY_ENV_NAMES.join(' / ')}、以及这些 .env 都没读到。查过：${tried.join(' | ')}`,
    }
  }

  let endpoint: string
  try {
    endpoint = imagesEndpoint(config.baseUrl)
  } catch (error) {
    return { ...base, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) }
  }

  const payload = {
    model,
    prompt,
    n: count,
    size,
    // 见文件头：url 模式拿到的是上游内网直链，本机取不回来。
    response_format: 'b64_json',
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  let response: Response
  try {
    log?.(`生图请求 → ${endpoint}（${model}，${size}×${count}）`)
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
    return {
      ...base,
      elapsedMs: Date.now() - startedAt,
      error: aborted ? `请求超时（${config.timeoutMs} ms）` : `请求失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timer)
  }

  const bodyText = await response.text().catch(() => '')
  if (!response.ok) {
    let message = `上游返回 HTTP ${response.status}`
    try {
      const parsed = JSON.parse(bodyText) as unknown
      const detail = errorMessageOf(parsed)
      if (detail !== '') message = `上游返回 HTTP ${response.status}：${detail}`
    } catch {
      // 不是 JSON，就把正文截一段贴出来。
    }
    return { ...base, elapsedMs: Date.now() - startedAt, error: message, status: response.status, detail: clip(bodyText) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return {
      ...base,
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      error: '上游返回的不是 JSON',
      detail: clip(bodyText),
    }
  }

  const record = (parsed ?? {}) as Record<string, unknown>
  const items = Array.isArray(record.data) ? record.data : []
  if (items.length === 0) {
    return {
      ...base,
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      error: errorMessageOf(parsed) || '上游没有返回图片（data 为空）',
      detail: clip(bodyText),
    }
  }

  const outputDir = request.outputDir?.trim() || config.outputDir || join(config.dataDir, 'images')
  const files: GeneratedImageFile[] = []
  let revisedPrompt = ''
  const failures: string[] = []

  for (let index = 0; index < items.length; index += 1) {
    const item = (items[index] ?? {}) as Record<string, unknown>
    if (revisedPrompt === '' && typeof item.revised_prompt === 'string') revisedPrompt = item.revised_prompt
    const mimeType = typeof item.mime_type === 'string' && item.mime_type !== '' ? item.mime_type : 'image/jpeg'

    let bytes: Buffer | null = null
    const b64 = typeof item.b64_json === 'string' ? item.b64_json : ''
    if (b64 !== '') {
      try {
        bytes = Buffer.from(b64, 'base64')
      } catch (error) {
        failures.push(`第 ${index + 1} 张 base64 解码失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
    } else if (typeof item.url === 'string' && item.url !== '') {
      // 兜底：万一以后上游回了能访问的直链。取不回来时把「为什么」写清楚。
      try {
        const controller2 = new AbortController()
        const timer2 = setTimeout(() => controller2.abort(), config.timeoutMs)
        try {
          const download = await fetch(item.url, { signal: controller2.signal })
          if (!download.ok) throw new Error(`HTTP ${download.status}`)
          bytes = Buffer.from(await download.arrayBuffer())
        } finally {
          clearTimeout(timer2)
        }
      } catch (error) {
        failures.push(
          `第 ${index + 1} 张只给了 url（${item.url}），回源失败：${error instanceof Error ? error.message : String(error)}` +
            '。若该地址是内网/内网穿透地址，请让上游改用 response_format=b64_json。',
        )
        continue
      }
    }

    if (bytes === null || bytes.length === 0) {
      failures.push(`第 ${index + 1} 张没有内容（既没有 b64_json 也没有可用 url）`)
      continue
    }

    const extension = extensionFor(mimeType)
    let target: string
    if (typeof request.savePath === 'string' && request.savePath.trim() !== '' && items.length === 1) {
      target = isAbsolute(request.savePath.trim()) ? request.savePath.trim() : resolve(request.savePath.trim())
    } else {
      const stem = count > 1 ? `image-${stampOf(new Date())}-${index + 1}` : `image-${stampOf(new Date())}`
      const suffix = randomBytes(3).toString('hex')
      target = join(outputDir, `${stem}-${suffix}.${extension}`)
    }

    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    } catch (error) {
      failures.push(`第 ${index + 1} 张落盘失败（${target}）：${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    files.push({
      path: target,
      bytes: bytes.length,
      mimeType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }

  const elapsedMs = Date.now() - startedAt
  if (files.length === 0) {
    return {
      ...base,
      elapsedMs,
      status: response.status,
      error: failures.join('；') || '上游返回了图片数据，但没有一张能落盘',
      detail: clip(bodyText),
    }
  }

  log?.(`生图完成：${files.length} 张，${elapsedMs} ms → ${basename(dirname(files[0].path))}`)
  return {
    ok: true,
    model,
    prompt,
    elapsedMs,
    files,
    outputDir: dirname(files[0].path),
    ...(revisedPrompt === '' ? {} : { revisedPrompt }),
    ...(failures.length === 0 ? {} : { detail: failures.join('；') }),
    apiKeySource: config.apiKeySource,
  }
}
