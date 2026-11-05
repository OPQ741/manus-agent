/**
 * 项目：列表 / 新建 / 详情 / 改名改皮肤 / 删除 / 回滚 / 停止。
 *
 * 「停止」放在这里而不是生成模块里，是因为它对外的形状是普通 JSON 接口（200/409），
 * 真正的中断动作在 services/generation（那里持有 AbortController）。
 */

import type { IncomingMessage } from 'node:http'
import type { DesignPrefs, DesignTweak, StopMode } from '../../shared/types'
import { PROMPT_MAX_LENGTH } from '../../shared/types'
import { sanitizeTweak } from '../../shared/preview/tweak'
import { resolveChain, type ResolvedCatalog } from '../agent/providers'
import { HttpError } from '../http/errors'
import { readJson, sendJson } from '../http/respond'
import { route, type Route } from '../http/router'
import { abortGeneration } from '../services/generation'
import { previewOf } from '../services/preview'
import { activeOf, sanitizeDesign, storeSettingsUser } from '../services/settings-view'
import type { Store } from '../store/store'

interface Deps {
  store: Store
  getCatalog: () => Promise<ResolvedCatalog>
}

/** 访客标识只用于"我创建的项目"，截断到 40 字符防止有人拿它当存储用。 */
function visitorOf(req: IncomingMessage, fallback = ''): string {
  return String(req.headers['x-visitor'] ?? fallback).slice(0, 40)
}

export function projectRoutes(deps: Deps): Route[] {
  /** 详情 = 项目 + 当前微调后的可运行 HTML，三处都要，抽一次。 */
  const detailPayload = (id: string) => {
    const detail = deps.store.detail(id)
    if (!detail) throw new HttpError(404, 'not_found', '项目不存在')
    return { ...detail, previewHtml: previewOf(detail.project.files, detail.project.tweak).html }
  }

  return [
    route('/api/projects', ['GET', 'POST'], async ({ req, res, method, url }) => {
      if (method === 'GET' || method === 'HEAD') {
        const visitor = visitorOf(req)
        const onlyMine = url.searchParams.get('mine') === '1'
        sendJson(res, 200, { projects: deps.store.listProjects(onlyMine ? visitor : undefined) })
        return
      }

      const body = await readJson<{ prompt?: string; provider?: string; design?: Partial<DesignPrefs> }>(req)
      const prompt = (body.prompt ?? '').trim().slice(0, PROMPT_MAX_LENGTH)
      const settings = deps.store.getSettings()
      const chain = resolveChain(await deps.getCatalog(), {
        ...storeSettingsUser(deps.store),
        provider: body.provider || settings.provider || undefined,
      })
      const active = activeOf(chain)
      const project = await deps.store.createProject({
        prompt,
        design: sanitizeDesign(body.design, settings.design),
        createdBy: visitorOf(req, 'anonymous'),
        provider: active?.id ?? '',
        providerLabel: active?.label ?? '',
        providerModel: active?.model ?? '',
      })
      sendJson(res, 201, { project, previewHtml: '', checks: [] })
    }),

    route('/api/projects/:id', ['GET', 'PATCH', 'DELETE'], async ({ req, res, method, params }) => {
      const id = params['id']!
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, detailPayload(id))
        return
      }

      if (method === 'PATCH') {
        const body = await readJson<{ name?: string; summary?: string; tweak?: DesignTweak | null }>(req)
        const project = await deps.store.updateProject(id, {
          ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim().slice(0, 40) } : {}),
          // 简介可以在编辑弹窗里改；空串是"清空"，要真的写进去，不能用 truthy 判断
          ...(typeof body.summary === 'string' ? { summary: body.summary.trim().slice(0, 140) } : {}),
          // 传 null 表示"恢复默认"；不传则不动
          ...('tweak' in body ? { tweak: sanitizeTweak(body.tweak) } : {}),
        })
        if (!project) throw new HttpError(404, 'not_found', '项目不存在')
        // 顺手回一份最新产物：前端据此可以同步首屏（不必再打一次 GET）
        sendJson(res, 200, { project, previewHtml: previewOf(project.files, project.tweak).html })
        return
      }

      const removed = await deps.store.deleteProject(id)
      if (!removed) throw new HttpError(404, 'not_found', '项目不存在')
      sendJson(res, 200, { ok: true })
    }),

    route('/api/projects/:id/rollback', ['POST'], async ({ req, res, params }) => {
      const body = await readJson<{ seq?: number }>(req)
      const seq = Number(body.seq)
      if (!Number.isInteger(seq)) throw new HttpError(400, 'bad_request', '缺少版本号')
      const result = await deps.store.rollback(params['id']!, seq)
      if (!result) throw new HttpError(404, 'not_found', '找不到这个版本')
      sendJson(res, 200, { project: result.project, version: result.version })
    }),

    /**
     * 停止当前生成：连接不关，服务端中断后按 mode 决定结局。
     *
     * - 不带 body（老客户端）：keep，把已写完的文件提交成新版本；
     * - `{ mode: 'discard' }`：连已写完的也不要，项目停在原版本。
     *
     * body 解析失败一律回落 keep：这条路是「核按钮」，宁可多留一个版本，
     * 也不能因为客户端发了个空 body 就把用户这一轮悄悄扔了。
     */
    route('/api/projects/:id/stop', ['POST'], async ({ req, res, params }) => {
      const body = await readJson<{ mode?: string }>(req).catch(() => ({ mode: undefined }))
      const mode: StopMode = body.mode === 'discard' ? 'discard' : 'keep'
      if (!abortGeneration(params['id']!, mode)) throw new HttpError(409, 'busy', '当前没有进行中的生成')
      sendJson(res, 200, { ok: true, mode })
    }),

    /**
     * 旧实现是"先按 action 分派，最后落到 GET 详情" —— 也就是说
     * `GET /api/projects/x/随便什么` 会返回详情。这条通配保留了这个宽松行为，
     * 免得重构顺手改了别人依赖的边角语义。
     */
    route('/api/projects/:id/*', ['GET'], async ({ res, params }) => {
      sendJson(res, 200, detailPayload(params['id']!))
    }),
  ]
}
