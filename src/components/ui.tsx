import { useEffect } from 'react'
import { App as AntdApp, Tag } from 'antd'
import {
  BugFilled,
  CodeFilled,
  CompassFilled,
  SafetyCertificateFilled,
  ThunderboltFilled,
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
 * 上一版的问题不是"没区分"，而是**区分靠色相**：用户和 Agent 都是紫色渐变方块、
 * 白色图标，26px 下只剩两块紫，扫一眼分不出对面是谁；规划 / 编码 / 自检又各是一种
 * 渐变，白图标压在饱和底上、笔画只有 1px，远看是一团糊。
 *
 * 现在改成按**层级**区分，而不是按色相堆渐变：
 *  - 用户 = 中性浅底 + 深墨图标：低饱和、不抢戏，只表示"这是我说的"；
 *  - Agent = 唯一一块实心品牌色，核标用粗笔画白色，26px 也认得出；
 *  - 运行时 / 出处等异常分支 = 浅色底 + 同色系实底图标，是"提示"而非"另一个人"。
 *
 * 颜色全部落在 CSS（`.agent-avatar.role-*`）里，深色主题才有得改；
 * 这里只负责挑图标和尺寸。
 */
export type AgentRole = 'user' | 'agent' | 'planner' | 'coder' | 'verifier' | 'runtime' | 'model'

const ROLES: Record<AgentRole, { label: string; icon: React.ReactNode }> = {
  user: { label: '你', icon: <UserOutlined /> },
  agent: { label: 'Nucleus Agent', icon: null },
  planner: { label: '规划', icon: <CompassFilled /> },
  coder: { label: '编码', icon: <CodeFilled /> },
  verifier: { label: '自检', icon: <SafetyCertificateFilled /> },
  runtime: { label: '运行时', icon: <BugFilled /> },
  model: { label: '模型', icon: <ThunderboltFilled /> },
}

/**
 * 头像里的核标。
 *
 * 顶栏那枚 Logo 是展示用的：13 半径的细轨道 + 品牌渐变，缩到 16px 就成了一团灰。
 * 这里换成"少一条轨道、加粗描边、纯 currentColor"的紧凑版 —— 小尺寸下读得出是原子。
 */
function NucleusMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {/* 26px 下轨道和核心会糊成一个白点：轨道略透（0.9）、更细（1.5），
          并把它拉到 ry 4.7 让出中间的空隙，核心才分得出来 */}
      <ellipse cx="12" cy="12" rx="9.3" ry="4.7" fill="none" stroke="currentColor" strokeOpacity="0.9" strokeWidth="1.5" />
      <ellipse
        cx="12"
        cy="12"
        rx="9.3"
        ry="4.7"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.9"
        strokeWidth="1.5"
        transform="rotate(70 12 12)"
      />
      <circle cx="12" cy="12" r="2.7" fill="currentColor" />
    </svg>
  )
}

export function AgentAvatar({ role, size = 24, title }: { role: AgentRole; size?: number; title?: string }) {
  const meta = ROLES[role]
  const radius = Math.max(6, Math.round(size * 0.32))
  return (
    <span
      className={`agent-avatar role-${role}`}
      style={{ width: size, height: size, borderRadius: radius, fontSize: Math.round(size * 0.5) }}
      title={title ?? meta.label}
      aria-label={meta.label}
      role="img"
    >
      {/* Agent 本人用核标，其余角色用实底图标 —— 主控与执行者不能长得一样 */}
      {role === 'agent' ? <NucleusMark size={Math.round(size * 0.66)} /> : meta.icon}
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
