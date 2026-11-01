import { describe, expect, it } from 'vitest'
import { crc32, createZip, listZipEntries, safeEntryName } from '../server/export/zip'

describe('zip · 打包', () => {
  it('UT-ZIP-01 单文件产出合法 ZIP 头', () => {
    const buf = createZip([{ name: 'index.html', content: '<h1>hi</h1>' }])
    expect(buf.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004')
    expect(buf.length).toBeGreaterThan(30)
  })

  it('UT-ZIP-02 多文件中央目录条数正确', () => {
    const buf = createZip([
      { name: 'index.html', content: '<h1>hi</h1>' },
      { name: 'styles.css', content: 'h1{color:red}' },
      { name: 'app.js', content: 'console.log(1)' },
    ])
    const entries = listZipEntries(buf)
    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.name)).toEqual(['index.html', 'styles.css', 'app.js'])
    expect(entries.every((entry) => entry.method === 0)).toBe(true)
  })

  it('UT-ZIP-03 CRC32 与已知向量一致', () => {
    expect(crc32('hello')).toBe(0x3610a686)
    expect(crc32('')).toBe(0)
    expect(crc32('123456789')).toBe(0xcbf43926)
  })

  it('UT-ZIP-04 空列表也是合法 ZIP', () => {
    const buf = createZip([])
    expect(listZipEntries(buf)).toHaveLength(0)
  })

  it('UT-ZIP-05 中文文件名（UTF-8 标志位）长度正确', () => {
    const buf = createZip([{ name: '说明文档.md', content: '内容' }])
    const entries = listZipEntries(buf)
    expect(entries[0]?.name).toBe('说明文档.md')
    expect(entries[0]?.size).toBe(Buffer.byteLength('内容'))
  })

  it('UT-ZIP-06 路径穿越条目被拒绝', () => {
    expect(() => createZip([{ name: '../evil.sh', content: 'x' }])).toThrow()
    expect(() => safeEntryName('/abs/path')).not.toThrow()
    expect(safeEntryName('/abs/path')).toBe('abs/path')
  })

  it('条目 CRC 与内容匹配', () => {
    const content = 'const a = 1;\n'
    const entries = listZipEntries(createZip([{ name: 'app.js', content }]))
    expect(entries[0]?.crc).toBe(crc32(content))
  })
})
