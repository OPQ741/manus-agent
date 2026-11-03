import { useMemo, useState } from 'react'
import { Button, Empty, Flex, Space, Tabs, Typography } from 'antd'
import { CopyOutlined, FileTextOutlined } from '@ant-design/icons'
import type { FileEntry } from '../../shared/types'
import { highlight, langOf } from '../lib/highlight'
import { bytes, copyText, lineCount, shortPath } from '../lib/format'
import { toast } from './ui'

const { Text } = Typography

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
  // 生成中自动跟随正在写入的文件；用户手动点选优先于默认的第一项
  const active =
    merged.find((file) => file.path === followPath) ??
    merged.find((file) => file.path === selected) ??
    merged[0]

  if (!active) {
    return <Empty className="empty-block" description="还没有文件。生成完成后这里会出现完整的源码。" />
  }

  return (
    <div className="code-shell">
      {/* 左侧文件树用 Tabs 的垂直形态：键盘方向键可在文件间移动，省掉自己维护选中态的 focus 逻辑 */}
      <Tabs
        tabPosition="left"
        size="small"
        className="code-tabs"
        activeKey={active.path}
        onChange={(key) => setSelected(key)}
        items={merged.map((file) => ({
          key: file.path,
          label: (
            <Space size={6}>
              <FileTextOutlined />
              <span className="mono">{shortPath(file.path)}</span>
            </Space>
          ),
          children: (
            <div className="code-pane">
              <Flex className="code-head" align="center" gap={10}>
                <Text className="mono" ellipsis>
                  {file.path}
                </Text>
                <div className="spacer" />
                <Text type="secondary" style={{ fontSize: 11.5 }}>
                  {lineCount(file.content)} 行 · {bytes(new Blob([file.content]).size)}
                </Text>
                <Button
                  size="small"
                  type="text"
                  icon={<CopyOutlined />}
                  onClick={async () => {
                    await copyText(file.content)
                    toast('已复制')
                  }}
                >
                  复制
                </Button>
              </Flex>
              <div className="code-view">
                <pre>
                  <code dangerouslySetInnerHTML={{ __html: highlight(file.content, langOf(file.path)) }} />
                </pre>
              </div>
            </div>
          ),
        }))}
      />
    </div>
  )
}
