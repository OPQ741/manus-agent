/**
 * 图标 sprite：模型写名字，我们出几何。
 *
 * 这组用例守的是"生成的界面不再到处是 emoji"这条底线：
 * 名字能对上就必须出图，对不上必须留痕（自检里报未识别），而不是静默变空白。
 */

import { describe, expect, it } from 'vitest'
import { assemble } from '../shared/preview/assemble'
import { expandIcons, hasIcon, ICON_NAMES, iconName } from '../shared/preview/icons'
import type { FileEntry } from '../shared/types'

const file = (path: string, content: string): FileEntry => ({ path, content, updatedAt: 0 })

describe('iconName · 名字归一', () => {
  it('大小写、下划线、空格都折叠成短横线', () => {
    expect(iconName('Plus')).toBe('plus')
    expect(iconName(' arrow_left ')).toBe('arrow-left')
    expect(iconName('map pin')).toBe('map-pin')
  })

  it('常见同义词指向同一个几何，不因为"叫法不同"漏图标', () => {
    expect(iconName('close')).toBe('x')
    expect(iconName('delete')).toBe('trash')
    expect(iconName('gear')).toBe('settings')
    expect(iconName('email')).toBe('mail')
    expect(iconName('bar-chart')).toBe('chart')
  })

  it('lucide- 前缀可以带，不必强制模型换写法', () => {
    expect(iconName('lucide-search')).toBe('search')
  })

  it('图标库覆盖了生成界面最常用的那一批', () => {
    for (const name of ['plus', 'search', 'trash', 'edit', 'check', 'x', 'user', 'calendar', 'settings', 'cart', 'heart', 'star']) {
      expect(hasIcon(name)).toBe(true)
    }
    expect(ICON_NAMES.length).toBeGreaterThan(40)
  })
})

describe('expandIcons · 展开', () => {
  it('UT-ICON-01 命中：空 svg 被填上内置路径，属性补全', () => {
    const out = expandIcons('<svg data-icon="plus" width="16" height="16"></svg>')
    expect(out.used).toEqual(['plus'])
    expect(out.html).toContain('viewBox="0 0 24 24"')
    expect(out.html).toContain('stroke="currentColor"')
    expect(out.html).toContain('M5 12h14M12 5v14')
    expect(out.html).toContain('width="16"')
    // 显式给了宽高就不能被 1em 覆盖
    expect(out.html).not.toContain('width="1em"')
    expect(out.unknown).toEqual([])
  })

  it('UT-ICON-02 未命中：保留原标签、记进 unknown，不阻断也不瞎画', () => {
    const out = expandIcons('<svg data-icon="trapezoid"></svg>')
    expect(out.unknown).toEqual(['trapezoid'])
    expect(out.used).toEqual([])
    expect(out.html).toBe('<svg data-icon="trapezoid"></svg>')
  })

  it('UT-ICON-03 模型自己画了 path 就尊重它，不覆盖', () => {
    const out = expandIcons('<svg data-icon="plus"><path d="M0 0h24v24H0z"/></svg>')
    expect(out.drawn).toBe(1)
    expect(out.used).toEqual([])
    expect(out.html).toContain('M0 0h24v24H0z')
    expect(out.html).not.toContain('M5 12h14M12 5v14')
  })

  it('UT-ICON-04 <i>/<span> 也能用：转成 svg 并补基线位移', () => {
    const out = expandIcons('<i class="ic" data-icon="trash"></i>')
    expect(out.used).toEqual(['trash'])
    expect(out.html.startsWith('<svg')).toBe(true)
    expect(out.html).toContain('class="ic"')
    expect(out.html).toContain('vertical-align:-0.125em')
    expect(out.html).toContain('pointer-events:none')
  })

  it('UT-ICON-05 自闭合写法同样展开', () => {
    const out = expandIcons('<svg data-icon="check" />')
    expect(out.used).toEqual(['check'])
    expect(out.html).toContain('M20 6 9 17l-5-5')
  })

  it('UT-ICON-06 二次展开不重复插路径（幂等）', () => {
    const once = expandIcons('<svg data-icon="plus"></svg>').html
    const twice = expandIcons(once)
    expect(twice.used).toEqual([])
    expect(twice.html).toBe(once)
  })

  it('UT-ICON-07 已有的 style 与 pointer-events 合并成一个属性，不写出两个 style', () => {
    const out = expandIcons('<i data-icon="bell" style="color:red"></i>')
    const styles = out.html.match(/style="/g) ?? []
    expect(styles).toHaveLength(1)
    expect(out.html).toContain('color:red')
    expect(out.html).toContain('pointer-events:none')
  })
})

describe('assemble · 图标自检', () => {
  it('UT-ICON-08 自检项如实报数：解析数与未识别名单都给出来', () => {
    const result = assemble([
      file('index.html', '<html><body><svg data-icon="plus"></svg><svg data-icon="nope"></svg></body></html>'),
    ])
    const icons = result.checks.find((check) => check.id === 'icons')
    expect(icons?.ok).toBe(false)
    expect(icons?.level).toBe('info')
    expect(icons?.detail).toContain('未识别')
    expect(icons?.detail).toContain('nope')
    // 未识别不阻断：整个组装仍然可用
    expect(result.html).toContain('data-icon="nope"')
  })

  it('UT-ICON-09 全部命中时自检为绿，并带上数量', () => {
    const result = assemble([
      file('index.html', '<html><body><svg data-icon="plus"></svg><svg data-icon="search"></svg></body></html>'),
    ])
    const icons = result.checks.find((check) => check.id === 'icons')
    expect(icons?.ok).toBe(true)
    expect(icons?.detail).toContain('2 个内置图标')
  })
})
