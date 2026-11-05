/**
 * 会话上下文：把"这个项目之前发生过什么"压成一千字以内塞进提示词。
 *
 * 为什么必须有这一层：`editTurnMessages` 以前只发三样东西 —— 设计参数、文件全文、
 * 这一句新指令，**一条历史都不带**。于是第 12 轮说"改成刚才那个深色"时，模型
 * 不知道"刚才"指什么；它只能从代码里猜，猜错就要用户再解释一遍。
 *
 * 为什么不用模型摘要：这里的目标是"让指代可解析"，不是"读懂整段对话"。版本标签
 * （`v3 加分类占比条`）和 changed 列表已经把"我们一路改了什么"说清楚了，而且
 * 零 token、零延迟、不会编造 —— 需要模型理解力的那部分留给 §2.2 第三层，
 * 那是另一个开关，不该混在基础上下文里。
 *
 * 预算：整块控制在 ~1.6 KB，相对 24 KB 的文件上下文可忽略；但也不能无限长，
 * 否则它会把真正的代码挤出去。
 */

import type { DesignPrefs, Message, Plan, Version } from '../../shared/types'

/** 最近几轮：8 轮足够覆盖"刚才""上面那个"的指代范围，再多只是重复。 */
const MAX_TURNS = 8
/** 单条截断：用户那句话的重点通常在前 100 字，多了只是复述。 */
const MAX_LINE = 100
/** 版本进展只列最近几版：更早的已经被后续版本覆盖，说了反而误导。 */
const MAX_VERSIONS = 5
/** 每行最多列几个文件：够说明"改了哪块"，又不会变成文件清单。 */
const MAX_FILES_PER_LINE = 4

function clip(text: string, max = MAX_LINE): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function changedOf(meta: Record<string, unknown> | undefined): string[] {
  const changed = meta?.changed
  return Array.isArray(changed) ? changed.filter((item): item is string => typeof item === 'string') : []
}

function filesText(list: string[]): string {
  if (list.length === 0) return '无'
  const head = list.slice(0, MAX_FILES_PER_LINE).join('、')
  return list.length > MAX_FILES_PER_LINE ? `${head} 等 ${list.length} 个` : head
}

/**
 * 最近几轮的对话。
 *
 * 只收两类消息：用户的原话，和"助手改了什么"。错误、停止、放弃这类过程记录
 * 一律剔除 —— 它们对"理解这一句在指什么"没有帮助，只会占掉本就不多的预算。
 *
 * @param currentPrompt 本次生成要发的指令：它已经作为最后一条用户消息落库了，
 *   如果不剔除，模型会看到同一句话出现两遍（一遍在 history，一遍在正文）。
 */
export function historyBlock(messages: Message[], currentPrompt = ''): string {
  const turns: Message[] = []
  for (const message of messages) {
    if (message.role === 'user' && message.kind === 'text') turns.push(message)
    else if (message.role === 'agent' && (message.kind === 'text' || message.kind === 'plan')) turns.push(message)
  }

  const last = turns[turns.length - 1]
  if (currentPrompt && last?.role === 'user' && last.content.trim() === currentPrompt.trim()) turns.pop()

  const recent = turns.slice(-MAX_TURNS)
  if (recent.length === 0) return ''

  const lines = recent.map((message) => {
    if (message.role === 'user') return `- 用户：${clip(message.content)}`
    const version = typeof message.meta?.version === 'number' ? (message.meta.version as number) : null
    const changed = changedOf(message.meta)
    // 有 meta 就报"改了哪些文件"（信息密度最高）；老数据没有 meta 才退回正文
    const what = changed.length > 0 ? `改了 ${filesText(changed)}` : clip(message.content, 60)
    return `  · 助手：${version ? `v${version} ` : ''}${what}`
  })

  return `<history>\n最近几轮（从旧到新；只用于理解"刚才""上面那个"这类指代，不要复述）：\n${lines.join('\n')}\n</history>`
}

/**
 * 项目摘要：版本标签 + 改动文件 + 当前设计参数。
 *
 * 全部来自已有数据（`versions[].label`、`versions[].changed`、`project.design`），
 * 所以它不可能编造事实 —— 这是它比"让模型总结一遍"更可靠的地方。
 */
export function summaryBlock(plan: Plan | null, versions: Version[], design: DesignPrefs): string {
  const rows = versions.slice(-MAX_VERSIONS).map((version) => {
    const label = clip(version.label, 48) || `第 ${version.seq} 版`
    return `- v${version.seq} ${label}：${filesText(version.changed)}`
  })

  if (!plan && rows.length === 0) return ''

  const theme = design.theme === 'dark' ? '深色主题' : design.theme === 'auto' ? '跟随系统' : '浅色主题'
  const head = plan ? `项目：${plan.name}（${clip(plan.summary, 40) || '暂无简介'}）` : '项目：（尚未定稿方案）'
  const body = rows.length > 0 ? `\n版本进展：\n${rows.join('\n')}` : ''
  return `<summary>\n${head}${body}\n当前设计：主色 ${design.accent}；${theme}\n</summary>`
}

/** 拼成最终注入提示词的那一段（没有历史时返回空串，调用方据此省略整段）。 */
export function projectContext(input: {
  messages: Message[]
  versions: Version[]
  plan: Plan | null
  design: DesignPrefs
  prompt: string
}): string {
  return [summaryBlock(input.plan, input.versions, input.design), historyBlock(input.messages, input.prompt)]
    .filter(Boolean)
    .join('\n')
}
