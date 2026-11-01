import { describe, expect, it } from 'vitest'
import { assemble, bridgeScript, withSeed } from '../server/preview/assemble'
import { composeFiles } from '../server/agent/composer'
import type { FileEntry } from '../shared/types'
import { DESIGN } from './helpers'

const at = Date.now()
const file = (path: string, content: string): FileEntry => ({ path, content, updatedAt: at })

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <h1>hi</h1>
  <script src="app.js"></script>
</body>
</html>`

const BASE = [file('index.html', HTML), file('styles.css', 'h1 { color: red }'), file('app.js', 'console.log(1)')]

describe('assemble · 入口与内联', () => {
  it('UT-ASM-01 优先使用 index.html', () => {
    const result = assemble([...BASE, file('other.html', '<html></html>')])
    expect(result.entry).toBe('index.html')
  })

  it('UT-ASM-02 没有 index.html 时退回 main.html', () => {
    const result = assemble([file('main.html', HTML), file('styles.css', 'a{}')])
    expect(result.entry).toBe('main.html')
  })

  it('UT-ASM-03 没有 HTML 时给出阻断性检查', () => {
    const result = assemble([file('app.js', 'x')])
    expect(result.html).toBe('')
    expect(result.checks.find((check) => check.id === 'entry')?.ok).toBe(false)
  })

  it('UT-ASM-04 CSS 被内联且位置不变', () => {
    const result = assemble(BASE)
    expect(result.html).toContain('<style data-src="styles.css">')
    expect(result.html).not.toContain('<link rel="stylesheet"')
    expect(result.html.indexOf('<style data-src="styles.css">')).toBeLessThan(result.html.indexOf('<body'))
  })

  it('UT-ASM-05 JS 被内联且位置不变', () => {
    const result = assemble(BASE)
    expect(result.html).toContain('<script data-src="app.js">')
    expect(result.html).not.toContain('<script src="app.js">')
    expect(result.html.indexOf('data-src="app.js"')).toBeLessThan(result.html.indexOf('</body>'))
  })

  it('UT-ASM-06 缺失引用被报告', () => {
    const result = assemble([file('index.html', HTML), file('app.js', 'x')])
    const refs = result.checks.find((check) => check.id === 'refs')
    expect(refs?.ok).toBe(false)
    expect(refs?.detail).toContain('styles.css')
  })

  it('UT-ASM-12 多个 CSS 保持书写顺序', () => {
    const html = `<html><head><link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css"></head><body></body></html>`
    const result = assemble([file('index.html', html), file('a.css', '.a{}'), file('b.css', '.b{}')])
    expect(result.html.indexOf('.a{}')).toBeLessThan(result.html.indexOf('.b{}'))
  })

  it('UT-ASM-13 没有 head 时自动补一个', () => {
    const result = assemble([file('index.html', '<html><body><p>x</p></body></html>')])
    expect(result.html).toContain('<head>')
    expect(result.html).toContain('data-nucleus="bridge"')
  })
})

describe('assemble · 桥接与检查', () => {
  it('UT-ASM-07 错误桥注入在业务脚本之前', () => {
    const result = assemble(BASE)
    const bridge = result.html.indexOf('data-nucleus="bridge"')
    const business = result.html.indexOf('data-src="app.js"')
    expect(bridge).toBeGreaterThan(-1)
    expect(bridge).toBeLessThan(business)
    expect(result.html).toContain('__nucleus')
  })

  it('桥接脚本自身可被解析且包含关键能力', () => {
    const script = bridgeScript()
    expect(script).toContain('unhandledrejection')
    expect(script).toContain('console.error')
    expect(script).toContain('__NUCLEUS_SEED')
    expect(() => new Function(script.replace(/<\/?script[^>]*>/g, ''))).not.toThrow()
  })

  it('UT-ASM-08 外链被识别为提示', () => {
    const html = `<html><head><script src="https://cdn.example.com/x.js"></script></head><body></body></html>`
    const result = assemble([file('index.html', html)])
    const external = result.checks.find((check) => check.id === 'external')
    expect(external?.detail).toContain('cdn.example.com')
  })

  it('UT-ASM-09 越权访问被标记', () => {
    const result = assemble([file('index.html', '<html><body><script>parent.document.title = "x"</script></body></html>')])
    expect(result.checks.find((check) => check.id === 'sandbox_safe')?.ok).toBe(false)
  })

  it('UT-ASM-10 超预算体积被标记', () => {
    const big = 'x'.repeat(420 * 1024)
    const result = assemble([file('index.html', `<html><body>${big}</body></html>`)])
    expect(result.checks.find((check) => check.id === 'size')?.ok).toBe(false)
  })

  it('UT-ASM-11 缺 body 时结构检查失败', () => {
    const result = assemble([file('index.html', '<div>hi</div>')])
    expect(result.checks.find((check) => check.id === 'structure')?.ok).toBe(false)
  })

  it('UT-ASM-14 内容里的 </script> 不破坏外层结构', () => {
    const js = 'const html = "</script><script>alert(1)</script>"'
    const result = assemble([file('index.html', HTML), file('app.js', js), file('styles.css', '')])
    expect(result.html.match(/<\/script>/g)?.length).toBeGreaterThan(0)
    // 内联后不应该出现可执行的第二个 alert(1) 脚本块
    expect(result.html).toContain('const html = "<\\/script>')
  })

  it('真实产物组装后无阻断问题', () => {
    const files = composeFiles('做一个记账应用', DESIGN)
    const result = assemble(files)
    expect(result.checks.filter((check) => check.level === 'block' && !check.ok)).toEqual([])
    expect(result.html).toContain('data-nucleus="bridge"')
  })
})

describe('assemble · 种子注入', () => {
  it('withSeed 在 head 之后注入且早于桥接脚本', () => {
    const result = assemble(BASE)
    const seeded = withSeed(result.html, { 'nucleus:expense:v1': '[{"id":"1"}]' })
    const seedAt = seeded.indexOf('__NUCLEUS_SEED=')
    const bridgeAt = seeded.indexOf('data-nucleus="bridge"')
    expect(seedAt).toBeGreaterThan(-1)
    expect(seedAt).toBeLessThan(bridgeAt)
  })

  it('withSeed 对空种子是恒等变换', () => {
    const result = assemble(BASE)
    expect(withSeed(result.html, null)).toBe(result.html)
    expect(withSeed(result.html, {})).toBe(result.html)
  })

  it('种子里的 </script> 被转义，不会提前闭合标签', () => {
    const result = assemble(BASE)
    const seeded = withSeed(result.html, { k: '</script><b>x</b>' })
    expect(seeded).toContain('<\\/script>')
  })
})
