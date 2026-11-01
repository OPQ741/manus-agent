/**
 * 预览组装器：把"多文件"编译成"一份能直接丢进 iframe 的 HTML"。
 *
 * 为什么在内联而不是 blob + 相对路径：
 *  - 生成物可能引用 styles.css / app.js，srcdoc 里没有同源静态目录可解析；
 *  - 内联后整份文档是自包含的，导出 ZIP 与分享页可以复用同一份产物。
 *
 * 时间顺序很重要：桥接脚本必须插在 <head> 之后、业务脚本之前，
 * 否则生成的应用在解析阶段抛的错会漏捕获。
 */

import type { Check, FileEntry } from '../../shared/types'
import { MAX_TOTAL_BYTES } from '../../shared/types'

export interface AssembleResult {
  html: string
  entry: string | null
  checks: Check[]
  inlined: string[]
  missing: string[]
}

const LOCAL_URL = /^(?!https?:|data:|mailto:|tel:|#|\/\/)/i

function normalize(url: string): string {
  return url.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/[?#].*$/, '')
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

  var seed = (window.__NUCLEUS_SEED && typeof window.__NUCLEUS_SEED === 'object') ? window.__NUCLEUS_SEED : {};
  var mem = {};
  for (var k in seed) { if (Object.prototype.hasOwnProperty.call(seed, k)) mem[k] = String(seed[k]); }
  var probe = '__nucleus_probe__';
  var nativeOk = false;
  try { window.localStorage.setItem(probe, '1'); window.localStorage.removeItem(probe); nativeOk = true; } catch (e) { nativeOk = false; }
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

function pickEntry(files: Map<string, FileEntry>): FileEntry | null {
  const exact = files.get('index.html')
  if (exact) return exact
  const html = [...files.values()].filter((f) => /\.html?$/i.test(f.path))
  if (html.length === 0) return null
  const preferred = html.find((f) => /^(index|main|app)\.html?$/i.test(f.path))
  return preferred ?? html[0]!
}

function inlineStylesheets(html: string, files: Map<string, FileEntry>, inlined: string[], missing: string[]) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
    const raw = href?.[2] ?? href?.[3] ?? ''
    if (!raw || !LOCAL_URL.test(raw.trim())) return tag
    const path = normalize(raw)
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

function inlineScripts(html: string, files: Map<string, FileEntry>, inlined: string[], missing: string[]) {
  return html.replace(/<script\b([^>]*)>\s*<\/script>/gi, (tag, attrs: string) => {
    const src = /src\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs)
    const raw = src?.[2] ?? src?.[3] ?? ''
    if (!raw || !LOCAL_URL.test(raw.trim())) return tag
    const path = normalize(raw)
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
  const bridge = bridgeScript()
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + '\n' + bridge + html.slice(at)
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + `\n<head>${bridge}</head>` + html.slice(at)
  }
  return bridge + '\n' + html
}

export function assemble(input: FileEntry[]): AssembleResult {
  const files = new Map<string, FileEntry>()
  for (const file of input) files.set(file.path, file)

  const entryFile = pickEntry(files)
  const inlined: string[] = []
  const missing: string[] = []
  const checks: Check[] = []

  if (!entryFile) {
    checks.push({
      id: 'entry',
      label: '入口文件存在',
      ok: false,
      level: 'block',
      detail: '没有任何 .html 文件，无法生成预览',
    })
    return { html: '', entry: null, checks, inlined, missing }
  }

  checks.push({ id: 'entry', label: '入口文件存在', ok: true, level: 'block', detail: entryFile.path })

  let html = inlineStylesheets(entryFile.content, files, inlined, missing)
  html = inlineScripts(html, files, inlined, missing)
  html = injectBridge(html)

  checks.push({
    id: 'refs',
    label: '引用完整性',
    ok: missing.length === 0,
    level: 'warn',
    detail: missing.length ? '缺失：' + missing.join('、') : `已内联 ${inlined.length} 个资源`,
  })

  const hasStructure = /<html\b/i.test(html) && /<body\b/i.test(html)
  checks.push({
    id: 'structure',
    label: 'HTML 结构完整',
    ok: hasStructure,
    level: 'warn',
    detail: hasStructure ? '<html> / <body> 正常' : '缺少 <html> 或 <body>，浏览器会自行补全但不保证样式',
  })

  const totalBytes = Buffer.byteLength(html, 'utf8')
  checks.push({
    id: 'size',
    label: '体积在预算内',
    ok: totalBytes <= MAX_TOTAL_BYTES,
    level: 'warn',
    detail: `${(totalBytes / 1024).toFixed(1)} KB / ${(MAX_TOTAL_BYTES / 1024).toFixed(0)} KB`,
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

  return { html, entry: entryFile.path, checks, inlined, missing }
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
