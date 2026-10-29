# vendor/

宿主半边**零运行时依赖**用的第三方副本。

| 目录 | 上游 | 版本 | 文件 |
|---|---|---|---|
| `schemastery/` | `@deepseek-ai/schemastery`（MIT） | 3.18.5 | 上游 `lib/index.mjs` → `index.js`，只改首行 import |
| `cosmokit/` | `@deepseek-ai/cosmokit`（MIT） | 1.8.6 | 上游 `lib/index.js`，未改 |

## 为什么要 vendor

DSH 的本地目录安装（`dsh plugin add D:\path\to\plugin`）走 `pnpm link`：**只建符号链接，
不装依赖**。Node 解析模块时按真实路径找 `node_modules`，因此找不到 profile 里那份
hoisted 的 `@deepseek-ai/schemastery`，插件在 `import` 阶段就报：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
imported from D:\tools\dsh-multi-agent-gateway\lib\config.js
```

放进 `vendor/` 之后，解压即用、不需要 `npm install`，也不会因为别人机器上的
profile 布局不同而炸。

## 怎么升级

```powershell
# 1. 拉新版（在插件目录 npm install 之后）
$s = Get-Content node_modules\@deepseek-ai\schemastery\lib\index.mjs -Raw
$s = $s.Replace('from "@deepseek-ai/cosmokit"', 'from "../cosmokit/index.js"')
Set-Content vendor\schemastery\index.js $s -NoNewline -Encoding utf8
Copy-Item node_modules\@deepseek-ai\cosmokit\lib\index.js vendor\cosmokit\index.js -Force
Copy-Item node_modules\@deepseek-ai\schemastery\LICENSE vendor\schemastery\LICENSE -Force
Copy-Item node_modules\@deepseek-ai\cosmokit\LICENSE vendor\cosmokit\LICENSE -Force
```

改完跑 `node scripts/build.mjs && npm test`。`lib/config.js` 里的 import 是
`../vendor/schemastery/index.js`，对 `src/` 和 `lib/` 都指向同一个目录。

## 许可

两个包都是 MIT，许可证原文分别在 `schemastery/LICENSE`、`cosmokit/LICENSE`。
