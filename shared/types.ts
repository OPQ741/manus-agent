/**
 * 前后端共享契约。
 *
 * 这个文件是唯一真相：服务端产出的 AgentEvent、客户端消费的 Project，
 * 以及测试断言的形状，全部来自这里。
 */

/**
 * 生成引擎 = 模型提供方 id。
 *
 * 以前这里是 `'local' | 'cloud'` 的二选一，'local' 是那条写死配方的本地编译器。
 * 现在所有生成都必须走真实模型，所以它退化成"这次用的是哪一家"：
 * 'pollinations'（免 Key）/ 'deepseek' / 'gemini' / 'custom'（访客自带 Key）…
 * 用 string 而不是联合类型，是因为目录可以被 config/providers.json 扩展。
 */
export type ProviderId = string

export interface ProviderInfo {
  id: ProviderId
  label: string
  model: string
  /** 免 Key 通道：UI 用它区分"无需配置就能用"和"你要自己填 Key" */
  free: boolean
}

export type ThemeMode = 'light' | 'dark' | 'auto'

export type Locale = 'zh' | 'en'

export interface DesignPrefs {
  accent: string
  theme: ThemeMode
  locale: Locale
}

/**
 * 设计微调：只改设计令牌，不重新生成代码。
 *
 * 生成出的应用统一用 CSS 变量表达视觉（--accent / --radius ...），
 * 所以"改主色"这件事没必要再花一次模型调用：改变量即可，
 * 毫秒级生效、不丢应用内状态、可以随项目保存。
 */
export interface DesignTweak {
  /** #rrggbb；缺省表示不覆盖 */
  accent?: string
  /** 0–28（px） */
  radius?: number
}

export interface FileEntry {
  path: string
  content: string
  updatedAt: number
}

/**
 * 手动编辑的一条变更。
 *
 * `content: null` 是删除 —— 必须能和"内容为空字符串"区分开：
 * 清空一个文件（保留空文件）和删掉它是两件事。
 */
export interface FileChange {
  path: string
  content: string | null
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
  provider: ProviderId
  chars: number
  tokens?: number
}

/**
 * 构建指纹。
 *
 * 存在的唯一理由：回答"线上跑的这一版，对应仓库哪个提交"。
 * 构建产物（dist/）不入库，所以只能把答案写进产物本身。
 */
export interface BuildMeta {
  version: string
  /** 短 hash，界面展示用 */
  commit: string
  commitFull: string
  branch: string
  /** 构建时工作区有未提交改动：说明这份产物不对应任何一个干净的提交 */
  dirty: boolean
  /** ISO 时间戳 */
  builtAt: string
}

/** 全系统唯一的流式事件模型。SSE 传它，reducer 吃它，测试断言它。 */
export type AgentEvent =
  | { type: 'stage'; stage: 'plan' | 'write' | 'verify'; status: 'running' | 'done' }
  | { type: 'note'; text: string }
  /**
   * 过程性提示：排队等待免 Key 配额、换了一家模型重试…
   * 它不是错误（红色），也不进版本历史。
   */
  | { type: 'notice'; level: 'info' | 'warn'; message: string }
  | { type: 'plan'; plan: Plan }
  | { type: 'file_start'; path: string }
  | { type: 'file_delta'; path: string; chunk: string }
  | { type: 'file_end'; path: string; lines: number; content: string; truncated?: boolean }
  | { type: 'delete'; path: string }
  | { type: 'check'; check: Check }
  | { type: 'warning'; message: string }
  /**
   * partial=true 表示这次是用户主动中断后保留的版本（只含已完成文件）。
   * kept = 实际保留下来的文件数；为 0 表示这次什么都没写完，没有产生新版本。
   *
   * discarded=true 是「放弃本轮」：连已写完的文件也不要，项目保持中断前的版本，
   * 此时 version 是旧版本号、kept 恒为 0。
   */
  | {
      type: 'done'
      version: number
      usage: Usage
      provider?: ProviderInfo
      partial?: boolean
      kept?: number
      discarded?: boolean
    }
  | { type: 'error'; code: ApiErrorCode; message: string }

export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'busy'
  | 'provider_unavailable'
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
  /** 最近一次成功生成用的提供方 id */
  provider: ProviderId
  /** 展示名（"免 Key · GPT-OSS 20B"），落库时定死，避免目录变更后历史标签漂移 */
  providerLabel: string
  /**
   * 最近一次成功生成用的**模型名**（"deepseek-chat"）。
   *
   * 只靠 providerLabel 不够：同一家通道能换模型，而"这次到底跑的哪个模型"
   * 是排查质量差异时最常被追问的一句。老项目没有这个字段，界面按通道默认值回退。
   */
  providerModel?: string
  design: DesignPrefs
  /**
   * 项目名是否由用户手动设定过。
   *
   * 一旦为 true，后续生成不再用方案里的 name 覆盖它 —— 否则用户在设置里
   * 改好的名字，会被下一句"把主色换成墨绿"这种编辑指令的占位方案冲掉。
   * 老数据没有这个字段，按 false 处理（首轮仍可由方案定名）。
   */
  nameLocked?: boolean
  /** 简介同上：手动改过就不再被方案摘要覆盖 */
  summaryLocked?: boolean
  /** 设计微调（叠加在生成结果之上，不进入版本快照） */
  tweak?: DesignTweak
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
  /** 访客点名的提供方：'' = 交给服务端解析链，'custom' = 用下面三项 */
  provider: string
  baseUrl: string
  model: string
  /** 点名预设时临时换模型（不影响自带 Key 的 model） */
  modelOverride: string
  /** 自带 Key 的输出上限 / 温度：留空表示用平台默认值 */
  maxTokens?: number
  temperature?: number
  hasKey: boolean
  apiKeyMasked: string
  design: DesignPrefs
  /** 服务端目录（不含 Key），设置页据此渲染预设列表 */
  providers: ProviderOption[]
  /** 这一次实际会打给谁（访客自带 Key 时是他自己，否则是服务端主力） */
  active: ProviderInfo | null
  /**
   * 为什么是这一家。
   *
   * 模型配置最常见的困惑不是"怎么填"，而是"我明明选了 A，怎么在跑 B"：
   * 点名的那家没 Key、地址被 SSRF 拦下、Key 存了但没点名…都会静默回退。
   * 把回退理由直接说出来，比让用户对着界面猜要省事得多。
   */
  activeReason: string
  /** 目录加载时的问题（配置写坏了、条目缺字段被跳过），空数组表示一切正常 */
  warnings: string[]
  version: string
  /** 服务端产物的构建指纹：设置页据此显示"线上是哪一次构建" */
  build: BuildMeta
}

/** 设置页里的一个可选提供方。ready=false 表示还没配 Key。 */
export interface ProviderOption {
  id: string
  label: string
  model: string
  /** 这一家可切换的候选模型（目录里声明的，不是实时探测） */
  models?: string[]
  baseUrl: string
  free: boolean
  ready: boolean
  isDefault: boolean
  keyUrl?: string
  note?: string
  keyEnv?: string
}

export interface ProjectSummary {
  id: string
  slug: string
  name: string
  summary: string
  version: number
  fileCount: number
  provider: ProviderId
  providerLabel: string
  providerModel?: string
  /** 创建者的访客标识：用于在列表里标出「我创建的」，不是安全边界。 */
  createdBy: string
  createdAt: number
  updatedAt: number
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

/**
 * 停止的两副面孔。
 *
 * - keep（默认）：中断引擎，把**已经写完**的文件提交成新版本 —— 「先看看写出来的部分」；
 * - discard：中断后什么都不留，项目停在中断前那一版 —— 「这一轮方向不对，别污染我」。
 *
 * 两者都必须走服务端中断（而不是客户端 abort 掉 SSE）：只有服务端知道哪些文件是
 * 完整闭合的，也只有它能决定要不要 commit。
 */
export type StopMode = 'keep' | 'discard'

export interface GenerateRequest {
  prompt: string
  /** 点名用哪个提供方；缺省交给服务端解析链 */
  provider?: ProviderId
  /**
   * 这一次生成临时换的模型名（不改全局设置）。
   *
   * 同一家通道的可选模型差别很大（reasoner 慢但稳、flash 快但容易截断），
   * 而"为了试一个模型去设置页改全局"会让下一个项目也跟着变 —— 所以按次指定。
   */
  model?: string
}

export const PROMPT_MAX_LENGTH = 2000
export const MAX_FILES = 24
export const MAX_FILE_BYTES = 200 * 1024
export const MAX_TOTAL_BYTES = 400 * 1024
