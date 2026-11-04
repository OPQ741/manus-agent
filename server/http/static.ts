/**
 * 静态资源服务（前端产物 dist/client）。
 *
 * 三条规则都是从真实故障里长出来的，别简化：
 *  - 路径必须落在 clientDir 内（`..` 归一化后仍要校验前缀），否则是任意文件读取；
 *  - 找不到文件 → 回退 index.html（前端是 hash 路由的 SPA，刷新深链接要能开）；
 *  - 连 index.html 都没有 → 503 并说清"先 build"，而不是 404 让人以为路由错了。
 */

import { promises as fs } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import type { ServerResponse } from 'node:http'
import { HttpError } from './errors'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

export async function serveStatic(res: ServerResponse, pathname: string, clientDir: string, headOnly = false) {
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  const candidate = join(clientDir, relative || 'index.html')
  if (!candidate.startsWith(clientDir)) throw new HttpError(403, 'bad_request', '非法路径')

  try {
    const data = await fs.readFile(candidate)
    res.writeHead(200, {
      'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
      'content-length': String(data.length),
    })
    res.end(headOnly ? undefined : data)
    return
  } catch {
    // SPA 回退
    try {
      const html = await fs.readFile(join(clientDir, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html']!, 'content-length': String(html.length) })
      res.end(headOnly ? undefined : html)
      return
    } catch {
      throw new HttpError(503, 'internal', '前端产物未构建，请先运行 npm run build')
    }
  }
}
