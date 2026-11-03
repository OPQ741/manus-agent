import type {
  AgentEvent,
  ApiErrorCode,
  DesignPrefs,
  DesignTweak,
  Project,
  ProjectDetail,
  ProjectSummary,
  ProviderId,
  PublicSettings,
  ShareDetail,
  Version,
} from '../../shared/types'
import { tweakPayload } from '../../shared/tweak'

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
  createProject: (input: { prompt?: string; provider?: ProviderId; design?: DesignPrefs }) =>
    request<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (id: string) =>
    request<ProjectDetail & { previewHtml: string }>(`/api/projects/${encodeURIComponent(id)}`),
  renameProject: (id: string, name: string) =>
    request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  /** 项目设置弹窗用：名称与简介一起提交（只传要改的键，没传的服务端保持不动）。 */
  updateProject: (id: string, patch: { name?: string; summary?: string }) =>
    request<{ project: Project; previewHtml: string }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /**
   * 保存设计微调。
   *
   * 空对象**必须**翻译成 `null`：`JSON.stringify({ tweak: undefined })` 得到 `{}`，
   * 服务端看不到 tweak 这个键，于是「恢复默认」只在前端活了 3 秒、一刷新就回退。
   * 这条边界是真实踩出来的（README 承诺"随项目保存"，PRD 承诺"可恢复"）。
   */
  updateTweak: (id: string, tweak: DesignTweak | null | undefined) =>
    request<{ project: Project; previewHtml: string }>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ tweak: tweakPayload(tweak) }),
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
    provider?: string
    baseUrl?: string
    model?: string
    /** 点名预设时换模型；传空串 = 回到预设默认模型 */
    modelOverride?: string
    apiKey?: string
    /** null = 清掉自定义值，回到平台默认 */
    maxTokens?: number | null
    temperature?: number | null
    design?: Partial<DesignPrefs>
  }) => request<PublicSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(input) }),
  /**
   * 拉上游模型列表。
   *
   * 传 `provider` 用服务端已配好的 Key 拉；传 `baseUrl`(+`apiKey`) 拉用户正在填的草稿。
   * 这是把「手写模型名」变成「从列表里选」的关键一步 —— 模型名拼错是自定义接入
   * 最高频的失败原因，而报错往往只有一句 400。
   */
  listModels: (input: { baseUrl?: string; apiKey?: string; provider?: string }) =>
    request<{ models: string[]; source: string }>('/api/settings/models', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /**
   * 测试连接。
   *
   * 传入草稿（还没保存的自带 Key）时只测草稿，**不落库** ——
   * 以前是先 PUT 再测，等于"点一下测试就顺手保存了"，语义很怪，
   * 而且测到的可能不是用户当下填的那一家。
   */
  testConnection: (draft?: { baseUrl?: string; model?: string; apiKey?: string }) =>
    request<{ ok: boolean; ms: number; sample: string; model: string; provider: string }>('/api/settings/test', {
      method: 'POST',
      body: JSON.stringify(draft ?? {}),
    }),
  share: (slug: string) => request<ShareDetail>(`/api/share/${encodeURIComponent(slug)}`),
  exportUrl: (id: string) => `/api/projects/${encodeURIComponent(id)}/export`,
  health: () =>
    request<{ ok: boolean; provider: string | null; providers: string[]; version: string }>('/api/health'),
}

/**
 * 消费 SSE。服务端每帧一个 JSON 事件，这里只负责拼帧与回调，
 * 不解读语义 —— 语义全部在页面层的 reducer 里。
 */
export async function generate(
  projectId: string,
  prompt: string,
  choice: { provider?: ProviderId; model?: string } = {},
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-visitor': visitorId() },
    body: JSON.stringify({ prompt, provider: choice.provider, model: choice.model }),
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
