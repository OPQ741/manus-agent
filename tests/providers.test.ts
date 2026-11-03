/**
 * 模型通道目录与配额闸门。
 *
 * 这一层决定"这次生成打给谁"，也决定"零配置时到底能不能真的生成" ——
 * 它是"去掉本地 mock"之后，替代那条捷径的新前提，所以必须被测住：
 *  - 免 Key 通道必须在（否则"打开就能用"是假的）；
 *  - Key 的优先级与来源（env > 文件）必须确定；
 *  - 配置文件只能改字段，不能凭空造出一个"假装免 Key"的条目；
 *  - 排队闸门必须真的串行，且排不上队时不能把后面的人也推后。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QueueFullError, projectedWait, resetGates, waitForSlot } from '../server/agent/queue'
import { BUILTIN_PROVIDERS, buildCatalog, catalogView, isReady, resolveChain } from '../server/agent/providers'
import { canFailover, createSink, placeholderPlan } from '../server/agent/runner'

let dir: string
let configFile: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'nucleus-providers-'))
  configFile = join(dir, 'providers.json')
  resetGates()
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function writeConfig(data: unknown) {
  await fs.writeFile(configFile, JSON.stringify(data), 'utf8')
}

describe('providers · 零配置也能真生成', () => {
  it('UT-PRV-01 默认目录里至少有一条免 Key 通道，解析链非空', async () => {
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    const free = catalog.entries.filter((entry) => entry.profile.free)
    expect(free.length).toBeGreaterThan(0)
    expect(free.every((entry) => entry.ready)).toBe(true)
    const chain = resolveChain(catalog)
    expect(chain.length).toBeGreaterThan(0)
    expect(chain.some((item) => item.profile.free)).toBe(true)
  })

  it('UT-PRV-02 内置预设都必须是合法的公网 https 地址（SSRF 边界）', () => {
    for (const preset of BUILTIN_PROVIDERS) {
      expect(preset.baseUrl).toMatch(/^https:\/\//)
      expect(preset.model.length).toBeGreaterThan(0)
      if (!preset.free) expect(preset.keyEnv).toBeTruthy()
    }
  })

  it('UT-PRV-03 需要 Key 的预设在没 Key 时不算就绪，也不会进链', async () => {
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    const deepseek = catalog.entries.find((entry) => entry.profile.id === 'deepseek')!
    expect(deepseek.ready).toBe(false)
    expect(resolveChain(catalog).some((item) => item.profile.id === 'deepseek')).toBe(false)
  })

  it('UT-PRV-04 给了环境变量 Key 就就绪，并成为可点名的主力', async () => {
    const catalog = await buildCatalog({
      dataDir: dir,
      configFile,
      env: { DEEPSEEK_API_KEY: 'sk-deep', NUCLEUS_PROVIDER: 'deepseek' },
    })
    const deepseek = catalog.entries.find((entry) => entry.profile.id === 'deepseek')!
    expect(deepseek.ready).toBe(true)
    expect(deepseek.apiKey).toBe('sk-deep')
    expect(catalog.defaultId).toBe('deepseek')
    const chain = resolveChain(catalog)
    expect(chain[0]?.profile.id).toBe('deepseek')
    // 免 Key 通道仍然留在链尾兜底
    expect(chain[chain.length - 1]?.profile.free).toBe(true)
  })

  it('UT-PRV-05 点名的预设不存在时退回默认，不会整条链空掉', async () => {
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: { NUCLEUS_PROVIDER: 'nope' } })
    expect(catalog.defaultId).not.toBe('nope')
    expect(resolveChain(catalog).length).toBeGreaterThan(0)
  })
})

describe('providers · 配置来源与优先级', () => {
  it('UT-PRV-06 配置文件按 id 合并：改模型名不会抹掉 label 与配额说明', async () => {
    await writeConfig({ providers: [{ id: 'moonshot', model: 'kimi-k2-turbo' }] })
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: { MOONSHOT_API_KEY: 'sk-m' } })
    const moonshot = catalog.entries.find((entry) => entry.profile.id === 'moonshot')!
    expect(moonshot.profile.model).toBe('kimi-k2-turbo')
    expect(moonshot.profile.label).toBe('Kimi K2')
    expect(moonshot.profile.note).toContain('国内直连')
  })

  it('UT-PRV-06b 配置文件可以调推理强度（思考型模型不压强度就写不完正文）', async () => {
    await writeConfig({ providers: [{ id: 'pollinations', reasoningEffort: 'high', maxTokens: 20000 }] })
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    const free = catalog.entries.find((entry) => entry.profile.free)!
    expect(free.profile.reasoningEffort).toBe('high')
    expect(free.profile.maxTokens).toBe(20000)
    // 免 Key 属性不能被配置文件"改没了"还能用：它决定零配置是否成立
    expect(free.profile.free).toBe(true)
  })

  it('UT-PRV-07 enabled:false 可以把一家彻底摘掉', async () => {
    await writeConfig({ providers: [{ id: 'pollinations', enabled: false }] })
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    expect(catalog.entries.some((entry) => entry.profile.id === 'pollinations')).toBe(false)
    // 摘掉免 Key 通道且没给任何 Key → 链空，接口该回 412 而不是偷偷退回模板
    expect(resolveChain(catalog)).toHaveLength(0)
  })

  it('UT-PRV-08 配置文件里的 apiKey 生效，但 env 的 Key 优先', async () => {
    await writeConfig({ providers: [{ id: 'deepseek', apiKey: 'sk-from-file' }] })
    const fromFile = await buildCatalog({ dataDir: dir, configFile, env: {} })
    expect(fromFile.entries.find((e) => e.profile.id === 'deepseek')?.apiKey).toBe('sk-from-file')

    const fromEnv = await buildCatalog({ dataDir: dir, configFile, env: { DEEPSEEK_API_KEY: 'sk-from-env' } })
    expect(fromEnv.entries.find((e) => e.profile.id === 'deepseek')?.apiKey).toBe('sk-from-env')
  })

  it('UT-PRV-09 本地文件（data/providers.local.json）能补 Key，且优先于仓库文件', async () => {
    await writeConfig({ providers: [{ id: 'zhipu', apiKey: 'sk-repo' }] })
    await fs.writeFile(
      join(dir, 'providers.local.json'),
      JSON.stringify({ providers: [{ id: 'zhipu', apiKey: 'sk-local' }] }),
      'utf8',
    )
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    expect(catalog.entries.find((e) => e.profile.id === 'zhipu')?.apiKey).toBe('sk-local')
  })

  it('UT-PRV-10 通用环境变量合成内联预设并抢下主力；地址非法则整条忽略', async () => {
    const good = await buildCatalog({
      dataDir: dir,
      configFile,
      env: {
        NUCLEUS_LLM_BASE_URL: 'https://llm.internal.example/v1',
        NUCLEUS_LLM_MODEL: 'my-coder',
        NUCLEUS_LLM_API_KEY: 'sk-inline',
      },
    })
    expect(good.defaultId).toBe('env')
    expect(resolveChain(good)[0]?.profile.model).toBe('my-coder')

    const bad = await buildCatalog({
      dataDir: dir,
      configFile,
      env: { NUCLEUS_LLM_BASE_URL: 'not-a-url', NUCLEUS_LLM_MODEL: 'x', NUCLEUS_LLM_API_KEY: 'k' },
    })
    expect(bad.entries.some((entry) => entry.profile.id === 'env')).toBe(false)
  })

  it('UT-PRV-11 配置文件坏成非法 JSON 也不能让服务起不来', async () => {
    await fs.writeFile(configFile, '{ this is not json', 'utf8')
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    expect(catalog.entries.length).toBe(BUILTIN_PROVIDERS.length)
  })

  it('UT-PRV-12 目录视图永不泄露 Key', async () => {
    await writeConfig({ providers: [{ id: 'deepseek', apiKey: 'sk-secret-value' }] })
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    const view = JSON.stringify(catalogView(catalog))
    expect(view).not.toContain('sk-secret-value')
    expect(view).toContain('DEEPSEEK_API_KEY')
  })
})

describe('providers · 解析链', () => {
  it('UT-PRV-13 访客自带 Key 时排第一（只影响他自己）', async () => {
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    const chain = resolveChain(catalog, {
      baseUrl: 'https://my.llm.example/v1',
      model: 'mine',
      apiKey: 'sk-mine',
      provider: 'custom',
    })
    expect(chain[0]?.profile.id).toBe('custom')
    expect(chain[0]?.profile.baseUrl).toBe('https://my.llm.example/v1')
    expect(chain.length).toBeGreaterThan(1)
  })

  it('UT-PRV-14 三项不齐不进链；内网地址不进链', async () => {
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: {} })
    expect(resolveChain(catalog, { baseUrl: 'https://a.example/v1', model: 'm', apiKey: '' })).toHaveLength(
      catalog.entries.filter((entry) => entry.ready).length,
    )
    const local = resolveChain(catalog, { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k' })
    expect(local.some((item) => item.profile.id === 'custom')).toBe(false)
  })

  it('UT-PRV-15 点名预设后它排在自带 Key 之后、默认主力之前', async () => {
    const catalog = await buildCatalog({
      dataDir: dir,
      configFile,
      env: { GEMINI_API_KEY: 'sk-g', NUCLEUS_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-d' },
    })
    const chain = resolveChain(catalog, { provider: 'gemini' })
    expect(chain.map((item) => item.profile.id).slice(0, 2)).toEqual(['gemini', 'deepseek'])
  })

  it('UT-PRV-16 同一家不会在链里出现两次', async () => {
    const catalog = await buildCatalog({ dataDir: dir, configFile, env: { DEEPSEEK_API_KEY: 'sk-d' } })
    const chain = resolveChain(catalog, { provider: 'deepseek' })
    const ids = chain.map((item) => item.profile.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('UT-PRV-17 isReady：免 Key 恒就绪，其余看 Key', () => {
    const base = { id: 'x', label: 'X', baseUrl: 'https://x.example/v1', model: 'm' }
    expect(isReady({ ...base, free: true }, '')).toBe(true)
    expect(isReady({ ...base, free: false }, '')).toBe(false)
    expect(isReady({ ...base, free: false }, 'k')).toBe(true)
  })
})

describe('queue · 免 Key 配额闸门', () => {
  it('UT-Q-01 无间隔时直接放行', async () => {
    expect(await waitForSlot('none', { minIntervalMs: 0 })).toBe(0)
  })

  it('UT-Q-02 两个请求被排成串行，第二个确实等了', async () => {
    const started = Date.now()
    await waitForSlot('p1', { minIntervalMs: 300 })
    const second = await waitForSlot('p1', { minIntervalMs: 300 })
    expect(second).toBeGreaterThanOrEqual(250)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it('UT-Q-03 等不起就 QueueFull，而且不把后面的人一起推后', async () => {
    await waitForSlot('p2', { minIntervalMs: 5_000 })
    await expect(waitForSlot('p2', { minIntervalMs: 5_000, maxWaitMs: 500 })).rejects.toBeInstanceOf(QueueFullError)
    // 被拒的这次没有占用槽位：下一次预计等待仍然约为 5s，而不是 10s
    expect(projectedWait('p2', 5_000)).toBeLessThan(5_100)
    expect(projectedWait('p2', 5_000)).toBeGreaterThan(3_500)
  })

  it('UT-Q-04 不同提供方互不影响', async () => {
    await waitForSlot('a', { minIntervalMs: 4_000 })
    expect(await waitForSlot('b', { minIntervalMs: 4_000 })).toBe(0)
  })

  it('UT-Q-05 等待途中被中止要立刻退出，不占着槽位干等', async () => {
    const controller = new AbortController()
    await waitForSlot('p3', { minIntervalMs: 4_000 })
    const started = Date.now()
    setTimeout(() => controller.abort(), 50)
    await expect(
      waitForSlot('p3', { minIntervalMs: 4_000, signal: controller.signal }),
    ).rejects.toThrow(/aborted/)
    expect(Date.now() - started).toBeLessThan(1_500)
  })
})

describe('runner · 故障转移判定与占位方案', () => {
  const emptySink = () => createSink([], null)

  it('UT-RN-01 只有"这家不行"且还没产出时才换下一家', () => {
    for (const code of ['llm_auth', 'llm_quota', 'llm_timeout', 'llm_network', 'protocol_error'] as const) {
      expect(canFailover(code, emptySink()), code).toBe(true)
    }
    expect(canFailover('internal', emptySink())).toBe(false)
    expect(canFailover(undefined, emptySink())).toBe(false)
  })

  it('UT-RN-02 已经吐了一半就不再换家（否则两份代码互相覆盖）', () => {
    const sink = emptySink()
    sink.raw = '<file path="index.html">'
    expect(canFailover('llm_timeout', sink)).toBe(false)

    const half = emptySink()
    half.completed.add('index.html')
    expect(canFailover('llm_quota', half)).toBe(false)
  })

  it('UT-RN-03 占位方案从需求里捞应用名，捞不到就用开头', () => {
    expect(placeholderPlan('做一个记账应用，叫「小账本」，主色墨绿').name).toBe('小账本')
    expect(placeholderPlan('做一个番茄钟').name).toBe('做一个番茄钟')
    expect(placeholderPlan('   ').name).toBe('新应用')
  })
})
