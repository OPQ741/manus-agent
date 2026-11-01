import { useMemo, useState } from 'react'
import type { Check } from '../../shared/types'
import { injectSeed, readSeed } from '../lib/seed'
import {
  IconAlert,
  IconDesktop,
  IconExternal,
  IconMobile,
  IconRefresh,
  IconShare,
  IconTablet,
  toast,
} from './ui'

type Device = 'desktop' | 'tablet' | 'mobile'

interface Props {
  projectId: string
  html: string
  checks: Check[]
  errors: string[]
  onHeal: () => void
  onRefresh: () => void
  shareUrl: string | null
}

export function PreviewPanel({ projectId, html, checks, errors, onHeal, onRefresh, shareUrl }: Props) {
  const [device, setDevice] = useState<Device>('desktop')
  const [nonce, setNonce] = useState(0)

  const srcDoc = useMemo(() => injectSeed(html, readSeed(projectId)), [html, projectId, nonce])

  const blocking = checks.find((check) => check.level === 'block' && !check.ok)

  const openStandalone = () => {
    try {
      const blob = new Blob([srcDoc], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      toast('打开失败，请先让 Agent 生成内容')
    }
  }

  return (
    <>
      {errors.length > 0 ? (
        <div className="error-banner" role="alert">
          <IconAlert size={15} />
          <span>
            检测到 {errors.length} 个运行时错误：<span className="mono">{errors[0]?.slice(0, 90)}</span>
          </span>
          <button className="btn sm primary" onClick={onHeal}>
            让 Agent 修复
          </button>
        </div>
      ) : null}

      <div className="preview-shell">
        <div className="preview-toolbar">
          <div className="segmented" role="group" aria-label="视口">
            <button aria-pressed={device === 'desktop'} onClick={() => setDevice('desktop')} aria-label="桌面">
              <IconDesktop size={14} />
            </button>
            <button aria-pressed={device === 'tablet'} onClick={() => setDevice('tablet')} aria-label="平板">
              <IconTablet size={14} />
            </button>
            <button aria-pressed={device === 'mobile'} onClick={() => setDevice('mobile')} aria-label="手机">
              <IconMobile size={14} />
            </button>
          </div>
          <div className="url-pill">
            <span className="dot" style={{ color: '#3bb273' }} />
            nucleus://preview/{projectId}
          </div>
          <button
            className="btn sm ghost"
            onClick={() => {
              setNonce((value) => value + 1)
              onRefresh()
            }}
            aria-label="重新加载预览"
          >
            <IconRefresh size={14} />
          </button>
          <button className="btn sm ghost" onClick={openStandalone} aria-label="在新窗口打开">
            <IconExternal size={14} />
          </button>
          <button
            className="btn sm ghost"
            disabled={!shareUrl}
            onClick={async () => {
              if (!shareUrl) return
              try {
                await navigator.clipboard.writeText(shareUrl)
                toast('分享链接已复制')
              } catch {
                toast(shareUrl)
              }
            }}
            aria-label="复制分享链接"
          >
            <IconShare size={14} />
          </button>
        </div>

        {html ? (
          <div className={`frame-wrap device-${device}`}>
            <iframe
              key={nonce}
              title="应用预览"
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              srcDoc={srcDoc}
            />
          </div>
        ) : (
          <div className="preview-empty">
            <div>
              <p style={{ margin: '0 0 6px', fontWeight: 600, color: 'var(--ink)' }}>还没有可预览的内容</p>
              <p style={{ margin: 0 }}>{blocking?.detail ?? '先在左侧描述你要的应用，Agent 会生成入口文件。'}</p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
