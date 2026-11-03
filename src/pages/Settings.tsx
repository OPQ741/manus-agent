import { useEffect, useState } from 'react'
import { Alert, Button, Card, Flex, Form, Input, Segmented, Space, Typography } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, KeyOutlined, SettingOutlined } from '@ant-design/icons'
import type { PublicSettings, ThemeMode } from '../../shared/types'
import { TopBar } from '../components/TopBar'
import { Badge, toast } from '../components/ui'
import { api } from '../lib/api'

const { Text, Paragraph } = Typography

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
          extra={<Text type="secondary" style={{ fontSize: 12 }}>所有生成都由真实大模型完成，没有本地模板兜底</Text>}
        >
          <Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 0 }}>
            默认走服务端的免 Key 通道，打开即用；你也可以点名一个预设，或填自己的 Key（填了就只对你这个浏览器生效）。
          </Paragraph>

          <Segmented
            style={{ marginBottom: 14 }}
            value={provider === CUSTOM ? CUSTOM : provider === AUTO ? AUTO : 'preset'}
            onChange={(value) => setProvider(value === CUSTOM ? CUSTOM : AUTO)}
            options={[
              { label: '自动（服务端默认）', value: AUTO },
              { label: '我的 Key', value: CUSTOM },
              // 点名了某个预设时，两个主选项都不该显示为选中，用一个不可选中的占位承接
              ...(provider !== AUTO && provider !== CUSTOM
                ? [{ label: providers.find((item) => item.id === provider)?.label ?? '已点名预设', value: 'preset', disabled: true }]
                : []),
            ]}
          />

          <div className="provider-list">
            {providers.map((item) => {
              const active = provider === item.id
              return (
                <Card
                  key={item.id}
                  size="small"
                  hoverable={item.ready}
                  className={`provider-card${active ? ' is-on' : ''}${item.ready ? '' : ' is-off'}`}
                  aria-pressed={active}
                  title={
                    <Flex align="center" gap={6} wrap>
                      <Text strong style={{ fontSize: 13 }}>
                        {item.label}
                      </Text>
                      {item.free ? <Badge tone="ok">免 Key</Badge> : null}
                      {item.isDefault ? <Badge tone="accent">服务端默认</Badge> : null}
                      {!item.ready ? <Badge>未配置</Badge> : null}
                    </Flex>
                  }
                  onClick={() => {
                    if (item.ready) setProvider(item.id)
                  }}
                >
                  <Text type="secondary" className="mono" style={{ fontSize: 11.5 }}>
                    {item.model}
                  </Text>
                  {item.note ? (
                    <Paragraph type="secondary" style={{ fontSize: 11.5, margin: '4px 0 0' }}>
                      {item.note}
                    </Paragraph>
                  ) : null}
                  {!item.ready && item.keyUrl ? (
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, height: 'auto' }}
                      href={item.keyUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => event.stopPropagation()}
                    >
                      去申请 Key（{item.keyEnv}）
                    </Button>
                  ) : null}
                </Card>
              )
            })}
          </div>
        </Card>

        {provider === CUSTOM ? (
          <Card title={<Space size={6}><KeyOutlined />自带 Key</Space>}>
            <Form layout="vertical" requiredMark={false}>
              <Form.Item
                label="模型地址（Base URL）"
                extra="会拼成 {baseUrl}/chat/completions，必须支持 SSE 流式。内网地址会被拒绝。"
              >
                <Input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                />
              </Form.Item>
              <Form.Item label="模型名">
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="deepseek-chat / gemini-2.5-flash / qwen-plus"
                />
              </Form.Item>
              <Form.Item
                label="API Key"
                extra="Key 只存在服务端，接口只回显掩码，不会进入前端产物，也不会被转发给第三方。"
              >
                <Input.Password
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={settings?.hasKey ? `已配置：${settings.apiKeyMasked}（留空表示不修改）` : 'sk-…'}
                />
              </Form.Item>
              <Flex align="center" gap={10} wrap>
                <Button onClick={() => void test()} loading={testing}>
                  测试连接
                </Button>
                {settings?.hasKey ? (
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

        <Card title="界面外观">
          <Form layout="vertical" requiredMark={false}>
            <Form.Item label="主色" extra="生成时作为设计参数告诉模型；你在需求里写「主色用墨绿」会以需求为准。">
              <Space size={8}>
                {ACCENTS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`swatch${accent === color ? ' is-on' : ''}`}
                    style={{ background: color }}
                    aria-pressed={accent === color}
                    aria-label={`主色 ${color}`}
                    onClick={() => setAccent(color)}
                  />
                ))}
              </Space>
            </Form.Item>
            <Form.Item label="主题">
              <Segmented
                value={theme}
                onChange={(value) => setTheme(value as ThemeMode)}
                options={[
                  { label: '浅色', value: 'light' },
                  { label: '深色', value: 'dark' },
                  { label: '跟随系统', value: 'auto' },
                ]}
              />
            </Form.Item>
            <Form.Item label="界面语言">
              <Segmented
                value={locale}
                onChange={(value) => setLocale(value as 'zh' | 'en')}
                options={[
                  { label: '简体中文', value: 'zh' },
                  { label: 'English', value: 'en' },
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
            当前生效：{settings?.active ? `${settings.active.label} · ${settings.active.model}` : '无可用通道'}
            {settings?.active?.free ? '（免 Key）' : ''}
          </Text>
        </Flex>

        <Alert
          type="info"
          showIcon={false}
          message={
            <Text type="secondary" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
              Nucleus Studio v{settings?.version ?? '1.0.0'} · 生成物是多文件静态应用（HTML / CSS / JS），在 sandbox iframe
              里运行，数据存在你自己的浏览器里。
              <br />
              服务端部署者可用环境变量预设主力模型（<code>NUCLEUS_PROVIDER</code>、<code>DEEPSEEK_API_KEY</code> …），详见仓库
              README 的「接模型」一节。
            </Text>
          }
        />
      </div>
    </>
  )
}
