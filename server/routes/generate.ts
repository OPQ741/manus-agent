/**
 * POST /api/projects/:id/generate —— 走 SSE 的那条主链路。
 *
 * 这一层只做一件事：把请求对象和已解析的目录交给生成编排。
 * 真正的故障转移、修复轮、中断保留都在 services/generation。
 */

import type { ResolvedCatalog } from '../agent/providers'
import { route, type Route } from '../http/router'
import { handleGeneration } from '../services/generation'
import type { Store } from '../store/store'

export function generateRoute(deps: { store: Store; getCatalog: () => Promise<ResolvedCatalog> }): Route {
  return route('/api/projects/:id/generate', ['POST'], async ({ req, res, params }) => {
    // 目录要先取：取不到就别开始流，否则 SSE 头已发出去就只能靠 error 事件收场
    const catalog = await deps.getCatalog()
    await handleGeneration(req, res, deps.store, params['id']!, catalog)
  })
}
