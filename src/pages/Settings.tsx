/**
 * 设置页。
 *
 * 这里只回答两个问题：「现在用哪个模型」和「界面长什么样」。
 *
 * 上一版把 7 张通道卡片平铺在页面上，每张卡都带模型名、说明、动作、申请链接，
 * 外加一条「当前生效」带子和一个「服务端通道 / 自带 Key」开关 —— 用户要在
 * 28 个信息点里找出「我现在用的是哪个」。所以这一版按市面上同类产品（Cursor 的
 * Models、Chatbox / Cherry Studio 的服务商页、OpenRouter 的模型选择）的共识重排：
 *
 *  1. **一屏只有一个主角**：当前模型 + 一句话说明它为什么生效；
 *  2. **选择放进抽屉**：点「更换」才展开列表，列表可搜索、按可用性分组；
 *  3. **不存在「模式开关」**：选预设就是预设，选自定义就是自定义，模式由选择本身决定，
 *     不再有「点了卡片却偷偷切到自带 Key」这种心智跳跃；
 *  4. **改了就是生效**：没有「保存设置」按钮，选完立刻 PUT。上一版的"改了但没保存"
 *     是设置页最常见的困惑来源。
 */

import { useEffect, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Segmented,
  Space,
  Spin,
  Typography,
} from 'antd'
import {
  ApiOutlined,
  CheckCircleFilled,
  CopyOutlined,
  KeyOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import type { ProviderOption, PublicSettings } from '../../shared/types'
import { TopBar } from '../components/TopBar'
import { Badge, toast } from '../components/ui'
import { api } from '../lib/api'
import { useUiPrefs } from '../lib/ui-prefs'

const { Text, Paragraph } = Typography

const ACCENTS = ['#4B3BFF', '#12715B', '#2563C9', '#C2703A', '#C2405C', '#1F2124']

const CUSTOM = 'custom'

/**
 * 自定义接入的常用服务商。
 *
 * 只做一件事：点一下把 Base URL 与一个能跑的模型名填好。
 * 这是自定义接入里唯一的"记忆负担"（各家地址格式不一样），Key 仍然要自己粘。
 */
const QUICK_PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview' },
  { label: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-air' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-Coder-30B-A3B-Instruct' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  { label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
]

type View = 'list' | 'custom'

export function SettingsPage() {
  const { prefs, setTheme, setAccent } = useUiPrefs()
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [view, setView] = useState<View>('list')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  /** 换模型时的本地草稿：输入过程中不发请求，选定/失焦才提交 */
  const [modelDraft, setModelDraft] = useState<string | null>(null)

  // 自定义接入的草稿：不落到 settings 上，只有点「保存并使用」才提交
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [keyUrl, setKeyUrl] = useState<string | undefined>()
  const [maxTokens, setMaxTokens] = useState<number | null>(null)
  const [temperature, setTemperature] = useState<number | null>(null)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  const load = async () => {
    try {
      setSettings(await api.getSettings())
    } catch (error) {
      toast(error instanceof Error ? error.message : '设置加载失败')
    }
  }

  // 只在首次挂载拉一次：之后所有变更都以 PUT 的返回值为准，不再前后端各存一份
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const providers = settings?.providers ?? []
  const active = settings?.active ?? null
  const currentId = settings?.provider === CUSTOM ? CUSTOM : settings?.provider || active?.id || ''
  const activeOption = providers.find((item) => item.id === active?.id)
  const modelChoices = activeOption?.models ?? []

  /** 保存模型通道；成功即刷新整页状态，失败只提示不改本地状态（避免"看起来生效了"）。 */
  const put = async (patch: Parameters<typeof api.saveSettings>[0], note = '已生效') => {
    setBusy(true)
    try {
      setSettings(await api.saveSettings(patch))
      toast(note)
      return true
    } catch (error) {
      toast(error instanceof Error ? error.message : '保存失败')
      return false
    } finally {
      setBusy(false)
    }
  }

  const openPicker = () => {
    setTestResult(null)
    setView('list')
    setQuery('')
    setPickerOpen(true)
  }

  /**
   * 手填模型名：输入只进草稿，回车/失焦才提交。
   * 每敲一个字就 PUT 会打出一串互相覆盖的请求，最后落库的很可能是中间态。
   */
  const commitModel = () => {
    if (!currentId || currentId === CUSTOM) return
    const next = (modelDraft ?? '').trim()
    if (!next) return
    const prev = settings?.modelOverride || active?.model || ''
    setModelDraft(null)
    if (next !== prev) void put({ provider: currentId, modelOverride: next })
  }

  const startCustom = (option?: ProviderOption) => {
    setTestResult(null)
    setView('custom')
    setBaseUrl(option?.baseUrl ?? settings?.baseUrl ?? '')
    setModel(option?.model ?? settings?.model ?? '')
    setApiKey('')
    setKeyUrl(option?.keyUrl)
    setMaxTokens(settings?.maxTokens ?? null)
    setTemperature(settings?.temperature ?? null)
    setModelOptions(option?.models ?? [])
  }

  /** 选一个预设。未配置 Key 的不再"偷偷切模式"，而是进自定义表单并说明原因。 */
  const choose = async (option: ProviderOption) => {
    if (busy) return
    if (!option.ready) {
      startCustom(option)
      toast(`${option.label} 需要 Key：地址和模型已填好，粘贴 Key 即可`)
      return
    }
    const keepOverride = settings?.provider === option.id ? settings.modelOverride : ''
    const ok = await put({ provider: option.id, modelOverride: keepOverride })
    if (ok) setPickerOpen(false)
  }

  const saveCustom = async () => {
    if (!baseUrl.trim()) {
      setTestResult({ ok: false, text: '先填 Base URL' })
      return
    }
    if (!model.trim()) {
      setTestResult({ ok: false, text: '先填模型名（可以点「拉取列表」选一个）' })
      return
    }
    if (!apiKey.trim() && !settings?.hasKey) {
      setTestResult({ ok: false, text: '还需要一个 API Key' })
      return
    }
    const ok = await put({
      provider: CUSTOM,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      maxTokens,
      temperature,
    })
    if (ok) {
      setApiKey('')
      setPickerOpen(false)
    }
  }

  const testDraft = async () => {
    if (!baseUrl.trim() || !model.trim()) {
      setTestResult({ ok: false, text: '先填 Base URL 和模型名' })
      return
    }
    setBusy(true)
    setTestResult(null)
    try {
      const result = await api.testConnection({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      })
      setTestResult({ ok: true, text: `连通正常 · ${result.ms}ms · ${result.sample || result.model}` })
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : '连接失败' })
    } finally {
      setBusy(false)
    }
  }

  /** 测试当前生效通道（不是草稿）：点一下确认"现在生成会打给谁"。 */
  const testActive = async () => {
    setBusy(true)
    try {
      const result = await api.testConnection()
      toast(`连通正常 · ${result.ms}ms · ${result.provider}`)
    } catch (error) {
      toast(error instanceof Error ? error.message : '连接失败')
    } finally {
      setBusy(false)
    }
  }

  const fetchModels = async () => {
    if (!baseUrl.trim()) {
      toast('先填 Base URL')
      return
    }
    setLoadingModels(true)
    try {
      const result = await api.listModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined })
      setModelOptions(result.models)
      if (!result.models.length) toast('这个地址没有返回模型，手填模型名也可以')
      else if (!model.trim()) setModel(result.models[0] ?? '')
    } catch (error) {
      toast(error instanceof Error ? error.message : '拉取失败')
    } finally {
      setLoadingModels(false)
    }
  }

  const designNow = () => ({
    accent: prefs.accent,
    theme: prefs.theme,
    locale: settings?.design.locale ?? ('zh' as const),
  })

  const pickAccent = (color: string) => {
    setAccent(color)
    void api
      .saveSettings({ design: { ...designNow(), accent: color } })
      .then(setSettings)
      .catch(() => toast('外观没能存到服务端，本机已生效'))
  }

  const pickTheme = (theme: 'light' | 'dark' | 'auto') => {
    setTheme(theme)
    void api
      .saveSettings({ design: { ...designNow(), theme } })
      .then(setSettings)
      .catch(() => toast('外观没能存到服务端，本机已生效'))
  }

  const keyword = query.trim().toLowerCase()
  const matched = providers.filter((item) =>
    keyword
      ? `${item.label} ${item.model} ${item.id} ${(item.models ?? []).join(' ')} ${item.note ?? ''}`
          .toLowerCase()
          .includes(keyword)
      : true,
  )
  const groups = [
    { key: 'free', title: '开箱可用', items: matched.filter((item) => item.free && item.ready) },
    { key: 'ready', title: '已配置', items: matched.filter((item) => !item.free && item.ready) },
    { key: 'need', title: '需要 Key', items: matched.filter((item) => !item.ready) },
  ].filter((group) => group.items.length > 0)

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
          title="模型"
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              服务端 v{settings?.version ?? '1.0.0'}
            </Text>
          }
        >
          {settings ? (
            active ? (
              <div className="model-current">
                <div className="model-current-body">
                  <div className="model-current-name">
                    <span className="dot" />
                    <Text strong style={{ fontSize: 14 }}>
                      {active.label}
                    </Text>
                    {active.free ? <Badge tone="ok">免 Key</Badge> : null}
                    {!active.free && currentId === CUSTOM ? <Badge tone="accent">自带 Key</Badge> : null}
                    {!active.free && currentId !== CUSTOM ? <Badge tone="accent">服务端</Badge> : null}
                  </div>
                  {/* 模型名单独一行、加大字号并做成可复制的胶囊：
                      "哪个通道"和"哪个模型"是两个问题，混在一行小字里谁都读不準 */}
                  <div className="model-current-model">
                    <span className="model-name mono">{active.model}</span>
                    <Button
                      size="small"
                      type="text"
                      className="model-copy"
                      icon={<CopyOutlined />}
                      aria-label="复制模型名"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(active.model)
                          toast('模型名已复制')
                        } catch {
                          toast(active.model)
                        }
                      }}
                    />
                    {activeOption?.models && activeOption.models.length > 1 ? (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        · 这一家还有 {activeOption.models.length - 1} 个可选模型
                      </Text>
                    ) : null}
                  </div>
                  <div className="model-current-reason">{settings.activeReason}</div>
                </div>
                <Space size={8} wrap>
                  <Button icon={<SwapOutlined />} onClick={openPicker} loading={busy}>
                    更换模型
                  </Button>
                  <Button icon={<ApiOutlined />} onClick={() => void testActive()} disabled={busy}>
                    测试
                  </Button>
                </Space>
              </div>
            ) : (
              <Alert
                type="error"
                showIcon
                message="没有可用的模型通道"
                description="免 Key 通道被关掉了，也没有配置任何 Key。到下面选一个预设并填 Key。"
                action={
                  <Button size="small" onClick={openPicker}>
                    去配置
                  </Button>
                }
              />
            )
          ) : (
            <Flex justify="center" style={{ padding: 24 }}>
              <Spin />
            </Flex>
          )}

          {/* 同一家换模型：把候选模型名铺成一排胶囊。
              上版是一个 AutoComplete —— 模型名藏在输入框里，要展开才知道有哪些，
              而"这家还有哪些模型"正是这一步唯一的决策信息。 */}
          {currentId && currentId !== CUSTOM ? (
            <div className="model-switch">
              <Text type="secondary" style={{ fontSize: 12.5 }}>
                同一通道内换模型
              </Text>
              {modelChoices.length > 0 ? (
                <div className="model-chips">
                  {modelChoices.map((value) => {
                    const on = value === (settings?.modelOverride || active?.model)
                    return (
                      <button
                        key={value}
                        type="button"
                        className={`model-chip mono${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        disabled={busy}
                        onClick={() => void put({ provider: currentId, modelOverride: value })}
                      >
                        {value}
                      </button>
                    )
                  })}
                </div>
              ) : null}
              <Input
                size="small"
                className="model-custom-input mono"
                value={modelDraft ?? ''}
                placeholder="或手填模型名"
                spellCheck={false}
                onChange={(event) => setModelDraft(event.target.value)}
                onPressEnter={() => commitModel()}
                onBlur={() => commitModel()}
              />
            </div>
          ) : null}

          {settings?.warnings?.length ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 14 }}
              message="模型目录有几处没生效"
              description={
                <ul className="settings-warnings">
                  {settings.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              }
            />
          ) : null}

          <Paragraph type="secondary" className="channel-foot">
            生成物是 HTML / CSS / JS 静态应用，在 sandbox iframe 里运行，数据存在浏览器本地。
          </Paragraph>

          <Collapse
            ghost
            size="small"
            className="settings-deployer"
            items={[
              {
                key: 'deployer',
                label: '部署者配置（环境变量 / 配置文件）',
                children: (
                  <div className="settings-hint">
                    <div>
                      <code>NUCLEUS_PROVIDER</code> 指定主力通道，<code>DEEPSEEK_API_KEY</code> /{' '}
                      <code>OPENROUTER_API_KEY</code> 等给对应预设施加 Key。
                    </div>
                    <div>
                      <code>config/providers.json</code>（可入库）与 <code>data/providers.local.json</code>
                      （放 Key，已 gitignore）按 id 逐字段合并，改完**无需重启**，下一次请求即生效。
                    </div>
                    <div>
                      要接自建网关（内网地址）需显式打开 <code>NUCLEUS_ALLOW_LOCAL_LLM=1</code>，否则会被
                      SSRF 防护拒绝。
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </Card>

        <Card title="界面外观">
          <Form layout="vertical" requiredMark={false}>
            <Form.Item label="主色" tooltip="即时生效，并作为新生成应用的默认主色；需求里指定主色时以需求为准。">
              <div className="swatches">
                {ACCENTS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`swatch swatch-lg${prefs.accent.toLowerCase() === color.toLowerCase() ? ' is-on' : ''}`}
                    style={{ background: color }}
                    aria-pressed={prefs.accent.toLowerCase() === color.toLowerCase()}
                    aria-label={`主色 ${color}`}
                    onClick={() => pickAccent(color)}
                  />
                ))}
              </div>
            </Form.Item>
            <Form.Item label="主题" tooltip="与新建应用共用；「跟随系统」随系统深浅色切换。">
              <Segmented
                value={prefs.theme}
                onChange={(value) => pickTheme(value as 'light' | 'dark' | 'auto')}
                options={[
                  { label: '浅色', value: 'light' },
                  { label: '深色', value: 'dark' },
                  { label: '跟随系统', value: 'auto' },
                ]}
              />
            </Form.Item>
          </Form>
        </Card>
      </div>

      <Drawer
        title={view === 'custom' ? '自定义接入' : '选择模型'}
        open={pickerOpen}
        width={560}
        onClose={() => setPickerOpen(false)}
        extra={
          view === 'list' ? (
            <Button size="small" type="link" onClick={() => startCustom()}>
              自定义接入
            </Button>
          ) : (
            <Button size="small" type="link" onClick={() => setView('list')}>
              返回预设
            </Button>
          )
        }
      >
        {view === 'list' ? (
          <>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索模型 / 服务商"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ marginBottom: 12 }}
            />

            {groups.length === 0 ? (
              <Empty description="没有匹配的模型" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              groups.map((group) => (
                <div key={group.key} className="model-group">
                  <div className="model-group-title">{group.title}</div>
                  {group.items.map((item) => {
                    const on = item.id === currentId
                    return (
                      <div
                        key={item.id}
                        className={`model-row${on ? ' is-on' : ''}`}
                        role="button"
                        tabIndex={0}
                        aria-pressed={on}
                        onClick={() => void choose(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            void choose(item)
                          }
                        }}
                      >
                        <div className="model-row-main">
                          <div className="model-row-title">
                            <Text strong style={{ fontSize: 13 }}>
                              {item.label}
                            </Text>
                            {item.isDefault ? <Badge>服务端默认</Badge> : null}
                            {item.free ? <Badge tone="ok">免 Key</Badge> : null}
                            {!item.ready ? <Badge tone="warn">未配置</Badge> : null}
                          </div>
                          <div className="model-row-sub">
                            <span className="model-pill mono">{item.model}</span>
                            {item.models && item.models.length > 1 ? (
                              <span className="model-row-count">{item.models.length} 个可选</span>
                            ) : null}
                          </div>
                          {item.note ? <div className="model-row-note">{item.note}</div> : null}
                        </div>
                        <div className="model-row-side">
                          {on ? (
                            <CheckCircleFilled style={{ color: 'var(--accent)' }} />
                          ) : item.ready ? (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              使用
                            </Text>
                          ) : (
                            <Text style={{ fontSize: 12, color: 'var(--accent)' }}>填 Key</Text>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))
            )}

            <div className="model-footer-hint">
              想用列表里没有的服务商？点右上角「自定义接入」，填 Base URL、Key 与模型即可。
            </div>
          </>
        ) : (
          <Form layout="vertical" requiredMark={false}>
            <Form.Item label="常用服务商" extra="点一下自动填好地址和默认模型，你只需要粘 Key。">
              <div className="preset-chips">
                {QUICK_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={`preset-chip${baseUrl.trim() === preset.baseUrl ? ' is-on' : ''}`}
                    onClick={() => {
                      setBaseUrl(preset.baseUrl)
                      setModel(preset.model)
                      setModelOptions([])
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Form.Item>

            <Form.Item label="Base URL" extra="OpenAI 兼容地址，通常是 …/v1；内网地址会被拒绝（除非服务端显式放行）。">
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
              />
            </Form.Item>

            <Form.Item
              label={
                <Space size={6}>
                  <KeyOutlined />
                  API Key
                  <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>
                    {settings?.hasKey ? `已保存 ${settings.apiKeyMasked}，留空不修改` : '只存在服务端'}
                  </Text>
                </Space>
              }
              extra={
                keyUrl ? (
                  <span>
                    还没有 Key？
                    <a href={keyUrl} target="_blank" rel="noreferrer">
                      去申请
                    </a>
                  </span>
                ) : undefined
              }
            >
              <Input.Password
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={settings?.hasKey ? '留空表示不修改' : 'sk-…'}
                autoComplete="off"
              />
            </Form.Item>

            <Form.Item
              label="模型"
              extra={
                <span>
                  不确定叫什么？点右边按上游 <code>/models</code> 拉取。
                </span>
              }
            >
              <Space.Compact style={{ width: '100%' }}>
                <AutoComplete
                  style={{ flex: 1 }}
                  value={model}
                  onChange={(value) => setModel(value)}
                  options={modelOptions.map((value) => ({ value }))}
                  placeholder="deepseek-chat"
                  filterOption={(input, option) =>
                    String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                />
                <Button icon={<ReloadOutlined />} loading={loadingModels} onClick={() => void fetchModels()}>
                  拉取列表
                </Button>
              </Space.Compact>
            </Form.Item>

            <Collapse
              ghost
              size="small"
              items={[
                {
                  key: 'advanced',
                  label: '高级参数（一般不用改）',
                  children: (
                    <div className="form-row">
                      <Form.Item label="最大输出 tokens" extra="留空用平台默认 8192；写不完应用时可调大。">
                        <InputNumber
                          style={{ width: '100%' }}
                          min={256}
                          max={32768}
                          step={512}
                          value={maxTokens ?? undefined}
                          onChange={(value) => setMaxTokens(typeof value === 'number' ? value : null)}
                          placeholder="8192"
                        />
                      </Form.Item>
                      <Form.Item label="温度" extra="0–2，越低越稳定。">
                        <InputNumber
                          style={{ width: '100%' }}
                          min={0}
                          max={2}
                          step={0.1}
                          value={temperature ?? undefined}
                          onChange={(value) => setTemperature(typeof value === 'number' ? value : null)}
                          placeholder="0.4"
                        />
                      </Form.Item>
                    </div>
                  ),
                },
              ]}
            />

            <Flex align="center" gap={10} wrap style={{ marginTop: 6 }}>
              <Button type="primary" onClick={() => void saveCustom()} loading={busy}>
                保存并使用
              </Button>
              <Button onClick={() => void testDraft()} disabled={busy}>
                测试连接
              </Button>
              {settings?.hasKey ? (
                <Button
                  type="text"
                  size="small"
                  onClick={() => {
                    void put({ apiKey: '' }, '已清除保存的 Key').then(() => {
                      setApiKey('')
                    })
                  }}
                >
                  清除已保存的 Key
                </Button>
              ) : null}
              {testResult ? (
                <Badge tone={testResult.ok ? 'ok' : 'danger'}>{testResult.text}</Badge>
              ) : null}
            </Flex>

            {!testResult ? (
              <Paragraph type="secondary" style={{ fontSize: 11.5, marginTop: 12, marginBottom: 0 }}>
                保存前可以先「测试连接」：它只测当前草稿，不会落库。
              </Paragraph>
            ) : null}
          </Form>
        )}
      </Drawer>
    </>
  )
}
