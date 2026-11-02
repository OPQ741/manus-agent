/**
 * 微调的**传输层**契约：把界面上的 draft 翻成一个服务端一定能听懂的载荷。
 *
 * 单独抽出来的原因是一次真实事故：`JSON.stringify({ tweak: undefined })` 得到 `{}`，
 * 服务端看不见 `tweak` 这个键，于是「恢复默认」只活了 3 秒 —— 一点色卡当场生效，
 * 一刷新又回到旧配色。这类 bug 的特点是"没有任何一层报错"，所以契约必须写成可断言的纯函数。
 *
 * 规则只有一条：**空微调永远发 null（= 清除），绝不发 undefined（= 什么都不发）**。
 */

import type { DesignTweak } from './types'
import { isTweakEmpty } from './theme'

export type TweakPayload = DesignTweak | null

/** 归一化：丢掉空字段；全空 → null。 */
export function tweakPayload(input: DesignTweak | TweakPayload | undefined): TweakPayload {
  if (!input || isTweakEmpty(input)) return null
  const next: DesignTweak = {}
  if (typeof input.accent === 'string' && input.accent) next.accent = input.accent
  if (typeof input.radius === 'number' && Number.isFinite(input.radius)) next.radius = input.radius
  return isTweakEmpty(next) ? null : next
}

/** 这条载荷经过 JSON 之后，服务端还能不能看见 tweak 键。用于守住上面那条规则。 */
export function serializedCarriesTweak(input: DesignTweak | TweakPayload | undefined): boolean {
  const json = JSON.stringify({ tweak: tweakPayload(input) })
  return json.includes('"tweak"')
}
