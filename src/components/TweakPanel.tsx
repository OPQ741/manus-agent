import { Button, Flex, Space, Typography } from 'antd'
import { BgColorsOutlined, ReloadOutlined } from '@ant-design/icons'
import type { DesignTweak } from '../../shared/types'
import { RADIUS_MAX, tweakVars } from '../../shared/theme'

/**
 * 设计微调面板：改主色 / 圆角。
 *
 * 这一层刻意**不经过模型**：颜色是确定性的设计令牌变换，
 * 走一次生成既慢（秒级）又不稳（同样的描述每次颜色都不一样）。
 * 面板只负责收集意图，真正的"生效"由宿主 postMessage 推给沙箱，
 * 所以调色时应用里的输入内容、滚动位置、已填表单都不会被重置。
 */

const { Text } = Typography

const PRESETS: { label: string; hex: string }[] = [
  { label: '墨绿', hex: '#17624b' },
  { label: '靛蓝', hex: '#4f46e5' },
  { label: '玫红', hex: '#e11d6b' },
  { label: '琥珀', hex: '#b45309' },
  { label: '石墨', hex: '#334155' },
  { label: '天青', hex: '#0e7490' },
]

const DEFAULT_RADIUS = 14

interface Props {
  tweak: DesignTweak
  supportsTokens: boolean
  saving: boolean
  onChange: (next: DesignTweak) => void
  onReset: () => void
}

export function TweakPanel({ tweak, supportsTokens, saving, onChange, onReset }: Props) {
  const accent = tweak.accent ?? ''
  const radius = typeof tweak.radius === 'number' ? tweak.radius : DEFAULT_RADIUS
  const vars = tweakVars(tweak)

  return (
    <Flex className="tweak-panel" align="center" gap={10} wrap role="group" aria-label="设计微调">
      <Text type="secondary" style={{ fontSize: 12 }}>
        <BgColorsOutlined /> 主色
      </Text>

      <Space size={6}>
        {PRESETS.map((preset) => (
          <button
            key={preset.hex}
            type="button"
            className={`swatch${accent === preset.hex ? ' is-on' : ''}`}
            style={{ background: preset.hex }}
            aria-label={`主色 ${preset.label}`}
            aria-pressed={accent === preset.hex}
            title={preset.label}
            onClick={() => onChange({ ...tweak, accent: preset.hex })}
          />
        ))}
        {/* 自定义颜色用浏览器原生取色器：它是系统级控件，比再引一个调色板组件更轻也更准 */}
        <label className={`swatch swatch-color${accent && !PRESETS.some((preset) => preset.hex === accent) ? ' is-on' : ''}`} title="自定义颜色">
          <input
            type="color"
            value={accent || '#17624b'}
            aria-label="自定义主色"
            onChange={(event) => onChange({ ...tweak, accent: event.target.value })}
          />
          <span style={{ background: accent || 'conic-gradient(#e11d6b,#4f46e5,#0e7490,#b45309,#e11d6b)' }} />
        </label>
      </Space>

      <span className="tweak-sep" />

      <Text type="secondary" style={{ fontSize: 12 }}>
        圆角
      </Text>
      {/*
        这里刻意保留原生 range：它是浏览器级的无障碍控件（键盘、触摸、辅助技术全部原生支持），
        换成 Slider 只会多一层包装。视觉用 accent-color 跟随主题，不额外写样式。
      */}
      <input
        className="tweak-range"
        type="range"
        min={0}
        max={RADIUS_MAX}
        step={1}
        value={radius}
        aria-label="圆角大小"
        onChange={(event) => onChange({ ...tweak, radius: Number(event.target.value) })}
      />
      <Text className="mono" style={{ fontSize: 12 }}>
        {radius}px
      </Text>

      <div className="spacer" />

      {saving ? (
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          保存中…
        </Text>
      ) : null}
      {!supportsTokens ? (
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          该应用未声明设计令牌，只能调圆角
        </Text>
      ) : null}
      {Object.keys(vars).length > 0 ? (
        <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onReset} title="清除微调，回到生成时的外观">
          恢复默认
        </Button>
      ) : null}
    </Flex>
  )
}
