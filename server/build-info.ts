/**
 * 服务端读取构建指纹。
 *
 * 产物在哪就写在哪：`dist/build.json` 由 scripts/build-meta.mjs 在构建时写入，
 * 所以这里按"离 server.js 最近的 dist"去找，而不是假设进程从项目根启动
 * （部署平台的工作目录经常不是仓库根）。
 *
 * 环境变量优先，是因为发布平台可以不动代码就声明"这份产物的提交是哪个"：
 * `NUCLEUS_COMMIT` / `NUCLEUS_BUILT_AT`。两者都没有时明确回 unknown，
 * 而不是编一个版本号 —— 编出来的版本号比没有更误导。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BuildMeta } from '../shared/types'

const UNKNOWN: BuildMeta = {
  version: '0.0.0',
  commit: 'unknown',
  commitFull: 'unknown',
  branch: 'unknown',
  dirty: false,
  builtAt: '',
}

function fromEnv(): Partial<BuildMeta> | null {
  const commit = process.env.NUCLEUS_COMMIT?.trim()
  if (!commit) return null
  const out: Partial<BuildMeta> = { commitFull: commit, commit: commit.slice(0, 7) }
  // 只覆盖显式给了值的字段：平台通常只传 commit，剩下的（构建时间、分支）
  // 应该回落到 dist/build.json，而不是被空值抹掉。
  const version = process.env.NUCLEUS_VERSION?.trim()
  if (version) out.version = version
  const branch = process.env.NUCLEUS_BRANCH?.trim()
  if (branch) out.branch = branch
  const builtAt = process.env.NUCLEUS_BUILT_AT?.trim()
  if (builtAt) out.builtAt = builtAt
  if (process.env.NUCLEUS_DIRTY) out.dirty = process.env.NUCLEUS_DIRTY === '1'
  return out
}

function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  return [
    // bundle 后：dist/server.js 旁边
    join(here, 'build.json'),
    // 源码直跑（vitest / tsx）：项目根的 dist/build.json
    join(here, '..', 'dist', 'build.json'),
    join(process.cwd(), 'dist', 'build.json'),
  ]
}

function fromFile(): Partial<BuildMeta> | null {
  for (const file of candidates()) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildMeta>
      if (!parsed || typeof parsed.commit !== 'string' || !parsed.commit) continue
      return parsed
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return null
}

let cached: BuildMeta | null = null

/**
 * 环境变量与文件逐字段合并：环境变量优先（它能声明"这次部署的是哪个提交"），
 * 缺的字段回落到文件。以前是"有环境变量就整个用它"，于是平台只传了 commit 时，
 * 构建时间和分支一起变成空值 —— 页面上看起来像"不知道为什么没有时间"。
 */
export function readBuildMeta(): BuildMeta {
  if (!cached) {
    const file = fromFile()
    const env = fromEnv()
    cached = file || env ? { ...UNKNOWN, ...(file ?? {}), ...(env ?? {}) } : UNKNOWN
  }
  return cached
}

/** 测试用：清掉缓存，模拟"换了产物重新启动"。 */
export function resetBuildMeta(): void {
  cached = null
}
