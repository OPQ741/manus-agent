import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BgColorsOutlined,
  CaretDownFilled,
  CodeOutlined,
  FileImageOutlined,
  FileMarkdownOutlined,
  FileOutlined,
  FileTextOutlined,
  FileZipOutlined,
  FolderFilled,
  FolderOpenFilled,
  Html5Outlined,
} from '@ant-design/icons'

/**
 * 文件树。
 *
 * 以前文件是一列平铺的页签：`src/components/home.jsx` 这种路径整条打印在一行里，
 * 五个文件以上就看不出目录结构，也分不清哪个是文件夹。这里按 `/` 建树、
 * 文件夹可折叠、文件夹和文件用不同图标与颜色区分。
 *
 * 折叠状态用「记折叠了谁」而不是「记展开了谁」：新生成的文件所在目录
 * 默认就是展开的，不需要额外同步。
 */

interface Branch {
  name: string
  path: string
  dir: boolean
  children: Branch[]
}

function buildTree(paths: string[]): Branch[] {
  const root: Branch = { name: '', path: '', dir: true, children: [] }

  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1
      const sub = parts.slice(0, index + 1).join('/')
      let child = node.children.find((item) => item.name === part && item.dir === !isFile)
      if (!child) {
        child = { name: part, path: sub, dir: !isFile, children: [] }
        node.children.push(child)
      }
      node = child
    })
  }

  const sort = (nodes: Branch[]) => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    for (const node of nodes) sort(node.children)
  }
  sort(root.children)
  return root.children
}

/** 文件图标按扩展名分色：一屏里靠颜色就能认出 html / 脚本 / 样式 */
function iconFor(name: string): { node: ReactNode; cls: string } {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  switch (ext) {
    case 'html':
    case 'htm':
      return { node: <Html5Outlined />, cls: 'ico-html' }
    case 'css':
    case 'scss':
    case 'less':
      return { node: <BgColorsOutlined />, cls: 'ico-css' }
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return { node: <CodeOutlined />, cls: 'ico-js' }
    case 'json':
      return { node: <FileTextOutlined />, cls: 'ico-json' }
    case 'md':
    case 'markdown':
      return { node: <FileMarkdownOutlined />, cls: 'ico-md' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return { node: <FileImageOutlined />, cls: 'ico-img' }
    case 'zip':
      return { node: <FileZipOutlined />, cls: 'ico-zip' }
    default:
      return { node: <FileOutlined />, cls: 'ico-plain' }
  }
}

interface Props {
  paths: string[]
  activePath: string | null
  onSelect: (path: string) => void
  /** 有未保存改动 / 正在写入的文件，会在树里带一个小圆点 */
  dirtyPaths?: string[]
  writingPath?: string | null
}

export function FileTree({ paths, activePath, onSelect, dirtyPaths = [], writingPath }: Props) {
  const tree = useMemo(() => buildTree(paths), [paths])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const dirty = useMemo(() => new Set(dirtyPaths), [dirtyPaths])

  // 打开的文件躲在折叠目录里时自动展开它 —— 从自检项「手动改」跳过来就靠这个
  useEffect(() => {
    if (!activePath) return
    const parts = activePath.split('/')
    setCollapsed((prev) => {
      let next: Set<string> | null = null
      for (let index = 1; index < parts.length; index += 1) {
        const dir = parts.slice(0, index).join('/')
        if (!prev.has(dir)) continue
        next ??= new Set(prev)
        next.delete(dir)
      }
      return next ?? prev
    })
  }, [activePath])

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderNodes = (nodes: Branch[], depth: number): ReactNode[] =>
    nodes.flatMap((node) => {
      const indent = { paddingLeft: 8 + depth * 13 }
      if (node.dir) {
        const open = !collapsed.has(node.path)
        return [
          <button
            key={node.path}
            type="button"
            className={`tree-row tree-dir${open ? ' is-open' : ''}`}
            style={indent}
            aria-expanded={open}
            onClick={() => toggle(node.path)}
          >
            <CaretDownFilled className="tree-caret" />
            {open ? <FolderOpenFilled className="tree-ico ico-dir" /> : <FolderFilled className="tree-ico ico-dir" />}
            <span className="tree-name">{node.name}</span>
          </button>,
          ...(open ? renderNodes(node.children, depth + 1) : []),
        ]
      }

      const { node: icon, cls } = iconFor(node.name)
      const active = node.path === activePath
      return [
        <button
          key={node.path}
          type="button"
          className={`tree-row tree-file${active ? ' is-on' : ''}`}
          style={indent}
          title={node.path}
          aria-current={active ? 'true' : undefined}
          onClick={() => onSelect(node.path)}
        >
          <span className="tree-caret-space" />
          <span className={`tree-ico ${cls}`}>{icon}</span>
          <span className="tree-name">{node.name}</span>
          {writingPath === node.path ? <span className="tree-writing" title="正在写入" /> : null}
          {dirty.has(node.path) ? <span className="code-dirty" title="有未保存的改动" /> : null}
        </button>,
      ]
    })

  return <div className="tree-rows">{renderNodes(tree, 0)}</div>
}
