import { useEffect, useState } from 'react'
import { ToastHost } from './components/ui'
import { HomePage } from './pages/Home'
import { SettingsPage } from './pages/Settings'
import { SharePage } from './pages/Share'
import { StudioPage } from './pages/Studio'

type Route =
  | { name: 'home' }
  | { name: 'studio'; id: string }
  | { name: 'share'; slug: string }
  | { name: 'settings' }
  | { name: 'notfound'; path: string }

/** ~40 行的 hash 路由：静态托管零配置，刷新不会 404。 */
function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '')
  const path = raw.split('?')[0] ?? ''
  const segments = path.split('/').filter(Boolean)

  if (segments.length === 0) return { name: 'home' }
  if (segments[0] === 'studio' && segments[1]) return { name: 'studio', id: segments[1] }
  if (segments[0] === 'p' && segments[1]) return { name: 'share', slug: segments[1] }
  if (segments[0] === 'settings') return { name: 'settings' }
  return { name: 'notfound', path }
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash)

  useEffect(() => {
    const onChange = () => {
      setRoute(parseHash())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  useEffect(() => {
    const titles: Record<Route['name'], string> = {
      home: 'Nucleus · 说一句话，得到一个能用的应用',
      studio: '工作台 · Nucleus',
      share: '分享 · Nucleus',
      settings: '设置 · Nucleus',
      notfound: '未找到 · Nucleus',
    }
    document.title = titles[route.name]
  }, [route])

  return (
    <>
      {route.name === 'home' ? <HomePage /> : null}
      {route.name === 'studio' ? <StudioPage id={route.id} key={route.id} /> : null}
      {route.name === 'share' ? <SharePage slug={route.slug} key={route.slug} /> : null}
      {route.name === 'settings' ? <SettingsPage /> : null}
      {route.name === 'notfound' ? (
        <div className="home">
          <div className="empty-block">
            <p style={{ margin: 0, fontWeight: 600 }}>页面不存在</p>
            <p style={{ margin: '6px 0 14px', fontSize: 12.5 }}>{route.path}</p>
            <a className="btn primary" href="#/">
              回到首页
            </a>
          </div>
        </div>
      ) : null}
      <ToastHost />
    </>
  )
}
