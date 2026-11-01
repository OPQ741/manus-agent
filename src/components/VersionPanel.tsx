import { useMemo } from 'react'
import type { Version } from '../../shared/types'
import { diffFiles } from '../lib/diff'
import { formatTime } from '../lib/format'
import { IconHistory } from './ui'

interface Props {
  versions: Version[]
  current: number
  onRollback: (seq: number) => void
  busy: boolean
}

export function VersionPanel({ versions, current, onRollback, busy }: Props) {
  const enriched = useMemo(
    () =>
      versions.map((version, index) => {
        const older = versions[index + 1]
        const diffs = older ? diffFiles(older.files, version.files) : []
        return { version, diffs }
      }),
    [versions],
  )

  if (versions.length === 0) {
    return (
      <div className="empty-block" style={{ margin: 'auto' }}>
        还没有版本。每完成一次生成，就会在这里留下一个可回滚的快照。
      </div>
    )
  }

  return (
    <div className="timeline">
      {enriched.map(({ version, diffs }) => {
        const added = diffs.reduce((sum, item) => sum + item.added, 0)
        const removed = diffs.reduce((sum, item) => sum + item.removed, 0)
        return (
          <article key={version.id} className={`version-item${version.seq === current ? ' current' : ''}`}>
            <div className="version-seq">v{version.seq}</div>
            <div className="version-body">
              <div className="row" style={{ gap: 8 }}>
                <h5>{version.label}</h5>
                {version.seq === current ? <span className="badge accent">当前</span> : null}
                <div className="spacer" />
                {version.seq !== current ? (
                  <button className="btn sm" disabled={busy} onClick={() => onRollback(version.seq)}>
                    <IconHistory size={13} /> 回滚
                  </button>
                ) : null}
              </div>
              <span className="meta">
                {formatTime(version.createdAt)} · {version.files.length} 个文件
                {diffs.length > 0 ? ` · 变更 ${diffs.length} 个` : ''}
                {added || removed ? (
                  <>
                    {' · '}
                    <span className="diff-add">+{added}</span> <span className="diff-del">−{removed}</span>
                  </>
                ) : null}
              </span>
              {version.prompt ? (
                <span className="meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  “{version.prompt}”
                </span>
              ) : null}
              {diffs.length > 0 ? (
                <div className="version-changes">
                  {diffs.map((diff) => (
                    <span key={diff.path} className="diff-file" title={`${diff.status} +${diff.added} −${diff.removed}`}>
                      {diff.path}
                      {diff.status === 'added' ? <span className="diff-add"> 新增</span> : null}
                      {diff.status === 'removed' ? <span className="diff-del"> 删除</span> : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </article>
        )
      })}
    </div>
  )
}
