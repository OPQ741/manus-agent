import { useEffect, useState } from 'react'
import { Alert, Button, Card, Flex, Form, Input, Segmented, Space, Typography } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  KeyOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import type { ProviderOption, PublicSettings } from '../../shared/types'
import { TopBar } from '../components/TopBar'
import { Badge, toast } from '../components/ui'
import { api } from '../lib/api'
import { useUiPrefs } from '../lib/ui-prefs'

const { Text, Paragraph } = Typography

const ACCENTS = ['#4B3BFF', '#12715B', '#2563C9', '#C2703A', '#C2405C', '#1F2124']

/** 点名的提供方：'' = 交给服务端解析链（默认），'custom' = 自带 Key，其他 = 预设 id */
const AUTO = ''
const CUSTOM = 'custom'

/** 比较 Base URL 时忽略末尾斜杠：服务端会归一化，界面上不该因此判成"不是同一家" */
function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function SettingsPage() {
  const { prefs, setTheme, setAccent } = useUiPrefs()
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [provider, setProvider] = useState(AUTO)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const reload = (data: PublicSettings) => {
    setSettings(data)
    setProvider(data.provider)
    setBaseUrl(data.baseUrl)
    setModel(data.model)
  }

  useEffect(() => {
    void api
      .getSettings()
      .then(reload)
      .catch((err: unknown) => toast(err instanceof Error ? err.message : '设置加载失败'))
  }, [])

  const isCustom = provider === CUSTOM
  const providers = settings?.providers ?? []
  const active = settings?.active ?? null
  /** 点名的服务端预设（不是「自动」，也不是「自带 Key」） */
  const namedPreset = provider !== AUTO && provider !== CUSTOM ? providers.find((item) => item.id === provider) : undefined

  /**
   * 自带 Key 的三项必须齐全才算配置好：
   * 服务端的解析链只认「URL + 模型 + Key」三个都在的 custom 通道，
   * 少一项它就会悄悄落到服务端主力上 —— 用户会以为保存了却没生效。
   */
  const customComplete = Boolean(baseUrl.trim() && model.trim() && (apiKey.trim() || settings?.hasKey))

  const design = () => ({ accent: prefs.accent, theme: prefs.theme, locale: settings?.design.locale ?? 'zh' })

  /**
   * 保存载荷。
   *
   * 关键点：**不在「自带 Key」模式下就把这三项清空**。
   * 旧实现里切回服务端通道后，库里留着的 baseUrl/model/key 仍然会让 custom
   * 排在解析链第一位 —— 界面上选了服务端，实际还在打自己的 Key。
   */
  const payload = () =>
    isCustom
      ? {
          provider: CUSTOM,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          design: design(),
        }
      : { provider, baseUrl: '', model: '', apiKey: '', design: design() }

  const save = async () => {
    if (isCustom && !customComplete) {
      setTestResult({ ok: false, text: '自带 Key 需要三项齐全：Base URL、模型名、Key' })
      return
    }
    setSaving(true)
    try {
      reload(await api.saveSettings(payload()))
      setApiKey('')
      setTestResult(null)
      toast('已保存')
    } catch (err) {
      toast(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /** 测的是**当前表单**，不顺手落库：以前"测试连接"会先把草稿保存，语义很怪。 */
  const test = async () => {
    if (isCustom && !baseUrl.trim()) {
      setTestResult({ ok: false, text: '先填 Base URL' })
      return
    }
    if (isCustom && !model.trim()) {
      setTestResult({ ok: false, text: '先填模型名' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.testConnection(
        isCustom ? { baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() || undefined } : undefined,
      )
      setTestResult({ ok: true, text: `连通正常 · ${result.ms}ms · ${result.provider} / ${result.model}` })
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : '连接失败' })
    } finally {
      setTesting(false)
    }
  }

  const clearKey = async () => {
    setSaving(true)
    try {
      reload(await api.saveSettings({ provider: AUTO, baseUrl: '', model: '', apiKey: '', design: design() }))
      setProvider(AUTO)
      setBaseUrl('')
      setModel('')
      setApiKey('')
      setTestResult(null)
      toast('已清除自带 Key，回到服务端通道')
    } catch (err) {
      toast(err instanceof Error ? err.message : '清除失败')
    } finally {
      setSaving(false)
    }
  }

  /**
   * 点卡片。
   *
   * 已就绪 → 点名它；
   * 未配置 → 把它的地址与模型名填进「自带 Key」并切过去。
   * 旧实现里未配置的卡片点了完全没反应（且置灰到看不清），这比报错更让人困惑。
   */
  const pick = (item: ProviderOption) => {
    setTestResult(null)
    if (item.ready) {
      setProvider(item.id)
      return
    }
    setProvider(CUSTOM)
    setBaseUrl(item.baseUrl)
    setModel(item.model)
    setApiKey('')
    toast(`${item.label} 还没配 Key：地址与模型已填好，粘贴 Key 后保存即可`)
  }

  const dirty =
    Boolean(settings) &&
    (provider !== settings?.provider ||
      (isCustom && (baseUrl !== settings?.baseUrl || model !== settings?.model || apiKey.trim() !== '')) ||
      prefs.accent !== settings?.design.accent ||
      prefs.theme !== settings?.design.theme)

  return (
    <>
      <TopBar
        left={
          <Space size={6}>
            <SettingOutlined />
            <Text type="secondary" style={{ fontSize: 13 }}>
              设置
            </Text>
          </Space>
        }
        right={
          <Button size="small" type="text" href="#/">
            返回首页
          </Button>
        }
      />

      <div className="settings">
        <Card
          title="模型通道"
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              真实大模型 · 无本地模板兜底
            </Text>
          }
        >
          <div className="channel-band">
            <span className={`dot${active ? '' : ' idle'}`} />
            <Text strong style={{ fontSize: 12.5 }}>
              当前生效
            </Text>
            <Text type="secondary" className="mono" style={{ fontSize: 12 }}>
              {active ? `${active.label} · ${active.model}` : '无可用通道'}
            </Text>
            {active?.free ? <Badge tone="ok">免 Key</Badge> : null}
          </div>

          <Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 0 }}>
            打开即用：默认由服务端决定走哪一家。也可以点一张卡片点名预设，或切到「自带 Key」填自己的模型。
          </Paragraph>

          <div className="channel-mode">
            <Segmented
              value={isCustom ? CUSTOM : AUTO}
              onChange={(value) => {
                setTestResult(null)
                setProvider(value === CUSTOM ? CUSTOM : AUTO)
              }}
              options={[
                { label: '服务端通道', value: AUTO },
                { label: '自带 Key', value: CUSTOM },
              ]}
            />
            {namedPreset ? (
              <Space size={4}>
                <Badge tone="accent">已点名 · {namedPreset.label}</Badge>
                <Button
                  size="small"
                  type="link"
                  style={{ padding: 0, height: 'auto', fontSize: 12 }}
                  onClick={() => setProvider(AUTO)}
                >
                  取消点名
                </Button>
              </Space>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                未点名时用服务端主力
              </Text>
            )}
          </div>

          <div className="provider-list">
            {providers.map((item) => {
              const on = provider === item.id
              /* 「自带 Key」模式下，地址和模型正好是这张卡片的 → 标出来源，否则用户看不出预填的是哪家 */
              const source =
                isCustom && trimUrl(item.baseUrl) === trimUrl(baseUrl) && item.model === model.trim() && Boolean(baseUrl.trim())
              return (
                <div
                  key={item.id}
                  className={`provider-card${on ? ' is-on' : ''}${source ? ' is-source' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  title={item.keyEnv ? `服务端可用 ${item.keyEnv} 配置这家` : undefined}
                  onClick={() => pick(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      pick(item)
                    }
                  }}
                >
                  <div className="prov-head">
                    <Text strong style={{ fontSize: 13 }}>
                      {item.label}
                    </Text>
                    {item.free ? <Badge tone="ok">免 Key</Badge> : null}
                    {item.isDefault ? <Badge tone="accent">服务端默认</Badge> : null}
                    {!item.ready ? <Badge>未配置</Badge> : null}
                    {source ? <Badge tone="accent">正在用它</Badge> : null}
                    <div className="spacer" />
                    {on ? <CheckCircleFilled style={{ color: 'var(--accent)', fontSize: 13 }} /> : null}
                  </div>
                  <div className="prov-model mono">{item.model}</div>
                  <div className="prov-note">{item.note ?? ''}</div>
                  <div className="prov-foot">
                    <span className="prov-cta">{on ? '当前通道' : item.ready ? '点此使用' : '用我的 Key 走这家'}</span>
                    <div className="spacer" />
                    {!item.ready && item.keyUrl ? (
                      <Button
                        type="link"
                        size="small"
                        className="prov-key-link"
                        href={item.keyUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        去申请 Key
                      </Button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        {isCustom ? (
          <Card
            title={
              <Space size={6}>
                <KeyOutlined />
                自带 Key
              </Space>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                只存在服务端，接口只回显掩码
              </Text>
            }
          >
            <Form layout="vertical" requiredMark={false}>
              <Form.Item
                label="模型地址（Base URL）"
                extra="会拼成 {baseUrl}/chat/completions，必须支持 SSE 流式；内网地址会被拒绝。"
              >
                <Input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                  spellCheck={false}
                />
              </Form.Item>
              <div className="form-row">
                <Form.Item label="模型名">
                  <Input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="deepseek-chat"
                  />
                </Form.Item>
                <Form.Item
                  label={
                    <span>
                      API Key{' '}
                      <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>
                        {settings?.hasKey ? `已配置 ${settings.apiKeyMasked}` : '只存服务端'}
                      </Text>
                    </span>
                  }
                >
                  <Input.Password
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={settings?.hasKey ? '留空表示不修改' : 'sk-…'}
                    autoComplete="off"
                  />
                </Form.Item>
              </div>

              <Flex align="center" gap={10} wrap>
                <Button onClick={() => void test()} loading={testing}>
                  测试连接
                </Button>
                {settings?.hasKey || apiKey ? (
                  <Button size="small" type="text" onClick={() => void clearKey()} disabled={saving}>
                    清除我的 Key
                  </Button>
                ) : null}
                {testResult ? (
                  <Badge tone={testResult.ok ? 'ok' : 'danger'}>
                    <Space size={4}>
                      {testResult.ok ? <CheckCircleFilled /> : <CloseCircleFilled />}
                      {testResult.text}
                    </Space>
                  </Badge>
                ) : null}
              </Flex>
            </Form>
          </Card>
        ) : null}

        <Card title="界面外观" extra={<Text type="secondary" style={{ fontSize: 12 }}>切换即时生效</Text>}>
          <Form layout="vertical" requiredMark={false}>
            <Form.Item
              label="主色"
              extra="立即改变本页的强调色，同时作为新生成应用的默认主色；需求里写「主色用墨绿」会以需求为准。"
            >
              <div className="swatches">
                {ACCENTS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`swatch swatch-lg${prefs.accent.toLowerCase() === color.toLowerCase() ? ' is-on' : ''}`}
                    style={{ background: color }}
                    aria-pressed={prefs.accent.toLowerCase() === color.toLowerCase()}
                    aria-label={`主色 ${color}`}
                    onClick={() => setAccent(color)}
                  />
                ))}
              </div>
            </Form.Item>
            <Form.Item
              label="主题"
              extra="本页与新建应用共用这套外观；「跟随系统」会随操作系统的浅色/深色自动切换。"
            >
              <Segmented
                value={prefs.theme}
                onChange={(value) => setTheme(value as 'light' | 'dark' | 'auto')}
                options={[
                  { label: '浅色', value: 'light' },
                  { label: '深色', value: 'dark' },
                  { label: '跟随系统', value: 'auto' },
                ]}
              />
            </Form.Item>
          </Form>
        </Card>

        <Flex align="center" gap={12} wrap>
          <Button type="primary" onClick={() => void save()} loading={saving}>
            保存设置
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {dirty
              ? '有未保存的改动：模型通道要保存后才生效，外观已经生效。'
              : '外观改动即时生效；模型通道保存后对新生成生效。'}
          </Text>
        </Flex>

        <Alert
          type="info"
          showIcon={false}
          message={
            <Text type="secondary" style={{ fontSize: 12.5, lineHeight: 1.9 }}>
              Nucleus Studio v{settings?.version ?? '1.0.0'} · 生成物是多文件静态应用（HTML / CSS / JS），在 sandbox iframe
              里运行，数据存在你自己的浏览器里。
              <br />
              部署者可用环境变量预设主力模型（<code>NUCLEUS_PROVIDER</code>、<code>DEEPSEEK_API_KEY</code> …），详见仓库 README
              的「接模型」一节。
            </Text>
          }
        />
      </div>
    </>
  )
}
