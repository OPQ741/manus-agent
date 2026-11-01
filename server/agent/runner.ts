/**
 * Agent 编排：plan → write → verify。
 *
 * 输出只有一种东西：AgentEvent 流。它不知道 HTTP，不知道数据库，
 * 因此可以被任何传输层复用（SSE / 测试 / 未来的 WebSocket）。
 */

import type { AgentEvent, Check, DesignPrefs, EngineId, FileEntry, Plan, Usage } from '../../shared/types'
import { assemble } from '../preview/assemble'
import { compose, extractSlots, planFor, type Slots } from './composer'
import { LlmError, streamChat, type LlmConfig } from './llm'
import { editTurnMessages, firstTurnMessages } from './prompts'
import { ProtocolParser } from './protocol'

export interface GenContext {
  prompt: string
  design: DesignPrefs
  engine: EngineId
  files: FileEntry[]
  plan: Plan | null
  llm?: LlmConfig
  signal?: AbortSignal
}

/** 生成结束后的产物，交给路由层持久化。 */
export interface GenSink {
  files: Map<string, string>
  plan: Plan | null
  checks: Check[]
  warnings: string[]
  raw: string
  usage: Usage
}

export interface AgentEngine {
  id: EngineId
  plan(ctx: GenContext): Promise<Plan>
  write(ctx: GenContext, plan: Plan): AsyncIterable<string>
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 本地引擎：确定性编译 + 人为分块（让上层只有一条流式链路）。 */
export class LocalEngine implements AgentEngine {
  readonly id = 'local' as const

  async plan(ctx: GenContext): Promise<Plan> {
    return planFor(extractSlots(ctx.prompt, ctx.design))
  }

  async *write(ctx: GenContext, _plan: Plan): AsyncGenerator<string> {
    const { text } = compose(ctx.prompt, ctx.design, ctx.files)
    for (const chunk of chunkText(text, 720)) {
      if (ctx.signal?.aborted) return
      yield chunk
      await sleep(55)
    }
  }
}

/** 云模型引擎：把 LLM 的增量原样上抛，协议解析留给上层。 */
export class CloudEngine implements AgentEngine {
  readonly id = 'cloud' as const
  private readonly config: LlmConfig

  constructor(config: LlmConfig) {
    this.config = config
  }

  async plan(ctx: GenContext): Promise<Plan> {
    const slots: Slots = extractSlots(ctx.prompt, ctx.design)
    // 先给一张"占位方案"，模型真正的 plan 会在流里覆盖它，用户不必等首字节。
    return {
      name: slots.name || '新应用',
      summary: ctx.prompt.slice(0, 60),
      stack: 'HTML + CSS + JavaScript（模型生成）',
      steps: ['理解需求', '生成结构、样式与逻辑', '静态自检'],
      files: [],
    }
  }

  async *write(ctx: GenContext, _plan: Plan): AsyncGenerator<string> {
    const messages =
      ctx.files.length > 0
        ? editTurnMessages(ctx.prompt, ctx.design, ctx.files, ctx.plan)
        : firstTurnMessages(ctx.prompt, ctx.design)

    for await (const delta of streamChat(this.config, messages, { signal: ctx.signal })) {
      yield delta
    }
  }
}

export function createEngine(engine: EngineId, ctx: GenContext): AgentEngine {
  if (engine === 'cloud') {
    if (!ctx.llm) throw new LlmError('engine_unconfigured', '云模型未配置，请到设置里填写模型地址与 Key')
    return new CloudEngine(ctx.llm)
  }
  return new LocalEngine()
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

  yield { type: 'stage', stage: 'plan', status: 'running' }
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

  yield { type: 'stage', stage: 'write', status: 'running' }

  const parser = new ProtocolParser()
  const files = sink.files
  const applyEvent = (event: AgentEvent) => {
    if (event.type === 'file_end') {
      files.set(event.path, event.content)
    } else if (event.type === 'delete') {
      files.delete(event.path)
    } else if (event.type === 'plan') {
      sink.plan = event.plan
      plan = event.plan
    } else if (event.type === 'warning') {
      sink.warnings.push(event.message)
    }
  }

  try {
    for await (const chunk of engine.write(ctx, plan)) {
      sink.raw += chunk
      if (ctx.signal?.aborted) break
      const events = parser.push(chunk)
      for (const event of events) {
        applyEvent(event)
        yield event
      }
    }
    for (const event of parser.end()) {
      applyEvent(event)
      yield event
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
  for (const check of result.checks) {
    yield { type: 'check', check }
  }
  yield { type: 'stage', stage: 'verify', status: 'done' }

  const usage: Usage = {
    ms: Date.now() - started,
    engine: engine.id,
    chars: sink.raw.length,
  }
  sink.usage = usage
  yield { type: 'done', version: 0, usage }
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
    plan,
    checks: [],
    warnings: [],
    raw: '',
    usage: { ms: 0, engine: 'local', chars: 0 },
  }
}
