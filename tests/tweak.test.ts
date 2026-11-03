/**
 * 设计微调：派生规则、输入校验、CSS 注入、与组装器的协同。
 *
 * 重点不是"函数能跑"，而是三条不变量：
 *  1. 派生是确定的（同一主色永远得到同一组变量，前端推送与服务端注入不会漂移）；
 *  2. 注入位置在应用自有样式**之后**（否则覆盖不生效）；
 *  3. 非法输入被局部丢弃而不是整单拒绝（用户拖滑杆时不该因为一个脏字段 400）。
 */

import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../shared/types'
import { contrastInk, lighten, normalizeHex, tweakVars } from '../shared/theme'
import { assemble } from '../shared/preview/assemble'
import { injectTweak, sanitizeTweak, tweakCss, usesDesignTokens } from '../shared/preview/tweak'

function app(files: { path: string; content: string }[]): FileEntry[] {
  return files.map((file) => ({ ...file, updatedAt: 0 }))
}

const TOKEN_APP = app([
  {
    path: 'index.html',
    content: `<!doctype html><html><head><link rel="stylesheet" href="styles.css" /></head><body><h1>x</h1></body></html>`,
  },
  {
    path: 'styles.css',
    content: `:root { --accent: #4b3bff; --radius: 14px; }\n.btn { background: var(--accent); border-radius: var(--radius); }`,
  },
])

describe('微调 · 颜色派生', () => {
  it('UT-TWEAK-01 归一化支持 #abc / 大写，拒绝非法值', () => {
    expect(normalizeHex('#4B3BFF')).toBe('#4b3bff')
    expect(normalizeHex('  #abc ')).toBe('#aabbcc')
    expect(normalizeHex('red')).toBeNull()
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex(42)).toBeNull()
  })

  it('UT-TWEAK-02 浅底向白色混色，深色主色配白字', () => {
    expect(lighten('#000000', 0.86)).toBe('#dbdbdb')
    expect(lighten('#ffffff', 0.86)).toBe('#ffffff')
    expect(contrastInk('#17624b')).toBe('#ffffff')
    expect(contrastInk('#f5e663')).toBe('#14140f')
  })

  it('UT-TWEAK-03 同一个 tweak 派生出的变量组是稳定的', () => {
    expect(tweakVars({ accent: '#17624b', radius: 6 })).toEqual({
      '--accent': '#17624b',
      '--accent-soft': lighten('#17624b', 0.86),
      '--accent-ink': '#ffffff',
      '--radius': '6px',
    })
    expect(tweakVars({})).toEqual({})
  })
})

describe('微调 · 输入校验', () => {
  it('UT-TWEAK-04 圆角越界被夹紧、四舍五入', () => {
    expect(sanitizeTweak({ radius: 999 })?.radius).toBe(28)
    expect(sanitizeTweak({ radius: -5 })?.radius).toBe(0)
    expect(sanitizeTweak({ radius: 3.6 })?.radius).toBe(4)
  })

  it('UT-TWEAK-05 非法字段被局部丢弃，合法字段仍然生效', () => {
    expect(sanitizeTweak({ accent: 'not-a-color', radius: 8 })).toEqual({ radius: 8 })
    expect(sanitizeTweak({ accent: '#E11D6B' })).toEqual({ accent: '#e11d6b' })
    expect(sanitizeTweak({})).toBeUndefined()
    expect(sanitizeTweak(null)).toBeUndefined()
    expect(sanitizeTweak('x')).toBeUndefined()
  })
})

describe('微调 · CSS 注入', () => {
  it('UT-TWEAK-06 样式插在 </head> 前，且位于应用样式之后', () => {
    const html = `<html><head><style>:root{--accent:#000}</style></head><body></body></html>`
    const out = injectTweak(html, { accent: '#17624b', radius: 6 })
    expect(out.indexOf('data-nucleus="tweak"')).toBeGreaterThan(out.indexOf(':root{--accent:#000}'))
    expect(out.indexOf('data-nucleus="tweak"')).toBeLessThan(out.indexOf('</head>'))
    expect(out).toContain('--accent: #17624b;')
    expect(out).toContain('--radius: 6px;')
  })

  it('UT-TWEAK-07 没有 tweak / 空 tweak 时原样返回（不产生无意义 DOM）', () => {
    const html = '<html><head></head><body></body></html>'
    expect(injectTweak(html, undefined)).toBe(html)
    expect(injectTweak(html, {})).toBe(html)
    expect(tweakCss({})).toBe('')
  })

  it('UT-TWEAK-08 缺少 </head> 时仍能注入（降级不抛错）', () => {
    const out = injectTweak('<body><h1>x</h1></body>', { radius: 2 })
    expect(out.startsWith('<style data-nucleus="tweak">')).toBe(true)
  })

  it('UT-TWEAK-09 设计令牌探测', () => {
    expect(usesDesignTokens(':root{--accent:#000}')).toBe(true)
    expect(usesDesignTokens(':root{--radius:8px}')).toBe(true)
    expect(usesDesignTokens('h1{color:red}')).toBe(false)
  })
})

describe('微调 · 与组装器协同', () => {
  it('UT-TWEAK-10 组装后的产物带覆盖样式，且仍然自检通过', () => {
    const result = assemble(TOKEN_APP, { accent: '#17624b', radius: 6 })
    expect(result.html).toContain('data-nucleus="tweak"')
    expect(result.html).toContain('--accent: #17624b;')
    // 覆盖样式要排在应用样式之后
    expect(result.html.indexOf('data-nucleus="tweak"')).toBeGreaterThan(result.html.indexOf('.btn {'))
    expect(result.checks.find((check) => check.id === 'theme_vars')?.ok).toBe(true)
  })

  it('UT-TWEAK-11 没有令牌的应用会被如实标记（而不是假装能调色）', () => {
    const plain = app([{ path: 'index.html', content: '<!doctype html><html><head></head><body><h1>x</h1></body></html>' }])
    expect(assemble(plain).checks.find((check) => check.id === 'theme_vars')?.ok).toBe(false)
  })

  it('UT-TWEAK-12 无 tweak 时产物里没有微调样式（默认路径零副作用）', () => {
    expect(assemble(TOKEN_APP).html).not.toContain('data-nucleus="tweak"')
  })
})
