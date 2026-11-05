/**
 * Monaco 的装载与定制。
 *
 * 这个模块**只被动态 import**（见 CodeEditor）：Monaco 本体加上语言服务有好几 MB，
 * 挂在首屏路径上会让"打开工作台"多等一截，而大多数人进来是先看预览的。
 *
 * 语言按需挑：HTML / CSS / Markdown 用 Monarch 词法（纯前端，不启 worker 也准）；
 * JS / TS / JSX 走 TypeScript 语言服务 —— 生成物里大量 React JSX，
 * 只有语言服务才分得清 `<div>` 是标签还是小于号；JSON 用它自己的服务，
 * 顺带把配置文件的括号错误标出来。
 *
 * 主题两套，跟界面深浅走：浅色界面配浅色编辑器，深色配深色。
 * token 颜色沿用旧版自研高亮器的那一套（见 styles.css 里已删除的 tok-*），
 * 换编辑器不该让代码"整体换个颜色"。
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js'
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'

export const THEME_DARK = 'nucleus-dark'
export const THEME_LIGHT = 'nucleus-light'

/** Monaco 从全局变量上找 worker 工厂；Vite 把 ?worker 的产物放在同源的 assets 下。 */
;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    if (label === 'json') return new JsonWorker()
    return new EditorWorker()
  },
}

monaco.editor.defineTheme(THEME_DARK, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'e6e4f0' },
    { token: 'comment', foreground: '7f8598', fontStyle: 'italic' },
    { token: 'string', foreground: '9ad9a4' },
    { token: 'number', foreground: 'f0b37e' },
    { token: 'keyword', foreground: 'a4b0ff' },
    { token: 'type', foreground: '7fd4e8' },
    { token: 'type.identifier', foreground: '7fd4e8' },
    { token: 'tag', foreground: '7fd4e8' },
    { token: 'attribute.name', foreground: 'd6b0f7' },
    { token: 'attribute.value', foreground: '9ad9a4' },
    { token: 'metatag', foreground: 'd6b0f7' },
    { token: 'delimiter', foreground: '9a9aae' },
    { token: 'key', foreground: 'a4b0ff' },
  ],
  colors: {
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
    'scrollbarSlider.background': '#ffffff18',
    'scrollbarSlider.hoverBackground': '#ffffff28',
    'scrollbarSlider.activeBackground': '#ffffff34',
  },
})

monaco.editor.defineTheme(THEME_LIGHT, {
  base: 'vs',
  inherit: true,
  rules: [
    { token: '', foreground: '24242c' },
    { token: 'comment', foreground: '8b8b99', fontStyle: 'italic' },
    { token: 'string', foreground: 'a4306a' },
    { token: 'number', foreground: '0b6f8a' },
    { token: 'keyword', foreground: '5a3ff0' },
    { token: 'type', foreground: '0f5590' },
    { token: 'type.identifier', foreground: '0f5590' },
    { token: 'tag', foreground: '0f766e' },
    { token: 'attribute.name', foreground: 'a1550b' },
    { token: 'attribute.value', foreground: 'a4306a' },
    { token: 'metatag', foreground: 'a1550b' },
    { token: 'delimiter', foreground: '6e6e78' },
    { token: 'key', foreground: '5a3ff0' },
  ],
  colors: {
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
    'scrollbarSlider.background': '#14141a14',
    'scrollbarSlider.hoverBackground': '#14141a22',
    'scrollbarSlider.activeBackground': '#14141a2e',
  },
})

/**
 * JS / TS 的语义校验一律关掉。
 *
 * 我们不给沙箱里的生成物装 @types/react，开着语义校验只会让每个 `import React`
 * 下面都挂一条红波浪线 —— 那不是"代码有问题"，是"这里没装依赖"。
 * 语法校验留给它：括号不配对这类错误在编辑器里标出来是有用的。
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
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
}

export function languageOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}

export { monaco }
export type Monaco = typeof monaco
