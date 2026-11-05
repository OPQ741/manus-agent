import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { transform } from 'sucrase'
import { assemble, type AssembleOptions } from '../shared/preview/assemble'
import { isModuleProject, transformOptions } from '../shared/preview/bundle'
import type { FileEntry } from '../shared/types'

const requireHere = createRequire(import.meta.url)
const at = Date.now()
const file = (path: string, content: string): FileEntry => ({ path, content, updatedAt: at })

/** 测试里直接读 node_modules 的 UMD：和服务端装配保持同一条路径 */
function umd(pkg: string, name: string): string {
  return readFileSync(join(dirname(requireHere.resolve(`${pkg}/package.json`)), 'umd', name), 'utf8')
}

const OPTIONS: AssembleOptions = {
  compile: (code, path) => transform(code, transformOptions(path)).code,
  runtime: { react: umd('react', 'react.production.min.js'), reactDom: umd('react-dom', 'react-dom.production.min.js') },
}

const INDEX = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8" /><link rel="stylesheet" href="styles.css" /></head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>`

const MAIN = `import { createRoot } from 'react-dom/client'
import { App } from './App'
import '../styles.css'
createRoot(document.getElementById('root')).render(<App title="记账本" />)`

const APP = `import { useState } from 'react'
import { Card } from './components/Card'
export function App({ title }: { title: string }) {
  const [n, setN] = useState(0)
  return (
    <main>
      <h1>{title}</h1>
      <Card n={n} onAdd={() => setN(n + 1)} />
    </main>
  )
}`

const CARD = `export function Card({ n, onAdd }: { n: number; onAdd: () => void }) {
  return <button onClick={onAdd}>点了 {n} 次</button>
}`

const REACT_FILES = [
  file('index.html', INDEX),
  file('styles.css', ':root { --accent: #4b3bff }'),
  file('src/main.jsx', MAIN),
  file('src/App.tsx', APP),
  file('src/components/Card.tsx', CARD),
]

describe('bundle · 模块工程的识别', () => {
  it('UT-BND-01 有 .jsx/.tsx 才算模块工程', () => {
    expect(isModuleProject(REACT_FILES)).toBe(true)
    expect(isModuleProject([file('index.html', INDEX), file('app.js', 'console.log(1)')])).toBe(false)
  })

  it('UT-BND-02 原生工程不受影响：不传打包器时行为完全不变', () => {
    const files = [file('index.html', '<html><body><h1>hi</h1><script src="app.js"></script></body></html>'), file('app.js', 'console.log(1)')]
    const result = assemble(files)
    expect(result.checks.some((check) => check.id === 'bundle')).toBe(false)
    expect(result.html).toContain('console.log(1)')
  })
})

describe('bundle · React 多文件打包', () => {
  const result = assemble(REACT_FILES, undefined, OPTIONS)

  it('UT-BND-03 多文件被打包成一份自包含 HTML', () => {
    // 入口的 module 脚本被替换掉：沙箱里没有静态目录，留着它就是 404
    expect(result.html).not.toMatch(/<script[^>]*type="module"/i)
    // React 运行时与打包脚本都在
    expect(result.html).toContain('window.__nucleus_modules')
    expect(result.html).toContain('react.production.min')
    // 三个模块都进了模块表（依赖是相对路径 + 省略扩展名，靠解析补全）
    expect(result.html).toContain('"src/main.jsx"')
    expect(result.html).toContain('"src/App.tsx"')
    expect(result.html).toContain('"src/components/Card.tsx"')
    expect(result.checks.find((check) => check.id === 'bundle')?.ok).toBe(true)
  })

  it('UT-BND-04 JSX/TS 被编译，且相对引用改写成了模块 id', () => {
    expect(result.html).not.toContain('createRoot(document.getElementById("root")).render(<App')
    expect(result.html).toContain('require("src/App.tsx")')
    expect(result.html).toContain('require("src/components/Card.tsx")')
    // 类型标注必须消失（否则浏览器会报语法错）
    expect(result.html).not.toContain(': { title: string }')
  })

  it('UT-BND-05 import 的样式被搬进 <style>，JS 里不再有 css 引用', () => {
    expect(result.html).toContain('<style data-src="styles.css">')
    expect(result.html).not.toContain('require("./styles.css")')
    // 体积自检要把平台注入的运行时扣掉
    expect(result.checks.find((check) => check.id === 'size')?.detail).toContain('不计入')
  })
})

describe('bundle · 失败要能看见', () => {
  it('UT-BND-06 缺文件时给出阻断项并写进 broken（驱动修复轮）', () => {
    const broken = assemble([file('index.html', INDEX), file('src/main.jsx', "import './Missing'\n")], undefined, OPTIONS)
    const check = broken.checks.find((item) => item.id === 'bundle')
    expect(check?.ok).toBe(false)
    expect(check?.level).toBe('block')
    expect(check?.detail).toContain('找不到模块')
    expect(broken.broken).toContain('src/main.jsx')
    // 失败页面要把原因写在屏幕上，而不是留一片白
    expect(broken.html).toContain('React 模块没能打包')
  })

  it('UT-BND-07 不认识的裸依赖（npm 包）如实报错', () => {
    const result = assemble(
      [file('index.html', INDEX), file('src/main.jsx', "import dayjs from 'dayjs'\nconsole.log(dayjs)\n")],
      undefined,
      OPTIONS,
    )
    expect(result.checks.find((item) => item.id === 'bundle')?.detail).toContain('dayjs')
  })

  it('UT-BND-08 jsx 里写错语法时不会静默通过', () => {
    const result = assemble(
      [file('index.html', INDEX), file('src/main.jsx', 'export const A = () => <div>')],
      undefined,
      OPTIONS,
    )
    expect(result.checks.find((item) => item.id === 'bundle')?.ok).toBe(false)
  })

  it('UT-BND-09 没有打包器时（浏览器还没加载完）给出明确阻断，而不是白屏', () => {
    const result = assemble(REACT_FILES)
    const check = result.checks.find((item) => item.id === 'bundle')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('打包器')
  })

  it('UT-BND-10 注释里出现的 from "..." 不算依赖，不该把项目判死', () => {
    const main = `// 旧写法：import { App } from './legacy/App'
import { createRoot } from 'react-dom/client'
createRoot(document.getElementById('root')).render(<h1>hi</h1>)`
    const result = assemble([file('index.html', INDEX), file('src/main.jsx', main)], undefined, OPTIONS)
    expect(result.checks.find((item) => item.id === 'bundle')?.ok).toBe(true)
  })
})
