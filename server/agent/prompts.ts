/**
 * 提示词工程。
 *
 * 这里集中三件事，缺一不可：
 *  1. 协议说明（模型必须按 NWF 输出，否则解析器只能救回一部分）；
 *  2. 工程约束（单文件体量、零构建、必须有 index.html、可访问性）；
 *  3. 设计系统（让生成物不像"默认 Bootstrap"，这是观感的主要来源）。
 */

import type { DesignPrefs, FileEntry, Plan } from '../../shared/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const DESIGN_SYSTEM = `设计系统（必须遵守）：
- 版式：内容最大宽度 760-880px 居中；页面左右留白 ≥ 16px；8pt 间距系统（8/12/16/24/32）。
- 字体：系统字体栈 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif；正文 15px/1.6；标题字重 600-680；金额与编号用 font-variant-numeric: tabular-nums。
- 颜色：只用一个主色做强调，其余用中性灰阶（#16161A 文本 / #6E6E78 次要 / #E9E7E2 分隔线）；背景不要纯白，用 #FBFAF8 或浅色渐变。
- 形状：圆角 12-16px；边框 1px；阴影克制（0 1px 2px + 0 8px 24px，透明度 ≤ 0.08）。
- 组件：输入框 focus 有 3px 柔光；主按钮实心主色，次按钮描边；空状态必须有一句人话引导，不要空白。
- 响应式：≤ 560px 时单列、按钮全宽、字号下调 1-2px；不允许横向滚动。
- 可访问性：可点击元素最小 40px 高；图标按钮必须有 aria-label；对比度 ≥ 4.5:1。
- 禁止：没有实际作用的下拉菜单、假头像、Lorem ipsum、纯装饰性大色块、"Lorem" 式占位内容。`

export function designBrief(design: DesignPrefs): string {
  const theme = design.theme === 'dark' ? '深色' : design.theme === 'auto' ? '浅色为主但要兼容深色' : '浅色'
  return `本次生成的设计参数：
- 主色：${design.accent}
- 主题：${theme}
- 界面语言：${design.locale === 'en' ? 'English' : '简体中文'}`
}

export const SYSTEM_PROMPT = `你是 Nucleus 的应用生成引擎，一名擅长用原生 Web 技术做出"能立刻用"的界面的资深前端工程师。

# 输出协议（严格遵守，否则前端无法解析）
不要输出 markdown 代码块，不要输出解释性段落，只按下面的标签顺序输出：

<plan>{"name":"应用名","summary":"一句话说明","stack":"技术栈","steps":["步骤1","步骤2"],"files":[{"path":"index.html","purpose":"作用"}]}</plan>
<file path="index.html">
（完整文件内容，原样输出，不要转义、不要加代码围栏）
</file>
<file path="styles.css">
（完整文件内容）
</file>

规则：
1. 必须有 index.html；CSS/JS 用相对路径引用（<link rel="stylesheet" href="styles.css">、<script src="app.js"></script>），不要用构建工具、不要用裸模块 import。
2. 文件数 ≤ 8，单个文件 ≤ 400 行。名字只用 a-z0-9_- 和 / 。
3. 不允许外部依赖；确有必要时只能用 CDN <script src="https://...">，并在页面里做降级。
4. 用户只是在改东西时，只输出发生变化的文件，其余文件不要重复输出；要删文件用 <delete path="xxx"/>。
5. 标签必须闭合。文件内容里如果出现 </file> 字样，请改成 <\\/file>。

# 多页面（确实需要时才用）
- 能一页做完就不要拆页。需要"关于/定价/详情"这类独立地址时，页面放在 pages/ 下：pages/about.html、pages/pricing.html；入口永远是根目录的 index.html。
- 页面之间用相对路径互链：根页面写 <a href="pages/about.html">关于</a>，pages/ 里的页面写 <a href="../index.html">返回</a>。
- 每个页面必须是**完整 HTML 文档**（含 <html> / <head> / <body>），不要只给一段 <section>。
- 多页可以共用同一份 styles.css；脚本建议每页一个（about.js），也可以共用，平台的预览按页面隔离运行，不会互相干扰。

# 设计令牌契约（决定"实时微调"能不能用，必须遵守）
- 主色必须写成 CSS 变量 --accent，圆角必须写成 --radius，都定义在 :root 上：
  :root { --accent: #4B3BFF; --radius: 14px; }
- 所有用到主色/圆角的地方一律用 var(--accent) / var(--radius)，不要在多处重复写死同一个色值。
- 原因：平台可以在不重新生成代码的前提下实时改这两个变量；你把颜色散写在各个规则里，
  用户的"换个主色"就只会改到一半。
- 同时派生 --accent-soft（主色的浅底，用于 focus 光环与选中态）与 --accent-ink（主色上的文字色，
  深底用 #FFFFFF、亮底用 #14140F）。

# 图标与图片（决定"看起来像产品还是像作业"）
- 需要图标时写 <svg data-icon="plus" width="18" height="18"></svg>，**不要自己画 path**，也不要引 Font Awesome / iconfont 等外部图标库：预览沙箱没有外网，那些链接会变成一排空方块。
- 可用的图标名（写英文小写短横线形式，都是内置的）：plus minus x check check-circle search trash edit save copy download upload share filter menu more
  arrow-left arrow-right arrow-up arrow-down chevron-left chevron-right chevron-down chevron-up home user users settings bell heart star bookmark
  calendar clock chart trending pie tag mail phone map-pin credit-card lock eye eye-off refresh play pause sun moon info alert image file folder list grid cart package message send link globe
- 图标默认继承文字颜色（stroke: currentColor）与字号（1em），所以在按钮里写一次就够，不要给它单独指定 color。
- 需要 logo / 插图时输出 assets/xxx.svg 这种**纯文本 SVG 文件**，页面里用 <img src="assets/logo.svg" alt="..."> 引用；平台会在预览时把它内联成 data URI，导出时仍是独立文件。
- 不要用 emoji 当图标（🔍 ⚙️ ✅ 这类），它们在不同系统上字形差异极大，也是"看起来业余"的第一来源。

# 工程质量底线
- 真实交互：按钮点了要有反应，表单要能提交，状态要真的变化；数据用 localStorage 持久化（键名前缀 nucleus:）。
- 真实内容：中文界面用中文文案，示例数据要像真的（不要 foo/bar/123）。
- 出错要能看见：表单校验失败给出行内提示或 toast，不要静默失败。
- 不写 XSS 漏洞：所有用户输入渲染到 DOM 前必须转义。
- 只用原生 API，不假设任何全局库存在。

${DESIGN_SYSTEM}`

export function firstTurnMessages(prompt: string, design: DesignPrefs): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${designBrief(design)}

需求：${sanitizeUserPrompt(prompt)}

请从零生成这个应用。`,
    },
  ]
}

/**
 * 修复轮：模型有时会"引用了 app.js 却不输出它"、"写到一半字符串没闭合"，
 * 或者干脆把文件截断在中间（小模型 + 输出预算下很常见）。
 *
 * 与其让用户拿到一个"打开就白屏"的应用，不如再问一次，但只补缺的那几个文件：
 *  - 提示词里带上**上一次的失败原因**，模型才知道要重写的到底是哪一段；
 *  - 明确禁止重写已有文件，否则它会把已经做好的部分换个写法覆盖掉，
 *    用户看到的版本历史就变成了一次毫无意义的全文替换。
 */
export function repairMessages(
  prompt: string,
  design: DesignPrefs,
  files: FileEntry[],
  repair: { path: string; reason: string }[],
  plan: Plan | null,
): ChatMessage[] {
  const context = renderFiles(files, prompt)
  const list = repair.map((item) => `- ${item.path}：${item.reason}`).join('\n')
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${designBrief(design)}

原始需求：${sanitizeUserPrompt(prompt)}
${plan ? `应用：${plan.name}（${plan.summary}）` : ''}

已经生成的文件：
${context}

问题：下面这些文件必须重新输出，每一个都要**完整、能直接运行**：
${list}

要求：
1. 只输出上面列出的文件，每个都用 <file path="..."> 包裹，不要重复输出其他文件。
2. 与已有文件的 DOM id / class / 全局变量严格对应，不要自己另起一套。
3. 文件要写到闭合标签为止，不要停在半句；单个文件控制在 400 行以内，宁可精简功能也不要截断。
4. 不要解释，不要代码围栏。`,
    },
  ]
}

export function editTurnMessages(
  prompt: string,
  design: DesignPrefs,
  files: FileEntry[],
  plan: Plan | null,
  /**
   * 项目上下文（<summary> + <history>）。
   *
   * 顺序放在文件清单之前：先知道"我们一路改到了哪"，再看代码，模型才知道
   * 这次该从哪个角度读文件。放在最后会被 24 KB 的代码埋掉，等于没给。
   */
  context = '',
): ChatMessage[] {
  // 上下文也是预算的一部分：它多占一个字，文件就少给一个字
  const budget = Math.max(MAX_CONTEXT_CHARS - context.length, 8_000)
  const contextFiles = renderFiles(files, prompt, budget)
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${designBrief(design)}
${context ? `\n${context}\n` : ''}
当前项目${plan ? `（${plan.name}：${plan.summary}）` : ''}的完整文件如下：
${contextFiles}

用户的新要求：${sanitizeUserPrompt(prompt)}

只输出需要变更的文件；不需要改的文件不要输出。如果要求只涉及样式，就只改 styles.css。`,
    },
  ]
}

/** 上下文体积上限：超出时按文件截断，宁可少给也不能把上下文撑爆。 */
export const MAX_CONTEXT_CHARS = 24000

/** 单个文件被截断时，至少要给这么多内容，否则不如不给。 */
const MIN_TRUNCATE_CHARS = 600

/**
 * 指令 → 文件类型亲和度。
 *
 * 纯词法匹配在中文上很弱（"主色换成墨绿"里的"色"几乎每个 CSS 都命中），
 * 所以先按**语义类别**给文件加权，再叠加词法分。
 * 权重是分路径的：改样式时 CSS 远重于 HTML，改布局时反过来。
 */
const AFFINITY: { pattern: RegExp; paths: { matcher: RegExp; weight: number }[] }[] = [
  {
    pattern: /色|主题|风格|配色|皮肤|dark|light|theme|color|style/i,
    paths: [
      { matcher: /\.css$/i, weight: 8 },
      { matcher: /\.html$/i, weight: 3 },
    ],
  },
  {
    pattern: /布局|结构|页面|元素|排版|界面|layout|page|section/i,
    paths: [
      { matcher: /\.html$/i, weight: 8 },
      { matcher: /\.css$/i, weight: 2 },
    ],
  },
  {
    pattern: /功能|逻辑|交互|按钮|表单|计算|保存|删除|筛选|统计|function|button|form|logic/i,
    paths: [
      { matcher: /\.js$/i, weight: 8 },
      { matcher: /\.html$/i, weight: 3 },
    ],
  },
  {
    pattern: /文案|文字|标题|内容|文本|text|copy|label/i,
    paths: [{ matcher: /\.html$/i, weight: 4 }],
  },
  {
    pattern: /图表|饼图|占比|趋势|chart|graph|percent/i,
    paths: [
      { matcher: /\.js$/i, weight: 5 },
      { matcher: /\.html$/i, weight: 2 },
    ],
  },
]

/** 分词：英文按词，中文按二元组（单字噪声太大）。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z][a-z0-9_-]{1,}/g)) out.push(m[0])
  const cjk = lower.replace(/[^一-龥]+/g, ' ')
  for (const chunk of cjk.split(/\s+/)) {
    if (!chunk) continue
    if (chunk.length === 1) {
      out.push(chunk)
      continue
    }
    for (let i = 0; i + 1 < chunk.length; i++) out.push(chunk.slice(i, i + 2))
  }
  return out
}

/** 文件与当前指令的相关度：语义类别 + 词法命中。 */
export function relevance(file: FileEntry, instruction: string): number {
  const path = file.path.toLowerCase()
  const content = file.content.toLowerCase()
  let score = 0

  // 入口文件永远相关：模型至少要知道页面骨架长什么样
  if (/^(index|main|app)\.html?$/i.test(file.path)) score += 2

  for (const rule of AFFINITY) {
    if (!rule.pattern.test(instruction)) continue
    for (const entry of rule.paths) if (entry.matcher.test(path)) score += entry.weight
  }

  const tokens = tokenize(instruction)
  for (const token of tokens) {
    if (path.includes(token)) score += 4
    else if (token.length > 1 && content.includes(token)) score += 1
  }
  return score
}

export interface ContextFile {
  path: string
  content: string
  truncated: boolean
}

/**
 * 在预算内挑选要发给模型的文件。
 *
 * 与旧策略的关键区别：
 *  1. **不整份丢弃**。旧策略按路径顺序累加，超预算后剩下的文件直接消失 ——
 *     模型会以为那个文件不存在，从而把它整个重建。
 *  2. **按相关度排序**。"主色换成墨绿"应该优先给 styles.css，
 *     而不是碰巧排在最前面的 index.html。
 *  3. **入口文件保底**。即使预算紧张，也保证模型看得到页面骨架。
 */
export function selectContext(files: FileEntry[], instruction: string, budget = MAX_CONTEXT_CHARS): ContextFile[] {
  if (files.length === 0) return []

  const scored = files
    .map((file) => ({ file, score: relevance(file, instruction) }))
    .sort((a, b) => b.score - a.score || a.file.content.length - b.file.content.length)

  const chosen = new Map<string, ContextFile>()
  let used = 0

  for (const { file } of scored) {
    const overhead = file.path.length + 24
    const cost = file.content.length + overhead
    if (used + cost <= budget) {
      chosen.set(file.path, { path: file.path, content: file.content, truncated: false })
      used += cost
      continue
    }
    const remain = budget - used - overhead
    if (remain >= MIN_TRUNCATE_CHARS) {
      chosen.set(file.path, { path: file.path, content: file.content.slice(0, remain), truncated: true })
      used = budget
      break
    }
    // 余额太少，截出来没意义 —— 跳过它，看看后面有没有更小的文件能塞进去
  }

  // 输出保持项目里的原始顺序，方便模型对照
  return files.filter((file) => chosen.has(file.path)).map((file) => chosen.get(file.path)!)
}

/**
 * 把当前文件集合渲染成给模型看的上下文。
 *
 * 包含一个 manifest：列出**所有**文件及其状态（完整 / 已截断 / 未提供），
 * 让模型知道项目里还有什么，而不只是看到"给了什么"。
 */
export function renderFiles(files: FileEntry[], instruction = '', budget = MAX_CONTEXT_CHARS): string {
  if (files.length === 0) return '（当前项目还没有文件）'

  const selected = selectContext(files, instruction, budget)
  const byPath = new Map(selected.map((item) => [item.path, item]))

  const manifest = files
    .map((file) => {
      const item = byPath.get(file.path)
      const size = file.content.length
      if (!item) return `${file.path}（未提供内容：上下文预算已满，${size} 字符）`
      if (item.truncated) return `${file.path}（已截断：只给了前 ${item.content.length} / ${size} 字符）`
      return `${file.path}（完整，${size} 字符）`
    })
    .join('\n')

  const body = selected
    .map((item) => `<file path="${item.path}">\n${item.content}\n</file>`)
    .join('\n')

  return `<manifest>\n${manifest}\n</manifest>\n${body}`
}

/**
 * 用户输入不可信：这里剥掉会破坏协议的定界符，避免"提示词里写 </file>"把上下文撑破。
 */
export function sanitizeUserPrompt(prompt: string): string {
  return prompt
    .replace(/<\/?file[^>]*>/gi, (match) => match.replace(/</g, '＜').replace(/>/g, '＞'))
    .replace(/<\/?plan[^>]*>/gi, (match) => match.replace(/</g, '＜').replace(/>/g, '＞'))
    .replace(/\u0000/g, '')
    .slice(0, 2000)
}
