/**
 * 服务组装：store / 目录 / 路由表 / 静态回退 / 统一错误出口。
 *
 * 这一层刻意保持"只剩接线"——原来 1016 行的 index.ts 拆成了：
 *   http/      传输原语（错误、JSON、静态、SSE、路由匹配）
 *   routes/    每条接口一个文件，只做取参 → 校验 → 调 service → 回包
 *   services/  业务编排（生成、设置投影、预览）
 * 装卸顺序和响应语义与拆分前逐条对齐，`tests/server.test.ts` 是这份等价性的凭据。
 */

import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { buildCatalog, createCatalogSource, type ResolvedCatalog } from './agent/providers'
import { HttpError } from './http/errors'
import { sendError } from './http/respond'
import { resolveRoute, type Route } from './http/router'
import { serveStatic } from './http/static'
import { exportRoute } from './routes/export'
import { generateRoute } from './routes/generate'
import { healthRoute } from './routes/health'
import { projectRoutes } from './routes/projects'
import { settingsRoutes } from './routes/settings'
import { shareRoutes } from './routes/share'
import { seedDatabase } from './store/seed'
import { Store, resolveDataFile } from './store/store'

const DATA_DIR = resolve(process.env.NUCLEUS_DATA_DIR ?? 'data')
const CLIENT_DIR = resolve(process.env.NUCLEUS_CLIENT_DIR ?? 'dist/client')

/** 读接口只认 GET/HEAD/OPTIONS：以前不校验方法，DELETE /api/health 也会拿到 200。 */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export interface ServerOptions {
  dataDir?: string
  clientDir?: string
  port?: number
  env?: NodeJS.ProcessEnv
  /** 注入模型目录（测试用假上游时走这里，不必真去联网） */
  catalog?: ResolvedCatalog
}

export async function createNucleusServer(options: ServerOptions = {}) {
  const dataDir = options.dataDir ?? DATA_DIR
  const env = options.env ?? process.env
  // clientDir 必须真的贯穿到静态服务：以前只回显在返回值里，
  // 导致测试传了自定义产物目录却仍然读到全局默认目录（"配置没生效"的经典形态）。
  const clientDir = resolve(options.clientDir ?? CLIENT_DIR)
  const store = await Store.open(resolveDataFile(dataDir))
  const catalog = options.catalog ?? (await buildCatalog({ dataDir, env }))
  /**
   * 注入目录（测试、脚本）时它是静态的；生产走带 mtime 检测的源 ——
   * 改完 config/providers.json 或 data/providers.local.json 不必重启进程。
   */
  const catalogSource = options.catalog
    ? { get: async () => options.catalog as ResolvedCatalog }
    : createCatalogSource({ dataDir, env })
  const seeded = await seedDatabase(store)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)
    const segments = pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'

    /**
     * 按需取目录：只有真用到模型配置的接口才去 stat 配置文件，
     * 静态资源请求不受影响；同一个请求内多次取用共享同一份快照。
     *
     * 路由表在这里按请求构造（十几个小对象），换来的是 http/ 层不必认识
     * ResolvedCatalog 这个领域类型 —— 这点分配开销远小于一次 stat。
     */
    let snapshot: ResolvedCatalog | null = null
    const getCatalog = async () => (snapshot ??= await catalogSource.get())

    const routes: Route[] = [
      healthRoute({ store, getCatalog, seeded }),
      ...settingsRoutes({ store, getCatalog }),
      ...shareRoutes({ store }),
      // 顺序有讲究：export 与 generate 必须先于 projects 的 `:id/*` 通配
      generateRoute({ store, getCatalog }),
      exportRoute({ store }),
      ...projectRoutes({ store, getCatalog }),
    ]

    try {
      const resolution = resolveRoute(routes, method, segments)
      if (resolution.kind === 'match') {
        await resolution.route.handler({ req, res, url, pathname, segments, params: resolution.params, method })
        return
      }
      // 路径对、方法不对：405。这里和下面的 /api 404 是两种语义，别合并
      if (resolution.kind === 'method') throw new HttpError(405, 'bad_request', '不支持的方法')

      // 任何没匹配到的 /api/* 一律用 JSON 回：绝不能掉进静态回退，
      // 否则 DELETE /api/health 这类错误方法会拿到 200 + index.html，让调用方以为成功。
      if (segments[0] === 'api') {
        throw new HttpError(
          READ_METHODS.has(method) ? 404 : 405,
          'bad_request',
          '接口不存在或不支持该方法',
        )
      }

      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'bad_request', '不支持的方法')
      await serveStatic(res, pathname, clientDir, method === 'HEAD')
    } catch (error) {
      if (res.headersSent) {
        // 已经在流式输出中途：不能再补 JSON（客户端只认 SSE 帧），
        // 但必须留下日志 —— 否则"事件流戛然而止、没有 done 也没有 error"是最难查的一类故障。
        console.error('[nucleus] 流式响应中断', pathname, error)
        if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify({ type: 'error', code: 'internal', message: '服务端在生成过程中出错了' })}\n\n`)
          } catch {
            /* 连接已断，写不进去 */
          }
        }
        res.end()
        return
      }
      sendError(res, error)
    }
  })

  return { server, store, dataDir, clientDir, catalog }
}
