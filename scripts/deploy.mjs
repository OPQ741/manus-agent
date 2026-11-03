#!/usr/bin/env node
/**
 * 一键部署准备。
 *
 * 它解决的是一件很具体的事：**模型配置以前只活在本机**。
 *
 * 之前 Key 放在 data/providers.local.json，而 data/ 整个被 gitignore ——
 * 于是「本地跑得好好的，部署上去却只剩免 Key 通道在硬扛」，
 * 设置页还会因为目录里缺条目而报「配置里的 xxx 缺 baseUrl 或 model」。
 *
 * 现在的分工：
 *   ① 目录结构（哪家是主力、用哪个模型、走哪个接入点）→ config/providers.json，可入库、随部署上传；
 *   ② Key                                              → 部署脚本在**服务端**注入环境变量，不落盘到仓库。
 *
 * 本脚本做四件事：
 *   1. 收 Key（命令行 > 环境变量 > 本机 data/providers.local.json）；
 *   2. 真打一次上游验证 Key 与模型名（错的 Key 不该等到线上才发现）；
 *   3. 校验 config/providers.json 在「纯环境变量、无本地文件」模式下能装配出可用目录；
 *   4. 生成 deploy/start.sh（含 Key，已 gitignore）并构建，最后打印可直接用于发布的启动命令。
 *
 * 用法：
 *   npm run deploy:prepare                          # 收集 → 校验 → 构建 → 打印部署参数
 *   npm run deploy:prepare -- --skip-build          # 只收集与校验
 *   node scripts/deploy.mjs --aliyun-key=sk-...     # 直接传入（不落本机文件）
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_FILE = join(ROOT, 'config', 'providers.json')
const LOCAL_FILE = join(ROOT, 'data', 'providers.local.json')
const DEPLOY_DIR = join(ROOT, 'deploy')

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
}

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue
    const [key, ...rest] = arg.slice(2).split('=')
    out[key] = rest.length ? rest.join('=') : 'true'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const skipBuild = args['skip-build'] === 'true'

/* ------------------------------------------------------------------ */
/* 1. 收 Key                                                           */
/* ------------------------------------------------------------------ */

/** 本机那份只是**迁移来源**：读得到就用，读不到也不算错（服务器上本来就没有）。 */
function readLocalKeys() {
  if (!existsSync(LOCAL_FILE)) return {}
  try {
    const parsed = JSON.parse(readFileSync(LOCAL_FILE, 'utf8'))
    const out = {}
    for (const entry of parsed.providers ?? []) {
      const key = entry.apiKey?.trim()
      if (entry.id && key) out[entry.id] = key
    }
    return out
  } catch {
    return {}
  }
}

const localKeys = readLocalKeys()
const collected = {
  aliyun: args['aliyun-key'] || process.env.ALIYUN_API_KEY?.trim() || localKeys.aliyun || '',
  dots: args['dots-key'] || process.env.DOTS_API_KEY?.trim() || localKeys.dots || '',
}

console.log(C.bold('\n① 收集模型通道的 Key'))
const sources = []
for (const [id, key] of Object.entries(collected)) {
  if (!key) continue
  const from = args[`${id}-key`] ? '命令行' : process.env[id === 'aliyun' ? 'ALIYUN_API_KEY' : 'DOTS_API_KEY'] ? '环境变量' : '本机 data/providers.local.json'
  sources.push(`${id} ← ${from}`)
  console.log(`   ${C.green('✓')} ${id.padEnd(8)} ${key.slice(0, 10)}…${key.slice(-4)}`)
}
if (!collected.aliyun && !collected.dots) {
  console.log(C.red('   ✗ 一个 Key 都没拿到'))
  console.log(C.dim('     用 --aliyun-key=xxx 传入，或先设环境变量 ALIYUN_API_KEY / DOTS_API_KEY，'))
  console.log(C.dim('     或在本机跑一次 npm run key -- aliyun <key>（本机那份只作迁移来源，不会上传）。'))
  process.exit(1)
}
for (const [id] of Object.entries(collected)) {
  if (!collected[id]) console.log(`   ${C.yellow('!')} ${id.padEnd(8)} 未提供，将不注入`)
}

/* ------------------------------------------------------------------ */
/* 2. 读配置目录                                                       */
/* ------------------------------------------------------------------ */

console.log(C.bold('\n② 读取服务端目录配置 config/providers.json'))

let catalogFile
try {
  catalogFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
} catch (error) {
  console.log(C.red(`   ✗ 读不动：${error.message}`))
  process.exit(1)
}

const byId = new Map((catalogFile.providers ?? []).map((entry) => [entry.id, entry]))
const declaredDefault = catalogFile.default
console.log(`   主力：${C.bold(declaredDefault ?? '(未声明)')}`)
console.log(`   条目：${[...byId.keys()].join(', ')}`)

/* ------------------------------------------------------------------ */
/* 3. 真打上游验证                                                     */
/* ------------------------------------------------------------------ */

console.log(C.bold('\n③ 真打一次上游，验证 Key 与模型名'))

/** 短到几 token 的一次调用：既验 Key，也验模型名存在。 */
async function probe({ baseUrl, model, apiKey, authHeader }) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  if (authHeader) headers[authHeader] = apiKey
  const started = Date.now()
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '回复两个字：可用' }],
      max_tokens: 256,
      reasoning_effort: 'low',
    }),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 160)}`, ms: Date.now() - started }
  let content = ''
  try {
    content = JSON.parse(text).choices?.[0]?.message?.content ?? ''
  } catch {
    return { ok: false, detail: '响应不是合法 JSON', ms: Date.now() - started }
  }
  if (!content.trim()) return { ok: false, detail: '回包里没有 content（模型名可能不对）', ms: Date.now() - started }
  return { ok: true, detail: content.trim().slice(0, 40), ms: Date.now() - started }
}

const probes = []
for (const [id, key] of Object.entries(collected)) {
  const entry = byId.get(id)
  if (!key) continue
  if (!entry?.baseUrl || !entry?.model) {
    console.log(C.red(`   ✗ ${id.padEnd(8)} config/providers.json 里缺 baseUrl 或 model`))
    probes.push({ id, ok: false })
    continue
  }
  const result = await probe({
    baseUrl: entry.baseUrl,
    model: entry.model,
    apiKey: key,
    authHeader: entry.authHeader,
  })
  probes.push({ id, ok: result.ok })
  console.log(
    result.ok
      ? `   ${C.green('✓')} ${id.padEnd(8)} ${result.ms}ms  ${C.dim(JSON.stringify(result.detail))}`
      : `   ${C.red('✗')} ${id.padEnd(8)} ${result.detail}`,
  )
}

/* ------------------------------------------------------------------ */
/* 4. 装配校验（模拟服务器：只有环境变量，没有本机文件）               */
/* ------------------------------------------------------------------ */

console.log(C.bold('\n④ 模拟服务器：只有环境变量、没有 data/providers.local.json'))

const serverEnv = {}
for (const [id, key] of Object.entries(collected)) {
  if (key) serverEnv[byId.get(id)?.keyEnv ?? `${id.toUpperCase()}_API_KEY`] = key
}
if (declaredDefault) serverEnv.NUCLEUS_PROVIDER = declaredDefault

const readyIds = Object.entries(collected)
  .filter(([, key]) => key)
  .map(([id]) => id)
const problems = []

if (!declaredDefault) problems.push('config/providers.json 没有声明 default')
else if (!byId.has(declaredDefault)) problems.push(`default「${declaredDefault}」不在 providers 列表里`)
else if (!collected[declaredDefault]) {
  problems.push(
    `default「${declaredDefault}」没有 Key —— 服务器会退到别的通道或免 Key 兜底`,
  )
}

for (const [id, entry] of byId) {
  if (entry.enabled === false) continue
  if (collected[id]) continue
  // 没给 Key 的通道在服务器上不会就绪，这是正常的，不算错
}
if (readyIds.length === 0) problems.push('没有任何一条通道能拿到 Key')

if (problems.length) {
  for (const problem of problems) console.log(C.red(`   ✗ ${problem}`))
} else {
  console.log(`   ${C.green('✓')} 主力 ${C.bold(declaredDefault)}，就绪通道：${readyIds.join(', ') || '(无)'}`)
  console.log(C.dim(`   （其余通道没给 Key，服务器上会显示未就绪 —— 想启用就补上对应的环境变量）`))
}

for (const probe of probes) {
  if (!probe.ok) problems.push(`${probe.id} 的上游验证没通过`)
}

/* ------------------------------------------------------------------ */
/* 5. 生成部署产物                                                     */
/* ------------------------------------------------------------------ */

console.log(C.bold('\n⑤ 生成服务端启动脚本'))

mkdirSync(DEPLOY_DIR, { recursive: true })
const envAssignments = [`NUCLEUS_PROVIDER=${declaredDefault ?? 'aliyun'}`]
for (const [id, key] of Object.entries(collected)) {
  if (key) envAssignments.push(`${byId.get(id)?.keyEnv ?? `${id.toUpperCase()}_API_KEY`}='${key}'`)
}

// 自建服务器复用的一份：逐行 export，读得懂也改得动。
const startScript = [
  '#!/usr/bin/env sh',
  '# 由 scripts/deploy.mjs 生成 —— 内含密钥，已 gitignore，只用于随部署包上传。',
  '# 用法：bash deploy/start.sh（先注入下面的环境变量，再启动服务）',
  '',
  ...envAssignments.map((assignment) => `export ${assignment}`),
  '',
  'exec npm start',
  '',
].join('\n')
writeFileSync(join(DEPLOY_DIR, 'start.sh'), startScript, 'utf8')

// 发布平台通常只给一条启动命令，那就把环境变量写成**命令前缀赋值**
// （`A=1 B=2 cmd`）—— 这是 POSIX sh 通用的写法，`export A=1 export B=2 cmd` 反而不合法。
// 这样 Key 连"落到部署包文件里"这一步都省了，只在进程启动时存在于环境里。
const inlineStart = `${envAssignments.join(' ')} npm start`
writeFileSync(join(DEPLOY_DIR, 'start-command.txt'), inlineStart + '\n', 'utf8')

console.log(`   ${C.green('✓')} deploy/start.sh        ${C.dim('（含 Key，已 gitignore，供自建服务器复用）')}`)
console.log(`   ${C.green('✓')} deploy/start-command.txt ${C.dim('（发布平台的 startCmd，Key 只存在于启动命令）')}`)

/* ------------------------------------------------------------------ */
/* 6. 构建                                                             */
/* ------------------------------------------------------------------ */

if (skipBuild) {
  console.log(C.bold('\n⑥ 构建'))
  console.log(C.dim('   --skip-build：跳过'))
} else {
  console.log(C.bold('\n⑥ 构建（typecheck + 客户端 + 服务端）'))
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
    console.log(`   ${C.green('✓')} 构建完成`)
  } catch {
    problems.push('构建失败，先修好再发布')
  }
}

/* ------------------------------------------------------------------ */
/* 7. 打印部署清单                                                     */
/* ------------------------------------------------------------------ */

console.log(C.bold('\n⑦ 部署参数'))
console.log(C.dim('   发布平台需要的启动命令（Key 随进程启动注入，不会写进仓库）：'))
console.log(`\n   ${inlineStart}\n`)
console.log(C.dim('   服务监听 $PORT 并绑定 0.0.0.0，端口默认 8787。'))

if (problems.length) {
  console.log(C.red('\n有 ' + problems.length + ' 个问题需要先解决：'))
  for (const problem of problems) console.log(C.red('   · ' + problem))
  process.exit(1)
}

console.log(C.green('\n全部就绪，可以发布了。'))
