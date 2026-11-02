/**
 * 浏览器端冒烟测试（真实 Chrome + 真实服务）。
 *
 * 覆盖 PRD §8 验收清单里的主流程：生成 → 交互 → 数据持久 → 迭代 → 运行时自愈
 * → 回滚 → 分享 → 导出。它是 npm test（单元/集成）之外的第二道闸门。
 *
 * 用法：
 *   npm run build && PORT=8787 npm run serve
 *   BASE_URL=http://127.0.0.1:8787 npm run e2e
 */

import { chromium } from 'playwright'
import { strict as assert } from 'node:assert'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787'
const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)

const results = []
let stepIndex = 0

async function step(name, fn) {
  stepIndex += 1
  const started = Date.now()
  try {
    await fn()
    results.push({ n: stepIndex, name, ok: true, ms: Date.now() - started })
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`)
  } catch (error) {
    results.push({ n: stepIndex, name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
    throw error
  }
}

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {})
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message))

const frame = () => page.frameLocator('iframe[title="应用预览"]')
const iframeElement = () => page.locator('iframe[title="应用预览"]')

try {
  console.log(`\nNucleus E2E · ${BASE}\n`)

  await step('E2E-01 首页可用（无 console 错误）', async () => {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    await page.locator('.composer textarea').waitFor({ state: 'visible' })
    assert.deepEqual(consoleErrors, [])
  })

  await step('E2E-02 输入需求并生成出可运行应用', async () => {
    await page.locator('.composer textarea').fill('做一个记账应用，叫「E2E 账本」，主色用墨绿，记录金额、分类和备注')
    await page.getByRole('button', { name: /生成应用/ }).click()
    await page.waitForURL(/#\/studio\//, { timeout: 15000 })
    await iframeElement().waitFor({ state: 'attached', timeout: 20000 })
    // 等生成完成（发送按钮从「停止」恢复为「发送」）
    await page.getByRole('button', { name: /^发送$/ }).waitFor({ state: 'visible', timeout: 30000 })
    await frame().locator('#amount').waitFor({ state: 'visible', timeout: 20000 })
    const title = await frame().locator('.brand').first().innerText()
    assert.match(title, /E2E 账本/)
  })

  await step('E2E-03 应用内真实交互 + 刷新后数据仍在', async () => {
    const before = await frame().locator('.item').count()
    await frame().locator('#amount').fill('12.5')
    await frame().locator('#note').fill('E2E 测试一笔')
    await frame().getByRole('button', { name: '记一笔' }).click()
    await frame().locator('.item').first().waitFor()
    assert.equal(await frame().locator('.item').count(), before + 1)

    const total = await frame().locator('#total').innerText()
    assert.match(total, /¥\d/)

    // 刷新预览：种子从宿主页面回灌，数据不应丢
    await page.getByRole('button', { name: '重新加载预览' }).click()
    await frame().locator('.item').first().waitFor({ timeout: 10000 })
    assert.equal(await frame().locator('.item').count(), before + 1)
  })

  await step('E2E-04 迭代修改生成新版本', async () => {
    const chat = page.locator('.chat-input textarea')
    await chat.fill('把主色改成红色，并在标题下面加一句说明')
    await page.getByRole('button', { name: /^发送$/ }).click()
    await page.locator('.badge.accent', { hasText: 'v2' }).first().waitFor({ timeout: 30000 })
    const css = await page.evaluate(async () => {
      const header = document.querySelector('.studio')
      return header ? header.textContent : ''
    })
    assert.ok(css.includes('v2'))
  })

  await step('E2E-05 运行时错误被捕获并可一键修复', async () => {
    const frames = page.frames().filter((item) => item.url() === 'about:srcdoc')
    assert.ok(frames.length > 0, '找不到预览 iframe')
    await frames[frames.length - 1].evaluate(() => {
      setTimeout(() => {
        throw new Error('E2E 模拟运行时错误')
      }, 0)
    })
    const banner = page.locator('.error-banner').first()
    await banner.waitFor({ state: 'visible', timeout: 8000 })
    assert.match(await banner.innerText(), /运行时错误/)

    await page.getByRole('button', { name: '让 Agent 修复' }).click()
    await page.getByRole('button', { name: /^发送$/ }).waitFor({ state: 'visible', timeout: 30000 })
    await page.locator('.badge.accent', { hasText: 'v3' }).first().waitFor({ timeout: 20000 })
  })

  await step('E2E-06 版本回滚', async () => {
    await page.getByRole('tab', { name: /版本/ }).click()
    const items = page.locator('.version-item')
    await items.first().waitFor()
    const countBefore = await items.count()
    await page.locator('.version-item', { hasText: 'v1' }).getByRole('button', { name: /回滚/ }).click()
    await page.locator('.badge.accent', { hasText: `v${countBefore + 1}` }).first().waitFor({ timeout: 20000 })
    const accent = await page.evaluate(() => localStorage.getItem('nucleus.visitor'))
    assert.ok(accent)
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
    await shareFrame.locator('body').waitFor({ state: 'visible', timeout: 15000 })
    const text = await shareFrame.locator('.brand').first().innerText()
    assert.match(text, /E2E 账本/)
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
    // 为什么不放在浏览器里轮询 DOM：整轮生成只有 ~0.7s，轮询延迟就能错过窗口，
    // 这种 flaky 测试比没有测试更糟。
    const response = await fetch(`${BASE}/api/projects/${projectId}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, engine: 'local' }),
    })
    assert.equal(response.status, 200)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let stopped = false
    let partial = false
    while (true) {
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
          if (event.type === 'file_end' && !stopped) {
            stopped = true
            await fetch(`${BASE}/api/projects/${projectId}/stop`, { method: 'POST' })
          }
          if (event.type === 'done' && event.partial) partial = true
        }
      }
    }
    assert.ok(partial, '没有收到 partial 的 done 事件')

    // 界面上能看到这个「中断保留」的版本
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('tab', { name: /版本/ }).click()
    const kept = page.locator('.version-item', { hasText: '中断保留' })
    await kept.first().waitFor({ timeout: 10000 })
    assert.ok((await kept.count()) >= 1, '版本列表里没有「中断保留」条目')

    // 顺带确认界面上的停止按钮：出现、且文案说清楚会保留什么
    const chat = page.locator('.chat-input textarea')
    await chat.fill('再加一句说明文字')
    await page.getByRole('button', { name: /^发送$/ }).click()
    const stop = page.getByRole('button', { name: /保留已完成文件/ })
    await stop.waitFor({ state: 'visible', timeout: 10000 })
    await page.getByRole('button', { name: /^发送$/ }).waitFor({ state: 'visible', timeout: 30000 })
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
