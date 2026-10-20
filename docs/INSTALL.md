# 安装部署

## 前置条件

- DSH 桌面版 **0.1.5-rc.1 或更高**（更低版本没有 `dsh.client` 客户端模块系统）。
- Node **>= 20**（插件本身只用 Node 内置模块；`scripts/build.mjs` 需要 22.13+ 的
  `module.stripTypeScriptTypes`，但**安装方不需要构建** —— `lib/` 是随包提交的产物）。

## 安装

### 方式一：从本地目录装（推荐，开发时用）

```powershell
dsh plugin --profile desktop add D:\AI\DeepseekPlugin\dsh-multi-agent-gateway
```

`dsh plugin add` 会做三件事：

1. `pnpm add <路径>`，把它写进 profile 的 `package.json` 依赖；
2. 读它的 `dsh.bundle.patch`（= `cordis.patch.yml`）并把这一层叠进组合树；
3. 把它加进 `dsh.profile.bundles` 列表（默认启用）。

### 方式二：从 git 仓库装

```powershell
dsh plugin --profile desktop add github:a1141171521/dsh-free-token
```

### 方式三：从 tarball 装

```powershell
npm pack                                     # 产出 dsh-multi-agent-gateway-0.1.0.tgz
dsh plugin --profile desktop add .\dsh-multi-agent-gateway-0.1.0.tgz
```

### 其它 profile

把 `--profile desktop` 换成 `web` / 你的 profile 名即可。

## **装完必须重启 DSH**

宿主在**启动时**扫描各包的 `dsh.client` 声明并把它接进客户端模块表。不重启的话：

- 宿主侧（模型分组、路由、定时任务）**已经生效**（profile 会热组合）；
- 但**「设置 → 插件」里的配置页不会出现**（浏览器侧还没拿到那份 bundle）。

重启后自检（用 `cordis_inspect_query` 或肉眼）：

| 检查项 | 期望 |
|---|---|
| 客户端槽 `plugins.bundle.config` | occupants 里有 `key: "dsh-multi-agent-gateway"` |
| 客户端槽 `plugins.row.config` | occupants 里有 `key: "dsh-multi-agent-gateway#dsh-multi-agent-gateway"` |
| 模型选择器分组 | 出现 `OpenCode` 分组（配好账号并拉到模型之后） |
| 宿主配置 | `cordis_inspect_query(host, Config, listConfigs, {name:'dsh-multi-agent-gateway'})` 的 `status` 是 `schema` |

## 配置

### 通过界面（推荐）

**设置 → 插件 → 多 Agent 网关**。可以：

- 总开关、路由策略；
- 每个 Agent：启用、模型上报、模型名是否带 Agent 前缀；
- 每个 Agent：签到 / 额度 / 活动任务**三套独立开关**与时间；
- 上游地址（用反代平台时改这里）；
- 账号增删改测、额度、健康、任务流水、模型倍率。

界面上所有开关都会写回 profile 的 `cordis.patch.yml`（持久化）。

### 通过 profile patch

想手工填默认值，编辑 `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`（**顶层 id 覆盖，
不要再 insert 一次**，重复 id 会让加载器直接报错）：

```yaml
- id: dsh-multi-agent-gateway
  config:
    enabled: true
    verbose: false
    gateway:
      routing: quota-first          # round-robin | quota-first
      maxAccountAttempts: 3
      degradeAfterFailures: 2
      penaltySec: 300
      recoverIntervalSec: 600
    agents:
      opencode:
        enabled: true
        exposeModels: true
        labelWithAgent: true
        checkIn:
          enabled: true
          cron: '0 30 8 * * *'      # 每天 08:30
        quota:
          enabled: true
          cron: 'every:1800'        # 每 30 分钟
        tasks:
          enabled: false            # 上游没有活动任务接口就保持关闭
          intervalMinutes: 60
          concurrency: 1
          maxFailures: 3
        upstream:
          chatBaseUrl: https://opencode.ai/inference/openai/v1
          apiBaseUrl: https://opencode.ai/console
          # 用反代平台时改成你的地址，并把下面两个填上
          # chatBaseUrl: https://your-proxy.example/v1
          # checkInPath: /api/user/checkin
          # tasksPath: /api/user/tasks
          # taskClaimPath: /api/user/tasks/{taskId}/claim
        credits:
          unit: usd
          baselineUsdPerMTok: 1.2
        requestTimeoutMs: 120000
        rateLimitPerMinute: 60
```

时间表达式支持三种：

| 写法 | 含义 |
|---|---|
| `every:<秒>` | 间隔（至少 30 秒）。`every:86400` = 每天一次 |
| `分 时 日 月 周` | 5 段 cron。`30 8 * * *` = 每天 08:30 |
| `秒 分 时 日 月 周` | 6 段 cron。`0 30 8 * * *` = 每天 08:30:00 |

**写错会直接抛错并写进日志**（不会静默变成「永远不跑」）。

### 改完配置怎么生效

- **改 `cordis.patch.yml`**：profile 会热组合，**立即生效**（定时计划会重建）；
- **改代码（`src/` / `client/`）**：必须 `node scripts/build.mjs` 并**重启 DSH**
  （Node 的 ESM 模块缓存不会重读文件）。

## 临时停用 / 卸载

```yaml
# 临时停用（配置层面，不用卸载）
- id: dsh-multi-agent-gateway
  disabled: true
```

```powershell
# 彻底卸载
dsh plugin --profile desktop remove dsh-multi-agent-gateway
```

卸载**不会**删除 `<DSH_HOME>/multi-agent-gateway` 里的数据（账号密文、日志）。
要清干净就手工删那个目录 —— 但注意删掉 `.master-key` 之后，`accounts.enc.json`
里的凭证就**再也解不开了**。

## 常见安装问题

| 现象 | 原因与处理 |
|---|---|
| 设置页里**完全看不到**这个插件 | ① 没重启 DSH（客户端 bundle 未加载）；② profile 里没选中这个 bundle（`dsh plugin list` 看一下） |
| 看到插件但**没有配置表单** | 客户端半边没装上：查 `plugins.bundle.config` 槽的 occupants。宿主日志会有 `客户端通道未装上：…` |
| 模型选择器里**没有 OpenCode 分组** | ① `enabled: false`；② `exposeModels: false`；③ 模型目录拉不到（看日志里 `拉取 OpenCode 模型目录失败`） |
| 分组在但**没有任何模型** | 上游模型目录不可达，或该 Agent 没有可用账号。点配置页的「列出模型」看真实报错 |
| 保存配置报「保存失败」 | 宿主只接受声明了 `volatile` 的字段，且**一次 mutate 里有一个非法 op 就整批拒**。界面会把改过的路径列出来，照着核对 |
| 加载器报 `duplicate loader entry id` | profile patch 里手工 insert 了同名 id。删掉那条手工 insert（bundle patch 已经加过了） |
| 加载器报 `DUPLICATE_ADAPTER` | 另一个插件/配置已经占了 `multiagent-opencode` 这个 provider 路由。检查是否有两份本插件 |
