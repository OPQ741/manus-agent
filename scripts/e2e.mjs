/**
 * 浏览器端冒烟测试（真实 Chrome + 真实服务 + 真实大模型）。
 *
 * 覆盖 PRD §8 验收清单里的主流程：生成 → 交互 → 数据持久 → 迭代 → 运行时自愈
 * → 回滚 → 分享 → 导出 → 停止保留 → 设计微调。它是 npm test（单元/集成）之外的第二道闸门。
 *
 * 用法：
 *   npm run build && PORT=8787 npm run serve
 *   BASE_URL=http://127.0.0.1:8787 npm run e2e
 *
 * 两条与"真实模型"绑定的写法约定，改这个文件前请先读：
 *  1. **不断言生成物 DOM**。生成物是模型写的，class/id 每次都可能不同；
 *     要验交互与持久化，就往第一个输入框里填一个唯一标记串，再看它有没有出现在页面上、
 *     刷新后还在不在 —— 这对任何一版生成物都成立，也不需要配方配合。
 *  2. **超时按"一次真实生成"给**。免 Key 通道有排队与修复轮，慢是设计的一部分；
 *     把超时调回秒级只会得到一条 flaky 测试。
 */

import { chromium } from 'playwright'
import { strict as assert } from 'node:assert'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787'
const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)

/** 一次真实生成（排队 + 流式 + 可能的修复轮）的等待上限。 */
const GEN_TIMEOUT = Number(process.env.E2E_GEN_TIMEOUT ?? 240_000)
const results = []
let stepIndex = 0

async function step(name, fn) {
  stepIndex += 1
  const started = Date.now()
  try {
    await fn()
    results.push({ n: stepIndex, name, ok: true, ms: Date.now() - started })
    console.log(`  ✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  } catch (error) {
    results.push({ n: stepIndex, name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
    throw error
  }
}

// 本机可能开着系统代理（Clash 之类），127.0.0.1 会被代理拦掉 → 直接绕过代理
const browser = await chromium.launch(
  CHROME ? { executablePath: CHROME, args: ['--no-proxy-server'] } : { args: ['--no-proxy-server'] },
)
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message))

const frame = () => page.frameLocator('iframe[title="应用预览"]')
const iframeElement = () => page.locator('iframe[title="应用预览"]')
/**
 * 拿到预览 iframe 的 Frame 对象（需要 evaluate 时用）。
 *
 * 不按 url === 'about:srcdoc' 过滤：srcdoc + sandbox（无 allow-same-origin）时
 * 不同 Chrome 版本上报的 frame url 可能是空串，按 url 过滤会偶发拿不到。
 * 预览永远是主文档唯一/最后一个子 frame，取最后一个更稳。
 */
const previewFrame = () => {
  const frames = page.frames().filter((item) => item !== page.mainFrame())
  return frames[frames.length - 1]
}

/** 等一次生成结束：发送按钮从「停止」恢复成「发送」。 */
async function waitForGenerationEnd(timeout = GEN_TIMEOUT) {
  await page.getByRole('button', { name: /^发送$/ }).waitFor({ state: 'visible', timeout })
}

/** 读预览里的可见文本（生成物内部结构未知，文本是最稳的观测面）。 */
async function previewText() {
  return (await frame().locator('body').innerText({ timeout: 15_000 })).replace(/\s+/g, ' ').trim()
}

try {
  console.log(`\nNucleus E2E · ${BASE}\n`)

  await step('E2E-01 首页可用（无 console 错误）且出厂示例是真实模型产物', async () => {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    await page.locator('.composer textarea').waitFor({ state: 'visible' })
    assert.deepEqual(consoleErrors, [])
    // 首页下面的示例项目必须标注它是哪家模型生成的（不再是"本地引擎"）
    const badges = await page.locator('.project-card .badge').allInnerTexts()
    assert.ok(badges.some((text) => /GPT-OSS|DeepSeek|Gemini|Kimi|GLM|Qwen|模型/.test(text)), `项目卡上没有模型出处标注：${badges.join(' / ')}`)
    assert.ok(!badges.includes('本地引擎'), '仍然出现"本地引擎"，说明本地 mock 没清干净')
  })

  await step('E2E-02 输入需求 → 真实模型生成可运行应用', async () => {
    await page
      .locator('.composer textarea')
      .fill('做一个记账应用，叫「E2E 账本」，主色用墨绿，记录金额、分类和备注')
    await page.getByRole('button', { name: /生成应用/ }).click()
    await page.waitForURL(/#\/studio\//, { timeout: 15_000 })
    await iframeElement().waitFor({ state: 'attached', timeout: GEN_TIMEOUT })
    await waitForGenerationEnd()
    const text = await previewText()
    // 这里只判断"不是白屏"。原来的阈值是 20 字符，但一个极简记账页
    // （标题 + 金额/分类/备注 + 添加按钮）干净起来正好 18 个字符 —— 阈值卡在
    // 内容密度上而不是功能上，模型少写一行提示语就会误报。真正的判定在下面：
    // 应用名必须出现、代码面板必须有内容、下一步必须能真的录入并持久化。
    assert.ok(text.length > 8, `预览几乎是空的：${text.slice(0, 80)}`)
    // 应用名由模型决定，但需求里点了名，产物标题就该出现它
    assert.match(text, /E2E 账本/, `预览文本里没有应用名：${text.slice(0, 120)}`)
    // 代码面板必须真的有内容（行数来自真实解析，不是占位）
    await page.getByRole('tab', { name: /代码/ }).click()
    const code = await page.locator('.code-view, pre, .code-panel').first().innerText()
    assert.ok(code.length > 200, '代码面板几乎是空的')
    await page.getByRole('tab', { name: /预览/ }).click()
  })

  await step('E2E-03 应用内真实交互 + 刷新预览后数据仍在', async () => {
    const token = `E2E${Date.now().toString(36).slice(-5)}`
    // <input type="number">（金额之类）拒绝字母，给它一个纯数字标记
    const numericToken = String(Date.now()).slice(-6)
    const before = await previewText()

    // 把所有可填写字段都填上唯一标记：生成物常有必填校验
    // （例如记账页要求「金额 + 分类」都有值），只填第一个字段提交会被拦下，
    // 那样测的是校验文案而不是"录入 → 落库 → 刷新还在"。
    const inputs = frame().locator('input:not([type="hidden"]), textarea')
    const count = await inputs.count()
    assert.ok(count > 0, '生成物里没有任何输入框，谈不上"真实交互"')
    let filled = 0
    for (let i = 0; i < count; i += 1) {
      const input = inputs.nth(i)
      const type = ((await input.getAttribute('type')) ?? 'text').toLowerCase()
      if (['checkbox', 'radio', 'date', 'color', 'range', 'file'].includes(type)) continue
      if (!(await input.isVisible())) continue
      await input.scrollIntoViewIfNeeded()
      await input.fill(type === 'number' ? numericToken : token)
      filled += 1
    }
    assert.ok(filled > 0, '生成物里没有可填写的输入框')

    const buttons = frame().locator('button, button[type="submit"], input[type="submit"]')
    const buttonCount = await buttons.count()
    assert.ok(buttonCount > 0, '生成物里没有任何按钮')
    let clicked = false
    for (let i = 0; i < buttonCount; i += 1) {
      const button = buttons.nth(i)
      if (!(await button.isVisible())) continue
      await button.click({ timeout: 5_000 }).then(() => (clicked = true)).catch(() => {})
      if (clicked) break
    }
    assert.ok(clicked, '生成物里的按钮点不动')

    const marks = [token, numericToken]
    const hasMark = (text) => marks.some((mark) => text.includes(mark))

    await page.waitForTimeout(800)
    const after = await previewText()
    assert.notEqual(after, before, '点了提交按钮但页面没有任何变化，交互是假的')
    assert.ok(hasMark(after), `页面上找不到刚录入的标记 ${token} / ${numericToken}`)

    // 刷新预览：种子从宿主页面回灌，数据不应丢 —— 这才是"持久化"而不是"内存里活着"
    await page.getByRole('button', { name: '重新加载预览' }).click()
    await frame().locator('body').waitFor({ state: 'visible', timeout: 20_000 })
    const reloaded = await previewText()
    assert.ok(hasMark(reloaded), '刷新预览后数据丢了，localStorage 桥接没生效')
  })

  await step('E2E-04 迭代修改生成新版本', async () => {
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    const detail = await (await page.request.get(`${BASE}/api/projects/${projectId}`)).json()
    const version = detail.project.version
    assert.ok(version >= 1, `第一轮生成没有落版本：v${version}`)

    const chat = page.locator('.chat-input textarea')
    await chat.fill('把主色改成红色，并在标题下面加一句说明文字')
    await page.getByRole('button', { name: /^发送$/ }).click()
    await waitForGenerationEnd()
    const after = await (await page.request.get(`${BASE}/api/projects/${projectId}`)).json()
    assert.ok(after.project.version > version, `版本没有递增（${version} → ${after.project.version}）`)
    assert.ok(after.versions.length >= 2, '版本历史里没有第二次生成')
    await page.getByRole('tab', { name: /预览/ }).click()
    await iframeElement().waitFor({ state: 'attached', timeout: 20_000 })
  })

  await step('E2E-05 运行时错误被捕获并可一键修复', async () => {
    const preview = previewFrame()
    assert.ok(preview, '找不到预览 iframe')
    await preview.evaluate(() => {
      setTimeout(() => {
        throw new Error('E2E 模拟运行时错误')
      }, 0)
    })
    const banner = page.locator('.error-banner').first()
    await banner.waitFor({ state: 'visible', timeout: 8_000 })
    assert.match(await banner.innerText(), /运行时错误/)

    await page.getByRole('button', { name: '让 Agent 修复' }).click()
    await waitForGenerationEnd()
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    const detail = await (await page.request.get(`${BASE}/api/projects/${projectId}`)).json()
    assert.ok(detail.project.version >= 3, `修复没有产生新版本（当前 v${detail.project.version}）`)
    await page.getByRole('tab', { name: /预览/ }).click()
    await iframeElement().waitFor({ state: 'attached', timeout: 20_000 })
  })

  await step('E2E-06 版本回滚', async () => {
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    await page.getByRole('tab', { name: /版本/ }).click()
    const items = page.locator('.version-item')
    await items.first().waitFor()
    const countBefore = await items.count()
    assert.ok(countBefore >= 3, `版本数不足，回滚没有意义：${countBefore}`)
    await page.locator('.version-item', { hasText: 'v1' }).getByRole('button', { name: /回滚/ }).click()
    await page
      .locator('.badge.accent', { hasText: `v${countBefore + 1}` })
      .first()
      .waitFor({ timeout: 20_000 })
  })

  await step('E2E-07 项目在刷新后仍然存在', async () => {
    const url = page.url()
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    assert.equal(page.url(), url)
    await page.getByRole('tab', { name: /版本/ }).click()
    assert.ok((await page.locator('.version-item').count()) >= 3)
  })

  await step('E2E-08 导出 ZIP 是合法压缩包', async () => {
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    const response = await page.request.get(`${BASE}/api/projects/${projectId}/export`)
    assert.equal(response.status(), 200)
    const buffer = await response.body()
    assert.equal(buffer.subarray(0, 2).toString(), 'PK')
    assert.ok(buffer.length > 1000)
  })

  await step('E2E-09 分享链接可独立运行', async () => {
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    const detail = await (await page.request.get(`${BASE}/api/projects/${projectId}`)).json()
    const share = await context.newPage()
    await share.goto(`${BASE}/#/p/${detail.project.slug}`, { waitUntil: 'networkidle' })
    const shareFrame = share.frameLocator('iframe')
    await shareFrame.locator('body').waitFor({ state: 'visible', timeout: 20_000 })
    const text = (await shareFrame.locator('body').innerText()).replace(/\s+/g, ' ')
    assert.ok(text.length > 20, '分享页的预览是空的')
    // 分享页顶栏要标出是哪家模型生成的
    assert.match(await share.locator('.share-bar').innerText(), /GPT-OSS|DeepSeek|Gemini|Kimi|GLM|Qwen|模型生成/)
    await share.close()
  })

  await step('E2E-10 移动端 390px 无横向滚动', async () => {
    const mobile = await context.newPage()
    await mobile.setViewportSize({ width: 390, height: 844 })
    await mobile.goto(BASE + '/', { waitUntil: 'networkidle' })
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    assert.ok(overflow <= 2, `横向溢出 ${overflow}px`)
    await mobile.close()
  })

  await step('E2E-11 生成中停止会保留已完成的文件', async () => {
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    const tag = Date.now().toString(36).slice(-4)
    const prompt = `名字叫「E2E 概览 ${tag}」，主色换成紫色，并加一个本月概览区块`

    // 在 Node 侧发起生成并逐帧读 SSE：精确地在"第一个文件刚写完"那一刻喊停。
    // 真实模型一轮要几十秒，这个窗口比本地编译器时代宽得多，反而更好抓。
    //
    // 免 Key 通道会偶发 "模型响应超时（30s 无数据）"：那一轮只会回一个 error 事件，
    // 没有任何 file_end —— 那是上游抖动，不是"停止保留"功能坏了。所以重试两轮，
    // 只有连续三轮都没有 file_end 才判失败，并把最后一次错误带进断言信息。
    let stopped = false
    let partial = false
    let lastError = null

    for (let attempt = 1; attempt <= 3 && !stopped; attempt += 1) {
      partial = false
      const response = await fetch(`${BASE}/api/projects/${projectId}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      assert.equal(response.status, 200)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of block.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            let event
            try {
              event = JSON.parse(trimmed.slice(5).trim())
            } catch {
              continue
            }
            if (event.type === 'error') lastError = event.message
            if (event.type === 'file_end' && !stopped) {
              stopped = true
              await fetch(`${BASE}/api/projects/${projectId}/stop`, { method: 'POST' })
            }
            if (event.type === 'done' && event.partial) partial = true
          }
        }
      }
      if (!stopped && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 4_000))
    }
    assert.ok(stopped, `三轮生成都没等到 file_end${lastError ? `，最后一次错误：${lastError}` : ''}`)
    assert.ok(partial, '没有收到 partial 的 done 事件')

    // 界面上能看到这个「中断保留」的版本
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /版本/ }).click()
    const kept = page.locator('.version-item', { hasText: '中断保留' })
    await kept.first().waitFor({ timeout: 10_000 })
    assert.ok((await kept.count()) >= 1, '版本列表里没有「中断保留」条目')

    // 顺带确认界面上的停止按钮：出现、且文案说清楚会保留什么
    const chat = page.locator('.chat-input textarea')
    await chat.fill('再加一句说明文字')
    await page.getByRole('button', { name: /^发送$/ }).click()
    const stop = page.getByRole('button', { name: /保留已完成文件/ })
    await stop.waitFor({ state: 'visible', timeout: 20_000 })
    await waitForGenerationEnd()
  })

  await step('E2E-12 设计微调实时生效、刷新后仍在', async () => {
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    // 前面的用例把页签留在了「版本」，先回预览
    await page.getByRole('tab', { name: /预览/ }).click()
    await iframeElement().waitFor({ state: 'attached', timeout: 20_000 })
    await frame().locator('body').waitFor({ state: 'visible', timeout: 20_000 })

    // 生成物必须声明 --accent，否则"实时改主色"就是个骗人的开关。
    // 这条由提示词里的设计令牌契约保证，所以它同时也是对契约是否被遵守的真实检验。
    const live = previewFrame()
    await live.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().length > 0,
      null,
      { timeout: 10_000 },
    )

    await page.getByRole('button', { name: '设计微调' }).click()

    // 1) 点色卡：不重新生成、不重载 iframe，变量应当立即变
    await page.getByRole('button', { name: '主色 玫红' }).click()
    await live.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === '#e11d6b',
      null,
      { timeout: 5_000 },
    )

    // 2) 拖动圆角滑杆：同样即时生效
    await page.locator('input[aria-label="圆角大小"]').fill('6')
    await live.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--radius').trim() === '6px',
      null,
      { timeout: 5_000 },
    )

    // 3) 防抖保存后，服务端应记住这次微调
    await page.waitForTimeout(900)
    const detail = await (await page.request.get(`${BASE}/api/projects/${projectId}`)).json()
    assert.equal(detail.project.tweak?.accent, '#e11d6b')
    assert.equal(detail.project.tweak?.radius, 6)

    // 4) 整页刷新：外观仍然是调过的那个（持久化，而不是内存里的临时效果）
    await page.reload({ waitUntil: 'networkidle' })
    const reloaded = previewFrame()
    await reloaded.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === '#e11d6b',
      null,
      { timeout: 10_000 },
    )
  })

  await step('E2E-13 「恢复默认」清除微调，刷新后不回退', async () => {
    const projectId = page.url().split('/studio/')[1]?.split('?')[0]
    await page.getByRole('tab', { name: /预览/ }).click()
    await iframeElement().waitFor({ state: 'attached', timeout: 20_000 })
    await frame().locator('body').waitFor({ state: 'visible', timeout: 20_000 })

    // 前置：E2E-12 留下的玫红微调此刻应当还在
    await page.getByRole('button', { name: '设计微调' }).click()
    const before = previewFrame()
    await before.waitForFunction(
      () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase() === '#e11d6b',
      null,
      { timeout: 10_000 },
    )

    // 点「恢复默认」→ 清除微调并落库（这一步曾经只在前端生效，刷新就回退）
    await page.getByRole('button', { name: '恢复默认' }).click()
    await page.waitForTimeout(900)

    // 服务端：tweak 真的没了，产物里不再带微调样式
    const detail = await (await page.request.get(`${BASE}/api/projects/${projectId}`)).json()
    assert.equal(detail.project.tweak, undefined, '服务端仍保留微调，说明"恢复默认"没落库')
    assert.ok(!detail.previewHtml.includes('data-nucleus="tweak"'), '产物仍注入微调样式')

    // 生成时的底色是动态的：前面几轮把主色改过红/紫并回滚过，绝不是某个写死的值。
    // 所以期望值从"已清除微调的产物"里现取——那里面只剩生成自带的那一个 --accent 声明。
    const baseAccent = (/--accent:\s*(#[0-9a-fA-F]{6})/.exec(detail.previewHtml)?.[1] ?? '').toLowerCase()
    assert.ok(baseAccent, '产物里没解析到生成时的 --accent')
    assert.notEqual(baseAccent, '#e11d6b', '底色不该正好等于玫红微调，否则这条断言失去意义')

    // 整页刷新后：回到"生成时的那个主色"（而不是写死的墨绿），且一定不是玫红微调
    await page.reload({ waitUntil: 'networkidle' })
    const after = previewFrame()
    await after.waitForFunction(
      (expected) => {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim().toLowerCase()
        return accent === expected
      },
      baseAccent,
      { timeout: 10_000 },
    )
  })

  await step('E2E-14 设置页可选预设，自带 Key 后立刻优先', async () => {
    await page.goto(BASE + '/#/settings', { waitUntil: 'networkidle' })
    const cards = page.locator('.provider-card')
    await cards.first().waitFor({ timeout: 10_000 })
    const labels = await cards.allInnerTexts()
    assert.ok(labels.some((text) => /免 Key/.test(text)), '设置页没有免 Key 通道可选')
    assert.ok(labels.some((text) => /DeepSeek|Gemini|Kimi/i.test(text)), '设置页没有预设模型可选')
    // 目录只回显"从哪个环境变量读 Key"，绝不能把 Key 本身发到前端
    const html = await page.content()
    assert.ok(!/sk-[a-zA-Z0-9]{12,}/.test(html), '设置页里出现了疑似明文 Key')
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  })

  console.log(`\n全部 ${results.length} 步通过 ✓`)
  if (consoleErrors.length) console.log('控制台错误（非阻断）：', consoleErrors.slice(0, 5))
  await browser.close()
  process.exit(0)
} catch (error) {
  console.error('\nE2E 失败：', error?.message ?? error)
  try {
    await page.screenshot({ path: 'e2e-failure.png', fullPage: false })
    console.log('已保存截图 e2e-failure.png')
  } catch {
    /* ignore */
  }
  await browser.close()
  process.exit(1)
}
