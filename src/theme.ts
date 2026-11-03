/**
 * Ant Design 主题令牌 —— 品牌与视觉参数只在这里定义一次。
 *
 * 为什么集中到这一处：改造前颜色/圆角/阴影散落在 1400 行手写 CSS 里，
 * 改一个按钮高度要翻十处；现在组件样式由 antd 令牌统一驱动，
 * 页面层只负责「排版骨架」（见 styles.css），两件事不再互相污染。
 *
 * 主题是**函数**而不是常量：设置页换主色、切深色都要当场重算，
 * 且两套取值必须和 styles.css 的 `[data-theme='dark']` 一一对应，否则会出现
 * "按钮是深色、页面背景还是浅色"的割裂感。
 */
import { theme as antdAlgorithms } from 'antd'
import type { ThemeConfig } from 'antd'

/** 与 styles.css 的 :root 变量保持同一套取值，避免两套色板漂移。 */
export const PALETTE = {
  accent: '#4b3bff',
  bg: '#faf9f7',
  surface: '#ffffff',
  ink: '#14141a',
  inkSoft: '#3d3d47',
  muted: '#6e6e78',
  line: '#e8e6e1',
  ok: '#0f7a5a',
  warn: '#a9651f',
  danger: '#c2405c',
} as const

export const DEFAULT_ACCENT = PALETTE.accent

const DARK = {
  bg: '#131318',
  surface: '#1a1a21',
  ink: '#ececf3',
  muted: '#9b9ba9',
  line: '#2a2a34',
  ok: '#3fbf95',
  warn: '#e0a44a',
  danger: '#ef6a86',
} as const

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

/**
 * 生成一套 antd 主题。
 *
 * @param accent 主色（来自界面外观设置）
 * @param dark   是否深色。深色走 antd 的 darkAlgorithm，只覆盖我们自己的中性色。
 */
export function buildTheme(accent: string, dark: boolean): ThemeConfig {
  return {
    algorithm: dark ? antdAlgorithms.darkAlgorithm : antdAlgorithms.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorInfo: accent,
      colorSuccess: dark ? DARK.ok : PALETTE.ok,
      colorWarning: dark ? DARK.warn : PALETTE.warn,
      colorError: dark ? DARK.danger : PALETTE.danger,
      colorText: dark ? DARK.ink : PALETTE.ink,
      colorTextSecondary: dark ? DARK.muted : PALETTE.muted,
      colorBorder: dark ? DARK.line : PALETTE.line,
      colorBorderSecondary: dark ? DARK.line : PALETTE.line,
      colorBgLayout: dark ? DARK.bg : PALETTE.bg,
      colorBgContainer: dark ? DARK.surface : PALETTE.surface,
      fontFamily: FONT_STACK,
      fontSize: 14,
      borderRadius: 10,
      borderRadiusLG: 14,
      borderRadiusSM: 8,
      controlHeight: 34,
      controlHeightSM: 28,
      wireframe: false,
      motionDurationMid: '0.16s',
    },
    components: {
      Button: { fontWeight: 550, primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none' },
      Card: { paddingLG: 18, headerFontSize: 13, boxShadowTertiary: 'none' },
      Tag: {
        defaultBg: dark ? '#23232c' : '#f2f0ec',
        defaultColor: dark ? '#c8c8d4' : PALETTE.inkSoft,
        borderRadiusSM: 6,
      },
      Tabs: { horizontalItemPadding: '10px 0 8px', titleFontSize: 13, horizontalItemGutter: 20 },
      Segmented: {
        itemSelectedColor: dark ? '#ffffff' : PALETTE.ink,
        itemSelectedBg: dark ? '#33333f' : '#ffffff',
        trackBg: dark ? '#20202a' : '#f2f0ec',
      },
      Alert: { defaultPadding: '8px 12px' },
      Empty: { colorTextDescription: dark ? DARK.muted : PALETTE.muted },
      Tooltip: { fontSize: 12 },
    },
  }
}
