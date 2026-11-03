import { useEffect, useState } from 'react'
import { Button, Flex, Result, Space, Spin, Typography } from 'antd'
import { DownloadOutlined, ExportOutlined } from '@ant-design/icons'
import type { ShareDetail } from '../../shared/types'
import { Logo } from '../components/ui'
import { api, visitorId } from '../lib/api'
import { injectSeed, readSeed } from '../lib/seed'

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
            title={data.project.name}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
            srcDoc={injectSeed(data.html, readSeed(data.project.id))}
          />
        ) : null}
      </Flex>
    </div>
  )
}
