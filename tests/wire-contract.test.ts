/**
 * 传输契约回归：微调载荷 & 分享链接。
 *
 * 这两组都是"界面看起来对了、服务端/别人那里没对"的类型：
 * 单靠 HTTP 集成测试（直接发理想载荷）发现不了，单靠 E2E（只看当场效果）也发现不了，
 * 所以把它们钉成纯函数断言 —— 前端只要改了写法就会红。
 */

import { describe, expect, it, vi } from 'vitest'
import { isTweakEmpty } from '../shared/theme'
import { serializedCarriesTweak, tweakPayload } from '../shared/tweak'
import { accessParams, shareUrlFor } from '../src/lib/share'

// node 环境下没有 window：只在"取当前地址"这一条用例里临时注入，
// 其余用例都显式传参，避免依赖 DOM。
function withLocation(search: string, run: () => void) {
  const win = { location: { search } } as unknown as Window & typeof globalThis
  vi.stubGlobal('window', win)
  try {
    run()
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('UT-WIRE-01～06 微调载荷：空必须发 null，不能发 undefined', () => {
  it('UT-WIRE-01 空微调 → null（= 清除指令）', () => {
    expect(tweakPayload(undefined)).toBeNull()
    expect(tweakPayload(null)).toBeNull()
    expect(tweakPayload({})).toBeNull()
    expect(tweakPayload({ accent: '', radius: undefined })).toBeNull()
  })

  it('UT-WIRE-02 清除动作在 JSON 里仍然看得见 tweak 键', () => {
    // 回归点：JSON.stringify({ tweak: undefined }) === "{}"，服务端看不见键，
    // 于是「恢复默认」当场生效、刷新后回退。
    expect(JSON.stringify({ tweak: undefined })).toBe('{}')
    expect(serializedCarriesTweak(undefined)).toBe(true)
    expect(serializedCarriesTweak({})).toBe(true)
    expect(JSON.parse(JSON.stringify({ tweak: tweakPayload({}) }))).toEqual({ tweak: null })
  })

  it('UT-WIRE-03 radius = 0 是有效值，不能被当成"空"丢掉', () => {
    expect(tweakPayload({ radius: 0 })).toEqual({ radius: 0 })
    expect(isTweakEmpty({ radius: 0 })).toBe(false)
    expect(isTweakEmpty({ accent: '#17624b' })).toBe(false)
    expect(isTweakEmpty({ accent: '' })).toBe(true)
  })

  it('UT-WIRE-04 只保留有类型的键，脏字段被丢掉而不是整单拒绝', () => {
    expect(tweakPayload({ accent: '#e11d6b', radius: Number.NaN })).toEqual({ accent: '#e11d6b' })
    expect(tweakPayload({ accent: 42 as unknown as string, radius: 8 })).toEqual({ radius: 8 })
  })

  it('UT-WIRE-05 非空的两个字段一起走，服务端一次拿到完整外观', () => {
    expect(tweakPayload({ accent: '#17624b', radius: 6 })).toEqual({ accent: '#17624b', radius: 6 })
  })

  it('UT-WIRE-06 载荷幂等：同一份 draft 反复保存结果一致', () => {
    const draft = { accent: '#0e7490', radius: 12 }
    expect(tweakPayload(tweakPayload(draft) ?? undefined)).toEqual(tweakPayload(draft))
  })
})

describe('UT-WIRE-07～11 分享链接：托管网关的访问口令必须透传', () => {
  it('UT-WIRE-07 带 sharecode 的地址会带上口令，且 hash 紧跟 query', () => {
    expect(shareUrlFor('abc1234567', 'https://app.example.com', '?sharecode=XLMO6EYD5C')).toBe(
      'https://app.example.com/?sharecode=XLMO6EYD5C#/p/abc1234567',
    )
  })

  it('UT-WIRE-08 本地直跑（无口令）保持原来的干净链接', () => {
    expect(shareUrlFor('abc1234567', 'http://localhost:8787', '')).toBe('http://localhost:8787/#/p/abc1234567')
  })

  it('UT-WIRE-08b origin 带尾斜杠时不会拼出双斜杠', () => {
    expect(shareUrlFor('abc1234567', 'https://app.example.com/', '?sharecode=X1')).toBe(
      'https://app.example.com/?sharecode=X1#/p/abc1234567',
    )
  })

  it('UT-WIRE-09 只透传白名单参数，不把跟踪参数带进分享链接', () => {
    const params = accessParams('?sharecode=AB12&utm_source=twitter&ref=xyz')
    expect(params.toString()).toBe('sharecode=AB12')
  })

  it('UT-WIRE-10 缺口令时不伪造一个空参数', () => {
    expect(accessParams('?other=1').toString()).toBe('')
    expect(shareUrlFor('slug', 'https://app.example.com', '?other=1')).toBe('https://app.example.com/#/p/slug')
  })

  it('UT-WIRE-11 不传 search 时读当前地址（Studio 就是这么调的）', () => {
    withLocation('?sharecode=GATE42', () => {
      expect(shareUrlFor('slug1234567', 'https://app.example.com')).toBe('https://app.example.com/?sharecode=GATE42#/p/slug1234567')
      expect(accessParams().get('sharecode')).toBe('GATE42')
    })
  })
})
