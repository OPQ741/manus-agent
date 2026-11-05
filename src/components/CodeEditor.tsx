import { useCallback, useLayoutEffect, useRef } from 'react'
import { highlight, langOf } from '../lib/highlight'

/**
 * 可编辑的代码视图。
 *
 * 为什么用「透明 textarea 叠在着色 <pre> 上」而不是引入 Monaco / CodeMirror：
 *  - 这个工坊的依赖只有 antd，编辑器只用来改几行生成出来的代码，
 *    Monaco 一上来就是 2 MB + worker 配置，换来的是用户根本用不上的智能提示；
 *  - 高亮器已经有一份（src/lib/highlight.ts，先切词再转义，不存在 XSS 风险），
 *    叠层能直接复用它，输入时逐字符重算也不卡。
 *
 * 关键约束：两层必须共用**同一套**字体、行高、内边距与 tab 宽度，否则光标会和
 * 着色文字错位（用户第一眼就会觉得"这编辑器坏了"）。这些量写在 styles.css 的
 * `.code-edit-layer` 里，只允许有一处定义。
 */
interface Props {
  value: string
  path: string
  onChange: (value: string) => void
  /** Ctrl/Cmd + S */
  onSave?: () => void
  readOnly?: boolean
}

export function CodeEditor({ value, path, onChange, onSave, readOnly }: Props) {
  const viewRef = useRef<HTMLPreElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  /** 滚同步：只有 textarea 真正滚动，pre 跟着走（它自己是看不见滚动条的）。 */
  const syncScroll = useCallback(() => {
    const area = areaRef.current
    const view = viewRef.current
    if (!area || !view) return
    view.scrollTop = area.scrollTop
    view.scrollLeft = area.scrollLeft
  }, [])

  // 切文件时把两层的滚动位置都归零，否则新文件会从上一份的中间开始显示
  useLayoutEffect(() => {
    const area = areaRef.current
    const view = viewRef.current
    if (!area || !view) return
    area.scrollTop = 0
    area.scrollLeft = 0
    view.scrollTop = 0
    view.scrollLeft = 0
  }, [path])

  return (
    <div className="code-edit">
      {/* 着色层只负责好看：aria-hidden 让读屏软件直接读 textarea */}
      <pre className="code-edit-layer code-edit-view" ref={viewRef} aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: highlight(value.endsWith('\n') ? value : `${value}\n`, langOf(path)) }} />
      </pre>
      <textarea
        ref={areaRef}
        className="code-edit-layer code-edit-input"
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        wrap="off"
        readOnly={readOnly}
        aria-label={`编辑 ${path}`}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            onSave?.()
            return
          }
          // Tab 必须打进内容里：代码面板里按 Tab 跳焦点是最让人恼火的一件事。
          // 用 setRangeText 而不是「拼接字符串 + 改 selection」——后者会把撤销栈清空。
          if (event.key === 'Tab' && !readOnly) {
            event.preventDefault()
            const area = event.currentTarget
            area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end')
            onChange(area.value)
          }
        }}
      />
    </div>
  )
}
