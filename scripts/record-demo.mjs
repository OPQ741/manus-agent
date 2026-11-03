/**
 * 一键录「使用演示视频」：起服务 → 跑 scripts/demo-capture.mjs 真实链路录屏 → 切成 mp4。
 *
 *   npm run demo:record                 # 全流程，产物 docs/demo/nucleus-demo.mp4
 *   npm run demo:record -- --no-shots   # 只录视频，不动 docs/screenshots
 *   npm run demo:record -- --with-e2e   # 录之前先跑一遍 npm run e2e（14 步真实浏览器断言）
 *   npm run demo:record -- --port=8912 --keep
 *
 * 三件容易踩的事，这个脚本替你处理掉：
 *  1. **Key 跟着数据目录走**。演示数据目录是临时的，而 `providers.local.json` 在 `data/` 里 ——
 *     直接换个空目录，主力通道就没 Key，录出来的是免 Key 通道的朴素产物。脚本会把本机 Key
 *     读出来注入子进程环境变量，并打印服务端实际选中的通道，让你录之前就知道在录什么。
 *  2. **后台服务必须收干净**。Git Bash 里没有 `pkill`，`node server & kill $!` 杀到的常常是
 *     子 shell，服务留在端口上：下一次调用要么 EADDRINUSE，要么因为管道没关被工具判成超时。
 *     所以这里用子进程管理，退出前一定等到服务真的结束。
 *  3. **ffmpeg 不是必装**。优先用 PATH 上的 ffmpeg，其次找 ./.tmp-ffmpeg/ffmpeg(.exe)；
 *     都没有就把 webm 留在原地并打印转换命令，不让录好的素材因为缺一个转换器而白跑。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const hasFlag = (name) => process.argv.slice(2).includes(`--${name}`)

const PORT = Number(argOf('port', process.env.PORT ?? 8911))
const TMP = join(ROOT, '.tmp-demo')
const DATA_DIR = join(TMP, 'data')
const VIDEO_DIR = join(TMP, 'video')
const SHOT_DIR = hasFlag('no-shots') ? join(TMP, 'shots') : join(ROOT, 'docs', 'screenshots')
const OUT_MP4 = join(ROOT, 'docs', 'demo', 'nucleus-demo.mp4')

const run = (command, args, options = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolvePromise(code) : reject(new Error(`${command} 退出码 ${code}`))))
  })

/** 起服务并等它健康；返回子进程与它选中的通道（stdout 第一行）。 */
async function startServer() {
  const env = { ...process.env, PORT: String(PORT), NUCLEUS_DATA_DIR: DATA_DIR }
  // 把本机 Key 搬进子进程环境：读法与 scripts/deploy.mjs 一致（env > 本地文件）
  const localFile = join(ROOT, 'data', 'providers.local.json')
  if (existsSync(localFile)) {
    try {
      const local = JSON.parse(readFileSync(localFile))
      for (const item of local.providers ?? []) {
        if (!item.apiKey) continue
        env[String(item.keyEnv ?? `${String(item.id).toUpperCase()}_API_KEY`)] = item.apiKey
      }
    } catch {
      console.log('（读不动 data/providers.local.json，忽略：会退到免 Key 通道）')
    }
  }
  const catalog = join(ROOT, 'config', 'providers.json')
  if (!env.NUCLEUS_PROVIDER && existsSync(catalog)) {
    try {
      env.NUCLEUS_PROVIDER = JSON.parse(readFileSync(catalog)).default
    } catch { /* 拿不到就用服务端自己的默认 */ }
  }

  const server = spawn('node', [join('dist', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', (chunk) => (log += chunk))
  server.stderr.on('data', (chunk) => (log += chunk))
  const healthy = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok
    } catch {
      return false
    }
  }
  for (let i = 0; i < 60 && !(await healthy()); i += 1) {
    if (server.exitCode !== null) throw new Error(`服务没起来：\n${log}`)
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!(await healthy())) throw new Error(`服务健康检查超时：\n${log}`)
  return { server, banner: log.trim().split('\n')[0] ?? '' }
}

const stopServer = (server) =>
  new Promise((resolvePromise) => {
    if (!server || server.exitCode !== null) return resolvePromise()
    server.once('exit', resolvePromise)
    server.kill()
    setTimeout(resolvePromise, 4_000)
  })

/** 录屏文件在 context 关闭时才落盘，取目录里最新的那个。 */
function newestWebm(dir) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.webm'))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files[0] ? join(dir, files[0].name) : null
}

/** 先认项目里下到 .tmp-ffmpeg 的那份静态二进制，再退到 PATH 上的 ffmpeg。 */
function spawnSyncOk(command, args) {
  try {
    return spawnSync(command, args, { cwd: ROOT, stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function findFfmpeg() {
  const local = [join(ROOT, '.tmp-ffmpeg', 'ffmpeg.exe'), join(ROOT, '.tmp-ffmpeg', 'ffmpeg')]
  for (const path of local) if (existsSync(path)) return path
  return spawnSyncOk('ffmpeg', ['-version']) ? 'ffmpeg' : null
}

console.log(`\n录演示视频 · http://127.0.0.1:${PORT}`)
console.log(`截图目录 ${SHOT_DIR === join(ROOT, 'docs', 'screenshots') ? 'docs/screenshots（正式素材）' : SHOT_DIR}`)

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const { server, banner } = await startServer()
console.log(`\n② 服务已起：${banner}`)
if (hasFlag('with-e2e')) {
  console.log('\n②.1 先跑 e2e（14 步真实浏览器断言，同一个服务）')
  await run('node', [join('scripts', 'e2e.mjs')], { env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}` } })
}
if (banner && !/active=(aliyun|dots|deepseek|gemini|moonshot|zhipu|openrouter|siliconflow)/.test(banner)) {
  console.log('   （注意：看起来没走带 Key 的主力通道，产物会朴素一些。要换就设 ALIYUN_API_KEY 后重跑）')
}

let code = 0
try {
  await run('node', [join('scripts', 'demo-capture.mjs')], {
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${PORT}`, SHOT_DIR, VIDEO_DIR },
  })
} catch (error) {
  code = 1
  console.error(error.message)
} finally {
  await stopServer(server)
  console.log('③ 服务已关闭')
}

const webm = existsSync(VIDEO_DIR) ? newestWebm(VIDEO_DIR) : null
if (!webm) {
  console.log('\n没找到录屏文件（采集脚本可能在起浏览器前就失败了）。')
  process.exit(code || 1)
}
console.log(`\n录屏原始文件：${webm}  ${(statSync(webm).size / 1024 / 1024).toFixed(1)} MB`)

const ffmpeg = findFfmpeg()
if (!ffmpeg) {
  console.log('没找到 ffmpeg。素材已经录好，装好后自己切一条即可：')
  console.log(`  ffmpeg -y -i "${webm}" -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart "${OUT_MP4}"`)
  process.exit(code)
}

mkdirSync(join(ROOT, 'docs', 'demo'), { recursive: true })
console.log(`\n④ 用 ${ffmpeg} 切成 mp4 …`)
await run(ffmpeg, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-i', webm,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '28',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  OUT_MP4,
])
console.log(`✓ ${OUT_MP4}  ${(statSync(OUT_MP4).size / 1024 / 1024).toFixed(1)} MB`)
if (!hasFlag('keep')) console.log(`  （原始 webm 留在 ${VIDEO_DIR}，要重切就别删）`)
process.exit(code)
