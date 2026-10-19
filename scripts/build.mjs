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
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')
const checkOnly = process.argv.includes('--check')

/**
 * 构建锁：**允许多个进程同时构建，但同一时刻只跑一个**。
 *
 * 为什么需要：`lib/` 是**全量**产物（40 个文件），而多个人/多个终端同时
 * 改不同模块时都会跑构建。没有锁就会出现「A 刚写完 lib，B 用它自己那份
 * 基于旧 src 的产物覆盖掉」—— 症状是**测试莫名其妙地过了或挂了**，
 * 而且换一次运行结果就变（本仓库真的踩过）。
 *
 * 实现取「排他创建 + 过期抢占」：
 *   · `wx` 打开成功 = 拿到锁；
 *   · 已存在且**未过期** → 退避重试；
 *   · 已存在但**超过 staleMs** → 认为持锁进程已死（被 Ctrl-C 掉），抢占。
 *
 * 崩溃后残留的锁最多让下一次构建等 `staleMs`，不会永久卡死。
 */
function acquireLock() {
  const lockPath = join(root, '.build.lock')
  const staleMs = 30_000
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' })
      return () => rmSync(lockPath, { force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let ageMs = 0
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs
      } catch {
        continue // 锁刚被别人释放 —— 直接重试
      }
      if (ageMs > staleMs) {
        rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(`等待构建锁超时（${lockPath} 被 pid=${readFileSync(lockPath, 'utf8').trim()} 持有）`)
      }
      // 同步退避：构建本身只跑一秒，不值得为它上异步。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
    }
  }
}

// `--check` 不写文件，无需串行。
const releaseLock = checkOnly ? () => {} : acquireLock()
process.on('exit', () => releaseLock())

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

/**
 * 把一个 .ts 转成 .js。
 *
 * ⚠️ **`sourceUrl` 必须是仓库相对路径**，不能传绝对路径。
 * `stripTypeScriptTypes` 会把它写成产物末尾的 `//# sourceURL=` 注释，
 * 传绝对路径就意味着 `lib/` 里嵌了**本机的绝对路径**（`D:\AI\…` / `E:\AIProject\…`）：
 *   · 换一台机器 / 换一个盘符构建，40 个产物文件全变成「已修改」，
 *     真实改动被这一行路径噪声淹没（本仓库真发生过，每轮都要手工 revert）；
 *   · 多个人同时构建时互相覆盖，diff 里全是路径。
 * 相对路径对 source map 的调试用途没有损失 —— 栈里显示 `src/core/cache.ts`
 * 比显示某台机器的绝对路径更有用。
 */
function transpile(file) {
  const source = readFileSync(file, 'utf8')
  const stableUrl = relative(root, file).split(sep).join('/')
  try {
    return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: stableUrl })
  } catch (error) {
    throw new Error(`${stableUrl} 含有不可擦除的 TypeScript 语法：${error.message}`)
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

// ── 二进制资产：src 下的 .wasm 要跟到 lib 的同名位置 ──
//
// Qoder 的 WASM 桥用 `resolve(dirname(import.meta.url), 'qoder-auth-wasm.wasm')`
// 读文件 —— 它找的是**编译产物旁边**，所以只放在 src 里不够，必须复制。
function copyWasmAssets(from, to) {
  if (statSync(from, { throwIfNoEntry: false }) === undefined) return 0
  let count = 0
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      count += copyWasmAssets(source, target)
    } else if (entry.isFile() && entry.name.endsWith('.wasm')) {
      if (!checkOnly) {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, readFileSync(source))
      }
      count += 1
    }
  }
  return count
}
const wasmCount = copyWasmAssets(srcDir, libDir)
if (wasmCount > 0) console.log(`✓ ${wasmCount} 个 .wasm 资产 → lib/`)

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
