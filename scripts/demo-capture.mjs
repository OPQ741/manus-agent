/**
 * 演示素材采集：一次真实链路跑完，同时产出「使用视频」与全套界面截图。
 *
 * 和 e2e.mjs 的分工：e2e 负责**断言**（可复跑、会失败），这个脚本负责**证据**
 * （视频 + 截图，进文档给人看）。它不断言生成物 DOM，也不为了好看而放慢或加速——
 * 视频里的一切都是真实倍速：排队是真的排队，流式落字是真的在落。
 *
 * 用法（服务要先起来，数据目录指到临时目录，避免把演示项目混进本机库里）：
 *   npm run build
 *   NUCLEUS_DATA_DIR=.tmp-visual/data PORT=8899 node dist/server.js &
 *   BASE_URL=http://127.0.0.1:8899 npm run demo
 *
 * 产物：
 *   docs/screenshots/*.png       界面截图（文档与 README 引用）
 *   .tmp-visual/video/*.webm     Playwright 原始录屏（gitignore 内）
 *   docs/demo/nucleus-demo.mp4   交付用的使用视频，由下面这条命令切出来（需要本机 ffmpeg）：
 *     ffmpeg -y -i .tmp-visual/video/<最新>.webm \
 *       -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -movflags +faststart \
 *       docs/demo/nucleus-demo.mp4
 *
 * 复测模式 `DEMO_PROJECT=p_xxxx npm run demo`：直接进已有项目，只跑「记一笔 + 刷新持久」
 * 这一段，且不写 docs/screenshots。生成物是模型写的，表单形状每轮都可能变（这轮是
 * <select>，下轮是一排 chip），用它复核填表逻辑不必再烧一次真实生成与上游配额。
 *
 * 与 e2e.mjs 相同的两条约定：不断言生成物 DOM；超时按"一次真实生成"给。
 */

import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8899'
const SHOT_DIR = process.env.SHOT_DIR ?? 'docs/screenshots'
const VIDEO_DIR = process.env.VIDEO_DIR ?? '.tmp-visual/video'
const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)
const GEN_TIMEOUT = Number(process.env.DEMO_GEN_TIMEOUT ?? 300_000)
const RESUME_PROJECT = process.env.DEMO_PROJECT ?? ''

const PROMPT_NEW = '做一个记账应用，叫「小账本」，主色墨绿，可以记录金额、分类和备注'
const PROMPT_ITERATE = '在标题下面加一句说明文字，并加一个按分类的支出占比条'

const started = Date.now()
const marks = []

/** 记一条时间线：既打日志，也供文档里写"录屏第几十秒是什么"。 */
function mark(scene, note = '') {
  const sec = ((Date.now() - started) / 1000).toFixed(1)
  marks.push({ scene, sec, note })
  console.log(`[${sec.padStart(6)}s] ${scene}${note ? `  ${note}` : ''}`)
}

mkdirSync(SHOT_DIR, { recursive: true })
mkdirSync(VIDEO_DIR, { recursive: true })

const browser = await chromium.launch(
  CHROME ? { executablePath: CHROME, args: ['--no-proxy-server'] } : { args: ['--no-proxy-server'] },
)
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  // 截图要 2x 才清晰；录屏按 1x 出，体积控制在几 MB，GitHub 上能直接入库。
  deviceScaleFactor: 2,
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
})
const page = await context.newPage()
// 「分享」走的是剪贴板 API：不给权限就只能看到兜底 toast，视频里分不清到底复制成功没有。
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => {})

const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message))

const frame = () => page.frameLocator('iframe[title="应用预览"]')

/**
 * 预览里的可见文本。
 *
 * 先把千分位逗号去掉再比：生成物常把金额渲染成 `¥123,456.00`，而脚本填进去的是
 * `123456` —— 不归一化就会把"应用其实记上了"误判成"没记上"（实测踩过，白跑一轮真实生成）。
 */
const previewText = async () => {
  const raw = await frame().locator('body').innerText({ timeout: 20_000 })
  return raw.replace(/,/g, '').replace(/\s+/g, ' ').trim()
}

/** 打字用逐字输入：视频里要看得见"人在写需求"，而不是瞬间填空。 */
async function typeSlowly(locator, text, delay = 42) {
  await locator.click()
  await locator.pressSequentially(text, { delay })
}

async function shot(name, options = {}) {
  if (RESUME_PROJECT) return mark('跳过截图', name)
  await page.screenshot({ path: join(SHOT_DIR, name), ...options })
  mark('截图', name)
}

/** 等生成结束：发送按钮从「停止」恢复成「发送」。 */
async function waitForGenerationEnd(timeout = GEN_TIMEOUT) {
  await page.getByRole('button', { name: /^发送$/ }).waitFor({ state: 'visible', timeout })
}

/* ================= 场景 1–3：首页 → 一次真实生成 ================= */

async function recordFreshGeneration() {
  mark('场景 1 · 首页')
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.locator('.composer textarea').waitFor({ state: 'visible' })
  await page.waitForTimeout(1_600)
  await shot('home.png')

  mark('场景 2 · 输入需求')
  await typeSlowly(page.locator('.composer textarea'), PROMPT_NEW)
  await page.waitForTimeout(900)

  mark('场景 3 · 提交生成')
  await page.getByRole('button', { name: /生成应用/ }).click()
  await page.waitForURL(/#\/studio\//, { timeout: 20_000 })

  await page.locator('.run-status').first().waitFor({ state: 'visible', timeout: 60_000 })
  mark('状态条出现', '正在理解需求')
  await page.waitForTimeout(1_500)

  const gotPlan = await page
    .locator('.thought-name')
    .first()
    .waitFor({ state: 'visible', timeout: 120_000 })
    .then(() => true)
    .catch(() => false)
  if (gotPlan) mark('方案卡出现', (await page.locator('.thought-name').first().innerText()).trim())

  // 抓"正在写第 N 个文件"的那一帧：方案卡 + 流式落字 + 运行状态条同屏，
  // 这是 Atoms 环节①②最有说服力的一张图，也是视频里最需要被看清的几十秒。
  const gotWriting = await page
    .locator('.run-file.is-active')
    .first()
    .waitFor({ state: 'visible', timeout: 120_000 })
    .then(() => true)
    .catch(() => false)
  if (gotWriting) {
    mark('文件写入中', (await page.locator('.run-file.is-active .run-file-path').first().innerText()).trim())
    await page.waitForTimeout(2_400)
    await shot('generating.png')
  }

  await waitForGenerationEnd()
  mark('第一轮生成结束')
}

/* ================= 场景 5–6：记一笔 → 刷新还在 ================= */

const SUBMIT_LABEL = /保存|提交|添加|新增|记录|确定|确认|记一笔|submit|save|add/i
const DESTRUCTIVE = /删|清空|清|移除|关闭|取消|重置|退出|主题|切换|收起|展开/i

/**
 * 生成物里"选项组"的候选点：分类、类型、标签这类控件，模型想怎么写就怎么写 ——
 * 见过 `<select>`、`<button class="chip">`、也见过 `<div class="cat-item">` 配 click 监听。
 * 所以按"看起来能点 + 文案短"来扫，而不是押某一种标签。
 */
const CLICKABLE_CANDIDATES = [
  'button',
  '[role="radio"]',
  '[role="option"]',
  '[class*="chip"]',
  '[class*="cat"]',
  '[class*="tag"]',
  '[class*="pill"]',
  '[class*="option"]',
  '[class*="type-"]',
].join(', ')

/** 把「🍜 餐饮」这类带 emoji 的文案压成「餐饮」，用来判长短与去重。 */
const cleanLabel = (text) => (text ?? '').replace(/[^\p{L}\p{N}]/gu, '')

async function listOptionCandidates() {
  const nodes = frame().locator(CLICKABLE_CANDIDATES)
  const total = await nodes.count()
  const out = []
  for (let i = 0; i < total; i += 1) {
    const node = nodes.nth(i)
    if (!(await node.isVisible().catch(() => false))) continue
    const label = ((await node.innerText().catch(() => '')) || '').trim()
    // 带换行的一定是容器（一排 chip 的父节点），点它要么没反应，要么把已选的分类重置掉
    if (!label || label.includes('\n')) continue
    const clean = cleanLabel(label)
    if (!clean || clean.length > 6) continue
    if (SUBMIT_LABEL.test(label) || DESTRUCTIVE.test(label)) continue
    if (!out.some((item) => item.clean === clean)) out.push({ label, clean })
  }
  return out
}

async function clickCandidate(label) {
  const nodes = frame().locator(CLICKABLE_CANDIDATES)
  const total = await nodes.count()
  for (let i = 0; i < total; i += 1) {
    const node = nodes.nth(i)
    const text = ((await node.innerText().catch(() => '')) || '').trim()
    if (text !== label) continue
    await node.click({ timeout: 3_000 }).catch(() => {})
    return true
  }
  return false
}

/**
 * 把生成物表单里所有能填的都填上，然后按文案挑提交键点下去。
 *
 * 为什么要"整表重填 + 重试"而不是一次填完就提交：真实产物里普遍有「支出/收入」这类
 * 切换控件，它一改就会**重新生成分类下拉**（把已选的值清掉）。实测第一轮提交就是这么
 * 被应用自己的必填校验拦下的 —— 重填一遍比猜它清了什么可靠得多，而且对任何一版产物都成立。
 */
async function fillAndSubmit(amountToken, noteToken, chipLabel) {
  const today = new Date().toISOString().slice(0, 10)

  const inputs = frame().locator('input:not([type="hidden"]), textarea')
  const inputCount = await inputs.count()
  for (let i = 0; i < inputCount; i += 1) {
    const input = inputs.nth(i)
    const type = ((await input.getAttribute('type')) ?? 'text').toLowerCase()
    if (['checkbox', 'radio', 'color', 'range', 'file'].includes(type)) continue
    if (!(await input.isVisible())) continue
    const hint = `${(await input.getAttribute('placeholder')) ?? ''} ${(await input.getAttribute('name')) ?? ''} ${(await input.getAttribute('id')) ?? ''}`
    const numeric = type === 'number' || /金额|价格|数量|amount|price|qty/i.test(hint)
    await input.scrollIntoViewIfNeeded()
    // 日期类字段要真填：`<input type="date" required>` 空着，HTML5 校验会把提交整个拦下，
    // 于是"记一笔"变成"什么都没发生"——那是脚本没填表，不是应用没持久化。
    if (type === 'date' || type === 'month') {
      await input.fill(type === 'month' ? today.slice(0, 7) : today).catch(() => {})
      continue
    }
    await input.fill('')
    await typeSlowly(input, numeric ? amountToken : noteToken, 55)
  }

  /*
   * 下拉只填**空着的那些**。有值的绝不碰：真实产物里「类型」常是一个已经选中"支出"的
   * <select>，它的 change 处理器会顺手把「分类」那一排重渲染一遍 —— 于是刚点好的分类
   * 又被清空，提交永远停在"请选择一个分类"。实测这么被自己打死三轮。
   */
  const selects = frame().locator('select')
  for (let i = 0; i < (await selects.count()); i += 1) {
    const select = selects.nth(i)
    if (!(await select.isVisible())) continue
    if (await select.inputValue()) continue
    const values = await select.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value).filter(Boolean))
    if (values.length) await select.selectOption(values[0]).catch(() => {})
  }

  // 选项组的点选放在最后：点完就是提交，中间不再有任何会触发重渲染的动作
  if (chipLabel) await clickCandidate(chipLabel)

  // 提交键按文案挑（同 e2e.mjs）：生成物里还有主题切换/分段控件，盲点第一个会点错。
  // 每次重新查：提交之后生成物会重渲染，旧的 locator 会失效。
  const buttons = frame().locator('button, input[type="submit"]')
  const total = await buttons.count()
  let named = null
  let last = null
  for (let i = 0; i < total; i += 1) {
    const button = buttons.nth(i)
    if (!(await button.isVisible())) continue
    last = button
    const label = ((await button.innerText().catch(() => '')) || (await button.getAttribute('value')) || '').trim()
    if (!named && label && SUBMIT_LABEL.test(label)) named = button
  }
  await (named ?? last)?.click({ timeout: 5_000 }).catch(() => {})
}

async function recordAndPersist() {
  mark('场景 5 · 在生成的应用里记一笔')
  /*
   * 标记串两条腿：金额用不会丢前导零的数字（渲染成 123,456.00 也还在），备注用一句人话。
   * 只靠一条都会误判 —— 有的产物不显示备注，有的把金额格式化掉前导零。
   */
  const amountToken = `12${String(Date.now()).slice(-4)}`
  const noteToken = '午饭打车'
  const hasMark = (text) => text.includes(amountToken) || text.includes(noteToken)

  /*
   * 最多五次：第一次什么都不点直接提交；被应用的必填校验拦下，就依次改点一个"看起来是
   * 选项组"的短标签控件（分类 / 类型 / 标签），每次点完都把整张表重填一遍再提交。
   * 为什么要重填：真实产物里"改类型 → 重渲染分类"是常态，只补点不重填会一直停在
   * "请选择一个分类"（实测连输三轮就是这么来的）。
   */
  const candidates = await listOptionCandidates()
  mark('可点的选项组控件', candidates.map((item) => item.label).join(' / ') || '(没扫到)')
  let after = ''
  let picked = null
  for (let attempt = 1; attempt <= Math.min(candidates.length + 1, 5); attempt += 1) {
    picked = attempt === 1 ? null : candidates[attempt - 2].label
    await fillAndSubmit(amountToken, noteToken, picked)
    await page.waitForTimeout(1_500)
    after = await previewText()
    if (hasMark(after)) {
      mark(`第 ${attempt} 次尝试`, `✓ 记上了${picked ? `（点了「${picked}」）` : ''}`)
      break
    }
    mark(
      `第 ${attempt} 次尝试`,
      `✗ 没记上${picked ? `（已点「${picked}」）` : ''}：${/请选择|请输入|请填写|不能为空|必填/.exec(after)?.[0] ?? '无校验文案'}`,
    )
  }

  mark(
    '录入这笔账',
    hasMark(after)
      ? `✓ 页面上能看到 ${amountToken} / ${noteToken}`
      : `✗ ${/请选择|请输入|请填写|不能为空|必填/.test(after) ? '应用的必填校验一直没放过（表单形状超出预期）' : '页面里找不到标记'} —— 这一段不要用进交付`,
  )

  mark('场景 6 · 刷新预览，数据仍在')
  await page.getByRole('button', { name: '重新加载预览' }).click()
  await frame().locator('body').waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(1_400)
  const reloaded = await previewText()
  mark(
    '持久化',
    hasMark(reloaded)
      ? '✓ 刷新后记录还在（沙箱存储回灌生效）'
      : `✗ 刷新后没找到那条记录${hasMark(after) ? '' : '（那条本来就没记上）'}`,
  )
}

/* ================= 场景 7–11：迭代 / 版本 / 微调 / 导出 / 设置页 ================= */

async function recordRest(projectId) {
  mark('场景 7 · 提迭代需求')
  await typeSlowly(page.locator('.chat-input textarea'), PROMPT_ITERATE)
  await page.getByRole('button', { name: /^发送$/ }).click()
  await page.waitForTimeout(1_000)
  await waitForGenerationEnd()
  mark('第二轮生成结束')
  await page.waitForTimeout(1_600)

  mark('场景 8 · 版本时间线')
  const detail = await (await page.request.get(`${BASE}/api/projects/${projectId}`)).json()
  mark(
    '服务端项目',
    `${detail.project.name} · v${detail.project.version} · ${detail.project.files.length} 个文件 · ${
      detail.versions.length
    } 个版本 · 通道 ${detail.project.providerLabel ?? detail.project.provider}`,
  )
  await page.getByRole('tab', { name: /版本/ }).click()
  await page.locator('.version-item').first().waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1_600)
  await shot('versions.png')
  mark('版本条目', String(await page.locator('.version-item').count()))
  await page.getByRole('tab', { name: /预览/ }).click()
  await page.locator('iframe[title="应用预览"]').waitFor({ state: 'attached', timeout: 20_000 })

  // 允许失败：微调面板要求产物声明 --accent，个别模型那一轮没写令牌，
  // 不该把后面的设置页镜头一起带走。失败会记在时间线里，由人决定要不要重录。
  try {
    mark('场景 9 · 设计微调')
    await frame().locator('body').waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByRole('button', { name: '设计微调' }).click()
    await page.waitForTimeout(700)
    await page.getByRole('button', { name: '主色 玫红' }).click()
    await page.waitForTimeout(1_200)
    await shot('tweak.png')
    mark('微调后主色', '玫红（即时生效，未重新生成）')
    await page.getByRole('button', { name: '恢复默认' }).click()
    await page.waitForTimeout(1_000)
  } catch (error) {
    mark('场景 9 跳过', String(error?.message ?? error).split('\n')[0])
  }

  try {
    mark('场景 10 · 导出与分享')
    // 「导出」是带 href 的 antd Button，落到 DOM 是 <a>，role 是 link 不是 button；
    // 「分享」没有 href，才是真正的 button。按 .topbar 里的文案定位，两个都不挑角色。
    await page.locator('.topbar .ant-btn', { hasText: '导出' }).first().click({ timeout: 8_000 })
    await page.waitForTimeout(1_600)
    await page.locator('.topbar .ant-btn', { hasText: '分享' }).first().click({ timeout: 8_000 })
    await page.waitForTimeout(1_800)
    const zip = await page.request.get(`${BASE}/api/projects/${projectId}/export`)
    const zipBuffer = await zip.body()
    mark(
      '导出 ZIP',
      `HTTP ${zip.status()} · ${(zipBuffer.length / 1024).toFixed(1)} KB · ${
        zipBuffer.subarray(0, 2).toString() === 'PK' ? '合法压缩包' : '不是 ZIP'
      }`,
    )
  } catch (error) {
    mark('场景 10 跳过', String(error?.message ?? error).split('\n')[0])
  }

  mark('场景 11 · 设置页')
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
  await page.locator('.model-current').waitFor({ timeout: 15_000 })
  await page.waitForTimeout(1_400)
  await shot('settings-model.png')
  mark('当前通道', (await page.locator('.model-current').innerText()).replace(/\s+/g, ' ').trim())

  await page.getByRole('button', { name: /更换模型/ }).click()
  await page.locator('.model-row').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(1_400)
  await shot('settings-picker.png')
  await page.keyboard.press('Escape')
}

/* ================= 主流程 ================= */

try {
  console.log(`\nNucleus 演示采集 · ${BASE}${RESUME_PROJECT ? ' · 复测模式' : ''}\n`)

  if (RESUME_PROJECT) {
    mark('复测模式 · 直接进已有项目', RESUME_PROJECT)
    await page.goto(`${BASE}/#/studio/${RESUME_PROJECT}`, { waitUntil: 'networkidle' })
  } else {
    await recordFreshGeneration()
  }

  /* ---------------- 4. 沙箱里真的能点 ---------------- */
  await page.locator('iframe[title="应用预览"]').waitFor({ state: 'attached', timeout: 30_000 })
  await frame().locator('body').waitFor({ state: 'visible', timeout: 30_000 })
  // 多等两秒：让「已更新到 v1」的浮层自己消失，工作台截图要干净
  await page.waitForTimeout(3_200)
  mark('预览已就绪', `可见文本 ${(await previewText()).length} 字`)
  await shot('studio.png')

  await recordAndPersist()

  const projectId = page.url().split('/studio/')[1]?.split('?')[0]
  if (!RESUME_PROJECT) await recordRest(projectId)

  mark('结束', `共 ${((Date.now() - started) / 1000).toFixed(1)}s`)
} catch (error) {
  console.error('\n采集中断：', error?.message ?? error)
  await page.screenshot({ path: join(SHOT_DIR, 'demo-capture-failure.png') }).catch(() => {})
} finally {
  // 录屏文件在 context 关闭时才落盘
  const video = page.video()
  await context.close()
  await browser.close()
  if (video) {
    const path = await video.path()
    console.log(`\n录屏：${path}`)
  }
  if (consoleErrors.length) console.log('控制台错误：', consoleErrors.slice(0, 5))
  const skipped = marks.filter(
    (item) => (item.scene.includes('跳过') && item.scene !== '跳过截图') || item.note.startsWith('✗'),
  )
  console.log(
    skipped.length
      ? `⚠ 有 ${skipped.length} 条没走通：\n  ${skipped.map((item) => `${item.scene} → ${item.note}`).join('\n  ')}`
      : '✓ 全部场景走通',
  )
  console.log(`时间线 ${marks.length} 条已打印`)
}
