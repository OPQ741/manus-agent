import type {
  AgentEvent,
  ApiErrorCode,
  DesignPrefs,
  DesignTweak,
  EngineId,
  Project,
  ProjectDetail,
  ProjectSummary,
  PublicSettings,
  ShareDetail,
  Version,
} from '../../shared/types'

export class ApiError extends Error {
  readonly code: ApiErrorCode | string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

const VISITOR_KEY = 'nucleus.visitor'

export function visitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_KEY)
    if (existing) return existing
    const created = Math.random().toString(36).slice(2, 10)
    localStorage.setItem(VISITOR_KEY, created)
    return created
  } catch {
    return 'anonymous'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-visitor': visitorId(),
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    let code = 'internal'
    let message = `请求失败（${res.status}）`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      code = body.error ?? code
      message = body.message ?? message
    } catch {
      /* 保留默认信息 */
    }
    throw new ApiError(res.status, code, message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** 项目列表缓存：30s 内复用，避免每次进首页都打一次接口（PRD §5.5）。 */
const LIST_TTL = 30_000
let listCache: { at: number; mine: boolean; data: ProjectSummary[] } | null = null

export const api = {
  listProjects: (mine = false, force = false) => {
    const now = Date.now()
    if (!force && listCache && listCache.mine === mine && now - listCache.at < LIST_TTL) {
      return Promise.resolve({ projects: listCache.data })
    }
    return request<{ projects: ProjectSummary[] }>(`/api/projects${mine ? '?mine=1' : ''}`).then((payload) => {
      listCache = { at: Date.now(), mine, data: payload.projects }
      return payload
    })
  },
  /** 让服务端中断当前生成；连接不关，中断后服务端会提交已完成的文件。 */
  stop: (id: string) => request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  createProject: (input: { prompt?: string; engine?: EngineId; design?: DesignPrefs }) =>
    request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) =>
    request<ProjectDetail & { previewHtml: string }>(`/api/projects/${encodeURIComponent(id)}`),
  renameProject: (id: string, name: string) =>
    request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** 保存设计微调；传 null 表示恢复默认。 */
  updateTweak: (id: string, tweak: DesignTweak | null) =>
    request<{ project: Project; previewHtml: string }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ tweak }),
    }),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  rollback: (id: string, seq: number) =>
    request<{ project: Project; version: Version }>(`/api/projects/${encodeURIComponent(id)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ seq }),
    }),
  getSettings: () => request<PublicSettings>('/api/settings'),
  saveSettings: (input: {
    engine?: EngineId
    baseUrl?: string
    model?: string
    apiKey?: string
    design?: Partial<DesignPrefs>
  }) => request<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(input) }),
  testConnection: () =>
    request<{ ok: boolean; ms: number; sample: string; model: string }>('/api/settings/test', {
      method: 'POST',
    }),
  share: (slug: string) => request<ShareDetail>(`/api/share/${encodeURIComponent(slug)}`),
  exportUrl: (id: string) => `/api/projects/${encodeURIComponent(id)}/export`,
  health: () => request<{ ok: boolean; engine: EngineId; version: string }>('/api/health'),
}

/**
 * 消费 SSE。服务端每帧一个 JSON 事件，这里只负责拼帧与回调，
 * 不解读语义 —— 语义全部在页面层的 reducer 里。
 */
export async function generate(
  projectId: string,
  prompt: string,
  engine: EngineId | undefined,
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-visitor': visitorId() },
    body: JSON.stringify({ prompt, engine }),
    signal,
  })

  if (!res.ok || !res.body) {
    let code = 'internal'
    let message = `生成失败（${res.status}）`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      code = body.error ?? code
      message = body.message ?? message
    } catch {
      /* 保留默认信息 */
    }
    throw new ApiError(res.status, code, message)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const flushBlock = (block: string) => {
    for (const line of block.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      try {
        onEvent(JSON.parse(payload) as AgentEvent)
      } catch {
        /* 坏帧跳过，不打断整条流 */
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      flushBlock(block)
    }
  }
  if (buffer.trim()) flushBlock(buffer)
}
