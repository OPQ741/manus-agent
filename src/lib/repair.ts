/**
 * 自检项 → 修复指令。
 *
 * 自检面板最没用的一种形态是「告诉你哪里不对，然后什么都不给」。这里把每一项
 * 翻译成一句**模型能直接执行**的指令：带上失败原因、带上合法取值（图标名）、
 * 带上文件边界（只输出改动的文件）。这样"修复"就不是重开一轮抽卡，而是一次定向修补。
 */

import type { Check, FileEntry } from '../../shared/types'
import { ICON_NAMES } from '../../shared/preview/icons'

/** 内置图标名清单：给模型看"能用的只有这些"，比让它猜有效得多。 */
const ICON_VOCAB = ICON_NAMES.join(' ')

/** 从 `syntax:app.js` 这类 id 里取出文件名。 */
export function fileOfCheck(check: Check): string | null {
  const match = /^syntax:(.+)$/.exec(check.id)
  if (match?.[1]) return match[1]
  return null
}

/**
 * 「去代码里改」要跳到哪个文件。
 *
 * 语法类检查自带文件名；图标类没有，只能反查 —— 拿未识别的名字去内容里找，
 * 命中一个文件才跳，命中多个就老老实实打开代码页让用户自己选。
 */
export function fileForCheck(check: Check, files: FileEntry[]): string | null {
  const direct = fileOfCheck(check)
  if (direct) return direct
  if (check.id !== 'icons') return null
  const unknown = /未识别：(.+)$/.exec(check.detail ?? '')?.[1]
  if (!unknown) return null
  const names = unknown.split(/[、,]\s*/).map((name) => name.trim()).filter(Boolean)
  const hits = files.filter((file) => names.some((name) => file.content.includes(`data-icon="${name}"`) || file.content.includes(`data-icon='${name}'`)))
  return hits.length === 1 ? hits[0]!.path : null
}

export function checkRepairPrompt(check: Check): string {
  const detail = check.detail ?? '未通过'

  if (check.id === 'icons') {
    return `自检项「图标解析」没有通过：${detail}。

这些 <svg data-icon="..."> 名字不在内置图标库里，预览里会显示成空白方块。请把它们换成下面这些合法名字之一：
${ICON_VOCAB}

要求：
1. 选语义最接近的那个（比如 wallet 用 credit-card，lucide-x 用 x）；
2. 不要新增图标库、不要自己画 path、不要用 emoji 顶替；
3. 只输出包含这些图标的文件，其余文件不要重复输出。`
  }

  const file = fileOfCheck(check)
  if (file) {
    return `文件 ${file} 没有通过语法检查：${detail}。

请重写这个文件：结构要完整、最后一个函数/标签必须闭合，不要中途截断，不要给片段。
与它配合的其他文件（DOM id、class、全局函数名）保持原样，不要顺手改。只输出 ${file} 这一个文件。`
  }

  if (check.id === 'assets') {
    return `自检项「图片资产内联」没有通过：${detail}。

预览只支持把**纯文本 SVG** 内联成 data URI，位图（png/jpg）没有落库通道。
请把出问题的图片改成 assets/xxx.svg 形式的纯文本 SVG，或者在页面里直接用内联 SVG；不要用外链图片。只输出需要改动的文件。`
  }

  if (check.id === 'refs') {
    return `自检项「引用完整性」没有通过：${detail}。

有文件引用了项目里不存在的资源（样式、脚本、页面或图片）。请补齐缺失的文件，或者把引用改成实际存在的路径。
不要重写没问题的文件，只输出新增或修好的那几个。`
  }

  return `自检项「${check.label}」没有通过：${detail}。

请定位原因并修复，只输出需要改动的文件，不要重写没有问题的部分。`
}

/** 「全部修复」：把失败项打包成一条指令，避免用户点五次、模型跑五轮。 */
export function batchRepairPrompt(checks: Check[]): string {
  const rows = checks.map((check, index) => `${index + 1}) ${check.label}：${check.detail ?? '未通过'}`).join('\n')
  return `自检有 ${checks.length} 项没有通过，请一起修好：
${rows}

要求：
1. 逐项对应修复，不要改动与这些项无关的部分；
2. 图标只能从内置图标库里选：${ICON_VOCAB}
3. 只输出发生变化的文件，每个文件都要完整、可运行，不要截断。`
}
