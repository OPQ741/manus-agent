/**
 * 浏览器内的模块打包器：把「多文件 React 工程」压成一份能塞进 srcdoc 的 HTML。
 *
 * 为什么要在前端打包
 *  - 预览是 `srcdoc` + 无同源沙箱，没有静态服务器，`import './App'` 这类语句
 *    在浏览器里既没有解析通道、也没有 MIME 保证（`.jsx` 会被当成下载）；
 *  - 项目的整个组装链路（server/services/preview、Studio 的实时预览）都是**同步**的，
 *    「发个请求让服务端打包」会在流式生成时每写一个文件就打一次后端；
 *  - 用户导出、分享拿到的又必须是同一份产物 —— 所以打包结果必须是纯字符串，
 *    不依赖任何运行时环境。
 *
 * 因此这里刻意只做三件事，且都不依赖 Node：
 *  1. 解析 import 图（相对路径 + 扩展名补全 + index 回退）；
 *  2. 把 JSX/TS 转成 CommonJS（转译器由调用方注入，见下方 Compiler）；
 *  3. 把 React 运行时、样式、模块表拼成一段自包含脚本。
 *
 * 关于 React 从哪来：沙箱里 `connect-src 'none'`，不可能去 CDN 取，也不该取 ——
 * 预览必须离线可跑。所以 React 以 UMD 源码字符串注入（production 版，约 142 KB），
 * 由调用方（浏览器用 `?raw`、Node 用 fs 读 node_modules）提供。
 */

import type { FileEntry } from '../types'
import { svgDataUri } from './assets'
import { byteLength } from './bytes'

/** 转译器：把一段源码转成 CommonJS。注入而不是直接 import sucrase， 是为了让浏览器按需懒加载它。 */
export type Compiler = (code: string, path: string) => string

/**
 * 按扩展名给出 sucrase 配置。
 *
 * 放在这里而不是各自写一份：服务端与浏览器必须用**同一套**编译参数，
 * 否则会出现「预览能跑、导出后跑不起来」这种最难查的两套逻辑漂移。
 * 返回值直接喂给 `transform(code, options)`。
 */
export function transformOptions(path: string): {
  transforms: ('typescript' | 'jsx' | 'imports')[]
  jsxRuntime: 'automatic'
  production: boolean
} {
  const jsx = /\.(jsx|tsx)$/i.test(path)
  const ts = /\.tsx?$/i.test(path)
  // .js/.mjs 里也可能出现 JSX（模型经常不给后缀），所以一律开着 jsx 转换：
  // 它对没有 JSX 的文件是个无害的直通，而对漏了后缀的组件是唯一的救命绳。
  return {
    transforms: [...(ts ? (['typescript'] as const) : []), ...(jsx || !ts ? (['jsx'] as const) : []), 'imports'],
    jsxRuntime: 'automatic',
    // 生产模式：走 `react/jsx-runtime` 而不是 jsxDEV，省掉每处调用附带的调试对象，
    // 产物小一截，也不会在控制台刷一堆开发期警告。
    production: true,
  }
}

export interface BundleRuntime {
  /** react.production.min.js 原文（UMD） */
  react: string
  /** react-dom.production.min.js 原文（UMD） */
  reactDom: string
}

export interface BundleIssue {
  path: string
  message: string
}

export interface BundleResult {
  ok: boolean
  /** 替换掉 `<script type="module">` 的整段脚本（含 React 运行时） */
  script: string
  /** 被 import 的样式文件：调用方按顺序插进文档 */
  styles: { path: string; content: string }[]
  /** 参与打包的模块（按发现顺序） */
  modules: string[]
  /** 解析不了的裸依赖（npm 包）：沙箱里没有安装通道，只能如实报错 */
  external: string[]
  issues: BundleIssue[]
  /** 运行时占用（React UMD）字节数，体积自检时单独扣掉 */
  runtimeBytes: number
}

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json']
const ASSETS = /\.(svg|png|jpe?g|gif|webp|avif)$/i

/**
 * 一个项目算不算「模块工程」。
 *
 * 判据是文件后缀而不是 prompt 里的关键词：模型说要写 React 但产出的是原生
 * `app.js` 时，走原生路径才是对的；反过来只要出现 `.jsx`/`.tsx`，就必须打包，
 * 否则那份文件在预览里只会是一段被浏览器当成文本的东西。
 */
export function isModuleProject(files: FileEntry[]): boolean {
  return files.some((file) => /\.(jsx|tsx|mjs|ts)$/i.test(file.path))
}

/** 入口 HTML 里声明的模块脚本（`<script type="module" src="...">`）。 */
const MODULE_TAG = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>[\s\S]*?<\/script>/i

function scriptSrc(tag: string): string {
  const match = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
  return (match?.[2] ?? match?.[3] ?? '').trim()
}

function normalize(spec: string): string {
  return spec.trim().replace(/[?#].*$/, '')
}

function guessFromHtml(html: string, files: Map<string, FileEntry>): string | null {
  const tag = MODULE_TAG.exec(html)?.[0]
  if (tag) {
    const src = normalize(scriptSrc(tag))
    if (src) {
      const path = resolvePath(files, src.replace(/^\/+/, ''))
      if (path) return path
    }
  }
  // 没写 type=module 但引用了 .jsx：同样按模块工程处理（模型经常漏掉 type）
  const loose = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+\.(?:jsx|tsx|ts|mjs))["']/i.exec(html)
  if (loose?.[1]) {
    const path = resolvePath(files, normalize(loose[1]).replace(/^\/+/, ''))
    if (path) return path
  }
  return null
}

/** 找不到声明时按约定猜入口：src/main → main → src/App → index。 */
function guessEntry(files: Map<string, FileEntry>): string | null {
  const candidates = ['src/main', 'main', 'src/index', 'index', 'src/App', 'App', 'app']
  for (const base of candidates) {
    const hit = resolvePath(files, base)
    if (hit) return hit
  }
  return null
}

export interface ModuleEntry {
  /** 入口模块路径 */
  module: string
  /** 入口 HTML 原文（含 `<script type="module">`） */
  html: string
}

export function findModuleEntry(files: FileEntry[], html: string): ModuleEntry | null {
  const map = new Map(files.map((file) => [file.path, file]))
  const module = guessFromHtml(html, map) ?? guessEntry(map)
  return module ? { module, html } : null
}

function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/** 相对引用 → 项目内绝对路径（不带扩展名时的补全交给 resolvePath）。 */
function joinPath(from: string, spec: string): string {
  const clean = normalize(spec)
  const parts = clean.startsWith('/') ? [] : dirOf(from).split('/').filter(Boolean)
  for (const part of clean.replace(/^\/+/, '').split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

/**
 * 路径 → 真实文件。
 *
 * 顺序按「越具体越优先」：先精确命中，再补扩展名，最后按目录 index 回退。
 * 补全表里 `.tsx` 排在 `.js` 前：同名 App.tsx / App.js 同时存在时，
 * 用户想要的一定是带类型的那份。
 */
export function resolvePath(files: Map<string, FileEntry>, path: string): string | null {
  if (!path) return null
  if (files.has(path)) return path
  for (const ext of EXTENSIONS) if (files.has(path + ext)) return path + ext
  for (const ext of EXTENSIONS) {
    const index = `${path}/index${ext}`
    if (files.has(index)) return index
  }
  for (const ext of ['.css', '.json']) if (files.has(path + ext)) return path + ext
  return null
}

/** `from 'x'` / `import 'x'` / `import('x')` 里的说明符。 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+)\1/g

function specifiersOf(code: string): string[] {
  const out: string[] = []
  for (const match of code.matchAll(SPECIFIER)) {
    if (match[2]) out.push(match[2])
  }
  return out
}

/** 把整条 `import './x.css'` 语句删掉：样式由文档统一承载，逻辑里不需要它。 */
function stripCssImports(code: string, isCss: (spec: string) => boolean): string {
  return code.replace(
    /(?:^|\n)[ \t]*import\s+(?:[^'"\n]*?\bfrom\s*)?(['"])([^'"\n]+)\1;?[ \t]*(?=\n|$)/g,
    (whole: string, _quote: string, spec: string) => (isCss(spec) ? '\n' : whole),
  )
}

const escapeSpec = (spec: string) => spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 把 `require("spec")` 换成目标（模块 id 或内联的 data URI 字面量）。 */
function rewriteRequire(code: string, spec: string, replacement: string): string {
  /**
   * 整体替换而不是只换参数：匹配的是 `require("spec")` 整段。
   * 替换串里必须把 `require(` 写回来 —— 少写一次，产物里就只剩一个孤立的
   * `("src/App.tsx")` 表达式，模块根本不会被加载（预览白屏且没有任何报错）。
   */
  return code.replace(new RegExp(`require\\((['"])${escapeSpec(spec)}\\1\\)`, 'g'), `require(${replacement})`)
}

function asModuleId(id: string): string {
  return JSON.stringify(id)
}

/** 模块表 + 运行时垫片 + 入口调用。 */
function assembleScript(defs: { id: string; code: string }[], entry: string, runtime: BundleRuntime): string {
  const table = defs
    .map((def) => `${JSON.stringify(def.id)}: function (module, exports, require) {\n${def.code}\n}`)
    .join(',\n')

  return `<script data-nucleus="react">${runtime.react}</script>
<script data-nucleus="react-dom">${runtime.reactDom}</script>
<script data-nucleus="bundle">
(function () {
  var React = window.React;
  var ReactDOM = window.ReactDOM;
  if (!React || !ReactDOM) {
    document.body.innerHTML = '<pre style="padding:16px;color:#b42318">React 运行时没有加载成功</pre>';
    return;
  }
  /*
   * JSX 自动运行时：sucrase 把 <div/> 编成 jsx('div', {children:...})，
   * 这里直接转投 createElement —— props 里的 children 会被 createElement 正确摊平，
   * 不需要我们再实现一遍 children 规范化。
   */
  function jsx(type, props, key) {
    var next = props;
    if (key !== undefined) {
      next = Object.assign({}, props || {});
      next.key = key;
    }
    return React.createElement(type, next);
  }
  var jsxRuntime = { jsx: jsx, jsxs: jsx, Fragment: React.Fragment, jsxDEV: jsx };
  var externals = {
    'react': React,
    'react-dom': ReactDOM,
    'react-dom/client': { createRoot: ReactDOM.createRoot, hydrateRoot: ReactDOM.hydrateRoot },
    'react/jsx-runtime': jsxRuntime,
    'react/jsx-dev-runtime': jsxRuntime
  };
  var defs = {
${table}
  };
  var cache = {};
  function req(id) {
    if (Object.prototype.hasOwnProperty.call(externals, id)) return externals[id];
    if (cache[id]) return cache[id].exports;
    var module = { exports: {} };
    cache[id] = module;
    var def = defs[id];
    if (!def) throw new Error('找不到模块：' + id);
    def(module, module.exports, req);
    return module.exports;
  }
  window.__nucleus_modules = defs;
  req(${asModuleId(entry)});
})();
</script>`
}

/** 打包失败时的可见错误页：白屏是最难排查的失败形态，宁可把原因写在屏幕上。 */
function errorDocument(issues: BundleIssue[]): string {
  const rows = issues
    .map(
      (issue) =>
        `<li style="margin:0 0 8px"><code style="color:#b42318">${escapeHtml(issue.path)}</code><br>${escapeHtml(issue.message)}</li>`,
    )
    .join('')
  return `<div style="font:14px/1.7 -apple-system,'Segoe UI','PingFang SC',sans-serif;padding:24px;color:#16161a">
  <h3 style="margin:0 0 8px;font-size:15px">React 模块没能打包</h3>
  <p style="margin:0 0 12px;color:#6e6e78">预览需要所有被 import 的文件都能解析。下面这几处改好就能跑：</p>
  <ul style="margin:0;padding-left:20px">${rows}</ul>
</div>`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)
}

/**
 * 打包入口。
 *
 * 返回的 `script` 已经包含 React 运行时，调用方要做的是：
 *  1. 把入口 HTML 里的 `<script type="module">` 整段换成它；
 *  2. 把 `styles` 按顺序插成 `<style data-src>`。
 */
export function bundleModules(
  files: FileEntry[],
  entry: ModuleEntry,
  compile: Compiler,
  runtime: BundleRuntime,
): BundleResult {
  const map = new Map(files.map((file) => [file.path, file]))
  const issues: BundleIssue[] = []
  const external: string[] = []
  const styles: { path: string; content: string }[] = []
  const modules: string[] = []
  const defs: { id: string; code: string }[] = []
  const seenCss = new Set<string>()
  const queue: { path: string; from: string }[] = [{ path: entry.module, from: entry.module }]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const next = queue.shift()!
    if (visited.has(next.path)) continue
    visited.add(next.path)

    const file = map.get(next.path)
    if (!file) {
      issues.push({ path: next.path, message: `被 ${next.from} 引用的文件不存在` })
      continue
    }

    const isCssSpec = (spec: string) => !!resolvePath(map, joinPath(next.path, spec))?.endsWith('.css')

    let code = stripCssImports(file.content, isCssSpec)
    const specs = specifiersOf(file.content)

    // 先转译再改写 require：转译器（sucrase）会用原样字符串生成 require，
    // 所以在源码上改写路径既不可靠也没必要 —— 编译产物里替换才是精确的。
    try {
      // JSON 天然就是一个模块：不需要转译器，也不该为它多跑一趟解析
      code = next.path.endsWith('.json') ? `module.exports = ${file.content}` : compile(code, next.path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      issues.push({ path: next.path, message })
      continue
    }

    /**
     * 只处理"编译产物里真的出现了 require"的说明符。
     *
     * 说明符是用正则从**源码**里扫的，注释和字符串里的 `from './xxx'` 也会被扫到；
     * 拿它去解析依赖，就会把一句注释报成"找不到模块"，让本来能跑的项目变成阻断失败。
     * 转译后仍然存在的 require 才说明这真的是一条 import。
     */
    const linked = (spec: string) =>
      code.includes(`require(${JSON.stringify(spec)})`) || code.includes(`require('${spec}')`)

    for (const spec of specs) {
      try {
        // 裸依赖：只认运行时里有的那几个，其余如实报错（沙箱没有包管理器）
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
          if (!linked(spec)) continue
          const builtin = /^react(-dom)?(\/client|\/jsx-runtime|\/jsx-dev-runtime)?$/.test(spec)
          if (!builtin && !external.includes(spec)) external.push(spec)
          continue
        }
        const resolved = resolvePath(map, joinPath(next.path, spec))
        // 样式在转译前就被剥掉了（不会有 require），所以它必须在 linked 之前处理
        if (resolved?.endsWith('.css')) {
          if (!seenCss.has(resolved)) {
            seenCss.add(resolved)
            styles.push({ path: resolved, content: map.get(resolved)?.content ?? '' })
          }
          continue
        }
        if (!linked(spec)) continue
        if (!resolved) {
          issues.push({ path: next.path, message: `找不到模块 ${spec}` })
          continue
        }
        if (ASSETS.test(resolved)) {
          const content = map.get(resolved)?.content ?? ''
          const uri = /\.svg$/i.test(resolved) ? svgDataUri(content) : null
          if (!uri) {
            issues.push({ path: resolved, message: '二进制图片没有落库通道，请改用 .svg 或内联 data URI' })
            continue
          }
          code = rewriteRequire(code, spec, JSON.stringify(uri))
          continue
        }
        code = rewriteRequire(code, spec, asModuleId(resolved))
        queue.push({ path: resolved, from: next.path })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        issues.push({ path: next.path, message })
      }
    }

    modules.push(next.path)
    defs.push({ id: next.path, code: code.replace(/<\/script/gi, '<\\/script') })
  }

  if (external.length > 0) {
    issues.push({
      path: entry.module,
      message: `预览只内置 react / react-dom，没有 ${external.join('、')}：请改用原生 API 或去掉这些 import`,
    })
  }

  const runtimeBytes = byteLength(runtime.react) + byteLength(runtime.reactDom)
  const ok = issues.length === 0
  return {
    ok,
    script: ok
      ? assembleScript(defs, entry.module, {
          react: runtime.react.replace(/<\/script/gi, '<\\/script'),
          reactDom: runtime.reactDom.replace(/<\/script/gi, '<\\/script'),
        })
      : errorDocument(issues),
    styles,
    modules,
    external,
    issues,
    runtimeBytes,
  }
}

/** 调用方把入口 HTML 与打包结果拼回一份文档。 */
export function applyBundle(html: string, result: BundleResult): string {
  const styles = result.styles
    .map((style) => `<style data-src="${style.path}">\n${style.content.replace(/<\/style/gi, '<\\/style')}\n</style>`)
    .join('\n')

  /**
   * 一律用函数式替换。
   * `String.replace(str, str)` 会把替换串里的 `$&` / `$'` 当成特殊变量展开，
   * 而这段字符串是**编译产物**（React 运行时 + 用户代码），里面出现 `$&` 完全正常 ——
   * 一旦命中，被替换掉的 `<script type="module">` 会被原样插回来，页面直接白屏。
   */
  const withScript = MODULE_TAG.test(html)
    ? html.replace(MODULE_TAG, () => result.script)
    : // 没有声明的模块脚本：挂到 </body> 前，实在没有就追加到末尾
      html.includes('</body>')
      ? html.replace(/<\/body>/i, () => `${result.script}\n</body>`)
      : `${html}\n${result.script}`

  if (!styles) return withScript
  const head = /<head\b[^>]*>/i.exec(withScript)
  if (head) {
    const at = head.index + head[0].length
    return `${withScript.slice(0, at)}\n${styles}${withScript.slice(at)}`
  }
  return `${styles}\n${withScript}`
}
