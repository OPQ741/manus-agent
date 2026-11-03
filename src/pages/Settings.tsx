import { useEffect, useState } from 'react'
import type { PublicSettings, ThemeMode } from '../../shared/types'
import { TopBar } from '../components/TopBar'
import { IconAlert, IconCheck, Spinner, toast } from '../components/ui'
import { api } from '../lib/api'

const ACCENTS = ['#4B3BFF', '#12715B', '#2563C9', '#C2703A', '#C2405C', '#1F2124']

/** 点名的提供方：'' = 交给服务端解析链（默认），'custom' = 自带 Key，其他 = 预设 id */
const AUTO = ''
const CUSTOM = 'custom'

export function SettingsPage() {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [provider, setProvider] = useState(AUTO)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [accent, setAccent] = useState(ACCENTS[0]!)
  const [theme, setTheme] = useState<ThemeMode>('light')
  const [locale, setLocale] = useState<'zh' | 'en'>('zh')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const reload = (data: PublicSettings) => {
    setSettings(data)
    setProvider(data.provider)
    setBaseUrl(data.baseUrl)
    setModel(data.model)
    setAccent(data.design.accent)
    setTheme(data.design.theme)
    setLocale(data.design.locale)
  }

  useEffect(() => {
    void api.getSettings().then(reload).catch((err: unknown) => toast(err instanceof Error ? err.message : '设置加载失败'))
  }, [])

  const payload = () => ({
    provider,
    baseUrl,
    model,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    design: { accent, theme, locale },
  })

  const save = async () => {
    setSaving(true)
    try {
      reload(await api.saveSettings(payload()))
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
      await api.saveSettings({ ...payload(), design: undefined })
      const result = await api.testConnection()
      setTestResult({ ok: true, text: `连通正常 · ${result.ms}ms · ${result.provider}/${result.model}` })
      setApiKey('')
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  const clearKey = async () => {
    setSaving(true)
    try {
      reload(await api.saveSettings({ ...payload(), apiKey: '' }))
      setApiKey('')
      setTestResult(null)
      toast('已清除 Key，交回服务端通道')
    } catch (err) {
      toast(err instanceof Error ? err.message : '清除失败')
    } finally {
      setSaving(false)
    }
  }

  const providers = settings?.providers ?? []

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
            <label>模型通道</label>
            <p className="help" style={{ marginTop: 0 }}>
              所有生成都由真实大模型完成，没有本地模板兜底。默认走服务端的免 Key 通道，打开即用；
              你也可以点名一个预设，或填自己的 Key（填了就只对你这个浏览器生效）。
            </p>
            <div className="segmented" role="group" aria-label="模型通道">
              <button aria-pressed={provider === AUTO} onClick={() => setProvider(AUTO)}>
                自动（服务端默认）
              </button>
              <button aria-pressed={provider === CUSTOM} onClick={() => setProvider(CUSTOM)}>
                我的 Key
              </button>
            </div>
          </div>

          <div className="provider-list">
            {providers.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`provider-card${provider === item.id ? ' is-on' : ''}`}
                aria-pressed={provider === item.id}
                disabled={!item.ready}
                onClick={() => setProvider(item.id)}
                title={item.ready ? `使用 ${item.label}` : `还没配置 Key（${item.keyEnv}）`}
              >
                <span className="provider-head">
                  <strong>{item.label}</strong>
                  {item.free ? <span className="badge ok">免 Key</span> : null}
                  {item.isDefault ? <span className="badge accent">服务端默认</span> : null}
                  {!item.ready ? <span className="badge">未配置</span> : null}
                </span>
                <span className="provider-model">{item.model}</span>
                {item.note ? <span className="provider-note">{item.note}</span> : null}
                {!item.ready && item.keyUrl ? (
                  <a className="provider-key" href={item.keyUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                    去申请 Key（{item.keyEnv}）
                  </a>
                ) : null}
              </button>
            ))}
          </div>
        </section>

        {provider === CUSTOM ? (
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
              <input id="model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-chat / gemini-2.5-flash / qwen-plus" />
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
              <p className="help">Key 只存在服务端，接口只回显掩码，不会进入前端产物，也不会被转发给第三方。</p>
            </div>
            <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => void test()} disabled={testing}>
                {testing ? <Spinner /> : null} 测试连接
              </button>
              {settings?.hasKey ? (
                <button className="btn sm ghost" onClick={() => void clearKey()} disabled={saving}>
                  清除我的 Key
                </button>
              ) : null}
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
            <p className="help">生成时作为设计参数告诉模型；你在需求里写「主色用墨绿」会以需求为准。</p>
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
            当前生效：{settings?.active ? `${settings.active.label} · ${settings.active.model}` : '无可用通道'}
            {settings?.active?.free ? '（免 Key）' : ''}
          </span>
        </div>

        <section className="card" style={{ padding: 16 }}>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.7 }}>
            Nucleus Studio v{settings?.version ?? '1.0.0'} · 生成物是多文件静态应用（HTML / CSS / JS），
            在 sandbox iframe 里运行，数据存在你自己的浏览器里。
            <br />
            服务端部署者可用环境变量预设主力模型（<code>NUCLEUS_PROVIDER</code>、<code>DEEPSEEK_API_KEY</code> …），
            详见仓库 README 的「接模型」一节。
          </p>
        </section>
      </div>
    </>
  )
}
