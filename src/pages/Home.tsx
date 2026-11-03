import { useEffect, useRef, useState } from 'react'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Segmented,
  Skeleton,
  Space,
  Tooltip,
  Typography,
} from 'antd'
import { DeleteOutlined, ReloadOutlined, SendOutlined, SettingOutlined } from '@ant-design/icons'
import type { ProjectSummary } from '../../shared/types'
import { TopBar } from '../components/TopBar'
import { Badge, toast } from '../components/ui'
import { api, visitorId } from '../lib/api'
import { timeAgo } from '../lib/format'
import { setPendingPrompt } from '../lib/pending'

const { Text, Paragraph } = Typography

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
  const areaRef = useRef<TextAreaRef>(null)
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
    // 全局快捷键：搜索框聚焦，与 Studio 里的输入框保持同一套手势
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

  const open = (id: string) => {
    window.location.hash = `#/studio/${id}`
  }

  return (
    <>
      <TopBar
        right={
          <Button type="text" icon={<SettingOutlined />} href="#/settings">
            设置
          </Button>
        }
      />

      <main className="home">
        <div className="hero">
          <h1>
            说一句话，
            <br />
            得到一个<em>能用的应用</em>
          </h1>
          <Paragraph className="hero-sub">
            描述想法，Agent 写代码并在沙箱里跑起来；不满意就继续说，随时退回上一版。
          </Paragraph>
        </div>

        <div className="composer">
          <Input.TextArea
            ref={areaRef}
            variant="borderless"
            value={prompt}
            autoSize={{ minRows: 3, maxRows: 8 }}
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
          <Flex align="center" gap={10} className="composer-bar">
            <Text type="secondary" style={{ fontSize: 12 }}>
              ⌘/Ctrl + Enter
            </Text>
            <div className="spacer" />
            <Button type="primary" size="large" loading={busy} icon={<SendOutlined />} onClick={() => void start()}>
              生成应用
            </Button>
          </Flex>
        </div>

        <Flex className="chips" wrap gap={8} justify="center">
          {TEMPLATES.map((template) => (
            <Button
              key={template.label}
              size="small"
              shape="round"
              onClick={() => {
                setPrompt(template.prompt)
                areaRef.current?.focus()
              }}
            >
              {template.label}
            </Button>
          ))}
        </Flex>

        {error ? (
          <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} style={{ marginBottom: 18 }} />
        ) : null}

        <Flex className="section-head" align="center" gap={10} wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>
            项目
          </Typography.Title>
          <Text type="secondary" style={{ fontSize: 12.5 }}>
            {loading ? '加载中…' : `${projects.length} 个 · 已落盘`}
          </Text>
          <div className="spacer" />
          <Segmented
            value={mine ? 'mine' : 'all'}
            onChange={(value) => setMine(value === 'mine')}
            options={[
              { label: '全部', value: 'all' },
              { label: '我的', value: 'mine' },
            ]}
          />
          <Tooltip title="强制刷新列表（绕过 30s 缓存）">
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void load(mine, true)}>
              刷新
            </Button>
          </Tooltip>
        </Flex>

        {loading ? (
          <div className="grid">
            {[0, 1, 2].map((index) => (
              <Card key={index} className="project-card">
                <Skeleton active paragraph={{ rows: 2 }} title={{ width: '40%' }} />
              </Card>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <Empty
            className="empty-block"
            description={
              <Space direction="vertical" size={2}>
                <Text strong>{mine ? '你还没有创建过项目' : '还没有项目'}</Text>
                <Text type="secondary" style={{ fontSize: 12.5 }}>
                  {mine
                    ? '切回「全部」能看到所有人的项目；在上面写一句话，就会创建属于你的第一个应用。'
                    : '在上面写一句话，或者点一个灵感标签，30 秒后这里就会出现你的第一个应用。'}
                </Text>
              </Space>
            }
          />
        ) : (
          <div className="grid">
            {projects.map((project) => (
              <Card
                key={project.id}
                className="project-card"
                hoverable
                role="button"
                tabIndex={0}
                aria-label={`打开 ${project.name}`}
                onClick={() => open(project.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    open(project.id)
                  }
                }}
              >
                <div className="card-title">
                  <Text strong ellipsis style={{ fontSize: 15, flex: 1, minWidth: 0 }}>
                    {project.name}
                  </Text>
                  {project.createdBy === me ? <Badge tone="accent">我创建的</Badge> : null}
                </div>
                <Text type="secondary" className="card-model mono" ellipsis>
                  {project.providerLabel || '模型生成'}
                </Text>
                <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: '6px 0 0', fontSize: 12.5 }}>
                  {project.summary || '还没有描述'}
                </Paragraph>
                <Flex className="card-foot" align="center" gap={6}>
                  <Badge tone="accent">v{project.version || 0}</Badge>
                  <Badge>{project.fileCount} 文件</Badge>
                  <div className="spacer" />
                  <Text type="secondary" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                    {timeAgo(project.updatedAt)}
                  </Text>
                  {/*
                    项目带着全部版本历史，删掉无法恢复：用二次确认换掉原来的「再点一次」状态机。
                    确认框的浮层虽然画在 body 下，React 事件却仍沿着组件树冒泡 ——
                    「取消」会被卡片接走变成"点进卡片"，「删除」则会打开一个刚被删掉（已不存在）的项目。
                    所以在 Popconfirm 外套一层把事件挡在卡片之外的壳，确认框里的任何点击都不再触达卡片。
                  */}
                  <span
                    className="card-actions"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Popconfirm
                      title="删除这个项目？"
                      description="版本历史会一起删除，不可恢复。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void remove(project.id)}
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label={`删除 ${project.name}`}
                      />
                    </Popconfirm>
                  </span>
                </Flex>
              </Card>
            ))}
          </div>
        )}
      </main>
    </>
  )
}
