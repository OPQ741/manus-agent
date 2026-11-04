import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Flex, Result, Space, Spin, Typography } from 'antd'
import { DownloadOutlined, ExportOutlined } from '@ant-design/icons'
import type { ShareDetail } from '../../shared/types'
import { Logo } from '../components/ui'
import { api, visitorId } from '../lib/api'
import { applyStorageMessage, injectSeed, readSeed } from '../lib/seed'

const { Text } = Typography

/** 分享页只展示一个可读的作者标识，不暴露完整访客 ID。 */
function authorLabel(createdBy: string): string {
  if (!createdBy || createdBy === 'nucleus') return 'Nucleus 示例'
  if (createdBy === visitorId()) return '我'
  return `访客 ${createdBy.slice(0, 4)}`
}

export function SharePage({ slug }: { slug: string }) {
  const [data, setData] = useState<ShareDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)

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

  /**
   * 生成物的持久化闭环。
   *
   * 预览 iframe 是不透明源（sandbox 没有 allow-same-origin），生成物写存储会被
   * 桥接脚本转成 postMessage 发给父页面，由父页面替它落盘。Studio 早就接了这个口
   * （Studio.tsx 的 onMessage），分享页一直没接 —— 于是"分享页里新增一条记录，
   * 刷新就回到初始数据"。这里把同一套接收端补上。
   *
   * 刻意只落盘、不 setState：srcDoc 一旦重新计算，React 就会重载 iframe，
   * 应用内的输入内容、已填表单、滚动位置全部丢失。刷新页面时才重新读 seed。
   */
  useEffect(() => {
    const projectId = data?.project.id
    if (!projectId) return
    const onMessage = (event: MessageEvent) => {
      const payload = event.data as { __nucleus?: number; kind?: string } | null
      if (!payload || payload.__nucleus !== 1 || payload.kind !== 'storage') return
      // 分享页是公开页面，任何窗口都能 postMessage 过来：只认自己那个 iframe
      if (event.source !== frameRef.current?.contentWindow) return
      applyStorageMessage(projectId, payload as { op: 'set' | 'remove' | 'clear'; key?: string; value?: string })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [data?.project.id])

  /** 只算一次：种子是"打开这个页面时的状态"，不该随任何重渲染变化 */
  const srcDoc = useMemo(() => (data ? injectSeed(data.html, readSeed(data.project.id)) : ''), [data])

  if (error) {
    return (
      <div className="share">
        <div className="share-bar">
          <Logo size={22} />
          <Text strong>Nucleus</Text>
        </div>
        <Result
          status="warning"
          title={error}
          extra={
            <Button type="primary" href="#/">
              去 Nucleus 做一个
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="share">
      <div className="share-bar">
        <Logo size={22} />
        <div style={{ minWidth: 0 }}>
          <Text strong ellipsis style={{ fontSize: 13.5, display: 'block' }}>
            {data?.project.name ?? '加载中…'}
          </Text>
          <Text type="secondary" style={{ fontSize: 11.5 }}>
            {data
              ? `v${data.project.version} · ${data.project.fileCount} 个文件 · ${
                  data.project.providerLabel || '模型生成'
                } · 作者 ${authorLabel(data.project.createdBy)}`
              : ''}
          </Text>
        </div>
        <div className="spacer" />
        {data ? (
          <Space size={6}>
            <Button size="small" type="text" href={`#/studio/${data.project.id}`} icon={<ExportOutlined />}>
              在 Studio 中打开
            </Button>
            <Button size="small" icon={<DownloadOutlined />} href={api.exportUrl(data.project.id)}>
              导出
            </Button>
          </Space>
        ) : (
          <Spin />
        )}
      </div>
      <Flex className="share-frame" justify="center">
        {data ? (
          <iframe
            ref={frameRef}
            title={data.project.name}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            srcDoc={srcDoc}
          />
        ) : null}
      </Flex>
    </div>
  )
}
