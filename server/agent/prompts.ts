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
2. 文件数 ≤ 5，单个文件 ≤ 400 行。名字只用 a-z0-9_- 和 / 。
3. 不允许外部依赖；确有必要时只能用 CDN <script src="https://...">，并在页面里做降级。
4. 用户只是在改东西时，只输出发生变化的文件，其余文件不要重复输出；要删文件用 <delete path="xxx"/>。
5. 标签必须闭合。文件内容里如果出现 </file> 字样，请改成 <\\/file>。

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

export function editTurnMessages(
  prompt: string,
  design: DesignPrefs,
  files: FileEntry[],
  plan: Plan | null,
): ChatMessage[] {
  const context = renderFiles(files)
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${designBrief(design)}

当前项目${plan ? `（${plan.name}：${plan.summary}）` : ''}的完整文件如下：
${context}

用户的新要求：${sanitizeUserPrompt(prompt)}

只输出需要变更的文件；不需要改的文件不要输出。如果要求只涉及样式，就只改 styles.css。`,
    },
  ]
}

/** 上下文体积上限：超出时按文件截断，宁可少给也不能把上下文撑爆。 */
export const MAX_CONTEXT_CHARS = 24000

export function renderFiles(files: FileEntry[]): string {
  const parts: string[] = []
  let budget = MAX_CONTEXT_CHARS
  for (const file of files) {
    if (budget <= 0) {
      parts.push(`<file path="${file.path}">（内容过长已省略）</file>`)
      continue
    }
    const content = file.content.length > budget ? file.content.slice(0, budget) + '\n/* …已截断… */' : file.content
    budget -= file.content.length
    parts.push(`<file path="${file.path}">\n${content}\n</file>`)
  }
  return parts.join('\n')
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
