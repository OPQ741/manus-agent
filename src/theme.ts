/**
 * Ant Design 主题令牌 —— 品牌与视觉参数只在这里定义一次。
 *
 * 为什么集中到这一处：改造前颜色/圆角/阴影散落在 1400 行手写 CSS 里，
 * 改一个按钮高度要翻十处；现在组件样式由 antd 令牌统一驱动，
 * 页面层只负责「排版骨架」（见 styles.css），两件事不再互相污染。
 */
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

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: PALETTE.accent,
    colorInfo: PALETTE.accent,
    colorSuccess: PALETTE.ok,
    colorWarning: PALETTE.warn,
    colorError: PALETTE.danger,
    colorText: PALETTE.ink,
    colorTextSecondary: PALETTE.muted,
    colorBorder: PALETTE.line,
    colorBorderSecondary: PALETTE.line,
    colorBgLayout: PALETTE.bg,
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
    Tag: { defaultBg: '#f2f0ec', defaultColor: PALETTE.inkSoft, borderRadiusSM: 6 },
    Tabs: { horizontalItemPadding: '10px 0 8px', titleFontSize: 13, horizontalItemGutter: 20 },
    Segmented: { itemSelectedColor: PALETTE.ink, trackBg: '#f2f0ec' },
    Alert: { defaultPadding: '8px 12px' },
    Empty: { colorTextDescription: PALETTE.muted },
    Tooltip: { fontSize: 12 },
  },
}
