import { useEffect, useState } from 'react'
import type { EngineId, PublicSettings, ThemeMode } from '../../shared/types'
import { TopBar } from '../components/TopBar'
import { IconAlert, IconCheck, Spinner, toast } from '../components/ui'
import { api } from '../lib/api'

const ACCENTS = ['#4B3BFF', '#12715B', '#2563C9', '#C2703A', '#C2405C', '#1F2124']

export function SettingsPage() {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [engine, setEngine] = useState<EngineId>('local')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [accent, setAccent] = useState(ACCENTS[0]!)
  const [theme, setTheme] = useState<ThemeMode>('light')
  const [locale, setLocale] = useState<'zh' | 'en'>('zh')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void api
      .getSettings()
      .then((data) => {
        setSettings(data)
        setEngine(data.engine)
        setBaseUrl(data.baseUrl)
        setModel(data.model)
        setAccent(data.design.accent)
        setTheme(data.design.theme)
        setLocale(data.design.locale)
      })
      .catch((err: unknown) => toast(err instanceof Error ? err.message : '设置加载失败'))
  }, [])

  const save = async (patch?: Partial<Parameters<typeof api.saveSettings>[0]>) => {
    setSaving(true)
    try {
      const next = await api.saveSettings({
        engine,
        baseUrl,
        model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        design: { accent, theme, locale },
        ...patch,
      })
      setSettings(next)
      setApiKey('')
      toast('已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      await api.saveSettings({ engine, baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      const result = await api.testConnection()
      setTestResult({ ok: true, text: `连通正常 · ${result.ms}ms · ${result.model}` })
      setApiKey('')
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <TopBar
        left={<span className="muted" style={{ fontSize: 13 }}>设置</span>}
        right={
          <a className="btn ghost sm" href="#/">
            返回首页
          </a>
        }
      />
      <div className="settings">
        <section className="card">
          <div className="field">
            <label>生成引擎</label>
            <div className="segmented" role="group" aria-label="生成引擎">
              <button aria-pressed={engine === 'local'} onClick={() => setEngine('local')}>
                本地引擎
              </button>
              <button aria-pressed={engine === 'cloud'} onClick={() => setEngine('cloud')}>
                云模型
              </button>
            </div>
            <p className="help">
              本地引擎是确定性编译器：零配置、离线可用，按意图与槽位生成可运行应用；云模型走任意 OpenAI 兼容接口，
              生成更自由，但需要你自己提供 Key。
            </p>
          </div>
        </section>

        {engine === 'cloud' ? (
          <section className="card">
            <div className="field">
              <label htmlFor="baseUrl">模型地址（Base URL）</label>
              <input
                id="baseUrl"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
              />
              <p className="help">会拼成 {'{baseUrl}'}/chat/completions，必须支持 SSE 流式。内网地址会被拒绝。</p>
            </div>
            <div className="field">
              <label htmlFor="model">模型名</label>
              <input id="model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o-mini / deepseek-chat / qwen-plus" />
            </div>
            <div className="field">
              <label htmlFor="apiKey">API Key</label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={settings?.hasKey ? `已配置：${settings.apiKeyMasked}（留空表示不修改）` : 'sk-…'}
              />
              <p className="help">Key 只存在服务端，接口只回显掩码，不会进入前端产物。</p>
            </div>
            <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <button className="btn" onClick={() => void test()} disabled={testing}>
                {testing ? <Spinner /> : null} 测试连接
              </button>
              {testResult ? (
                <span className={`badge ${testResult.ok ? 'ok' : 'danger'}`}>
                  {testResult.ok ? <IconCheck size={11} /> : <IconAlert size={11} />}
                  {testResult.text}
                </span>
              ) : null}
            </div>
          </section>
        ) : null}

        <section className="card">
          <div className="field">
            <label>主色</label>
            <div className="swatches">
              {ACCENTS.map((color) => (
                <button
                  key={color}
                  className="swatch"
                  style={{ background: color }}
                  aria-pressed={accent === color}
                  aria-label={`主色 ${color}`}
                  onClick={() => setAccent(color)}
                />
              ))}
            </div>
            <p className="help">生成时注入到设计令牌；prompt 里明确写「主色用墨绿」会覆盖这里的设置。</p>
          </div>
          <div className="field">
            <label>主题</label>
            <div className="segmented">
              {(['light', 'dark', 'auto'] as ThemeMode[]).map((value) => (
                <button key={value} aria-pressed={theme === value} onClick={() => setTheme(value)}>
                  {value === 'light' ? '浅色' : value === 'dark' ? '深色' : '跟随系统'}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>界面语言</label>
            <div className="segmented">
              <button aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}>
                简体中文
              </button>
              <button aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>
                English
              </button>
            </div>
          </div>
        </section>

        <div className="row">
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner /> : null} 保存设置
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            当前：{settings?.engine === 'cloud' ? '云模型' : '本地引擎'}
            {settings?.cloudReady ? ' · 云模型已就绪' : ''}
          </span>
        </div>

        <section className="card" style={{ padding: 16 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.7 }}>
            Nucleus Studio v{settings?.version ?? '1.0.0'} · 生成物是多文件静态应用（HTML / CSS / JS），
            在 sandbox iframe 里运行，数据存在你自己的浏览器里。
            <br />
            想了解实现：<a href="https://github.com" style={{ color: 'var(--accent)' }}>源码与文档</a>（见交付说明）。
          </p>
        </section>
      </div>
    </>
  )
}
