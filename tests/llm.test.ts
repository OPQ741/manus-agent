/**
 * OpenAI 兼容客户端的请求头组装。
 *
 * 为什么单独测这一层：认证头错一个字符，症状是上游 401；
 * 而 401 在整条链上表现为"这家不行"——会触发故障转移、换一家重试，
 * 排查时很容易绕到"是不是 Key 过期了"上去。
 * 把头的组装单独测住，症状就地收敛。
 */

import { describe, expect, it } from 'vitest'
import { buildHeaders } from '../server/agent/llm'

describe('llm · 请求头组装', () => {
  it('UT-LLM-01 默认发标准 Bearer 头', () => {
    const headers = buildHeaders({ apiKey: 'sk-test' })
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')
  })

  it('UT-LLM-02 没给 Key 时用 anonymous（免 Key 通道）', () => {
    expect(buildHeaders({}).authorization).toBe('Bearer anonymous')
  })

  it('UT-LLM-03 声明 authHeader 时额外发一个裸 Key 头，Bearer 仍在', () => {
    // 小红书 Dots：官方文档写的是 `api-key: <key>`，但 Bearer 它也认。
    // 双发两头，就不用赌上游认哪种。
    const headers = buildHeaders({ apiKey: 'ak-test', authHeader: 'api-key' })
    expect(headers['api-key']).toBe('ak-test')
    expect(headers.authorization).toBe('Bearer ak-test')
  })

  it('UT-LLM-04 没声明 authHeader 时不会凭空多出这个头', () => {
    expect(buildHeaders({ apiKey: 'sk-test' })['api-key']).toBeUndefined()
  })

  it('UT-LLM-05 自定义头放最后，可以覆盖默认头', () => {
    // 有些网关要求改 Authorization 的前缀形式，自定义头必须能覆盖它。
    const headers = buildHeaders({
      apiKey: 'sk-test',
      headers: { authorization: 'Token sk-test', 'http-referer': 'https://example.com' },
    })
    expect(headers.authorization).toBe('Token sk-test')
    expect(headers['http-referer']).toBe('https://example.com')
  })

  it('UT-LLM-06 自定义头不能把 Key 泄进目录视图之外的字段', () => {
    // 头里的 Key 值只应出现在鉴权头上，不会被复制到别的字段
    const headers = buildHeaders({ apiKey: 'sk-secret', authHeader: 'api-key' })
    const leaked = Object.entries(headers).filter(
      ([name, value]) => name !== 'authorization' && name !== 'api-key' && value.includes('sk-secret'),
    )
    expect(leaked).toHaveLength(0)
  })
})
