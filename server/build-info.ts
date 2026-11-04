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

function fromEnv(): BuildMeta | null {
  const commit = process.env.NUCLEUS_COMMIT?.trim()
  if (!commit) return null
  return {
    version: process.env.NUCLEUS_VERSION?.trim() || UNKNOWN.version,
    commit: commit.slice(0, 12),
    commitFull: commit,
    branch: process.env.NUCLEUS_BRANCH?.trim() || 'unknown',
    dirty: process.env.NUCLEUS_DIRTY === '1',
    builtAt: process.env.NUCLEUS_BUILT_AT?.trim() || '',
  }
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

function fromFile(): BuildMeta | null {
  for (const file of candidates()) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildMeta>
      if (!parsed || typeof parsed.commit !== 'string' || !parsed.commit) continue
      return { ...UNKNOWN, ...parsed, commit: parsed.commit }
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return null
}

let cached: BuildMeta | null = null

/** 进程内缓存：构建指纹在一次运行里不会变，没必要每个请求都读盘。 */
export function readBuildMeta(): BuildMeta {
  if (!cached) cached = fromEnv() ?? fromFile() ?? UNKNOWN
  return cached
}

/** 测试用：清掉缓存，模拟"换了产物重新启动"。 */
export function resetBuildMeta(): void {
  cached = null
}
