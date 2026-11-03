/**
 * OpenAI 兼容的流式客户端。
 *
 * 只做三件事：发请求、把 SSE 解成文本增量、把各种失败映射成平台自己的错误码。
 * 协议解析不在这里 —— 那是 protocol.ts 的职责，两层分开才能各自单测。
 */

import type { ApiErrorCode } from '../../shared/types'
import type { ChatMessage } from './prompts'

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /**
   * 输出上限。必须由调用方显式给：
   * 实测 Pollinations 匿名档默认只给 1500 completion tokens（含思考链），
   * 不传这个字段时一个四文件应用会被从中间截断。
   */
  maxTokens?: number
  temperature?: number
  /**
   * 推理强度（gpt-oss / R1 这类思考型模型）。
   *
   * 为什么重要：思考链和正文共用同一个输出预算，默认强度下模型常常"想完了但没写完"，
   * 表现为文件写到一半被截断（实测 Pollinations 匿名档就这样）。
   * 调低强度把 token 让给正文。不支持该参数的上游会忽略或报 400，所以它是可选的。
   */
  reasoningEffort?: 'high' | 'medium' | 'low'
  /** 部分网关要求署名头（OpenRouter 的 http-referer / x-title） */
  headers?: Record<string, string>
  /**
   * 额外的鉴权头：Key 以裸值放进这个头，同时保留标准的 Bearer 头。
   *
   * 小红书 Dots 官方只认 `api-key: <key>`，标准 Bearer 形式它也接受，
   * 但接口文档明确写的是前者 —— 双发两头就不用赌上游认哪种。
   */
  authHeader?: string
}

/**
 * 组装请求头。
 *
 * 抽出来是因为三处要用（发消息 / 拉模型列表 / 连通性测试），
 * 而认证头的差异正是最容易在某一处漏掉的地方。
 *
 * 导出是为了能直接单测：认证头错一个字符，症状是上游 401，
 * 而 401 在整条链上表现为"这家不行"——排查起来绕远路。
 */
export function buildHeaders(config: {
  apiKey?: string
  headers?: Record<string, string>
  authHeader?: string
}): Record<string, string> {
  const key = config.apiKey || 'anonymous'
  const result: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  }
  // 额外的裸 Key 头：值就是 Key 本身，不带前缀
  if (config.authHeader) result[config.authHeader] = key
  // 用户自定义头放最后：允许覆盖上面任何一项（比如网关要求改 Authorization 前缀）
  return { ...result, ...(config.headers ?? {}) }
}

/** 错误分类：能不能换一家重试，由这一层判断，编排层不必认识 HTTP 状态码。 */
export class LlmError extends Error {
  readonly code: ApiErrorCode
  readonly status?: number
  /** true = 换个提供方或等一会儿再试有可能成功（限流、网络、上游 5xx）。 */
  readonly retryable: boolean
  /** 上游要求我们等待多久（秒），来自 Retry-After。 */
  readonly retryAfterMs?: number

  constructor(
    code: ApiErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = options.status
    this.retryable = options.retryable ?? false
    this.retryAfterMs = options.retryAfterMs
  }
}

const BLOCKED_HOSTS = /^(localhost|127\.|10\.|0\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|\[::1\])/i

/** SSRF 防护：只允许公网 http(s)，禁止内网与本机。 */
export function validateBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: '地址格式不正确，需要是 http(s):// 开头的完整地址' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http/https' }
  }
  // 测试钩子：集成测试需要对本机假上游发起请求，默认关闭
  const allowLocal = process.env.NUCLEUS_ALLOW_LOCAL_LLM === '1'
  if (!allowLocal && BLOCKED_HOSTS.test(url.hostname)) {
    return { ok: false, reason: '出于安全考虑，不允许指向内网或本机地址' }
  }
  return { ok: true, url: url.toString().replace(/\/+$/, '') }
}

function mapStatus(status: number): ApiErrorCode {
  if (status === 401 || status === 403) return 'llm_auth'
  if (status === 429 || status === 402) return 'llm_quota'
  return 'llm_network'
}

/** Retry-After 支持「秒数」和「HTTP 日期」两种写法。 */
function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 120_000))
  const date = Date.parse(raw)
  if (!Number.isFinite(date)) return undefined
  return Math.max(0, Math.min(date - Date.now(), 120_000))
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text()
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    return parsed.error?.message ?? text.slice(0, 200)
  } catch {
    return '上游未返回可读的错误信息'
  }
}

function withIdleTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new LlmError('llm_timeout', `模型响应超时（${Math.round(ms / 1000)}s 无数据）`, { retryable: true }))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

export interface StreamOptions {
  signal?: AbortSignal
  temperature?: number
  /** 首字节超时（默认 30s），之后每次读到数据都会重置空闲超时（默认 60s）。 */
  firstByteTimeoutMs?: number
  idleTimeoutMs?: number
  onUsage?: (usage: { tokens?: number }) => void
}

/** 逐段产出模型输出文本。调用方负责拼接，然后交给协议解析器。 */
export async function* streamChat(
  config: LlmConfig,
  messages: ChatMessage[],
  options: StreamOptions = {},
): AsyncGenerator<string> {
  const guard = validateBaseUrl(config.baseUrl)
  if (!guard.ok) throw new LlmError('llm_network', guard.reason)

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  const firstByteTimeout = options.firstByteTimeoutMs ?? 30000
  const idleTimeout = options.idleTimeoutMs ?? 60000
  let closed = false
  const abort = () => {
    closed = true
    controller.abort()
  }

  try {
    let res: Response
    try {
        res = await withIdleTimeout(
          fetch(`${guard.url}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(config),
            body: JSON.stringify({
            model: config.model,
            messages,
            stream: true,
            temperature: options.temperature ?? config.temperature ?? 0.6,
            ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
            ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
          }),
          signal: controller.signal,
        }),
        firstByteTimeout,
        () => controller.abort(),
      )
    } catch (error) {
      if (error instanceof LlmError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new LlmError('llm_timeout', '请求被中止或超时', { retryable: !options.signal?.aborted })
      }
      throw new LlmError('llm_network', '无法连接模型服务：' + ((error as Error).message ?? '网络错误'), {
        retryable: true,
      })
    }

    if (!res.ok || !res.body) {
      const detail = await readError(res)
      throw new LlmError(mapStatus(res.status), `模型拒绝请求（${res.status}）：${detail}`, {
        status: res.status,
        // 401/403 换一家也没用（Key 问题）；429/402/5xx/网络类值得换一家或等一下
        retryable: res.status !== 401 && res.status !== 403 && res.status !== 404,
        retryAfterMs: res.status === 429 ? parseRetryAfter(res) : undefined,
      })
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let finished = false

    while (!finished) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await withIdleTimeout(reader.read(), idleTimeout, abort)
      } catch (error) {
        if (error instanceof LlmError) throw new LlmError(error.code, '模型连接中断：' + error.message, { retryable: true })
        if (closed) throw new LlmError('llm_timeout', '模型连接中断', { retryable: true })
        throw new LlmError('llm_network', '读取模型输出失败', { retryable: true })
      }
      if (chunk.done) break

      buffer += decoder.decode(chunk.value, { stream: true })
      let lineBreak: number
      while ((lineBreak = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, lineBreak).trim()
        buffer = buffer.slice(lineBreak + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          finished = true
          break
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string }; finish_reason?: string }[]
            usage?: { total_tokens?: number }
          }
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) yield delta
          if (parsed.usage?.total_tokens) options.onUsage?.({ tokens: parsed.usage.total_tokens })
        } catch {
          // 单个坏帧不应该中断整条流
        }
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    if (!closed) controller.abort()
  }
}

/** 设置页的「测试连接」：发一条最短请求，返回延迟与模型自报家门。 */
export async function testConnection(config: LlmConfig): Promise<{ ms: number; sample: string }> {
  const started = Date.now()
  let text = ''
  for await (const delta of streamChat(
    config,
    [
      { role: 'system', content: '你是一个连通性测试助手，只回复 OK。' },
      { role: 'user', content: 'ping' },
    ],
    { firstByteTimeoutMs: 12000, temperature: 0 },
  )) {
    text += delta
    if (text.length > 40) break
  }
  return { ms: Date.now() - started, sample: text.trim().slice(0, 40) }
}

/** 明显不是聊天补全的模型：列表里留着只会让人选错（选完生成必 400）。 */
const NON_CHAT = /(embed|rerank|whisper|tts|dall-e|moderation|image|speech|transcri|sd[-_]|stable-diffusion)/i

/**
 * 问上游「你有哪些模型」。
 *
 * 这是把"填一个模型名"变成"从列表里选一个"的唯一前提：模型名拼错是自定义接入
 * 最高频的失败原因，而且报错往往只有一句 400，用户根本不知道该改成什么。
 *
 * 只读 `GET {baseUrl}/models`（OpenAI 兼容规范），不猜任何厂商私有接口；
 * 拉不到不算致命 —— 界面仍然允许手填。
 */
export async function listModels(config: {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  authHeader?: string
  timeoutMs?: number
}): Promise<string[]> {
  const guard = validateBaseUrl(config.baseUrl)
  if (!guard.ok) throw new LlmError('llm_network', guard.reason)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 10_000)
  try {
    const res = await fetch(`${guard.url}/models`, {
      method: 'GET',
      headers: buildHeaders(config),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await readError(res)
      throw new LlmError(mapStatus(res.status), `拉取模型列表失败（${res.status}）：${detail}`, { status: res.status })
    }
    const body = (await res.json()) as unknown
    const rows = Array.isArray(body)
      ? body
      : ((body as { data?: unknown; models?: unknown })?.data ?? (body as { models?: unknown })?.models)
    const ids: string[] = []
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const id =
          typeof row === 'string'
            ? row
            : typeof (row as { id?: unknown })?.id === 'string'
              ? (row as { id: string }).id
              : typeof (row as { name?: unknown })?.name === 'string'
                ? (row as { name: string }).name
                : ''
        if (!id) continue
        if (NON_CHAT.test(id)) continue
        ids.push(id)
      }
    }
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 300)
  } catch (error) {
    if (error instanceof LlmError) throw error
    if ((error as Error).name === 'AbortError') {
      throw new LlmError('llm_timeout', '拉取模型列表超时（10s 无响应）', { retryable: true })
    }
    throw new LlmError('llm_network', '拉取模型列表失败：' + ((error as Error).message ?? '网络错误'), {
      retryable: true,
    })
  } finally {
    clearTimeout(timer)
  }
}
