import { describe, expect, it } from 'vitest'
import { collectPages, localPageLinks, pageRoute, pageTitle } from '../shared/preview/pages'
import type { FileEntry } from '../shared/types'

const file = (path: string, content: string): FileEntry => ({ path, content, updatedAt: 0 })

describe('pageRoute · 路径到路由', () => {
  it('入口统一成 /', () => {
    expect(pageRoute('index.html')).toBe('/')
    expect(pageRoute('./index.html')).toBe('/')
    expect(pageRoute('pages/index.html')).toBe('/')
  })

  it('pages/ 是目录约定，不进 URL', () => {
    expect(pageRoute('pages/about.html')).toBe('/about')
    expect(pageRoute('pages/pricing.html')).toBe('/pricing')
  })

  it('根目录下的其它页面同样可用', () => {
    expect(pageRoute('about.html')).toBe('/about')
  })

  it('嵌套目录保留层级', () => {
    expect(pageRoute('pages/blog/post.html')).toBe('/blog/post')
  })

  it('大小写与 .htm 都能识别', () => {
    expect(pageRoute('Pages/About.HTML')).toBe('/About')
    expect(pageRoute('pages/faq.htm')).toBe('/faq')
  })
})

describe('collectPages · 页面收集', () => {
  it('只有 HTML 参与，入口排第一', () => {
    const pages = collectPages([
      file('pages/about.html', '<title>关于</title>'),
      file('styles.css', 'a{}'),
      file('index.html', '<title>首页</title>'),
    ])
    expect(pages.map((page) => page.route)).toEqual(['/', '/about'])
    expect(pages[0]?.title).toBe('首页')
  })

  it('路由冲突时保留先出现的（index.html 优先）', () => {
    const pages = collectPages([file('index.html', '<title>真入口</title>'), file('pages/index.html', '<title>影子</title>')])
    expect(pages).toHaveLength(1)
    expect(pages[0]?.title).toBe('真入口')
  })

  it('没有 <title> 时用路由兜底，不至于所有标签页都叫"预览"', () => {
    expect(pageTitle('<html></html>', '/about')).toBe('/about')
    expect(pageTitle('<html></html>', '/')).toBe('首页')
  })
})

describe('localPageLinks · 待修复的链接', () => {
  it('只认本地 .html 链接', () => {
    const html = `<a href="pages/about.html">关于</a>
      <a href="https://example.com/x.html">外链</a>
      <a href="#top">锚点</a>
      <a href="mailto:a@b.c">邮件</a>
      <a href="app.js">脚本</a>
      <a href='pages/faq.html?from=home'>带参数</a>`
    expect(localPageLinks(html)).toEqual(['pages/about.html', 'pages/faq.html'])
  })
})
