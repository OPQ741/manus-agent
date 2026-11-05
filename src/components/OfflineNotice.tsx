/**
 * 断网提示条。
 *
 * 为什么值得一个独立组件：断网时页面看起来"什么都没发生"是最难受的状态 ——
 * 点发送没反应、点停止没反应、刷新也转圈。一条常驻的说明至少能回答
 * "是我哪里点错了吗"，答案是没有。
 *
 * 用 fixed 而不是插进布局：任何页面（首页 / 工作台 / 分享页）都需要它，
 * 而插进各自的流式布局会让每个页面都多一处要维护的条件渲染。
 */

import { DisconnectOutlined } from '@ant-design/icons'
import { useOnline } from '../lib/online'

export function OfflineNotice() {
  const online = useOnline()
  if (online) return null

  return (
    <div className="offline-bar" role="status" aria-live="polite">
      <DisconnectOutlined />
      <span>网络已断开：已生成的内容不会丢，恢复连接后可以继续。</span>
    </div>
  )
}
