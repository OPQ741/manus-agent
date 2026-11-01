import type { ReactNode } from 'react'
import { Logo } from './ui'

export function TopBar({
  left,
  center,
  right,
}: {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
}) {
  return (
    <header className="topbar">
      <a className="brand" href="#/" aria-label="回到首页">
        <Logo size={24} />
        <span>Nucleus</span>
        <small>studio</small>
      </a>
      {left ? (
        <>
          <span className="sep" />
          {left}
        </>
      ) : null}
      {center ? <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>{center}</div> : null}
      <div className="spacer" />
      {right}
    </header>
  )
}
