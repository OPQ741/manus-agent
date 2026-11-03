import type { AgentEvent, DesignPrefs } from '../shared/types'

export const DESIGN: DesignPrefs = { accent: '#4B3BFF', theme: 'light', locale: 'zh' }

/**
 * 把事件流"折叠"成稳定投影：相邻 note 合并、file_delta 折叠进文件内容。
 *
 * 为什么需要它：流式解析时，同样的输入按不同分块喂入，note 会被切成多个事件、
 * file_delta 的切点也不同 —— 这是流式的本质，不是 bug。真正要断言的不变量是
 * "最终内容与顺序一致"，所以测试比较的是投影，而不是原始事件数组。
 */
export type Projected =
  | { kind: 'note'; text: string }
  | { kind: 'notice'; level: 'info' | 'warn'; text: string }
  | { kind: 'plan'; name: string; files: string[] }
  | { kind: 'file'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'warning' }
  | { kind: 'error'; code: string }
  | { kind: 'done' }

export function project(events: AgentEvent[]): Projected[] {
  const out: Projected[] = []
  let noteBuffer = ''
  const flushNote = () => {
    if (noteBuffer.trim()) out.push({ kind: 'note', text: noteBuffer.trim() })
    noteBuffer = ''
  }
  const fileContents = new Map<string, string>()

  for (const event of events) {
    switch (event.type) {
      case 'note':
        noteBuffer += event.text
        break
      case 'notice':
        flushNote()
        out.push({ kind: 'notice', level: event.level, text: event.message })
        break
      case 'plan':
        flushNote()
        out.push({ kind: 'plan', name: event.plan.name, files: event.plan.files.map((f) => f.path) })
        break
      case 'file_start':
        flushNote()
        fileContents.set(event.path, '')
        out.push({ kind: 'file', path: event.path, content: '' })
        break
      case 'file_delta': {
        fileContents.set(event.path, (fileContents.get(event.path) ?? '') + event.chunk)
        break
      }
      case 'file_end': {
        flushNote()
        const index = out.findIndex((item) => item.kind === 'file' && item.path === event.path && item.content === '')
        const content = event.content
        if (index >= 0) out[index] = { kind: 'file', path: event.path, content }
        break
      }
      case 'delete':
        flushNote()
        out.push({ kind: 'delete', path: event.path })
        break
      case 'warning':
        out.push({ kind: 'warning' })
        break
      case 'error':
        flushNote()
        out.push({ kind: 'error', code: event.code })
        break
      case 'done':
        flushNote()
        out.push({ kind: 'done' })
        break
      default:
        break
    }
  }
  flushNote()
  return out.filter((item) => !(item.kind === 'file' && item.content === '' && false))
}

/** 把整段文本按随机/固定大小切块喂给解析器。 */
export function splitEvery(text: string, size: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}
