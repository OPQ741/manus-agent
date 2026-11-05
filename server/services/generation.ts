/**
 * 生成编排：解析链故障转移 → 排队 → 修复轮 → 中断保留 → 落库。
 *
 * 这是整个服务最重的一段业务，也是**框架一行都省不掉**的那部分：
 * 它管的是"一家失败换下一家""修两轮还不行就保留能用的""用户按停止时只留写完的文件"，
 * 跟 HTTP 用什么库无关。所以从入口文件里搬出来单独放，路由层只负责适配请求。
 *
 * 事件流的出口是 GenSink → SSE；这里不认识 HTTP 细节，只认识 sse.send。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentEvent, ApiErrorCode, FileEntry, GenerateRequest, StopMode } from '../../shared/types'
import { PROMPT_MAX_LENGTH } from '../../shared/types'
import { QueueFullError, projectedWait, waitForSlot } from '../agent/queue'
import { projectContext } from '../agent/history'
import { resolveChain, type ResolvedCatalog, type ResolvedProvider } from '../agent/providers'
import { canFailover, createSink, runGeneration, ModelEngine, type GenContext, type GenSink } from '../agent/runner'
import { HttpError } from '../http/errors'
import { readJson } from '../http/respond'
import { openSse } from '../http/sse'
import type { Store } from '../store/store'
import { activeOf, userFromSettings } from './settings-view'

/** 排队上限：超过就换下一家，而不是让人对着转圈等两分钟。 */
const MAX_QUEUE_WAIT_MS = Number(process.env.NUCLEUS_MAX_QUEUE_WAIT ?? 90_000)
/** 一轮生成最多修几次：每次都是真实的上游请求，不能为了追一个顽固模型把访客钉在转圈上。 */
const MAX_REPAIR_PASSES = Number(process.env.NUCLEUS_MAX_REPAIR_PASSES ?? 2)
/** 超过这个等待就提前告诉用户"前面在排队"。 */
const QUEUE_NOTICE_MS = 1_000

/**
 * 正在进行的生成：项目 id → 句柄。
 *
 * 句柄里除了 AbortController 还要带一个 `mode`：`/stop` 是另一个请求，
 * 它得在**中断发生之前**把「要保留还是要丢弃」写进来 —— 等 commit 时再查 Map
 * 是行不通的（那时 finally 已经把条目删了）。
 */
interface RunHandle {
  controller: AbortController
  mode: StopMode
}

const running = new Map<string, RunHandle>()

/**
 * POST /api/projects/:id/stop 的唯一入口：有在跑的才中断，没有就是 409。
 *
 * 默认 keep（保留已写完的文件）：老客户端不带 mode，行为必须和以前一致。
 */
export function abortGeneration(projectId: string, mode: StopMode = 'keep'): boolean {
  const handle = running.get(projectId)
  if (!handle) return false
  handle.mode = mode
  handle.controller.abort()
  return true
}

/** 这个项目此刻是不是正在生成：手动改文件要据此拒绝，否则改完立刻被模型覆盖。 */
export function isGenerating(projectId: string): boolean {
  return running.has(projectId)
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
    // 而不是一红条 + 一份成功产物。终态由 handleGeneration 决定要不要发 error。
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

export async function handleGeneration(
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
  /** 客户端断开走这条回调：没人收结果了，默认按「保留已写完的文件」处理 */
  const handle: RunHandle = { controller, mode: 'keep' }
  // 客户端断开 → 中断上游；继续写会 ERR_STREAM_DESTROYED，交给 SseChannel 兜住
  const sse = openSse(res, () => controller.abort())
  const send = sse.send

  running.set(projectId, handle)
  /**
   * 上下文必须在写入本轮用户消息**之前**取：否则 history 里会多出刚刚这句，
   * 与正文重复一遍，模型会以为"用户连着说了两次同样的话"。
   */
  const before = store.detail(projectId)
  const history = projectContext({
    messages: before?.messages ?? [],
    versions: before?.versions ?? [],
    plan: project.plan,
    design: project.design,
    prompt,
  })
  await store.appendMessage({ projectId, role: 'user', kind: 'text', content: prompt })

  const base = {
    prompt,
    design: project.design,
    files: project.files,
    plan: project.plan,
    history,
    repair: undefined as GenContext['repair'],
  }

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
      /**
       * prompt 必须落库：错误条上的「重新生成」要用**失败的那条指令**重试，
       * 而它以前只活在前端的 useRef 里 —— 刷新一次就丢，重试只能拿输入框的草稿。
       */
      meta: { code: failed.code, tried, prompt },
    })
    sse.end()
    return
  }

  /**
   * 放弃本轮：不 commit、不改版本，只在历史里留一条"我丢掉了这一轮"。
   *
   * 和「停止并保留」的区别只在 commit 这一步 —— 上游该中断的已经中断了，
   * 所以这里不需要再碰 controller，直接返回即可。
   */
  if (aborted && handle.mode === 'discard') {
    await store.appendMessage({
      projectId,
      role: 'agent',
      kind: 'notice',
      content: `已放弃本轮生成，项目仍停留在 v${project.version}，没有改动任何文件。`,
      meta: { discarded: true, written: sink.completed.size },
    })
    if (!sse.gone) {
      send({ type: 'done', version: project.version, usage: sink.usage, partial: true, kept: 0, discarded: true })
    }
    sse.end()
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
    // 也要留一条记录：否则这一轮只剩用户那句话挂在那里，像发出去就没了
    await store.appendMessage({
      projectId,
      role: 'agent',
      kind: 'notice',
      content: `已停止：这一轮还没有任何文件写完，项目保持 v${project.version} 不变。`,
      meta: { stopped: true, kept: 0 },
    })
    if (!sse.gone) {
      send({ type: 'done', version: project.version, usage: sink.usage, partial: true, kept: 0 })
      sse.end()
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
    if (!sse.gone) {
      send({ type: 'error', code: 'not_found', message: '项目在生成过程中被删除了' })
      sse.end()
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

  if (sse.gone) {
    sse.end()
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
  sse.end()
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

