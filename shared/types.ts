/**
 * 前后端共享契约。
 *
 * 这个文件是唯一真相：服务端产出的 AgentEvent、客户端消费的 Project，
 * 以及测试断言的形状，全部来自这里。
 */

export type EngineId = 'local' | 'cloud'

export type ThemeMode = 'light' | 'dark' | 'auto'

export type Locale = 'zh' | 'en'

export interface DesignPrefs {
  accent: string
  theme: ThemeMode
  locale: Locale
}

export interface FileEntry {
  path: string
  content: string
  updatedAt: number
}

export interface PlanFile {
  path: string
  purpose: string
}

export interface Plan {
  name: string
  summary: string
  stack: string
  steps: string[]
  files: PlanFile[]
}

export interface Check {
  id: string
  label: string
  ok: boolean
  level: 'block' | 'warn' | 'info'
  detail?: string
}

export interface Usage {
  ms: number
  engine: EngineId
  chars: number
  tokens?: number
}

/** 全系统唯一的流式事件模型。SSE 传它，reducer 吃它，测试断言它。 */
export type AgentEvent =
  | { type: 'stage'; stage: 'plan' | 'write' | 'verify'; status: 'running' | 'done' }
  | { type: 'note'; text: string }
  | { type: 'plan'; plan: Plan }
  | { type: 'file_start'; path: string }
  | { type: 'file_delta'; path: string; chunk: string }
  | { type: 'file_end'; path: string; lines: number; content: string }
  | { type: 'delete'; path: string }
  | { type: 'check'; check: Check }
  | { type: 'warning'; message: string }
  | { type: 'done'; version: number; usage: Usage }
  | { type: 'error'; code: ApiErrorCode; message: string }

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'busy'
  | 'engine_unconfigured'
  | 'llm_auth'
  | 'llm_quota'
  | 'llm_timeout'
  | 'llm_network'
  | 'protocol_error'
  | 'internal'

export interface Project {
  id: string
  slug: string
  name: string
  summary: string
  engine: EngineId
  design: DesignPrefs
  files: FileEntry[]
  plan: Plan | null
  checks: Check[]
  version: number
  createdBy: string
  createdAt: number
  updatedAt: number
}

export type MessageRole = 'user' | 'agent' | 'system'
export type MessageKind = 'text' | 'plan' | 'error' | 'notice'

export interface Message {
  id: string
  projectId: string
  role: MessageRole
  kind: MessageKind
  content: string
  meta?: Record<string, unknown>
  createdAt: number
}

export interface Version {
  id: string
  projectId: string
  seq: number
  label: string
  prompt: string
  files: FileEntry[]
  changed: string[]
  createdAt: number
}

/** 对外可见的设置：apiKey 永远不出现在这里。 */
export interface PublicSettings {
  engine: EngineId
  baseUrl: string
  model: string
  hasKey: boolean
  apiKeyMasked: string
  design: DesignPrefs
  cloudReady: boolean
  version: string
}

export interface ProjectSummary {
  id: string
  slug: string
  name: string
  summary: string
  version: number
  fileCount: number
  engine: EngineId
  updatedAt: number
  createdAt: number
}

export interface ProjectDetail {
  project: Project
  messages: Message[]
  versions: Version[]
}

export interface ShareDetail {
  project: ProjectSummary
  html: string
  checks: Check[]
}

export interface GenerateRequest {
  prompt: string
  engine?: EngineId
}

export const PROMPT_MAX_LENGTH = 2000
export const MAX_FILES = 24
export const MAX_FILE_BYTES = 200 * 1024
export const MAX_TOTAL_BYTES = 400 * 1024
