import { useCallback, useEffect, useRef, useState } from 'react'
import { CHAT_DEFAULT, CHAT_MAX, CHAT_MIN } from '../lib/pane-width'

/**
 * 左右分栏的拖拽分隔条。
 *
 * 为什么不用 antd 的 Splitter / 自绘 grid 拖拽：
 *  - 布局本身是 CSS grid（`.studio`），改一列宽度只需要动一个自定义属性，
 *    不必把整棵子树搬进一个受控容器组件里；
 *  - 用 pointer capture 而不是 window 的 mousemove：拖到 iframe 上方时，
 *    指针事件会被预览文档吃掉，只有捕获在分隔条自己身上才不会「拖着拖着断开」。
 *
 * 三个入口都要有：鼠标拖、键盘方向键、双击复位 —— 只用鼠标的话，
 * 键盘用户永远卡在默认宽度上。
 */

/** 右侧工作区的最小宽度：再窄就没法看预览了，宁可让左侧停在最小值 */
const WORKSPACE_MIN = 420

interface Props {
  width: number
  /** 拖动过程中连续触发（只改视觉，不落盘） */
  onResize: (width: number) => void
  /** 松手 / 键盘调整结束时触发（这里才写 localStorage） */
  onCommit: (width: number) => void
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

export function Splitter({ width, onResize, onCommit }: Props) {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startX: number; startWidth: number; max: number } | null>(null)
  const latest = useRef(width)
  latest.current = width

  /** 容器能给的宽度上限：窗口越小，可用拖拽空间越小 */
  const maxFor = (element: HTMLElement): number => {
    const container = element.parentElement
    if (!container) return CHAT_MAX
    return Math.min(CHAT_MAX, container.clientWidth - WORKSPACE_MIN)
  }

  const end = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    onCommit(latest.current)
  }, [onCommit])

  // 拖拽中锁住光标与选区：否则越过文字时会选中对话内容，看起来像界面卡住了
  useEffect(() => {
    if (!dragging) return
    const { body } = document
    const previous = body.style.cssText
    body.style.cursor = 'col-resize'
    body.style.userSelect = 'none'
    return () => {
      body.style.cssText = previous
    }
  }, [dragging])

  return (
    <div
      className={`splitter${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整对话区宽度"
      aria-valuenow={Math.round(width)}
      aria-valuemin={CHAT_MIN}
      aria-valuemax={CHAT_MAX}
      tabIndex={0}
      onPointerDown={(event) => {
        // 只认主键：右键/中键按住拖动在浏览器里另有含义
        if (event.button !== 0) return
        event.preventDefault()
        const element = event.currentTarget
        element.setPointerCapture(event.pointerId)
        dragRef.current = { startX: event.clientX, startWidth: width, max: maxFor(element) }
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag) return
        const next = clamp(drag.startWidth + (event.clientX - drag.startX), CHAT_MIN, drag.max)
        if (next !== latest.current) onResize(next)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        onResize(CHAT_DEFAULT)
        onCommit(CHAT_DEFAULT)
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16
        const max = maxFor(event.currentTarget)
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          const next = clamp(width + (event.key === 'ArrowLeft' ? -step : step), CHAT_MIN, max)
          onResize(next)
          onCommit(next)
        } else if (event.key === 'Home') {
          event.preventDefault()
          onResize(CHAT_DEFAULT)
          onCommit(CHAT_DEFAULT)
        }
      }}
      title="拖动调整宽度（双击复位）"
    >
      <span className="splitter-grip" aria-hidden="true" />
    </div>
  )
}
