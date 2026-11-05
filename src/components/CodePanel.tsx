import { useEffect, useMemo, useState } from 'react'
import { Button, Empty, Flex, Input, Modal, Popconfirm, Tooltip, Typography } from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import type { FileChange, FileEntry } from '../../shared/types'
import { bytes, copyText, lineCount } from '../lib/format'
import { toast } from './ui'
import { CodeEditor } from './CodeEditor'
import { FileTree } from './FileTree'

const { Text } = Typography

interface Props {
  files: FileEntry[]
  liveFiles?: { path: string; content: string; done: boolean }[]
  followPath?: string | null
  /** 从自检 / 版本等入口跳过来时要选中的文件 */
  focusPath?: string | null
  /** 生成进行中：只读（这一轮结束前写的改动会被服务端整份覆盖） */
  readOnly?: boolean
  saving?: boolean
  /** 保存一组改动（content 为 null 表示删除）。返回 true 表示服务端已经接受。 */
  onSave?: (changes: FileChange[]) => Promise<boolean>
}

export function CodePanel({ files, liveFiles, followPath, focusPath, readOnly, saving, onSave }: Props) {
  const merged = useMemo(() => {
    const map = new Map<string, string>()
    for (const file of files) map.set(file.path, file.content)
    for (const file of liveFiles ?? []) map.set(file.path, file.content)
    return [...map.entries()].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path))
  }, [files, liveFiles])

  const [selected, setSelected] = useState<string | null>(null)
  /** 正在编辑的文件（可多个：切来切去不该丢掉没保存的草稿） */
  const [editing, setEditing] = useState<string[]>([])
  /** 当前缓冲区：可能等于原内容，也可能还没落库 */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [newPath, setNewPath] = useState('')

  // 生成中自动跟随正在写入的文件；用户手动点选优先于默认的第一项
  const activePath =
    merged.find((file) => file.path === followPath)?.path ??
    merged.find((file) => file.path === selected)?.path ??
    (selected && drafts[selected] !== undefined ? selected : null) ??
    merged[0]?.path ??
    Object.keys(drafts)[0] ??
    null

  // 外部跳转（「去代码里改」）要选中目标文件并直接进编辑态 —— 用户点它的意图就是改
  useEffect(() => {
    if (!focusPath) return
    setSelected(focusPath)
    setEditing((prev) => (prev.includes(focusPath) ? prev : [...prev, focusPath]))
  }, [focusPath])

  const original = useMemo(() => new Map(files.map((file) => [file.path, file.content])), [files])
  const isDirty = (path: string) => drafts[path] !== undefined && drafts[path] !== original.get(path)

  const dirtyPaths = Object.keys(drafts).filter((path) => isDirty(path))
  const dirty = dirtyPaths.length > 0

  /** 文件列表 = 服务端/流式文件 + 仅存在于草稿里的新文件 */
  const list = useMemo(() => {
    const map = new Map<string, { path: string; content: string }>()
    for (const file of merged) map.set(file.path, { path: file.path, content: drafts[file.path] ?? file.content })
    for (const [path, content] of Object.entries(drafts)) {
      if (!map.has(path)) map.set(path, { path, content })
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path))
  }, [merged, drafts])

  const active = list.find((file) => file.path === activePath) ?? null
  /** 生成中正在写入的那个文件：树里给一个小动点，避免用户以为界面卡住了 */
  const writing = liveFiles?.find((file) => !file.done)?.path ?? null

  if (!active) {
    return (
      <Empty
        className="empty-block"
        description="还没有文件。生成完成后这里会出现完整的源码，也可以自己新建一个。"
      >
        <Button size="small" icon={<FileAddOutlined />} onClick={() => setAdding(true)}>
          新建文件
        </Button>
      </Empty>
    )
  }

  const isEditing = editing.includes(active.path)
  const buffer = drafts[active.path] ?? active.content

  const save = async () => {
    if (!onSave || !dirty) return
    const changes: FileChange[] = dirtyPaths.map((path) => ({ path, content: drafts[path] ?? '' }))
    const ok = await onSave(changes)
    if (ok) {
      // 保存成功后草稿不再是"草稿"：把它对齐到服务端内容，编辑态保留，光标不用重新找
      setDrafts((prev) => {
        const next = { ...prev }
        for (const change of changes) next[change.path] = change.content ?? ''
        return next
      })
    }
  }

  const stopEditing = (path: string) => {
    // 放弃改动 = 清掉草稿；已经有服务端内容的文件回到只读视图
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    setEditing((prev) => prev.filter((item) => item !== path))
  }

  const remove = async (path: string) => {
    if (!onSave) return
    const ok = await onSave([{ path, content: null }])
    if (!ok) return
    stopEditing(path)
    if (selected === path) setSelected(null)
    toast(`已删除 ${path}`)
  }

  const createFile = () => {
    const path = newPath.trim().replace(/^\/+/, '')
    if (!/^[A-Za-z0-9_\-./]+$/.test(path) || path.includes('..')) {
      toast('文件名只能包含字母、数字、下划线、连字符与 /')
      return
    }
    if (list.some((file) => file.path === path)) {
      toast('这个文件已经存在')
      return
    }
    setDrafts((prev) => ({ ...prev, [path]: '' }))
    setEditing((prev) => (prev.includes(path) ? prev : [...prev, path]))
    setSelected(path)
    setAdding(false)
  }

  return (
    <div className="code-shell">
      {/*
        左侧是真正的文件树（按 / 建目录、可折叠、图标分类型），
        不再是一列把完整路径印在页签上的平铺列表。
      */}
      <aside className="code-tree" aria-label="文件">
        <div className="code-tree-head">
          <span className="code-tree-title">文件</span>
          <span className="code-tree-count">{list.length}</span>
          <div className="spacer" />
          <Tooltip title="新建文件">
            <Button
              size="small"
              type="text"
              className="code-add"
              aria-label="新建文件"
              icon={<FileAddOutlined />}
              disabled={readOnly}
              onClick={() => {
                setNewPath('')
                setAdding(true)
              }}
            />
          </Tooltip>
        </div>
        <div className="code-tree-body">
          <FileTree
            paths={list.map((file) => file.path)}
            activePath={active.path}
            onSelect={setSelected}
            dirtyPaths={dirtyPaths}
            writingPath={writing}
          />
        </div>
      </aside>

      <div className="code-pane">
        <Flex className="code-head" align="center" gap={8}>
          <Text className="mono" ellipsis>
            {active.path}
          </Text>
          <div className="spacer" />
          <Text type="secondary" style={{ fontSize: 11.5 }} className="code-meta">
            {lineCount(buffer)} 行 · {bytes(new Blob([buffer]).size)}
          </Text>
          {isEditing ? (
            <>
              <Button size="small" type="text" icon={<UndoOutlined />} disabled={saving} onClick={() => stopEditing(active.path)}>
                放弃
              </Button>
              <Tooltip title="Ctrl / ⌘ + S">
                <Button
                  size="small"
                  type={isDirty(active.path) ? 'primary' : 'text'}
                  icon={<SaveOutlined />}
                  loading={saving}
                  disabled={!isDirty(active.path)}
                  onClick={() => void save()}
                >
                  保存
                </Button>
              </Tooltip>
            </>
          ) : (
            <>
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                onClick={async () => {
                  await copyText(buffer)
                  toast('已复制')
                }}
              >
                复制
              </Button>
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                disabled={readOnly}
                title={readOnly ? '生成中不能改文件' : undefined}
                onClick={() => {
                  setDrafts((prev) => (prev[active.path] !== undefined ? prev : { ...prev, [active.path]: active.content }))
                  setEditing((prev) => (prev.includes(active.path) ? prev : [...prev, active.path]))
                }}
              >
                编辑
              </Button>
            </>
          )}
          <Popconfirm
            title={`删除 ${active.path}？`}
            description="会立即生成一个新版本，可以回滚。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void remove(active.path)}
            disabled={readOnly}
          >
            <Button size="small" type="text" danger aria-label="删除文件" icon={<DeleteOutlined />} disabled={readOnly} />
          </Popconfirm>
        </Flex>

        <CodeEditor
          path={active.path}
          value={buffer}
          readOnly={readOnly || !isEditing}
          onSave={() => void save()}
          onChange={(next) => setDrafts((prev) => ({ ...prev, [active.path]: next }))}
        />
      </div>

      <Modal open={adding} title="新建文件" okText="创建" cancelText="取消" onCancel={() => setAdding(false)} onOk={createFile}>
        <Input
          autoFocus
          value={newPath}
          placeholder="例如 src/components/Card.tsx"
          onChange={(event) => setNewPath(event.target.value)}
          onPressEnter={createFile}
        />
      </Modal>
    </div>
  )
}
