import { describe, expect, it } from 'vitest'
import { ProtocolParser, countLines, parsePlan, parseProtocol, sanitizePath, stripFence, trimEdgeNewline } from '../server/agent/protocol'
import { project, splitEvery } from './helpers'

const DOC = `先说明一下：我要一个记账小工具。

<note>开工，先出结构</note>
<plan>{"name":"随手记账","summary":"极简记账","stack":"HTML","steps":["结构","样式"],"files":[{"path":"index.html","purpose":"入口"},{"path":"app.js","purpose":"逻辑"}]}</plan>
<file path="index.html">
<!DOCTYPE html>
<html lang="zh-CN"><body><h1>记账</h1><script src="app.js"></script></body></html>
</file>
<file path="app.js">
const KEY = 'nucleus:expense';
console.log(KEY);
</file>`

describe('protocol · 基础解析', () => {
  it('UT-PROTO-01 完整文档产出预期事件序列', () => {
    const events = parseProtocol(DOC)
    const types = events.map((event) => event.type)
    expect(types).toContain('note')
    expect(types).toContain('plan')
    expect(types.filter((type) => type === 'file_end')).toHaveLength(2)

    const files = events.filter((event) => event.type === 'file_end')
    const first = files[0]
    expect(first?.type === 'file_end' && first.path).toBe('index.html')
    expect(first?.type === 'file_end' && first.content).toContain('<h1>记账</h1>')
    expect(first?.type === 'file_end' && first.content.startsWith('<')).toBe(true)
  })

  it('UT-PROTO-02 单字符喂入与整体喂入的投影一致', () => {
    const whole = project(parseProtocol(DOC))
    const parser = new ProtocolParser()
    const events = []
    for (const char of DOC) events.push(...parser.push(char))
    events.push(...parser.end())
    expect(project(events)).toEqual(whole)
  })

  it('UT-PROTO-03 随机分块不丢字不重复', () => {
    const whole = project(parseProtocol(DOC))
    for (const size of [2, 3, 7, 13, 64]) {
      const parser = new ProtocolParser()
      const events = []
      for (const chunk of splitEvery(DOC, size)) events.push(...parser.push(chunk))
      events.push(...parser.end())
      expect(project(events)).toEqual(whole)
    }
  })

  it('UT-PROTO-11 文件内容里的 `<` 原样保留', () => {
    const text = `<file path="a.js">\nif (a < b) { run() }\n</file>`
    const events = parseProtocol(text)
    const file = events.find((event) => event.type === 'file_end')
    expect(file?.type === 'file_end' && file.content).toBe('if (a < b) { run() }')
  })

  it('UT-PROTO-15 CRLF 原样保留', () => {
    const text = '<file path="a.txt">\r\nline1\r\nline2\r\n</file>'
    const events = parseProtocol(text)
    const file = events.find((event) => event.type === 'file_end')
    expect(file?.type === 'file_end' && file.content).toBe('line1\r\nline2')
  })

  it('UT-PROTO-16 空输入返回空数组', () => {
    const parser = new ProtocolParser()
    expect(parser.push('')).toEqual([])
    expect(parser.end()).toEqual([])
  })

  it('UT-PROTO-17 纯文本被当作 note', () => {
    const events = parseProtocol('你好，我想做个记账工具。')
    expect(events.filter((event) => event.type === 'note').length).toBeGreaterThan(0)
  })
})

describe('protocol · 容错', () => {
  it('UT-PROTO-04 半截标签退化为文本，不抛异常', () => {
    const parser = new ProtocolParser()
    const events = [...parser.push('<pl'), ...parser.end()]
    expect(events.some((event) => event.type === 'note')).toBe(true)
    expect(events.some((event) => event.type === 'plan')).toBe(false)
  })

  it('UT-PROTO-05 未闭合的 file 在结束时收尾', () => {
    const events = parseProtocol('<file path="a.html">\n<h1>hi</h1>')
    const file = events.find((event) => event.type === 'file_end')
    expect(file?.type === 'file_end' && file.content).toBe('<h1>hi</h1>')
    expect(events.some((event) => event.type === 'warning')).toBe(true)
  })

  it('UT-PROTO-06 剥离 markdown 代码围栏', () => {
    const events = parseProtocol('<file path="a.html">\n```html\n<p>hi</p>\n```\n</file>')
    const file = events.find((event) => event.type === 'file_end')
    expect(file?.type === 'file_end' && file.content).toBe('<p>hi</p>')
  })

  it('UT-PROTO-07 属性名兼容 name / 大小写', () => {
    const events = parseProtocol('<FILE NAME="a.html">\n<p>x</p>\n</FILE>')
    const file = events.find((event) => event.type === 'file_end')
    expect(file?.type === 'file_end' && file.path).toBe('a.html')
  })

  it('UT-PROTO-08 忘记闭合直接开新文件时自动收尾', () => {
    const events = parseProtocol('<file path="a.html">\n<p>a</p>\n<file path="b.html">\n<p>b</p>\n</file>')
    const files = events.filter((event) => event.type === 'file_end')
    expect(files).toHaveLength(2)
    expect(events.some((event) => event.type === 'warning')).toBe(true)
  })

  it('UT-PROTO-09 重复路径后者覆盖并告警', () => {
    const events = parseProtocol('<file path="a.html">\n1\n</file>\n<file path="a.html">\n2\n</file>')
    const files = events.filter((event) => event.type === 'file_end')
    expect(files).toHaveLength(2)
    expect(events.some((event) => event.type === 'warning')).toBe(true)
  })

  it('UT-PROTO-10 delete 标签被解析', () => {
    const events = parseProtocol('<delete path="old.js"/>')
    const del = events.find((event) => event.type === 'delete')
    expect(del?.type === 'delete' && del.path).toBe('old.js')
  })

  it('UT-PROTO-12 路径穿越被丢弃', () => {
    const events = parseProtocol('<file path="../etc/passwd">\nx\n</file>')
    expect(events.some((event) => event.type === 'file_end')).toBe(false)
    expect(events.some((event) => event.type === 'warning')).toBe(true)
  })

  it('UT-PROTO-13 空路径被丢弃', () => {
    const events = parseProtocol('<file path="">\nx\n</file>')
    expect(events.some((event) => event.type === 'file_end')).toBe(false)
  })

  it('UT-PROTO-14 非法 plan JSON 不抛异常', () => {
    const events = parseProtocol('<plan>{bad json}</plan><file path="a.html">\n<p>x</p>\n</file>')
    expect(events.some((event) => event.type === 'plan')).toBe(false)
    expect(events.some((event) => event.type === 'file_end')).toBe(true)
    expect(events.some((event) => event.type === 'warning')).toBe(true)
  })
})

describe('protocol · 工具函数', () => {
  it('sanitizePath 只放行安全相对路径', () => {
    expect(sanitizePath('index.html')).toBe('index.html')
    expect(sanitizePath('./styles.css')).toBe('styles.css')
    expect(sanitizePath('src/app.js')).toBe('src/app.js')
    expect(sanitizePath('../x.js')).toBeNull()
    expect(sanitizePath('/etc/passwd')).toBeNull()
    expect(sanitizePath('a b.html')).toBeNull()
    expect(sanitizePath('')).toBeNull()
    expect(sanitizePath('.hidden/x')).toBeNull()
    expect(sanitizePath('a'.repeat(200))).toBeNull()
  })

  it('stripFence 只剥外层围栏', () => {
    expect(stripFence('```js\nconst a = 1\n```')).toBe('const a = 1')
    expect(stripFence('const a = 1')).toBe('const a = 1')
    expect(stripFence('```\n```')).toBe('')
  })

  it('trimEdgeNewline 只去一层换行', () => {
    expect(trimEdgeNewline('\nabc\n')).toBe('abc')
    expect(trimEdgeNewline('\n\nabc\n\n')).toBe('\nabc\n')
    expect(trimEdgeNewline('abc')).toBe('abc')
  })

  it('countLines 处理三种换行', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\r\nb\r\nc')).toBe(3)
  })

  it('parsePlan 容忍前后缀噪声', () => {
    const plan = parsePlan('好的，方案如下：{"name":"X","steps":["a"],"files":[{"path":"index.html"}]} 以上。')
    expect(plan?.name).toBe('X')
    expect(plan?.files[0]?.path).toBe('index.html')
  })
})
