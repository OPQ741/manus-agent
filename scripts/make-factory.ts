/**
 * 生成出厂示例：现场调一次真实大模型，把产物固化进 server/store/factory-example.json。
 *
 *   npm run make:factory
 *   npm run make:factory -- --prompt "做一个番茄钟，深色风格" --provider gemini
 *
 * 关键点：**它走的是产品自己的 HTTP 链路**（createNucleusServer + /generate SSE），
 * 不是另写一套调用。所以排队、故障转移、补全轮、assemble 自检、落库全部生效 ——
 * 出厂示例和访客点「生成应用」拿到的东西同源，脚本不会测出一条产品里不存在的路径。
 *
 * 产物带完整出处（prompt / 提供方 / 模型 / 耗时 / token / 时间戳），
 * 有阻断性问题或缺引用文件时拒绝写入：宁可不更新，也不把打不开的应用固化成"示例"。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, Check, Plan } from '../shared/types'
import { buildCatalog, resolveChain } from '../server/agent/providers'
import { createNucleusServer } from '../server/index'

const DEFAULT_PROMPT = '做一个记账应用，叫「小账本」，记录金额、分类和备注，能按分类看占比'
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const OUT_FILE = join(ROOT, 'server', 'store', 'factory-example.json')

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

function parseEvents(text: string): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      try {
        events.push(JSON.parse(trimmed.slice(5).trim()) as AgentEvent)
      } catch {
        /* 忽略非 JSON 帧 */
      }
    }
  }
  return events
}

async function main() {
  const prompt = arg('prompt', DEFAULT_PROMPT)
  const wanted = arg('provider')

  const catalog = await buildCatalog({ dataDir: 'data' })
  const chain = resolveChain(catalog, { provider: wanted || undefined })
  if (chain.length === 0) {
    console.error('[factory] 没有可用的模型通道：免 Key 通道被关了，也没有任何 Key。')
    process.exit(1)
  }
  console.log(`[factory] prompt: ${prompt}`)
  console.log(`[factory] 通道链: ${chain.map((item) => `${item.profile.id}(${item.profile.model})`).join(' → ')}`)

  const dataDir = await fs.mkdtemp(join(tmpdir(), 'nucleus-factory-'))
  const { server } = await createNucleusServer({ dataDir, clientDir: join(dataDir, 'nope'), catalog })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`

  try {
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const { project } = (await created.json()) as { project: { id: string } }

    console.log('[factory] 生成中（真实模型，可能需要几十秒）…')
    const response = await fetch(`${base}/api/projects/${project.id}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const events = parseEvents(await response.text())
    for (const event of events) {
      if (event.type === 'file_end') console.log(`  · ${event.path} ${event.lines} 行`)
      else if (event.type === 'notice') console.log(`  ! ${event.message}`)
      else if (event.type === 'error') console.error(`  × ${event.code}: ${event.message}`)
    }
    const failed = events.find((event) => event.type === 'error')
    if (failed && failed.type === 'error') {
      console.error('[factory] 生成失败，拒绝写入')
      process.exit(1)
    }
    const done = events.find((event) => event.type === 'done')
    if (!done || done.type !== 'done') {
      console.error('[factory] 没有收到 done，链路异常，拒绝写入')
      process.exit(1)
    }

    const detail = (await (await fetch(`${base}/api/projects/${project.id}`)).json()) as {
      project: { name: string; plan: Plan | null; checks: Check[]; files: { path: string; content: string }[] }
    }
    const { files, plan, checks } = detail.project
    for (const check of checks) console.log(`  [${check.ok ? 'ok' : check.level}] ${check.label}${check.detail ? ` — ${check.detail}` : ''}`)

    const blocked = checks.filter((check) => check.level === 'block' && !check.ok)
    const missing = checks.find((check) => check.id === 'refs')
    if (files.length === 0 || blocked.length > 0) {
      console.error('[factory] 产物有阻断性问题，拒绝写入：', blocked.map((check) => check.label).join('、'))
      process.exit(1)
    }
    if (missing && !missing.ok) {
      console.error('[factory] 补全之后仍有缺失引用，拒绝写入：', missing.detail)
      process.exit(1)
    }

    const payload = {
      schema: 1,
      prompt,
      provider: done.usage.provider
        ? {
            id: done.usage.provider,
            label: chain.find((item) => item.profile.id === done.usage.provider)?.profile.label ?? done.usage.provider,
            model: chain.find((item) => item.profile.id === done.usage.provider)?.profile.model ?? '',
            free: Boolean(chain.find((item) => item.profile.id === done.usage.provider)?.profile.free),
          }
        : { id: 'unknown', label: '未知', model: '', free: false },
      usage: { ms: done.usage.ms, chars: done.usage.chars, tokens: done.usage.tokens },
      generatedAt: Date.now(),
      plan,
      files: files.map((file) => ({ path: file.path, content: file.content })),
    }

    await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    console.log(
      `[factory] 已写入 server/store/factory-example.json：` +
        `${files.length} 个文件 / ${done.usage.chars} 字符 / ${(done.usage.ms / 1000).toFixed(1)}s` +
        (done.usage.tokens ? ` / ${done.usage.tokens} tokens` : '') +
        ` / 模型 ${payload.provider.label}`,
    )
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await fs.rm(dataDir, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error('[factory] 异常', error)
  process.exit(1)
})
