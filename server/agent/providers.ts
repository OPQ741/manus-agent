/**
 * 模型提供方目录（Provider Catalog）。
 *
 * 这一层只回答一个问题：**这一次生成该打给谁。**
 *
 * 三条规则，按优先级从高到低：
 *  1. 访客在「设置」里填了自己的 Base URL + 模型 + Key → 用访客的（`custom`）；
 *  2. 否则用服务端预设目录里**已就绪**的提供方，默认主力由 `NUCLEUS_PROVIDER` 指定；
 *  3. 目录里永远保留一条免 Key 通道（`free: true`），所以**零配置也能真实调用大模型**。
 *
 * Key 从哪来（都不进仓库）：
 *  - 环境变量：每个预设声明自己的 `keyEnv`，例如 `DEEPSEEK_API_KEY`；
 *  - 通用环境变量：`NUCLEUS_LLM_BASE_URL` / `NUCLEUS_LLM_MODEL` / `NUCLEUS_LLM_API_KEY`
 *    合成一个 id=`env` 的内联预设，直接当主力；
 *  - 配置文件：`config/providers.json`（可入库，改目录结构、不放 Key）
 *    与 `data/providers.local.json`（已 gitignore，可放 Key）。
 *
 * 为什么做成"目录 + 解析链"而不是一个写死的地址：免 Key 通道有配额
 * （Pollinations 匿名档实测为同一 IP 每 30 秒 1 次请求），单点必然把访客挡在门外；
 * 有链才能排队 + 故障转移，而你能用环境变量决定谁做主力。
 */

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProviderOption } from '../../shared/types'
import { validateBaseUrl } from './llm'

export interface ProviderProfile {
  /** 稳定 id，写进项目与用量里 */
  id: string
  /** 给人看的名字 */
  label: string
  /** OpenAI 兼容 Base URL（会拼成 {baseUrl}/chat/completions） */
  baseUrl: string
  model: string
  /**
   * 同一家可切换的候选模型。
   *
   * 目录里写死一个模型名，会让"换个模型试试"变成必须改配置文件；
   * 这里给一组常用候选，界面上就能直接换。真正的完整列表由
   * `/api/models` 现拉（上游 `/v1/models`），预设只负责开箱可用。
   */
  models?: string[]
  /** 读 Key 的环境变量名；免 Key 通道为 undefined */
  keyEnv?: string
  /** 免 Key：不需要任何注册即可调用 */
  free?: boolean
  /** 单次输出上限。不显式设的话上游用它自己的小默认值（Pollinations 是 1500，会把应用直接截断） */
  maxTokens?: number
  temperature?: number
  /** 思考型模型的推理强度：调低能把 token 让给正文，减少"写到一半就断" */
  reasoningEffort?: 'high' | 'medium' | 'low'
  /** 额外请求头（有些网关要求 HTTP-Referer / 署名之类） */
  headers?: Record<string, string>
  /** 排队用的最小请求间隔（毫秒）：免 Key 通道靠它把并发压成串行而不是 429 */
  minIntervalMs?: number
  /** 申请 Key 的入口，设置页给访客看 */
  keyUrl?: string
  /** 一句话说明（配额、注意事项） */
  note?: string
  /** 内置预设：配置文件只能调整它，不能凭空造一个"假装免 Key"的条目 */
  builtin?: boolean
}

/**
 * 内置预设。
 *
 * 只有第一条是**免 Key**的，它保证"打开就能生成"；其余是"你给了 Key 就切过去"的
 * 主力候选 —— 全部是标准 OpenAI 兼容端点。想接自家网关，在 config/providers.json
 * 里追加同形状的一条即可，不必改代码。
 *
 * `models` 只是**开箱可选的起点**，不是白名单：设置页还有一个「拉取模型列表」
 * 按钮，直接问上游 `/models`，所以上游上了新模型也不用回来改这张表。
 */
export const BUILTIN_PROVIDERS: ProviderProfile[] = [
  {
    id: 'pollinations',
    label: '免 Key · GPT-OSS 20B',
    baseUrl: 'https://text.pollinations.ai/openai',
    model: 'openai-fast',
    models: ['openai-fast', 'openai', 'mistral'],
    free: true,
    maxTokens: 12000,
    temperature: 0.4,
    // gpt-oss 默认思考强度会把输出预算吃光（实测：app.js 写到一半断），
    // 降到 low 后正文才写得完 —— 这是免 Key 通道能产出可用应用的关键一档。
    reasoningEffort: 'low',
    // 实测匿名档：同一 IP 每 30 秒 1 次请求。多留 1 秒余量，把并发变排队。
    minIntervalMs: 31_000,
    keyUrl: 'https://enter.pollinations.ai',
    note: '免注册，约 30 秒 1 次',
    builtin: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek V3',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyEnv: 'DEEPSEEK_API_KEY',
    maxTokens: 8192,
    temperature: 0.4,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '中文与代码都稳，按量计费',
    builtin: true,
  },
  {
    id: 'gemini',
    label: 'Gemini 2.5 Flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    keyEnv: 'GEMINI_API_KEY',
    maxTokens: 8192,
    temperature: 0.5,
    keyUrl: 'https://aistudio.google.com/apikey',
    note: '有免费档，出码快',
    builtin: true,
  },
  {
    id: 'moonshot',
    label: 'Kimi K2',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-32k'],
    keyEnv: 'MOONSHOT_API_KEY',
    maxTokens: 8192,
    temperature: 0.4,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '国内直连、中文好',
    builtin: true,
  },
  {
    id: 'zhipu',
    label: 'GLM-4.5-Air',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.5-air',
    models: ['glm-4.5-air', 'glm-4.5', 'glm-4.5-flash'],
    keyEnv: 'ZHIPU_API_KEY',
    maxTokens: 8192,
    temperature: 0.4,
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: '国内可达，有免费档',
    builtin: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter 聚合',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    models: [
      'deepseek/deepseek-chat',
      'anthropic/claude-sonnet-4',
      'google/gemini-2.5-flash',
      'qwen/qwen3-coder',
      'z-ai/glm-4.5-air',
    ],
    keyEnv: 'OPENROUTER_API_KEY',
    maxTokens: 8192,
    temperature: 0.4,
    headers: { 'http-referer': 'https://github.com/OPQ741/manus-agent', 'x-title': 'Nucleus Studio' },
    keyUrl: 'https://openrouter.ai/settings/keys',
    note: '一个 Key 换一堆模型',
    builtin: true,
  },
  {
    id: 'siliconflow',
    label: '硅基流动 · Qwen3 Coder',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct',
    models: [
      'Qwen/Qwen3-Coder-30B-A3B-Instruct',
      'Qwen/Qwen3-235B-A22B-Instruct-2507',
      'deepseek-ai/DeepSeek-V3',
    ],
    keyEnv: 'SILICONFLOW_API_KEY',
    maxTokens: 8192,
    temperature: 0.4,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '注册送额度，国内可达',
    builtin: true,
  },
]

/** 免 Key 通道永远排在解析链最后兜底。 */
export const FREE_PROVIDER_ID = 'pollinations'

export interface CatalogFileEntry {
  id: string
  label?: string
  baseUrl?: string
  model?: string
  models?: string[]
  keyEnv?: string
  apiKey?: string
  free?: boolean
  maxTokens?: number
  temperature?: number
  reasoningEffort?: 'high' | 'medium' | 'low'
  headers?: Record<string, string>
  minIntervalMs?: number
  keyUrl?: string
  note?: string
  /** false = 从目录里摘掉 */
  enabled?: boolean
}

export interface CatalogFile {
  /** 覆盖默认主力（NUCLEUS_PROVIDER 优先级更高） */
  default?: string
  /** 追加或按 id 合并覆盖预设 */
  providers?: CatalogFileEntry[]
  /** 解析顺序（缺省按目录顺序；default 仍会被提到最前） */
  order?: string[]
}

/** 目录里的一条 = 配置 + 当场解析出来的 Key */
export interface CatalogEntry {
  profile: ProviderProfile
  apiKey: string
  ready: boolean
}

export interface ResolvedCatalog {
  entries: CatalogEntry[]
  /** 服务端主力 id */
  defaultId: string
  /** 是否至少有一个可用提供方（免 Key 通道在，正常恒为 true） */
  ready: boolean
  /**
   * 装配过程中的问题：配置文件不是合法 JSON、某条缺 baseUrl/model 被跳过、
   * `default` 指向不存在的 id…
   *
   * 这些以前全是**静默忽略**，于是"我改了配置怎么没生效"只能靠翻日志。
   * 现在原样带到设置页上，一眼能看到是哪一行没被采纳。
   */
  warnings?: string[]
}

/* ------------------------------------------------------------------ */
/* Key 解析                                                            */
/* ------------------------------------------------------------------ */

export function isReady(profile: ProviderProfile, key: string): boolean {
  return Boolean(profile.free) || Boolean(key)
}

/**
 * 取某个提供方的 Key。
 *
 * env 优先于文件：容器部署通常只能给 env，而且"改了文件没重启"比"改了 env 没生效"更常见。
 */
function resolveKey(profile: ProviderProfile, fileKey: string | undefined, env: NodeJS.ProcessEnv): string {
  const fromEnv = profile.keyEnv ? env[profile.keyEnv]?.trim() : ''
  if (fromEnv) return fromEnv
  if (profile.id === 'env') return env.NUCLEUS_LLM_API_KEY?.trim() ?? ''
  return fileKey?.trim() ?? ''
}

/**
 * 通用环境变量合成的内联预设。
 *
 * 三个变量齐了就能接任何 OpenAI 兼容网关而不改代码；地址非法直接忽略 ——
 * 启动期不该因为一个错 URL 崩掉。
 */
function envProfile(env: NodeJS.ProcessEnv): ProviderProfile | null {
  const baseUrl = env.NUCLEUS_LLM_BASE_URL?.trim()
  const model = env.NUCLEUS_LLM_MODEL?.trim()
  const apiKey = env.NUCLEUS_LLM_API_KEY?.trim()
  if (!baseUrl || !model) return null
  if (!validateBaseUrl(baseUrl).ok) return null
  return {
    id: 'env',
    label: env.NUCLEUS_LLM_LABEL?.trim() || `自定义 · ${model}`,
    baseUrl,
    model,
    keyEnv: apiKey ? undefined : 'NUCLEUS_LLM_API_KEY',
    free: apiKey ? false : env.NUCLEUS_LLM_FREE === '1',
    maxTokens: Number(env.NUCLEUS_LLM_MAX_TOKENS ?? 8192) || 8192,
    temperature: env.NUCLEUS_LLM_TEMPERATURE !== undefined ? Number(env.NUCLEUS_LLM_TEMPERATURE) : 0.4,
    builtin: false,
  }
}

function mergeProfile(base: ProviderProfile, patch: CatalogFileEntry): ProviderProfile {
  const next: ProviderProfile = { ...base }
  if (patch.label) next.label = patch.label
  if (patch.baseUrl) next.baseUrl = patch.baseUrl
  if (patch.model) next.model = patch.model
  if (patch.models?.length) next.models = patch.models.filter(Boolean)
  if (patch.keyEnv !== undefined) next.keyEnv = patch.keyEnv || undefined
  if (patch.free !== undefined && base.builtin) next.free = patch.free
  if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens
  if (patch.temperature !== undefined) next.temperature = patch.temperature
  if (patch.reasoningEffort !== undefined) next.reasoningEffort = patch.reasoningEffort
  if (patch.headers) next.headers = { ...(base.headers ?? {}), ...patch.headers }
  if (patch.minIntervalMs !== undefined) next.minIntervalMs = patch.minIntervalMs
  if (patch.keyUrl) next.keyUrl = patch.keyUrl
  if (patch.note) next.note = patch.note
  return next
}

interface CatalogFileRead {
  file: CatalogFile | null
  warning?: string
}

/**
 * 读一份目录文件。
 *
 * 两种失败必须分开：**文件不存在**是正常情况（可选覆盖文件），
 * **文件存在但读不动**是配置事故 —— 后者要冒泡成 warning，不能装作没配。
 */
async function readCatalogFile(path: string): Promise<CatalogFileRead> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch {
    return { file: null }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { file: null, warning: `${path} 顶层必须是对象，已跳过` }
    }
    return { file: parsed as CatalogFile }
  } catch (error) {
    return { file: null, warning: `${path} 不是合法 JSON（${(error as Error).message}），已跳过` }
  }
}

export interface BuildCatalogOptions {
  dataDir?: string
  configFile?: string
  env?: NodeJS.ProcessEnv
}

/**
 * 装配目录：内置预设 ← 仓库文件 ← 本地文件 ← 环境变量。
 *
 * 后一层只覆盖自己声明的字段，没声明的保持上一层，所以"改一个模型名"
 * 不会顺手把 Key 来源和配额说明抹掉。
 */
export async function buildCatalog(options: BuildCatalogOptions = {}): Promise<ResolvedCatalog> {
  const env = options.env ?? process.env
  const dataDir = resolve(options.dataDir ?? 'data')
  const repoFile = options.configFile ?? resolve('config/providers.json')

  const reads = await Promise.all([
    readCatalogFile(repoFile),
    readCatalogFile(join(dataDir, 'providers.local.json')),
  ])
  const warnings: string[] = reads.map((item) => item.warning).filter((item): item is string => Boolean(item))
  const files = reads.map((item) => item.file).filter((item): item is CatalogFile => item !== null)

  const patches = new Map<string, CatalogFileEntry>()
  const fileKeys = new Map<string, string>()
  const disabled = new Set<string>()
  for (const file of files) {
    for (const entry of file.providers ?? []) {
      if (!entry?.id) continue
      if (entry.enabled === false) {
        disabled.add(entry.id)
        patches.delete(entry.id)
        continue
      }
      disabled.delete(entry.id)
      patches.set(entry.id, { ...(patches.get(entry.id) ?? { id: entry.id }), ...entry })
      if (entry.apiKey?.trim()) fileKeys.set(entry.id, entry.apiKey.trim())
    }
  }

  const merged: ProviderProfile[] = []
  for (const preset of BUILTIN_PROVIDERS) {
    const patch = patches.get(preset.id)
    const profile = patch ? mergeProfile(preset, patch) : preset
    if (!disabled.has(profile.id)) merged.push(profile)
  }
  // 配置文件里的新预设（例如自家网关）追加在后面
  for (const [id, patch] of patches) {
    if (merged.some((profile) => profile.id === id)) continue
    if (!patch.baseUrl || !patch.model) {
      warnings.push(`providers.json 里的「${id}」缺 baseUrl 或 model，已跳过`)
      continue
    }
    merged.push({
      id,
      label: patch.label ?? id,
      baseUrl: patch.baseUrl,
      model: patch.model,
      models: patch.models?.filter(Boolean),
      keyEnv: patch.keyEnv,
      free: patch.free,
      maxTokens: patch.maxTokens ?? 8192,
      temperature: patch.temperature ?? 0.4,
      reasoningEffort: patch.reasoningEffort,
      headers: patch.headers,
      minIntervalMs: patch.minIntervalMs,
      keyUrl: patch.keyUrl,
      note: patch.note,
      builtin: false,
    })
  }

  const inlineBase = env.NUCLEUS_LLM_BASE_URL?.trim()
  const inline = envProfile(env)
  if (inline) merged.unshift(inline)
  else if (inlineBase) {
    warnings.push('NUCLEUS_LLM_BASE_URL 没有生效：需要合法的公网 http(s) 地址，并且同时给出 NUCLEUS_LLM_MODEL')
  }

  const order = files.map((file) => file.order).find((item) => item?.length)
  const byId = new Map(merged.map((profile) => [profile.id, profile]))
  const ordered: ProviderProfile[] = []
  for (const id of order ?? []) {
    const hit = byId.get(id)
    if (hit && !ordered.includes(hit)) ordered.push(hit)
  }
  for (const profile of merged) if (!ordered.includes(profile)) ordered.push(profile)

  const fromEnv = env.NUCLEUS_PROVIDER?.trim()
  const fromFile = files.map((file) => file.default).find((id) => id && byId.has(id))
  // default 写了但目标不存在（拼错 id / 那一条被 enabled:false 摘了）：说出名字，别静默改道
  for (const file of files) {
    if (file.default && !byId.has(file.default)) {
      warnings.push(`providers.json 的 default「${file.default}」不在目录里，已忽略`)
    }
  }
  if (fromEnv && !byId.has(fromEnv)) {
    warnings.push(`NUCLEUS_PROVIDER=${fromEnv} 不在目录里（拼错或被 enabled:false 摘掉了），已回退`)
  }
  const declaredDefault = fromEnv || inline?.id || fromFile || FREE_PROVIDER_ID
  const defaultId = byId.has(declaredDefault) ? declaredDefault : ordered[0]?.id ?? FREE_PROVIDER_ID

  // 主力提到第一位；免 Key 通道若被选中，它本来就在链上
  const defaultIndex = ordered.findIndex((profile) => profile.id === defaultId)
  if (defaultIndex > 0) {
    const [first] = ordered.splice(defaultIndex, 1)
    if (first) ordered.unshift(first)
  }

  const entries: CatalogEntry[] = ordered.map((profile) => {
    const apiKey = resolveKey(profile, fileKeys.get(profile.id), env)
    return { profile, apiKey, ready: isReady(profile, apiKey) }
  })

  return { entries, defaultId, ready: entries.some((entry) => entry.ready), warnings }
}

/* ------------------------------------------------------------------ */
/* 解析链                                                              */
/* ------------------------------------------------------------------ */

export interface ResolvedProvider {
  profile: ProviderProfile
  apiKey: string
}

export interface UserUpstream {
  baseUrl?: string
  model?: string
  apiKey?: string
  /** 设置页点名的预设 id；'custom' = 用上面三项 */
  provider?: string
  /** 点名预设时换一个模型（不动 custom 的 model） */
  modelOverride?: string
  /** 自带 Key 的输出上限 / 温度；不填走平台默认 */
  maxTokens?: number
  temperature?: number
}

/** 自定义通道的参数夹到安全区：界面上填错一个数字，不该让整条通道 400。 */
export function clampCustom(profile: ProviderProfile, user: UserUpstream): ProviderProfile {
  const next: ProviderProfile = { ...profile }
  if (Number.isFinite(user.maxTokens)) {
    const value = Math.round(Number(user.maxTokens))
    next.maxTokens = Math.min(Math.max(value, 256), 32_768)
  }
  if (Number.isFinite(user.temperature)) {
    next.temperature = Math.min(Math.max(Number(user.temperature), 0), 2)
  }
  return next
}

/**
 * 这一次生成可用的提供方链（按尝试顺序）。
 *
 * 去重按 id：点名了某个预设时它是 [点名, 主力, …, 免 Key]；
 * 点名「自带 Key」时是 [custom, 主力, …, 免 Key]。
 */
export function resolveChain(catalog: ResolvedCatalog, user: UserUpstream = {}): ResolvedProvider[] {
  const chain: ResolvedProvider[] = []
  const push = (profile: ProviderProfile, apiKey: string) => {
    if (!isReady(profile, apiKey)) return
    if (chain.some((item) => item.profile.id === profile.id)) return
    chain.push({ profile, apiKey })
  }
  const provider = user.provider?.trim() ?? ''

  // ① 自带 Key：**必须明确点名 custom** 才生效。
  //    以前是"三项齐了就排第一"，于是切回服务端预设后，库里残留的 Key 仍然在打头 ——
  //    界面上写的是服务端通道，实际花的还是自己的额度。
  if (provider === 'custom') {
    const userBase = user.baseUrl?.trim()
    const userModel = user.model?.trim()
    const userKey = user.apiKey?.trim()
    if (userKey && userBase && userModel && validateBaseUrl(userBase).ok) {
      push(
        clampCustom(
          {
            id: 'custom',
            label: '我的模型',
            baseUrl: userBase,
            model: userModel,
            maxTokens: 8192,
            temperature: 0.4,
          },
          user,
        ),
        userKey,
      )
    }
  }

  // ② 点名预设（可带一个模型覆盖）→ 服务端目录顺序（主力在前，免 Key 兜底在后）
  const named =
    provider && provider !== 'custom' ? catalog.entries.find((item) => item.profile.id === provider) : undefined
  if (named) {
    const override = user.modelOverride?.trim()
    push(override ? { ...named.profile, model: override } : named.profile, named.apiKey)
  }
  for (const entry of catalog.entries) push(entry.profile, entry.apiKey)

  return chain
}

/** 给 UI 的目录视图：永远不含 Key。形状由 shared/types 定，这里只负责填。 */
export function catalogView(catalog: ResolvedCatalog): ProviderOption[] {
  return catalog.entries.map((entry) => ({
    id: entry.profile.id,
    label: entry.profile.label,
    model: entry.profile.model,
    models: entry.profile.models,
    baseUrl: entry.profile.baseUrl,
    free: Boolean(entry.profile.free),
    ready: entry.ready,
    isDefault: entry.profile.id === catalog.defaultId,
    keyUrl: entry.profile.keyUrl,
    note: entry.profile.note,
    keyEnv: entry.profile.free ? undefined : entry.profile.keyEnv ?? (entry.profile.id === 'env' ? 'NUCLEUS_LLM_API_KEY' : undefined),
  }))
}

/* ------------------------------------------------------------------ */
/* 目录热加载                                                          */
/* ------------------------------------------------------------------ */

export interface CatalogSource {
  /** 取当前目录；配置文件 mtime/size 变了会自动重建，不必重启服务 */
  get: (force?: boolean) => Promise<ResolvedCatalog>
}

/**
 * 目录缓存 + 文件变更检测。
 *
 * 为什么需要它：`buildCatalog` 原本只在启动时跑一次，改完 `config/providers.json`
 * 必须重启才算数 —— 这是"配置改了却没生效"最典型的来源（人不会记得自己没重启）。
 * 现在每次取目录都 stat 一下两个文件（各一次，成本可忽略），变了就重建。
 *
 * 重建失败时继续用上一份可用目录：配置文件写坏不该让线上服务直接失去模型。
 */
export function createCatalogSource(options: BuildCatalogOptions = {}): CatalogSource {
  const dataDir = resolve(options.dataDir ?? 'data')
  const repoFile = options.configFile ?? resolve('config/providers.json')
  const localFile = join(dataDir, 'providers.local.json')

  let cache: ResolvedCatalog | null = null
  let stamp = ''
  let inflight: Promise<ResolvedCatalog> | null = null

  const readStamp = async () => {
    const parts = await Promise.all(
      [repoFile, localFile].map(async (path) => {
        try {
          const stat = await fs.stat(path)
          return `${stat.mtimeMs}:${stat.size}`
        } catch {
          return '-'
        }
      }),
    )
    return parts.join('|')
  }

  return {
    async get(force = false) {
      const next = await readStamp()
      if (!force && cache && next === stamp) return cache
      if (inflight) return inflight
      const built = buildCatalog({ ...options, dataDir, configFile: repoFile })
        .then((catalog) => {
          cache = catalog
          stamp = next
          return catalog
        })
        .catch((error: unknown) => {
          if (cache) return cache
          throw error
        })
        .finally(() => {
          inflight = null
        })
      inflight = built
      return built
    },
  }
}
