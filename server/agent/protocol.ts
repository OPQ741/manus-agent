/**
 * NWF（Nucleus Wire Format）—— 生成协议。
 *
 * 设计目标（详见 docs/04-技术设计文档.md §1）：
 *  1. 内容区不转义，模型不容易写坏；
 *  2. 增量可解析，任何位置断流都能恢复到"已产出的部分"；
 *  3. 解析器永不抛异常 —— 模型犯错是常态，不能让错误冒泡成 500。
 *
 * 语法：
 *   <note>...</note>
 *   <plan>{...json...}</plan>
 *   <file path="index.html">
 *   ...任意内容...
 *   </file>
 *   <delete path="old.js"/>
 */

import type { AgentEvent, Plan, PlanFile } from '../../shared/types'

const CLOSE_FILE = /<\s*\/\s*file\s*>/i
const OPEN_FILE = /<\s*file\s+([^>]*?)\s*>/i
const PLAN_OPEN = /<\s*plan\s*>/i
const PLAN_CLOSE = /<\s*\/\s*plan\s*>/i
const NOTE_OPEN = /<\s*note\s*>/i
const NOTE_CLOSE = /<\s*\/\s*note\s*>/i
const DELETE_TAG = /<\s*delete\s+([^>]*?)\/?\s*>/i

/** 流结束前保留的尾巴长度：`</file>` 是 7 字符，留 10 保证任何半截标签都不会被当成正文。 */
const SAFE_TAIL = 10

const TAG_NAMES = ['file', 'plan', 'note', 'delete']

/**
 * 判断一段以 '<' 开头的文本是否"可能是一个还没写完的标签"。
 * 逐字符流式输入时，`<file path="index.html">` 会被切成 22 次 push，
 * 这里必须一路认到 '>' 为止，否则标签永远拼不起来。
 */
export function isPossibleTagPrefix(text: string): boolean {
  if (!text.startsWith('<')) return false
  if (text.includes('>')) return false // 已经闭合却没匹配上任何标签 → 是正文
  const partialName = /^<\s*\/?\s*([a-zA-Z]*)$/.exec(text)
  if (partialName) {
    const name = (partialName[1] ?? '').toLowerCase()
    return TAG_NAMES.some((tag) => tag.startsWith(name))
  }
  // 标签名已经完整，正在等属性或 '>'
  return /^<\s*\/?\s*(file|plan|note|delete)\b/i.test(text)
}

export interface ParserOptions {
  /** 收到 file_end 时的钩子，便于服务端做即时校验；返回 false 表示丢弃该文件。 */
  onFile?: (path: string, content: string) => boolean
}

/**
 * 文件名安全校验：白名单 + 禁止穿越。
 * 返回 null 表示非法，调用方应丢弃并给出 warning。
 */
export function sanitizePath(raw: string): string | null {
  if (typeof raw !== 'string') return null
  let p = raw.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  p = p.replace(/^\.\//, '')
  if (!p || p.length > 120) return null
  if (p.startsWith('/') || p.includes('..')) return null
  if (!/^[A-Za-z0-9_\-.]+(?:\/[A-Za-z0-9_\-.]+)*$/.test(p)) return null
  if (p.split('/').some((seg) => seg === '' || seg.startsWith('.'))) return null
  return p
}

/** 提取 `<file path="x">` 的属性；兼容 name / filename 拼写。 */
export function parsePathAttr(attrText: string): string | null {
  const m = /(?:^|\s)(path|name|filename)\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrText)
  if (!m) return null
  const value = m[3] ?? m[4]
  if (typeof value !== 'string') return null
  return sanitizePath(value)
}

/** 剥掉模型自作主张包上的 markdown 代码围栏。 */
export function stripFence(content: string): string {
  let text = content
  const fenced = /^```[a-zA-Z0-9]*[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/.exec(text.trim())
  if (fenced && typeof fenced[1] === 'string') {
    text = fenced[1]
  }
  return text
}

/** 去掉首尾各一个换行（模型习惯在标签后换行，不应该算进文件内容）。 */
export function trimEdgeNewline(content: string): string {
  let text = content
  if (text.startsWith('\r\n')) text = text.slice(2)
  else if (text.startsWith('\n')) text = text.slice(1)
  if (text.endsWith('\r\n')) text = text.slice(0, -2)
  else if (text.endsWith('\n')) text = text.slice(0, -1)
  return text
}

export function countLines(content: string): number {
  if (!content) return 0
  return content.split(/\r\n|\n|\r/).length
}

export function parsePlan(raw: string): Plan | null {
  const text = raw.trim()
  if (!text) return null
  const candidates = [text]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>
      if (!value || typeof value !== 'object') continue
      const files: PlanFile[] = Array.isArray(value.files)
        ? value.files
            .map((item) => {
              if (!item || typeof item !== 'object') return null
              const rec = item as Record<string, unknown>
              const path = typeof rec.path === 'string' ? sanitizePath(rec.path) : null
              if (!path) return null
              return { path, purpose: typeof rec.purpose === 'string' ? rec.purpose : '' }
            })
            .filter((item): item is PlanFile => item !== null)
        : []

      return {
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : '未命名应用',
        summary: typeof value.summary === 'string' ? value.summary.trim() : '',
        stack: typeof value.stack === 'string' && value.stack.trim() ? value.stack.trim() : 'HTML + CSS + JavaScript',
        steps: Array.isArray(value.steps) ? value.steps.filter((s): s is string => typeof s === 'string') : [],
        files,
      }
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null
}

/**
 * 增量解析器。每次 `push(chunk)` 返回本次新增的事件数组。
 * `end()` 收尾未闭合的块并返回剩余事件。
 */
export class ProtocolParser {
  private buffer = ''
  private mode: 'outside' | 'plan' | 'file' = 'outside'
  private currentPath: string | null = null
  private currentContent = ''
  private currentStarted = false
  private planBuf = ''
  private noteBuf = ''
  private events: AgentEvent[] = []
  private paths = new Set<string>()
  private readonly options: ParserOptions

  constructor(options: ParserOptions = {}) {
    this.options = options
  }

  push(chunk: string): AgentEvent[] {
    if (chunk) this.buffer += chunk
    this.events = []
    this.drain()
    return this.events
  }

  end(): AgentEvent[] {
    this.events = []
    // 未闭合的文件：以已收到的内容收尾，宁可半成品也不丢整轮
    if (this.mode === 'file' && this.currentPath) {
      this.flushFileText(this.buffer)
      this.buffer = ''
      this.warn('文件未闭合，已按已收到的内容收尾：' + this.currentPath)
      this.closeFile(true)
    } else if (this.mode === 'plan') {
      this.planBuf += this.buffer
      this.buffer = ''
      this.flushPlan()
    }
    if (this.buffer) {
      // 残余文本（可能是半截标签）
      const rest = this.buffer
      this.buffer = ''
      this.pushNote(rest)
    }
    this.flushNote()
    this.mode = 'outside'
    return this.events
  }

  private warn(message: string) {
    this.events.push({ type: 'warning', message })
  }

  private pushNote(text: string) {
    if (!text) return
    this.noteBuf += text
  }

  private flushNote() {
    const text = this.noteBuf.trim()
    this.noteBuf = ''
    if (text) this.events.push({ type: 'note', text })
  }

  private openFile(path: string) {
    if (this.paths.has(path)) {
      this.warn('重复的文件路径，后者覆盖前者：' + path)
    }
    this.paths.add(path)
    this.mode = 'file'
    this.currentPath = path
    this.currentContent = ''
    this.currentStarted = false
    this.events.push({ type: 'file_start', path })
  }

  private appendContent(piece: string) {
    if (!piece || !this.currentPath) return
    let text = piece
    if (!this.currentStarted) {
      // 吃掉标签后的第一个换行
      if (text.startsWith('\r\n')) text = text.slice(2)
      else if (text.startsWith('\n')) text = text.slice(1)
      if (!text) return
      this.currentStarted = true
    }
    this.currentContent += text
    this.events.push({ type: 'file_delta', path: this.currentPath, chunk: text })
  }

  /**
   * 收尾一个文件。
   * truncated=true 表示这个文件**没有正常闭合**（流断了 / 模型忘了写 </file>），
   * 内容是"已收到的部分"。调用方据此区分「写完了」与「只写了一半」——
   * 前者可安全保留，后者在中断时应回退到旧版本。
   */
  private closeFile(truncated = false) {
    const path = this.currentPath
    if (!path) {
      this.mode = 'outside'
      return
    }
    this.currentPath = null
    this.mode = 'outside'
    const content = trimEdgeNewline(stripFence(this.currentContent))
    this.events.push({ type: 'file_end', path, lines: countLines(content), content, truncated })
    this.currentContent = ''
    this.currentStarted = false
    this.options.onFile?.(path, content)
  }

  private flushFileText(text: string) {
    if (!text) return
    this.appendContent(text)
  }

  private flushPlan() {
    const raw = this.planBuf
    this.planBuf = ''
    this.mode = 'outside'
    const plan = parsePlan(raw)
    if (plan) this.events.push({ type: 'plan', plan })
    else this.warn('方案 JSON 无法解析，已跳过')
  }

  /** 主循环：只要还能推进就继续。 */
  private drain() {
    let guard = 0
    while (guard++ < 1000) {
      if (this.mode === 'file') {
        if (!this.stepFile()) return
      } else if (this.mode === 'plan') {
        if (!this.stepPlan()) return
      } else {
        if (!this.stepOutside()) return
      }
    }
  }

  /** 返回 false 表示需要等更多数据。 */
  private stepFile(): boolean {
    const close = CLOSE_FILE.exec(this.buffer)
    const nextOpen = OPEN_FILE.exec(this.buffer)
    const closeAt = close ? close.index : -1
    const openAt = nextOpen ? nextOpen.index : -1

    // 只有带了合法 path 的下一个 <file> 才算"忘记闭合"的恢复点
    const recoverAt = nextOpen && openAt >= 0 && parsePathAttr(nextOpen[1] ?? '') ? openAt : -1

    let cutAt = -1
    let kind: 'close' | 'recover' = 'close'
    if (closeAt >= 0 && (recoverAt < 0 || closeAt <= recoverAt)) {
      cutAt = closeAt
      kind = 'close'
    } else if (recoverAt >= 0) {
      cutAt = recoverAt
      kind = 'recover'
    }

    if (cutAt < 0) {
      // 无终止符：把"可能是标签开头"的尾巴留下
      const keep = Math.min(this.buffer.length, SAFE_TAIL)
      const head = this.buffer.slice(0, this.buffer.length - keep)
      this.buffer = this.buffer.slice(this.buffer.length - keep)
      this.flushFileText(head)
      return false
    }

    this.flushFileText(this.buffer.slice(0, cutAt))
    this.buffer = this.buffer.slice(cutAt)
    if (kind === 'close') {
      const c = CLOSE_FILE.exec(this.buffer)
      this.buffer = this.buffer.slice(c ? c[0].length : 0)
      this.closeFile()
    } else {
      const m = OPEN_FILE.exec(this.buffer)
      if (!m) return false
      const path = parsePathAttr(m[1] ?? '')
      this.buffer = this.buffer.slice(m[0].length)
      this.warn('上一个文件未闭合，已自动收尾')
      this.closeFile(true)
      if (path) this.openFile(path)
    }
    return true
  }

  private stepPlan(): boolean {
    const close = PLAN_CLOSE.exec(this.buffer)
    if (!close) {
      // 留一段尾巴：`</plan>` 可能正被切在两次 push 之间
      const keep = Math.min(this.buffer.length, 12)
      this.planBuf += this.buffer.slice(0, this.buffer.length - keep)
      this.buffer = this.buffer.slice(this.buffer.length - keep)
      return false
    }
    this.planBuf += this.buffer.slice(0, close.index)
    this.buffer = this.buffer.slice(close.index + close[0].length)
    this.flushPlan()
    return true
  }

  private stepOutside(): boolean {
    type Hit = { at: number; kind: 'plan' | 'file' | 'note' | 'note_close' | 'delete' }
    const hits: Hit[] = []
    const plan = PLAN_OPEN.exec(this.buffer)
    if (plan) hits.push({ at: plan.index, kind: 'plan' })
    const file = OPEN_FILE.exec(this.buffer)
    if (file) hits.push({ at: file.index, kind: 'file' })
    const note = NOTE_OPEN.exec(this.buffer)
    if (note) hits.push({ at: note.index, kind: 'note' })
    const del = DELETE_TAG.exec(this.buffer)
    if (del) hits.push({ at: del.index, kind: 'delete' })
    const noteClose = NOTE_CLOSE.exec(this.buffer)
    if (noteClose) hits.push({ at: noteClose.index, kind: 'note_close' })

    if (hits.length === 0) {
      // 没有完整标签：从最后一个 '<' 开始判断"是不是还没到齐的标签前缀"，
      // 只把可确定是正文的部分吐出去（否则逐字符喂入时标签会被切碎）。
      const lt = this.buffer.lastIndexOf('<')
      if (lt >= 0 && isPossibleTagPrefix(this.buffer.slice(lt))) {
        if (lt > 0) this.pushNote(this.buffer.slice(0, lt))
        this.buffer = this.buffer.slice(lt)
        this.flushNote()
        return false
      }
      this.pushNote(this.buffer)
      this.buffer = ''
      this.flushNote()
      return false
    }

    hits.sort((a, b) => a.at - b.at)
    const hit = hits[0]!
    if (hit.at > 0) {
      this.pushNote(this.buffer.slice(0, hit.at))
      this.buffer = this.buffer.slice(hit.at)
    }
    this.flushNote()

    if (hit.kind === 'plan') {
      const m = PLAN_OPEN.exec(this.buffer)!
      this.buffer = this.buffer.slice(m[0].length)
      this.planBuf = ''
      this.mode = 'plan'
      return true
    }
    if (hit.kind === 'note') {
      // note 只是一个"口播"标记，标签本身丢弃，内容是普通文本（可增量吐出）
      const m = NOTE_OPEN.exec(this.buffer)
      if (!m) return false
      this.buffer = this.buffer.slice(m[0].length)
      return true
    }
    if (hit.kind === 'note_close') {
      const m = NOTE_CLOSE.exec(this.buffer)
      if (!m) return false
      this.buffer = this.buffer.slice(m[0].length)
      return true
    }
    if (hit.kind === 'delete') {
      const m = DELETE_TAG.exec(this.buffer)!
      const path = parsePathAttr(m[1] ?? '')
      this.buffer = this.buffer.slice(m[0].length)
      if (!path) {
        this.warn('delete 标签缺少合法路径，已忽略')
        return true
      }
      this.events.push({ type: 'delete', path })
      return true
    }

    // file
    const m = OPEN_FILE.exec(this.buffer)!
    const path = parsePathAttr(m[1] ?? '')
    this.buffer = this.buffer.slice(m[0].length)
    if (!path) {
      this.warn('文件路径非法，已丢弃：' + (m[1] ?? '').slice(0, 60))
      return true
    }
    this.openFile(path)
    return true
  }
}

/** 便捷函数：一次性解析整段文本（测试与本地引擎使用）。 */
export function parseProtocol(text: string, options: ParserOptions = {}): AgentEvent[] {
  const parser = new ProtocolParser(options)
  const events = parser.push(text)
  events.push(...parser.end())
  return events
}
