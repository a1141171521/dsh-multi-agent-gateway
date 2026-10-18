# 已知问题 / 待修清单

**从上往下修**。每条都写清「现象 → 根因 → 已改了什么 → 还差什么」，
换一台机器也能直接接着干，不用重新调研。

状态图例：

| 标记 | 含义 |
|---|---|
| 🔴 | 有真机复现，**还没修好**（代码可能已经改了，但没验证过，不算修好） |
| 🟡 | 代码已改，只跑过单测/预览，**没在真机上确认** |
| 🟢 | 真机确认过 |

---

## 🔴 #1 对话框模型选择器里出现「没勾选、也没保存过」的模型

> 报障原话：很多模型我并没有选择并保存，但是现在在对话框选择模型的地方，
> 渲染的有这些平台的模型。

**状态**：根因已定位、代码已改，但**真机未验证** —— 而且这次改的是宿主侧
schema 默认值，**必须重启 DSH 才会加载**。所以仍按「未修好」记。
明天第一件事就是按下面「验证」那节跑一遍。

### 现象

- DSH 的模型选择器里出现 OpenCode 之外的平台模型（WorkBuddy / Qoder / 国际版的免费模型）；
- 插件设置页「账号」里这些平台却显示 `已勾选 0 / 共 10` —— 界面和下拉对不上；
- 「总览」KPI 的数字比下拉里实际能看到的条数多。

### 根因（两处独立缺陷）

1. **默认值太宽松**：`ModelPolicySchema.mode` 默认 `'free'`，含义是「免费模型自动上报」。
   用户 yml 里只给 `opencode` 写了 `models` 块，其它平台没有 `models` 块 → 走默认值 →
   免费模型**自动**进选择器。用户从没勾过、也没保存过，模型却出现了。
2. **连续勾选互相覆盖**：`toggleModel` 以「宿主已保存的 `selectedIds`」为基线，
   连续勾/取消多个时后一次把前一次覆盖掉 —— 勾 5 个保存后只剩 1 个。这条会让
   用户以为「保存没生效」，进而反复点保存，把更多平台写进配置。

### 已改的地方

| 文件 | 改动 |
|---|---|
| `src/config.ts:203-216` | `mode` 默认 `'free'` → **`'selected'`**；`selected` 默认 `''`。即「**不勾不报**」。 |
| `src/runtime.ts:1224-1228` | 快照新增 `exposedCount` = 上游拉回来的 ∩ 上报策略；`exposeModels !== true` 时为 `0`。 |
| `client/client.js` | `toggleModel` 基线改为**草稿优先**（draft → 宿主 `selectedIds` → `modelSelection()`）；新增 `preselectModels(ids)` 与「按推荐预选 N 个」按钮；总览 KPI 与平台健康表改读 `exposedCount`。 |
| `test/client.test.mjs` | 新增 4 条断言：schema 默认必须是 `selected`、默认勾选必须为空、连续取消不互相覆盖、`preselectModels` 只写草稿。 |
| `docs/MODELS.md` §6.5 | 上报规则表按「不勾不报」重写。 |

### 验证（明天按顺序做）

1. **重启 DSH**（不是刷新页面）。schema 默认值在宿主进程启动时解析，
   刷新页面只重载 client 半边，拿不到新默认值。
2. 设置 → 插件 → 多 Agent 网关 → **账号**。没配过 `models` 的平台
   （Qoder / WorkBuddy / WorkBuddy 国际版）应显示 `已勾选 0 / 共 N`。
3. 回对话框展开模型下拉：**只应出现 OpenCode 已保存的那两个** ——
   `deepseek-v4.1-flash-free`、`glm-5.3-flash-free`。

> 参考：这份配置在 `~/.dsh/profiles/desktop/cordis.patch.yml`，当前只有
> `opencode.models`（`mode: selected` + 两个模型）和 `qoder.tasks.enabled`，
> 其它平台**没有任何 `models` 块** —— 所以默认值就是唯一的开关。

### 如果重启后还复现，按这个顺序查

1. **yml 被写脏了**（最可能）。翻 `cordis.patch.yml` 对应平台的 `models:` 块：
   如果**显式**写了 `mode: free`（早期点过「保存并生效」就会被写进去），
   改 schema 默认值完全不管用 —— 需要改配置，或者加一段迁移把
   「显式 free + 用户没真正勾过」收敛掉。**先看这一步再动代码。**
2. **`exposeModels: false` 但 provider 还注册着**。`src/runtime.ts` 里
   `exposeModels !== true` 时应完全不注册 provider；若仍能看到该平台，
   说明注册没跟着配置走。
3. **DSH 自己的模型缓存**。宿主的模型目录可能按 provider 缓存，重启后仍留旧条目。
   试：清 `~/.dsh/profiles/desktop` 下与模型相关的缓存，或整目录重装一次。
4. **选择器不走 `exposedCount`**。界面已经改了，但如果 DSH 原生选择器的
   模型列表有别的来源，去查 `src/llm/adapter.ts` 的 `listModels`。

### 教训

**不要用「默认上报」当默认值。** 任何会自动出现在用户界面上的东西，
默认都必须是不出现，由用户显式打开。

---

## 🟡 #2 登录弹框的遮罩把整个屏幕遮住了

- **原因**：拿 `--dsw-alias-bg-overlay` 当遮罩用。这个 token 是**不透明的浮层表面**，
  不是半透明蒙版，铺满全屏就变成一块死板。
- **已改**：`.mag-overlay` 改用 `rgba(0,0,0,.42)`；点遮罩空白处 / ✕ / 取消 / Esc
  都走同一个 `closeLoginModal()`。
- **还差**：真机看一眼遮罩下面能不能看到页面。弹框本身在 `document.body` 的 portal 里
  （`z-index: 1000`），因为设置页祖先有 `transform`/`overflow`，`position: fixed` 会被裁。

---

## 🟡 #3 设置页所有「开启 / 关闭」开关点了没反应

- **原因**：`fieldRowHTML` 读 `fieldState.value`，但宿主的真实形状是
  布尔字段 `{checked, changed}`、文本字段 `{text, changed}`。读不到 → 开关永远渲染成
  `aria-checked="false"`；而点击时算出的「设成 true」对本来就 true 的字段是空操作。
- **已改**：渲染和 `onSwitchClick`（读 `hit.state?.checked`）都按真实形状取值。
- **还差**：真机确认开关会翻面，且翻面后顶部出现「保存并生效」（保存栏由
  `shell.dirty` / `dirtyCount` 驱动，开关**不会**即时写入配置）。

---

## 🟡 #4 外链登录的自动轮询没有真机验证

`startLogin` 现在对**设备码**和**外链**两种形态都排每 3～5 秒一次的轮询（原型要求）。
代价是 WorkBuddy / Qoder 的 `/auth/token?state=` 会被一直问到过期。需要一次真人登录确认：

1. 授权完成后 3～5 秒内界面自己变绿（不用点「手动刷新」）；
2. 过期后停在 `expired`（灰），**不会**再变绿 —— 早期这里掉进 `else` 分支，
   过期反而渲染成绿色的「已添加账号」。

---

## 🟡 #5 深色主题只有近似色，没在真机核对

`scripts/preview.mjs` 用固定的 14 个 token 浅色值渲染成 `preview/*.html`，
深色用的是近似调色板。真实设备上的深色值没核对过，检查清单：边框、
次要文字、「浅色底 + 状态色」的徽章。

---

## 其它已知边界（不是 bug，别再查一遍）

- **Trae 适配器是骨架**，`visible: false`，界面看不到。实现后把 `trae` 加进
  `src/config.ts` 的 `DEFAULT_VISIBLE_AGENTS` 即可。
- **宿主端 `addAccount` / `setCredentials` 端点仍在**（`src/index.ts`），
  但界面已没有手动填 token / cookie 的入口 —— 保留给脚本用。
- **WorkBuddy 的签到 / 额度**上游没有公开接口，明确回报「不支持」。
- 改完 `src/` **必须先跑 `node scripts/build.mjs`** 再提交：`lib/` 是提交进仓库的
  构建产物，安装时不重新构建。`node scripts/build.mjs --check` 校验是否漂移。
