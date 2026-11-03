import { useEffect, useMemo, useRef, useState } from 'react'
import { Flex, Tooltip, Typography } from 'antd'
import {
  BulbOutlined,
  CheckCircleFilled,
  CheckOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  CodeOutlined,
  DownOutlined,
  ExclamationCircleFilled,
  FileTextOutlined,
  HourglassOutlined,
  LoadingOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import type { Check, Message, Plan, ProviderInfo, Usage } from '../../shared/types'
import { fmtSec } from '../lib/format'
import { effectiveStage, STAGE_LABEL, type RunStage } from '../lib/run-stage'
import { AgentAvatar, Badge, type AgentRole } from './ui'

const { Text } = Typography

/**
 * 对话流 = 一次运行的执行记录，而不是"一问一答两团气泡"。
 *
 * 参照 CLI Agent（Claude Code / Codex / Cursor）的转录形态：
 *
 *   你 ── 需求
 *   Agent ── ├ 拆解需求            ✓ 0.3s
 *            ├ 深度思考  ⌄（可展开的模型自述）
 *            ├ 编写代码
 *            │   ├ app.js      132 行 · 4.2s ← 正在写入，尾部代码实时滚动
 *            │   └ index.html  148 行 · 3.1s ✓
 *            └ 静态自检      ✓ 6 通过 · 1 提示
 *
 * 为什么不是"聊天气泡"：生成过程的真实信息密度在**步骤**上（谁在做什么、
 * 花了多久、写到第几行、哪一项校验没过），而气泡把这一切压成一段散文，
 * 用户只能读完之后才知道刚才发生了什么。
 */

export interface LiveFile {
  path: string
  content: string
  lines: number
  done: boolean
  /** 开始/结束时刻：用来算"这个文件写了多久"，而不是整轮的平均值 */
  startedAt: number
  endedAt?: number
}

export interface LiveState {
  running: boolean
  stage: 'plan' | 'write' | 'verify' | null
  plan: Plan | null
  files: LiveFile[]
  checks: Check[]
  warnings: string[]
  /** 模型自述的最新一段（口播），拼进"深度思考" */
  note: string
  /** note 的累积版本：模型边想边说的话，逐字追加 */
  thought: string
  /** 服务端的过程性提示：排队等免 Key 配额、换了一家模型重试… */
  notice: { level: 'info' | 'warn'; text: string } | null
  startedAt: number
  usage: Usage | null
  provider: ProviderInfo | null
}

export const EMPTY_LIVE: LiveState = {
  running: false,
  stage: null,
  plan: null,
  files: [],
  checks: [],
  warnings: [],
  note: '',
  thought: '',
  notice: null,
  startedAt: 0,
  usage: null,
  provider: null,
}

/** 阶段图标：时间线、状态条共用同一套语义，扫一眼就知道走到哪一步了 */
const STAGE_ICON: Record<RunStage, React.ReactNode> = {
  plan: <BulbOutlined />,
  write: <CodeOutlined />,
  verify: <SafetyCertificateOutlined />,
}

function fmtChars(chars: number): string {
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}k 字符`
  return `${chars} 字符`
}

/** 运行中的秒表：只在 running 时开 timer，停下就别再让 React 每秒空转。 */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

function readPlan(meta: Record<string, unknown> | undefined): Plan | null {
  const plan = meta?.plan
  if (plan && typeof plan === 'object' && typeof (plan as Plan).name === 'string') return plan as Plan
  return null
}

function readUsage(meta: Record<string, unknown> | undefined): Usage | null {
  const usage = meta?.usage
  if (usage && typeof usage === 'object' && typeof (usage as Usage).ms === 'number') return usage as Usage
  return null
}

function readProvider(meta: Record<string, unknown> | undefined): ProviderInfo | null {
  const provider = meta?.provider
  if (provider && typeof provider === 'object' && typeof (provider as ProviderInfo).id === 'string') {
    return provider as ProviderInfo
  }
  return null
}

/* --------------------------------- 基础件 -------------------------------- */

type RowStatus = 'pending' | 'running' | 'done' | 'failed' | 'idle'

function RunStep({
  status,
  title,
  meta,
  icon,
  children,
  last,
}: {
  status: RowStatus
  title: React.ReactNode
  meta?: React.ReactNode
  /** 阶段图标：挂在标题前，和时间线右侧的 bullet 表达同一件事 */
  icon?: React.ReactNode
  children?: React.ReactNode
  last?: boolean
}) {
  return (
    <li className={`run-step is-${status}${last ? ' is-last' : ''}`}>
      <span className="run-bullet" aria-hidden="true">
        {status === 'running' ? (
          <LoadingOutlined spin />
        ) : status === 'done' ? (
          <CheckOutlined />
        ) : status === 'failed' ? (
          <CloseOutlined />
        ) : (
          <span className="run-hollow" />
        )}
      </span>
      <div className="run-main">
        <div className="run-line">
          {icon ? <span className="run-step-icon">{icon}</span> : null}
          <span className="run-title">{title}</span>
          {meta ? <span className="run-meta">{meta}</span> : null}
        </div>
        {children}
      </div>
    </li>
  )
}

/** 自检结果统一渲染成一组语义标签，对话流与预览工具栏复用同一种表达。 */
export function CheckTags({ checks }: { checks: Check[] }) {
  return (
    <Flex wrap gap={5} className="check-list">
      {checks.map((check) => (
        <Badge key={check.id} tone={check.ok ? 'ok' : check.level === 'block' ? 'danger' : 'warn'} title={check.detail}>
          {check.ok ? <CheckCircleFilled /> : <ExclamationCircleFilled />} {check.label}
        </Badge>
      ))}
    </Flex>
  )
}

/**
 * 历史消息里的自检结论：先给一句话，明细按需展开。
 *
 * 一次生成会留下七八条自检，全铺成绿色标签时，"这次改了哪些文件"会被挤到视线外，
 * 每轮历史都拖长一节。通过是常态，不值得占版面；失败才是要读的那行 —— 所以
 * 未通过项永远露出，通过项收进一句话，点开才是完整清单。
 */
export function CheckSummary({ checks }: { checks: Check[] }) {
  const [open, setOpen] = useState(false)
  const failed = checks.filter((check) => !check.ok)
  const passed = checks.length - failed.length
  const allOk = failed.length === 0

  return (
    <div className="check-summary">
      {failed.length > 0 ? <CheckTags checks={failed} /> : null}
      <button
        type="button"
        className={`check-summary-note${allOk ? ' is-ok' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {allOk ? <CheckCircleFilled /> : null}
        {allOk
          ? `${passed} 项自检全部通过`
          : passed > 0
            ? `其余 ${passed} 项通过`
            : `${failed.length} 项未通过`}
        <span className="check-summary-caret">{open ? <DownOutlined /> : <RightOutlined />}</span>
      </button>
      {open ? <CheckTags checks={checks} /> : null}
    </div>
  )
}

/**
 * 深度思考。
 *
 * 前半段是模型自己说的话（`<note>` 流），后半段是它给出的方案 JSON ——
 * 两者本就是同一次思考的两面，分成两个卡片反而要用户自己拼。
 */
function Thinking({
  text,
  plan,
  streaming,
  defaultOpen = false,
  forceOpen,
}: {
  text: string
  plan: Plan | null
  streaming?: boolean
  defaultOpen?: boolean
  /**
   * 生成中强制展开。
   * 用户提的正是这点：方案出来之后卡片自动收起，界面只剩"编写代码"四个字，
   * 看上去像什么都没发生。生成过程中它必须是展开的 —— 这是此刻唯一有信息量的地方。
   */
  forceOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const opened = open || Boolean(forceOpen)
  const hasText = Boolean(text.trim())
  const steps = plan?.steps ?? []
  const summary = plan?.summary ?? ''
  if (!hasText && !plan) return null

  const preview = (hasText ? text : summary).trim().replace(/\s+/g, ' ').slice(0, 68)

  return (
    <div className={`thought${opened ? ' is-open' : ''}${forceOpen ? ' is-locked' : ''}`}>
      <button type="button" className="thought-head" onClick={() => setOpen((value) => !value)} aria-expanded={opened}>
        <span className="thought-caret">{opened ? <DownOutlined /> : <RightOutlined />}</span>
        <span className="thought-label">深度思考</span>
        {plan ? <span className="thought-name">{plan.name}</span> : null}
        {!opened && preview ? <span className="thought-preview">{preview}…</span> : null}
        {streaming ? (
          <span className="thought-live">
            <span className="live-dot" />
            思考中
          </span>
        ) : null}
      </button>

      {opened ? (
        <div className="thought-body">
          {plan?.summary ? <p className="thought-summary">{plan.summary}</p> : null}
          {steps.length > 0 ? (
            <ol className="thought-steps">
              {steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          ) : null}
          {hasText ? (
            <div className="thought-stream">
              {text}
              {streaming ? <span className="caret" /> : null}
            </div>
          ) : null}
          <div className="thought-foot">
            {plan?.files?.length ? (
              <span className="thought-files">
                {plan.files.map((file) => (
                  <Tooltip key={file.path} title={file.purpose || file.path}>
                    <span className="file-chip mono">{file.path}</span>
                  </Tooltip>
                ))}
              </span>
            ) : null}
            {plan?.stack ? <span className="mono thought-stack">{plan.stack}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 正在写入的文件的尾部预览：让"模型在打字"这件事可见，而不是一个转圈。 */
function CodePeek({ content }: { content: string }) {
  const tail = useMemo(() => {
    const slice = content.slice(-360)
    const lines = slice.split('\n')
    // 切在半个字符上会看到残行，丢掉第一行
    if (slice.length === 360) lines.shift()
    return lines.slice(-4)
  }, [content])
  return (
    <pre className="code-peek mono" aria-hidden="true">
      {tail.map((line, index) => (
        <span key={index} className="code-peek-line">
          {line || ' '}
        </span>
      ))}
      <span className="caret" />
    </pre>
  )
}

function FileRow({ file, now }: { file: LiveFile; now: number }) {
  const elapsed = Math.max(0, (file.endedAt ?? now) - (file.startedAt || now))
  return (
    <li className={`run-file${file.done ? '' : ' is-active'}`}>
      <div className="run-file-head">
        <span className={`run-file-icon${file.done ? '' : ' active'}`}>
          {file.done ? <FileTextOutlined /> : <LoadingOutlined spin />}
        </span>
        <span className="run-file-path mono">{file.path}</span>
        <span className="run-file-meta">{file.done ? `${file.lines} 行` : `${file.lines} 行 · 写入中`}</span>
        <span className="run-file-time">{fmtSec(elapsed)}</span>
      </div>
      {!file.done && file.content ? <CodePeek content={file.content} /> : null}
    </li>
  )
}

/**
 * 还没开始写的文件。
 *
 * 方案里点名了 3 个文件，但只有第一个到达时才出现第一行 —— 中间那段时间
 * "编写代码" 底下是空的。把计划里的文件先占位摆出来，用户一开始就知道
 * 这一轮要产出什么、还剩几个，而不是盯着一行字猜。
 */
function PendingFileRow({ path, purpose }: { path: string; purpose?: string }) {
  return (
    <li className="run-file is-pending">
      <div className="run-file-head">
        <span className="run-file-icon">
          <HourglassOutlined />
        </span>
        <span className="run-file-path mono">{path}</span>
        <span className="run-file-meta">{purpose || '排队中'}</span>
      </div>
    </li>
  )
}

function Metrics({ usage, provider, version }: { usage: Usage | null; provider: ProviderInfo | null; version?: number }) {
  if (!usage && !provider) return null
  return (
    <div className="run-metrics">
      {version ? <span className="run-metric">v{version}</span> : null}
      {usage ? (
        <span className="run-metric">
          <ClockCircleOutlined /> {fmtSec(usage.ms)}
        </span>
      ) : null}
      {usage?.chars ? <span className="run-metric">{fmtChars(usage.chars)}</span> : null}
      {usage?.tokens ? <span className="run-metric">{usage.tokens} tokens</span> : null}
      {provider ? (
        <span className="run-metric model" title={`${provider.label} · ${provider.model}`}>
          <ThunderboltOutlined /> <span className="mono">{provider.model}</span>
        </span>
      ) : null}
    </div>
  )
}

/* --------------------------------- 进行中 -------------------------------- */

function LiveBlock({ live }: { live: LiveState }) {
  const now = useTicker(live.running)
  const elapsed = live.startedAt ? now - live.startedAt : 0

  /** 各阶段的起止：时间线上每一步都应该能说出"花了多久" */
  const marksRef = useRef<Record<string, { from: number; to?: number }>>({})
  const prevStage = useRef<string | null>(null)
  const [, force] = useState(0)
  useEffect(() => {
    const at = Date.now()
    const prev = prevStage.current
    if (prev && prev !== live.stage) {
      const mark = marksRef.current[prev]
      if (mark && !mark.to) mark.to = at
    }
    if (live.stage && !marksRef.current[live.stage]) marksRef.current[live.stage] = { from: at }
    prevStage.current = live.stage
    force((value) => value + 1)
  }, [live.stage])

  const marks = marksRef.current
  const planDone = Boolean(live.plan) || Boolean(marks.plan?.to)
  // 阶段结束事件会把 live.stage 置回 null，直接读它会在收尾阶段显示成回到拆解；
  // 计时标记仍用原始事件（只在阶段真正切换时打点），显示一律走 effectiveStage。
  const stage = effectiveStage(live)
  const writeRunning = stage === 'write'
  const verifyStarted = stage === 'verify' || live.checks.length > 0
  const okCount = live.checks.filter((check) => check.ok).length
  const badCount = live.checks.length - okCount
  const blockFailed = live.checks.some((check) => !check.ok && check.level === 'block')
  /** 方案里点名、但还没开始写的文件：先占位，别让"编写代码"底下空白一段时间 */
  const pending = (live.plan?.files ?? [])
    .filter((file) => !live.files.some((item) => item.path === file.path))
    .slice(0, 4)

  return (
    <article className="turn agent is-live">
      <header className="turn-head">
        <AgentAvatar role="agent" size={26} />
        <div className="turn-who">
          <span className="turn-name">Nucleus Agent</span>
          <span className="turn-sub">
            {live.provider ? live.provider.label : '规划 · 编码 · 自检'}
          </span>
        </div>
        <div className="spacer" />
        <span className="turn-stage">{live.running ? STAGE_LABEL[stage] : '已完成'}</span>
        <span className="turn-clock">
          <span className="live-dot" />
          {fmtSec(elapsed)}
        </span>
      </header>

      <div className="turn-body">
        <ol className="run-timeline">
          <RunStep
            status={planDone ? 'done' : stage === 'plan' ? 'running' : 'idle'}
            title={STAGE_LABEL.plan}
            icon={STAGE_ICON.plan}
            meta={
              planDone && marks.plan ? fmtSec((marks.plan.to ?? Date.now()) - marks.plan.from) : stage === 'plan' ? '…' : null
            }
          >
            {/* 模型还没开口/还没出方案时，给一条会呼吸的占位：纯 spinner 看着像卡住了 */}
            {live.running && !live.plan && !live.thought ? (
              <div className="run-skeleton" aria-hidden="true">
                <span className="sk-line" style={{ width: '82%' }} />
                <span className="sk-line" style={{ width: '64%' }} />
                <span className="sk-line" style={{ width: '45%' }} />
              </div>
            ) : null}
          </RunStep>

          {live.thought || live.plan ? (
            <li className="run-step is-plain">
              <span className="run-bullet is-soft" aria-hidden="true">
                <span className="run-hollow" />
              </span>
              <div className="run-main">
                <Thinking
                  text={live.thought}
                  plan={live.plan}
                  streaming={live.running && !live.files.length}
                  defaultOpen={!live.plan}
                  forceOpen={live.running}
                />
              </div>
            </li>
          ) : null}

          <RunStep
            status={live.files.length ? 'done' : writeRunning ? 'running' : 'idle'}
            title={STAGE_LABEL.write}
            icon={STAGE_ICON.write}
            meta={
              live.files.length
                ? `${live.files.filter((file) => file.done).length}/${live.files.length} 个文件`
                : writeRunning
                  ? '等待首个文件…'
                  : null
            }
          >
            {live.files.length > 0 || pending.length > 0 ? (
              <ul className="run-files">
                {live.files.map((file) => (
                  <FileRow key={file.path} file={file} now={now} />
                ))}
                {live.running ? pending.map((file) => <PendingFileRow key={file.path} path={file.path} purpose={file.purpose} />) : null}
              </ul>
            ) : writeRunning ? (
              <div className="run-skeleton" aria-hidden="true">
                <span className="sk-line" style={{ width: '70%' }} />
                <span className="sk-line" style={{ width: '52%' }} />
              </div>
            ) : null}
          </RunStep>

          {verifyStarted ? (
            <RunStep
              status={stage === 'verify' ? 'running' : live.checks.length ? (blockFailed ? 'failed' : 'done') : 'idle'}
              title={STAGE_LABEL.verify}
              icon={STAGE_ICON.verify}
              meta={
                live.checks.length ? (
                  <span className={badCount > 0 ? 'has-warn' : ''}>
                    {okCount} 通过{badCount > 0 ? ` · ${badCount} 提示` : ''}
                  </span>
                ) : (
                  '…'
                )
              }
            >
              {live.checks.length ? <CheckTags checks={live.checks} /> : null}
            </RunStep>
          ) : null}

          {live.notice ? (
            <RunStep
              status="idle"
              title={<span className={`run-notice-text ${live.notice.level}`}>{live.notice.text}</span>}
              last
            />
          ) : null}

          {live.warnings.length > 0 ? (
            <RunStep
              status="idle"
              title={<span className="run-warn-text">解析提示：{live.warnings[0]}</span>}
              meta={live.warnings.length > 1 ? `共 ${live.warnings.length} 条` : null}
              last
            />
          ) : null}
        </ol>
      </div>
    </article>
  )
}

/* --------------------------------- 历史消息 ------------------------------ */

const KIND_ROLE: Record<string, AgentRole> = { text: 'agent', plan: 'planner', error: 'runtime', notice: 'model' }

function AgentMessage({ message }: { message: Message }) {
  const plan = readPlan(message.meta)
  const usage = readUsage(message.meta)
  const provider = readProvider(message.meta)
  const checks = message.meta?.checks
  const changed = message.meta?.changed
  const version = typeof message.meta?.version === 'number' ? (message.meta.version as number) : undefined
  const role = message.kind === 'error' ? 'runtime' : plan ? 'planner' : 'agent'

  if (message.kind === 'notice' && !plan) {
    return (
      <article className="turn agent is-notice">
        <header className="turn-head">
          <AgentAvatar role={KIND_ROLE[message.kind] ?? 'agent'} size={22} />
          <div className="turn-who">
            <span className="turn-name">{KIND_ROLE[message.kind] === 'model' ? '出处' : 'Nucleus Agent'}</span>
          </div>
        </header>
        <p className="turn-notice">{message.content}</p>
      </article>
    )
  }

  return (
    <article className={`turn agent${message.kind === 'error' ? ' is-error' : ''}`}>
      <header className="turn-head">
        <AgentAvatar role={role} size={26} />
        <div className="turn-who">
          <span className="turn-name">{message.kind === 'error' ? '运行时' : 'Nucleus Agent'}</span>
          {plan ? <span className="turn-sub">方案 · 编码 · 自检</span> : null}
        </div>
        <div className="spacer" />
        {provider ? (
          <Tooltip title={`${provider.label} · ${provider.model}`}>
            <span className="turn-model mono">{provider.model}</span>
          </Tooltip>
        ) : null}
      </header>

      <div className="turn-body">
        {plan ? (
          <Thinking text="" plan={plan} defaultOpen={false} />
        ) : null}

        <div className={`turn-text${message.kind === 'error' ? ' is-error' : ''}`}>
          {message.kind === 'error' ? <WarningOutlined className="turn-text-icon" /> : null}
          <span>{message.content}</span>
        </div>

        {Array.isArray(changed) && changed.length > 0 ? (
          <div className="changed-files">
            {changed.slice(0, 8).map((path) => (
              <span key={String(path)} className="file-chip mono">
                {String(path)}
              </span>
            ))}
            {changed.length > 8 ? <span className="changed-more">+{changed.length - 8}</span> : null}
          </div>
        ) : null}

        {Array.isArray(checks) && checks.length > 0 ? <CheckSummary checks={checks as Check[]} /> : null}

        <Metrics usage={usage} provider={provider} version={version} />
      </div>
    </article>
  )
}

/* --------------------------------- 出口 --------------------------------- */

/**
 * 用户气泡的深浅 = 离现在多远。
 *
 * 长篇迭代里每条用户消息都是同一块浅紫，往回翻时"这句是刚说的、那句是半小时前说的"
 * 只能靠位置猜。这里用主色浓度做一条静默的时间轴：最新的一条最深，越旧越淡 ——
 * 不额外加标签、不加分割线，视线上就能分出层次。
 */
const BUBBLE_MIX_MIN = 8
const BUBBLE_MIX_MAX = 30
/** 待发送气泡的占位 id：它永远是最新的一条 */
const PENDING_TURN = '__pending'

function bubbleTone(depth: number): React.CSSProperties {
  const mix = BUBBLE_MIX_MIN + (BUBBLE_MIX_MAX - BUBBLE_MIX_MIN) * Math.min(1, Math.max(0, depth))
  return { '--bubble-mix': `${mix.toFixed(1)}%` } as React.CSSProperties
}

export function ChatStream({
  messages,
  live,
  pendingUser,
}: {
  messages: Message[]
  live: LiveState
  pendingUser: string | null
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  /** 每条用户消息的"新近度"：1 = 最新，0 = 最早；只有一条时按最新处理 */
  const toneByTurn = useMemo(() => {
    const ids = messages.filter((message) => message.role === 'user').map((message) => message.id)
    if (pendingUser) ids.push(PENDING_TURN)
    const total = ids.length
    const map = new Map<string, number>()
    ids.forEach((id, index) => {
      map.set(id, total <= 1 ? 1 : 1 - (total - 1 - index) / (total - 1))
    })
    return map
  }, [messages, pendingUser])

  /**
   * 自动跟随：只钉住底部，不跟用户抢滚动条。
   *
   * 判据是"距离底部是否小于 120px"：用户主动往上翻看历史时，
   * 每秒十几次的 file_delta 不该把他拽回底部 —— 这是流式界面最常见的坏体验。
   */
  useEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
    if (nearBottom) endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, live.files.length, live.thought.length, live.stage, pendingUser])

  return (
    <div className="chat-scroll" ref={scrollRef}>
      {messages.length === 0 && !pendingUser ? (
        <div className="chat-empty">
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            描述你想要的应用，Agent 会先给方案再动手 —— 每一步都会实时显示在这里。
          </Text>
        </div>
      ) : null}

      {messages.map((message) =>
        message.role === 'user' ? (
          <article key={message.id} className="turn user">
            <div className="bubble" style={bubbleTone(toneByTurn.get(message.id) ?? 0)}>
              {message.content}
            </div>
            <AgentAvatar role="user" size={24} />
          </article>
        ) : (
          <AgentMessage key={message.id} message={message} />
        ),
      )}

      {pendingUser ? (
        <article className="turn user">
          <div className="bubble pending" style={bubbleTone(1)}>
            {pendingUser}
          </div>
          <AgentAvatar role="user" size={24} />
        </article>
      ) : null}

      {live.running || live.files.length > 0 ? <LiveBlock live={live} /> : null}

      <div ref={endRef} />
    </div>
  )
}
