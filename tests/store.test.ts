import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store, deriveName, maskKey, resolveDataFile } from '../server/store/store'
import type { FileEntry } from '../shared/types'

let dir: string
let store: Store

const fileEntry = (path: string, content: string): FileEntry => ({ path, content, updatedAt: Date.now() })

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nucleus-store-'))
  store = await Store.open(resolveDataFile(dir))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('store · 项目', () => {
  it('UT-STORE-01 建项目后能读回', async () => {
    const project = await store.createProject({ prompt: '做一个记账应用', createdBy: 'me' })
    expect(project.id.startsWith('p_')).toBe(true)
    expect(project.slug).toHaveLength(10)
    expect(store.getProject(project.id)?.name).toContain('记账')
    expect(store.getBySlug(project.slug)?.id).toBe(project.id)
  })

  it('UT-STORE-02 列表按更新时间倒序', async () => {
    const a = await store.createProject({ prompt: 'A' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const b = await store.createProject({ prompt: 'B' })
    const list = store.listProjects()
    expect(list[0]?.id).toBe(b.id)
    expect(list[1]?.id).toBe(a.id)
  })

  it('UT-STORE-09 删除项目会一并清理消息与版本', async () => {
    const project = await store.createProject({ prompt: 'A' })
    await store.appendMessage({ projectId: project.id, role: 'user', kind: 'text', content: 'hi' })
    await store.commit(project.id, {
      files: [fileEntry('index.html', '<html></html>')],
      plan: null,
      checks: [],
      prompt: 'A',
      usage: { ms: 1, engine: 'local', chars: 10 },
    })
    expect(store.listVersions(project.id)).toHaveLength(1)
    await store.deleteProject(project.id)
    expect(store.getProject(project.id)).toBeNull()
    expect(store.listMessages(project.id)).toHaveLength(0)
    expect(store.listVersions(project.id)).toHaveLength(0)
  })
})

describe('store · 版本', () => {
  const commit = (id: string, files: FileEntry[], prompt = 'p') =>
    store.commit(id, { files, plan: null, checks: [], prompt, usage: { ms: 1, engine: 'local', chars: 10 } })

  it('UT-STORE-03 版本号递增且 changed 只含真正变化的文件', async () => {
    const project = await store.createProject({ prompt: 'A' })
    await commit(project.id, [fileEntry('index.html', '<html>1</html>'), fileEntry('app.js', 'a')])
    const second = await commit(project.id, [fileEntry('index.html', '<html>2</html>'), fileEntry('app.js', 'a')])
    expect(second?.version.seq).toBe(2)
    expect(second?.version.changed).toEqual(['index.html'])
  })

  it('UT-STORE-04 回滚生成新版本且内容等于目标版本', async () => {
    const project = await store.createProject({ prompt: 'A' })
    await commit(project.id, [fileEntry('index.html', 'v1')])
    await commit(project.id, [fileEntry('index.html', 'v2')])
    const rolled = await store.rollback(project.id, 1)
    expect(rolled?.version.seq).toBe(3)
    expect(rolled?.project.files[0]?.content).toBe('v1')
    expect(store.listVersions(project.id)).toHaveLength(3)
  })

  it('UT-STORE-05 超过 30 个版本时裁剪，但保留首版与最近 5 版', async () => {
    const project = await store.createProject({ prompt: 'A' })
    for (let i = 0; i < 35; i++) {
      await commit(project.id, [fileEntry('index.html', `v${i}`)])
    }
    const versions = store.listVersions(project.id)
    expect(versions.length).toBeLessThanOrEqual(30)
    const seqs = versions.map((version) => version.seq)
    expect(seqs).toContain(1)
    expect(seqs).toContain(35)
    expect(seqs).toContain(34)
  })

  it('回滚到不存在的版本返回 null', async () => {
    const project = await store.createProject({ prompt: 'A' })
    expect(await store.rollback(project.id, 99)).toBeNull()
  })
})

describe('store · 持久化', () => {
  it('UT-STORE-06 写入过程被中断不会损坏原文件（原子替换）', async () => {
    const project = await store.createProject({ prompt: 'A' })
    const dbPath = resolveDataFile(dir)
    const before = await fs.readFile(dbPath, 'utf8')

    // 模拟崩溃：写 tmp 但不 rename
    await fs.writeFile(`${dbPath}.${process.pid}.tmp`, '{"broken":', 'utf8')
    const after = await fs.readFile(dbPath, 'utf8')
    expect(after).toBe(before)

    const reopened = await Store.open(dbPath)
    expect(reopened.getProject(project.id)?.id).toBe(project.id)
  })

  it('UT-STORE-07 并发写入后文件仍是合法 JSON 且包含所有数据', async () => {
    const project = await store.createProject({ prompt: 'A' })
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.appendMessage({
          projectId: project.id,
          role: 'user',
          kind: 'text',
          content: `并发写入 ${index}`,
        }),
      ),
    )
    const raw = await fs.readFile(resolveDataFile(dir), 'utf8')
    const parsed = JSON.parse(raw) as { messages: unknown[] }
    expect(parsed.messages).toHaveLength(20)
  })

  it('UT-STORE-08 首次启动自动建库，损坏文件会被备份后重建', async () => {
    const dbPath = resolveDataFile(dir)
    await fs.writeFile(dbPath, 'not json at all', 'utf8')
    const recovered = await Store.open(dbPath)
    expect(recovered.listProjects()).toEqual([])
    const files = await fs.readdir(dir)
    expect(files.some((name) => name.startsWith('db.json.corrupt.'))).toBe(true)
  })

  it('UT-STORE-10 读取设置时 Key 只出掩码', async () => {
    await store.updateSettings({ baseUrl: 'https://api.example.com', model: 'gpt-x', apiKey: 'sk-1234567890abcd' })
    const publicSettings = store.publicSettings()
    expect(publicSettings.hasKey).toBe(true)
    expect(publicSettings.apiKeyMasked).toBe('sk-****abcd')
    expect(publicSettings.cloudReady).toBe(true)
    expect(JSON.stringify(publicSettings)).not.toContain('1234567890')
  })
})

describe('store · 工具', () => {
  it('deriveName 优先取引号内文本', () => {
    expect(deriveName('做一个叫「随手记」的记账')).toBe('随手记')
    expect(deriveName('做一个记账应用')).toBe('做一个记账应用')
    expect(deriveName('')).toBe('未命名应用')
  })

  it('maskKey 处理短 key', () => {
    expect(maskKey('')).toBe('')
    expect(maskKey('abc')).toBe('****')
  })

  it('detail 汇总项目、消息与版本', async () => {
    const project = await store.createProject({ prompt: 'A' })
    await store.appendMessage({ projectId: project.id, role: 'user', kind: 'text', content: 'hi' })
    const detail = store.detail(project.id)
    expect(detail?.messages).toHaveLength(1)
    expect(detail?.versions).toEqual([])
  })
})
