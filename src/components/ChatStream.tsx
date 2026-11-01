import { useEffect, useRef } from 'react'
import type { Check, Message, Plan } from '../../shared/types'
import { IconAlert, IconCheck, IconFile, Spinner } from './ui'

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
}

export const EMPTY_LIVE: LiveState = {
  running: false,
  stage: null,
  plan: null,
  files: [],
  checks: [],
  warnings: [],
  note: '',
}

function readPlan(meta: Record<string, unknown> | undefined): Plan | null {
  const plan = meta?.plan
  if (plan && typeof plan === 'object' && typeof (plan as Plan).name === 'string') return plan as Plan
  return null
}

export function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div className="plan-card">
      <header>
        <span className="badge accent">方案</span>
        <h4>{plan.name}</h4>
      </header>
      {plan.summary ? <p className="summary">{plan.summary}</p> : null}
      {plan.steps.length > 0 ? (
        <ol className="plan-steps">
          {plan.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      ) : null}
      {plan.files.length > 0 ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 5 }}>
          {plan.files.map((file) => (
            <span key={file.path} className="diff-file">
              {file.path}
            </span>
          ))}
        </div>
      ) : null}
      <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
        {plan.stack}
      </p>
    </div>
  )
}

function StagePill({ stage }: { stage: LiveState['stage'] }) {
  const labels: Record<string, string> = { plan: '拆解需求', write: '编写代码', verify: '静态自检' }
  if (!stage) return null
  return (
    <span className="stage-pill">
      <Spinner /> 正在<b>{labels[stage] ?? stage}</b>
    </span>
  )
}

function LiveBlock({ live }: { live: LiveState }) {
  return (
    <div className="msg agent">
      <span className="who">Nucleus Agent</span>
      <StagePill stage={live.stage} />
      {live.plan ? <PlanCard plan={live.plan} /> : null}
      {live.files.length > 0 ? (
        <div className="file-stream">
          {live.files.map((file) => (
            <div key={file.path} className={`file-line${!file.done ? ' active' : ''}`}>
              {file.done ? <IconCheck size={13} /> : <Spinner />}
              <span className="name">{file.path}</span>
              <span className="meta">{file.lines ? `${file.lines} 行` : '写入中…'}</span>
            </div>
          ))}
        </div>
      ) : null}
      {live.note ? <p className="muted" style={{ margin: 0, fontSize: 12 }}>{live.note}</p> : null}
      {live.checks.length > 0 ? (
        <div className="check-list">
          {live.checks.map((check) => (
            <span key={check.id} className={`badge ${check.ok ? 'ok' : check.level === 'block' ? 'danger' : 'warn'}`}>
              {check.ok ? <IconCheck size={11} /> : <IconAlert size={11} />}
              {check.label}
            </span>
          ))}
        </div>
      ) : null}
      {live.warnings.length > 0 ? (
        <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
          {live.warnings.length} 条解析提示：{live.warnings[0]}
        </p>
      ) : null}
    </div>
  )
}

interface Props {
  messages: Message[]
  live: LiveState
  pendingUser: string | null
}

export function ChatStream({ messages, live, pendingUser }: Props) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, live.files.length, live.stage, pendingUser])

  return (
    <div className="chat-scroll">
      {messages.length === 0 && !pendingUser ? (
        <div className="muted" style={{ fontSize: 12.5, padding: '4px 4px 0' }}>
          描述你想要的应用，Agent 会先给方案再动手。
        </div>
      ) : null}

      {messages.map((message) => {
        if (message.role === 'user') {
          return (
            <div key={message.id} className="msg user">
              <div className="bubble">{message.content}</div>
            </div>
          )
        }
        if (message.kind === 'error') {
          return (
            <div key={message.id} className="msg agent error">
              <span className="who">运行时</span>
              <div className="bubble">{message.content}</div>
            </div>
          )
        }
        const plan = readPlan(message.meta)
        return (
          <div key={message.id} className="msg agent">
            <span className="who">Nucleus Agent</span>
            {plan ? <PlanCard plan={plan} /> : null}
            <div className="bubble">{message.content}</div>
            {(() => {
              const checks = message.meta?.checks
              if (!Array.isArray(checks) || checks.length === 0) return null
              return (
                <div className="check-list">
                  {(checks as Check[]).map((check) => (
                    <span
                      key={check.id}
                      className={`badge ${check.ok ? 'ok' : check.level === 'block' ? 'danger' : 'warn'}`}
                      title={check.detail}
                    >
                      {check.ok ? <IconCheck size={11} /> : <IconAlert size={11} />}
                      {check.label}
                    </span>
                  ))}
                </div>
              )
            })()}
          </div>
        )
      })}

      {pendingUser ? (
        <div className="msg user">
          <div className="bubble" style={{ opacity: 0.75 }}>
            {pendingUser}
          </div>
        </div>
      ) : null}

      {live.running || live.files.length > 0 ? <LiveBlock live={live} /> : null}

      <div ref={endRef} />
    </div>
  )
}

export { IconFile }
