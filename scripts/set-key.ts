/**
 * 一键配模型 Key：写完即生效，不用手改 JSON、不用重启。
 *
 *   npm run key                                       看目录：每家能不能用、去哪申请、现在配没配
 *   npm run key -- zhipu sk-xxxxxxxx                  验证 Key → 写入 → 设为服务端主力
 *   npm run key -- deepseek sk-xxx --model deepseek-chat
 *   npm run key -- --test                             逐个测已配置的通道能不能通
 *   npm run key -- zhipu --remove                     摘掉某家的 Key
 *   npm run key -- --id mygw --url https://x/v1 --model coder --key sk-xxx   接自家网关
 *
 * 为什么写进 data/providers.local.json 而不是环境变量：
 *  - 那个文件已 gitignore，Windows 上改完不用重开终端，服务端按 mtime 热加载，
 *    下一次请求就生效；环境变量得重启进程才认。
 *  - 想走环境变量部署也没问题，这个脚本只负责本机开发这一条路。
 *
 * 写入前会真发一次最小请求（1 个 token）验证 Key 与模型名都有效 ——
 * "存进去了但一生成就 401"是这类配置最常见的坑，与其事后翻日志，不如当场拦住。
 */

import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testConnection } from '../server/agent/llm'
import { buildCatalog, type CatalogFile } from '../server/agent/providers'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const DATA_DIR = resolve(process.env.NUCLEUS_DATA_DIR ?? join(ROOT, 'data'))
const LOCAL_FILE = join(DATA_DIR, 'providers.local.json')

const C = {
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith('--')) {
    return process.argv[index + 1]!
  }
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

/** 只开关、不吃值的参数。不列出来的长参数按"后面跟一个值"处理。 */
const BOOLEAN_FLAGS = new Set(['test', 'remove', 'force', 'set-default', 'help'])

/** 位置参数：npm run key -- zhipu sk-xxx */
function positional(): string[] {
  const out: string[] = []
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!
    if (item.startsWith('--')) {
      const name = item.slice(2).split('=')[0]!
      // 带值的长参数（--model xxx）要连值一起跳过，否则值会被误当成位置参数
      if (!item.includes('=') && !BOOLEAN_FLAGS.has(name)) i += 1
      continue
    }
    out.push(item)
  }
  return out
}

async function readLocal(): Promise<CatalogFile> {
  try {
    const raw = await fs.readFile(LOCAL_FILE, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as CatalogFile
    return {}
  } catch {
    return {}
  }
}

async function writeLocal(data: CatalogFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(LOCAL_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function mask(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}****`
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

/** 本机/内网地址被 SSRF 防护拦下时，把放行方式直接写出来，别让人去翻文档。 */
function localHint(message: string): void {
  if (!message.includes('内网或本机')) return
  console.log(C.dim('  本机地址需要先放行。依次执行：'))
  console.log(C.dim('    PowerShell: $env:NUCLEUS_ALLOW_LOCAL_LLM="1"'))
  console.log(C.dim('    cmd:        set NUCLEUS_ALLOW_LOCAL_LLM=1'))
  console.log(C.dim('    bash:       NUCLEUS_ALLOW_LOCAL_LLM=1 npm run key -- ...'))
}

/** 真发一条最短请求：既验 Key，也验模型名和流式支持。 */
async function verify(config: {
  baseUrl: string
  apiKey: string
  model: string
  headers?: Record<string, string>
}): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await testConnection({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      headers: config.headers,
      temperature: 0,
    })
    return { ok: true, detail: `${result.ms}ms · 返回「${result.sample || '(空)'}」` }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function listCatalog(): Promise<void> {
  const catalog = await buildCatalog({ dataDir: DATA_DIR })
  const local = await readLocal()
  const localIds = new Set((local.providers ?? []).map((item) => item.id))

  console.log(`\n${C.bold('模型通道')}  ${C.dim(`配置文件：data/providers.local.json${localIds.size ? '' : '（还没有，第一次写入会自动创建）'}`)}\n`)

  for (const entry of catalog.entries) {
    const { profile } = entry
    const state = profile.free
      ? C.green('免 Key')
      : entry.ready
        ? C.green('已配 Key')
        : C.yellow('待配 Key')
    const star = profile.id === catalog.defaultId ? C.cyan(' ← 主力') : ''
    console.log(`  ${C.bold(profile.id.padEnd(13))} ${state.padEnd(20)} ${profile.model}${star}`)
    console.log(`  ${' '.repeat(13)} ${C.dim(profile.note ?? profile.label)}`)
    if (profile.keyUrl && !profile.free) {
      console.log(`  ${' '.repeat(13)} ${C.dim('申请：')}${C.cyan(profile.keyUrl)}`)
    }
    if (profile.keyEnv) {
      const hit = process.env[profile.keyEnv] ? C.green('已通过环境变量提供') : C.dim(`或设 ${profile.keyEnv}`)
      console.log(`  ${' '.repeat(13)} ${hit}`)
    }
    console.log()
  }

  if (catalog.warnings.length) {
    console.log(C.yellow('配置告警：'))
    for (const warning of catalog.warnings) console.log(`  ${C.yellow('•')} ${warning}`)
    console.log()
  }

  console.log(C.dim('拿到 Key 之后：'))
  console.log(`  ${C.cyan('npm run key -- <通道 id> <你的 Key>')}   例如 ${C.dim('npm run key -- zhipu 8f3a...')}\n`)
}

async function runTest(): Promise<void> {
  const catalog = await buildCatalog({ dataDir: DATA_DIR })
  console.log(`\n${C.bold('连通性测试')}\n`)
  let failed = 0
  for (const entry of catalog.entries) {
    if (!entry.ready) {
      console.log(`  ${entry.profile.id.padEnd(13)} ${C.dim('跳过（没有 Key）')}`)
      continue
    }
    const result = await verify({
      baseUrl: entry.profile.baseUrl,
      apiKey: entry.apiKey,
      model: entry.profile.model,
      headers: entry.profile.headers,
    })
    if (result.ok) {
      console.log(`  ${entry.profile.id.padEnd(13)} ${C.green('通')}  ${C.dim(result.detail)}`)
    } else {
      failed += 1
      console.log(`  ${entry.profile.id.padEnd(13)} ${C.red('不通')}  ${C.dim(result.detail)}`)
    }
  }
  console.log()
  if (failed) {
    console.log(C.yellow(`${failed} 家不通。常见原因：Key 复制时带了空格、账户没实名、免费额度用尽、模型名已下线。`))
    console.log(C.dim('模型名可能过期，用这句看该 Key 实际能调哪些：\n  npm run key -- --models <id>\n'))
    process.exitCode = 1
  }
}

async function showModels(id: string): Promise<void> {
  const catalog = await buildCatalog({ dataDir: DATA_DIR })
  const entry = catalog.entries.find((item) => item.profile.id === id)
  if (!entry) {
    console.error(C.red(`没有这个通道：${id}`))
    process.exitCode = 1
    return
  }
  const { listModels } = await import('../server/agent/llm')
  try {
    const models = await listModels({ baseUrl: entry.profile.baseUrl, apiKey: entry.apiKey, headers: entry.profile.headers })
    console.log(`\n${C.bold(entry.profile.label)} 可用模型（${models.length}）\n`)
    for (const model of models) console.log(`  ${model}`)
    console.log(`\n${C.dim('换模型：npm run key -- ')}${id}${C.dim(' <Key> --model <上面的某个>')}\n`)
  } catch (error) {
    console.error(C.red(`拉取失败：${error instanceof Error ? error.message : String(error)}`))
    process.exitCode = 1
  }
}

async function removeKey(id: string): Promise<void> {
  const local = await readLocal()
  const providers = (local.providers ?? []).filter((item) => item.id !== id)
  // 摘掉主力指向这一家的情况：否则目录里会留一个"默认指向已删除条目"的告警
  const next: CatalogFile = { ...local, providers }
  if (next.default === id) delete next.default
  await writeLocal(next)
  console.log(`\n${C.green('已摘掉')} ${id} 的 Key。${C.dim(`现在改回默认主力。`)}\n`)
}

async function setKey(id: string, apiKey: string): Promise<void> {
  const before = await buildCatalog({ dataDir: DATA_DIR })
  const entry = before.entries.find((item) => item.profile.id === id)
  if (!entry) {
    console.error(C.red(`\n没有这个通道：${id}`))
    console.error(C.dim(`可用的 id：${before.entries.map((item) => item.profile.id).join('、')}`))
    console.error(C.dim('接自家网关：npm run key -- --id mygw --url https://your-gateway/v1 --model <模型> --key <Key>\n'))
    process.exitCode = 1
    return
  }

  const model = arg('model', entry.profile.model)
  const baseUrl = arg('url', entry.profile.baseUrl)

  if (entry.profile.free && !apiKey) {
    console.log(`\n${C.green('这一家本来就不需要 Key')}（${entry.profile.label}）。直接用它：npm run key -- ${id} --set-default\n`)
    return
  }

  console.log(`\n${C.bold(`配置 ${entry.profile.label}`)}`)
  console.log(`  ${C.dim('地址')} ${baseUrl}`)
  console.log(`  ${C.dim('模型')} ${model}`)
  console.log(`  ${C.dim('Key ')} ${mask(apiKey)}\n`)

  process.stdout.write(`验证中…`)
  const result = await verify({ baseUrl, apiKey, model, headers: entry.profile.headers })
  process.stdout.write('\r' + ' '.repeat(30) + '\r')

  if (!result.ok) {
    console.log(`  ${C.red('验证失败')}  ${result.detail}`)
    localHint(result.detail)
    if (!flag('force')) {
      console.log(`\n${C.yellow('没有写入。')}${C.dim('如果确认配置没错（比如网关不支持流式、或要等下白名单），加 --force 强制保存。')}\n`)
      process.exitCode = 1
      return
    }
    console.log(`  ${C.yellow('--force：仍然写入，生成时可能失败。')}`)
  } else {
    console.log(`  ${C.green('验证通过')}  ${C.dim(result.detail)}`)
  }

  const local = await readLocal()
  const providers = [...(local.providers ?? [])]
  const index = providers.findIndex((item) => item.id === id)
  const patch = { id, apiKey, ...(model !== entry.profile.model ? { model } : {}), ...(baseUrl !== entry.profile.baseUrl ? { baseUrl } : {}) }
  if (index >= 0) providers[index] = { ...providers[index]!, ...patch }
  else providers.push(patch)
  await writeLocal({ ...local, default: id, providers })

  console.log(`\n${C.green('已写入')} data/providers.local.json，并设为服务端主力。`)
  console.log(C.dim('不用重启：服务端按文件变更热加载，下一次请求就生效。'))
  console.log(C.dim(`回滚：npm run key -- ${id} --remove\n`))
}

async function setCustom(): Promise<void> {
  const id = arg('id', 'mygw')
  const url = arg('url')
  const model = arg('model')
  const key = arg('key')
  if (!url || !model) {
    console.error(C.red('\n自定义网关需要 --url 与 --model'))
    console.error(C.dim('npm run key -- --id mygw --url https://your-gateway/v1 --model my-model --key sk-xxx\n'))
    process.exitCode = 1
    return
  }

  if (key) {
    process.stdout.write(`${C.dim('验证中…')}`)
    const result = await verify({ baseUrl: url, apiKey: key, model })
    process.stdout.write(`\r${' '.repeat(20)}\r`)
    if (result.ok) {
      console.log(`${C.green('验证通过')}  ${C.dim(result.detail)}\n`)
    } else {
      console.log(`${C.red('验证失败')}  ${result.detail}\n`)
      localHint(result.detail)
      if (!flag('force')) {
        console.log(C.yellow('没有写入。') + C.dim('确认无误后加 --force 强制保存。\n'))
        process.exitCode = 1
        return
      }
    }
  }

  const local = await readLocal()
  const providers = [...(local.providers ?? [])]
  const index = providers.findIndex((item) => item.id === id)
  const patch = { id, label: arg('label', `自定义 · ${model}`), baseUrl: url, model, apiKey: key || undefined, free: key ? undefined : true }
  if (index >= 0) providers[index] = { ...providers[index]!, ...patch }
  else providers.push(patch)
  await writeLocal({ ...local, default: id, providers })

  console.log(`\n${C.green('已写入')} 自定义通道 ${C.bold(id)} → ${url}（${model}）`)
  if (!key) console.log(C.yellow(' 注意：没给 --key，按"免 Key 通道"处理；上游若要求鉴权会 401。'))
  console.log(C.dim('本机地址默认被拦（安全策略）。开发期要指向 localhost 的 Ollama/LM Studio，启动时加 NUCLEUS_ALLOW_LOCAL_LLM=1。\n'))
}

async function main(): Promise<void> {
  const words = positional()
  const [first, second] = words

  if (flag('models')) {
    await showModels(arg('models', first ?? ''))
    return
  }
  if (flag('test')) {
    await runTest()
    return
  }
  // 自定义网关全是长参数、没有位置参数，必须排在 !first 之前判
  if (arg('url')) {
    await setCustom()
    return
  }
  if (!first) {
    await listCatalog()
    return
  }
  if (flag('remove')) {
    await removeKey(first)
    return
  }
  if (flag('set-default')) {
    const local = await readLocal()
    await writeLocal({ ...local, default: first })
    console.log(`\n${C.green('已设为服务端主力：')}${first}\n`)
    return
  }
  if (!second) {
    console.error(C.red('\n缺 Key。'))
    console.error(C.dim(`  npm run key -- ${first} sk-xxxxxxxx`))
    console.error(C.dim(`  先看这家去哪申请：npm run key\n`))
    process.exitCode = 1
    return
  }
  await setKey(first, second.trim())
}

main().catch((error) => {
  console.error(C.red(`\n出错：${error instanceof Error ? error.message : String(error)}`))
  process.exitCode = 1
})
