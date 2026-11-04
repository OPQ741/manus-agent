/**
 * 分享链接：`/api/share/:slug` 给数据，`/p/:slug` 给好看的地址。
 *
 * `/p/:slug` 是 302 到 hash 路由 —— 静态托管时没有服务端，hash 是最省事的兼容方式；
 * 有服务端时用一个短路径把人接进去，链接看起来才像"一个作品"而不是"一个参数"。
 */

import { HttpError } from '../http/errors'
import { sendJson } from '../http/respond'
import { route, type Route } from '../http/router'
import { previewOf } from '../services/preview'
import type { Store } from '../store/store'

export function shareRoutes(deps: { store: Store }): Route[] {
  const payload = (slug: string) => {
    const project = deps.store.getBySlug(slug)
    if (!project) throw new HttpError(404, 'not_found', '分享链接不存在')
    const preview = previewOf(project.files, project.tweak)
    return {
      project: {
        id: project.id,
        slug: project.slug,
        name: project.name,
        summary: project.summary,
        version: project.version,
        fileCount: project.files.length,
        provider: project.provider,
        providerLabel: project.providerLabel,
        providerModel: project.providerModel,
        createdBy: project.createdBy,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
      html: preview.html,
      checks: preview.checks,
    }
  }

  // OPTIONS 也放行：分享页可能被跨域探测
  const api = (pattern: string): Route =>
    route(pattern, ['GET', 'OPTIONS'], ({ res, params }) => sendJson(res, 200, payload(params['slug']!)))

  const short = (pattern: string): Route =>
    route(pattern, 'ANY', ({ res, params }) => {
      res.writeHead(302, { location: `/#/p/${params['slug']!}` })
      res.end()
    })

  return [
    api('/api/share/:slug'),
    // 旧实现忽略多余路径段（/api/share/a/b 等价于 /api/share/a），通配保留这个语义
    api('/api/share/:slug/*'),
    short('/p/:slug'),
    short('/p/:slug/*'),
  ]
}
