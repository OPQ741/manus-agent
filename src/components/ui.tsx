import { useEffect, useState, type ReactNode } from 'react'

/* --------------------------------- 图标 --------------------------------- */

interface IconProps {
  size?: number
  className?: string
}

const svg = (path: ReactNode, viewBox = '0 0 24 24') =>
  function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
      >
        {path}
      </svg>
    )
  }

export const IconPlus = svg(<path d="M12 5v14M5 12h14" />)
export const IconBack = svg(<path d="M15 5l-7 7 7 7" />)
export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </>,
)
export const IconPlay = svg(<path d="M7 4l12 8-12 8V4z" />)
export const IconCode = svg(<path d="M9 18l-6-6 6-6M15 6l6 6-6 6" />)
export const IconHistory = svg(
  <>
    <path d="M3 12a9 9 0 109-9 9 9 0 00-7.6 4.2" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </>,
)
export const IconDownload = svg(<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 19h16" />)
export const IconShare = svg(
  <>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </>,
)
export const IconRefresh = svg(
  <>
    <path d="M20 11a8 8 0 10-2.3 6.3" />
    <path d="M20 4v7h-7" />
  </>,
)
export const IconTrash = svg(<path d="M4 7h16M9 7V5h6v2m-7 0l1 13h6l1-13" />)
export const IconDesktop = svg(
  <>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </>,
)
export const IconTablet = svg(
  <>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M12 18h.01" />
  </>,
)
export const IconMobile = svg(
  <>
    <rect x="7" y="2" width="10" height="20" rx="2.5" />
    <path d="M12 19h.01" />
  </>,
)
export const IconSend = svg(<path d="M4 12l16-8-6 16-3-6-7-2z" />)
export const IconStop = svg(<rect x="6" y="6" width="12" height="12" rx="2" />)
export const IconExternal = svg(<path d="M14 4h6v6M20 4l-9 9M19 14v5H5V5h5" />)
export const IconCopy = svg(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5h10" />
  </>,
)
export const IconSpark = svg(<path d="M12 3l1.9 5.6L20 10.5l-5.4 2.2L12 18l-2.6-5.3L4 10.5l6.1-1.9L12 3z" />)
export const IconPalette = svg(
  <>
    <path d="M12 3a9 9 0 000 18h1.2a2.3 2.3 0 002.3-2.3c0-.6-.2-1.1-.6-1.6-.4-.4-.6-.9-.6-1.5a1.6 1.6 0 011.6-1.6H18a3 3 0 003-3 9 9 0 00-9-8z" />
    <circle cx="8" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="16.6" cy="10.4" r="1.1" fill="currentColor" stroke="none" />
  </>,
)
export const IconCheck = svg(<path d="M4 12.5l5 5L20 6.5" />)
export const IconAlert = svg(
  <>
    <path d="M12 3l9.5 17H2.5L12 3z" />
    <path d="M12 9v5M12 17h.01" />
  </>,
)
export const IconFile = svg(
  <>
    <path d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V9l-6-6z" />
    <path d="M13 3v6h6" />
  </>,
)

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

/* --------------------------------- Toast -------------------------------- */

const TOAST_EVENT = 'nucleus:toast'

export function toast(message: string) {
  window.dispatchEvent(new CustomEvent<string>(TOAST_EVENT, { detail: message }))
}

export function ToastHost() {
  const [items, setItems] = useState<{ id: number; text: string }[]>([])

  useEffect(() => {
    const handler = (event: Event) => {
      const text = (event as CustomEvent<string>).detail
      const id = Date.now() + Math.random()
      setItems((prev) => [...prev, { id, text }])
      setTimeout(() => setItems((prev) => prev.filter((item) => item.id !== id)), 2400)
    }
    window.addEventListener(TOAST_EVENT, handler)
    return () => window.removeEventListener(TOAST_EVENT, handler)
  }, [])

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 90,
        pointerEvents: 'none',
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          style={{
            background: '#14141a',
            color: '#fff',
            padding: '9px 16px',
            borderRadius: 10,
            fontSize: 13,
            boxShadow: '0 10px 30px rgba(0,0,0,.25)',
            animation: 'fade-up .18s ease',
          }}
        >
          {item.text}
        </div>
      ))}
    </div>
  )
}

/* ------------------------------- 其他小件 ------------------------------- */

export function Spinner() {
  return <span className="spin" aria-label="加载中" />
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty-block">
      <p style={{ margin: 0, fontWeight: 600, color: 'var(--ink)' }}>{title}</p>
      {hint ? <p style={{ margin: '6px 0 0', fontSize: 12.5 }}>{hint}</p> : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  )
}
