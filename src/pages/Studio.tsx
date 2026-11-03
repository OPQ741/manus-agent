import { useCallback, useEffect, useRef, useState } from 'react'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import { Alert, Button, Flex, Input, Result, Space, Spin, Tabs, Tooltip, Typography } from 'antd'
import {
  ArrowLeftOutlined,
  CodeOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  LoadingOutlined,
  SendOutlined,
  ShareAltOutlined,
  StopOutlined,
} from '@ant-design/icons'
import type { AgentEvent, DesignTweak, Project, ProjectDetail, PublicSettings } from '../../shared/types'
import { ChatStream, EMPTY_LIVE, type LiveState } from '../components/ChatStream'
import { CodePanel } from '../components/CodePanel'
import { ModelMenu } from '../components/ModelMenu'
import { PreviewPanel } from '../components/PreviewPanel'
import { ProjectSettingsModal } from '../components/ProjectSettingsModal'
import { TopBar } from '../components/TopBar'
import { VersionPanel } from '../components/VersionPanel'
import { Badge, toast } from '../components/ui'
import { ApiError, api, generate } from '../lib/api'
import { explainError } from '../lib/errors'
import { readModelChoice, writeModelChoice, type ModelChoice } from '../lib/model-prefs'
import { applyStorageMessage } from '../lib/seed'
import { shareUrlFor } from '../lib/share'
import { takePendingPrompt } from '../lib/pending'

type Tab = 'preview' | 'code' | 'versions'

const MAX_ERRORS = 20

const STAGE_TEXT: Record<string, string> = { write: '正在写代码', verify: '正在自检' }

/**
 * 把一批 SSE 事件折进「进行中」状态。
 *
 * 用一次 requestAnimationFrame 批量 flush：模型一秒能吐几十个 file_delta，
 * 逐条 setState 会让 React 在流式阶段里空转，界面反而更卡。
 */
function applyEvents(state: LiveState, events: AgentEvent[]): LiveState {
  let next = state
  const clone = () => ({
    ...next,
    files: next.files.map((file) => ({ ...file })),
    checks: [...next.checks],
    warnings: [...next.warnings],
  })

  for (const event of events) {
    switch (event.type) {
      case 'stage':
        next = clone()
        next.stage = event.status === 'running' ? event.stage : next.stage === event.stage ? null : next.stage
        break
      case 'plan':
        next = clone()
        next.plan = event.plan
        break
      case 'note':
        // 累积而不是覆盖：模型边写边说的那几句，拼起来才是"它怎么想的"
        next = clone()
        next.note = (event.text || '').slice(0, 160)
        next.thought = `${next.thought}${event.text || ''}`.slice(-2400)
        break
      case 'notice':
        // 排队/换家这类提示只保留最新一条：它们描述的是"此刻在发生什么"
        next = clone()
        next.notice = { level: event.level, text: event.message }
        break
      case 'file_start':
        next = clone()
        if (!next.files.some((file) => file.path === event.path)) {
          next.files.push({ path: event.path, content: '', lines: 0, done: false, startedAt: Date.now() })
        }
        break
      case 'file_delta': {
        next = clone()
        const file = next.files.find((item) => item.path === event.path)
        if (file) {
          file.content += event.chunk
          file.lines = file.content.split('\n').length
        }
        break
      }
      case 'file_end': {
        next = clone()
        const file = next.files.find((item) => item.path === event.path)
        if (file) {
          file.content = event.content
          file.lines = event.lines
          file.done = true
          file.endedAt = Date.now()
        } else {
          next.files.push({
            path: event.path,
            content: event.content,
            lines: event.lines,
            done: true,
            startedAt: Date.now(),
            endedAt: Date.now(),
          })
        }
        break
      }
      case 'check':
        next = clone()
        next.checks = [...next.checks.filter((check) => check.id !== event.check.id), event.check]
        break
      case 'warning':
        next = clone()
        next.warnings.push(event.message)
        break
      case 'done':
        next = clone()
        next.usage = event.usage
        next.provider = event.provider ?? next.provider
        break
      default:
        break
    }
  }
  return next
}

export function StudioPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [previewHtml, setPreviewHtml] = useState('')
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE)
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('preview')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([])
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [rolling, setRolling] = useState(false)
  /** 本项目的模型选择（null = 跟随设置） */
  const [modelChoice, setModelChoice] = useState<ModelChoice | null>(null)
  const [editOpen, setEditOpen] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const inputRef = useRef<TextAreaRef>(null)
  /**
   * 模型选择走 ref 而不是进 run 的依赖数组：run 变了，下面那个 [id, run] 的
   * 加载 effect 会整页重载 —— 换个模型就把对话重新拉一遍，体验很怪。
   */
  const modelChoiceRef = useRef<ModelChoice | null>(null)
  /**
   * 最近一次失败所用的指令：错误条上的「重新生成」要用**它**重试，
   * 而不是输入框里此刻的内容（用户可能已经改了字，或者输入框是空的）。
   */
  const lastFailedPromptRef = useRef<string | null>(null)
  /** 当前项目已有多少文件 —— 用来判断「首次生成」还是「迭代」，避免抢用户的页签 */
  const fileCountRef = useRef(0)
  const runningFileRef = live.files.find((file) => !file.done)?.path ?? null

  useEffect(() => {
    fileCountRef.current = detail?.project.files.length ?? 0
  }, [detail])

  const refresh = useCallback(async () => {
    const data = await api.getProject(id)
    setDetail({ project: data.project, messages: data.messages, versions: data.versions })
    setPreviewHtml(data.previewHtml)
    return data
  }, [id])

  const run = useCallback(
    async (prompt: string) => {
      if (busyRef.current) return
      const text = prompt.trim()
      if (!text) return
      const hadNoFiles = fileCountRef.current === 0
      busyRef.current = true
      setBusy(true)
      setPendingUser(text)
      setRuntimeErrors([])
      setError(null)
      lastFailedPromptRef.current = text
      setLive({ ...EMPTY_LIVE, running: true, stage: 'plan', startedAt: Date.now() })
      setTab('preview')

      const controller = new AbortController()
      abortRef.current = controller

      const queue: AgentEvent[] = []
      let frame = 0
      let partial = false
      let kept = 0
      let streamError: { code: string; message: string } | null = null
      const flush = () => {
        frame = 0
        if (queue.length === 0) return
        const events = queue.splice(0)
        setLive((prev) => applyEvents(prev, events))
      }
      const enqueue = (event: AgentEvent) => {
        if (event.type === 'done' && event.partial) {
          partial = true
          kept = event.kept ?? 0
        }
        // 流里的 error 事件不会让 fetch 抛错，必须自己接住，
        // 否则模型 401 / 超时这类失败在界面上是"静默失败"
        if (event.type === 'error') streamError = { code: event.code, message: event.message }
        queue.push(event)
        if (!frame) frame = requestAnimationFrame(flush)
      }

      try {
        const choice = modelChoiceRef.current
        await generate(
          id,
          text,
          { provider: choice?.provider, model: choice?.model },
          enqueue,
          controller.signal,
        )
        if (frame) {
          cancelAnimationFrame(frame)
          frame = 0
        }
        flush()
        const data = await refresh()
        if (streamError) {
          setError(streamError)
        } else {
          lastFailedPromptRef.current = null
          // 只有"从零生成第一次"才自动切到预览；迭代时尊重用户当前在看的那一页
          if (hadNoFiles && data.project.files.length > 0) setTab('preview')
          if (partial) {
            toast(
              kept > 0
                ? `已停止，保留了 ${kept} 个已完成的文件（v${data.project.version}）`
                : '已停止：这次还没写完任何文件，没有产生新版本',
            )
          } else {
            toast(`已更新到 v${data.project.version}`)
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          toast('已停止生成，未完成的改动不会写入')
        } else {
          const apiError = err as ApiError
          setError({ code: apiError.code ?? 'internal', message: apiError.message ?? '生成失败' })
        }
        try {
          await refresh()
        } catch {
          /* 忽略二次失败 */
        }
      } finally {
        if (frame) cancelAnimationFrame(frame)
        busyRef.current = false
        abortRef.current = null
        setBusy(false)
        setPendingUser(null)
        setLive(EMPTY_LIVE)
      }
    },
    [id, refresh],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const data = await api.getProject(id)
        if (cancelled) return
        setDetail({ project: data.project, messages: data.messages, versions: data.versions })
        setPreviewHtml(data.previewHtml)
        const pending = takePendingPrompt(id)
        if (pending && data.project.files.length === 0) void run(pending)
      } catch (err) {
        if (!cancelled) {
          const apiError = err as ApiError
          setError({ code: apiError.code ?? 'internal', message: apiError.message ?? '项目加载失败' })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    void api.getSettings().then(setSettings).catch(() => undefined)
    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
  }, [id, run])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { __nucleus?: number; kind?: string; message?: string } | null
      if (!data || data.__nucleus !== 1) return
      if (data.kind === 'error' && data.message) {
        const message = data.message
        setRuntimeErrors((prev) => (prev.includes(message) ? prev : [...prev, message].slice(0, MAX_ERRORS)))
      } else if (data.kind === 'storage') {
        applyStorageMessage(id, data as { op: 'set' | 'remove' | 'clear'; key?: string; value?: string })
      } else if (data.kind === 'ready') {
        setRuntimeErrors([])
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [id])

  const heal = () => {
    if (runtimeErrors.length === 0) return
    const list = runtimeErrors
      .slice(0, 8)
      .map((message, index) => `${index + 1}) ${message}`)
      .join('\n')
    void run(`预览出现了以下运行时错误，请定位并修复。只输出改动过的文件，不要重写没有问题的部分：\n${list}`)
  }

  /**
   * 停止生成。
   *
   * 刻意**不**直接 abort 掉 SSE 连接：连接一断就收不到服务端的确认。
   * 这里只发一个 /stop，请求服务端中断引擎；服务端随后把"已写完的文件"
   * 提交成一个新版本，再通过同一条流回一个 done(partial) 事件。
   */
  const stop = useCallback(() => {
    void api.stop(id).catch(() => {
      /* 生成可能已经结束，忽略 */
    })
  }, [id])

  const rollback = async (seq: number) => {
    setRolling(true)
    try {
      await api.rollback(id, seq)
      await refresh()
      toast(`已回滚到 v${seq}`)
      setTab('preview')
    } catch (err) {
      toast(err instanceof Error ? err.message : '回滚失败')
    } finally {
      setRolling(false)
    }
  }

  /**
   * 保存设计微调。
   *
   * 实时效果由 PreviewPanel 直接 postMessage 完成（不重载 iframe，应用内状态不丢），
   * 这里只负责"下次打开还是这个样子"。
   *
   * 但**必须**把服务端返回的 project 写回 state：否则「恢复默认」之后
   * detail.project.tweak 还留着旧值，一旦预览被刷新/换视口/切页签回来，
   * iframe 重新挂载就会按残留的旧微调覆盖用户刚选的颜色 —— 表现为"调了没生效"。
   * 空 tweak 由 api 层归一成 null（清除），不会再把 `{}` 发成"什么都没发"。
   */
  const saveTweak = useCallback(
    async (next: DesignTweak | undefined) => {
      const { project } = await api.updateTweak(id, next ?? null)
      setDetail((prev) => (prev ? { ...prev, project } : prev))
    },
    [id],
  )

  /** 本项目的模型选择：只影响下一次生成，不动全局设置。 */
  const pickModel = useCallback(
    (choice: ModelChoice | null) => {
      setModelChoice(choice)
      modelChoiceRef.current = choice
      writeModelChoice(id, choice)
      if (choice) toast(`下一次生成用 ${choice.model || choice.provider}`)
    },
    [id],
  )

  useEffect(() => {
    const saved = readModelChoice(id)
    setModelChoice(saved)
    modelChoiceRef.current = saved
  }, [id])

  if (loading) {
    return (
      <>
        <TopBar left={<Typography.Text type="secondary">加载中…</Typography.Text>} />
        <div className="center-fill">
          <Spin size="large" />
        </div>
      </>
    )
  }

  if (!detail) {
    return (
      <>
        <TopBar />
        <Result
          status="warning"
          title="项目不存在"
          subTitle={error?.message ?? '可能已经被删除了'}
          extra={
            <Button type="primary" href="#/">
              回到首页
            </Button>
          }
        />
      </>
    )
  }

  const { project, messages, versions } = detail
  // 走 shareUrlFor 而不是裸拼 origin：托管网关的访问口令（?sharecode=）必须一起带上，
  // 否则复制出去的链接在别人（以及刷新后的自己）那里是一页"链接不完整"。
  const shareUrl = shareUrlFor(project.slug, window.location.origin)
  const canSend = !busy && input.trim().length > 0
  const errorInfo = explainError(error?.code, error?.message ?? '')
  const retryPrompt = input.trim() || lastFailedPromptRef.current || ''
  const fileTotal = project.files.length + live.files.filter((file) => !project.files.some((item) => item.path === file.path)).length

  const send = () => {
    if (!canSend) return
    const text = input
    setInput('')
    void run(text)
  }

  return (
    <>
      <TopBar
        left={
          <Flex align="center" gap={6} style={{ minWidth: 0 }}>
            <Tooltip title="返回首页">
              <Button type="text" size="small" href="#/" aria-label="返回首页" icon={<ArrowLeftOutlined />} />
            </Tooltip>
            <Tooltip title={project.name}>
              <span className="project-title">{project.name}</span>
            </Tooltip>
            {/* 名字/简介/分享链接都收进弹窗：顶栏只留一支笔，不再就地撑开输入框 */}
            <Tooltip title="项目设置">
              <Button
                type="text"
                size="small"
                className="project-edit"
                aria-label="项目设置"
                icon={<EditOutlined />}
                onClick={() => setEditOpen(true)}
              />
            </Tooltip>
            <Badge tone="accent">v{project.version}</Badge>
            <ModelMenu project={project} settings={settings} value={modelChoice} onChange={pickModel} />
          </Flex>
        }
        right={
          <Space size={4}>
            <Button
              size="small"
              type="text"
              icon={<ShareAltOutlined />}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl)
                  toast('分享链接已复制')
                } catch {
                  toast(shareUrl)
                }
              }}
            >
              分享
            </Button>
            <Button size="small" type="text" href={api.exportUrl(id)} icon={<DownloadOutlined />}>
              导出
            </Button>
          </Space>
        }
      />

      <div className="studio">
        <section className="chatpane" aria-label="对话">
          <ChatStream messages={messages} live={live} pendingUser={pendingUser} />

          {error ? (
            <Alert
              className="error-banner"
              type="error"
              showIcon
              style={{ margin: '0 12px 8px' }}
              message={errorInfo.title}
              description={errorInfo.hint}
              action={
                errorInfo.action.kind === 'none' ? null : (
                  <Button
                    size="small"
                    disabled={errorInfo.action.kind === 'retry' && !retryPrompt}
                    onClick={() => {
                      if (errorInfo.action.kind === 'settings') window.location.hash = '#/settings'
                      else if (errorInfo.action.kind === 'home') window.location.hash = '#/'
                      else {
                        setError(null)
                        setInput('')
                        void run(retryPrompt)
                      }
                    }}
                  >
                    {errorInfo.action.label}
                  </Button>
                )
              }
            />
          ) : null}

          <div className="chat-composer">
            <div className="chat-input">
              <Input.TextArea
                ref={inputRef}
                variant="borderless"
                value={input}
                autoSize={{ minRows: 2, maxRows: 6 }}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault()
                    send()
                  }
                  if (event.key === 'Escape' && busy) stop()
                }}
                placeholder={
                  project.files.length === 0
                    ? '描述你要的应用，或补充更多细节…'
                    : '继续改：比如「主色换成墨绿」「加一个分类占比图」'
                }
                aria-label="继续描述需求"
                disabled={busy}
              />
              <Flex className="chat-input-bar" align="center" gap={8}>
                {busy ? (
                  <Space size={6}>
                    <Spin indicator={<LoadingOutlined spin />} size="small" />
                    <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                      {STAGE_TEXT[live.stage ?? ''] ?? '正在拆解'}
                    </Typography.Text>
                  </Space>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    ⌘/Ctrl + Enter 发送 · ⌘/Ctrl + K 聚焦
                  </Typography.Text>
                )}
                <div className="spacer" />
                {busy ? (
                  <Button size="small" icon={<StopOutlined />} onClick={stop}>
                    停止（保留已完成文件）
                  </Button>
                ) : (
                  <Button
                    type="primary"
                    size="small"
                    icon={<SendOutlined />}
                    aria-label="发送"
                    disabled={!canSend}
                    onClick={send}
                  >
                    发送
                  </Button>
                )}
              </Flex>
            </div>
          </div>
        </section>

        <section className="workspace" aria-label="工作区">
          <Tabs
            className="ws-tabs"
            activeKey={tab}
            onChange={(key) => setTab(key as Tab)}
            tabBarExtraContent={
              live.running ? (
                <Badge tone="accent">
                  <Space size={5}>
                    <Spin indicator={<LoadingOutlined spin />} size="small" />
                    {runningFileRef ? `写入 ${runningFileRef}` : '运行中'}
                  </Space>
                </Badge>
              ) : null
            }
            items={[
              {
                key: 'preview',
                label: (
                  <Space size={6}>
                    <EyeOutlined /> 预览
                  </Space>
                ),
                children: (
                  <PreviewPanel
                    projectId={id}
                    html={previewHtml}
                    checks={project.checks}
                    errors={runtimeErrors}
                    tweak={project.tweak}
                    onTweakSave={saveTweak}
                    onHeal={heal}
                    onRefresh={() => void refresh()}
                    shareUrl={shareUrl}
                  />
                ),
              },
              {
                key: 'code',
                label: (
                  <Space size={6}>
                    <CodeOutlined /> 代码 <Badge>{fileTotal}</Badge>
                  </Space>
                ),
                children: <CodePanel files={project.files} liveFiles={live.files} followPath={live.running ? runningFileRef : null} />,
              },
              {
                key: 'versions',
                label: (
                  <Space size={6}>
                    <HistoryOutlined /> 版本 <Badge>{versions.length}</Badge>
                  </Space>
                ),
                children: <VersionPanel versions={versions} current={project.version} onRollback={(seq) => void rollback(seq)} busy={rolling} />,
              },
            ]}
          />
        </section>
      </div>

      <ProjectSettingsModal
        open={editOpen}
        project={project}
        shareUrl={shareUrl}
        onClose={() => setEditOpen(false)}
        onSaved={(next: Project) => setDetail((prev) => (prev ? { ...prev, project: next } : prev))}
      />
    </>
  )
}
