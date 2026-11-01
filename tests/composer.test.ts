import { describe, expect, it } from 'vitest'
import { classify, compose, composeFiles, extractSlots, planFor } from '../server/agent/composer'
import { assemble } from '../server/preview/assemble'
import { DESIGN } from './helpers'

describe('composer · 意图分类', () => {
  const cases: [string, string][] = [
    ['做一个记账应用，记录每天的花销', 'expense'],
    ['帮我做个待办清单，可以打卡', 'todo'],
    ['做个番茄钟，25 分钟专注', 'pomodoro'],
    ['做一个项目看板，三列拖拽', 'kanban'],
    ['来个计算器', 'calculator'],
    ['给我的产品做一个落地页', 'landing'],
    ['做一个灵感便签，随手记', 'notes'],
  ]

  it.each(cases)('UT-COMP-01/02 「%s」→ %s', (prompt, expected) => {
    expect(classify(prompt).archetype).toBe(expected)
  })

  it('UT-COMP-03 空 prompt 不抛异常且落到默认原型', () => {
    expect(() => classify('')).not.toThrow()
    expect(['landing', 'notes']).toContain(classify('').archetype)
  })

  it('UT-COMP-04 同分时结果稳定可重复', () => {
    const prompt = '随便做个东西'
    const first = classify(prompt)
    for (let i = 0; i < 5; i++) expect(classify(prompt)).toEqual(first)
  })
})

describe('composer · 槽位抽取', () => {
  it('UT-COMP-05 抽取应用名', () => {
    const slots = extractSlots('做一个记账应用，叫「随手记」', DESIGN)
    expect(slots.name).toBe('随手记')
  })

  it('UT-COMP-06 主色词映射到设计令牌', () => {
    expect(extractSlots('记账应用，主色用墨绿', DESIGN).tokens.accent).toBe('#12715B')
    expect(extractSlots('记账应用，主色改成红色', DESIGN).tokens.accent).toBe('#C2405C')
  })

  it('UT-COMP-07 深色风格', () => {
    expect(extractSlots('做个番茄钟，暗黑风格', DESIGN).tokens.theme).toBe('dark')
  })

  it('UT-COMP-08 货币识别', () => {
    expect(extractSlots('记账，用美元', DESIGN).currency).toBe('$')
    expect(extractSlots('记账', DESIGN).currency).toBe('¥')
  })

  it('未指定主色时沿用全局设计偏好', () => {
    expect(extractSlots('做个待办', { ...DESIGN, accent: '#2563C9' }).tokens.accent).toBe('#2563C9')
  })
})

describe('composer · 编译产物', () => {
  const prompt = '做一个记账应用，叫「随手记账」，主色用墨绿，记录金额、分类和备注'

  it('UT-COMP-09 同一 prompt 两次编译字节一致', () => {
    expect(compose(prompt, DESIGN).text).toBe(compose(prompt, DESIGN).text)
  })

  it('UT-COMP-10 改主色词会真的改变产物（防假编译器）', () => {
    const green = compose('记账应用，主色用墨绿', DESIGN).text
    const red = compose('记账应用，主色用红色', DESIGN).text
    expect(green).toContain('#12715B')
    expect(red).not.toContain('#12715B')
    expect(red).toContain('#C2405C')
  })

  it('UT-COMP-11 输出可被协议解析，且含 index.html', () => {
    const files = composeFiles(prompt, DESIGN)
    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(files.map((file) => file.path)).toContain('index.html')
  })

  it('UT-COMP-12 产物自洽：HTML 引用的本地文件都存在', () => {
    const files = composeFiles(prompt, DESIGN)
    const html = files.find((file) => file.path === 'index.html')!.content
    for (const match of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      expect(files.map((file) => file.path)).toContain(match[1])
    }
  })

  it('UT-COMP-13 产物包含真实持久化逻辑', () => {
    const files = composeFiles(prompt, DESIGN)
    const js = files.find((file) => file.path === 'app.js')!.content
    expect(js).toContain('localStorage.setItem')
    expect(js).toContain('localStorage.getItem')
  })

  it('UT-COMP-14 全部原型的产物都能通过组装器检查', () => {
    const prompts = [
      '记账应用',
      '待办清单',
      '便签笔记',
      '番茄钟',
      '项目看板',
      '计算器',
      '产品落地页',
    ]
    for (const item of prompts) {
      const files = composeFiles(item, DESIGN)
      const result = assemble(files)
      const blocking = result.checks.filter((check) => check.level === 'block' && !check.ok)
      const refs = result.checks.find((check) => check.id === 'refs')
      expect(blocking, `${item} 存在阻断问题`).toEqual([])
      expect(refs?.ok, `${item} 引用不完整：${refs?.detail}`).toBe(true)
      expect(result.html.length).toBeGreaterThan(600)
    }
  })

  it('迭代模式只回写变化的文件', () => {
    const first = composeFiles('记账应用，主色用墨绿', DESIGN)
    const { text } = compose('记账应用，主色用红色', DESIGN, first)
    const changed = (text.match(/<file path="/g) ?? []).length
    expect(changed).toBeLessThanOrEqual(3)
    expect(text).toContain('#C2405C')
  })

  it('没有任何变化时不输出文件', () => {
    const first: Parameters<typeof compose>[2] = composeFiles('记账应用，主色用墨绿', DESIGN).map((file) => ({
      ...file,
      updatedAt: Date.now(),
    }))
    const { text } = compose('记账应用，主色用墨绿', DESIGN, first)
    expect(text).not.toContain('<file path=')
    expect(text).toContain('没有检测到需要变更的文件')
  })

  it('planFor 描述与实际产物一致', () => {
    const slots = extractSlots(prompt, DESIGN)
    const plan = planFor(slots)
    expect(plan.files.map((file) => file.path)).toContain('index.html')
    expect(plan.steps.length).toBeGreaterThan(2)
  })
})
