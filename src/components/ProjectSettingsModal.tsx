import { useEffect, useState } from 'react'
import { Button, Flex, Form, Input, Modal, Space, Typography } from 'antd'
import { CopyOutlined, LinkOutlined } from '@ant-design/icons'
import type { Project } from '../../shared/types'
import { Badge, toast } from './ui'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'

const { Text } = Typography

/**
 * 项目设置弹窗。
 *
 * 为什么从"就地改名"换成弹窗：标题右边只有一个铅笔图标的位置，
 * 塞得下重命名，塞不下"这句话是干什么的"（简介）和分享链接 ——
 * 而这两项恰恰是项目详情里最该被编辑的部分。就地编辑还会让顶栏
 * 在输入态里跳高 4px，整个工作台跟着抖一下。
 *
 * 弹窗只改**元信息**（名字 / 简介），代码与版本不在这里动：
 * 那些要走对话，否则"我在这改了什么"会变得不可追溯。
 */
export function ProjectSettingsModal({
  open,
  project,
  shareUrl,
  onClose,
  onSaved,
}: {
  open: boolean
  project: Project
  shareUrl: string
  onClose: () => void
  onSaved: (project: Project) => void
}) {
  const [name, setName] = useState(project.name)
  const [summary, setSummary] = useState(project.summary)
  const [saving, setSaving] = useState(false)

  // 每次打开都以最新的项目状态为准：上一次取消留下的草稿不该粘住
  useEffect(() => {
    if (!open) return
    setName(project.name)
    setSummary(project.summary)
  }, [open, project.name, project.summary])

  const dirty = name.trim() !== project.name || summary.trim() !== project.summary

  const save = async () => {
    const nextName = name.trim()
    if (!nextName) {
      toast('名称不能为空')
      return
    }
    setSaving(true)
    try {
      const { project: updated } = await api.updateProject(project.id, { name: nextName, summary: summary.trim() })
      onSaved(updated)
      toast('已保存')
      onClose()
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast('分享链接已复制')
    } catch {
      toast(shareUrl)
    }
  }

  return (
    <Modal
      open={open}
      title="项目设置"
      okText="保存"
      cancelText="取消"
      onOk={() => void save()}
      onCancel={onClose}
      confirmLoading={saving}
      okButtonProps={{ disabled: !dirty }}
      destroyOnClose
      width={480}
    >
      <Form layout="vertical" requiredMark={false} className="project-form">
        <Form.Item label="名称" extra="显示在顶栏与首页卡片上，最多 40 字。">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            showCount
            autoFocus
            placeholder="比如：随手记账"
          />
        </Form.Item>

        <Form.Item
          label="一句话简介"
          extra={
            <Flex align="center" gap={6} wrap>
              <span>首页卡片上的一句话说明，最多 140 字。</span>
              {project.plan?.summary ? (
                <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => setSummary(project.plan?.summary ?? '')}>
                  用方案摘要填入
                </Button>
              ) : null}
            </Flex>
          }
        >
          <Input.TextArea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={140}
            showCount
            placeholder="这个应用是给谁、解决什么问题的"
          />
        </Form.Item>

        <Form.Item label="分享链接" extra="任何人打开都能看到当前版本，只读。">
          <Space.Compact style={{ width: '100%' }}>
            <Input value={shareUrl} readOnly prefix={<LinkOutlined />} onFocus={(event) => event.target.select()} />
            <Button icon={<CopyOutlined />} onClick={() => void copy()}>
              复制
            </Button>
          </Space.Compact>
        </Form.Item>
      </Form>

      <div className="project-form-meta">
        <Badge tone="accent">v{project.version}</Badge>
        <Badge>{project.files.length} 个文件</Badge>
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          更新于 {timeAgo(project.updatedAt)}
        </Text>
      </div>
    </Modal>
  )
}
