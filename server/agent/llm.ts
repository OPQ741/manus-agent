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
}

export class LlmError extends Error {
  readonly code: ApiErrorCode
  readonly status?: number

  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
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
      reject(new LlmError('llm_timeout', `模型响应超时（${Math.round(ms / 1000)}s 无数据）`))
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
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            stream: true,
            temperature: options.temperature ?? 0.6,
          }),
          signal: controller.signal,
        }),
        firstByteTimeout,
        () => controller.abort(),
      )
    } catch (error) {
      if (error instanceof LlmError) throw error
      if ((error as Error).name === 'AbortError') {
        throw new LlmError('llm_timeout', '请求被中止或超时')
      }
      throw new LlmError('llm_network', '无法连接模型服务：' + ((error as Error).message ?? '网络错误'))
    }

    if (!res.ok || !res.body) {
      const detail = await readError(res)
      throw new LlmError(mapStatus(res.status), `模型拒绝请求（${res.status}）：${detail}`, res.status)
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
        if (error instanceof LlmError) throw new LlmError(error.code, '模型连接中断：' + error.message)
        if (closed) throw new LlmError('llm_timeout', '模型连接中断')
        throw new LlmError('llm_network', '读取模型输出失败')
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
