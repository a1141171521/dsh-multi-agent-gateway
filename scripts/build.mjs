/**
 * 构建脚本：`src` 下的 TypeScript → `lib` 下的 JavaScript（**零第三方依赖**）。
 *
 * ## 为什么不用 tsc / tsdown / esbuild
 *
 * DSH 插件要在**没有构建工具链**的机器上装得上、跑得起来（`dsh plugin add`
 * 只跑 pnpm，不会帮你编译）。所以这里用 Node 自带的
 * `module.stripTypeScriptTypes()`（Node 22.13+ 有）做**类型擦除**：
 *
 *   - 输入：只使用「可擦除语法」的 TypeScript（不用 enum / namespace /
 *     参数属性 / `declare`）—— 这一点由本脚本**预先校验**，写错了立刻报错，
 *     不会生成半截产物；
 *   - 输出：标准 ESM `.js`，`import` 里已经写成 `./x.js`（与 TS 的 nodenext
 *     约定一致），所以**不需要改写任何 import 说明符**；
 *   - 顺带从 `src/**` 里挑出 `.js` 之类非 TS 文件原样拷贝（目前只有 client 半边，
 *     它本来就是手写的浏览器 bundle，不参与构建）。
 *
 * 用法：
 *   node scripts/build.mjs            # 构建
 *   node scripts/build.mjs --check    # 只校验可擦除性，不写文件
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')
const checkOnly = process.argv.includes('--check')

/** 递归列出文件。 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 把一个 .ts 转成 .js。 */
function transpile(file) {
  const source = readFileSync(file, 'utf8')
  try {
    return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file })
  } catch (error) {
    throw new Error(`${relative(root, file)} 含有不可擦除的 TypeScript 语法：${error.message}`)
  }
}

const files = walk(srcDir)
const tsFiles = files.filter((file) => file.endsWith('.ts'))
const otherFiles = files.filter((file) => !file.endsWith('.ts'))

let failures = 0
for (const file of tsFiles) {
  try {
    const output = transpile(file)
    if (!checkOnly) {
      const target = join(libDir, relative(srcDir, file).replace(/\.ts$/, '.js'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, output, 'utf8')
    }
  } catch (error) {
    failures += 1
    console.error(`✗ ${error.message}`)
  }
}

if (failures > 0) {
  console.error(`\n构建失败：${failures} 个文件有不可擦除语法。`)
  process.exit(1)
}

if (!checkOnly) {
  // 非 TS 文件原样拷贝（保持目录结构）。
  for (const file of otherFiles) {
    const target = join(libDir, relative(srcDir, file))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(file))
  }
  console.log(`✓ 构建完成：${tsFiles.length} 个 TypeScript 文件 → lib/`)
}

// ── 客户端半边：手写的浏览器 bundle，直接复制到 lib/client.js ──
const clientSource = join(root, 'client', 'client.js')
if (statSync(clientSource, { throwIfNoEntry: false }) !== undefined) {
  if (!checkOnly) {
    const target = join(libDir, 'client.js')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(clientSource))
    console.log('✓ 客户端半边 → lib/client.js')
  }
} else {
  console.warn('! 没有找到 client/client.js —— 设置页将不会出现配置表单')
}

// ── 自检：产物能被 Node 解析 ──
if (!checkOnly) {
  const entry = join(libDir, 'index.js')
  const source = readFileSync(entry, 'utf8')
  if (!source.includes('export default')) {
    console.error('✗ lib/index.js 里没有 export default —— DSH 加载器只会看到一半的导出')
    process.exit(1)
  }
  rmSync(join(libDir, 'test'), { recursive: true, force: true })
}
