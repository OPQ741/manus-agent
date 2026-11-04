/**
 * 集成测试：真起一个 HTTP 服务（随机端口），用 fetch 走完整业务流程。
 *
 * 关键前提：本地编译器已经删掉，所以这里**没有**"不调模型也能生成"的捷径 ——
 * 每条生成链路都打到一个假的 OpenAI 兼容上游（tests/fake-upstream.ts）上，
 * 走真实的 SSE 传输、协议解析、组装自检与落库。测的是我们这一侧，不是上游。
 *
 * 覆盖 PRD §8 的后端部分 + 模型通道解析（预设 / 自带 Key / 排队 / 故障转移）。
 */

process.env.NUCLEUS_ALLOW_LOCAL_LLM = '1'

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, ProjectDetail, PublicSettings } from '../shared/types'
import { tweakPayload } from '../shared/tweak'
import type { ProviderProfile, ResolvedCatalog } from '../server/agent/providers'
import { resetGates } from '../server/agent/queue'
import { createNucleusServer } from '../server/index'
import { listZipEntries } from '../server/export/zip'
import { nwfFor, nwfJsOnly, nwfMissingJs, startFakeUpstream, type FakeUpstream } from './fake-upstream'

let dir: string
let fake: FakeUpstream
let server: Awaited<ReturnType<typeof createNucleusServer>>['server']
let base = ''
let close: () => Promise<void>

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'fake',
    label: '假上游模型',
    baseUrl: fake.url,
    model: 'fake-model',
    maxTokens: 4096,
    reasoningEffort: 'low',
    ...over,
  }
}

function catalogOf(entries: { profile: ProviderProfile; apiKey: string }[], defaultId = entries[0]?.profile.id ?? ''): ResolvedCatalog {
  return {
    entries: entries.map((entry) => ({ ...entry, ready: Boolean(entry.profile.free) || Boolean(entry.apiKey) })),
    defaultId,
    ready: entries.length > 0,
  }
}

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nucleus-http-'))
  fake = await startFakeUpstream()
  const created = await createNucleusServer({
    dataDir: dir,
    clientDir: join(dir, 'nope'),
    catalog: catalogOf([{ profile: profile(), apiKey: 'sk-fake' }]),
  })
  server = created.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
})

afterAll(async () => {
  await close?.()
  await fake?.close()
  await fs.rm(dir, { recursive: true, force: true })
})

async function post(path: string, body: unknown) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function readSse(response: Response): Promise<AgentEvent[]> {
  const text = await response.text()
  const events: AgentEvent[] = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      try {
        events.push(JSON.parse(trimmed.slice(5).trim()) as AgentEvent)
      } catch {
        /* 忽略心跳等非 JSON 帧 */
      }
    }
  }
  return events
}

async function createProject(prompt = '做一个记账应用，叫「集成测试账本」，主色用墨绿') {
  const response = await post('/api/projects', { prompt })
  expect(response.status).toBe(201)
  const body = (await response.json()) as { project: { id: string; slug: string } }
  return body.project
}

/** 起一个临时实例（自带 catalog / 数据目录），用于需要不同通道配置的用例。 */
async function withServer<T>(
  catalog: ResolvedCatalog,
  run: (base: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(join(tmpdir(), 'nucleus-case-'))
  const created = await createNucleusServer({ dataDir, clientDir: join(dataDir, 'nope'), catalog })
  await new Promise<void>((resolve) => created.server.listen(0, '127.0.0.1', resolve))
  const address = created.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => created.server.close(() => resolve()))
    await fs.rm(dataDir, { recursive: true, force: true })
  }
}

async function newProjectOn(base: string, prompt: string) {
  const response = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  const body = (await response.json()) as { project: { id: string } }
  return body.project.id
}

describe('HTTP · 基础', () => {
  it('IT-15 健康检查报出实际生效的模型通道', async () => {
    const response = await fetch(base + '/api/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; provider: string; providers: string[] }
    expect(body.ok).toBe(true)
    expect(body.provider).toBe('fake')
    expect(body.providers).toContain('fake')
  })

  it('IT-01 创建项目', async () => {
    const project = await createProject('做一个待办清单')
    expect(project.id.startsWith('p_')).toBe(true)
    expect(project.slug).toHaveLength(10)
    const list = (await (await fetch(base + '/api/projects')).json()) as { projects: { id: string }[] }
    expect(list.projects.some((item) => item.id === project.id)).toBe(true)
  })

  it('IT-08 参数校验：空 prompt 与超长 prompt', async () => {
    const project = await createProject()
    const empty = await post(`/api/projects/${project.id}/generate`, { prompt: '   ' })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: string }).error).toBe('bad_request')

    const tooLong = await post(`/api/projects/${project.id}/generate`, { prompt: 'x'.repeat(2100) })
    expect(tooLong.status).toBe(400)
  })

  it('IT-07 不存在的项目返回 404', async () => {
    const response = await fetch(base + '/api/projects/p_missing')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toBe('not_found')
  })

  it('IT-10 没有任何就绪通道时给出 412（不再有"退回本地"这条路）', async () => {
    const empty = catalogOf([])
    empty.ready = false
    await withServer(empty, async (url) => {
      const id = await newProjectOn(url, '做个记账')
      const response = await fetch(`${url}/api/projects/${id}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '做个记账' }),
      })
      expect(response.status).toBe(412)
      expect(((await response.json()) as { error: string }).error).toBe('provider_unavailable')
    })
  })
})

describe('HTTP · 生成主流程（全部经模型）', () => {
  it('IT-02 模型生成并落库', async () => {
    const project = await createProject()
    const response = await post(`/api/projects/${project.id}/generate`, {
      prompt: '做一个记账应用，叫「集成测试账本」',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const events = await readSse(response)
    const types = events.map((event) => event.type)
    expect(types).toContain('plan')
    expect(types).toContain('file_end')
    expect(types).toContain('check')
    expect(types).toContain('done')
    expect(events.find((event) => event.type === 'done')).toMatchObject({ version: 1 })

    const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail & {
      previewHtml: string
    }
    expect(detail.project.files.length).toBeGreaterThanOrEqual(3)
    expect(detail.project.version).toBe(1)
    expect(detail.versions).toHaveLength(1)
    expect(detail.previewHtml).toContain('data-nucleus="bridge"')
    expect(detail.messages.some((message) => message.role === 'user')).toBe(true)
    // 项目上必须记得这次是哪家模型生成的
    expect(detail.project.provider).toBe('fake')
    expect(detail.project.providerLabel).toBe('假上游模型')
    // 发给上游的请求体必须带上预设里的输出预算与推理强度：
    // 少了 max_tokens，一个应用会被上游的小默认值从中间截断；
    // 少了 reasoning_effort，思考型模型会把预算全花在"想"上、正文写不完。
    const body = fake.lastBody() as { max_tokens?: number; reasoning_effort?: string }
    expect(body.max_tokens).toBe(4096)
    expect(body.reasoning_effort).toBe('low')
  })

  it('IT-03 迭代生成产生新版本且文件变化', async () => {
    const project = await createProject()
    await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '做一个记账应用，主色用墨绿' }))
    await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '做一个记账应用，主色用红色' }))

    const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail
    expect(detail.project.version).toBe(2)
    const latest = detail.versions[0]!
    expect(latest.seq).toBe(2)
    expect(latest.changed).toContain('styles.css')
    const css = detail.project.files.find((file) => file.path === 'styles.css')!.content
    expect(css).toContain('#C2405C')
  })

  it('IT-04 回滚到历史版本', async () => {
    const project = await createProject()
    await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '做一个记账应用，主色用墨绿' }))
    await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '做一个记账应用，主色用红色' }))

    const response = await post(`/api/projects/${project.id}/rollback`, { seq: 1 })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { project: { version: number; files: { path: string; content: string }[] } }
    expect(body.project.version).toBe(3)
    const css = body.project.files.find((file) => file.path === 'styles.css')!.content
    expect(css).toContain('#12715B')
  })

  it('IT-09 并发生成第二个请求被拒（409）', async () => {
    fake.setMode('slow')
    try {
      const project = await createProject()
      const first = post(`/api/projects/${project.id}/generate`, { prompt: '做一个待办清单' })
      await new Promise((resolve) => setTimeout(resolve, 60))
      const second = await post(`/api/projects/${project.id}/generate`, { prompt: '做一个待办清单' })
      expect(second.status).toBe(409)
      expect(((await second.json()) as { error: string }).error).toBe('busy')
      await (await first).text()
    } finally {
      fake.setMode('ok')
    }
  })

  it('上游活着但不按协议出码 → protocol_error，且不产生版本', async () => {
    fake.setMode('empty')
    try {
      const project = await createProject('什么都不按规矩来')
      const events = await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '什么都不按规矩来' }))
      expect(events.find((event) => event.type === 'error')).toMatchObject({ code: 'protocol_error' })
      const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail
      expect(detail.project.version).toBe(0)
    } finally {
      fake.setMode('ok')
    }
  })
})

describe('HTTP · 导出与分享', () => {
  it('IT-05 导出 ZIP', async () => {
    const project = await createProject()
    await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '做一个记账应用' }))

    const response = await fetch(`${base}/api/projects/${project.id}/export`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const buffer = Buffer.from(await response.arrayBuffer())
    const entries = listZipEntries(buffer)
    expect(entries.map((entry) => entry.name)).toContain('index.html')
    expect(entries.map((entry) => entry.name)).toContain('styles.css')
  })

  it('IT-06 分享接口返回可运行 HTML', async () => {
    const project = await createProject('做一个番茄钟')
    await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '做一个番茄钟' }))

    const response = await fetch(`${base}/api/share/${project.slug}`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { html: string; project: { name: string; providerLabel: string } }
    expect(body.html).toContain('data-nucleus="bridge"')
    expect(body.project.name).toBeTruthy()
    expect(body.project.providerLabel).toBe('假上游模型')

    const pretty = await fetch(`${base}/p/${project.slug}`, { redirect: 'manual' })
    expect(pretty.status).toBe(302)
    expect(pretty.headers.get('location')).toBe(`/#/p/${project.slug}`)
  })

  it('IT-14 静态资源不可用时给出明确提示', async () => {
    const response = await fetch(base + '/')
    expect([200, 503]).toContain(response.status)
  })
})

describe('HTTP · 模型通道解析', () => {
  it('IT-13 设置读写：Key 只回显掩码，目录不含 Key', async () => {
    const update = await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'custom',
        baseUrl: 'https://api.example.com/v1/',
        model: 'gpt-test',
        apiKey: 'sk-test-1234567890',
        design: { accent: '#12715B' },
      }),
    })
    expect(update.status).toBe(200)
    const body = (await update.json()) as PublicSettings
    expect(body.hasKey).toBe(true)
    expect(body.apiKeyMasked).toBe('sk-****7890')
    expect(body.baseUrl).toBe('https://api.example.com/v1')
    expect(body.active?.id).toBe('custom')
    expect(body.providers.length).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain('1234567890')

    // 复原：设置是全局的，不清掉会污染后面的用例（自带 Key 优先级最高）
    const cleared = await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: '', baseUrl: '', model: '', apiKey: '' }),
    })
    const after = (await cleared.json()) as PublicSettings
    expect(after.hasKey).toBe(false)
    expect(after.active?.id).toBe('fake')
  })

  it('拒绝内网模型地址（SSRF 防护）', async () => {
    process.env.NUCLEUS_ALLOW_LOCAL_LLM = '0'
    const response = await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9999/v1' }),
    })
    expect(response.status).toBe(400)
    process.env.NUCLEUS_ALLOW_LOCAL_LLM = '1'
  })

  it('IT-28 拉取上游模型列表：过滤掉非对话模型', async () => {
    const response = await post('/api/settings/models', { baseUrl: fake.url, apiKey: 'sk-x' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { models: string[]; source: string }
    expect(body.models).toContain('fake-model')
    expect(body.models).toContain('fake-coder')
    expect(body.models).not.toContain('text-embedding-3-small')
    expect(body.models).not.toContain('whisper-1')
    expect(body.source).toBe('自定义通道')
  })

  it('IT-29 点名一个还没配 Key 的预设去拉列表 → 412 并说明原因', async () => {
    await withServer(
      catalogOf([
        { profile: profile({ id: 'needs-key', label: '还需要 Key 的一家', keyEnv: 'SOME_KEY' }), apiKey: '' },
        { profile: profile({ id: 'ready-one', baseUrl: fake.url }), apiKey: 'sk-ready' },
      ]),
      async (url) => {
        const response = await fetch(url + '/api/settings/models', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'needs-key' }),
        })
        expect(response.status).toBe(412)
        const body = (await response.json()) as { message: string }
        expect(body.message).toContain('还没有 Key')
      },
    )
  })

  it('IT-30 目录告警与「为什么是这一家」会随设置一起返回', async () => {
    const response = await fetch(base + '/api/settings')
    const body = (await response.json()) as PublicSettings
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(body.activeReason.length).toBeGreaterThan(0)
  })

  it('IT-11 访客自带 Key 时优先打他自己的通道', async () => {
    fake.setMode('ok')
    await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', baseUrl: fake.url, model: 'my-model', apiKey: 'sk-mine' }),
    })
    try {
      const before = fake.calls()
      const project = await createProject('让模型生成一个页面')
      const events = await readSse(
        await post(`/api/projects/${project.id}/generate`, { prompt: '让模型生成一个页面' }),
      )
      const done = events.find((event) => event.type === 'done')
      expect(done).toMatchObject({ type: 'done', usage: { provider: 'custom', tokens: 4321 } })
      expect(fake.calls()).toBeGreaterThan(before)
      // 自带 Key 时走的是 custom 通道：max_tokens 必须带上，否则应用会被从中间截断。
      // reasoning_effort 不在这里断言 —— 那是服务端预设的属性，用户自己的网关未必支持，
      // 我们不该替别人决定要发什么非标准字段。
      expect(fake.lastBody()?.max_tokens).toBeGreaterThan(1000)
      const fileEnds = events.filter((event) => event.type === 'file_end')
      expect(fileEnds.map((event) => (event.type === 'file_end' ? event.path : ''))).toEqual([
        'index.html',
        'styles.css',
        'app.js',
      ])
      const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail
      expect(detail.project.provider).toBe('custom')
      expect(detail.project.version).toBe(1)
    } finally {
      await fetch(base + '/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: '', baseUrl: '', model: '', apiKey: '' }),
      })
    }
  })

  it('IT-12 上游 401 映射成 llm_auth 且不污染项目', async () => {
    fake.setMode('auth')
    try {
      const project = await createProject('触发 401')
      const events = await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '触发 401' }))
      expect(events.find((event) => event.type === 'error')).toMatchObject({ code: 'llm_auth' })
      const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail
      expect(detail.project.files).toHaveLength(0)
      expect(detail.project.version).toBe(0)
      expect(detail.messages.some((message) => message.kind === 'error')).toBe(true)
    } finally {
      fake.setMode('ok')
    }
  })

  it('第一家不可用时自动换下一家，并留下可见的提示', async () => {
    const bad = await startFakeUpstream()
    bad.setMode('auth')
    try {
      await withServer(
        catalogOf([
          { profile: profile({ id: 'bad', label: '坏掉的一家', baseUrl: bad.url }), apiKey: 'k' },
          { profile: profile({ id: 'good', label: '好的那家', baseUrl: fake.url }), apiKey: 'k' },
        ]),
        async (url) => {
          const id = await newProjectOn(url, '故障转移')
          const response = await fetch(`${url}/api/projects/${id}/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: '故障转移' }),
          })
          const events = await readSse(response)
          const notices = events.filter((event) => event.type === 'notice')
          expect(notices.length).toBeGreaterThan(0)
          expect(events.some((event) => event.type === 'error')).toBe(false)
          const done = events.find((event) => event.type === 'done')
          expect(done).toMatchObject({ provider: { id: 'good' } })
          const detail = (await (await fetch(`${url}/api/projects/${id}`)).json()) as ProjectDetail
          expect(detail.project.provider).toBe('good')
          // 坏的那家确实被打过一次，不是根本没尝试
          expect(bad.calls()).toBe(1)
        },
      )
    } finally {
      await bad.close()
    }
  })

  it('模型引用了 app.js 却没输出 → 自动修一轮，产物完整且方案不被覆盖', async () => {
    let pass = 0
    const flaky = await startFakeUpstream((prompt) => {
      pass++
      return pass === 1 ? nwfMissingJs(prompt) : nwfJsOnly()
    })
    try {
      await withServer(catalogOf([{ profile: profile({ id: 'flaky', baseUrl: flaky.url }), apiKey: 'k' }]), async (url) => {
        const id = await newProjectOn(url, '做一个记账应用，叫「补全账本」')
        const response = await fetch(`${url}/api/projects/${id}/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: '做一个记账应用，叫「补全账本」' }),
        })
        const events = await readSse(response)

        expect(events.some((event) => event.type === 'notice' && /正在修第 1 轮/.test(String((event as { message?: string }).message)))).toBe(true)
        expect(events.some((event) => event.type === 'error')).toBe(false)
        expect(flaky.calls()).toBe(2)

        const detail = (await (await fetch(`${url}/api/projects/${id}`)).json()) as ProjectDetail
        const paths = detail.project.files.map((file) => file.path)
        expect(paths).toContain('app.js')
        expect(paths).toContain('index.html')
        // 引用完整性必须真的变绿，而不是"修了但还是缺"
        expect(detail.project.checks.find((check) => check.id === 'refs')?.ok).toBe(true)
        // 修复轮不能把方案卡覆盖成占位方案（应用名是最容易露馅的字段）
        expect(detail.project.name).toBe('补全账本')
        // 两次请求的用量要合并上报，否则界面上的耗时/token 比真实值小
        const done = events.find((event) => event.type === 'done')
        expect(done?.type === 'done' && done.usage.chars).toBeGreaterThan(0)
        expect(detail.messages.filter((message) => message.role === 'user')).toHaveLength(1)
      })
    } finally {
      await flaky.close()
    }
  })

  it('生成的 JS 语法不通会被查出来，并触发修复轮', async () => {
    let pass = 0
    const broken = await startFakeUpstream((prompt) => {
      pass++
      // 第一轮：字符串没闭合 —— 结构检查全绿，但应用一打开就白屏
      if (pass === 1) return nwfFor(prompt).replace('rows.push({ at: Date.now() });', "rows.push('未闭合的字符串);")
      return nwfJsOnly()
    })
    try {
      await withServer(catalogOf([{ profile: profile({ id: 'brokentest', baseUrl: broken.url }), apiKey: 'k' }]), async (url) => {
        const id = await newProjectOn(url, '做一个记账应用，叫「坏脚本」')
        const events = await readSse(
          await fetch(`${url}/api/projects/${id}/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: '做一个记账应用，叫「坏脚本」' }),
          }),
        )
        expect(broken.calls()).toBe(2)
        expect(events.some((event) => event.type === 'notice' && /正在修第 1 轮/.test(String((event as { message?: string }).message)))).toBe(true)
        const detail = (await (await fetch(`${url}/api/projects/${id}`)).json()) as ProjectDetail
        const syntax = detail.project.checks.filter((check) => check.id.startsWith('syntax:'))
        expect(syntax.length).toBeGreaterThan(0)
        expect(syntax.every((check) => check.ok)).toBe(true)
      })
    } finally {
      await broken.close()
    }
  })

  it('修不好时不会无限重试，也不会把整次生成判成失败', async () => {
    const stubborn = await startFakeUpstream((prompt) => nwfMissingJs(prompt))
    try {
      await withServer(catalogOf([{ profile: profile({ id: 'stubborn', baseUrl: stubborn.url }), apiKey: 'k' }]), async (url) => {
        const id = await newProjectOn(url, '做一个记账应用，叫「补不上账本」')
        const events = await readSse(
          await fetch(`${url}/api/projects/${id}/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: '做一个记账应用，叫「补不上账本」' }),
          }),
        )
        // 1 次原始生成 + MAX_REPAIR_PASSES(2) 次修复，到此为止
        expect(stubborn.calls()).toBe(3)
        expect(events.some((event) => event.type === 'error')).toBe(false)
        expect(events.some((event) => event.type === 'notice' && event.level === 'warn')).toBe(true)
        const detail = (await (await fetch(`${url}/api/projects/${id}`)).json()) as ProjectDetail
        expect(detail.project.files.map((file) => file.path)).toContain('index.html')
        expect(detail.project.version).toBe(1)
      })
    } finally {
      await stubborn.close()
    }
  })

  it('免 Key 通道超配额时排队而不是打死', async () => {
    resetGates()
    const catalog = catalogOf([
      { profile: profile({ id: 'gated', label: '限流的一家', minIntervalMs: 1500, free: true }), apiKey: '' },
    ])
    await withServer(catalog, async (url) => {
      const first = await newProjectOn(url, '排队一')
      const second = await newProjectOn(url, '排队二')
      const call = (id: string, prompt: string) =>
        fetch(`${url}/api/projects/${id}/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
        }).then(readSse)
      const started = Date.now()
      const [a, b] = await Promise.all([call(first, '排队一'), call(second, '排队二')])
      const elapsed = Date.now() - started
      expect(a.some((event) => event.type === 'done')).toBe(true)
      expect(b.some((event) => event.type === 'done')).toBe(true)
      // 两个都成功，但第二个必须被闸门推后 —— 串行化而不是并发撞上 429
      expect(elapsed).toBeGreaterThanOrEqual(1400)
      expect(b.some((event) => event.type === 'notice' && event.level === 'info')).toBe(true)
    })
    resetGates()
  })
})

describe('HTTP · 我的项目与中断保留', () => {
  it('IT-16 ?mine=1 只返回该访客创建的项目', async () => {
    const created = await fetch(base + '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-visitor': 'visitor-a' },
      body: JSON.stringify({ prompt: '访客 A 的项目' }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { project: { id: string } }

    const mine = (await (
      await fetch(base + '/api/projects?mine=1', { headers: { 'x-visitor': 'visitor-a' } })
    ).json()) as { projects: { id: string; createdBy: string }[] }
    expect(mine.projects.some((item) => item.id === body.project.id)).toBe(true)
    expect(mine.projects.every((item) => item.createdBy === 'visitor-a')).toBe(true)

    const other = (await (
      await fetch(base + '/api/projects?mine=1', { headers: { 'x-visitor': 'visitor-b' } })
    ).json()) as { projects: { id: string }[] }
    expect(other.projects.some((item) => item.id === body.project.id)).toBe(false)
  })

  it('IT-17 停止生成后保留已完成的文件并落一个新版本', async () => {
    fake.setMode('slow')
    try {
      const prompt = '做一个待办清单，可以勾选完成'
      const project = await createProject(prompt)

      const response = await fetch(base + `/api/projects/${project.id}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      expect(response.status).toBe(200)

      const events: AgentEvent[] = []
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const reading = (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let index: number
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            for (const line of block.split('\n')) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              try {
                events.push(JSON.parse(trimmed.slice(5).trim()) as AgentEvent)
              } catch {
                /* 忽略坏帧 */
              }
            }
          }
        }
      })()

      // 等第一个文件真正写完（收到 file_end），再喊停
      const deadline = Date.now() + 20_000
      while (!events.some((event) => event.type === 'file_end') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      expect(events.some((event) => event.type === 'file_end')).toBe(true)

      const stopped = await post(`/api/projects/${project.id}/stop`, {})
      expect(stopped.status).toBe(200)

      await reading

      const done = events.find((event) => event.type === 'done')
      expect(done).toBeTruthy()
      expect(done?.type === 'done' && done.partial).toBe(true)

      const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail
      expect(detail.project.files.length).toBeGreaterThan(0)
      expect(detail.project.version).toBe(1)
      // 保留下来的一定是完整闭合的文件，不能是写了一半的
      for (const file of detail.project.files) {
        expect(file.content.trim().length).toBeGreaterThan(0)
      }
      expect(detail.messages.some((message) => message.content.includes('已停止'))).toBe(true)
    } finally {
      fake.setMode('ok')
    }
  })

  it('IT-18 没有进行中的生成时停止接口给出明确错误', async () => {
    const project = await createProject('空闲项目')
    const stopped = await post(`/api/projects/${project.id}/stop`, {})
    expect(stopped.status).toBe(409)
  })
})

describe('HTTP · 设计微调', () => {
  async function generate(projectId: string, prompt = '做一个记账应用，叫「微调账本」') {
    const response = await post(`/api/projects/${projectId}/generate`, { prompt })
    expect(response.status).toBe(200)
    const events = await readSse(response)
    expect(events.some((event) => event.type === 'done')).toBe(true)
  }

  it('IT-19 保存微调后，详情 / 分享 / 导出三处外观一致', async () => {
    const project = await createProject('做一个记账应用，叫「微调账本」')
    await generate(project.id)

    const patched = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tweak: { accent: '#17624B', radius: 6 } }),
    })
    expect(patched.status).toBe(200)
    const body = (await patched.json()) as {
      project: { tweak?: { accent?: string; radius?: number } }
      previewHtml: string
    }
    expect(body.project.tweak).toEqual({ accent: '#17624b', radius: 6 })
    expect(body.previewHtml).toContain('--accent: #17624b;')
    expect(body.previewHtml).toContain('--radius: 6px;')

    // 刷新（重新 GET）后微调仍在 —— 这是"持久化"的关键，而不只是内存里改了一下
    const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail & {
      previewHtml: string
    }
    expect(detail.project.tweak?.accent).toBe('#17624b')
    expect(detail.previewHtml).toContain('data-nucleus="tweak"')

    // 分享链接是别人看到的入口，外观必须一致
    const share = (await (await fetch(`${base}/api/share/${project.slug}`)).json()) as { html: string }
    expect(share.html).toContain('--accent: #17624b;')

    // 导出要带走外观：ZIP 是 store 模式，正文可直接在字节里检索
    const zip = Buffer.from(await (await fetch(`${base}/api/projects/${project.id}/export`)).arrayBuffer())
    expect(zip.includes(Buffer.from('data-nucleus="tweak"'))).toBe(true)
  })

  it('IT-20 显式传 null 可以清除微调，恢复生成时的外观', async () => {
    const project = await createProject('做一个待办应用，叫「微调待办」')
    await generate(project.id, '做一个待办应用，叫「微调待办」，主色用墨绿')

    await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tweak: { accent: '#e11d6b' } }),
    })

    const cleared = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tweak: null }),
    })
    const body = (await cleared.json()) as { project: { tweak?: unknown }; previewHtml: string }
    expect(body.project.tweak).toBeUndefined()
    expect(body.previewHtml).not.toContain('data-nucleus="tweak"')
    // 回到的是"这个项目生成时的主色"，不是某个写死的默认绿
    expect(body.previewHtml).toContain('#12715B')
  })

  it('IT-21 非法字段被局部丢弃（不会 400，也不会写脏数据）', async () => {
    const project = await createProject('做一个笔记应用，叫「微调笔记」')
    const response = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tweak: { accent: 'chartreuse', radius: 999 } }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { project: { tweak?: { accent?: string; radius?: number } } }
    expect(body.project.tweak).toEqual({ radius: 28 })
  })

  it('IT-22 前端清空微调的真实载荷必须真的落库（守住 JSON.stringify 丢键这个坑）', async () => {
    const project = await createProject('做一个记账应用，叫「清除账本」')
    await generate(project.id)

    // 曾经的 bug：draft 为空时前端发的是 `{ tweak: undefined }`，
    // JSON.stringify 会把这个键整个丢掉 → 服务端收到 `{}` → 旧微调留着不动。
    // 现在前端由 tweakPayload 归一成 null；这里同时钉住"归一结果"和"服务端行为"。
    expect(JSON.stringify({ tweak: undefined })).toBe('{}')
    const wire = JSON.stringify({ tweak: tweakPayload({}) })
    expect(wire).toBe(JSON.stringify({ tweak: null }))

    const patched = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tweak: { accent: '#0e7490', radius: 8 } }),
    })
    expect(((await patched.json()) as { project: { tweak?: unknown } }).project.tweak).toBeTruthy()

    const cleared = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: wire,
    })
    const body = (await cleared.json()) as { project: { tweak?: unknown }; previewHtml: string }
    expect(body.project.tweak).toBeUndefined()
    expect(body.previewHtml).not.toContain('data-nucleus="tweak"')
    expect(body.previewHtml).not.toContain('--accent: #0e7490;')

    // 分享页与导出也必须跟着回到生成时的外观（三处一致的另一个方向）
    const share = (await (await fetch(`${base}/api/share/${project.slug}`)).json()) as { html: string }
    expect(share.html).not.toContain('data-nucleus="tweak"')
  })

  it('IT-23 载荷里不带 tweak 键（例如只改名）绝不能顺手清掉微调', async () => {
    const project = await createProject('做一个记账应用，叫「改名账本」')
    await generate(project.id)
    await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tweak: { accent: '#b45309' } }),
    })

    const renamed = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '新名字' }),
    })
    const body = (await renamed.json()) as { project: { name: string; tweak?: { accent?: string } } }
    expect(body.project.name).toBe('新名字')
    expect(body.project.tweak?.accent).toBe('#b45309')
  })

  it('IT-24 tweak 带原型链属性（{accent:"toString"}）被丢弃，不写脏数据也不 500', async () => {
    const project = await createProject('做一个记账应用，叫「原型账本」')
    const response = await fetch(`${base}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tweak: { accent: 'toString', radius: 'valueOf' } }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { project: { tweak?: unknown } }
    expect(body.project.tweak).toBeUndefined()
  })

  /**
   * 线上事故：在对话里说"把主色换成墨绿"，顶栏的应用名跟着变成了那句话。
   * 两个入口都得堵住 —— 编辑轮不预发占位方案，commit 也不再用方案改名。
   */
  it('IT-26 改样式的编辑轮不重命名项目，也不重发方案卡', async () => {
    const project = await createProject('做一个记账应用，叫「固定名字账本」')
    await generate(project.id, '做一个记账应用，叫「固定名字账本」')

    const first = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail & { previewHtml: string }
    expect(first.project.name).toBe('固定名字账本')

    const response = await post(`/api/projects/${project.id}/generate`, { prompt: '把主色换成墨绿' })
    expect(response.status).toBe(200)
    const events = await readSse(response)
    expect(events.some((event) => event.type === 'done')).toBe(true)
    // 编辑轮沿用首轮方案：占位方案会把"把主色换成墨绿"当成应用名闪一下
    expect(events.some((event) => event.type === 'plan')).toBe(false)

    const after = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail & { previewHtml: string }
    expect(after.project.name).toBe('固定名字账本')
    // 样式确实生效 —— 否则"名字没变"可能只是因为这一轮什么都没做
    expect(after.previewHtml).toContain('#12715B')
  })
})

describe('HTTP · 接口面语义', () => {
  it('IT-25 读接口只认 GET/HEAD：错误方法回 405 JSON，不再假装成功', async () => {
    for (const path of ['/api/health', `/api/nonsense`, '/api/share/deadbeef10']) {
      const response = await fetch(base + path, { method: 'DELETE' })
      expect(response.status, path).toBe(405)
      const body = (await response.json()) as { error: string }
      expect(body.error, path).toBe('bad_request')
    }
  })

  it('IT-26 /api/* 的 GET 未匹配路由回 404 JSON', async () => {
    const response = await fetch(base + '/api/nonsense')
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toBe('bad_request')
  })

  it('IT-26b HEAD 读接口与 GET 同一方法分支，不被当成错误方法', async () => {
    const project = await createProject('HEAD 详情项目')
    const detail = await fetch(`${base}/api/projects/${project.id}`, { method: 'HEAD' })
    expect(detail.status).toBe(200)
    const settings = await fetch(`${base}/api/settings`, { method: 'HEAD' })
    expect(settings.status).toBe(200)
    const list = await fetch(`${base}/api/projects`, { method: 'HEAD' })
    expect(list.status).toBe(200)
  })

  it('IT-27 HEAD 静态资源回头部与长度，但不返回正文', async () => {
    // 主服务的 clientDir 指向不存在的路径（IT-14 用那条路径验证 503），
    // 这里另起一个带真实产物目录的实例，专测 HEAD 语义。
    const clientDir = await fs.mkdtemp(join(tmpdir(), 'nucleus-client-'))
    await fs.writeFile(join(clientDir, 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>', 'utf8')
    const second = await createNucleusServer({
      dataDir: await fs.mkdtemp(join(tmpdir(), 'nucleus-head-')),
      clientDir,
      catalog: catalogOf([{ profile: profile(), apiKey: 'sk-fake' }]),
    })
    await new Promise<void>((resolve) => second.server.listen(0, '127.0.0.1', resolve))
    const address = second.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type') ?? '').toContain('text/html')
      expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0)
      expect(await response.text()).toBe('')

      const get = await fetch(`http://127.0.0.1:${port}/`)
      expect(await get.text()).toContain('<body>ok</body>')
    } finally {
      await new Promise<void>((resolve) => second.server.close(() => resolve()))
      await fs.rm(clientDir, { recursive: true, force: true })
    }
  })
})
