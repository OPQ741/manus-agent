import type { DesignTweak } from '../../shared/types'
import { RADIUS_MAX, tweakVars } from '../../shared/theme'
import { IconPalette, IconRefresh } from './ui'

/**
 * 设计微调面板：改主色 / 圆角。
 *
 * 这一层刻意**不经过模型**：颜色是确定性的设计令牌变换，
 * 走一次生成既慢（秒级）又不稳（同样的描述每次颜色都不一样）。
 * 面板只负责收集意图，真正的"生效"由宿主 postMessage 推给沙箱，
 * 所以调色时应用里的输入内容、滚动位置、已填表单都不会被重置。
 */

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
    <div className="tweak-panel" role="group" aria-label="设计微调">
      <span className="tweak-label">
        <IconPalette size={13} /> 主色
      </span>
      <div className="tweak-swatches">
        {PRESETS.map((preset) => (
          <button
            key={preset.hex}
            className="swatch"
            style={{ background: preset.hex }}
            aria-label={`主色 ${preset.label}`}
            aria-pressed={accent === preset.hex}
            title={preset.label}
            onClick={() => onChange({ ...tweak, accent: preset.hex })}
          />
        ))}
        <label className="swatch custom" title="自定义颜色">
          <input
            type="color"
            value={accent || '#17624b'}
            aria-label="自定义主色"
            onChange={(event) => onChange({ ...tweak, accent: event.target.value })}
          />
          <span style={{ background: accent || 'conic-gradient(#e11d6b,#4f46e5,#0e7490,#b45309,#e11d6b)' }} />
        </label>
      </div>

      <span className="tweak-sep" />

      <span className="tweak-label">圆角</span>
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
      <span className="mono tweak-value">{radius}px</span>

      <span className="spacer" />

      {saving ? <span className="tweak-hint">保存中…</span> : null}
      {!supportsTokens ? <span className="tweak-hint">该应用未声明设计令牌，只能调圆角</span> : null}
      {Object.keys(vars).length > 0 ? (
        <button className="btn sm ghost" onClick={onReset} title="清除微调，回到生成时的外观">
          <IconRefresh size={12} /> 恢复默认
        </button>
      ) : null}
    </div>
  )
}
