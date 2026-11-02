/**
 * 设计令牌的派生规则 —— 前后端共用同一份实现。
 *
 * 为什么必须共用：宿主实时把变量推给 iframe 时用的是这里的算法，
 * 服务端注入 <style> 时用的也是这里的算法。两边只要有一处偏差，
 * 就会出现"调色时是 A 色、刷新后变成 B 色"的诡异不一致。
 */

import type { DesignTweak } from './types'

export const RADIUS_MIN = 0
export const RADIUS_MAX = 28

/** 归一化任意写法（#abc / #aabbcc / 大写）为 #rrggbb；不认识就返回 null。 */
export function normalizeHex(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  const full = /^#([0-9a-f]{6})$/i.exec(raw)
  if (full) return `#${full[1]}`.toLowerCase()
  return null
}

function channels(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

/** 往白色方向混色：派生 --accent-soft（浅底）。ratio=0.86 近似 12% 透明度的观感。 */
export function lighten(hex: string, ratio: number): string {
  const [r, g, b] = channels(hex)
  const mix = (channel: number) => channel + (255 - channel) * ratio
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}

/** 主色上的文字色：亮底用深字，暗底用白字。阈值与本地引擎一致，避免两种观感。 */
export function contrastInk(hex: string): string {
  const [r, g, b] = channels(hex)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.62 ? '#14140f' : '#ffffff'
}

/** 一个 tweak → 一整组 CSS 变量。注入 <style> 与 postMessage 都用它。 */
export function tweakVars(tweak: DesignTweak): Record<string, string> {
  const vars: Record<string, string> = {}
  if (tweak.accent) {
    vars['--accent'] = tweak.accent
    vars['--accent-soft'] = lighten(tweak.accent, 0.86)
    vars['--accent-ink'] = contrastInk(tweak.accent)
  }
  if (typeof tweak.radius === 'number') vars['--radius'] = `${tweak.radius}px`
  return vars
}
