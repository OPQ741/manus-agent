#!/usr/bin/env node
/**
 * 构建指纹。
 *
 * 要解决的是一个反复出现的对账问题：**线上那一版，到底是仓库哪个提交**。
 *
 * dist/ 在 .gitignore 里，构建产物不入库，所以"线上跑的这份"不对应任何 git 对象；
 * 再加上 prestart 会在每次启动时重新 build，一台机器重启两次都可能产出不同结果。
 * 光靠肉眼比对 JS 文件名（index-C1uQ8aei.js）只能得出"不一样"，说不出"差在哪"。
 *
 * 做法：构建前把 commit / 分支 / 是否有未提交改动 / 构建时间写进两个地方 ——
 *   ① dist/build.json   → 服务端进程可直接读，/api/health 与设置页展示；
 *   ② .tmp-build/meta.json → vite 用 define 注入前端，设置页能对比前后端是否同版。
 *
 * dirty=true 很重要：它表示这份产物不对应任何干净的提交，线上出问题时要先问
 * "是不是拿了未提交的工作区打的包"，而不是去翻 git log。
 */

import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function git(args, fallback) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || fallback
  } catch {
    return fallback
  }
}

let version = '0.0.0'
try {
  version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? version
} catch {
  /* 没有 package.json 也不该让构建挂掉 */
}

/**
 * 上一份产物里的指纹。
 *
 * 发布平台通常只拿到源码包、没有 .git，`git rev-parse` 在那里会失败。
 * 而部署包里带着的 dist/build.json 是**同一次源码构建**的产物，它的 commit
 * 就是这份源码的 commit —— 所以 git 不可用时继承它，而不是把指纹写成 unknown。
 * 若连这份文件也没有，才诚实地写 unknown（那确实无从得知）。
 */
let previous = null
try {
  previous = JSON.parse(readFileSync(join(ROOT, 'dist', 'build.json'), 'utf8'))
} catch {
  /* 首次构建 */
}

const envCommit = process.env.NUCLEUS_COMMIT?.trim() || ''
const inGit = Boolean(git('rev-parse --is-inside-work-tree', ''))
const commitFull = git('rev-parse HEAD', '') || envCommit || previous?.commitFull || 'unknown'
const commit = commitFull === 'unknown' ? 'unknown' : commitFull.slice(0, 7)
const branch = git('rev-parse --abbrev-ref HEAD', '') || process.env.NUCLEUS_BRANCH?.trim() || previous?.branch || 'unknown'
/** 没有 git 时无法判断工作区是否干净：沿用上一份产物的结论，而不是乐观地报 false。 */
const dirty = inGit ? git('status --porcelain', '').length > 0 : process.env.NUCLEUS_DIRTY === '1' || Boolean(previous?.dirty)

const meta = {
  version,
  commit,
  commitFull,
  branch,
  dirty,
  builtAt: new Date().toISOString(),
}

mkdirSync(join(ROOT, 'dist'), { recursive: true })
mkdirSync(join(ROOT, '.tmp-build'), { recursive: true })
writeFileSync(join(ROOT, 'dist', 'build.json'), JSON.stringify(meta, null, 2))
writeFileSync(join(ROOT, '.tmp-build', 'meta.json'), JSON.stringify(meta))

console.log(`[build-meta] ${meta.commit}${meta.dirty ? '+dirty' : ''} · ${meta.branch} · ${meta.builtAt}`)
