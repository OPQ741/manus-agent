import { useEffect, useRef, useState } from 'react'
import { Spin, Typography } from 'antd'
import type { editor as MonacoEditor } from 'monaco-editor'
import { useUiPrefs } from '../lib/ui-prefs'
import type { Monaco } from '../lib/monaco-env'

/**
 * 代码编辑器：Monaco。
 *
 * 以前这里是「透明 textarea 叠在着色 <pre> 上」—— 自己写的高亮器只切词不建语法树，
 * 行号、括号配对、折叠、查找一个都没有，读生成出来的 React 代码很吃力。
 * 换成 Monaco 之后这些都白拿，代价是它要单独一份懒加载 chunk（见 lib/monaco-env.ts），
 * 所以这个组件在「代码」页打开前不产生任何下载。
 *
 * 关键约束：每个文件一个 model（按路径缓存）。撤消栈、光标位置、滚动位置都挂在
 * model 上，切文件回来还能接着改，而不是每次都从第一行重新开始。
 */
interface Props {
  value: string
  path: string
  onChange: (value: string) => void
  /** Ctrl/Cmd + S */
  onSave?: () => void
  readOnly?: boolean
}

type MonacoKit = {
  monaco: Monaco
  languageOf: (path: string) => string
  THEME_DARK: string
  THEME_LIGHT: string
}

/** 全局只加载一次：即使来回切页签，也不会重复下载/重复 defineTheme。 */
let loader: Promise<MonacoKit> | null = null

function loadMonaco(): Promise<MonacoKit> {
  loader ??= import('../lib/monaco-env').catch((error: unknown) => {
    // 加载失败不缓存 rejection：下次进代码页还能再试一次
    loader = null
    throw error
  })
  return loader
}

function ensureModel(kit: MonacoKit, models: Map<string, MonacoEditor.ITextModel>, path: string, value: string) {
  const { monaco } = kit
  const existing = models.get(path)
  if (existing) {
    if (existing.getValue() !== value) existing.setValue(value)
    return existing
  }
  const created = monaco.editor.createModel(value, kit.languageOf(path), monaco.Uri.parse(`inmemory://nucleus/${path}`))
  // 生成物统一两空格缩进：Monaco 默认按语言猜，js/css 会给出 4
  created.updateOptions({ tabSize: 2, insertSpaces: true })
  models.set(path, created)
  return created
}

export function CodeEditor({ value, path, onChange, onSave, readOnly }: Props) {
  const [kit, setKit] = useState<MonacoKit | null>(null)
  const [failed, setFailed] = useState(false)
  const { dark } = useUiPrefs()

  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const modelsRef = useRef(new Map<string, MonacoEditor.ITextModel>())
  /** 回调走 ref：Monaco 的事件订阅只在挂载时建一次，闭包里的旧 props 会写回旧草稿 */
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const wasReadOnly = useRef(Boolean(readOnly))

  useEffect(() => {
    let alive = true
    loadMonaco()
      .then((module) => {
        if (alive) setKit(module)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  // 建编辑器（只在 Monaco 就绪时跑一次；之后的内容/文件切换都走 model）
  useEffect(() => {
    if (!kit || !hostRef.current) return
    const { monaco } = kit
    const model = ensureModel(kit, modelsRef.current, path, value)
    // Monaco 要拿真实字体名做字符宽度测量，`var(--mono)` 这种写法它读不懂
    const monoFont = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace'
    const created = monaco.editor.create(hostRef.current, {
      model,
      theme: dark ? kit.THEME_DARK : kit.THEME_LIGHT,
      fontFamily: monoFont,
      fontSize: 12.5,
      lineHeight: 20,
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      automaticLayout: true,
      padding: { top: 10, bottom: 28 },
      readOnly: Boolean(readOnly),
      domReadOnly: Boolean(readOnly),
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      // 查找框、悬浮提示默认会被容器裁掉一半，fixed 让它们相对视口定位
      fixedOverflowWidgets: true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
      wordWrap: 'off',
      ariaLabel: `编辑 ${path}`,
    })
    editorRef.current = created
    // 主题是全局的：先设一次，之后切深浅由下面的 effect 接管
    monaco.editor.setTheme(dark ? kit.THEME_DARK : kit.THEME_LIGHT)

    const subscription = created.onDidChangeModelContent(() => changeRef.current(created.getValue()))
    created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.())

    return () => {
      subscription.dispose()
      created.dispose()
      // model 是我们自己建的，编辑器销毁不会带走它们 —— 不手动释放就是内存泄漏
      for (const model of modelsRef.current.values()) model.dispose()
      modelsRef.current.clear()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit])

  /**
   * 换文件：换 model，并把滚动位置归零。
   * 必须排在下面那个 [value] 同步之前 —— 否则新文件的内容会先被写进上一个文件的 model。
   */
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !kit) return
    const model = ensureModel(kit, modelsRef.current, path, value)
    if (editor.getModel() !== model) editor.setModel(model)
    editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 })
    // 无障碍标签是建编辑器时定下的，换文件必须跟着换，否则读屏软件一直念上一个文件名
    editor.updateOptions({ ariaLabel: `编辑 ${path}` })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit, path])

  // 外部改动（保存后回读、回滚、生成过程中流入）同步进 model；用户自己打字时两边已相等
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    if (model.getValue() !== value) model.setValue(value)
  }, [value])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.updateOptions({ readOnly: Boolean(readOnly), domReadOnly: Boolean(readOnly) })
    // 只读 → 可编辑的那一下才抢焦点；首次挂载时抢焦点会把页面的滚动位置带跑
    if (wasReadOnly.current && !readOnly) editor.focus()
    wasReadOnly.current = Boolean(readOnly)
  }, [readOnly])

  useEffect(() => {
    if (!kit) return
    kit.monaco.editor.setTheme(dark ? kit.THEME_DARK : kit.THEME_LIGHT)
  }, [kit, dark])

  if (failed) {
    // 兜底：Monaco 没起来（离线/产物缺失）时至少还能读代码
    return (
      <div className="code-view">
        <pre>
          <code>{value}</code>
        </pre>
      </div>
    )
  }

  return (
    <div className="code-edit">
      <div className="code-monaco" ref={hostRef} />
      {kit ? null : (
        <div className="code-loading">
          <Spin size="small" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            正在加载编辑器…
          </Typography.Text>
        </div>
      )}
    </div>
  )
}
