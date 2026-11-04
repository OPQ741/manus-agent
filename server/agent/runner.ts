/**
 * Agent 编排：plan → write → verify。
 *
 * 输出只有一种东西：AgentEvent 流。它不知道 HTTP，不知道数据库，
 * 因此可以被任何传输层复用（SSE / 测试 / 未来的 WebSocket）。
 *
 * 这里**没有**第二条生成路径：以前有个 LocalEngine（写死七类配方的本地编译器），
 * 它会让"没配 Key 也能生成"变成假的 —— 用户以为在调模型，其实在跑模板。
 * 现在唯一的引擎是 ModelEngine，它必须打到一个真实模型上，打不到就直接报错。
 */

import type {
  AgentEvent,
  ApiErrorCode,
  Check,
  DesignPrefs,
  FileEntry,
  Plan,
  ProviderId,
  ProviderInfo,
  Usage,
} from '../../shared/types'
import { assemble } from '../../shared/preview/assemble'
import { LlmError, streamChat, type LlmConfig } from './llm'
import type { ResolvedProvider } from './providers'
import { editTurnMessages, firstTurnMessages, repairMessages } from './prompts'
import { ProtocolParser } from './protocol'

export interface GenContext {
  prompt: string
  design: DesignPrefs
  files: FileEntry[]
  plan: Plan | null
  signal?: AbortSignal
  /**
   * 修复轮：非空时本轮**只**重新输出这些文件（其余保持不动），
   * reason 会原样告诉模型上一次是哪里不对（没输出 / 被截断 / 语法不通）。
   * 由编排层在 assemble 之后设置。
   */
  repair?: { path: string; reason: string }[]
}

/** 生成结束后的产物，交给路由层持久化。 */
export interface GenSink {
  files: Map<string, string>
  /** 本轮真正写完（收到正常闭合的 file_end）的路径。用于「中断保留」时区分新旧内容。 */
  completed: Set<string>
  /** 本轮被显式删除的路径。 */
  deleted: Set<string>
  plan: Plan | null
  checks: Check[]
  warnings: string[]
  /** assemble 发现"被引用但没生成"的文件：驱动修复轮（见 index.ts 的 repair pass）。 */
  missing: string[]
  /** assemble 发现语法就不通的脚本：同样进修复轮。 */
  broken: string[]
  /** 闭合标签没等到、写到一半就断的文件：内容不可信，必须重出。 */
  truncated: Set<string>
  raw: string
  usage: Usage
}

export interface AgentEngine {
  readonly id: ProviderId
  readonly info: ProviderInfo
  plan(ctx: GenContext): Promise<Plan>
  write(ctx: GenContext): AsyncIterable<string>
}

/**
 * 占位方案：模型自己的 plan 会在流里覆盖它。
 *
 * 名字从 prompt 里捞（引号内的应用名优先），捞不到就用需求开头 ——
 * 这一步不调模型，纯粹是为了让用户在首字节之前就看到"它在做什么"。
 */
export function placeholderPlan(prompt: string): Plan {
  const quoted = /(?:叫|名为|名称是|名字叫)\s*[「"'“]([^」"'”]{1,16})[」"'”]/.exec(prompt)?.[1]
  const name = quoted?.trim() || prompt.replace(/\s+/g, ' ').trim().slice(0, 12) || '新应用'
  return {
    name,
    summary: prompt.trim().slice(0, 60),
    stack: '由模型决定的 HTML / CSS / JavaScript',
    steps: ['理解需求', '生成结构、样式与逻辑', '静态自检'],
    files: [],
  }
}

/** 真实模型引擎：把上游的增量原样上抛，协议解析留给上层。 */
export class ModelEngine implements AgentEngine {
  readonly id: ProviderId
  readonly info: ProviderInfo
  private readonly config: LlmConfig
  /** 上游回报的 token 用量（部分兼容服务在最后一帧带 usage）。 */
  private lastUsage: { tokens?: number } | null = null
  private readonly onUsage = (usage: { tokens?: number }) => {
    this.lastUsage = { tokens: usage.tokens }
  }

  constructor(provider: ResolvedProvider) {
    this.id = provider.profile.id
    this.info = { id: provider.profile.id, label: provider.profile.label, model: provider.profile.model, free: Boolean(provider.profile.free) }
    this.config = {
      baseUrl: provider.profile.baseUrl,
      apiKey: provider.apiKey,
      model: provider.profile.model,
      maxTokens: provider.profile.maxTokens,
      temperature: provider.profile.temperature,
      reasoningEffort: provider.profile.reasoningEffort,
      headers: provider.profile.headers,
      authHeader: provider.profile.authHeader,
    }
  }

  get usage(): { tokens?: number } | null {
    return this.lastUsage
  }

  async plan(ctx: GenContext): Promise<Plan> {
    return placeholderPlan(ctx.prompt)
  }

  async *write(ctx: GenContext): AsyncGenerator<string> {
    if (ctx.repair?.length) {
      for await (const delta of streamChat(this.config, repairMessages(ctx.prompt, ctx.design, ctx.files, ctx.repair, ctx.plan), {
        signal: ctx.signal,
        onUsage: this.onUsage,
      })) {
        yield delta
      }
      return
    }

    const messages =
      ctx.files.length > 0
        ? editTurnMessages(ctx.prompt, ctx.design, ctx.files, ctx.plan)
        : firstTurnMessages(ctx.prompt, ctx.design)

    for await (const delta of streamChat(this.config, messages, { signal: ctx.signal, onUsage: this.onUsage })) {
      yield delta
    }
  }
}

/**
 * 跑一次生成。所有事件即时 yield；产物写入 sink 供调用方持久化。
 * 任何内部错误都被翻译成 error 事件 —— 调用方永远只处理事件，不处理异常。
 */
export async function* runGeneration(
  ctx: GenContext,
  engine: AgentEngine,
  sink: GenSink,
): AsyncGenerator<AgentEvent> {
  const started = Date.now()
  const isRepair = Boolean(ctx.repair?.length)
  /**
   * 已有文件 = 增量编辑轮（"把主色换成墨绿""加一个导出按钮"）。
   *
   * 编辑轮同样不该重发方案：占位方案的名字是从这句指令里截出来的，
   * 一句"把主色换成墨绿"会当场把应用名改成"把主色换成墨绿"，
   * 并且通过 plan 事件闪现在对话流里当作"本轮方案"。
   * 方案由首轮定稿，编辑轮沿用 ctx.plan（commit 时也不会再用它改名）。
   */
  const isEdit = !isRepair && ctx.files.length > 0

  yield { type: 'stage', stage: 'plan', status: 'running' }
  if (isRepair || isEdit) {
    // 修复轮不重发方案：否则占位方案会把已经定稿的应用名覆盖成"修复 app.js…"
    sink.plan = ctx.plan
    yield { type: 'stage', stage: 'plan', status: 'done' }
  } else {
    let plan: Plan
    try {
      plan = await engine.plan(ctx)
    } catch (error) {
      yield toErrorEvent(error)
      return
    }
    sink.plan = plan
    yield { type: 'plan', plan }
    yield { type: 'stage', stage: 'plan', status: 'done' }
  }

  yield { type: 'stage', stage: 'write', status: 'running' }

  const parser = new ProtocolParser()
  const files = sink.files
  /**
   * 编辑轮的方案不推给界面。
   *
   * 这一轮模型仍可能照协议输出 <plan>，但它的 name 往往是从指令里截的
   * （"把主色换成墨绿"），summary 就是这句指令本身。推上去的结果是一张
   * 写着新应用名的方案卡 —— 用户可以合理地理解为"我的项目被改名了"。
   * 方案只在首轮定稿；编辑轮只关心它改了哪些文件。
   */
  const visible = (event: AgentEvent) => !(isEdit && event.type === 'plan')
  const applyEvent = (event: AgentEvent) => {
    if (event.type === 'file_end') {
      files.set(event.path, event.content)
      // 只有"正常闭合"的文件才算写完；被截断的（流断了/模型忘了闭合）
      // 在中断保留时要回退到旧版本，不能当成完整产物。
      if (!event.truncated) {
        sink.completed.add(event.path)
        sink.truncated.delete(event.path)
      } else {
        sink.completed.delete(event.path)
        sink.truncated.add(event.path)
      }
    } else if (event.type === 'delete') {
      files.delete(event.path)
      sink.completed.delete(event.path)
      sink.deleted.add(event.path)
    } else if (event.type === 'plan') {
      // 模型自己输出的方案优先级最高（它会覆盖占位方案）
      sink.plan = event.plan
    } else if (event.type === 'warning') {
      sink.warnings.push(event.message)
    }
  }

  try {
    for await (const chunk of engine.write(ctx)) {
      sink.raw += chunk
      if (ctx.signal?.aborted) break
      const events = parser.push(chunk)
      for (const event of events) {
        applyEvent(event)
        if (visible(event)) yield event
      }
    }
    for (const event of parser.end()) {
      applyEvent(event)
      if (visible(event)) yield event
    }
  } catch (error) {
    yield toErrorEvent(error)
    return
  }

  yield { type: 'stage', stage: 'write', status: 'done' }

  if (files.size === 0) {
    const hint = sink.raw.trim().slice(0, 180).replace(/\s+/g, ' ')
    yield {
      type: 'error',
      code: 'protocol_error',
      message: `模型没有按协议输出任何文件${hint ? `。原文开头：${hint}` : ''}`,
    }
    return
  }

  yield { type: 'stage', stage: 'verify', status: 'running' }
  const fileList: FileEntry[] = [...files.entries()].map(([path, content]) => ({
    path,
    content,
    updatedAt: Date.now(),
  }))
  const result = assemble(fileList)
  sink.checks = result.checks
  sink.missing = result.missing
  sink.broken = result.broken
  for (const check of result.checks) {
    yield { type: 'check', check }
  }
  yield { type: 'stage', stage: 'verify', status: 'done' }

  const usage: Usage = {
    ms: Date.now() - started,
    provider: engine.id,
    chars: sink.raw.length,
  }
  // 上游若回报了 usage，就带上真实 token；带不到就留空，界面按字符数展示（不编造数字）。
  const reported = (engine as { usage?: { tokens?: number } | null }).usage
  if (reported?.tokens) usage.tokens = reported.tokens
  sink.usage = usage
  yield { type: 'done', version: 0, usage, provider: engine.info }
}

/**
 * 哪些错误值得换一家模型再试。
 *
 * 判据有两条，缺一不可：
 *  - 错误码属于"这家不行"（鉴权 / 限流 / 网络 / 超时 / 没按协议出码），
 *    而不是"这次请求本身有问题"（internal）；
 *  - 还没有任何产出（raw 为空且没写完文件）—— 已经吐了一半再换家，
 *    用户会看到两份互相覆盖的代码，比直接失败更糟。
 *
 * 注意 llm_auth 也在里面：访客自己的 Key 填错时，退回免 Key 通道比硬失败友好得多，
 * 而编排层会先发一条 notice 说明"这家不行、换下一家"，不会让人误以为 Key 是好的。
 */
const FAILOVER_CODES = new Set<ApiErrorCode>([
  'llm_auth',
  'llm_quota',
  'llm_timeout',
  'llm_network',
  'protocol_error',
])

export function canFailover(code: ApiErrorCode | undefined, sink: GenSink): boolean {
  if (!code || !FAILOVER_CODES.has(code)) return false
  return sink.raw.length === 0 && sink.completed.size === 0
}

export function toErrorEvent(error: unknown): AgentEvent {
  if (error instanceof LlmError) {
    return { type: 'error', code: error.code, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { type: 'error', code: 'internal', message: message.slice(0, 300) }
}

export function createSink(files: FileEntry[], plan: Plan | null): GenSink {
  return {
    files: new Map(files.map((file) => [file.path, file.content])),
    completed: new Set(),
    deleted: new Set(),
    plan,
    checks: [],
    warnings: [],
    missing: [],
    broken: [],
    truncated: new Set<string>(),
    raw: '',
    usage: { ms: 0, provider: '', chars: 0 },
  }
}
