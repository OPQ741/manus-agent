/**
 * 宿主界面的外观偏好（主题 / 强调色）。
 *
 * 为什么单独一层，而不是直接读服务端设置：
 * 服务端 settings.design 是**生成时喂给模型的设计参数**（新建项目的默认值），
 * 它存在服务端、对所有访客共享。而"我把这个页面切成深色"是**每台浏览器**的事，
 * 不该因为别人点了深色就让所有人变深色。所以这里用 localStorage 落地，
 * 服务端那份只作为首次访问的初值与生成默认值。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ThemeMode } from '../../shared/types'
import { lighten } from '../../shared/theme'
import { DEFAULT_ACCENT } from '../theme'
import { api } from './api'

export interface UiPrefs {
  theme: ThemeMode
  accent: string
}

export const UI_DEFAULT: UiPrefs = { theme: 'light', accent: DEFAULT_ACCENT }

const STORAGE_KEY = 'nucleus.ui.v1'
const DARK_QUERY = '(prefers-color-scheme: dark)'

function readCache(): UiPrefs | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    const theme: ThemeMode = parsed.theme === 'dark' || parsed.theme === 'auto' ? parsed.theme : 'light'
    const accent = typeof parsed.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.accent) ? parsed.accent : DEFAULT_ACCENT
    return { theme, accent }
  } catch {
    return null
  }
}

function writeCache(prefs: UiPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* 隐私模式下写不进去：本页仍然生效，只是下次不记得 */
  }
}

export function resolveDark(theme: ThemeMode): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches
}

/**
 * 把偏好写进根元素：`data-theme` 驱动 CSS 变量，`--accent` 驱动强调色。
 *
 * 深色下的 `--accent-soft` 故意**不写内联值**，交给 CSS 用 color-mix 按当前主色
 * 生成半透明底色 —— 否则内联的浅色底会把深色主题里的焦点环和气泡底色一起点亮。
 */
export function applyUiPrefs(prefs: UiPrefs) {
  const root = document.documentElement
  const dark = resolveDark(prefs.theme)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.setProperty('--accent', prefs.accent)
  if (dark) root.style.removeProperty('--accent-soft')
  else root.style.setProperty('--accent-soft', lighten(prefs.accent, 0.86))
  // 手机地址栏跟着一起换，否则深色页面顶着一条浅色状态栏
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#131318' : '#faf9f7')
}

interface UiPrefsValue {
  prefs: UiPrefs
  /** 当前**实际**是不是深色（auto 时按系统偏好解析后的结果） */
  dark: boolean
  setTheme: (theme: ThemeMode) => void
  setAccent: (accent: string) => void
}

const UiPrefsContext = createContext<UiPrefsValue | null>(null)

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<UiPrefs>(() => readCache() ?? UI_DEFAULT)
  const [dark, setDark] = useState(() => resolveDark((readCache() ?? UI_DEFAULT).theme))

  // 首次访问没有本地缓存：继承服务端保存的默认外观，而不是硬闪一下浅色
  useEffect(() => {
    if (readCache()) return
    let alive = true
    api
      .getSettings()
      .then((data) => {
        if (!alive) return
        setPrefs({ theme: data.design.theme, accent: data.design.accent })
      })
      .catch(() => {
        /* 服务端不可达就保持默认，外观不该阻塞页面 */
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const apply = () => {
      applyUiPrefs(prefs)
      setDark(resolveDark(prefs.theme))
      writeCache(prefs)
    }
    apply()
    if (prefs.theme !== 'auto') return
    const query = window.matchMedia(DARK_QUERY)
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [prefs])

  const setTheme = useCallback((theme: ThemeMode) => setPrefs((prev) => ({ ...prev, theme })), [])
  const setAccent = useCallback((accent: string) => setPrefs((prev) => ({ ...prev, accent })), [])

  const value = useMemo<UiPrefsValue>(() => ({ prefs, dark, setTheme, setAccent }), [prefs, dark, setTheme, setAccent])
  return <UiPrefsContext.Provider value={value}>{children}</UiPrefsContext.Provider>
}

export function useUiPrefs(): UiPrefsValue {
  const value = useContext(UiPrefsContext)
  if (!value) throw new Error('useUiPrefs 必须在 UiPrefsProvider 内使用')
  return value
}
