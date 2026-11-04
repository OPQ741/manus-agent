/**
 * GET /api/health —— 存活 + 线上对账。
 *
 * 回包里的 `build` 是给"线上跑的是哪一版"用的：拿它和仓库 HEAD 比就能回答，
 * 不用登机器看进程启动时间。
 */

import type { ResolvedCatalog } from '../agent/providers'
import { resolveChain } from '../agent/providers'
import { readBuildMeta } from '../build-info'
import { sendJson } from '../http/respond'
import { route, type Route } from '../http/router'
import { activeOf, storeSettingsUser } from '../services/settings-view'
import type { Store } from '../store/store'

export function healthRoute(deps: {
  store: Store
  getCatalog: () => Promise<ResolvedCatalog>
  /** 本次启动往空库里塞了几条出厂示例（0 = 库本来就有数据） */
  seeded: number
}): Route {
  // OPTIONS 也放行：这是探测类接口，探活工具常先发 OPTIONS
  return route('/api/health', ['GET', 'OPTIONS'], async ({ res }) => {
    const catalog = await deps.getCatalog()
    const chain = resolveChain(catalog, storeSettingsUser(deps.store))
    const build = readBuildMeta()
    sendJson(res, 200, {
      ok: true,
      provider: activeOf(chain)?.id ?? null,
      providers: catalog.entries.filter((entry) => entry.ready).map((entry) => entry.profile.id),
      seeded: deps.seeded,
      uptime: Math.round(process.uptime()),
      version: build.version,
      build,
    })
  })
}
