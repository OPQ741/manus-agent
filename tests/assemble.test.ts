import { describe, expect, it } from 'vitest'
import { assemble, bridgeScript, withSeed } from '../shared/preview/assemble'
import { loadFactory } from '../server/store/seed'
import type { FileEntry } from '../shared/types'

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

  it('真实模型产物（出厂示例）组装后无阻断问题', () => {
    const example = loadFactory()
    if (example.files.length === 0) throw new Error('factory-example.json 是空的：跑 scripts/make-factory.mjs 生成')
    const files = example.files.map((item) => file(item.path, item.content))
    const result = assemble(files)
    expect(result.checks.filter((check) => check.level === 'block' && !check.ok)).toEqual([])
    expect(result.html).toContain('data-nucleus="bridge"')
    // 出厂示例必须本身是完整的：缺引用或语法不通就不该被固化成"示例"
    expect(result.missing).toEqual([])
    expect(result.broken).toEqual([])
    // 示例还得真的支持"实时改主色"：模型如果散写色值、不声明 --accent，
    // 微调面板就会变成一个骗人的开关（这条只能对着真实产物验，提示词约束不算数）
    expect(result.checks.find((check) => check.id === 'theme_vars')?.ok).toBe(true)
  })

  it('脚本语法不通是阻断级：结构全绿但一打开就白屏的情况必须被拦住', () => {
    const broken = file('app.js', "const a = '未闭合的字符串);")
    const result = assemble([file('index.html', HTML), file('app.js', broken.content), file('styles.css', '')])
    const check = result.checks.find((item) => item.id === 'syntax:app.js')
    expect(check?.ok).toBe(false)
    expect(check?.level).toBe('block')
    expect(result.broken).toEqual(['app.js'])
  })

  it('语法检查只编译不执行', () => {
    // 这行如果真被执行就会抛错；new Function 只编译，所以应当判为"语法 OK"
    const ok = assemble([file('index.html', HTML), file('app.js', 'throw new Error("boom")'), file('styles.css', '')])
    expect(ok.broken).toEqual([])
    expect(ok.checks.find((check) => check.id === 'syntax:app.js')?.ok).toBe(true)
  })

  it('只有 --radius 没有 --accent 时，如实说"主色需要重新生成"', () => {
    const result = assemble([
      file('index.html', HTML),
      file('styles.css', ':root { --radius: 12px; }'),
      file('app.js', 'var x = 1'),
    ])
    const tokens = result.checks.find((check) => check.id === 'theme_vars')
    expect(tokens?.ok).toBe(false)
    expect(tokens?.detail).toContain('主色需要重新生成')
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

describe('assemble · 多页面', () => {
  const HOME = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>书签</title><link rel="stylesheet" href="styles.css"></head>
<body>
  <h1>书签</h1>
  <a href="pages/about.html">关于</a>
  <script src="app.js"></script>
</body>
</html>`

  const ABOUT = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>关于</title><link rel="stylesheet" href="../styles.css"></head>
<body>
  <h1>关于我们</h1>
  <a href="../index.html">返回</a>
  <script src="../app.js"></script>
</body>
</html>`

  const MULTI: FileEntry[] = [
    file('index.html', HOME),
    file('pages/about.html', ABOUT),
    file('styles.css', 'h1 { color: var(--accent) }'),
    file('app.js', 'console.log(1)'),
  ]

  /** 从壳里把内嵌的 DOCS 抠出来解析：这条断言能一次抓住转义/引号类错误 */
  function readDocs(html: string): Record<string, string> {
    const start = html.indexOf('var DOCS = ')
    const end = html.indexOf('var TITLES = ')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const raw = html.slice(start + 'var DOCS = '.length, end).trim().replace(/;$/, '')
    return JSON.parse(raw) as Record<string, string>
  }

  it('UT-ASM-20 两个页面 → 路由壳，两个路由都在', () => {
    const result = assemble(MULTI)
    expect(result.entry).toBe('index.html')
    expect(result.checks.find((check) => check.id === 'pages')?.detail).toContain('/about')
    expect(result.html).toContain('data-nucleus="pages"')
    expect(result.html).toContain('np-frame')
    expect(Object.keys(readDocs(result.html))).toEqual(['/', '/about'])
  })

  it('UT-ASM-21 每页各自内联一份共享样式（帧之间不共享 DOM）', () => {
    const result = assemble(MULTI)
    const docs = readDocs(result.html)
    expect(docs['/']).toContain('<style data-src="styles.css">')
    expect(docs['/about']).toContain('<style data-src="styles.css">')
    expect(result.missing).toHaveLength(0)
  })

  it('UT-ASM-22 壳脚本本身语法正确（模板里的转义写错就会让整站白屏）', () => {
    const result = assemble(MULTI)
    const start = result.html.indexOf('<script data-nucleus="pages">') + '<script data-nucleus="pages">'.length
    const end = result.html.indexOf('</script>', start)
    const code = result.html.slice(start, end)
    expect(() => new Function(code)).not.toThrow()
  })

  it('UT-ASM-23 链接指向不存在的页面 → 进 missing，驱动修复轮', () => {
    const broken = HOME.replace('pages/about.html', 'pages/pricing.html')
    const result = assemble([file('index.html', broken), file('pages/about.html', ABOUT)])
    expect(result.missing).toContain('pages/pricing.html')
    expect(result.checks.find((check) => check.id === 'refs')?.ok).toBe(false)
  })

  it('UT-ASM-24 只有 index.html 时仍走单页路径（不产出路由壳）', () => {
    const result = assemble([file('index.html', HOME), file('styles.css', 'a{}'), file('app.js', 'x')])
    expect(result.html).not.toContain('data-nucleus="pages"')
    expect(result.checks.some((check) => check.id === 'pages')).toBe(false)
  })

  it('UT-ASM-25 多页面项目里一个语法错脚本仍然是阻断级', () => {
    const result = assemble([...MULTI.filter((item) => item.path !== 'app.js'), file('app.js', 'function (')])
    expect(result.broken).toContain('app.js')
  })
})
