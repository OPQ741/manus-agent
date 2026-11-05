/**
 * 项目：列表 / 新建 / 详情 / 改名改皮肤 / 删除 / 回滚 / 停止。
 *
 * 「停止」放在这里而不是生成模块里，是因为它对外的形状是普通 JSON 接口（200/409），
 * 真正的中断动作在 services/generation（那里持有 AbortController）。
 */

import type { IncomingMessage } from 'node:http'
import type { DesignPrefs, DesignTweak, StopMode } from '../../shared/types'
import { MAX_FILE_BYTES, MAX_FILES, PROMPT_MAX_LENGTH } from '../../shared/types'
import { sanitizeTweak } from '../../shared/preview/tweak'
import { byteLength } from '../../shared/preview/bytes'
import { resolveChain, type ResolvedCatalog } from '../agent/providers'
import { HttpError } from '../http/errors'
import { readJson, sendJson } from '../http/respond'
import { route, type Route } from '../http/router'
import { abortGeneration, isGenerating } from '../services/generation'
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

/**
 * 手写文件路径的清洗。
 *
 * 只放行字母数字和 `_-./`：这个值会直接进文件表、导出 ZIP 的条目名、
 * 以及 `<link href>`。允许 `..` 或空格的那一刻，导出包里就会出现
 * 一个指向上一级目录的条目 —— 这类问题在本地看不出，发给别人就是事故。
 */
function sanitizeFilePath(raw: unknown): string {
  const path = String(raw ?? '').trim().replace(/^\/+/, '')
  if (!path || path.length > 120) throw new HttpError(400, 'bad_request', '文件名不合法')
  if (!/^[A-Za-z0-9_\-./]+$/.test(path) || path.includes('..')) {
    throw new HttpError(400, 'bad_request', `文件名只能包含字母、数字、下划线、连字符与 /：${path}`)
  }
  return path
}

/** 版本标题：一个文件的改动直接说文件名，多文件说"改了 N 个文件"。 */
function describeEdits(changes: { path?: unknown; content?: unknown }[]): string {
  const names = changes.map((change) => String(change.path ?? '').trim()).filter(Boolean)
  if (names.length === 1) {
    return changes[0]?.content === null ? `删除 ${names[0]}` : `手动编辑 ${names[0]}`
  }
  return `手动编辑 ${names.length} 个文件`
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
     * 手动编辑文件：把改动提交成一个新版本。
     *
     * 三个设计取舍：
     *  1. **走 commit 而不是直接改 files**：用户手改的东西也必须有版本、能回滚、
     *     能和 Agent 的轮次并列出现在版本列表里，否则"我改坏了"就没有退路；
     *  2. **expectVersion 冲突保护**：前端带回它读到的版本号，服务端对不上就 409。
     *     没有这道闸，两个标签页（或生成中的一次提交）会互相静默覆盖；
     *  3. **生成中直接拒绝**：模型这一轮结束时会把整份文件列表提交上来，
     *     此刻写进去的改动 100% 会被覆盖，提前拒绝比事后解释便宜。
     */
    route('/api/projects/:id/files', ['POST'], async ({ req, res, params }) => {
      const id = params['id']!
      const detail = deps.store.detail(id)
      if (!detail) throw new HttpError(404, 'not_found', '项目不存在')
      const project = detail.project
      if (isGenerating(id)) throw new HttpError(409, 'busy', '正在生成，等这一轮结束再改文件')

      const body = await readJson<{
        changes?: { path?: unknown; content?: unknown }[]
        expectVersion?: unknown
        note?: unknown
      }>(req)
      const changes = Array.isArray(body.changes) ? body.changes : []
      if (changes.length === 0) throw new HttpError(400, 'bad_request', '没有要保存的改动')

      const expectVersion = Number(body.expectVersion)
      if (Number.isInteger(expectVersion) && expectVersion !== project.version) {
        throw new HttpError(409, 'busy', `项目已经更新到 v${project.version}，刷新后再改`)
      }

      const next = new Map(project.files.map((file) => [file.path, { ...file }]))
      for (const change of changes) {
        const path = sanitizeFilePath(change.path)
        // content 为 null 是删除：显式传 null 才算，缺字段一律当"没给内容"拒绝
        if (change.content === null) {
          next.delete(path)
          continue
        }
        if (typeof change.content !== 'string') throw new HttpError(400, 'bad_request', `${path} 缺少内容`)
        const bytes = byteLength(change.content)
        if (bytes > MAX_FILE_BYTES) {
          throw new HttpError(400, 'bad_request', `${path} 有 ${(bytes / 1024).toFixed(0)} KB，超过单文件上限 ${MAX_FILE_BYTES / 1024} KB`)
        }
        next.set(path, { path, content: change.content, updatedAt: Date.now() })
      }
      if (next.size === 0) throw new HttpError(400, 'bad_request', '至少保留一个文件')
      if (next.size > MAX_FILES) throw new HttpError(400, 'bad_request', `文件数超过上限 ${MAX_FILES}`)

      const files = [...next.values()]
      const preview = previewOf(files, project.tweak)
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 60) : ''
      const label = note || describeEdits(changes)

      const result = await deps.store.commit(id, {
        files,
        plan: project.plan,
        checks: preview.checks,
        prompt: label,
        // 手动编辑不消耗模型：用量记 0，版本详情里显示成"没有调用模型"
        usage: { ms: 0, provider: project.provider, chars: 0 },
        label,
      })
      if (!result) throw new HttpError(404, 'not_found', '项目不存在')
      // 在对话流里留一笔：否则"这一版是怎么来的"在历史里无从追溯
      await deps.store.appendMessage({
        projectId: id,
        role: 'system',
        kind: 'notice',
        content: `${label}（v${result.project.version}）`,
      })
      sendJson(res, 200, { project: result.project, previewHtml: preview.html, checks: preview.checks })
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
