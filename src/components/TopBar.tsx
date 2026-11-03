import type { ReactNode } from 'react'
import { Logo } from './ui'

/**
 * 顶栏只做骨架：左边品牌、中间可选、右边动作位。
 * 高度写死在 CSS（58px），工作台与首页共用同一套度量。
 */
export function TopBar({ left, center, right }: { left?: ReactNode; center?: ReactNode; right?: ReactNode }) {
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
      {center ? <div className="topbar-center">{center}</div> : null}
      <div className="spacer" />
      {right}
    </header>
  )
}
