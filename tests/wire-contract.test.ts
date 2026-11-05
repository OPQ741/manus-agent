/**
 * 传输契约回归：微调载荷 & 分享链接。
 *
 * 这两组都是"界面看起来对了、服务端/别人那里没对"的类型：
 * 单靠 HTTP 集成测试（直接发理想载荷）发现不了，单靠 E2E（只看当场效果）也发现不了，
 * 所以把它们钉成纯函数断言 —— 前端只要改了写法就会红。
 */

import { describe, expect, it, vi } from 'vitest'
import { assemble, bridgeScript } from '../shared/preview/assemble'
import { CARRY_KEY } from '../shared/preview/pages'
import type { FileEntry } from '../shared/types'
import { isTweakEmpty } from '../shared/theme'
import { serializedCarriesTweak, tweakPayload } from '../shared/tweak'
import { accessParams, shareUrlFor } from '../src/lib/share'

const file = (path: string, content: string): FileEntry => ({ path, content, updatedAt: 0 })

/** 一份最小的双页面项目：壳、桥、内嵌文档三条链路都会跑到。 */
const TWO_PAGES: FileEntry[] = [
  file('index.html', '<!DOCTYPE html><html><head><title>首页</title></head><body><a href="pages/about.html">关于</a></body></html>'),
  file('pages/about.html', '<!DOCTYPE html><html><head><title>关于</title></head><body><a href="../index.html">回首页</a></body></html>'),
]

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

describe('UT-WIRE-12～15 多页面路由壳：壳与桥接之间的约定', () => {
  it('UT-WIRE-12 建帧快照的变量名，壳写与桥读必须完全一致', () => {
    // 回归点：壳写 __NUCLEUS_CARRY__、桥读 __NUCLEUS_CARRY，少一个下划线。
    // 现象是跨页数据静默变成 null，不报错、测试不红，只能靠肉眼发现 —— 所以钉成契约。
    const html = assemble(TWO_PAGES).html
    expect(html).toContain(`window.${CARRY_KEY}=`)
    expect(html).toContain(`typeof window.${CARRY_KEY} === 'object'`)
    expect(CARRY_KEY).toBe('__NUCLEUS_CARRY__')
    expect(bridgeScript()).toContain(`window.${CARRY_KEY}`)
  })

  it('UT-WIRE-13 页面写存储上报的 kind，壳监听的也是同一个', () => {
    // 桥里 setItem 发 { kind: 'storage', op }，壳按 kind === 'storage' 分流。
    expect(bridgeScript()).toContain("post({ kind: 'storage', op: 'set'")
    expect(assemble(TWO_PAGES).html).toContain("data.kind === 'storage'")
  })

  it('UT-WIRE-14 内嵌文档不会提前闭合壳脚本：真正的收尾标签只有一个', () => {
    // 回归点：壳脚本里只要出现一处裸 </script>，后面的代码就变成文本节点，
    // 表现是整页白屏 + 控制台一句 "Unexpected token '<'"。
    // 壳自己只有一个 script，所以"真的"收尾标签必须恰好 1 个；内嵌文档里的
    // 那几处必须被转义成 <\/script> 才不算数。
    const html = assemble(TWO_PAGES).html
    const closes = (html.match(/<\/script>/gi) ?? []).length
    expect(closes).toBe(1)
    expect(html).toContain('<\\/script>')

    const start = html.indexOf('<script data-nucleus="pages">')
    const end = html.indexOf('</script>', start)
    const code = html.slice(start + '<script data-nucleus="pages">'.length, end)
    expect(code.trimEnd().endsWith('})();')).toBe(true)
    expect(() => new Function(code)).not.toThrow()
  })

  it('UT-WIRE-15 页面内的相对链接按"本页所在目录"解析，不按站点根', () => {
    // <a href="../index.html"> 在 /about 页里必须指回 /，否则点一下就死链。
    // 文档整体是塞进 JSON 字符串的，引号在壳里是 \" —— 断言要把这一层算进去。
    const html = assemble(TWO_PAGES).html
    expect(html).toContain('window.__NUCLEUS_PAGE__=\\"pages/about.html\\"')
    expect(bridgeScript()).toContain("'https://nucleus.local/' + String(window.__NUCLEUS_PAGE__)")
  })
})

describe('UT-WIRE-16～19 沙箱加固：CSP 与弹窗代理', () => {
  it('UT-WIRE-16 CSP 注入在最前面，且掐死了 connect-src', () => {
    // 沙箱挡的是"碰到宿主"，挡不住"把数据发出去" —— 后者靠 connect-src 'none'。
    const html = assemble([file('index.html', '<html><head><title>t</title></head><body><script>x()</script></body></html>')]).html
    const cspAt = html.indexOf('Content-Security-Policy')
    expect(cspAt).toBeGreaterThan(-1)
    // meta 只对出现在它之后的内容生效，所以必须抢在所有脚本之前
    expect(cspAt).toBeLessThan(html.indexOf('<script'))
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("default-src 'none'")
    // 图片/字体/脚本不能一起关掉，否则生成物会整片失色
    expect(html).toContain('img-src data: blob: https:')
    expect(html).toContain("'unsafe-inline'")
    // 多页面里每个页面文档都要有自己的 CSP（srcdoc 逐文档生效）
    expect(assemble(TWO_PAGES).html.match(/Content-Security-Policy/g)).toHaveLength(2)
  })

  it('UT-WIRE-17 生成物自带 CSP 时不覆盖（作者意图优先）', () => {
    const html = assemble([
      file(
        'index.html',
        '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body></body></html>',
      ),
    ]).html
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1)
    expect(html).toContain("default-src 'self'")
  })

  it('UT-WIRE-18 心跳协议：宿主 ping 的字段名与桥接应答的 kind 必须对上', () => {
    // 对不上的后果是"页面明明活着，却被判定卡死"——遮罩盖住正常应用，比不判还糟。
    expect(bridgeScript()).toContain('__nucleus_ping')
    expect(bridgeScript()).toContain("post({ kind: 'pong'")
    // 单页与多页都要能应答：多页面由路由壳代答（见 pages.ts）
    expect(assemble(TWO_PAGES).html).toContain('__nucleus_ping')
  })

  it('UT-WIRE-19 沙箱没有 allow-popups，窗口打开必须走桥接上报', () => {
    expect(bridgeScript()).toContain("window.open = function")
    expect(bridgeScript()).toContain("post({ kind: 'open'")
    // 外链与 target=_blank 也一并收上来，否则"点了没反应"
    expect(bridgeScript()).toContain('_blank')
  })
})
