import { describe, expect, it } from 'vitest'
import type { DesignPrefs, Message, Plan, Version } from '../shared/types'
import { historyBlock, projectContext, summaryBlock } from '../server/agent/history'

const DESIGN: DesignPrefs = { accent: '#2F5D50', theme: 'light', locale: 'zh' }

const PLAN: Plan = {
  name: '小账本',
  summary: '一个记账应用',
  stack: 'HTML/CSS/JS',
  steps: [],
  files: [],
}

let seq = 0

function msg(over: Partial<Message> & Pick<Message, 'role' | 'kind' | 'content'>): Message {
  seq += 1
  return { id: `m${seq}`, projectId: 'p1', createdAt: seq, ...over } as Message
}

function version(seq: number, label: string, changed: string[]): Version {
  return { id: `v${seq}`, projectId: 'p1', seq, label, prompt: label, files: [], changed, createdAt: seq }
}

/** 造 n 轮"用户说 + 助手改"的对话 */
function rounds(n: number): Message[] {
  const out: Message[] = []
  for (let i = 1; i <= n; i++) {
    out.push(msg({ role: 'user', kind: 'text', content: `第 ${i} 轮：把第 ${i} 块改成 ${i} 号方案` }))
    out.push(
      msg({
        role: 'agent',
        kind: 'text',
        content: `已更新 1 个文件（v${i}）`,
        meta: { version: i, changed: ['styles.css'] },
      }),
    )
  }
  return out
}

describe('historyBlock · 最近几轮', () => {
  it('空历史返回空串：首轮不该塞一段空的 <history>', () => {
    expect(historyBlock([])).toBe('')
    expect(historyBlock([msg({ role: 'user', kind: 'text', content: '做个记账' })], '做个记账')).toBe('')
  })

  it('只保留最近 8 轮，且能被 1.2 KB 装下', () => {
    const block = historyBlock(rounds(20))
    expect(block).toContain('第 20 轮')
    // 第 1 轮早已滚出窗口
    expect(block).not.toContain('第 1 轮：')
    expect(new TextEncoder().encode(block).length).toBeLessThan(1200)
  })

  it('当前这句指令不算历史（否则同一句话会出现两遍）', () => {
    const messages = [...rounds(2), msg({ role: 'user', kind: 'text', content: '把主色换成墨绿' })]
    const block = historyBlock(messages, '把主色换成墨绿')
    expect(block).not.toContain('把主色换成墨绿')
    expect(block).toContain('第 2 轮')
  })

  it('助手的记录优先报"改了哪些文件"，而不是复述气泡文案', () => {
    const block = historyBlock([
      msg({ role: 'user', kind: 'text', content: '加个导出按钮' }),
      msg({
        role: 'agent',
        kind: 'text',
        content: '已更新 2 个文件（v4）',
        meta: { version: 4, changed: ['app.js', 'styles.css'] },
      }),
    ])
    expect(block).toContain('v4 改了 app.js、styles.css')
  })

  it('错误 / 停止 / 放弃这类过程消息不进历史', () => {
    const block = historyBlock([
      msg({ role: 'user', kind: 'text', content: '做个番茄钟' }),
      msg({ role: 'agent', kind: 'error', content: '模型拒绝了这个请求' }),
      msg({ role: 'agent', kind: 'notice', content: '已停止：这一轮还没有任何文件写完' }),
    ])
    expect(block).not.toContain('模型拒绝')
    expect(block).not.toContain('已停止')
    expect(block).toContain('做个番茄钟')
  })

  it('超长的一句话被截断，不占满预算', () => {
    const long = '把'.repeat(500)
    const block = historyBlock([msg({ role: 'user', kind: 'text', content: long })])
    expect(block).toContain('…')
    // 中文一个字三字节，所以按字符数断言：整行 = 100 字上限 + 前后缀
    expect(block.length).toBeLessThan(200)
  })
})

describe('summaryBlock · 纯确定性拼装', () => {
  it('列出每个版本改过哪些文件', () => {
    const block = summaryBlock(PLAN, [version(1, '初始版本', ['index.html', 'app.js']), version(2, '主色换成墨绿', ['styles.css'])], DESIGN)
    expect(block).toContain('v1 初始版本：index.html、app.js')
    expect(block).toContain('v2 主色换成墨绿：styles.css')
    expect(block).toContain('#2F5D50')
  })

  it('版本很多时只留最近 5 版', () => {
    const versions = Array.from({ length: 12 }, (_, i) => version(i + 1, `第 ${i + 1} 版`, ['app.js']))
    const block = summaryBlock(PLAN, versions, DESIGN)
    expect(block).toContain('v12')
    expect(block).not.toContain('v7 ')
  })

  it('没有方案也没有版本时不产出空壳', () => {
    expect(summaryBlock(null, [], DESIGN)).toBe('')
  })
})

describe('projectContext · 拼装与预算', () => {
  it('摘要在前、历史在后，整体不超过 2 KB', () => {
    const text = projectContext({
      messages: rounds(20),
      versions: Array.from({ length: 10 }, (_, i) => version(i + 1, `第 ${i + 1} 版`, ['app.js', 'styles.css'])),
      plan: PLAN,
      design: DESIGN,
      prompt: '把标题改短一点',
    })
    expect(text.indexOf('<summary>')).toBeLessThan(text.indexOf('<history>'))
    expect(new TextEncoder().encode(text).length).toBeLessThan(2048)
  })

  it('首轮（没有消息/版本）返回空串，让调用方整段省略', () => {
    expect(projectContext({ messages: [], versions: [], plan: null, design: DESIGN, prompt: '做个记账' })).toBe('')
  })
})
