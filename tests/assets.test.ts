/**
 * 资产内联：`<img src="assets/logo.svg">` 在预览里必须是「画出图」而不是「404」。
 *
 * 关键取舍都在这里钉住：
 *  - 只内联文本 SVG（位图在这个项目里没有落库通道）；
 *  - 缺文件要进 missing（交给修复轮），而不是悄悄吞掉；
 *  - 超预算要留痕（自检里说清楚原因），而不是把 400 KB 预算吃穿。
 */

import { describe, expect, it } from 'vitest'
import { assemble } from '../shared/preview/assemble'
import { inlineAssets, emptyAssetSink, MAX_ASSETS_BYTES, MAX_ASSET_BYTES, svgDataUri } from '../shared/preview/assets'
import type { FileEntry } from '../shared/types'

const FILE = (path: string, content: string): FileEntry => ({ path, content, updatedAt: 0 })
const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

const map = (files: FileEntry[]) => new Map(files.map((file) => [file.path, file]))

describe('svgDataUri · 编码', () => {
  it('用 utf-8 + encodeURIComponent：可读、且能原样解回来', () => {
    const uri = svgDataUri(LOGO)
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(uri).not.toContain('base64')
    // 关键不变量：解码后就是原图（差一次空白压缩）
    const payload = uri.slice('data:image/svg+xml;charset=utf-8,'.length)
    expect(decodeURIComponent(payload).replace(/\s+/g, ' ').trim()).toBe(LOGO)
    // 裸引号、裸 # 会把属性或片段截断，必须已经被转义
    expect(payload).not.toContain('"')
    expect(payload).not.toContain('#')
  })

  it('换行与缩进被压平：uri 里不该出现裸换行', () => {
    expect(svgDataUri('<svg>\n  <path d="M0 0"/>\n</svg>')).not.toContain('\n')
  })
})

describe('inlineAssets · 内联', () => {
  it('UT-ASSET-01 img 引用本地 svg → data URI', () => {
    const sink = emptyAssetSink()
    const out = inlineAssets('<img src="assets/logo.svg" alt="logo">', map([FILE('assets/logo.svg', LOGO)]), 'index.html', sink)
    expect(out).toContain('src="data:image/svg+xml;charset=utf-8,')
    expect(out).not.toContain('assets/logo.svg')
    // alt 之类的其它属性必须保留
    expect(out).toContain('alt="logo"')
    expect(sink.inlined).toEqual(['assets/logo.svg'])
    expect(sink.bytes).toBeGreaterThan(0)
  })

  it('UT-ASSET-02 子目录里的页面按自己的目录解析相对路径', () => {
    const sink = emptyAssetSink()
    const out = inlineAssets(
      '<img src="../assets/logo.svg">',
      map([FILE('assets/logo.svg', LOGO)]),
      'pages/about.html',
      sink,
    )
    expect(out).toContain('data:image/svg+xml')
    expect(sink.inlined).toEqual(['assets/logo.svg'])
  })

  it('UT-ASSET-03 CSS 里的 url(...) 也换掉（背景纹理最容易漏）', () => {
    const sink = emptyAssetSink()
    const out = inlineAssets(
      '<style>.hero{background:url(assets/pattern.svg)}</style>',
      map([FILE('assets/pattern.svg', LOGO)]),
      'index.html',
      sink,
    )
    expect(out).toContain('url("data:image/svg+xml;charset=utf-8,')
    expect(sink.inlined).toEqual(['assets/pattern.svg'])
  })

  it('UT-ASSET-04 引用了不存在的文件 → 进 missing，交给修复轮补', () => {
    const sink = emptyAssetSink()
    const out = inlineAssets('<img src="assets/nope.svg">', map([]), 'index.html', sink)
    expect(out).toBe('<img src="assets/nope.svg">')
    expect(sink.missing).toEqual(['assets/nope.svg'])
  })

  it('UT-ASSET-05 外链与 data: 一律不碰（离线不可用让 external 检查去说）', () => {
    const sink = emptyAssetSink()
    const html = '<img src="https://example.com/a.png"><img src="data:image/png;base64,AAA">'
    expect(inlineAssets(html, map([]), 'index.html', sink)).toBe(html)
    expect(sink.missing).toEqual([])
    expect(sink.inlined).toEqual([])
  })

  it('UT-ASSET-06 位图没内联通道：如实标"不是 SVG"，不伪造坏 data URI', () => {
    const sink = emptyAssetSink()
    const out = inlineAssets('<img src="assets/photo.png">', map([FILE('assets/photo.png', 'not-binary')]), 'index.html', sink)
    expect(out).toBe('<img src="assets/photo.png">')
    expect(sink.inlined).toEqual([])
    expect(sink.skipped[0]?.reason).toContain('不是 SVG')
  })

  it('UT-ASSET-07 单文件超 64 KB 就跳过，并说明原因', () => {
    const sink = emptyAssetSink()
    const huge = `<svg>${'<path d="M0 0"/>'.repeat(5000)}</svg>`
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_ASSET_BYTES)
    const out = inlineAssets('<img src="big.svg">', map([FILE('big.svg', huge)]), 'index.html', sink)
    expect(out).toBe('<img src="big.svg">')
    expect(sink.skipped[0]?.reason).toContain('64 KB')
  })

  it('UT-ASSET-08 总量超预算后停止内联，但前面已内联的仍然有效', () => {
    const sink = emptyAssetSink()
    // 每个约 40 KB，第 4 个开始越过 120 KB 上限
    const body = `<svg>${'<path d="M0 0"/>'.repeat(3000)}</svg>`
    const files = map([1, 2, 3, 4].map((n) => FILE(`a${n}.svg`, body)))
    const html = [1, 2, 3, 4].map((n) => `<img src="a${n}.svg">`).join('')
    const out = inlineAssets(html, files, 'index.html', sink)
    expect(sink.bytes).toBeLessThanOrEqual(MAX_ASSETS_BYTES)
    expect(sink.inlined.length).toBeGreaterThan(0)
    expect(sink.inlined.length).toBeLessThan(4)
    expect(out).toContain('src="a4.svg"')
  })
})

describe('assemble · 资产自检', () => {
  it('UT-ASSET-09 内联成功时自检为绿，报数量与体积', () => {
    const result = assemble([FILE('index.html', '<html><body><img src="assets/logo.svg"></body></html>'), FILE('assets/logo.svg', LOGO)])
    const check = result.checks.find((item) => item.id === 'assets')
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain('1 个已内联')
    expect(result.html).toContain('data:image/svg+xml')
    expect(result.inlined).toContain('assets/logo.svg')
  })

  it('UT-ASSET-10 缺文件同时进 refs 与 assets：两条自检说的是同一件事', () => {
    const result = assemble([FILE('index.html', '<html><body><img src="assets/nope.svg"></body></html>')])
    expect(result.missing).toContain('assets/nope.svg')
    const refs = result.checks.find((item) => item.id === 'refs')
    expect(refs?.ok).toBe(false)
    expect(refs?.detail).toContain('assets/nope.svg')
  })
})
