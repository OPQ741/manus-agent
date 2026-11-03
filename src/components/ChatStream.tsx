import { useEffect, useRef } from 'react'
import { Card, Flex, Space, Spin, Typography } from 'antd'
import { CheckCircleFilled, ExclamationCircleFilled, FileTextOutlined, LoadingOutlined } from '@ant-design/icons'
import type { Check, Message, Plan } from '../../shared/types'
import { Badge } from './ui'

const { Text } = Typography

export interface LiveFile {
  path: string
  content: string
  lines: number
  done: boolean
}

export interface LiveState {
  running: boolean
  stage: 'plan' | 'write' | 'verify' | null
  plan: Plan | null
  files: LiveFile[]
  checks: Check[]
  warnings: string[]
  note: string
  /** 服务端的过程性提示：排队等免 Key 配额、换了一家模型重试… */
  notice: { level: 'info' | 'warn'; text: string } | null
}

export const EMPTY_LIVE: LiveState = {
  running: false,
  stage: null,
  plan: null,
  files: [],
  checks: [],
  warnings: [],
  note: '',
  notice: null,
}

const STAGE_LABEL: Record<string, string> = { plan: '拆解需求', write: '编写代码', verify: '静态自检' }

function readPlan(meta: Record<string, unknown> | undefined): Plan | null {
  const plan = meta?.plan
  if (plan && typeof plan === 'object' && typeof (plan as Plan).name === 'string') return plan as Plan
  return null
}

/** 自检结果统一渲染成一组语义标签，对话流与预览工具栏复用同一种表达。 */
export function CheckTags({ checks }: { checks: Check[] }) {
  return (
    <Flex wrap gap={6} className="check-list">
      {checks.map((check) => (
        <Badge
          key={check.id}
          tone={check.ok ? 'ok' : check.level === 'block' ? 'danger' : 'warn'}
          title={check.detail}
        >
          <Space size={4}>
            {check.ok ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
            {check.label}
          </Space>
        </Badge>
      ))}
    </Flex>
  )
}

export function PlanCard({ plan }: { plan: Plan }) {
  return (
    <Card
      size="small"
      className="plan-card"
      title={
        <Space size={8}>
          <Badge tone="accent">方案</Badge>
          <Text strong>{plan.name}</Text>
        </Space>
      }
    >
      {plan.summary ? (
        <Text type="secondary" style={{ fontSize: 12.5 }}>
          {plan.summary}
        </Text>
      ) : null}
      {plan.steps.length > 0 ? (
        <ol className="plan-steps">
          {plan.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : null}
      {plan.files.length > 0 ? (
        <Flex wrap gap={5}>
          {plan.files.map((file) => (
            <Badge key={file.path}>{file.path}</Badge>
          ))}
        </Flex>
      ) : null}
      <Text type="secondary" className="mono" style={{ fontSize: 11.5 }}>
        {plan.stack}
      </Text>
    </Card>
  )
}

function LiveBlock({ live }: { live: LiveState }) {
  return (
    <div className="msg agent">
      <span className="who">Nucleus Agent</span>
      {live.stage ? (
        <Space size={6} className="stage-pill">
          <Spin indicator={<LoadingOutlined spin />} size="small" />
          <Text type="secondary" style={{ fontSize: 12 }}>
            正在{STAGE_LABEL[live.stage] ?? live.stage}
          </Text>
        </Space>
      ) : null}

      {live.plan ? <PlanCard plan={live.plan} /> : null}

      {live.files.length > 0 ? (
        <Space direction="vertical" size={4} className="file-stream">
          {live.files.map((file) => (
            <Flex key={file.path} align="center" gap={7} className={`file-line${file.done ? '' : ' active'}`}>
              {file.done ? (
                <CheckCircleFilled style={{ color: 'var(--ok)' }} />
              ) : (
                <Spin indicator={<LoadingOutlined spin />} size="small" />
              )}
              <FileTextOutlined style={{ opacity: 0.5 }} />
              <Text className="mono" style={{ fontSize: 12 }}>
                {file.path}
              </Text>
              <Text type="secondary" style={{ fontSize: 11.5 }}>
                {file.done ? `${file.lines} 行` : '写入中…'}
              </Text>
            </Flex>
          ))}
        </Space>
      ) : null}

      {live.notice ? (
        <Text className={`run-notice ${live.notice.level}`} role="status">
          {live.notice.text}
        </Text>
      ) : null}
      {live.note ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {live.note}
        </Text>
      ) : null}
      {live.checks.length > 0 ? <CheckTags checks={live.checks} /> : null}
      {live.warnings.length > 0 ? (
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          {live.warnings.length} 条解析提示：{live.warnings[0]}
        </Text>
      ) : null}
    </div>
  )
}

function AgentMessage({ message }: { message: Message }) {
  const plan = readPlan(message.meta)
  const checks = message.meta?.checks
  return (
    <div className={`msg agent${message.kind === 'error' ? ' error' : ''}`}>
      <span className="who">{message.kind === 'error' ? '运行时' : 'Nucleus Agent'}</span>
      {plan ? <PlanCard plan={plan} /> : null}
      <div className="bubble">{message.content}</div>
      {Array.isArray(checks) && checks.length > 0 ? <CheckTags checks={checks as Check[]} /> : null}
    </div>
  )
}

export function ChatStream({ messages, live, pendingUser }: { messages: Message[]; live: LiveState; pendingUser: string | null }) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, live.files.length, live.stage, pendingUser])

  return (
    <div className="chat-scroll">
      {messages.length === 0 && !pendingUser ? (
        <Text type="secondary" style={{ fontSize: 12.5 }}>
          描述你想要的应用，Agent 会先给方案再动手。
        </Text>
      ) : null}

      {messages.map((message) =>
        message.role === 'user' ? (
          <div key={message.id} className="msg user">
            <div className="bubble">{message.content}</div>
          </div>
        ) : (
          <AgentMessage key={message.id} message={message} />
        ),
      )}

      {pendingUser ? (
        <div className="msg user">
          <div className="bubble pending">{pendingUser}</div>
        </div>
      ) : null}

      {live.running || live.files.length > 0 ? <LiveBlock live={live} /> : null}

      <div ref={endRef} />
    </div>
  )
}
