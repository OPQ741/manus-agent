/**
 * 在线/离线感知。
 *
 * 浏览器自带 `navigator.onLine` 与 online/offline 事件，但它们只说"网卡有没有连着"，
 * 不代表服务端可达（连着 WiFi 但网关挂了照样是离线）。所以这里的用途很克制：
 * **只用来提前拦住"发出去必然失败"的动作**，以及在断网时给出解释 ——
 * 真正的可达性仍以请求结果为准（fetch 失败会走错误条那条路）。
 */

import { useEffect, useState } from 'react'

function initial(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(initial)

  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    // 挂载时对齐一次：从后台切回来时 state 可能已经过期
    setOnline(initial())
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  return online
}
