import { describe, expect, it } from 'vitest'
import { batchRepairPrompt, checkRepairPrompt, fileForCheck, fileOfCheck } from '../src/lib/repair'
import { ICON_NAMES } from '../shared/preview/icons'
import type { Check, FileEntry } from '../shared/types'

const at = Date.now()
const file = (path: string, content: string): FileEntry => ({ path, content, updatedAt: at })

const icons: Check = {
  id: 'icons',
  label: '图标解析',
  ok: false,
  level: 'info',
  detail: '5 个已解析，未识别：wallet、arrow-up',
}

describe('自检项 → 修复指令', () => {
  it('UT-RPR-01 图标未识别：把内置图标名清单原样交给模型', () => {
    const prompt = checkRepairPrompt(icons)
    // 清单必须完整出现：只给几个例子的话，模型仍然会自造名字
    for (const name of ['plus', 'credit-card', 'arrow-up']) {
      expect(ICON_NAMES).toContain(name)
      expect(prompt).toContain(name)
    }
    expect(prompt).toContain('wallet')
    expect(prompt).toContain('只输出包含这些图标的文件')
  })

  it('UT-RPR-02 语法类检查点名到文件', () => {
    const check: Check = { id: 'syntax:app.js', label: 'app.js 语法', ok: false, level: 'block', detail: 'Unexpected token' }
    expect(fileOfCheck(check)).toBe('app.js')
    const prompt = checkRepairPrompt(check)
    expect(prompt).toContain('app.js')
    expect(prompt).toContain('Unexpected token')
    // 必须禁止顺手改别的文件：修复轮最怕的就是"全文重写"
    expect(prompt).toContain('只输出')
  })

  it('UT-RPR-03 「手动改」能定位到具体文件；定位不到就返回 null', () => {
    const files = [file('index.html', '<i data-icon="wallet"></i>'), file('styles.css', '')]
    expect(fileForCheck(icons, files)).toBe('index.html')
    // 两个文件都写了坏图标：不猜，交给用户在代码页里选
    expect(fileForCheck(icons, [file('a.html', 'data-icon="wallet"'), file('b.html', 'data-icon="wallet"')])).toBeNull()
    expect(fileForCheck({ id: 'refs', label: '引用完整性', ok: false, level: 'warn' }, files)).toBeNull()
  })

  it('UT-RPR-04 批量修复把每一项都带上，并只要求输出改动文件', () => {
    const prompt = batchRepairPrompt([icons, { id: 'size', label: '体积在预算内', ok: false, level: 'warn', detail: '600 KB' }])
    expect(prompt).toContain('2 项')
    expect(prompt).toContain('图标解析')
    expect(prompt).toContain('体积在预算内')
    expect(prompt).toContain('只输出发生变化的文件')
  })
})
