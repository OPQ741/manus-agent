import { useEffect } from 'react'
import { App as AntdApp, Tag } from 'antd'
import {
  BugOutlined,
  CodeOutlined,
  CompassOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons'

/* --------------------------------- Logo --------------------------------- */

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="nucleus-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6A5CFF" />
          <stop offset="100%" stopColor="#4B3BFF" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="5.2" fill="url(#nucleus-g)" />
      <ellipse cx="16" cy="16" rx="13" ry="5.6" stroke="#B9B1FF" strokeWidth="1.3" fill="none" />
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="5.6"
        stroke="#B9B1FF"
        strokeWidth="1.3"
        fill="none"
        transform="rotate(60 16 16)"
      />
      <ellipse
        cx="16"
        cy="16"
        rx="13"
        ry="5.6"
        stroke="#B9B1FF"
        strokeWidth="1.3"
        fill="none"
        transform="rotate(120 16 16)"
      />
    </svg>
  )
}

/* ------------------------------ Agent 头像 ------------------------------ */

/**
 * 对话里的"谁在说话"。
 *
 * 生成过程其实有四个角色在同一轮里交替出现：规划（给方案）、编码（写文件）、
 * 自检（跑静态校验）、运行时（预览里的报错）。以前它们全都叫 "Nucleus Agent"，
 * 一段长输出读下来分不清哪句是判断、哪句是结果。用头像 + 角色色把这件事
 * 变成"一眼扫过去"就能分辨的视觉信号 —— 和 CLI Agent（Claude Code / Codex）
 * 打印 [plan] / [write] / [check] 是同一种信息设计。
 */
export type AgentRole = 'user' | 'agent' | 'planner' | 'coder' | 'verifier' | 'runtime' | 'model'

const ROLES: Record<AgentRole, { label: string; icon: React.ReactNode; bg: string }> = {
  user: { label: '你', icon: <UserOutlined />, bg: 'linear-gradient(135deg, #7A6BFF, #4B3BFF)' },
  agent: { label: 'Nucleus Agent', icon: null, bg: 'linear-gradient(135deg, #2A2A3A, #14141A)' },
  planner: { label: '规划', icon: <CompassOutlined />, bg: 'linear-gradient(135deg, #9B7BFF, #6C4BF5)' },
  coder: { label: '编码', icon: <CodeOutlined />, bg: 'linear-gradient(135deg, #4FA8FF, #2563C9)' },
  verifier: { label: '自检', icon: <SafetyCertificateOutlined />, bg: 'linear-gradient(135deg, #2FBF95, #0F7A5A)' },
  runtime: { label: '运行时', icon: <BugOutlined />, bg: 'linear-gradient(135deg, #E1677F, #C2405C)' },
  model: { label: '模型', icon: <ThunderboltOutlined />, bg: 'linear-gradient(135deg, #E0A44A, #A9651F)' },
}

export function AgentAvatar({ role, size = 24, title }: { role: AgentRole; size?: number; title?: string }) {
  const meta = ROLES[role]
  const radius = Math.max(6, Math.round(size * 0.32))
  return (
    <span
      className={`agent-avatar role-${role}`}
      style={{ width: size, height: size, borderRadius: radius, background: meta.bg, fontSize: Math.round(size * 0.52) }}
      title={title ?? meta.label}
      aria-label={meta.label}
      role="img"
    >
      {/* Agent 本人用品牌 Logo，其余角色用图标 —— 主控与执行者不能长得一样 */}
      {role === 'agent' ? <Logo size={Math.round(size * 0.74)} /> : meta.icon}
    </span>
  )
}

/* --------------------------------- Badge -------------------------------- */

const TONES = { plain: undefined, accent: 'geekblue', ok: 'green', warn: 'orange', danger: 'red' } as const

export type Tone = keyof typeof TONES

/**
 * 语义标签。保留 `badge` 这个类名是因为 e2e 用它做观测面（`.project-card .badge`），
 * 视觉全部交给 antd Tag，样式不再手写。
 */
export function Badge({
  tone = 'plain',
  title,
  children,
  className,
}: {
  tone?: Tone
  title?: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <Tag
      bordered={false}
      color={TONES[tone]}
      title={title}
      className={['badge', tone === 'plain' ? '' : tone, className].filter(Boolean).join(' ')}
    >
      {children}
    </Tag>
  )
}

/* --------------------------------- Toast -------------------------------- */

/**
 * 全局提示仍然只暴露 `toast(text)` 一个函数：二十多处调用点不必都拿到 hooks，
 * 由 ToastHost 在 App 内把它接到 antd 的 message 实例上。
 */
let sink: ((text: string) => void) | null = null

export function toast(text: string) {
  if (sink) sink(text)
}

export function ToastHost() {
  const { message } = AntdApp.useApp()

  useEffect(() => {
    sink = (text) => {
      void message.open({ content: text, duration: 2.4 })
    }
    return () => {
      sink = null
    }
  }, [message])

  return null
}
