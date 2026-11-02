/**
 * 集成测试：真起一个 HTTP 服务（随机端口），用 fetch 走完整业务流程。
 *
 * 覆盖 PRD §8 的后端部分，并包含一条"假上游模型"链路 —— 它证明
 * 云模型分支的流式解析、错误映射与本地引擎走的是同一套代码。
 */

process.env.NUCLEUS_ALLOW_LOCAL_LLM = '1'

import { createServer as createHttpServer, type Server } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, ProjectDetail } from '../shared/types'
import { createNucleusServer } from '../server/index'
import { listZipEntries } from '../server/export/zip'

let dir: string
let server: Server
let base: string
let close: () => Promise<void>

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nucleus-http-'))
  const created = await createNucleusServer({ dataDir: dir, clientDir: join(dir, 'nope') })
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

describe('HTTP · 基础', () => {
  it('IT-15 健康检查', async () => {
    const response = await fetch(base + '/api/health')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; engine: string }
    expect(body.ok).toBe(true)
    expect(body.engine).toBe('local')
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

  it('IT-10 选云模型但未配置时给出 412', async () => {
    const project = await createProject()
    const response = await post(`/api/projects/${project.id}/generate`, { prompt: '做个记账', engine: 'cloud' })
    expect(response.status).toBe(412)
    expect(((await response.json()) as { error: string }).error).toBe('engine_unconfigured')
  })
})

describe('HTTP · 生成主流程', () => {
  it('IT-02 本地引擎生成并落库', async () => {
    const project = await createProject()
    const response = await post(`/api/projects/${project.id}/generate`, { prompt: '做一个记账应用，叫「集成测试账本」' })
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
    const project = await createProject()
    const first = post(`/api/projects/${project.id}/generate`, { prompt: '做一个待办清单' })
    // 让第一个请求先进入 running 状态
    await new Promise((resolve) => setTimeout(resolve, 40))
    const second = await post(`/api/projects/${project.id}/generate`, { prompt: '做一个待办清单' })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toBe('busy')
    await (await first).text()
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
    const body = (await response.json()) as { html: string; project: { name: string } }
    expect(body.html).toContain('data-nucleus="bridge"')
    expect(body.project.name).toBeTruthy()

    const pretty = await fetch(`${base}/p/${project.slug}`, { redirect: 'manual' })
    expect(pretty.status).toBe(302)
    expect(pretty.headers.get('location')).toBe(`/#/p/${project.slug}`)
  })

  it('IT-14 静态资源不可用时给出明确提示', async () => {
    const response = await fetch(base + '/')
    expect([200, 503]).toContain(response.status)
  })
})

describe('HTTP · 设置与云模型链路', () => {
  let fakeUpstream: Server
  let fakeUrl = ''
  let mode: 'ok' | 'unauthorized' = 'ok'

  beforeAll(async () => {
    fakeUpstream = createHttpServer((req, res) => {
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const protocol = [
        '<plan>{"name":"云端应用","summary":"来自模型","stack":"HTML","steps":["a"],"files":[{"path":"index.html","purpose":"入口"}]}</plan>\n',
        '<file path="index.html">\n<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>hello</h1><script src="app.js"></script></body></html>\n</file>\n',
        '<file path="styles.css">\nbody{color:#111}\n</file>\n',
        '<file path="app.js">\nconsole.log("from model")\n</file>\n',
      ]
      let index = 0
      const timer = setInterval(() => {
        if (index >= protocol.length) {
          res.write('data: [DONE]\n\n')
          res.end()
          clearInterval(timer)
          return
        }
        const piece = protocol[index++]!
        // 故意把一个 file 标签切成两半，验证跨帧解析
        const cut = piece.length > 40 ? Math.floor(piece.length / 2) : piece.length
        for (const slice of [piece.slice(0, cut), piece.slice(cut)]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: slice } }] })}\n\n`)
        }
      }, 10)
      req.on('close', () => clearInterval(timer))
    })
    await new Promise<void>((resolve) => fakeUpstream.listen(0, '127.0.0.1', resolve))
    const address = fakeUpstream.address()
    const port = typeof address === 'object' && address ? address.port : 0
    fakeUrl = `http://127.0.0.1:${port}/v1`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()))
  })

  it('IT-13 设置读写：Key 只回显掩码', async () => {
    const update = await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        engine: 'cloud',
        baseUrl: 'https://api.example.com/v1/',
        model: 'gpt-test',
        apiKey: 'sk-test-1234567890',
        design: { accent: '#12715B' },
      }),
    })
    expect(update.status).toBe(200)
    const body = (await update.json()) as { apiKeyMasked: string; hasKey: boolean; baseUrl: string; cloudReady: boolean }
    expect(body.hasKey).toBe(true)
    expect(body.apiKeyMasked).toBe('sk-****7890')
    expect(body.baseUrl).toBe('https://api.example.com/v1')
    expect(body.cloudReady).toBe(true)

    // 复原：设置是全局的，不还原会污染后面的用例（默认引擎被改成 cloud）
    await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'local' }),
    })
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

  it('IT-11 云模型链路（假上游，跨帧切割）', async () => {
    mode = 'ok'
    await fetch(base + '/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'cloud', baseUrl: fakeUrl, model: 'fake-model', apiKey: 'sk-fake' }),
    })
    const project = await createProject('让模型生成一个页面')
    const events = await readSse(
      await post(`/api/projects/${project.id}/generate`, { prompt: '让模型生成一个页面', engine: 'cloud' }),
    )

    expect(events.some((event) => event.type === 'plan')).toBe(true)
    const fileEnds = events.filter((event) => event.type === 'file_end')
    expect(fileEnds.map((event) => (event.type === 'file_end' ? event.path : ''))).toEqual([
      'index.html',
      'styles.css',
      'app.js',
    ])

    const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail
    expect(detail.project.files.some((file) => file.content.includes('from model'))).toBe(true)
    expect(detail.project.version).toBe(1)
  })

  it('IT-12 上游 401 被映射成 llm_auth 且不污染项目', async () => {
    mode = 'unauthorized'
    const project = await createProject('触发 401')
    const events = await readSse(await post(`/api/projects/${project.id}/generate`, { prompt: '触发 401', engine: 'cloud' }))
    const error = events.find((event) => event.type === 'error')
    expect(error).toMatchObject({ type: 'error', code: 'llm_auth' })

    const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as ProjectDetail
    expect(detail.project.files).toHaveLength(0)
    expect(detail.project.version).toBe(0)
    expect(detail.messages.some((message) => message.kind === 'error')).toBe(true)
    mode = 'ok'
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
    const prompt = '做一个待办清单，可以勾选完成'
    const project = await createProject(prompt)

    const response = await fetch(base + `/api/projects/${project.id}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, engine: 'local' }),
    })
    expect(response.status).toBe(200)

    const events: AgentEvent[] = []
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const reading = (async () => {
      while (true) {
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
    const deadline = Date.now() + 15_000
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
  })

  it('IT-18 没有进行中的生成时停止接口给出明确错误', async () => {
    const project = await createProject('空闲项目')
    const stopped = await post(`/api/projects/${project.id}/stop`, {})
    expect(stopped.status).toBe(409)
  })
})

describe('HTTP · 设计微调', () => {
  async function generate(projectId: string) {
    const response = await post(`/api/projects/${projectId}/generate`, {
      prompt: '做一个记账应用，叫「微调账本」',
      engine: 'local',
    })
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
    await generate(project.id)

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
})
