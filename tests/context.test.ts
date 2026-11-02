/**
 * 迭代上下文选择（server/agent/prompts.ts）。
 *
 * 这是"改一个需求会不会把别的文件改坏"的关键：旧策略按路径顺序累加，
 * 超预算后整份文件消失，模型会以为它不存在 —— 于是把它整个重建。
 */

import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../shared/types'
import {
  MAX_CONTEXT_CHARS,
  relevance,
  renderFiles,
  selectContext,
  tokenize,
} from '../server/agent/prompts'

function file(path: string, size: number, marker = 'x'): FileEntry {
  return { path, content: marker.repeat(size), updatedAt: 0 }
}

describe('context · 分词与相关度', () => {
  it('UT-CTX-01 英文按词、中文按二元组', () => {
    const tokens = tokenize('主色换成墨绿 addTodo')
    expect(tokens).toContain('addtodo')
    expect(tokens).toContain('主色')
    expect(tokens).toContain('墨绿')
  })

  it('UT-CTX-02 样式类需求偏向 css 文件', () => {
    const instruction = '把主色换成墨绿'
    const css = relevance(file('styles.css', 100), instruction)
    const js = relevance(file('app.js', 100), instruction)
    expect(css).toBeGreaterThan(js)
  })

  it('UT-CTX-03 逻辑类需求偏向 js 文件', () => {
    const instruction = '加一个筛选按钮和保存功能'
    const js = relevance(file('app.js', 100), instruction)
    const css = relevance(file('styles.css', 100), instruction)
    expect(js).toBeGreaterThan(css)
  })

  it('UT-CTX-04 入口文件永远有基础分', () => {
    const instruction = '完全无关的一句话'
    expect(relevance(file('index.html', 100), instruction)).toBeGreaterThan(0)
  })
})

describe('context · 预算内的文件选择', () => {
  it('UT-CTX-05 预算充足时全部文件完整给出', () => {
    const files = [file('index.html', 100), file('styles.css', 200), file('app.js', 300)]
    const selected = selectContext(files, '随便改改')
    expect(selected).toHaveLength(3)
    expect(selected.every((item) => !item.truncated)).toBe(true)
  })

  it('UT-CTX-06 超预算时截断而不是丢弃', () => {
    const files = [file('index.html', 5000, 'a'), file('styles.css', 5000, 'b')]
    const selected = selectContext(files, '改配色', 6000)
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.some((item) => item.truncated)).toBe(true)
    const truncated = selected.find((item) => item.truncated)!
    expect(truncated.content.length).toBeLessThan(5000)
  })

  it('UT-CTX-07 预算只够一个文件时，优先给相关的那个', () => {
    const files = [file('index.html', 9000, 'a'), file('styles.css', 9000, 'b')]
    const selected = selectContext(files, '把主色换成墨绿', 5000)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.path).toBe('styles.css')
  })

  it('UT-CTX-08 选出来的内容总量不超过预算', () => {
    const files = [file('index.html', 9000, 'a'), file('styles.css', 9000, 'b'), file('app.js', 9000, 'c')]
    const budget = 5000
    const selected = selectContext(files, '改配色', budget)
    const total = selected.reduce((sum, item) => sum + item.content.length, 0)
    expect(total).toBeLessThanOrEqual(budget)
  })

  it('UT-CTX-09 输出保持项目原始顺序', () => {
    const files = [file('app.js', 100), file('index.html', 100), file('styles.css', 100)]
    const selected = selectContext(files, '随便改改')
    expect(selected.map((item) => item.path)).toEqual(['app.js', 'index.html', 'styles.css'])
  })
})

describe('context · 渲染给模型看的上下文', () => {
  it('UT-CTX-10 manifest 列出全部文件（含未提供的）', () => {
    const files = [file('index.html', 100, 'a'), file('styles.css', 100, 'b'), file('app.js', 100, 'c')]
    const text = renderFiles(files, '改配色')
    expect(text).toContain('<manifest>')
    expect(text).toContain('index.html')
    expect(text).toContain('styles.css')
    expect(text).toContain('app.js')
    expect(text).toContain('</manifest>')
  })

  it('UT-CTX-11 每个被选中的文件都包在 file 标签里', () => {
    const files = [file('index.html', 100, 'a'), file('styles.css', 100, 'b')]
    const text = renderFiles(files, '改配色')
    expect(text).toContain('<file path="index.html">')
    expect(text).toContain('<file path="styles.css">')
  })

  it('UT-CTX-12 预算紧张时 manifest 明确标注"未提供内容"', () => {
    const files = [file('index.html', 9000, 'a'), file('styles.css', 9000, 'b'), file('app.js', 9000, 'c')]
    const text = renderFiles(files, '改配色', 4000)
    expect(text).toContain('未提供内容')
  })

  it('UT-CTX-13 空项目给出明确提示而不是空字符串', () => {
    expect(renderFiles([], '随便')).toContain('还没有文件')
  })

  it('UT-CTX-14 默认预算常量保持可用', () => {
    expect(MAX_CONTEXT_CHARS).toBeGreaterThan(1000)
  })
})
