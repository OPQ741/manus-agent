import { useMemo, useState } from 'react'
import type { FileEntry } from '../../shared/types'
import { highlight, langOf } from '../lib/highlight'
import { bytes, lineCount, shortPath } from '../lib/format'
import { copyText } from '../lib/format'
import { IconCopy, IconFile, toast } from './ui'

interface Props {
  files: FileEntry[]
  liveFiles?: { path: string; content: string; done: boolean }[]
  followPath?: string | null
}

export function CodePanel({ files, liveFiles, followPath }: Props) {
  const merged = useMemo(() => {
    const map = new Map<string, string>()
    for (const file of files) map.set(file.path, file.content)
    for (const file of liveFiles ?? []) map.set(file.path, file.content)
    return [...map.entries()].map(([path, content]) => ({ path, content })).sort((a, b) => a.path.localeCompare(b.path))
  }, [files, liveFiles])

  const [selected, setSelected] = useState<string | null>(null)
  const activePath = followPath && merged.some((file) => file.path === followPath) ? followPath : selected ?? merged[0]?.path ?? null
  const active = merged.find((file) => file.path === activePath) ?? null

  if (merged.length === 0) {
    return (
      <div className="empty-block" style={{ margin: 'auto' }}>
        还没有文件。生成完成后这里会出现完整的源码。
      </div>
    )
  }

  return (
    <div className="code-shell">
      <div className="file-tree" role="tablist" aria-label="文件列表">
        {merged.map((file) => (
          <button
            key={file.path}
            role="tab"
            aria-current={file.path === activePath}
            onClick={() => setSelected(file.path)}
          >
            <IconFile size={13} />
            {shortPath(file.path)}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="code-head">
          <span className="mono">{active?.path}</span>
          <span className="spacer" />
          <span>{active ? `${lineCount(active.content)} 行 · ${bytes(new Blob([active.content]).size)}` : ''}</span>
          <button
            className="btn sm ghost"
            onClick={async () => {
              if (!active) return
              await copyText(active.content)
              toast('已复制')
            }}
          >
            <IconCopy size={13} /> 复制
          </button>
        </div>
        <div className="code-view">
          <pre>
            <code
              dangerouslySetInnerHTML={{
                __html: active ? highlight(active.content, langOf(active.path)) : '',
              }}
            />
          </pre>
        </div>
      </div>
    </div>
  )
}
