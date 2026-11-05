/**
 * 多页面：把 pages/ 目录里的每个 HTML 变成一个"能在预览里互跳"的页面。
 *
 * 核心取舍（这也是这一项真正的难点，不是路由）：
 *
 * 预览只有一个 `srcdoc`，没有第二个 URL 可导航，而每个页面的脚本都假设自己独占
 * 一个文档（`document.getElementById('app')`）。把 N 个页面塞进同一个文档时，
 * 这些查询会互相踩；靠正则改写脚本里的选择器又太脆（字符串里出现同名字样就误伤）。
 *
 * 所以这里走"每页一个 iframe"：每个页面拿到**完整、独立**的文档，脚本作用域天然
 * 隔离，模型不需要为多页面改变任何写法。壳只做三件事：
 *   1. 按路由显隐对应的 frame；
 *   2. 把页面里点到的本地链接翻译成路由切换（子帧上报 → 壳处理）；
 *   3. 把 localStorage 写入广播给其他帧（沙箱下是不透明源，各帧各有内存 shim，
 *      不广播就会出现"在 A 页存的数据，翻到 B 页就没了"）。
 *
 * 导出侧完全不同：ZIP 里就是真实的多文件，链接保持相对路径，放到任意静态服务器
 * 都能跑。两套产物、同一份 files，这是有意为之 —— 强行统一只会两边都做不好。
 */

import type { FileEntry } from '../types'

/**
 * 建帧时携带存储快照用的全局名。
 *
 * 壳写、桥接读，两处必须完全一致 —— 曾经因为一边少写一个下划线，跨页存储静默失效，
 * 表现为"翻页后数据变 null"，排查成本极高。放在这里共用一个常量，别再手抄。
 */
export const CARRY_KEY = '__NUCLEUS_CARRY__'

export interface PageUnit {
  /** 路由：'/'、'/about' */
  route: string
  /** 源文件路径：'index.html'、'pages/about.html' */
  path: string
  title: string
  content: string
}

/**
 * 文件路径 → 路由。
 *
 * - `index.html` / `pages/index.html` → `/`
 * - `pages/about.html` → `/about`
 * - `about.html` → `/about`
 * - `pages/blog/post.html` → `/blog/post`
 *
 * `pages/` 前缀被剥掉：它表示"这是页面目录"，不是 URL 层级 —— 用户看到的是
 * `/about` 而不是 `/pages/about`。壳里的链接翻译用的是同一个函数逻辑（见 buildShell）。
 */
export function pageRoute(path: string): string {
  let route = path
    .trim()
    .replace(/^\.?\//, '')
    .replace(/\.html?$/i, '')
    // pages/ 前缀要先于 /index 处理：`pages/index` 先变成 `index`，
    // 否则会剩下一个孤零零的 `pages`，被当成 `/pages` 这个"页面"。
    .replace(/^pages\//i, '')
    .replace(/\/index$/i, '')
    .replace(/^index$/i, '')
    .replace(/\/+$/, '')
  return route ? `/${route}` : '/'
}

/** 从 `<title>` 取页面标题；没有就用路由本身，避免标签页全叫"预览"。 */
export function pageTitle(html: string, route: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = match?.[1]?.replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, 80) : route === '/' ? '首页' : route
}

/**
 * 收集所有页面。只有一个 HTML 时不走多页面路径（单页项目的行为必须逐字节不变）。
 *
 * 路由冲突（`index.html` 与 `pages/index.html` 都在）时保留先出现的那个：
 * 入口永远是 `index.html`，它排在第一位。
 */
export function collectPages(files: FileEntry[]): PageUnit[] {
  const html = files.filter((file) => /\.html?$/i.test(file.path))
  const byRoute = new Map<string, PageUnit>()

  for (const file of html) {
    const route = pageRoute(file.path)
    if (byRoute.has(route)) continue
    byRoute.set(route, {
      route,
      path: file.path,
      title: pageTitle(file.content, route),
      content: file.content,
    })
  }

  return [...byRoute.values()].sort((a, b) => {
    if (a.route === b.route) return 0
    if (a.route === '/') return -1
    if (b.route === '/') return 1
    return a.route.localeCompare(b.route)
  })
}

/** 从 HTML 里捞出所有指向本地 .html 的链接（用于"页面引用了却没输出"的修复轮）。 */
export function localPageLinks(html: string): string[] {
  const out: string[] = []
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const href = (match[1] ?? match[2] ?? '').trim()
    if (!href || /^(?:[a-z]+:|\/\/|#)/i.test(href)) continue
    if (!/\.html?(?:[?#].*)?$/i.test(href)) continue
    out.push(href.replace(/[?#].*$/, ''))
  }
  return out
}

export interface ShellPage {
  route: string
  title: string
  /** 已经组装好的完整文档（内联样式/脚本、含 bridge 与设计微调） */
  doc: string
}

/**
 * 路由壳。
 *
 * 文档以 JSON 形式内嵌，再由壳脚本按需创建 iframe：这样不必把整份 HTML 塞进
 * `srcdoc="..."` 属性里做多层引号转义（那是最容易出错、也最难读的写法）。
 * 唯一需要处理的是 `</script` —— 它会把内嵌脚本提前闭合。
 *
 * 帧**按需挂载**，不是一次性全建：沙箱里的 localStorage 是各帧独立的内存 shim，
 * 页面 A 写入的数据要出现在页面 B，必须在 B 的脚本跑起来之前就塞给它。
 * 建帧时把当前存储快照写进文档（`__NUCLEUS_CARRY__`），时序才是确定的 ——
 * 如果一开始就把 B 建好，B 的脚本早就在数据写入之前跑完了。
 */
export function buildShell(pages: ShellPage[]): string {
  const docs: Record<string, string> = {}
  const titles: Record<string, string> = {}
  for (const page of pages) {
    docs[page.route] = page.doc
    titles[page.route] = page.title
  }

  const json = (value: unknown) =>
    JSON.stringify(value)
      .replace(/<\/script/gi, '<\\/script')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')

  const start = docs['/'] ? '/' : (Object.keys(docs)[0] ?? '/')
  const title = titles[start] ?? '预览'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  .np-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; display: block; }
  .np-frame[hidden] { display: none; }
</style>
</head>
<body>
<script data-nucleus="pages">
(function () {
  var DOCS = ${json(docs)};
  var TITLES = ${json(titles)};
  var frames = {};
  var mirror = {};
  var current = null;

  function inlineJson(value) {
    return JSON.stringify(value).replace(/<\\//g, '<\\\\/');
  }

  function normalize(href) {
    var value = String(href == null ? '' : href).replace(/[?#].*$/, '').trim();
    value = value.replace(/^\\.?\\//, '').replace(/\\.html?$/i, '');
    value = value.replace(/\\/index$/i, '').replace(/^index$/i, '').replace(/^pages\\//i, '');
    value = value.replace(/\\/+$/, '');
    return value ? '/' + value : '/';
  }

  /** 按需建帧：把当前存储快照塞进文档，页面脚本一跑就能读到别的页写过的数据。 */
  function ensure(route) {
    if (frames[route]) return frames[route];
    var doc = DOCS[route] || '';
    // 收尾标签必须用「反斜杠 + 斜杠」转义写，否则它会提前闭合外层壳脚本
    var carry = '<script data-nucleus="carry">window.${CARRY_KEY}=' + inlineJson(mirror) + ';<\\/script>';
    doc = /<head[^>]*>/i.test(doc)
      ? doc.replace(/<head[^>]*>/i, function (tag) { return tag + carry; })
      : carry + doc;

    var frame = document.createElement('iframe');
    frame.className = 'np-frame';
    frame.setAttribute('title', TITLES[route] || route);
    /*
     * 这里**不**声明 sandbox 属性：外层预览 iframe 的 sandbox 标志会自动继承给
     * 所有嵌套浏览上下文。重复声明一次会让子帧变成独立的 OOPIF（不透明源 + 独立沙箱），
     * 表现为"帧在 DOM 里、却读不到也点不到"——踩过一次，别再写回去。
     */
    frame.srcdoc = doc;
    document.body.appendChild(frame);
    frames[route] = frame;
    return frame;
  }

  function go(route) {
    if (!DOCS[route]) route = DOCS['/'] ? '/' : Object.keys(DOCS)[0];
    ensure(route);
    current = route;
    for (var key in frames) {
      if (Object.prototype.hasOwnProperty.call(frames, key)) frames[key].hidden = key !== route;
    }
    if (TITLES[route]) { try { document.title = TITLES[route]; } catch (e) {} }
  }

  addEventListener('message', function (event) {
    var data = event.data;
    /*
     * 心跳由壳代为应答：页面帧可能是卡死的那个，壳还活着就说明渲染线程没被占死。
     * 反过来，主线程真被死循环占住时壳也答不上来 —— 这正是要看出来的现象。
     */
    if (data && data.__nucleus_ping !== undefined) {
      try { top.postMessage({ __nucleus: 1, kind: 'pong', id: data.__nucleus_ping }, '*'); } catch (e) {}
      return;
    }
    if (!data || data.__nucleus !== 1) return;
    var from = null;
    for (var key in frames) {
      if (Object.prototype.hasOwnProperty.call(frames, key) && frames[key].contentWindow === event.source) from = key;
    }
    if (data.kind === 'navigate') { go(normalize(data.to)); return; }
    if (data.kind === 'storage') {
      // 同步镜像：之后新建的页面靠它拿到历史写入
      if (data.op === 'set') mirror[String(data.key)] = String(data.value);
      else if (data.op === 'remove') delete mirror[String(data.key)];
      else if (data.op === 'clear') mirror = {};
      // 已经在跑的其它帧直接广播过去
      for (var other in frames) {
        if (!Object.prototype.hasOwnProperty.call(frames, other) || other === from) continue;
        try { frames[other].contentWindow.postMessage({ __nucleus_store: data }, '*'); } catch (e) {}
      }
    }
    // 错误 / ready / 心跳一律上报宿主（Studio 的运行时错误面板与看门狗都依赖它们）
    try { top.postMessage(data, '*'); } catch (e) {}
  });

  go(DOCS['/'] ? '/' : Object.keys(DOCS)[0]);
})();
</script>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
