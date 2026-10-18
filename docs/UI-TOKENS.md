# 界面样式与主题 token（踩坑记录）

这份文件记录**样式为什么曾经「没有原型好看」**，以及现在必须遵守的规矩。
下次改 UI 前先读一遍，能省掉一次返工。

---

## 1. DSH 主题只提供 14 个 token

真实清单（来自 client Inspect 的 `Theme` provider）：

```
--dsw-alias-bg-base
--dsw-alias-bg-layer-1
--dsw-alias-bg-layer-2
--dsw-alias-bg-overlay
--dsw-alias-border-l1
--dsw-alias-border-l2
--dsw-alias-brand-primary
--dsw-alias-label-primary
--dsw-alias-label-secondary
--dsw-alias-state-error-primary
--dsw-alias-state-idle-primary
--dsw-alias-state-success-primary
--dsw-alias-state-warn-primary
--dsw-specific-sidebar-fill
```

**没有** `label-tertiary`、`state-business-primary`、`settings-card-fill`、
`border-l3/l4`、`interactive-bg-hover`，**也没有任何 `--dsw-radius-*`**。

早期样式用了这些不存在的名字，于是：

- 对应属性**静默失效**（`var()` 取不到值 → 整条声明被丢弃）；
- 我又给它们配了**浅色兜底**，浅色主题下勉强能看，**一旦主题变深就撞色**。

这就是「没原型好看」的真正原因。现在：

1. 只用上面 14 个 token；
2. **不写颜色兜底**（`var(--x, #fff)` → `var(--x)`），让颜色完全跟随主题；
3. 半径直接写字面值（8 / 6 / 4 px）；
4. 需要「浅色底 + 状态色」的地方用 `color-mix()` 从状态色派生，深浅主题都成立。

## 2. 回归防线

`test/client.test.mjs` 里有两条：

- `样式真的会被注入到页面`：断言样式确实 `appendChild` 到 `document.head`，
  且重复挂载不重复注入。**没有 document 时这条路径会被静默跳过**，
  所以测试必须显式注入一个假 document。
- 同一测试内检查**禁用 token 清单**：出现 `label-tertiary` /
  `state-business-primary` / `settings-card-` / `border-l3` / `border-l4` /
  `interactive-bg-hover` / `dsw-radius` 任一即失败。

## 3. 本地渲染预览

样式问题只能靠**看**发现。`node scripts/preview.mjs` 用**同一份 CSS**和
**同一棵组件树**渲染出五个页面到 `preview/*.html`，再用无头浏览器截图即可比对。

关键点：预览器要按**真实那 14 个 token** 注入一份浅色值 ——
如果预览用的是另一套 token 名，截图就不能代表真机。

## 4. 其它约定

- 面板最外层是 `.mag-root`（`max-width:100%`，不写死宽度 —— 设置页宽度有限，写死 1180px 会撑出横向滚动）；
- 两栏布局用 `.mag-two`，**880px 以下自动单栏**；
- 数据表一律包在 `.mag-tbl-wrap` 里（窄容器下横向滚动）；模型表是 grid 行（`.mag-mhead` / `.mag-mrow` 共用列宽），**620px 以下隐藏「状态」列**，否则窄面板里会出现半截徽章；
- 所有类名加 `mag-` 前缀，避免与 DSH 自带样式撞名。

## 5. 视图层写法（2026-10 改版）

界面不再是 React 组件树，而是「投影 → HTML 字符串 + 一处事件委托」：
`GatewayPanelView` 只挂一个 `<div>`，`paint()` 把 `panelHTML(state)` 写进去。
所以：

- 新增界面 = 加一个返回字符串的 `xxxHTML(state)`，**不要**再引入组件；
- 所有可输入元素必须带 `data-k`，否则整块重建后焦点会丢；
- 点击 / 输入统一走 `data-act`，在 `onClick` / `onChange` 里分发；
- 保存语义：模型勾选、上下文长度、设置页字段都先进**草稿**，点「保存并生效」
  才写盘并重发 provider；草稿态下界面立即变化（开关会翻），但没保存前不算数。