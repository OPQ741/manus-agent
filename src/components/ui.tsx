import { useEffect } from 'react'
import { App as AntdApp, Tag } from 'antd'

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
