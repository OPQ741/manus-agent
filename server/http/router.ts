/**
 * 声明式路由表：几十行换掉原来 340 行的 `if (pathname === ...)` 长链。
 *
 * 为什么不是 Express Router：整台服务只有 13 条路由，需要的只是
 * "路径匹配 + 方法匹配 + 405 语义"；这三件事一张表就能表达，而引入框架还要
 * 额外接管 body 解析、静态服务、错误处理，每一处都得把现有行为重新对齐一遍
 * （512KB→413、空 body→{}、/api 不落静态回退…）。表和框架的差别只在写法。
 *
 * `*` 是尾段通配，用来复刻旧实现的宽松匹配：`/p/a/b` 等价于 `/p/a`。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

export interface RouteContext {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  pathname: string
  segments: string[]
  params: Record<string, string>
  method: string
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void

export interface Route {
  /** `/api/projects/:id/generate`；`:name` 是参数，`*` 是尾段通配 */
  pattern: string
  methods: HttpMethod[] | 'ANY'
  /**
   * 路径命中但方法不命中时是否算 405（默认算）。
   *
   * 设为 false 只用于**动作型接口**：旧实现里 /api/settings/models 与 /api/settings/test
   * 只写了 `method === 'POST'` 一个分支、没有方法守卫，GET 打过去会掉进 `/api/*` 兜底
   * （读方法 → 404）。保留那个口径，免得重构把「接口不存在」悄悄升级成「方法不支持」。
   */
  strictMethod?: boolean
  handler: RouteHandler
}

export const route = (pattern: string, methods: HttpMethod[] | 'ANY', handler: RouteHandler): Route => ({
  pattern,
  methods,
  handler,
})

/** 动作型接口：只认 POST，方法不对时按"接口不存在"处理（对齐旧口径）。 */
export const action = (pattern: string, handler: RouteHandler): Route => ({
  pattern,
  methods: ['POST'],
  strictMethod: false,
  handler,
})

export type Resolution =
  | { kind: 'match'; route: Route; params: Record<string, string> }
  | { kind: 'method'; allow: HttpMethod[] }
  | { kind: 'none' }

function matchPath(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean)
  if (parts.length > segments.length) return null

  const params: Record<string, string> = {}
  for (const [index, part] of parts.entries()) {
    if (part === '*') return params
    const actual = segments[index]
    if (part.startsWith(':')) {
      // 旧实现用 segments[2] 的真值判断"有没有 id"，空段就当没匹配上
      if (!actual) return null
      params[part.slice(1)] = actual
      continue
    }
    if (part !== actual) return null
  }
  // 没有 `*` 时必须长度完全相等，否则 /api/settings 会吃掉 /api/settings/models
  return parts.length === segments.length ? params : null
}

export function resolveRoute(routes: Route[], method: string, segments: string[]): Resolution {
  let allow: HttpMethod[] = []

  for (const candidate of routes) {
    const params = matchPath(candidate.pattern, segments)
    if (!params) continue

    if (candidate.methods === 'ANY') return { kind: 'match', route: candidate, params }
    if (candidate.methods.includes(method as HttpMethod)) return { kind: 'match', route: candidate, params }
    // HEAD 跟随 GET：Node 自己会剥掉 body，不必给每个读接口写两遍
    if (method === 'HEAD' && candidate.methods.includes('GET')) return { kind: 'match', route: candidate, params }

    if (candidate.strictMethod !== false) allow = [...new Set([...allow, ...candidate.methods])]
  }

  return allow.length > 0 ? { kind: 'method', allow } : { kind: 'none' }
}
