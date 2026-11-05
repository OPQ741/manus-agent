import { describe, expect, it } from 'vitest'
import type { Message } from '../shared/types'
import { failedPromptOf } from '../src/lib/retry'

let seq = 0

function message(over: Partial<Message> & Pick<Message, 'role' | 'kind'>): Message {
  seq += 1
  return {
    id: `m${seq}`,
    projectId: 'p1',
    content: '',
    createdAt: seq,
    ...over,
  } as Message
}

describe('failedPromptOf · 「重新生成」到底重发哪句话', () => {
  it('没有错误时返回空串（此时才轮到输入框兜底）', () => {
    expect(failedPromptOf([])).toBe('')
    expect(failedPromptOf([message({ role: 'user', kind: 'text', content: '做个记账' })])).toBe('')
  })

  it('读取服务端落库的原指令，而不是错误文案本身', () => {
    const messages = [
      message({ role: 'user', kind: 'text', content: '做一个番茄钟' }),
      message({
        role: 'agent',
        kind: 'error',
        content: '模型拒绝了这个请求',
        meta: { code: 'llm_auth', tried: ['fake'], prompt: '做一个番茄钟' },
      }),
    ]
    expect(failedPromptOf(messages)).toBe('做一个番茄钟')
  })

  it('错误之后又成功产出过一轮：旧错误不再算「最近一次失败」', () => {
    const messages = [
      message({ role: 'user', kind: 'text', content: '第一版' }),
      message({ role: 'agent', kind: 'error', content: '超时', meta: { prompt: '第一版' } }),
      message({ role: 'user', kind: 'text', content: '换成深色' }),
      message({ role: 'agent', kind: 'text', content: '已更新 2 个文件' }),
    ]
    expect(failedPromptOf(messages)).toBe('')
  })

  it('中间夹着 notice（停止/放弃）不算成功，仍取最近一条错误', () => {
    const messages = [
      message({ role: 'user', kind: 'text', content: '第一版' }),
      message({ role: 'agent', kind: 'error', content: '超时', meta: { prompt: '第一版' } }),
      message({ role: 'user', kind: 'text', content: '第二版' }),
      message({ role: 'agent', kind: 'notice', content: '已放弃本轮生成' }),
      message({ role: 'agent', kind: 'error', content: '超时', meta: { prompt: '第二版' } }),
    ]
    expect(failedPromptOf(messages)).toBe('第二版')
  })

  it('老数据没有 meta.prompt：返回空串，交给输入框，而不是把错误文案当指令重发', () => {
    const messages = [message({ role: 'agent', kind: 'error', content: '所有模型通道都没能用上', meta: { code: 'internal' } })]
    expect(failedPromptOf(messages)).toBe('')
  })
})
