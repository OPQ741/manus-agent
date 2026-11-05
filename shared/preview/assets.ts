/**
 * 纯文本资产内联：`<img src="assets/logo.svg">` → data URI。
 *
 * 为什么必须内联：预览是一份自包含的 `srcdoc`，没有同源静态目录，
 * `assets/logo.svg` 在那里就是个 404 —— 生成物看起来"写了 logo、就是不显示"。
 * 而导出成 ZIP 时文件是真的，相对路径天然能跑，所以内联只发生在组装阶段。
 *
 * 只处理**文本类**资产（.svg / .svg 内容）：图片二进制在这个项目里没有落库通道，
 * 模型输出的 FileEntry.content 是字符串。遇到 .png 之类就如实报"不支持"，
 * 而不是伪造一个坏 data URI 让它静默不显示。
 */

import type { FileEntry } from '../types'
import { byteLength } from './bytes'

/** 单个资产上限：超过这个体积，大概率是模型把位图 base64 塞进了 svg，内联也没意义。 */
export const MAX_ASSET_BYTES = 64 * 1024
/** 所有资产合计上限：总量预算只有 400 KB，给资产留 120 KB 足够放 logo 与纹理。 */
export const MAX_ASSETS_BYTES = 120 * 1024

/**
 * data URI 的膨胀比（估算）。
 *
 * percent-encoding 会把 `<` `>` `"` `/` 各变成 3 个字节，所以"路径多、标记少"的 svg
 * 约 1.2×，标签密集的更高。这里按 1.2 估预算即可 —— 真正兜底的是组装完成后对整份
 * 文档做的体积检查，资产只是提前一步避免把预算吃穿。
 */
const ASSET_INFLATION = 1.2

export interface AssetSink {
  /** 成功内联的资产路径 */
  inlined: string[]
  /** 引用了但项目里没有：交给修复轮补文件 */
  missing: string[]
  /** 存在但没内联：超预算 / 不是文本 SVG / 体积过大 */
  skipped: { path: string; reason: string }[]
  /** 累计内联后的估算字节（含膨胀） */
  bytes: number
}

export function emptyAssetSink(): AssetSink {
  return { inlined: [], missing: [], skipped: [], bytes: 0 }
}

const ASSET_EXT = /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp)$/i

/** 只认本地引用：http(s)、data:、//cdn 一律不碰。 */
function isLocal(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  return !/^(?:[a-z]+:|\/\/|#)/i.test(v)
}

function resolve(raw: string, from: string): string {
  const clean = raw.trim().replace(/[?#].*$/, '')
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '')
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const parts: string[] = []
  for (const part of `${base}/${clean}`.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

/**
 * 把一个文本 SVG 变成 data URI。
 *
 * 用 `charset=utf-8` + encodeURIComponent 而不是 base64：体积约 1.05×（base64 是 1.37×），
 * 而且出问题时在 DevTools 里直接可读 —— 这两点对"生成物要不要重来"的判断很关键。
 */
export function svgDataUri(svg: string): string {
  const body = svg.replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim()
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`
}

interface Decision {
  uri?: string
  reason?: string
}

function decide(path: string, files: Map<string, FileEntry>, sink: AssetSink): Decision {
  const file = files.get(path)
  if (!file) return { reason: '文件不存在' }
  if (!/\.svg$/i.test(path)) return { reason: '不是 SVG（预览只内联文本资产）' }
  if (!/<svg[\s>]/i.test(file.content)) return { reason: '内容不像 SVG' }
  const size = byteLength(file.content)
  if (size > MAX_ASSET_BYTES) return { reason: `单文件 ${(size / 1024).toFixed(0)} KB 超出 64 KB` }
  const grow = Math.ceil(size * ASSET_INFLATION)
  if (sink.bytes + grow > MAX_ASSETS_BYTES) return { reason: '资产总量超出预算' }
  sink.bytes += grow
  sink.inlined.push(path)
  return { uri: svgDataUri(file.content) }
}

/**
 * 内联 `<img src>` 与 CSS 里的 `url(...)`。
 *
 * 两处都要管：logo 常写成 img，背景纹理常写在 style 里。
 * CSS 那一支尤其容易漏 —— 漏了不会报错，只是预览里少一层纹理。
 */
export function inlineAssets(html: string, files: Map<string, FileEntry>, from: string, sink: AssetSink): string {
  const swap = (raw: string): string | null => {
    if (!isLocal(raw) || !ASSET_EXT.test(raw.trim())) return null
    const path = resolve(raw, from)
    if (!files.has(path)) {
      sink.missing.push(path)
      return null
    }
    const decision = decide(path, files, sink)
    if (decision.uri) return decision.uri
    sink.skipped.push({ path, reason: decision.reason ?? '未知原因' })
    return null
  }

  // 1) 标签属性：src="..." / poster="..." —— 只认 HTML 标签内，避免误伤 JS 字符串
  let out = html.replace(
    /(<(?:img|source|video|audio|input)\b[^>]*?\b(?:src|poster)\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (whole, head: string, _q: string, dq?: string, sq?: string) => {
      const raw = dq ?? sq ?? ''
      const uri = swap(raw)
      return uri ? `${head}"${uri}"` : whole
    },
  )

  // 2) CSS url(...)：内联样式、<style> 块都会走到（样式此时已内联进文档）
  out = out.replace(/url\(\s*("([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi, (whole, _all, dq?: string, sq?: string, bare?: string) => {
    const raw = dq ?? sq ?? bare ?? ''
    const uri = swap(raw)
    return uri ? `url("${uri}")` : whole
  })

  return out
}
