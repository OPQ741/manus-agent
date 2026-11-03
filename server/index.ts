/**
 * HTTP 层：路由 + 静态资源 + SSE。
 *
 * 刻意不用框架：整台服务只有 11 个接口，手写路由比引入框架更短、更可控，
 * 也不用担心框架自带的 body 解析/超时策略与 SSE 打架。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { promises as fs } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import type {
  AgentEvent,
  ApiErrorCode,
  Check,
  DesignPrefs,
  DesignTweak,
  FileEntry,
  GenerateRequest,
  ProviderInfo,
  PublicSettings,
} from '../shared/types'
import { PROMPT_MAX_LENGTH } from '../shared/types'
import { LlmError, listModels, testConnection, validateBaseUrl } from './agent/llm'
import { QueueFullError, projectedWait, waitForSlot } from './agent/queue'
import {
  buildCatalog,
  catalogView,
  createCatalogSource,
  resolveChain,
  type ResolvedCatalog,
  type ResolvedProvider,
} from './agent/providers'
import { canFailover, createSink, runGeneration, ModelEngine, type GenContext, type GenSink } from './agent/runner'
import { assemble, entryPath } from './preview/assemble'
import { injectTweak, sanitizeTweak } from './preview/tweak'
import { createZip } from './export/zip'
import { seedDatabase } from './store/seed'
import { Store, resolveDataFile, type StoredSettings } from './store/store'

const DATA_DIR = resolve(process.env.NUCLEUS_DATA_DIR ?? 'data')
const CLIENT_DIR = resolve(process.env.NUCLEUS_CLIENT_DIR ?? 'dist/client')

/** 排队上限：超过就换下一家，而不是让人对着转圈等两分钟。 */
const MAX_QUEUE_WAIT_MS = Number(process.env.NUCLEUS_MAX_QUEUE_WAIT ?? 90_000)
/** 一轮生成最多修几次：每次都是真实的上游请求，不能为了追一个顽固模型把访客钉在转圈上。 */
const MAX_REPAIR_PASSES = Number(process.env.NUCLEUS_MAX_REPAIR_PASSES ?? 2)
/** 超过这个等待就提前告诉用户"前面在排队"。 */
const QUEUE_NOTICE_MS = 1_000

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

/** 自定义通道的输出上限：给一个人类填得出来的区间，别让一个 0 或 1e9 把上游打爆。 */
function sanitizeMaxTokens(input: number | null | undefined, fallback?: number): number | undefined {
  if (input === null) return undefined
  if (typeof input !== 'number' || !Number.isFinite(input)) return fallback
  return Math.min(Math.max(Math.round(input), 256), 32_768)
}

function sanitizeTemperature(input: number | null | undefined, fallback?: number): number | undefined {
  if (input === null) return undefined
  if (typeof input !== 'number' || !Number.isFinite(input)) return fallback
  return Math.min(Math.max(input, 0), 2)
}

/** 正在进行的生成：项目 id → 中断控制器。用来实现「停止并保留」。 */
const running = new Map<string, AbortController>()

/** 解析链 → 这次实际会打给谁（访客自带 Key 优先，其次服务端主力）。 */
function activeOf(chain: ResolvedProvider[]): ProviderInfo | null {
  const first = chain[0]
  if (!first) return null
  return { id: first.profile.id, label: first.profile.label, model: first.profile.model, free: Boolean(first.profile.free) }
}

export function settingsView(store: Store, catalog: ResolvedCatalog): PublicSettings {
  const settings = store.getSettings()
  const chain = resolveChain(catalog, userFromSettings(settings))
  return {
    ...store.publicSettings(),
    providers: catalogView(catalog),
    active: activeOf(chain),
    activeReason: explainActive(catalog, settings, chain),
    warnings: catalog.warnings ?? [],
  }
}

/**
 * 「为什么是这一家」的一句话解释。
 *
 * 解析链有三层回退（点名 → 主力 → 免 Key），任何一层静默失效，用户看到的都是
 * "我明明选了 A 却在跑 B"。与其让他去猜 Key 是不是没保存，不如直接告诉他。
 */
function explainActive(
  catalog: ResolvedCatalog,
  settings: { provider: string; baseUrl: string; model: string; apiKey: string },
  chain: ResolvedProvider[],
): string {
  const first = chain[0]
  if (!first) return '没有可用通道：免 Key 通道被关掉了，也没有配置任何 Key'
  const provider = settings.provider.trim()

  if (provider === 'custom') {
    if (first.profile.id === 'custom') return '使用你自带的 Key'
    if (!settings.baseUrl.trim() || !settings.model.trim() || !settings.apiKey.trim()) {
      return '自带 Key 还差 Base URL / 模型名 / Key 其中一项，已回退到服务端通道'
    }
    return '自带 Key 的地址不可用（内网地址会被拒绝），已回退到服务端通道'
  }

  if (provider) {
    const named = catalog.entries.find((entry) => entry.profile.id === provider)
    if (!named) return `点名的通道「${provider}」不在目录里，已回退到 ${first.profile.label}`
    if (!named.ready) return `「${named.profile.label}」还没有 Key，已回退到 ${first.profile.label}`
    if (first.profile.id === provider) {
      const model = first.profile.model
      return `按你的选择使用「${named.profile.label}」（${model}）`
    }
    return `点名的「${named.profile.label}」这次没排上，已回退到 ${first.profile.label}`
  }

  return first.profile.id === catalog.defaultId
    ? '服务端默认通道'
    : `服务端默认通道不可用，已回退到 ${first.profile.label}`
}

interface AttemptResult {
  /** 成功产出（或用户主动停止后仍有产出） */
  ok: boolean
  /** 失败但可以换一家重试 */
  retryable: boolean
  aborted: boolean
  sink: GenSink
  failed: { code: ApiErrorCode; message: string } | null
}

/**
 * 对一个提供方跑一次生成。
 *
 * 排队（免 Key 通道 30 秒 1 次）也在这里：等不到槽位就当"这家不可用"往外报，
 * 让调用方换下一家，而不是把用户钉在队列里。
 */
async function attemptWith(
  provider: ResolvedProvider,
  base: GenContext,
  send: (event: AgentEvent) => void,
  controller: AbortController,
): Promise<AttemptResult> {
  const sink = createSink(base.files, base.plan)
  const ctx: GenContext = { ...base, signal: controller.signal }

  const interval = provider.profile.minIntervalMs ?? 0
  if (interval > 0) {
    const ahead = projectedWait(provider.profile.id, interval)
    if (ahead > QUEUE_NOTICE_MS) {
      send({
        type: 'notice',
        level: 'info',
        message: `${provider.profile.label} 是免 Key 通道，前面还有约 ${Math.ceil(ahead / 1000)} 秒排队，正在等它…`,
      })
    }
    try {
      await waitForSlot(provider.profile.id, { minIntervalMs: interval, maxWaitMs: MAX_QUEUE_WAIT_MS, signal: controller.signal })
    } catch (error) {
      if (error instanceof QueueFullError) {
        // 没排上队：不算失败，只是这家太挤，交给调用方换下一家
        return { ok: false, retryable: true, aborted: false, sink, failed: null }
      }
      return { ok: false, retryable: false, aborted: true, sink, failed: null }
    }
  }

  const engine = new ModelEngine(provider)
  let failed: AttemptResult['failed'] = null
  for await (const event of runGeneration(ctx, engine, sink)) {
    if (event.type === 'done') continue
    // 错误**先不发**：这家失败但下一家成功时，用户只该看到一条"换了一家"的提示，
    // 而不是一红条 + 一份成功产物。终态由 handleGenerate 决定要不要发 error。
    if (event.type === 'error') {
      failed = { code: event.code, message: event.message }
      continue
    }
    send(event)
  }

  if (controller.signal.aborted) return { ok: false, retryable: false, aborted: true, sink, failed: null }
  if (failed) return { ok: false, retryable: canFailover(failed.code, sink), aborted: false, sink, failed }
  return { ok: true, retryable: false, aborted: false, sink, failed: null }
}

async function handleGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  projectId: string,
  catalog: ResolvedCatalog,
) {
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
  /**
   * 本次生成可以点名「通道 + 模型」：两者都是**临时覆盖**，不写回设置。
   *
   * 自带 Key 的模型名存在 settings.model 而不是 modelOverride 里，
   * 所以自定义通道换模型要改前者的副本；其余走 modelOverride。
   */
  const modelOverride = (body.model ?? '').trim().slice(0, 120)
  const user = userFromSettings(settings)
  const namedProvider = (body.provider ?? settings.provider) || undefined
  const chain = resolveChain(catalog, {
    ...user,
    provider: namedProvider,
    ...(modelOverride
      ? namedProvider === 'custom'
        ? { model: modelOverride }
        : { modelOverride }
      : {}),
  })
  if (chain.length === 0) {
    throw new HttpError(
      412,
      'provider_unavailable',
      '没有可用的模型通道：免 Key 通道被关掉了，也没有填自己的 Key。到设置里填一项，或给服务端配一个 Key。',
    )
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

  const base = { prompt, design: project.design, files: project.files, plan: project.plan, repair: undefined as GenContext['repair'] }

  let result: AttemptResult | null = null
  let used: ResolvedProvider | null = null
  const tried: string[] = []

  try {
    for (const [index, provider] of chain.entries()) {
      tried.push(provider.profile.id)
      const attempt = await attemptWith(provider, base, send, controller)
      result = attempt
      if (attempt.ok || attempt.aborted) {
        used = provider
        break
      }
      if (!attempt.retryable) break
      const next = chain[index + 1]
      if (next) {
        send({
          type: 'notice',
          level: 'warn',
          message: `${provider.profile.label} 这次不可用，正在换下一家（${next.profile.label}）…`,
        })
      }
    }
  } finally {
    running.delete(projectId)
  }

  /**
   * 修复轮：assemble 报出来的三类"生成了但不完整"都在这里收拾。
   *
   *  - missing：页面引用了却没被输出的文件（模型忘了写 app.js）；
   *  - truncated：闭合标签没等到、写到一半就断的文件（内容不可信）；
   *  - broken：语法就不通的脚本（一个没闭合的字符串会让整个应用静默白屏）。
   *
   * 规则：
   *  - 最多修 MAX_REPAIR_PASSES 轮 —— 每轮都是一次真实的上游请求，
   *    不能为了追一个顽固的模型把访客钉在转圈上；
   *  - 修不动就保留当前最好的产物 + 一条可见的 warn，而不是把整次生成判成失败：
   *    少一个文件的应用还能看、还能继续对话让它补，报错清空则什么都没剩下。
   */
  let pass = 0
  while (result?.ok && used && !controller.signal.aborted) {
    const sink = result.sink
    // 同一个文件可能同时"被截断"和"语法不通"（前者导致后者），按路径去重后再拼原因，
    // 否则提示里会出现"检测到 app.js、app.js 不完整"这种让人怀疑系统坏掉的话。
    const reasons = new Map<string, string[]>()
    const note = (path: string, reason: string) => reasons.set(path, [...(reasons.get(path) ?? []), reason])
    for (const path of sink.missing) note(path, '页面引用了它，但上一次没有输出这个文件')
    for (const path of sink.truncated) note(path, '上一次写到一半就断了（没有闭合标签），内容不完整')
    for (const path of sink.broken) note(path, '上一次输出的内容语法不通，浏览器会直接报错')
    const repair = [...reasons.entries()].map(([path, list]) => ({ path, reason: list.join('；') }))
    if (repair.length === 0 || pass >= MAX_REPAIR_PASSES) break
    pass++

    send({
      type: 'notice',
      level: 'info',
      message: `检测到 ${repair.map((item) => item.path).join('、')} 不完整，正在修第 ${pass} 轮…`,
    })
    const previous = result.sink
    const merged: FileEntry[] = [...previous.files.entries()].map(([path, content]) => ({
      path,
      content,
      updatedAt: Date.now(),
    }))
    const retry = await attemptWith(
      used,
      { ...base, prompt: `修复这些文件：${repair.map((item) => item.path).join('、')}`, files: merged, plan: previous.plan, repair },
      send,
      controller,
    )
    if (!retry.ok) {
      send({ type: 'notice', level: 'warn', message: '这一轮修复没成功，已保留之前生成的结果。' })
      break
    }
    // 用量要累计：只报最后一轮会让界面上的耗时与 token 比真实值小一大截
    retry.sink.usage = {
      ms: previous.usage.ms + retry.sink.usage.ms,
      provider: retry.sink.usage.provider,
      chars: previous.usage.chars + retry.sink.usage.chars,
      tokens:
        previous.usage.tokens || retry.sink.usage.tokens
          ? (previous.usage.tokens ?? 0) + (retry.sink.usage.tokens ?? 0)
          : undefined,
    }
    result = retry
  }
  if (result?.ok && result.sink.missing.length + result.sink.broken.length + result.sink.truncated.size > 0) {
    const left = [...result.sink.missing, ...[...result.sink.truncated], ...result.sink.broken]
    send({ type: 'notice', level: 'warn', message: `修完仍有问题：${[...new Set(left)].join('、')}。已保留能用的部分，你可以继续对话让它补。` })
  }

  const aborted = controller.signal.aborted
  const sink = result?.sink ?? createSink(project.files, project.plan)
  /**
   * 失败判定必须先看 `result.ok`，不能直接 `result.failed ?? 默认值`：
   * 成功时 failed 是**显式 null**，`??` 会把 null 当缺失，于是每次成功都被判成
   * "所有通道都没能用上"（真踩过：生成成功、文件也落库了，但前端只看到红色报错）。
   */
  const failed = aborted
    ? null
    : result?.ok
      ? null
      : (result?.failed ?? { code: 'provider_unavailable' as ApiErrorCode, message: '所有模型通道都没能用上' })

  if (failed) {
    // 走到这里说明整条链都没有成功产出：此刻才把红色错误发给前端
    send({ type: 'error', code: failed.code, message: failed.message })
    await store.appendMessage({
      projectId,
      role: 'agent',
      kind: 'error',
      content: failed.message + (tried.length > 1 ? `（已尝试：${tried.join(' → ')}）` : ''),
      meta: { code: failed.code, tried },
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

  const providerInfo = used ? activeOf([used]) : null
  const committed = await store.commit(projectId, {
    files,
    plan: sink.plan,
    checks: sink.checks,
    prompt,
    usage: sink.usage,
    label,
    provider: providerInfo
      ? { id: providerInfo.id, label: providerInfo.label, model: providerInfo.model }
      : undefined,
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
      provider: providerInfo,
      version: committed.version.seq,
      partial: aborted || undefined,
      /** 这一轮动了哪些文件：历史消息里的「结果卡」据此列出文件名，而不是只报一个数字 */
      changed: committed.version.changed.slice(0, 24),
      files: files.length,
    },
  })

  if (clientGone) {
    res.end()
    return
  }

  send({
    type: 'done',
    version: committed.version.seq,
    usage: sink.usage,
    provider: providerInfo ?? undefined,
    partial: aborted || undefined,
    kept: aborted ? sink.completed.size : undefined,
  })
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

async function handleExport(res: ServerResponse, store: Store, projectId: string, headOnly = false) {
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
      content: `# ${project.name}\n\n${project.summary}\n\n由 Nucleus Studio 生成（v${project.version}，模型：${project.providerLabel || project.provider}）。\n`,
    })
  }
  const zip = createZip(entries)
  const safeName = project.name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'nucleus-app'
  // HTTP 头只能放 ASCII：中文名走 RFC 5987 的 filename*，另给一个 ASCII 兜底
  const asciiName = safeName.replace(/[^\x20-\x7e]/g, '').replace(/^-+/, '') || 'nucleus-app'
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${encodeURIComponent(safeName)}.zip`,
    'content-length': String(zip.length),
  })
  res.end(headOnly ? undefined : zip)
}

async function serveStatic(res: ServerResponse, pathname: string, clientDir: string, headOnly = false) {
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
     */
    let snapshot: ResolvedCatalog | null = null
    const getCatalog = async () => (snapshot ??= await catalogSource.get())

    try {
      // 读接口只认 GET/HEAD：以前不校验方法，DELETE /api/health 这类错误调用
      // 会拿到 200 + 正常 JSON，调用方完全看不出自己用错了方法。
      const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

      if (pathname === '/api/health') {
        if (!READ_METHODS.has(method)) throw new HttpError(405, 'bad_request', '不支持的方法')
        const catalog = await getCatalog()
        const chain = resolveChain(catalog, storeSettingsUser(store))
        sendJson(res, 200, {
          ok: true,
          provider: activeOf(chain)?.id ?? null,
          providers: catalog.entries.filter((entry) => entry.ready).map((entry) => entry.profile.id),
          seeded,
          uptime: Math.round(process.uptime()),
          version: '1.0.0',
        })
        return
      }

      if (pathname === '/api/settings') {
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, settingsView(store, await getCatalog()))
          return
        }
        if (method === 'PUT') {
          const body = await readJson<{
            provider?: string
            baseUrl?: string
            model?: string
            modelOverride?: string
            apiKey?: string
            maxTokens?: number | null
            temperature?: number | null
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
            provider: typeof body.provider === 'string' ? body.provider.trim().slice(0, 40) : current.provider,
            baseUrl,
            model: typeof body.model === 'string' ? body.model.trim().slice(0, 120) : current.model,
            modelOverride:
              typeof body.modelOverride === 'string' ? body.modelOverride.trim().slice(0, 120) : current.modelOverride,
            maxTokens: sanitizeMaxTokens(body.maxTokens, current.maxTokens),
            temperature: sanitizeTemperature(body.temperature, current.temperature),
            // 显式传空串 = 清除 Key；不传这个键 = 保持不动。
            // 少了这条，访客换到服务端预设后，自己的旧 Key 会一直悄悄优先。
            apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : current.apiKey,
            design: sanitizeDesign(body.design, current.design),
          })
          sendJson(res, 200, settingsView(store, await getCatalog()))
          return
        }
        throw new HttpError(405, 'bad_request', '不支持的方法')
      }

      /**
       * 拉上游模型列表。
       *
       * 两种用法：`{ provider }` 拉某个已配置预设的（用服务端的 Key），
       * 或 `{ baseUrl, apiKey }` 拉用户正在填的草稿（还不用保存）。
       * 拉不到不算错 —— 前端允许继续手填模型名。
       */
      if (pathname === '/api/settings/models' && method === 'POST') {
        const body = await readJson<{ baseUrl?: string; apiKey?: string; provider?: string }>(req)
        const current = store.getSettings()
        const named = body.provider && body.provider !== 'custom' ? (await getCatalog()).entries.find((entry) => entry.profile.id === body.provider) : undefined

        let target: { baseUrl: string; apiKey: string; headers?: Record<string, string>; authHeader?: string; source: string }
        if (named) {
          if (!named.ready) throw new HttpError(412, 'provider_unavailable', `「${named.profile.label}」还没有 Key，先填 Key 再拉列表`)
          target = {
            baseUrl: named.profile.baseUrl,
            apiKey: named.apiKey,
            headers: named.profile.headers,
            authHeader: named.profile.authHeader,
            source: named.profile.label,
          }
        } else {
          const rawBase = (body.baseUrl ?? current.baseUrl).trim()
          if (!rawBase) throw new HttpError(400, 'bad_request', '先填 Base URL')
          const guard = validateBaseUrl(rawBase)
          if (!guard.ok) throw new HttpError(400, 'bad_request', guard.reason)
          target = {
            baseUrl: guard.url,
            apiKey: (body.apiKey ?? current.apiKey).trim(),
            source: '自定义通道',
          }
        }

        try {
          const models = await listModels(target)
          sendJson(res, 200, { models, source: target.source })
        } catch (error) {
          const code = error instanceof LlmError ? error.code : 'internal'
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 502, { error: code, message })
        }
        return
      }

      if (pathname === '/api/settings/test' && method === 'POST') {
        /**
         * 支持直接测「还没保存的草稿」。
         *
         * 没有草稿（body 为空）时测当前解析链的第一家 —— 也就是"现在点生成会打给谁"。
         */
        const body = await readJson<{ baseUrl?: string; model?: string; apiKey?: string }>(req)
        const current = store.getSettings()
        const wantsDraft = Boolean(body.baseUrl?.trim() || body.model?.trim() || body.apiKey?.trim())

        let target: {
          baseUrl: string
          apiKey: string
          model: string
          label: string
          headers?: Record<string, string>
          authHeader?: string
        }
        if (wantsDraft) {
          const guard = validateBaseUrl((body.baseUrl ?? current.baseUrl).trim())
          if (!guard.ok) throw new HttpError(400, 'bad_request', guard.reason)
          const model = (body.model ?? current.model).trim()
          if (!model) throw new HttpError(400, 'bad_request', '模型名不能为空')
          target = {
            baseUrl: guard.url,
            model,
            apiKey: (body.apiKey ?? current.apiKey).trim(),
            label: '我的 Key',
          }
        } else {
          const chain = resolveChain(await getCatalog(), storeSettingsUser(store))
          const first = chain[0]
          if (!first) throw new HttpError(412, 'provider_unavailable', '没有可测的模型通道：先选一个已就绪的预设，或填自己的 Key')
          target = {
            baseUrl: first.profile.baseUrl,
            model: first.profile.model,
            apiKey: first.apiKey,
            label: first.profile.id,
            headers: first.profile.headers,
            authHeader: first.profile.authHeader,
          }
        }

        try {
          const result = await testConnection({
            baseUrl: target.baseUrl,
            apiKey: target.apiKey,
            model: target.model,
            maxTokens: 32,
            temperature: 0,
            headers: target.headers,
            authHeader: target.authHeader,
          })
          sendJson(res, 200, {
            ok: true,
            ms: result.ms,
            sample: result.sample,
            model: target.model,
            provider: target.label,
          })
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
          if (method === 'GET' || method === 'HEAD') {
            const visitor = String(req.headers['x-visitor'] ?? '').slice(0, 40)
            const onlyMine = url.searchParams.get('mine') === '1'
            sendJson(res, 200, { projects: store.listProjects(onlyMine ? visitor : undefined) })
            return
          }
          if (method === 'POST') {
            const body = await readJson<{ prompt?: string; provider?: string; design?: Partial<DesignPrefs> }>(req)
            const prompt = (body.prompt ?? '').trim().slice(0, PROMPT_MAX_LENGTH)
            const settings = store.getSettings()
            const chain = resolveChain(await getCatalog(), {
              ...storeSettingsUser(store),
              provider: body.provider || settings.provider || undefined,
            })
            const active = activeOf(chain)
            const project = await store.createProject({
              prompt,
              design: sanitizeDesign(body.design, settings.design),
              createdBy: String(req.headers['x-visitor'] ?? 'anonymous').slice(0, 40),
              provider: active?.id ?? '',
              providerLabel: active?.label ?? '',
              providerModel: active?.model ?? '',
            })
            sendJson(res, 201, { project, previewHtml: '', checks: [] })
            return
          }
          throw new HttpError(405, 'bad_request', '不支持的方法')
        }

        if (action === 'generate' && method === 'POST') {
          await handleGenerate(req, res, store, id, await getCatalog())
          return
        }
        if (action === 'export' && (method === 'GET' || method === 'HEAD')) {
          await handleExport(res, store, id, method === 'HEAD')
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

        if (method === 'GET' || method === 'HEAD') {
          const detail = store.detail(id)
          if (!detail) throw new HttpError(404, 'not_found', '项目不存在')
          const preview = previewOf(detail.project.files, detail.project.tweak)
          sendJson(res, 200, { ...detail, previewHtml: preview.html })
          return
        }
        if (method === 'PATCH') {
          const body = await readJson<{ name?: string; summary?: string; tweak?: DesignTweak | null }>(req)
          const project = await store.updateProject(id, {
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
        if (method === 'DELETE') {
          const removed = await store.deleteProject(id)
          if (!removed) throw new HttpError(404, 'not_found', '项目不存在')
          sendJson(res, 200, { ok: true })
          return
        }
        throw new HttpError(405, 'bad_request', '不支持的方法')
      }

      if (segments[0] === 'api' && segments[1] === 'share' && segments[2]) {
        if (!READ_METHODS.has(method)) throw new HttpError(405, 'bad_request', '不支持的方法')
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
            provider: project.provider,
            providerLabel: project.providerLabel,
            providerModel: project.providerModel,
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

      // 任何没匹配到的 /api/* 一律用 JSON 回：绝不能掉进静态回退，
      // 否则 DELETE /api/health 这类错误方法会拿到 200 + index.html，让调用方以为成功。
      if (segments[0] === 'api') {
        throw new HttpError(method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 404 : 405, 'bad_request', '接口不存在或不支持该方法')
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

/** 存储里的设置 → 解析链需要的"访客自带上游"。 */
function userFromSettings(settings: StoredSettings) {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    provider: settings.provider,
    modelOverride: settings.modelOverride,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
  }
}

function storeSettingsUser(store: Store) {
  return userFromSettings(store.getSettings())
}

/**
 * 启动入口在 server/main.ts —— 这个模块**只导出工厂函数，导入即启动**是
 * 一类难查的副作用：脚本和测试只要 import { createNucleusServer } 就会
 * 顺带占掉 8787 端口（真踩过：EADDRINUSE 出现在完全无关的调用栈里）。
 */
