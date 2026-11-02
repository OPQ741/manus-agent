import { useEffect, useState } from 'react'
import type { ShareDetail } from '../../shared/types'
import { Logo, Spinner, IconDownload, IconExternal } from '../components/ui'
import { api, visitorId } from '../lib/api'
import { injectSeed, readSeed } from '../lib/seed'

/** 分享页只展示一个可读的作者标识，不暴露完整访客 ID。 */
function authorLabel(createdBy: string): string {
  if (!createdBy || createdBy === 'nucleus') return 'Nucleus 示例'
  if (createdBy === visitorId()) return '我'
  return `访客 ${createdBy.slice(0, 4)}`
}

export function SharePage({ slug }: { slug: string }) {
  const [data, setData] = useState<ShareDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .share(slug)
      .then((payload) => {
        if (!cancelled) setData(payload)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '分享链接不存在')
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  if (error) {
    return (
      <div className="share">
        <div className="share-bar">
          <Logo size={22} />
          <strong>Nucleus</strong>
        </div>
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontWeight: 600 }}>{error}</p>
            <a className="btn" href="#/">
              去 Nucleus 做一个
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="share">
      <div className="share-bar">
        <Logo size={22} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 620, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data?.project.name ?? '加载中…'}
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            {data
              ? `v${data.project.version} · ${data.project.fileCount} 个文件 · ${
                  data.project.engine === 'local' ? '本地引擎' : '云模型'
                } · 作者 ${authorLabel(data.project.createdBy)}`
              : ''}
          </div>
        </div>
        <div className="spacer" />
        {data ? (
          <>
            <a className="btn sm ghost" href={`#/studio/${data.project.id}`}>
              <IconExternal size={13} /> 在 Studio 中打开
            </a>
            <a className="btn sm" href={api.exportUrl(data.project.id)}>
              <IconDownload size={13} /> 导出
            </a>
          </>
        ) : (
          <Spinner />
        )}
      </div>
      <div className="share-frame">
        {data ? (
          <iframe
            title={data.project.name}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            srcDoc={injectSeed(data.html, readSeed(data.project.id))}
          />
        ) : null}
      </div>
    </div>
  )
}
