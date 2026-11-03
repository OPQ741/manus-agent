/**
 * 错误码 → 人话 + 动作 的映射。
 *
 * PRD §6 要求每个失败场景都能回答「发生了什么」和「我现在该点什么」，
 * 这一层是那个承诺的实现，所以它必须被测住。
 */

import { describe, expect, it } from 'vitest'
import { errorTitle, explainError } from '../src/lib/errors'

describe('errors · 错误码映射', () => {
  it('UT-ERR-01 每个已知错误码都有标题、原因和动作', () => {
    const codes = [
      'llm_auth',
      'llm_quota',
      'llm_timeout',
      'llm_network',
      'protocol_error',
      'provider_unavailable',
      'busy',
      'not_found',
      'bad_request',
      'internal',
    ]
    for (const code of codes) {
      const info = explainError(code, '')
      expect(info.title.length).toBeGreaterThan(0)
      expect(info.hint.length).toBeGreaterThan(0)
      expect(['settings', 'retry', 'home', 'none']).toContain(info.action.kind)
    }
  })

  it('UT-ERR-02 鉴权与额度问题引导去设置或重试', () => {
    expect(explainError('llm_auth', '').action.kind).toBe('settings')
    expect(explainError('provider_unavailable', '').action.kind).toBe('settings')
    expect(explainError('llm_quota', '').action.kind).toBe('retry')
  })

  it('UT-ERR-03 没有可用模型通道时明确指向设置页（不再有"退回本地"这条路）', () => {
    const info = explainError('provider_unavailable', '')
    expect(info.hint).toContain('Key')
    expect(info.action.label).toContain('设置')
    // 旧契约里的 engine_unconfigured 必须已经消失，否则说明还有本地引擎的入口
    expect(explainError('engine_unconfigured', '')).not.toBe(info)
  })

  it('UT-ERR-04 项目不存在时给出回首页的动作', () => {
    expect(explainError('not_found', '').action.kind).toBe('home')
  })

  it('UT-ERR-05 未知错误码走兜底但仍带原始信息', () => {
    const info = explainError('some_new_code', '服务端炸了')
    expect(info.title.length).toBeGreaterThan(0)
    expect(info.hint).toContain('服务端炸了')
  })

  it('UT-ERR-06 原始信息过长时截断', () => {
    const info = explainError('internal', 'x'.repeat(500))
    expect(info.hint.length).toBeLessThan(320)
  })

  it('UT-ERR-07 errorTitle 对已知码返回人话标题', () => {
    expect(errorTitle('llm_auth', '')).toBe('模型拒绝了这个请求')
    expect(errorTitle('', '原始错误')).toBe('原始错误')
    expect(errorTitle(undefined, '')).toBe('出了点问题')
  })
})
