# 生图（`generate_image`）

文字 → 图片。跟本插件其他的「多账号网关」能力**没有关系**：它不挑账号、不走路由、
不落 `accounts.enc.json`，只是一次 OpenAI Images 兼容的 HTTP 调用 + 落盘。
放在同一个插件里，是因为「注册工具」只有 `tools.ts` 一个入口。

## 一句话用法

对话里说「画一只橘猫坐在窗台上」，模型会调 `generate_image`，图落在
`<数据目录>/images/`，返回绝对路径。想在对话里直接看到图，再对那个路径调 `read_image`。

## 接口

```
POST {baseUrl}/v1/images/generations
Authorization: Bearer <apiKey>
{
  "model": "grok-imagine-image-2.0",
  "prompt": "...",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

### ⚠️ 为什么写死 `response_format: b64_json`

ClawHUD 在 `response_format: "url"` 时返回的是**它自己的内网直链**：

```
http://100.107.100.40:10009/v1/media/images/img_xxxxxxxx
```

`100.64.0.0/10` 是 Tailscale 的地址段，普通网络根本路由不到 —— 实测
`Invoke-WebRequest` 直接报「无法连接到远程服务器」。也就是说 url 模式**只在
和那台机器在同一个 tailnet 里**才有意义。

所以这里不做开关，永远走 base64：拿到字节自己落盘，不依赖任何回源。
（`generateImages()` 里仍留了 url 兜底分支，但失败时会把原因写成
「若该地址是内网/内网穿透地址，请让上游改用 response_format=b64_json」。）

## 配置（设置页 → Free Token → 生图）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后工具直接返回「已关闭」，不发请求 |
| `baseUrl` | `https://api.clawhud.com/` | 末尾带不带 `/` 都行；带 `/v1` 也认 |
| `apiKey` | 空 | 空 = 走环境变量，再不行读 `.env` |
| `model` | `grok-imagine-image-2.0` | 上游当前可用：`grok-imagine-image-2.0`、`grok-imagine-image` |
| `size` | `1024x1024` | 可被单次调用的 `size` 覆盖 |
| `outputDir` | 空 | 空 = `<数据目录>/images` |
| `timeoutMs` | `180000` | 生图比对话慢，实测一张约 15~20 秒，别调太小 |
| `envFile` | 空 | 额外的 `.env` 路径（排在最前面） |

### 密钥的三级回退

1. 配置里的 `imageGen.apiKey`（设置页可写，`volatile`）；
2. 进程环境变量：`CLAWHUD_API_KEY` → `IMAGE_API_KEY` → `OPENAI_API_KEY`；
3. `.env` 文件，按这个顺序找：

   ```
   <envFile 显式配置的>
   <插件目录>/../.env        ← 本项目把 .env 放在这里：D:\AI\DeepseekPlugin\.env
   <插件目录>/.env
   <数据目录>/.env
   ~/.dsh/.env
   ```

返回里的 `apiKeySource` 会写清到底用的是哪一级（`config` / `env` / `env-file` / `none`）。
三级都空**不会**让插件起不来，只会让工具返回「没有可用的 API key」并列出查过的路径 ——
比让人对着一条 `401 Unauthorized` 猜半天强。

## 工具参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | ✅ | 画面描述。主体 + 风格 + 光线 + 构图写得越具体越可控 |
| `size` | | 覆盖默认尺寸 |
| `model` | | 覆盖默认模型 |
| `n` | | 一次几张，1~4，默认 1 |
| `outputDir` | | 覆盖落盘目录 |
| `savePath` | | **只生成一张时**指定完整路径（含扩展名），目录不存在会自动建 |

返回：

```json
{
  "ok": true,
  "data": {
    "ok": true,
    "model": "grok-imagine-image-2.0",
    "prompt": "...",
    "elapsedMs": 18773,
    "files": [{ "path": "...\\images\\image-20261031-231312-c922b8.jpg", "bytes": 264834, "mimeType": "image/jpeg", "sha256": "..." }],
    "outputDir": "...\\images",
    "apiKeySource": "env-file"
  }
}
```

## 自测

```bash
# 单测（本地假上游，不碰外网）
node --test test/imagegen.test.mjs

# 真要打一次上游（用到 .env 里的 key）
node -e "import('./lib/core/imagegen.js').then(async (m) => { \
  const cfg = m.resolveImageGenConfig({}, { dataDir: './.tmp' }); \
  console.log(await m.generateImages(cfg, { prompt: '一只橘猫' })) })"
```

## 已知限制

- **不支持图生图 / 编辑**：只有 `prompt` 一个输入。上游若有 `/v1/images/edits`，要另开一条路径。
- **没有重试**：一次请求一次结果。上游偶发超时就再调一次（工具是幂等的，重复调用只会多几张图）。
- **不校验图片内容**：拿到什么字节就存什么，只按 `mime_type` 定扩展名。
- **不做并发限制**：跟对话请求的 `maxConcurrentRequests` 是两套东西，同时点很多次会同时打上游。
