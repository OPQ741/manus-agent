/**
 * HTTP 层：路由 + 静态资源 + SSE。
 *
 * 刻意不用框架：整台服务只有 10 个接口，手写路由比引入框架更短、更可控，
 * 也不用担心框架自带的 body 解析/超时策略与 SSE 打架。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, Check, DesignPrefs, DesignTweak, EngineId, FileEntry, GenerateRequest } from '../shared/types'
import { PROMPT_MAX_LENGTH } from '../shared/types'
import { LlmError, testConnection, validateBaseUrl } from './agent/llm'
import { createEngine, createSink, runGeneration, type GenSink } from './agent/runner'
import { assemble, entryPath } from './preview/assemble'
import { injectTweak, sanitizeTweak } from './preview/tweak'
import { createZip } from './export/zip'
import { seedDatabase } from './store/seed'
import { Store, resolveDataFile } from './store/store'

const PORT = Number(process.env.PORT ?? 8787)
const DATA_DIR = resolve(process.env.NUCLEUS_DATA_DIR ?? 'data')
const CLIENT_DIR = resolve(process.env.NUCLEUS_CLIENT_DIR ?? 'dist/client')

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

class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function sendError(res: ServerResponse, error: unknown) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code, message: error.message })
    return
  }
  console.error('[nucleus] unhandled', error)
  sendJson(res, 500, { error: 'internal', message: '服务端出了点问题，请重试' })
}

async function readJson<T>(req: IncomingMessage, limit = 1024 * 512): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new HttpError(413, 'bad_request', '请求体过大')
    chunks.push(buf)
  }
  if (size === 0) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'bad_request', '请求体不是合法 JSON')
  }
}

function previewOf(files: FileEntry[], tweak?: DesignTweak): { html: string; checks: Check[] } {
  const result = assemble(files, tweak)
  return { html: result.html, checks: result.checks }
}

function sanitizeDesign(input: Partial<DesignPrefs> | undefined, fallback: DesignPrefs): DesignPrefs {
  const design: DesignPrefs = { ...fallback }
  if (input?.accent && /^#[0-9a-fA-F]{6}$/.test(input.accent)) design.accent = input.accent
  if (input?.theme === 'light' || input?.theme === 'dark' || input?.theme === 'auto') design.theme = input.theme
  if (input?.locale === 'zh' || input?.locale === 'en') design.locale = input.locale
  return design
}

/** 正在进行的生成：项目 id → 中断控制器。用来实现「停止并保留」。 */
const running = new Map<string, AbortController>()

async function handleGenerate(req: IncomingMessage, res: ServerResponse, store: Store, projectId: string) {
  const project = store.getProject(projectId)
  if (!project) throw new HttpError(404, 'not_found', '项目不存在')

  const body = await readJson<GenerateRequest>(req)
  const prompt = (body.prompt ?? '').trim()
  if (!prompt) throw new HttpError(400, 'bad_request', '请输入需求描述')
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new HttpError(400, 'bad_request', `需求描述最多 ${PROMPT_MAX_LENGTH} 字`)
  }

  if (running.has(projectId)) throw new HttpError(409, 'busy', '这个项目正在生成，请先停止或等它跑完')

  const settings = store.getSettings()
  const engine: EngineId = body.engine ?? settings.engine
  if (engine === 'cloud' && !(settings.baseUrl && settings.model && settings.apiKey)) {
    throw new HttpError(412, 'engine_unconfigured', '云模型还没配置：去设置里填写模型地址、模型名和 Key')
  }

  const controller = new AbortController()

  let clientGone = false
  res.on('close', () => {
    clientGone = true
    controller.abort()
  })
  // 客户端断开后继续写会触发 ERR_STREAM_DESTROYED；这里吞掉，避免整台服务崩掉
  res.on('error', () => {
    clientGone = true
  })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: AgentEvent) => {
    if (clientGone || res.writableEnded || res.destroyed) return
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      clientGone = true
    }
  }

  running.set(projectId, controller)
  await store.appendMessage({ projectId, role: 'user', kind: 'text', content: prompt })

  const ctx = {
    prompt,
    design: project.design,
    engine,
    files: project.files,
    plan: project.plan,
    signal: controller.signal,
    llm: engine === 'cloud' ? { baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey } : undefined,
  }
  const sink = createSink(project.files, project.plan)

  let failed: { code: string; message: string } | null = null

  try {
    const agent = createEngine(engine, ctx)
    for await (const event of runGeneration(ctx, agent, sink)) {
      if (event.type === 'done') continue
      if (event.type === 'error') {
        failed = { code: event.code, message: event.message }
        // 中断导致的错误不是错误：用户是主动点的停止，不该弹红色报错
        if (!controller.signal.aborted) send(event)
        continue
      }
      send(event)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failed = { code: 'internal', message }
    if (!controller.signal.aborted) {
      send({ type: 'error', code: 'internal', message: message.slice(0, 300) })
    }
  } finally {
    running.delete(projectId)
  }

  const aborted = controller.signal.aborted
  if (aborted) failed = null

  if (failed) {
    await store.appendMessage({
      projectId,
      role: 'agent',
      kind: 'error',
      content: failed.message,
      meta: { code: failed.code },
    })
    res.end()
    return
  }

  const previous = new Map(project.files.map((file) => [file.path, file.content]))
  const files = aborted ? partialFiles(sink, previous) : [...sink.files.entries()].map(([path, content]) => ({
    path,
    content,
    updatedAt: Date.now(),
  }))

  const changedCount = files.filter((file) => previous.get(file.path) !== file.content).length
  const removedCount = project.files.filter((file) => !files.some((next) => next.path === file.path)).length

  // 中断保留：没有任何完整文件落库，就不产生版本（避免历史里全是空版本）
  if (aborted && changedCount === 0 && removedCount === 0) {
    if (!clientGone) {
      send({ type: 'done', version: project.version, usage: sink.usage, partial: true, kept: 0 })
      res.end()
    }
    return
  }

  const label = aborted
    ? `中断保留 · ${changedCount + removedCount} 个文件有变化`
    : project.version === 0
      ? '初始版本'
      : `第 ${project.version + 1} 版 · ${prompt.slice(0, 22)}`

  const committed = await store.commit(projectId, {
    files,
    plan: sink.plan,
    checks: sink.checks,
    prompt,
    usage: sink.usage,
    label,
  })

  if (!committed) {
    if (!clientGone) {
      send({ type: 'error', code: 'not_found', message: '项目在生成过程中被删除了' })
      res.end()
    }
    return
  }

  const changed = committed.version.changed.length
  await store.appendMessage({
    projectId,
    role: 'agent',
    kind: sink.plan ? 'plan' : 'text',
    content: aborted
      ? `已停止，保留了 ${changed} 个已完成的文件（v${committed.version.seq}）`
      : `已更新 ${changed} 个文件（v${committed.version.seq}）`,
    meta: {
      plan: sink.plan,
      checks: sink.checks,
      warnings: sink.warnings,
      usage: sink.usage,
      version: committed.version.seq,
      partial: aborted || undefined,
    },
  })

  if (clientGone) {
    res.end()
    return
  }

  send({ type: 'done', version: committed.version.seq, usage: sink.usage, partial: aborted || undefined, kept: aborted ? sink.completed.size : undefined })
  res.end()
}

/**
 * 中断保留：只留下"本轮真正写完"的文件；
 * 写了一半的文件回退到旧版本；本轮新开但没写完的文件直接丢弃。
 */
function partialFiles(sink: GenSink, previous: Map<string, string>): FileEntry[] {
  const result = new Map<string, string>()
  // 先按原项目顺序保留旧文件（写了一半的回退到旧内容）
  for (const [path, content] of previous) {
    if (sink.deleted.has(path)) continue
    result.set(path, sink.completed.has(path) ? (sink.files.get(path) ?? content) : content)
  }
  // 再补上本轮新写完的文件
  for (const [path, content] of sink.files) {
    if (result.has(path)) continue
    if (sink.deleted.has(path)) continue
    if (sink.completed.has(path)) result.set(path, content)
  }
  return [...result.entries()].map(([path, content]) => ({ path, content, updatedAt: Date.now() }))
}

async function handleExport(res: ServerResponse, store: Store, projectId: string) {
  const project = store.getProject(projectId)
  if (!project) throw new HttpError(404, 'not_found', '项目不存在')
  if (project.files.length === 0) throw new HttpError(400, 'bad_request', '这个项目还没有生成任何文件')

  const hasReadme = project.files.some((file) => /^readme\.md$/i.test(file.path))
  // 微调是"项目当前外观"的一部分：导出也必须带上，否则"下载下来跟预览长得不一样"
  const tweakTarget = project.tweak ? entryPath(project.files) : null
  const entries = project.files.map((file) => ({
    name: file.path,
    content: file.path === tweakTarget ? injectTweak(file.content, project.tweak) : file.content,
  }))
  if (!hasReadme) {
    entries.push({
      name: 'README.md',
      content: `# ${project.name}\n\n${project.summary}\n\n由 Nucleus Studio 生成（v${project.version}）。\n`,
    })
  }
  const zip = createZip(entries)
  const safeName = project.name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'nucleus-app'
  // HTTP 头只能放 ASCII：中文名走 RFC 5987 的 filename*，另给一个 ASCII 兜底
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, '').replace(/^-+/, '') || 'nucleus-app'
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${encodeURIComponent(safeName)}.zip`,
    'content-length': zip.length,
  })
  res.end(zip)
}

async function serveStatic(res: ServerResponse, pathname: string) {
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '')
  const candidate = join(CLIENT_DIR, relative || 'index.html')
  if (!candidate.startsWith(CLIENT_DIR)) throw new HttpError(403, 'bad_request', '非法路径')

  try {
    const data = await fs.readFile(candidate)
    res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' })
    res.end(data)
    return
  } catch {
    // SPA 回退
    try {
      const html = await fs.readFile(join(CLIENT_DIR, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html']! })
      res.end(html)
      return
    } catch {
      throw new HttpError(503, 'internal', '前端产物未构建，请先运行 npm run build')
    }
  }
}

export async function createNucleusServer(options: { dataDir?: string; clientDir?: string; port?: number } = {}) {
  const dataDir = options.dataDir ?? DATA_DIR
  const store = await Store.open(resolveDataFile(dataDir))
  const seeded = await seedDatabase(store)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = decodeURIComponent(url.pathname)
    const segments = pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'

    try {
      if (pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          engine: store.getSettings().engine,
          seeded,
          uptime: Math.round(process.uptime()),
          version: '1.0.0',
        })
        return
      }

      if (pathname === '/api/settings') {
        if (method === 'GET') {
          sendJson(res, 200, store.publicSettings())
          return
        }
        if (method === 'PUT') {
          const body = await readJson<{
            engine?: EngineId
            baseUrl?: string
            model?: string
            apiKey?: string
            design?: Partial<DesignPrefs>
          }>(req)
          const current = store.getSettings()
          let baseUrl = current.baseUrl
          if (typeof body.baseUrl === 'string') {
            const trimmed = body.baseUrl.trim()
            if (trimmed) {
              const guard = validateBaseUrl(trimmed)
              if (!guard.ok) throw new HttpError(400, 'bad_request', guard.reason)
              baseUrl = guard.url
            } else {
              baseUrl = ''
            }
          }
          await store.updateSettings({
            engine: body.engine === 'cloud' || body.engine === 'local' ? body.engine : current.engine,
            baseUrl,
            model: typeof body.model === 'string' ? body.model.trim() : current.model,
            apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey,
            design: sanitizeDesign(body.design, current.design),
          })
          sendJson(res, 200, store.publicSettings())
          return
        }
        throw new HttpError(405, 'bad_request', '不支持的方法')
      }

      if (pathname === '/api/settings/test' && method === 'POST') {
        const settings = store.getSettings()
        if (!(settings.baseUrl && settings.model && settings.apiKey)) {
          throw new HttpError(412, 'engine_unconfigured', '先填好模型地址、模型名和 Key')
        }
        try {
          const result = await testConnection({
            baseUrl: settings.baseUrl,
            model: settings.model,
            apiKey: settings.apiKey,
          })
          sendJson(res, 200, { ok: true, ms: result.ms, sample: result.sample, model: settings.model })
        } catch (error) {
          const code = error instanceof LlmError ? error.code : 'internal'
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 502, { ok: false, error: code, message })
        }
        return
      }

      if (segments[0] === 'api' && segments[1] === 'projects') {
        const id = segments[2]
        const action = segments[3]

        if (!id) {
          if (method === 'GET') {
            const visitor = String(req.headers['x-visitor'] ?? '').slice(0, 40)
            const onlyMine = url.searchParams.get('mine') === '1'
            sendJson(res, 200, { projects: store.listProjects(onlyMine ? visitor : undefined) })
            return
          }
          if (method === 'POST') {
            const body = await readJson<{ prompt?: string; engine?: EngineId; design?: Partial<DesignPrefs> }>(req)
            const prompt = (body.prompt ?? '').trim().slice(0, PROMPT_MAX_LENGTH)
            const settings = store.getSettings()
            const project = await store.createProject({
              prompt,
              engine: body.engine === 'cloud' || body.engine === 'local' ? body.engine : settings.engine,
              design: sanitizeDesign(body.design, settings.design),
              createdBy: String(req.headers['x-visitor'] ?? 'anonymous').slice(0, 40),
            })
            sendJson(res, 201, { project, previewHtml: '', checks: [] })
            return
          }
          throw new HttpError(405, 'bad_request', '不支持的方法')
        }

        if (action === 'generate' && method === 'POST') {
          await handleGenerate(req, res, store, id)
          return
        }
        if (action === 'export' && method === 'GET') {
          await handleExport(res, store, id)
          return
        }
        if (action === 'rollback' && method === 'POST') {
          const body = await readJson<{ seq?: number }>(req)
          const seq = Number(body.seq)
          if (!Number.isInteger(seq)) throw new HttpError(400, 'bad_request', '缺少版本号')
          const result = await store.rollback(id, seq)
          if (!result) throw new HttpError(404, 'not_found', '找不到这个版本')
          sendJson(res, 200, { project: result.project, version: result.version })
          return
        }
        // 停止当前生成：连接不关，服务端中断后把已完成的文件提交为新版本
        if (action === 'stop' && method === 'POST') {
          const controller = running.get(id)
          if (!controller) throw new HttpError(409, 'busy', '当前没有进行中的生成')
          controller.abort()
          sendJson(res, 200, { ok: true })
          return
        }

        if (method === 'GET') {
          const detail = store.detail(id)
          if (!detail) throw new HttpError(404, 'not_found', '项目不存在')
          const preview = previewOf(detail.project.files, detail.project.tweak)
          sendJson(res, 200, { ...detail, previewHtml: preview.html })
          return
        }
        if (method === 'PATCH') {
          const body = await readJson<{ name?: string; tweak?: DesignTweak | null }>(req)
          const project = await store.updateProject(id, {
            ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim().slice(0, 40) } : {}),
            // 传 null 表示"恢复默认"；不传则不动
            ...('tweak' in body ? { tweak: sanitizeTweak(body.tweak) } : {}),
          })
          if (!project) throw new HttpError(404, 'not_found', '项目不存在')
          // 顺手回一份最新产物：前端据此可以同步首屏（不必再打一次 GET）
          sendJson(res, 200, { project, previewHtml: previewOf(project.files, project.tweak).html })
          return
        }
        if (method === 'DELETE') {
          const removed = await store.deleteProject(id)
          if (!removed) throw new HttpError(404, 'not_found', '项目不存在')
          sendJson(res, 200, { ok: true })
          return
        }
        throw new HttpError(405, 'bad_request', '不支持的方法')
      }

      if (segments[0] === 'api' && segments[1] === 'share' && segments[2]) {
        const project = store.getBySlug(segments[2])
        if (!project) throw new HttpError(404, 'not_found', '分享链接不存在')
        const preview = previewOf(project.files, project.tweak)
        sendJson(res, 200, {
          project: {
            id: project.id,
            slug: project.slug,
            name: project.name,
            summary: project.summary,
            version: project.version,
            fileCount: project.files.length,
            engine: project.engine,
            createdBy: project.createdBy,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          },
          html: preview.html,
          checks: preview.checks,
        })
        return
      }

      // 好看的分享链接 → hash 路由（静态托管友好）
      if (segments[0] === 'p' && segments[1]) {
        res.writeHead(302, { location: `/#/p/${segments[1]}` })
        res.end()
        return
      }

      if (segments[0] === 'api') throw new HttpError(404, 'not_found', '接口不存在')

      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'bad_request', '不支持的方法')
      await serveStatic(res, pathname)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendError(res, error)
    }
  })

  return { server, store, dataDir, clientDir: options.clientDir ?? CLIENT_DIR }
}

export async function startServer() {
  const { server, store } = await createNucleusServer()
  server.listen(PORT, '0.0.0.0', () => {
    const settings = store.publicSettings()
    console.log(`[nucleus] http://localhost:${PORT}  engine=${settings.engine}  cloudReady=${settings.cloudReady}`)
  })
  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return server
}

const entry = process.argv[1] ? resolve(process.argv[1]) : ''
const self = fileURLToPath(import.meta.url)
if (entry && entry === resolve(self)) {
  startServer().catch((error) => {
    console.error('[nucleus] 启动失败', error)
    process.exit(1)
  })
}
