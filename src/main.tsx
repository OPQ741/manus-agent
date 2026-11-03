import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'antd/dist/reset.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点')

/**
 * 主题在 App 内部装配（ConfigProvider 由 App 提供）：
 * 设置页换主色 / 切深色要当场重算令牌，所以主题不能在这里写死。
 * antd 的 App 上下文（message/modal）也随之下沉，toast 才能吃到同一套主题。
 */
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
