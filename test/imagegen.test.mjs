/**
 * 生图工具的单测（`src/core/imagegen.ts`）。
 *
 * 覆盖点都选在**会静默出错**的地方：
 *   - `.env` 解析（注释 / export / 引号 / 非法行）—— 解析错了表现为「密钥读不到」，
 *     用户只会看到 401，根本想不到是解析器把值吃掉了；
 *   - 端点拼接（`/`、`/v1` 三种 base 写法）—— 拼错了是 404，看起来像「接口没了」；
 *   - 密钥三级回退的**来源标记**—— 决定用户该改配置还是改 .env；
 *   - 上游各种返回形状（b64 / url / 401）—— url 模式在本机是取不回来的，
 *     必须给出「改用 b64_json」这种能直接照做的提示，而不是一句 fetch failed。
 *
 * 全程**不碰外网**：起一个本地 http server 扮演上游。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_IMAGE_BASE_URL,
  DEFAULT_IMAGE_MODEL,
  extensionFor,
  generateImages,
  imagesEndpoint,
  loadEnvFile,
  parseEnvFile,
  resolveImageGenConfig,
  stampOf,
} from '../lib/core/imagegen.js'

/** 造一个临时目录，用完删掉。 */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-imagegen-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 临时改环境变量（返回还原函数）。 */
function withEnv(names, values) {
  const saved = new Map()
  for (const name of names) {
    saved.set(name, process.env[name])
    const next = values[name]
    if (next === undefined) delete process.env[name]
    else process.env[name] = next
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** 起一个本地假上游，返回 baseUrl 与关闭函数。 */
async function stubServer(handler) {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const result = handler({ method: request.method, url: request.url, body, headers: request.headers })
      response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' })
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// ───────────────────────── .env 解析 ─────────────────────────

test('parseEnvFile：注释 / export / 引号 / 非法行都按约定处理', () => {
  const parsed = parseEnvFile(
    [
      '# 注释',
      '',
      'CLAWHUD_API_KEY=abc123',
      '  SPACED = "quoted value"  ',
      "SINGLE='x=y'",
      'export EXPORTED=ok',
      'NO_EQUALS_LINE',
      '=empty-key',
      '1BAD=starts-with-digit',
    ].join('\n'),
  )
  assert.equal(parsed.CLAWHUD_API_KEY, 'abc123')
  assert.equal(parsed.SPACED, 'quoted value')
  // 引号只剥一层，`=` 留在值里（`SINGLE=x=y` 是合法的）。
  assert.equal(parsed.SINGLE, 'x=y')
  assert.equal(parsed.EXPORTED, 'ok')
  assert.equal(parsed.NO_EQUALS_LINE, undefined)
  assert.equal(parsed[''], undefined)
  assert.equal(parsed['1BAD'], undefined)
})

test('loadEnvFile：读不到就返回空，不抛错', () => {
  const result = loadEnvFile({ envFile: join(tmpdir(), 'definitely-missing-file.env') })
  assert.equal(typeof result.values, 'object')
  assert.equal(result.path === '' || typeof result.path === 'string', true)
})

// ───────────────────────── 端点拼接 ─────────────────────────

test('imagesEndpoint：三种 base 写法都落到同一个端点', () => {
  assert.equal(imagesEndpoint('https://api.clawhud.com/'), 'https://api.clawhud.com/v1/images/generations')
  assert.equal(imagesEndpoint('https://api.clawhud.com'), 'https://api.clawhud.com/v1/images/generations')
  assert.equal(imagesEndpoint('https://api.clawhud.com/v1'), 'https://api.clawhud.com/v1/images/generations')
  assert.equal(imagesEndpoint('https://api.clawhud.com/v1/'), 'https://api.clawhud.com/v1/images/generations')
  assert.throws(() => imagesEndpoint('  '), /baseUrl/)
})

test('extensionFor / stampOf：落盘命名用的两个小函数', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpg')
  assert.equal(extensionFor('image/png'), 'png')
  assert.equal(extensionFor('image/webp'), 'webp')
  assert.equal(extensionFor(''), 'jpg')
  assert.match(stampOf(new Date(2026, 9, 31, 23, 7, 32)), /^20261031-230732$/)
})

// ───────────────────────── 密钥回退 ─────────────────────────

test('resolveImageGenConfig：配置里的 key 优先，来源记为 config', () => {
  const restore = withEnv(['CLAWHUD_API_KEY'], { CLAWHUD_API_KEY: 'from-env' })
  try {
    const cfg = resolveImageGenConfig({ apiKey: 'from-config' }, { dataDir: join(tmpdir(), 'x') })
    assert.equal(cfg.apiKey, 'from-config')
    assert.equal(cfg.apiKeySource, 'config')
    assert.equal(cfg.baseUrl, DEFAULT_IMAGE_BASE_URL)
    assert.equal(cfg.model, DEFAULT_IMAGE_MODEL)
    assert.equal(cfg.enabled, true)
  } finally {
    restore()
  }
})

test('resolveImageGenConfig：配置为空时读环境变量', () => {
  const restore = withEnv(['CLAWHUD_API_KEY', 'IMAGE_API_KEY', 'OPENAI_API_KEY'], {
    CLAWHUD_API_KEY: 'from-env',
    IMAGE_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  })
  try {
    const cfg = resolveImageGenConfig({}, { dataDir: join(tmpdir(), 'x') })
    assert.equal(cfg.apiKey, 'from-env')
    assert.equal(cfg.apiKeySource, 'env')
  } finally {
    restore()
  }
})

test('resolveImageGenConfig：配置与环境变量都空时读 .env', () => {
  const { dir, cleanup } = tempDir()
  const envFile = join(dir, '.env')
  writeFileSync(envFile, 'CLAWHUD_API_KEY=from-file\nIMAGE_MODEL=another-model\n', 'utf8')
  const restore = withEnv(['CLAWHUD_API_KEY', 'IMAGE_API_KEY', 'OPENAI_API_KEY'], {
    CLAWHUD_API_KEY: undefined,
    IMAGE_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  })
  try {
    const cfg = resolveImageGenConfig({ envFile }, { dataDir: join(dir, 'data') })
    assert.equal(cfg.apiKey, 'from-file')
    assert.equal(cfg.apiKeySource, 'env-file')
    // 模型只认配置项，不从 .env 的 `IMAGE_MODEL` 偷读 —— 那是误会大户。
    assert.equal(cfg.model, DEFAULT_IMAGE_MODEL)
  } finally {
    restore()
    cleanup()
  }
})

test('resolveImageGenConfig：enabled 能被显式关掉，超时有下限', () => {
  const cfg = resolveImageGenConfig({ enabled: false, timeoutMs: 1 }, { dataDir: join(tmpdir(), 'x') })
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.timeoutMs, 5000)
})

// ───────────────────────── 端到端（本地假上游） ─────────────────────────

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9])

test('generateImages：b64_json 正常出图并落盘', async () => {
  const { dir, cleanup } = tempDir()
  let seen = null
  const stub = await stubServer((request) => {
    seen = { url: request.url, body: JSON.parse(request.body), auth: request.headers.authorization }
    return {
      status: 200,
      body: {
        created: 1,
        data: [{ b64_json: TINY_JPEG.toString('base64'), mime_type: 'image/jpeg', revised_prompt: '' }],
      },
    }
  })
  try {
    const cfg = resolveImageGenConfig({ baseUrl: stub.baseUrl, apiKey: 'k' }, { dataDir: join(dir, 'data') })
    const outcome = await generateImages(cfg, { prompt: 'a cat', n: 1 })
    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(outcome.files.length, 1)
    // 请求形状：端点、鉴权头、以及最关键的 response_format=b64_json。
    assert.equal(seen.url, '/v1/images/generations')
    assert.equal(seen.auth, 'Bearer k')
    assert.equal(seen.body.response_format, 'b64_json')
    assert.equal(seen.body.model, DEFAULT_IMAGE_MODEL)
    const file = outcome.files[0]
    assert.equal(file.mimeType, 'image/jpeg')
    assert.equal(file.bytes, TINY_JPEG.length)
    assert.equal(file.sha256.length, 64)
    assert.deepEqual(readFileSync(file.path), TINY_JPEG)
    // 默认落在 `<dataDir>/images` 下。
    assert.equal(outcome.outputDir, join(dir, 'data', 'images'))
  } finally {
    await stub.close()
    cleanup()
  }
})

test('generateImages：savePath 精确指定落盘位置（n=1）', async () => {
  const { dir, cleanup } = tempDir()
  const stub = await stubServer(() => ({
    status: 200,
    body: { data: [{ b64_json: TINY_JPEG.toString('base64'), mime_type: 'image/png' }] },
  }))
  try {
    const cfg = resolveImageGenConfig({ baseUrl: stub.baseUrl, apiKey: 'k' }, { dataDir: dir })
    const target = join(dir, 'nested', 'shot.png')
    const outcome = await generateImages(cfg, { prompt: 'x', savePath: target })
    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(outcome.files[0].path, target)
    assert.equal(readFileSync(target).length, TINY_JPEG.length)
  } finally {
    await stub.close()
    cleanup()
  }
})

test('generateImages：上游 401 时把上游原话带出来', async () => {
  const { dir, cleanup } = tempDir()
  const stub = await stubServer(() => ({ status: 401, body: { error: { message: 'invalid api key' } } }))
  try {
    const cfg = resolveImageGenConfig({ baseUrl: stub.baseUrl, apiKey: 'bad' }, { dataDir: dir })
    const outcome = await generateImages(cfg, { prompt: 'x' })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.status, 401)
    assert.match(outcome.error, /invalid api key/)
  } finally {
    await stub.close()
    cleanup()
  }
})

test('generateImages：只给 url 且取不回来时，提示改用 b64_json', async () => {
  const { dir, cleanup } = tempDir()
  const stub = await stubServer(() => ({
    status: 200,
    body: { data: [{ url: 'http://127.0.0.1:1/v1/media/images/img_x', mime_type: 'image/jpeg' }] },
  }))
  try {
    const cfg = resolveImageGenConfig({ baseUrl: stub.baseUrl, apiKey: 'k', timeoutMs: 5000 }, { dataDir: dir })
    const outcome = await generateImages(cfg, { prompt: 'x' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /b64_json/)
  } finally {
    await stub.close()
    cleanup()
  }
})

test('generateImages：没密钥时直接说没密钥，并列出查过的 .env', async () => {
  const { dir, cleanup } = tempDir()
  const restore = withEnv(['CLAWHUD_API_KEY', 'IMAGE_API_KEY', 'OPENAI_API_KEY'], {
    CLAWHUD_API_KEY: undefined,
    IMAGE_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  })
  try {
    // 把候选路径收窄到「一定不存在」的那个：显式 envFile 排第一，但仍然会走后面的默认候选，
    // 所以这里只断言「报的是没密钥」这件事，不断言具体命中哪个文件。
    const cfg = resolveImageGenConfig({ envFile: join(dir, 'none.env') }, { dataDir: join(dir, 'data') })
    if (cfg.apiKey !== '') {
      // 本机插件上一级正好有一份真 .env：这时跳过（不能因为开发机的环境让测试变红）。
      return
    }
    const outcome = await generateImages(cfg, { prompt: 'x' })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /没有可用的 API key/)
  } finally {
    restore()
    cleanup()
  }
})

test('generateImages：配置关掉 / prompt 为空时不发请求', async () => {
  const cfgOff = resolveImageGenConfig({ enabled: false, apiKey: 'k' }, { dataDir: join(tmpdir(), 'x') })
  const off = await generateImages(cfgOff, { prompt: 'x' })
  assert.equal(off.ok, false)
  assert.match(off.error, /关闭/)

  const cfg = resolveImageGenConfig({ apiKey: 'k' }, { dataDir: join(tmpdir(), 'x') })
  const empty = await generateImages(cfg, { prompt: '   ' })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /prompt/)
})
