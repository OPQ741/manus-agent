import { useMemo } from 'react'
import { Button, Card, Empty, Flex, Space, Typography } from 'antd'
import { HistoryOutlined } from '@ant-design/icons'
import type { Version } from '../../shared/types'
import { diffFiles } from '../lib/diff'
import { formatTime } from '../lib/format'
import { Badge } from './ui'

const { Text } = Typography

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
    return <Empty className="empty-block" description="还没有版本。每完成一次生成，就会在这里留下一个可回滚的快照。" />
  }

  return (
    <Space direction="vertical" size={10} className="version-list">
      {enriched.map(({ version, diffs }) => {
        const added = diffs.reduce((sum, item) => sum + item.added, 0)
        const removed = diffs.reduce((sum, item) => sum + item.removed, 0)
        const isCurrent = version.seq === current
        const interrupted = version.label.startsWith('中断保留')

        return (
          <Card
            key={version.id}
            size="small"
            className={`version-item${isCurrent ? ' current' : ''}`}
            title={
              <Flex align="center" gap={8} wrap>
                <Badge tone="accent">v{version.seq}</Badge>
                <Text strong style={{ fontSize: 13 }}>
                  {version.label}
                </Text>
                {isCurrent ? <Badge tone="ok">当前</Badge> : null}
                {interrupted ? <Badge tone="warn">中断</Badge> : null}
              </Flex>
            }
            extra={
              isCurrent ? null : (
                <Button size="small" icon={<HistoryOutlined />} disabled={busy} onClick={() => onRollback(version.seq)}>
                  回滚
                </Button>
              )
            }
          >
            <Flex vertical gap={6}>
              <Text type="secondary" style={{ fontSize: 11.5 }}>
                {formatTime(version.createdAt)} · {version.files.length} 个文件
                {diffs.length > 0 ? ` · 变更 ${diffs.length} 个` : ''}
                {added || removed ? (
                  <>
                    {' · '}
                    <span className="diff-add">+{added}</span> <span className="diff-del">−{removed}</span>
                  </>
                ) : null}
              </Text>
              {version.prompt ? (
                <Text type="secondary" italic ellipsis={{ tooltip: version.prompt }} style={{ fontSize: 11.5 }}>
                  “{version.prompt}”
                </Text>
              ) : null}
              {diffs.length > 0 ? (
                <Flex wrap gap={5}>
                  {diffs.map((diff) => (
                    <Badge key={diff.path} className="diff-file" title={`${diff.status} +${diff.added} −${diff.removed}`}>
                      <span className="mono">{diff.path}</span>
                      {diff.status === 'added' ? <span className="diff-add"> 新增</span> : null}
                      {diff.status === 'removed' ? <span className="diff-del"> 删除</span> : null}
                    </Badge>
                  ))}
                </Flex>
              ) : null}
            </Flex>
          </Card>
        )
      })}
    </Space>
  )
}
