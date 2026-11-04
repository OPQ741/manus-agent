#!/usr/bin/env node
/**
 * 线上 / 本地同版核对。
 *
 * 解决的是评审最常问、也最难自证的一句：**线上跑的是仓库哪个提交**。
 *
 * 三路证据一起看，缺一条都不足以下结论：
 *   ① /api/health 的 build —— 服务端产物自己报的 commit 与构建时间；
 *   ② HTML 引用的 /assets/* 文件名 —— 内容哈希，构建变了名字一定变；
 *   ③ 本地 dist 的同两项 —— 作为对照组。
 *
 * 注意托管网关的行为：不带口令的请求（包括静态资源）会返回一页
 * "链接不完整"，看起来像 200 的正常页面。所以这里所有请求都带口令，
 * 并且会识别"拿到的其实是网关兜底页"这种情况，避免把兜底页当成应用首页。
 *
 * 用法：
 *   npm run verify:live -- --url=https://xxx.host --code=XXXXXXX
 *   NUCLEUS_LIVE_URL=... NUCLEUS_SHARE_CODE=... npm run verify:live
 *
 * 退出码：0 = 同版；1 = 不同版或有任一环节没取到；2 = 参数缺失。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
const ORIGIN = (args.url || process.env.NUCLEUS_LIVE_URL || '').replace(/\/+$/, '')
const CODE = args.code || process.env.NUCLEUS_SHARE_CODE || ''

if (!ORIGIN) {
  console.error('缺少线上地址：npm run verify:live -- --url=https://xxx.host --code=XXXXXXX')
  process.exit(2)
}

const withCode = (path) => {
  if (!CODE) return `${ORIGIN}${path}`
  return `${ORIGIN}${path}${path.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(CODE)}`
}

async function get(path) {
  const res = await fetch(withCode(path), { signal: AbortSignal.timeout(20_000) })
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() }
}

/** 网关兜底页的特征：看起来 200，其实是"链接不完整"，正文里没有应用入口。 */
function isGatewayPage(html) {
  return html.includes('链接不完整') && !html.includes('/assets/')
}

function assetsOf(html) {
  return [...new Set([...html.matchAll(/\/assets\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]))].sort()
}

function readLocalBuild() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'dist', 'build.json'), 'utf8'))
  } catch {
    return null
  }
}

function readLocalAssets() {
  try {
    return assetsOf(readFileSync(join(ROOT, 'dist', 'client', 'index.html'), 'utf8'))
  } catch {
    return []
  }
}

const short = (build) =>
  build
    ? `${build.commit ?? 'unknown'}${build.dirty ? '+' : ''} · ${build.branch ?? '?'} · ${build.builtAt || '(无构建时间)'}`
    : '(没有构建指纹)'

console.log(`\n线上 ${ORIGIN}`)

let html
try {
  html = await get('/')
} catch (error) {
  console.error(`✗ 拉不到首页：${error.message}`)
  process.exit(1)
}
if (html.status !== 200) {
  console.error(`✗ 首页返回 HTTP ${html.status}`)
  process.exit(1)
}
if (isGatewayPage(html.text)) {
  console.error('✗ 拿到的是网关的「链接不完整」页 —— 口令缺失或过期，不是应用首页')
  process.exit(1)
}

let health
try {
  health = JSON.parse((await get('/api/health')).text)
} catch (error) {
  console.error(`✗ /api/health 取不到 JSON（多半也被网关拦了）：${error.message}`)
  process.exit(1)
}

const liveBuild = health.build ?? null
const liveAssets = assetsOf(html.text)
const localBuild = readLocalBuild()
const localAssets = readLocalAssets()

console.log(`  构建   ${short(liveBuild)}`)
console.log(`  资源   ${liveAssets.join(', ') || '(没解析到)'}`)
console.log(`\n本地 ${ROOT}`)
console.log(`  构建   ${short(localBuild)}`)
console.log(`  资源   ${localAssets.join(', ') || '(还没构建过：npm run build)'}`)

const problems = []
const notes = []
if (!liveBuild) problems.push('线上没有构建指纹 —— 说明部署的是一份 build-meta 之前的老产物')
if (!localBuild) problems.push('本地没有 dist/build.json —— 先跑一次 npm run build')
if (liveAssets.length === 0) problems.push('线上首页没解析到任何 /assets 资源，无法比对')
if (localAssets.length === 0) problems.push('本地没有 dist/client/index.html，无法比对')

if (liveBuild && localBuild) {
  if (liveBuild.commitFull !== localBuild.commitFull) {
    problems.push(`提交不同：线上 ${liveBuild.commit} ≠ 本地 ${localBuild.commit}`)
  } else if (liveBuild.builtAt !== localBuild.builtAt) {
    /*
     * 同一提交在两台机器上各构建一次是常态（本地打一次、平台 prestart 再打一次），
     * 构建时间必然不同，但产物内容由源码决定。所以时间差异只作提示，
     * 真正的同版判据是下面那行资源哈希。
     */
    notes.push(`构建时间不同（线上 ${liveBuild.builtAt} / 本地 ${localBuild.builtAt}）—— 同提交重建，内容一致即可`)
  }
}

const missing = liveAssets.filter((asset) => !localAssets.includes(asset))
const extra = localAssets.filter((asset) => !liveAssets.includes(asset))
if (liveAssets.length && localAssets.length && (missing.length || extra.length)) {
  problems.push(`静态资源不同：线上独有 [${missing.join(', ')}] / 本地独有 [${extra.join(', ')}]`)
}

if (problems.length === 0) {
  if (notes.length) for (const note of notes) console.log(`\n提示：${note}`)
  console.log('\n✓ 同版：线上产物与本地 dist 来自同一份源码\n')
  process.exit(0)
}

console.log('\n✗ 不同版：')
for (const problem of problems) console.log(`  · ${problem}`)
console.log('\n要同版：用同一份工作区重新 build 并重新发布，然后重跑本命令。\n')
process.exit(1)
