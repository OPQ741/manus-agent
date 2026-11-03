import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Button, ConfigProvider, Result } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { ToastHost } from './components/ui'
import { UiPrefsProvider, useUiPrefs } from './lib/ui-prefs'
import { HomePage } from './pages/Home'
import { SettingsPage } from './pages/Settings'
import { SharePage } from './pages/Share'
import { StudioPage } from './pages/Studio'
import { buildTheme } from './theme'

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

const TITLES: Record<Route['name'], string> = {
  home: 'Nucleus · 说一句话，得到一个能用的应用',
  studio: '工作台 · Nucleus',
  share: '分享 · Nucleus',
  settings: '设置 · Nucleus',
  notfound: '未找到 · Nucleus',
}

export default function App() {
  return (
    <UiPrefsProvider>
      <Shell />
    </UiPrefsProvider>
  )
}

/** 路由 + 主题壳：ConfigProvider 挂在最外层，切换外观时整棵树一起换令牌。 */
function Shell() {
  const { prefs, dark } = useUiPrefs()
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
    document.title = TITLES[route.name]
  }, [route])

  const theme = useMemo(() => buildTheme(prefs.accent, dark), [prefs.accent, dark])

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntdApp>
        {route.name === 'home' ? <HomePage /> : null}
        {route.name === 'studio' ? <StudioPage id={route.id} key={route.id} /> : null}
        {route.name === 'share' ? <SharePage slug={route.slug} key={route.slug} /> : null}
        {route.name === 'settings' ? <SettingsPage /> : null}
        {route.name === 'notfound' ? (
          <Result
            status="404"
            title="页面不存在"
            subTitle={route.path}
            extra={
              <Button type="primary" href="#/">
                回到首页
              </Button>
            }
          />
        ) : null}
        <ToastHost />
      </AntdApp>
    </ConfigProvider>
  )
}
