/**
 * 渲染兜底：React 树里任何一个组件抛错，默认行为是**整棵树卸载** ——
 * 用户看到的就是一片白屏，而且连"刷新一下试试"都不知道该不该试。
 *
 * 这里做两件事：
 *  1. 把崩溃限制在出问题的那一块（scope='panel'），对话和输入框继续可用；
 *  2. 给一条能自证的出路：重试（重新挂载子树）、回首页、整页刷新，
 *     外加可展开的技术细节 —— 出问题时最怕的不是崩，是崩了之后什么都拿不到。
 *
 * 注意 ErrorBoundary **接不住**异步错误（Promise 里 reject、事件回调里 throw），
 * 那些要靠各处的 try/catch 与全局 unhandledrejection 处理。这里只是最后一道网。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button, Result, Space, Typography } from 'antd'

interface Props {
  children: ReactNode
  /** 崩的是哪一块：只影响文案（"工作区渲染出错了"） */
  label?: string
  /**
   * page = 整页兜底（Result 版式）；
   * panel = 局部兜底（一张安静的卡片，不抢整屏）。
   */
  scope?: 'page' | 'panel'
}

interface State {
  error: Error | null
  stack: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 控制台留全量，界面上只放前 600 字：够定位，又不会把一屏塞满调用栈
    console.error('[nucleus] 渲染出错', error, info.componentStack)
    this.setState({ stack: info.componentStack ?? '' })
  }

  private reset = () => this.setState({ error: null, stack: '' })

  private detail() {
    const { error, stack } = this.state
    return (
      <details className="boundary-detail">
        <summary>技术细节</summary>
        <pre className="mono">{`${error?.message ?? '未知错误'}\n${stack.slice(0, 600)}`}</pre>
      </details>
    )
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.scope === 'panel') {
      return (
        <div className="boundary-panel" role="alert">
          <Typography.Text strong>{this.props.label ?? '这一块'}渲染出错了</Typography.Text>
          <Typography.Paragraph type="secondary" className="boundary-hint">
            项目和对话都还在。先把这一块重新挂一次，通常就好了。
          </Typography.Paragraph>
          <Space size={6}>
            <Button size="small" type="primary" onClick={this.reset}>
              重试
            </Button>
            <Button size="small" onClick={() => window.location.reload()}>
              整页刷新
            </Button>
          </Space>
          {this.detail()}
        </div>
      )
    }

    return (
      <Result
        status="error"
        title="界面崩了，但你的项目还在"
        subTitle={`${error.message || '渲染时抛了一个未捕获的错误'}。点「重试」重新挂载这一页；反复崩的话，回首页再进一次。`}
        extra={
          <Space wrap size={8}>
            <Button type="primary" onClick={this.reset}>
              重试
            </Button>
            <Button href="#/">回到首页</Button>
            <Button onClick={() => window.location.reload()}>整页刷新</Button>
          </Space>
        }
      >
        {this.detail()}
      </Result>
    )
  }
}
