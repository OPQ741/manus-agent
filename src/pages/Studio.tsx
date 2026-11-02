import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, DesignTweak, ProjectDetail, PublicSettings } from '../../shared/types'
import { ChatStream, EMPTY_LIVE, type LiveState } from '../components/ChatStream'
import { CodePanel } from '../components/CodePanel'
import { PreviewPanel } from '../components/PreviewPanel'
import { TopBar } from '../components/TopBar'
import { VersionPanel } from '../components/VersionPanel'
import {
  IconAlert,
  IconBack,
  IconCode,
  IconDownload,
  IconHistory,
  IconPlay,
  IconSend,
  IconShare,
  IconStop,
  Spinner,
  toast,
} from '../components/ui'
import { ApiError, api, generate } from '../lib/api'
import { explainError } from '../lib/errors'
import { applyStorageMessage } from '../lib/seed'
import { shareUrlFor } from '../lib/share'
import { takePendingPrompt } from '../lib/pending'

type Tab = 'preview' | 'code' | 'versions'

const MAX_ERRORS = 20

function applyEvents(state: LiveState, events: AgentEvent[]): LiveState {
  let next = state
  const clone = () => ({ ...next, files: next.files.map((file) => ({ ...file })), checks: [...next.checks], warnings: [...next.warnings] })

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
        next = clone()
        next.note = (event.text || '').slice(0, 160)
        break
      case 'file_start':
        next = clone()
        if (!next.files.some((file) => file.path === event.path)) {
          next.files.push({ path: event.path, content: '', lines: 0, done: false })
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
        } else {
          next.files.push({ path: event.path, content: event.content, lines: event.lines, done: true })
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
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [rolling, setRolling] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
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
      setLive({ ...EMPTY_LIVE, running: true, stage: 'plan' })
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
        await generate(id, text, undefined, enqueue, controller.signal)
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
        setNameDraft(data.project.name)
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
    void run(
      `预览出现了以下运行时错误，请定位并修复。只输出改动过的文件，不要重写没有问题的部分：\n${list}`,
    )
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

  const commitRename = async () => {
    const name = nameDraft.trim()
    setRenaming(false)
    if (!name || !detail || name === detail.project.name) return
    try {
      const { project } = await api.renameProject(id, name)
      setDetail((prev) => (prev ? { ...prev, project } : prev))
    } catch (err) {
      toast(err instanceof Error ? err.message : '重命名失败')
    }
  }

  if (loading) {
    return (
      <>
        <TopBar left={<span className="muted">加载中…</span>} />
        <div style={{ display: 'grid', placeItems: 'center', height: 'calc(100vh - 58px)' }}>
          <Spinner />
        </div>
      </>
    )
  }

  if (!detail) {
    return (
      <>
        <TopBar />
        <div className="home">
          <div className="empty-block">
            <p style={{ margin: 0, fontWeight: 600 }}>项目不存在</p>
            <p style={{ margin: '6px 0 14px', fontSize: 12.5 }}>{error?.message ?? '可能已经被删除了'}</p>
            <a className="btn primary" href="#/">
              回到首页
            </a>
          </div>
        </div>
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

  return (
    <>
      <TopBar
        left={
          <div className="row" style={{ gap: 8, minWidth: 0 }}>
            <a className="btn ghost sm" href="#/" aria-label="返回首页">
              <IconBack size={15} />
            </a>
            {renaming ? (
              <input
                autoFocus
                value={nameDraft}
                style={{ height: 30, width: 200 }}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename()
                  if (event.key === 'Escape') {
                    setRenaming(false)
                    setNameDraft(project.name)
                  }
                }}
                aria-label="项目名"
              />
            ) : (
              <button
                className="btn ghost"
                style={{ fontWeight: 600, color: 'var(--ink)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}
                onClick={() => setRenaming(true)}
                title="点击重命名"
              >
                {project.name}
              </button>
            )}
            <span className="badge accent">v{project.version}</span>
            <span className="badge">{settings?.engine === 'cloud' ? '云模型' : '本地引擎'}</span>
          </div>
        }
        right={
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn sm ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl)
                  toast('分享链接已复制')
                } catch {
                  toast(shareUrl)
                }
              }}
            >
              <IconShare size={14} /> 分享
            </button>
            <a className="btn sm ghost" href={api.exportUrl(id)}>
              <IconDownload size={14} /> 导出
            </a>
          </div>
        }
      />

      <div className="studio">
        <section className="chatpane" aria-label="对话">
          <ChatStream messages={messages} live={live} pendingUser={pendingUser} />

          {error ? (
            <div style={{ padding: '0 14px 8px' }}>
              <div className="error-banner">
                <IconAlert size={15} />
                <div className="error-body">
                  <strong>{errorInfo.title}</strong>
                  <span>{errorInfo.hint}</span>
                </div>
                {errorInfo.action.kind !== 'none' ? (
                  <button
                    className="btn sm"
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
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="chat-composer">
            <div className="chat-input">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend) {
                    event.preventDefault()
                    const text = input
                    setInput('')
                    void run(text)
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
              <div className="chat-input-bar">
                <span className="stage-pill">
                  {busy ? (
                    <>
                      <Spinner /> {live.stage === 'write' ? '正在写代码' : live.stage === 'verify' ? '正在自检' : '正在拆解'}
                    </>
                  ) : (
                    <span className="muted">⌘/Ctrl + Enter 发送 · ⌘/Ctrl + K 聚焦</span>
                  )}
                </span>
                <div className="spacer" />
                {busy ? (
                  <button className="btn sm" onClick={stop}>
                    <IconStop size={13} /> 停止（保留已完成文件）
                  </button>
                ) : (
                  <button
                    className="btn primary sm"
                    disabled={!canSend}
                    onClick={() => {
                      const text = input
                      setInput('')
                      void run(text)
                    }}
                  >
                    <IconSend size={13} /> 发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="workspace" aria-label="工作区">
          <div className="ws-tabs" role="tablist">
            <button className="tab" role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>
              <IconPlay size={13} /> 预览
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'code'} onClick={() => setTab('code')}>
              <IconCode size={13} /> 代码
              <span className="badge">{project.files.length + live.files.filter((f) => !project.files.some((p) => p.path === f.path)).length}</span>
            </button>
            <button className="tab" role="tab" aria-selected={tab === 'versions'} onClick={() => setTab('versions')}>
              <IconHistory size={13} /> 版本
              <span className="badge">{versions.length}</span>
            </button>
            <div className="spacer" />
            {live.running ? (
              <span className="badge accent">
                <Spinner /> {runningFileRef ? `写入 ${runningFileRef}` : '运行中'}
              </span>
            ) : null}
          </div>

          <div className="ws-body">
            {tab === 'preview' ? (
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
            ) : null}
            {tab === 'code' ? (
              <CodePanel
                files={project.files}
                liveFiles={live.files}
                followPath={live.running ? runningFileRef : null}
              />
            ) : null}
            {tab === 'versions' ? (
              <VersionPanel versions={versions} current={project.version} onRollback={(seq) => void rollback(seq)} busy={rolling} />
            ) : null}
          </div>
        </section>
      </div>
    </>
  )
}
