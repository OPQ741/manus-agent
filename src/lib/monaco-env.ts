/**
 * Monaco 的装载与定制。
 *
 * 这个模块**只被动态 import**（见 CodeEditor）：Monaco 本体加上语法有好几 MB，
 * 挂在首屏路径上会让"打开工作台"多等一截，而大多数人进来是先看预览的。
 *
 * 词法用 Shiki（VS Code 同款 TextMate 语法），不用 Monaco 自带的 Monarch：
 * Monarch 的 JS/TS 语法**不解析 JSX** —— `<main className="x">` 里的标签名会被当成
 * 普通标识符，整行只有关键字和字符串有颜色，React 代码看着像没高亮。
 * Shiki 的 javascript/jsx/typescript/tsx 语法和 VS Code 是同一份，标签、属性名、
 * 内嵌表达式都能正确分色。编辑器本身仍是 Monaco（行号 / 括号配对 / 查找 / 多光标）。
 *
 * 注意一个顺序约束：shikiToMonaco 只给**已经注册在 Monaco 里**的语言挂 tokenizer
 * （它自己不会注册语言），所以下面必须先把 basic-languages 的 contribution 引进来。
 */

/**
 * `typescript` / `javascript` 这两个 contribution 提供的不只是语法：
 * 没有它们，model 的 languageId 虽然叫 `javascript`、`monaco.languages.getLanguages()`
 * 里却没有这个语言，编辑器连"该用哪个 tokenizer"都无从谈起。
 */
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js'
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js'

import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { shikiToMonaco } from '@shikijs/monaco'
import langCss from '@shikijs/langs/css'
import langHtml from '@shikijs/langs/html'
import langJs from '@shikijs/langs/javascript'
import langJson from '@shikijs/langs/json'
import langJsx from '@shikijs/langs/jsx'
import langMarkdown from '@shikijs/langs/markdown'
import langTs from '@shikijs/langs/typescript'
import langTsx from '@shikijs/langs/tsx'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'

export const THEME_DARK = 'nucleus-dark'
export const THEME_LIGHT = 'nucleus-light'

/**
 * Monaco 的 fontFamily 只认具体字体名：
 * - 写 `var(--mono)` 它读不懂，会退回默认字体（Windows 上就是 Courier 味的打字机）；
 * - `ui-monospace` 在 Chromium/Windows 上同样落不到 Consolas。
 * 所以这里给一条实体字体栈，和 --mono 保持同样的偏好顺序。
 */
export const MONO_STACK = 'Consolas, "Cascadia Mono", "SF Mono", Menlo, "JetBrains Mono", monospace'

/** Monaco 从全局变量上找 worker 工厂；Vite 把 ?worker 的产物放在同源的 assets 下。 */
;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    if (label === 'json') return new JsonWorker()
    return new EditorWorker()
  },
}

/* ------------------------------------------------------------------ *
 * 主题：一套浅色、一套深色，配色沿用改版前的那一套（换编辑器不该让代码整体换色）
 * ------------------------------------------------------------------ */

type TokenRule = { scope?: string[] | string; color: string; italic?: boolean }

const LIGHT_COLORS = {
  'editor.background': '#ffffff',
  'editor.foreground': '#24242c',
  'editorLineNumber.foreground': '#b0b0ba',
  'editorLineNumber.activeForeground': '#4b3bff',
  'editor.lineHighlightBackground': '#f7f6fb',
  'editor.selectionBackground': '#d9d3ff',
  'editor.inactiveSelectionBackground': '#ece8ff',
  'editorCursor.foreground': '#4b3bff',
  'editorIndentGuide.background1': '#eceae4',
  'editorIndentGuide.activeBackground1': '#d8d5cd',
  'editorGutter.background': '#ffffff',
  'editorWidget.background': '#ffffff',
  'editorWidget.border': '#e8e6e1',
  'editorSuggestWidget.background': '#ffffff',
  'editorSuggestWidget.selectedBackground': '#f2f0ec',
  'editorHoverWidget.background': '#ffffff',
  'editorHoverWidget.border': '#e8e6e1',
  'editorBracketMatch.background': '#eeebff',
  'editorBracketMatch.border': '#bdb4ff',
  // 括号对着色（Monaco 默认给的是 #0431FA 这种高饱和蓝，跟这套配色打架）
  'editorBracketHighlight.foreground1': '#6e6e78',
  'editorBracketHighlight.foreground2': '#8a7fd0',
  'editorBracketHighlight.foreground3': '#a1550b',
  'scrollbarSlider.background': '#14141a14',
  'scrollbarSlider.hoverBackground': '#14141a22',
  'scrollbarSlider.activeBackground': '#14141a2e',
} as const

const DARK_COLORS = {
  'editor.background': '#14141b',
  'editor.foreground': '#e6e4f0',
  'editorLineNumber.foreground': '#4c4c5c',
  'editorLineNumber.activeForeground': '#b8b4ff',
  'editor.lineHighlightBackground': '#1c1c25',
  'editor.selectionBackground': '#3d3a6e',
  'editor.inactiveSelectionBackground': '#2c2a4a',
  'editorCursor.foreground': '#a4b0ff',
  'editorIndentGuide.background1': '#26262f',
  'editorIndentGuide.activeBackground1': '#3d3d4a',
  'editorGutter.background': '#14141b',
  'editorWidget.background': '#1a1a21',
  'editorWidget.border': '#33333e',
  'editorSuggestWidget.background': '#1a1a21',
  'editorSuggestWidget.selectedBackground': '#2b2b3a',
  'editorHoverWidget.background': '#1a1a21',
  'editorHoverWidget.border': '#33333e',
  'editorBracketMatch.background': '#2b2b45',
  'editorBracketMatch.border': '#5a5a86',
  'editorBracketHighlight.foreground1': '#9a9aae',
  'editorBracketHighlight.foreground2': '#a4b0ff',
  'editorBracketHighlight.foreground3': '#d6b0f7',
  'scrollbarSlider.background': '#ffffff18',
  'scrollbarSlider.hoverBackground': '#ffffff28',
  'scrollbarSlider.activeBackground': '#ffffff34',
} as const

/**
 * 作用域 → 颜色。
 * 用的是 TextMate 的作用域名，所以同一套规则对 js / jsx / ts / tsx / html / css 都成立：
 * 比如 `entity.name.tag` 在 JSX 里是 `<main>`、在 HTML 里是 `<body>`，颜色自然一致。
 */
const TOKENS_LIGHT: TokenRule[] = [
  { scope: ['comment', 'punctuation.definition.comment'], color: '#8b8b99', italic: true },
  { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], color: '#a4306a' },
  { scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'], color: '#0b6f8a' },
  { scope: ['keyword', 'keyword.control', 'storage.type', 'storage.modifier'], color: '#5a3ff0' },
  { scope: ['entity.name.function', 'support.function', 'meta.function-call'], color: '#0f5590' },
  { scope: ['entity.name.type', 'entity.name.class', 'support.class', 'support.type'], color: '#0f5590' },
  // JSX 里的组件名（<Header />）：VS Code 把它归为 support.class.component
  { scope: ['entity.name.tag', 'support.class.component'], color: '#0f766e' },
  { scope: ['entity.other.attribute-name'], color: '#a1550b' },
  // CSS：属性名（color / margin）和自定义属性（--accent）是两套作用域，都要点名
  { scope: ['support.type.property-name'], color: '#0f5590' },
  { scope: ['variable.css', 'variable.other.custom-property', 'variable.other.object'], color: '#a1550b' },
  { scope: ['meta.object-literal.key', 'variable.other.property', 'variable.other.object.property'], color: '#0f5590' },
  { scope: ['punctuation', 'meta.brace', 'keyword.operator'], color: '#6e6e78' },
  { scope: 'invalid', color: '#c62828' },
]

const TOKENS_DARK: TokenRule[] = [
  { scope: ['comment', 'punctuation.definition.comment'], color: '#7f8598', italic: true },
  { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string'], color: '#9ad9a4' },
  { scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'], color: '#f0b37e' },
  { scope: ['keyword', 'keyword.control', 'storage.type', 'storage.modifier'], color: '#a4b0ff' },
  { scope: ['entity.name.function', 'support.function', 'meta.function-call'], color: '#8fd0ff' },
  { scope: ['entity.name.type', 'entity.name.class', 'support.class', 'support.type'], color: '#7fd4e8' },
  { scope: ['entity.name.tag', 'support.class.component'], color: '#7fd4e8' },
  { scope: ['entity.other.attribute-name'], color: '#d6b0f7' },
  { scope: ['support.type.property-name'], color: '#7fd4e8' },
  { scope: ['variable.css', 'variable.other.custom-property', 'variable.other.object'], color: '#d6b0f7' },
  { scope: ['meta.object-literal.key', 'variable.other.property', 'variable.other.object.property'], color: '#8fd0ff' },
  { scope: ['punctuation', 'meta.brace', 'keyword.operator'], color: '#9a9aae' },
  { scope: 'invalid', color: '#ff6b6b' },
]

function toTheme(
  name: string,
  type: 'light' | 'dark',
  colors: Record<string, string>,
  tokens: TokenRule[],
  foreground: string,
) {
  return {
    name,
    type,
    colors,
    // 没有 scope 的这条是全局默认前景色：TextMate 主题里它对应 editor.foreground
    tokenColors: [
      { settings: { foreground } },
      ...tokens.map((rule) => ({
        scope: rule.scope,
        settings: { foreground: rule.color, ...(rule.italic ? { fontStyle: 'italic' } : {}) },
      })),
    ],
  }
}

/* ------------------------------------------------------------------ *
 * JS / TS 的语义校验一律关掉
 * ------------------------------------------------------------------ *
 * 我们不给沙箱里的生成物装 @types/react，开着语义校验只会让每个 `import React`
 * 下面都挂一条红波浪线 —— 那不是"代码有问题"，是"这里没装依赖"。
 */

const diagnostics = { noSemanticValidation: true, noSyntaxValidation: false } as const
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ ...diagnostics })
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ ...diagnostics })

const compilerOptions = {
  target: monaco.languages.typescript.ScriptTarget.ES2020,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  jsx: monaco.languages.typescript.JsxEmit.React,
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
  isolatedModules: true,
} as const
monaco.languages.typescript.javascriptDefaults.setCompilerOptions({ ...compilerOptions })
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({ ...compilerOptions })

/* ------------------------------------------------------------------ *
 * 语言 id
 * ------------------------------------------------------------------ */

/**
 * JSX / TSX 在 Monaco 里没有现成的语言 id（VS Code 用的是 javascriptreact / typescriptreact）。
 * 这里自己注册两个空壳，Shiki 会把 TextMate 语法挂上去 —— 语法本身才是我们想要的东西，
 * 不需要 Monaco 提供别的能力。
 */
monaco.languages.register({ id: 'jsx', extensions: ['.jsx'], aliases: ['JavaScript React', 'jsx'] })
monaco.languages.register({ id: 'tsx', extensions: ['.tsx'], aliases: ['TypeScript React', 'tsx'] })

/** 扩展名 → Monaco 语言 id。认不出来的当纯文本，不硬塞一个错误的语法。 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
}

export function languageOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

/* ------------------------------------------------------------------ *
 * Shiki 接入
 * ------------------------------------------------------------------ */

/**
 * 先按老配方定义两套 Monaco 主题：Shiki 装载失败时（离线 / 正则引擎不支持某条规则）
 * 编辑器至少还有正常的底色和 Monaco 自带的高亮，不会变成一张白纸。
 */
monaco.editor.defineTheme(THEME_LIGHT, {
  base: 'vs',
  inherit: true,
  rules: [{ token: '', foreground: '24242c' }],
  colors: { ...LIGHT_COLORS },
})
monaco.editor.defineTheme(THEME_DARK, {
  base: 'vs-dark',
  inherit: true,
  rules: [{ token: '', foreground: 'e6e4f0' }],
  colors: { ...DARK_COLORS },
})

async function initShiki() {
  const highlighter = await createHighlighterCore({
    // JS 正则引擎，不走 Oniguruma 的 wasm：少一份 ~600KB 的二进制，
    // 这几个语法的规则它都吃得下（forgiving 让不支持的断言降级而不是整段抛错）
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    themes: [
      toTheme(THEME_LIGHT, 'light', { ...LIGHT_COLORS }, TOKENS_LIGHT, '#24242c'),
      toTheme(THEME_DARK, 'dark', { ...DARK_COLORS }, TOKENS_DARK, '#e6e4f0'),
    ],
    langs: [langJs, langJsx, langTs, langTsx, langHtml, langCss, langJson, langMarkdown],
  })
  // 只覆盖已在 Monaco 注册的 id（jsx / tsx 是上面手动注册的）
  shikiToMonaco(highlighter, monaco)
}

/** Shiki 就绪。失败也不 reject：退化成 Monaco 自带主题，代码照样能读能改。 */
export const ready: Promise<void> = initShiki().catch((error: unknown) => {
  console.warn('[monaco] Shiki 语法装载失败，退回 Monaco 内置高亮', error)
})

export { monaco }
export type Monaco = typeof monaco
