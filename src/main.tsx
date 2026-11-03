import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import { antdTheme } from './theme'
import 'antd/dist/reset.css'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 挂载点')

/**
 * ConfigProvider 提供主题令牌与中文文案；antd 的 App 提供 message/modal
 * 的上下文（toast 走它，才能吃到同一套主题，而不是另起一套静态实例）。
 */
createRoot(container).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  </StrictMode>,
)
