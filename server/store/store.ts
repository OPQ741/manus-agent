/**
 * 持久化层。
 *
 * 选择"单文件 JSON + 原子替换"而不是 SQLite/Postgres（见 docs/03 §2）：
 * 零依赖、任何 Node 版本可跑、文件可读可 diff，代价是只能单进程。
 * 所有写操作走同一个串行队列，避免并发写坏文件。
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  Check,
  DesignPrefs,
  FileEntry,
  Message,
  Plan,
  Project,
  ProjectDetail,
  ProjectSummary,
  ProviderId,
  PublicSettings,
  Usage,
  Version,
} from '../../shared/types'

export interface StoredSettings {
  /**
   * 访客点名的提供方：'' = 交给服务端解析链（默认，免 Key 也能用）；
   * 'custom' = 用下面的 baseUrl/model/apiKey 三项；其他 = 目录里的某个预设 id。
   */
  provider: string
  baseUrl: string
  model: string
  /** 点名预设时换模型；与 custom 的 model 分开存，切换模式时互不覆盖 */
  modelOverride?: string
  /** custom 通道的输出上限（不填走 8192） */
  maxTokens?: number
  /** custom 通道的温度（不填走 0.4） */
  temperature?: number
  apiKey: string
  design: DesignPrefs
}

export interface Database {
  /**
   * v2：engine 'local'|'cloud' 被 provider id 取代（本地 mock 编译器已删除）。
   * 读到旧 schema 时备份并重建，顺带清掉上一版预置的 mock 项目。
   */
  schema: 2
  projects: Project[]
  messages: Message[]
  versions: Version[]
  settings: StoredSettings
}

export const SCHEMA_VERSION = 2

/** 旧版本数据库：走"备份 + 重建"，而不是硬迁移一堆过期 mock 项目。 */
class SchemaMismatchError extends Error {
  readonly schema: number
  constructor(schema: number) {
    super(`schema ${schema} ≠ ${SCHEMA_VERSION}`)
    this.schema = schema
  }
}

export const DEFAULT_DESIGN: DesignPrefs = { accent: '#4B3BFF', theme: 'light', locale: 'zh' }

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

function randomToken(length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}

export const newId = () => `p_${randomToken(9)}`
export const newSlug = () => randomToken(10)
export const newMessageId = () => `m_${randomToken(9)}`
export const newVersionId = () => `v_${randomToken(9)}`

export function emptyDatabase(): Database {
  return {
    schema: SCHEMA_VERSION,
    projects: [],
    messages: [],
    versions: [],
    settings: { provider: '', baseUrl: '', model: '', apiKey: '', design: { ...DEFAULT_DESIGN } },
  }
}

export function summarize(project: Project): ProjectSummary {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    summary: project.summary,
    version: project.version,
    fileCount: project.files.length,
    provider: project.provider,
    providerLabel: project.providerLabel,
    providerModel: project.providerModel,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}

export interface CommitInput {
  files: FileEntry[]
  plan: Plan | null
  checks: Check[]
  prompt: string
  usage: Usage
  label?: string
  /** 这次实际用了哪家模型；回滚等场景可以不传（保持原值） */
  provider?: { id: ProviderId; label: string; model?: string }
}

export class Store {
  readonly file: string
  private db: Database
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(file: string, db: Database) {
    this.file = file
    this.db = db
  }

  static async open(file: string): Promise<Store> {
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as Database
      if (!parsed || !Array.isArray(parsed.projects)) {
        throw new Error('数据库结构不可识别')
      }
      if (parsed.schema !== SCHEMA_VERSION) {
        // 旧 schema（v1 有本地引擎预置的 mock 项目）：备份后重建，
        // 让 seed 用出厂真实示例重新填一次，而不是把过期数据带进新契约。
        throw new SchemaMismatchError(parsed.schema)
      }
      parsed.messages ??= []
      parsed.versions ??= []
      parsed.settings ??= emptyDatabase().settings
      return new Store(file, parsed)
    } catch (error) {
      if (error instanceof SchemaMismatchError) {
        try {
          await fs.rename(file, `${file}.v${error.schema}-backup.${Date.now()}`)
        } catch {
          /* 忽略备份失败：重建仍然继续 */
        }
        const store = new Store(file, emptyDatabase())
        await store.save()
        return store
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // 文件损坏：备份后重建，避免整个应用起不来
        try {
          await fs.rename(file, `${file}.corrupt.${Date.now()}`)
        } catch {
          /* 忽略备份失败 */
        }
      }
      const store = new Store(file, emptyDatabase())
      await store.save()
      return store
    }
  }

  /** 串行、原子的落盘。返回的 Promise 在真正写完之后 resolve。 */
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.db)
    const run = this.queue.then(async () => {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.file)
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** 仅供测试/运维：等待队列排空 */
  async flush(): Promise<void> {
    await this.queue
  }

  snapshot(): Database {
    return JSON.parse(JSON.stringify(this.db)) as Database
  }

  /* ------------------------------ projects ------------------------------ */

  /**
   * 项目列表。传入 mine（访客标识）时只返回该访客创建的项目。
   * 注意：这是**展示层过滤**，不是安全边界 —— 免注册 Demo 不做写隔离。
   */
  listProjects(mine?: string): ProjectSummary[] {
    return [...this.db.projects]
      .filter((project) => !mine || project.createdBy === mine)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((project) => summarize(project))
  }

  getProject(id: string): Project | null {
    return this.db.projects.find((project) => project.id === id) ?? null
  }

  getBySlug(slug: string): Project | null {
    return this.db.projects.find((project) => project.slug === slug) ?? null
  }

  async createProject(input: {
    prompt?: string
    design?: DesignPrefs
    createdBy?: string
    provider?: ProviderId
    providerLabel?: string
    providerModel?: string
  }): Promise<Project> {
    const now = Date.now()
    const project: Project = {
      id: newId(),
      slug: newSlug(),
      name: input.prompt ? deriveName(input.prompt) : '未命名应用',
      summary: input.prompt?.slice(0, 80) ?? '',
      provider: input.provider ?? '',
      providerLabel: input.providerLabel ?? '',
      providerModel: input.providerModel,
      design: input.design ?? { ...this.db.settings.design },
      files: [],
      plan: null,
      checks: [],
      version: 0,
      createdBy: input.createdBy ?? 'anonymous',
      createdAt: now,
      updatedAt: now,
    }
    this.db.projects.unshift(project)
    await this.save()
    return project
  }

  async updateProject(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'summary' | 'design' | 'provider' | 'providerLabel' | 'tweak'>>,
  ): Promise<Project | null> {
    const project = this.getProject(id)
    if (!project) return null
    Object.assign(project, patch)
    // 用户亲手改过的元信息上锁：此后的生成（含"只改样式"）不再覆盖它，见 commit()
    if (typeof patch.name === 'string') project.nameLocked = true
    if (typeof patch.summary === 'string') project.summaryLocked = true
    // tweak 允许被显式清除（前端点"恢复默认"）：undefined 必须真的把键删掉，
    // 否则 JSON 里会留下一个 null，回读时又变成"有微调"。
    if ('tweak' in patch && patch.tweak === undefined) delete project.tweak
    project.updatedAt = Date.now()
    await this.save()
    return project
  }

  async deleteProject(id: string): Promise<boolean> {
    const before = this.db.projects.length
    this.db.projects = this.db.projects.filter((project) => project.id !== id)
    if (this.db.projects.length === before) return false
    this.db.messages = this.db.messages.filter((message) => message.projectId !== id)
    this.db.versions = this.db.versions.filter((version) => version.projectId !== id)
    await this.save()
    return true
  }

  /* ------------------------------ messages ------------------------------ */

  listMessages(projectId: string): Message[] {
    return this.db.messages
      .filter((message) => message.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async appendMessage(input: Omit<Message, 'id' | 'createdAt'>): Promise<Message> {
    const message: Message = { ...input, id: newMessageId(), createdAt: Date.now() }
    this.db.messages.push(message)
    // 每个项目最多保留 80 条，避免文件无限膨胀
    const mine = this.db.messages.filter((item) => item.projectId === input.projectId)
    if (mine.length > 80) {
      const drop = new Set(mine.sort((a, b) => a.createdAt - b.createdAt).slice(0, mine.length - 80).map((m) => m.id))
      this.db.messages = this.db.messages.filter((item) => !drop.has(item.id))
    }
    await this.save()
    return message
  }

  /* ------------------------------ versions ------------------------------ */

  listVersions(projectId: string): Version[] {
    return this.db.versions
      .filter((version) => version.projectId === projectId)
      .sort((a, b) => b.seq - a.seq)
  }

  getVersion(projectId: string, seq: number): Version | null {
    return this.db.versions.find((version) => version.projectId === projectId && version.seq === seq) ?? null
  }

  /** 提交一次生成结果：落文件、落版本、更新项目元信息。 */
  async commit(projectId: string, input: CommitInput): Promise<{ project: Project; version: Version } | null> {
    const project = this.getProject(projectId)
    if (!project) return null

    /**
     * 只有首轮（项目还没有任何文件）才允许用本轮方案给项目定名。
     *
     * 之前这里是无条件覆盖，于是"把主色换成墨绿"这种编辑轮也会带一个方案，
     * 而编辑轮方案的名字要么是模型重新起的，要么是占位方案从指令里截出来的
     * （详见 runner.ts 的 placeholderPlan）—— 用户刚在设置里改好的项目名，
     * 就被自己的一句样式指令冲掉了。名称是用户资产，不该由"改个颜色"顺手改掉。
     */
    const firstCommit = project.files.length === 0

    const previous = new Map(project.files.map((file) => [file.path, file.content]))
    const changed = input.files
      .filter((file) => previous.get(file.path) !== file.content)
      .map((file) => file.path)
    const removed = project.files.filter((file) => !input.files.some((next) => next.path === file.path)).map((file) => file.path)

    project.files = input.files
    project.plan = input.plan ?? project.plan
    project.checks = input.checks
    project.version = Math.max(1, project.version + 1)
    project.updatedAt = Date.now()
    if (input.provider) {
      project.provider = input.provider.id
      project.providerLabel = input.provider.label
      if (input.provider.model) project.providerModel = input.provider.model
    }
    if (input.plan?.name && firstCommit && !project.nameLocked) project.name = input.plan.name
    if (input.plan?.summary && firstCommit && !project.summaryLocked) project.summary = input.plan.summary
    // 名称以 project.name 为唯一真相：方案里的 name 只是"这一轮模型怎么称呼它"，
    // 回写成一致的值，避免下一轮的上下文里出现两个不同的应用名。
    if (project.plan && project.plan.name !== project.name) {
      project.plan = { ...project.plan, name: project.name }
    }

    const version: Version = {
      id: newVersionId(),
      projectId,
      seq: project.version,
      label: input.label ?? `第 ${project.version} 版`,
      prompt: input.prompt,
      files: input.files,
      changed: [...changed, ...removed],
      createdAt: Date.now(),
    }
    this.db.versions.push(version)
    this.pruneVersions(projectId)

    await this.save()
    return { project, version }
  }

  private pruneVersions(projectId: string) {
    const mine = this.db.versions
      .filter((version) => version.projectId === projectId)
      .sort((a, b) => a.seq - b.seq)
    if (mine.length <= 30) return
    const keep = new Set([mine[0]!.id, ...mine.slice(-5).map((version) => version.id)])
    this.db.versions = this.db.versions.filter((version) => version.projectId !== projectId || keep.has(version.id))
  }

  async rollback(projectId: string, seq: number): Promise<{ project: Project; version: Version } | null> {
    const target = this.getVersion(projectId, seq)
    if (!target) return null
    const project = this.getProject(projectId)
    if (!project) return null
    return this.commit(projectId, {
      files: target.files.map((file) => ({ ...file })),
      plan: project.plan,
      checks: project.checks,
      prompt: `回滚至 v${seq}`,
      usage: { ms: 0, provider: project.provider, chars: 0 },
      label: `回滚至 v${seq}`,
    })
  }

  /* ------------------------------ settings ------------------------------ */

  getSettings(): StoredSettings {
    return { ...this.db.settings, design: { ...this.db.settings.design } }
  }

  async updateSettings(patch: Partial<StoredSettings>): Promise<StoredSettings> {
    this.db.settings = {
      ...this.db.settings,
      ...patch,
      design: { ...this.db.settings.design, ...(patch.design ?? {}) },
    }
    await this.save()
    return this.getSettings()
  }

  /**
   * 对外可见的设置。
   *
   * 只含"访客自己填的那一份"：目录（providers）与实际生效的通道（active）由
   * HTTP 层用 ProviderCatalog 补 —— 存储层不该知道模型目录这件事。
   */
  publicSettings(): Omit<PublicSettings, 'providers' | 'active' | 'activeReason' | 'warnings' | 'build'> {
    const settings = this.getSettings()
    return {
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      modelOverride: settings.modelOverride ?? '',
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      hasKey: Boolean(settings.apiKey),
      apiKeyMasked: maskKey(settings.apiKey),
      design: settings.design,
      version: '1.0.0',
    }
  }

  detail(projectId: string): ProjectDetail | null {
    const project = this.getProject(projectId)
    if (!project) return null
    return {
      project,
      messages: this.listMessages(projectId),
      versions: this.listVersions(projectId),
    }
  }
}

/** 从 prompt 里猜一个能用的标题，避免列表里全是"未命名应用"。 */
export function deriveName(prompt: string): string {
  const quoted = /[「"'“]([^」"'”]{2,16})[」"'”]/.exec(prompt)
  if (quoted?.[1]) return quoted[1]
  const cleaned = prompt.replace(/\s+/g, ' ').trim()
  if (!cleaned) return '未命名应用'
  return cleaned.length > 18 ? cleaned.slice(0, 18) + '…' : cleaned
}

export function resolveDataFile(dir: string): string {
  return join(dir, 'db.json')
}
