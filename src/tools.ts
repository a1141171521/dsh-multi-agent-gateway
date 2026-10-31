/**
 * Agent 工具（模型可调用）。
 *
 * 五个工具，对应五件事：**账号 / 额度 / 签到 / 活动任务 / 路由**。
 * 全部走同一份核心对象（`GatewayRuntime`），所以工具看到的状态与 UI 完全一致。
 *
 * ⚠️ 两个硬规则：
 *   1. 工具结果**只返回脱敏后的账号**（`redactDeep`）—— 模型不该看到 token；
 *   2. 「不确定」要说出来，不要用 0 冒充（额度未知就写 `null` 并给原因）。
 */

import type { GatewayRuntime } from './runtime.js'
import { MAX_IMAGE_COUNT, generateImages } from './core/imagegen.js'

/** JsonSchema 子集（DSH 的 `ToolDefinition.parameters` 是 `Record<string, unknown>`）。 */
type JsonSchemaNode = Record<string, unknown>

/** 工具依赖。 */
export interface ToolDeps {
  runtime: GatewayRuntime
  register(definition: Record<string, unknown>): () => void
}

/** 一个纯文本渲染（工具的 `output.render` 必须给 ContentBlock[]）。 */
function textBlocks(text: string): Array<Record<string, unknown>> {
  return [{ type: 'text', text }]
}

/** 把 JSON 渲染成可读文本。 */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const AGENT_PARAM: JsonSchemaNode = {
  type: 'string',
  description:
    'Agent id：opencode / qoder / qoder-cn / trae / workbuddy / workbuddy-intl。省略 = 全部已启用的 Agent。',
}

/** 注册全部工具。 */
export function registerTools(deps: ToolDeps): Array<() => void> {
  const disposers: Array<() => void> = []
  const { runtime } = deps

  // ───────────────── 账号管理 ─────────────────
  disposers.push(
    deps.register({
      name: 'multiagent_accounts',
      description:
        'Free Token 的账号管理：列出 / 新增 / 修改 / 删除 / 测活账号。' +
        '凭证只写入不读出（返回结果里永远是脱敏后的）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'list = 列出；add = 新增；update = 改标签与开关；remove = 删除；test = 测活；setCredentials = 换凭证。',
            enum: ['list', 'add', 'update', 'remove', 'test', 'setCredentials'],
          },
          agentId: AGENT_PARAM,
          id: { type: 'string', description: '账号 id（update / remove / test / setCredentials 必填）。' },
          label: { type: 'string', description: '账号标签（add / update 用；同一个 Agent 下必须唯一）。' },
          token: { type: 'string', description: 'bearer token / API key（add / setCredentials 用）。' },
          cookie: { type: 'string', description: 'cookie 串（add / setCredentials 用，部分 Agent 需要）。' },
          enabled: { type: 'boolean', description: '是否参与路由。' },
          routeChat: { type: 'boolean', description: '是否参与对话路由。' },
          autoCheckIn: { type: 'boolean', description: '是否参与自动签到。' },
          autoTasks: { type: 'boolean', description: '是否参与自动活动任务。' },
          note: { type: 'string', description: '备注。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
        render: (_args: unknown, value: unknown) => textBlocks(jsonText(value)),
      },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as Record<string, unknown>
        const action = String(input.action ?? 'list')
        if (action === 'list') {
          return { ok: true, data: runtime.snapshotAccounts(typeof input.agentId === 'string' ? input.agentId : undefined) }
        }
        if (action === 'add') {
          const agentId = String(input.agentId ?? '')
          const label = String(input.label ?? '')
          if (agentId === '' || label === '') return { ok: false, error: 'add 需要 agentId 与 label' }
          const created = runtime.addAccount({
            agentId,
            label,
            credentials: {
              ...(typeof input.token === 'string' && input.token !== '' ? { token: input.token } : {}),
              ...(typeof input.cookie === 'string' && input.cookie !== '' ? { cookie: input.cookie } : {}),
            },
            ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
            ...(typeof input.routeChat === 'boolean' ? { routeChat: input.routeChat } : {}),
            ...(typeof input.autoCheckIn === 'boolean' ? { autoCheckIn: input.autoCheckIn } : {}),
            ...(typeof input.autoTasks === 'boolean' ? { autoTasks: input.autoTasks } : {}),
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
          })
          return { ok: true, data: created }
        }
        const id = String(input.id ?? '')
        if (id === '') return { ok: false, error: `${action} 需要 id` }
        if (action === 'remove') return { ok: runtime.removeAccount(id), data: { id } }
        if (action === 'test') return { ok: true, data: await runtime.testAccount(id) }
        if (action === 'setCredentials') {
          return {
            ok: true,
            data: runtime.setCredentials(id, {
              ...(typeof input.token === 'string' && input.token !== '' ? { token: input.token } : {}),
              ...(typeof input.cookie === 'string' && input.cookie !== '' ? { cookie: input.cookie } : {}),
            }),
          }
        }
        return {
          ok: true,
          data: runtime.updateAccount(id, {
            ...(typeof input.label === 'string' ? { label: input.label } : {}),
            ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
            ...(typeof input.routeChat === 'boolean' ? { routeChat: input.routeChat } : {}),
            ...(typeof input.autoCheckIn === 'boolean' ? { autoCheckIn: input.autoCheckIn } : {}),
            ...(typeof input.autoTasks === 'boolean' ? { autoTasks: input.autoTasks } : {}),
            ...(typeof input.note === 'string' ? { note: input.note } : {}),
          }),
        }
      },
    }),
  )

  // ───────────────── 额度 ─────────────────
  disposers.push(
    deps.register({
      name: 'multiagent_quota',
      description:
        '查看 / 刷新 Free Token 各账号的剩余额度与积分。额度未知时返回 null 并给出原因（不会用 0 冒充）。',
      parameters: {
        type: 'object',
        properties: {
          agentId: AGENT_PARAM,
          refresh: { type: 'boolean', description: 'true = 先向上游拉一次再返回。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
        render: (_args: unknown, value: unknown) => textBlocks(jsonText(value)),
      },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as Record<string, unknown>
        const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
        if (input.refresh === true) {
          return { ok: true, data: await runtime.refreshQuotas({ agentId }) }
        }
        return { ok: true, data: runtime.snapshotQuotas(agentId) }
      },
    }),
  )

  // ───────────────── 签到 ─────────────────
  disposers.push(
    deps.register({
      name: 'multiagent_checkin',
      description:
        '立即执行每日签到（或只查看签到结果）。上游没有签到接口时会明确返回「不支持」而不是报失败。',
      parameters: {
        type: 'object',
        properties: {
          agentId: AGENT_PARAM,
          accountId: { type: 'string', description: '只签某一个账号；省略 = 该 Agent 下全部开启自动签到的账号。' },
          force: { type: 'boolean', description: 'true = 忽略「今天已经签过」直接再签一次。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
        render: (_args: unknown, value: unknown) => textBlocks(jsonText(value)),
      },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as Record<string, unknown>
        return {
          ok: true,
          data: await runtime.runCheckIn({
            ...(typeof input.agentId === 'string' ? { agentId: input.agentId } : {}),
            ...(typeof input.accountId === 'string' ? { accountId: input.accountId } : {}),
            ...(input.force === true ? { force: true } : {}),
          }),
        }
      },
    }),
  )

  // ───────────────── 活动任务 ─────────────────
  disposers.push(
    deps.register({
      name: 'multiagent_tasks',
      description:
        '活动任务（与每日签到相互独立）：列出可做任务、立即执行一轮、查看执行流水。' +
        '上游没有活动任务接口时返回空列表与原因。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'list = 看可做任务；run = 立即跑一轮；log = 看执行流水；resume = 解除某账号的暂停。',
            enum: ['list', 'run', 'log', 'resume'],
          },
          agentId: AGENT_PARAM,
          accountId: { type: 'string', description: 'resume 用；run 时只跑这一个账号。' },
          count: { type: 'number', description: 'log 返回多少条（默认 40）。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
        render: (_args: unknown, value: unknown) => textBlocks(jsonText(value)),
      },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as Record<string, unknown>
        const action = String(input.action ?? 'list')
        const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
        if (action === 'log') {
          return { ok: true, data: runtime.taskLog(typeof input.count === 'number' ? input.count : 40) }
        }
        if (action === 'resume') {
          const accountId = String(input.accountId ?? '')
          if (accountId === '') return { ok: false, error: 'resume 需要 accountId' }
          return { ok: runtime.resumeTasks(accountId), data: runtime.snapshotTasks(agentId) }
        }
        if (action === 'run') {
          return {
            ok: true,
            data: await runtime.runTasks({
              ...(agentId === undefined ? {} : { agentId }),
              ...(typeof input.accountId === 'string' ? { accountId: input.accountId } : {}),
            }),
          }
        }
        return { ok: true, data: await runtime.listTasks(agentId) }
      },
    }),
  )

  // ───────────────── 路由 ─────────────────
  disposers.push(
    deps.register({
      name: 'multiagent_routing',
      description:
        '查看 / 调整多账号路由：当前策略、每个账号的健康与降权状态、降权账号的自动恢复。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'status = 看状态；reset = 重置某账号健康；recover = 立刻跑一轮自动恢复检测。',
            enum: ['status', 'reset', 'recover'],
          },
          agentId: AGENT_PARAM,
          accountId: { type: 'string', description: 'reset 用。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
        render: (_args: unknown, value: unknown) => textBlocks(jsonText(value)),
      },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as Record<string, unknown>
        const action = String(input.action ?? 'status')
        const agentId = typeof input.agentId === 'string' ? input.agentId : undefined
        if (action === 'reset') {
          const accountId = String(input.accountId ?? '')
          if (accountId === '') return { ok: false, error: 'reset 需要 accountId' }
          return { ok: runtime.resetHealth(accountId), data: runtime.snapshotRouting(agentId) }
        }
        if (action === 'recover') {
          return { ok: true, data: await runtime.recoverNow() }
        }
        return { ok: true, data: runtime.snapshotRouting(agentId) }
      },
    }),
  )

  // ───────────────── 生图 ─────────────────
  //
  // 与上面五个工具不是一回事：它不碰账号、不碰额度，只是一次 HTTP 调用 + 落盘。
  // 之所以还放在这里，是因为「注册工具」这件事只有这一处入口；多开一个文件只会
  // 让 `apply()` 多一个 try/catch。
  //
  // ⚠️ 配置每次现读 `runtime.config.imageGen`（而不是 apply 时捕获一份）——
  // 设置页改完 key 热更新就能用，不需要重启宿主。
  disposers.push(
    deps.register({
      name: 'generate_image',
      description:
        '按文字提示词生成图片（ClawHUD / OpenAI Images 兼容接口），并把图片落盘到本地。' +
        '返回每张图的绝对路径、字节数与 sha256；要在对话里看到图，再对返回的 path 调 read_image。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '画面描述。建议把主体、风格、光线、构图写清楚，越具体越可控。',
          },
          size: { type: 'string', description: '尺寸，如 1024x1024。省略 = 用配置里的默认尺寸。' },
          model: {
            type: 'string',
            description: '模型。省略 = 用配置里的默认模型（默认 grok-imagine-image-2.0）。',
          },
          n: { type: 'number', description: `一次生成几张（1~${MAX_IMAGE_COUNT}，默认 1）。` },
          outputDir: {
            type: 'string',
            description: '落盘目录。省略 = 配置里的 outputDir，再不行用 `<数据目录>/images`。',
          },
          savePath: {
            type: 'string',
            description: '只生成一张时，指定完整落盘路径（含扩展名）。路径不存在会自动建目录。',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
        render: (_args: unknown, value: unknown) => textBlocks(jsonText(value)),
      },
      async execute(args: unknown): Promise<unknown> {
        const input = (args ?? {}) as Record<string, unknown>
        const prompt = typeof input.prompt === 'string' ? input.prompt : ''
        if (prompt.trim() === '') return { ok: false, error: 'generate_image 需要 prompt' }
        const outcome = await generateImages(
          runtime.config.imageGen,
          {
            prompt,
            ...(typeof input.size === 'string' ? { size: input.size } : {}),
            ...(typeof input.model === 'string' ? { model: input.model } : {}),
            ...(typeof input.n === 'number' ? { n: input.n } : {}),
            ...(typeof input.outputDir === 'string' ? { outputDir: input.outputDir } : {}),
            ...(typeof input.savePath === 'string' ? { savePath: input.savePath } : {}),
          },
          (message) => runtime.logger.info(message),
        )
        return outcome.ok
          ? { ok: true, data: outcome }
          : { ok: false, error: outcome.error ?? '生图失败', data: outcome }
      },
    }),
  )

  return disposers
}
