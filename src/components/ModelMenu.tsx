import { useMemo, useState } from 'react'
import { Button, Divider, Empty, Input, Popover, Typography } from 'antd'
import {
  ApiOutlined,
  CaretDownOutlined,
  CheckCircleFilled,
  SettingOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { Project, ProviderOption, PublicSettings } from '../../shared/types'
import { Badge, toast } from './ui'
import { api } from '../lib/api'
import type { ModelChoice } from '../lib/model-prefs'

const { Text } = Typography

export type { ModelChoice }

/**
 * 顶栏的模型入口。
 *
 * 上一版这里是一枚只读徽章：写着"我的模型"，点不动，也说不清到底在跑哪个模型 ——
 * 而"这次用的哪个模型"恰恰是用户最常追问的一句（质量好坏、截断、速度全由它决定）。
 *
 * 这一版把它做成一个**就地可改**的配置口：
 *  1. 按钮上直接显示「通道 · 模型名」，不用点开就能读到答案；
 *  2. 点开可以换通道、换同一家的模型，改动只作用于**这个项目**；
 *  3. 想改全局（Key、自定义接入、默认通道）再跳设置页，两件事不再混在一起。
 */
export function ModelMenu({
  project,
  settings,
  value,
  onChange,
}: {
  project: Project
  settings: PublicSettings | null
  /** 本项目的选择：null = 跟随设置 */
  value: ModelChoice | null
  onChange: (choice: ModelChoice | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [testing, setTesting] = useState(false)

  const providers = settings?.providers ?? []
  const activeId = value?.provider || project.provider || settings?.active?.id || ''
  const option = providers.find((item) => item.id === activeId) ?? null

  const model =
    value?.model ||
    (activeId === project.provider ? project.providerModel : '') ||
    option?.model ||
    settings?.active?.model ||
    ''
  const label = option?.label || project.providerLabel || settings?.active?.label || '选择模型'
  const free = option?.free ?? settings?.active?.free ?? false

  const ready = useMemo(() => providers.filter((item) => item.ready), [providers])
  const models = useMemo(() => {
    const list = option?.models?.length ? option.models : option ? [option.model] : []
    return [...new Set([model, ...list].filter(Boolean))]
  }, [option, model])

  const pick = (provider: ProviderOption) => {
    onChange({ provider: provider.id, model: provider.model })
    setDraft('')
  }

  const pickModel = (next: string) => {
    if (!activeId || !next.trim()) return
    onChange({ provider: activeId, model: next.trim() })
    setDraft('')
  }

  const test = async () => {
    setTesting(true)
    try {
      const result = await api.testConnection()
      toast(`连通正常 · ${result.ms}ms · ${result.provider}`)
    } catch (error) {
      toast(error instanceof Error ? error.message : '连接失败')
    } finally {
      setTesting(false)
    }
  }

  const content = (
    <div className="model-menu">
      <div className="model-menu-head">
        <div className="model-menu-title">
          <span className={`model-dot${free ? ' free' : ''}`} />
          <Text strong>{label}</Text>
          {free ? <Badge tone="ok">免 Key</Badge> : null}
          {value ? <Badge tone="accent">本项目指定</Badge> : null}
        </div>
        <div className="model-menu-model mono">{model || '未指定模型'}</div>
        <div className="model-menu-reason">
          {value
            ? '只影响这个项目的下一次生成，不改变设置里的默认通道。'
            : settings?.activeReason || '跟随设置里的默认通道。'}
        </div>
      </div>

      <Divider className="model-menu-divider" />

      <div className="model-menu-section">
        <div className="model-menu-caption">
          通道
          <span className="model-menu-caption-hint">已就绪的才能选</span>
        </div>
        {ready.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可用通道，去设置里填一个 Key" />
        ) : (
          <div className="model-options">
            {ready.map((item) => {
              const on = item.id === activeId
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`model-option${on ? ' is-on' : ''}`}
                  onClick={() => pick(item)}
                  aria-pressed={on}
                >
                  <span className="model-option-main">
                    <span className="model-option-label">
                      {item.label}
                      {item.free ? <Badge tone="ok">免 Key</Badge> : null}
                      {item.isDefault ? <Badge>默认</Badge> : null}
                    </span>
                    <span className="model-option-model mono">{item.model}</span>
                  </span>
                  {on ? <CheckCircleFilled className="model-option-check" /> : null}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {models.length > 1 ? (
        <div className="model-menu-section">
          <div className="model-menu-caption">
            模型
            <span className="model-menu-caption-hint">同一通道内切换</span>
          </div>
          <div className="model-chips">
            {models.map((item) => (
              <button
                key={item}
                type="button"
                className={`model-chip mono${item === model ? ' is-on' : ''}`}
                onClick={() => pickModel(item)}
                aria-pressed={item === model}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="model-menu-section">
        <Input
          size="small"
          value={draft}
          placeholder="或手填模型名，回车生效"
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={() => pickModel(draft)}
          spellCheck={false}
        />
      </div>

      <div className="model-menu-foot">
        <Button size="small" type="text" icon={<ApiOutlined />} loading={testing} onClick={() => void test()}>
          测试生效通道
        </Button>
        <div className="spacer" />
        {value ? (
          <Button size="small" type="text" onClick={() => onChange(null)}>
            跟随设置
          </Button>
        ) : null}
        <Button
          size="small"
          type="text"
          icon={<SettingOutlined />}
          onClick={() => {
            setOpen(false)
            window.location.hash = '#/settings'
          }}
        >
          完整设置
        </Button>
      </div>
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      arrow={false}
      styles={{ body: { padding: 12, width: 384 } }}
      content={content}
    >
      <button type="button" className="model-btn" aria-label="模型设置">
        <ThunderboltOutlined className="model-btn-icon" />
        <span className="model-btn-label">{label}</span>
        <span className="model-btn-model mono" title={model}>
          {model || '默认模型'}
        </span>
        <CaretDownOutlined className="model-btn-caret" />
      </button>
    </Popover>
  )
}

/** 顶栏里的一句话摘要：给 Tooltip / 卡片复用，避免各处自行拼字符串。 */
export function modelSummary(label: string, model?: string): string {
  return model ? `${label} · ${model}` : label
}
