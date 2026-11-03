/**
 * 设计微调：把 { accent, radius } 翻译成一段覆盖 CSS，并注入到组装产物里。
 *
 * 为什么是"覆盖变量"而不是"重新生成"：
 *  - 生成物统一用 --accent / --accent-soft / --accent-ink / --radius 表达视觉；
 *  - 改一个颜色属于**确定性变换**，交给模型既不快也不稳（同一句"换成墨绿"每次出来的绿都不一样）；
 *  - 覆盖只动 CSS，不动 DOM，所以应用内的状态、表单内容、滚动位置全部保留。
 *
 * 派生规则在 shared/theme.ts（前端实时推送也用同一份），这里只负责：
 * 校验输入、生成 <style>、注入 HTML。
 */

import type { DesignTweak } from '../types'
import { RADIUS_MAX, RADIUS_MIN, normalizeHex, tweakVars } from '../theme'

export { RADIUS_MAX, RADIUS_MIN, contrastInk, lighten, normalizeHex, tweakVars } from '../../shared/theme'

/** 服务端入口校验：任何字段不合法就丢掉该字段，而不是整单拒绝。 */
export function sanitizeTweak(input: unknown): DesignTweak | undefined {
  if (!input || typeof input !== 'object') return undefined
  // JSON.parse 出来的对象带原型链：`{tweak:{accent:"toString"}}` 之类会让
  // 属性查找落到 Object.prototype 上，拿到一个函数而不是字符串。
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return undefined
  const source = input as Record<string, unknown>
  const tweak: DesignTweak = {}

  const accent = normalizeHex(source.accent)
  if (accent) tweak.accent = accent

  if (source.radius !== undefined && source.radius !== null) {
    const radius = Number(source.radius)
    if (Number.isFinite(radius)) {
      tweak.radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Math.round(radius)))
    }
  }

  return Object.keys(tweak).length > 0 ? tweak : undefined
}

export function tweakCss(tweak: DesignTweak): string {
  const vars = tweakVars(tweak)
  const keys = Object.keys(vars)
  if (keys.length === 0) return ''
  const body = keys.map((key) => `  ${key}: ${vars[key]};`).join('\n')
  return `:root {\n${body}\n}`
}

/**
 * 把微调样式插到 </head> 之前。
 *
 * 必须在**所有**应用自有样式之后：同优先级下"后写者胜"，
 * 这是唯一不需要 !important 就能覆盖 :root 变量的位置。
 */
export function injectTweak(html: string, tweak: DesignTweak | undefined): string {
  if (!tweak) return html
  const css = tweakCss(tweak)
  if (!css) return html
  const tag = `<style data-nucleus="tweak">\n${css}\n</style>`
  const head = /<\/head>/i.exec(html)
  if (!head) return tag + '\n' + html
  return html.slice(0, head.index) + tag + '\n' + html.slice(head.index)
}

/** 应用是否真的用设计令牌表达视觉：决定微调面板要不要提示"可能不生效"。 */
export function usesDesignTokens(html: string): boolean {
  return /--accent\s*:/.test(html) || /--radius\s*:/.test(html)
}
