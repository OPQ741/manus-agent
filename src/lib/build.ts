/**
 * 构建指纹的读取与展示。
 *
 * `__BUILD__` 由 vite 在构建时替换成 scripts/build-meta.mjs 算好的对象。
 * 这里包一层的原因有两个：dev（vite dev server 直接起）时该常量不存在，
 * 直接用会 ReferenceError；展示格式散落在页面里也迟早长成三种写法。
 */

import type { BuildMeta } from '../../shared/types'

declare const __BUILD__: BuildMeta | undefined

const FALLBACK: BuildMeta = {
  version: '0.0.0',
  commit: 'unknown',
  commitFull: 'unknown',
  branch: 'unknown',
  dirty: false,
  builtAt: '',
}

/**
 * 前端只拿到提交信息（vite 只注入 commit / commitFull）——
 * 构建时间不进 bundle，否则同一份源码每次构建的产物哈希都不同。
 */
export const BUILD: BuildMeta = {
  ...FALLBACK,
  ...(typeof __BUILD__ === 'object' && __BUILD__ ? __BUILD__ : {}),
}

function stamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 一眼可读的一行：`6e92333 · 11-04 11:40`（有未提交改动时带 `+`）。 */
export function formatBuild(meta: BuildMeta | null | undefined): string {
  if (!meta || !meta.commit || meta.commit === 'unknown') return 'dev'
  const at = stamp(meta.builtAt)
  return `${meta.commit}${meta.dirty ? '+' : ''}${at ? ` · ${at}` : ''}`
}

/** 悬停时看完整信息：完整 commit 才是能拿去 git show 的那个。 */
export function describeBuild(meta: BuildMeta | null | undefined): string {
  if (!meta || meta.commit === 'unknown') return '本地开发模式，没有构建指纹'
  return [
    `提交 ${meta.commitFull}`,
    `分支 ${meta.branch}`,
    meta.dirty ? '工作区有未提交改动（这份产物不对应任何干净提交）' : '工作区干净',
    meta.builtAt ? `构建于 ${meta.builtAt}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 前后端是不是同一次部署。
 *
 * 只比 commit：前后端是同一次构建产出的，提交相同就是同版；
 * 构建时间会因为"本地打一次、平台 prestart 再打一次"而必然不同，
 * 把它算进判据只会制造假警报。
 */
export function sameBuild(a: BuildMeta | null | undefined, b: BuildMeta | null | undefined): boolean {
  if (!a || !b) return false
  if (!a.commitFull || a.commitFull === 'unknown' || !b.commitFull || b.commitFull === 'unknown') return false
  return a.commitFull === b.commitFull
}
