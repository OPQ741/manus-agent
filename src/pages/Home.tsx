import { useEffect, useRef, useState } from 'react'
import type { ProjectSummary } from '../../shared/types'
import { TopBar } from '../components/TopBar'
import { Empty, IconRefresh, IconSend, IconSettings, IconTrash, toast } from '../components/ui'
import { api, visitorId } from '../lib/api'
import { timeAgo } from '../lib/format'
import { setPendingPrompt } from '../lib/pending'

const TEMPLATES: { label: string; prompt: string }[] = [
  { label: '记账本', prompt: '做一个记账应用，叫「随手记账」，主色用墨绿，记录金额、分类和备注' },
  { label: '待办清单', prompt: '做一个待办清单，可以勾选完成，按未完成/已完成筛选' },
  { label: '番茄钟', prompt: '做一个番茄钟，25 分钟专注，结束有提示，记录今天完成了几个' },
  { label: '项目看板', prompt: '做一个轻量看板，待办 / 进行中 / 已完成三列，卡片可以推进' },
  { label: '灵感便签', prompt: '做一个灵感便签，卡片式展示，可以快速记录和删除' },
  { label: '产品落地页', prompt: '给我的产品做一个落地页，深色风格，主色用天蓝，带等待名单表单' },
]

export function HomePage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mine, setMine] = useState(false)
  /** 二次确认中的项目 id：项目带着全部版本历史，删掉无法恢复，不该一次误点就没。 */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const me = visitorId()

  const load = async (onlyMine = mine, force = false) => {
    try {
      const data = await api.listProjects(onlyMine, force)
      setProjects(data.projects)
    } catch (err) {
      setError(err instanceof Error ? err.message : '项目列表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(mine)
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        areaRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mine])

  const start = async () => {
    const text = prompt.trim()
    if (!text) {
      areaRef.current?.focus()
      return
    }
    if (text.length > 2000) {
      setError('需求描述最多 2000 字')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { project } = await api.createProject({ prompt: text })
      setPendingPrompt(project.id, text)
      window.location.hash = `#/studio/${project.id}`
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setConfirmDelete(null)
    try {
      await api.deleteProject(id)
      setProjects((prev) => prev.filter((item) => item.id !== id))
      // 列表有 30s 缓存：删完必须强制刷新，否则切到「全部」还能看到刚删掉的项目
      void load(mine, true)
      toast('已删除')
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <>
      <TopBar
        right={
          <>
            <a className="btn ghost" href="#/settings">
              <IconSettings /> 设置
            </a>
          </>
        }
      />

      <main className="home">
        <div className="hero">
          <h1>
            说一句话，
            <br />
            得到一个<em>能用的应用</em>
          </h1>
          <p>
            描述你的想法，Agent 会先给方案、再逐文件写代码，然后直接在沙箱里跑起来。
            不满意就继续说，随时能退回上一版。
            <br />
            代码由<strong>真实大模型</strong>生成，默认走免 Key 通道，无需注册；也可以换成你自己的模型 Key。
          </p>
        </div>

        <div className="composer">
          <textarea
            ref={areaRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void start()
              }
            }}
            placeholder="例如：做一个记账应用，记录每天的花销，能按分类看占比…"
            aria-label="描述你想要的应用"
          />
          <div className="composer-bar">
            <span className="composer-hint">⌘/Ctrl + Enter 直接开工 · 生成过程可见、可停止</span>
            <div className="spacer" />
            <button className="btn primary" onClick={() => void start()} disabled={busy}>
              {busy ? <span className="spin" /> : <IconSend />}
              生成应用
            </button>
          </div>
        </div>

        <div className="chips">
          {TEMPLATES.map((template) => (
            <button
              key={template.label}
              className="chip"
              onClick={() => {
                setPrompt(template.prompt)
                areaRef.current?.focus()
              }}
            >
              {template.label}
            </button>
          ))}
        </div>

        {error ? (
          <p style={{ textAlign: 'center', color: 'var(--danger)', fontSize: 13 }} role="alert">
            {error}
          </p>
        ) : null}

        <div className="section-head">
          <h2>项目</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {loading ? '加载中…' : `${projects.length} 个 · 刷新后仍在，数据落盘保存`}
          </span>
          <div className="spacer" />
          <div className="segmented" role="group" aria-label="项目范围">
            <button aria-pressed={!mine} onClick={() => setMine(false)}>
              全部
            </button>
            <button aria-pressed={mine} onClick={() => setMine(true)}>
              我的
            </button>
          </div>
          <button className="btn sm ghost" onClick={() => void load(mine, true)} title="强制刷新列表（绕过 30s 缓存）">
            <IconRefresh size={13} /> 刷新
          </button>
        </div>

        {loading ? (
          <div className="grid">
            {[0, 1, 2].map((index) => (
              <div key={index} className="card" style={{ height: 118, opacity: 0.5 }} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <Empty
            title={mine ? '你还没有创建过项目' : '还没有项目'}
            hint={
              mine
                ? '切回「全部」能看到所有人的项目；在上面写一句话，就会创建属于你的第一个应用。'
                : '在上面写一句话，或者点一个灵感标签，30 秒后这里就会出现你的第一个应用。'
            }
          />
        ) : (
          <div className="grid">
            {projects.map((project) => (
              <article
                key={project.id}
                className="project-card"
                role="button"
                tabIndex={0}
                aria-label={`打开 ${project.name}`}
                onClick={() => {
                  if (confirmDelete && confirmDelete !== project.id) setConfirmDelete(null)
                  window.location.hash = `#/studio/${project.id}`
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    window.location.hash = `#/studio/${project.id}`
                  }
                }}
              >
                <div className="row">
                  <h3>{project.name}</h3>
                  <div className="spacer" />
                  {project.createdBy === me ? <span className="badge accent">我创建的</span> : null}
                  <span className="badge">{project.providerLabel || '模型生成'}</span>
                </div>
                <p>{project.summary || '还没有描述'}</p>
                <footer>
                  <span className="badge accent">v{project.version || 0}</span>
                  <span className="badge">{project.fileCount} 文件</span>
                  <div className="spacer" />
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {timeAgo(project.updatedAt)}
                  </span>
                  <button
                    className={`btn sm ghost danger${confirmDelete === project.id ? ' is-on' : ''}`}
                    aria-label={confirmDelete === project.id ? `确认删除 ${project.name}` : `删除 ${project.name}`}
                    title={confirmDelete === project.id ? '再点一次确认删除' : '删除项目'}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (confirmDelete === project.id) void remove(project.id)
                      else setConfirmDelete(project.id)
                    }}
                  >
                    <IconTrash size={13} />
                    {confirmDelete === project.id ? <span style={{ marginLeft: 4 }}>确认删除？</span> : null}
                  </button>
                </footer>
              </article>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
