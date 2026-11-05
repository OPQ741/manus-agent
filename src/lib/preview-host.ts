/**
 * 预览宿主侧的小工具：把沙箱里"需要宿主代做"的动作集中处理。
 *
 * 沙箱去掉 allow-popups 之后，生成物里的 `window.open`、`target=_blank`、
 * 外链点击全部会静默失效（点了没反应，控制台也没提示）。桥接把这几种动作上报成
 * `{ kind: 'open', url }`，由这里统一决定"开不开、怎么开"。
 *
 * 校验放在宿主侧：URL 来自不可信文档，只有 http(s) 才允许交给浏览器。
 * `javascript:` / `data:text/html` 这类伪协议一旦放行，等于把沙箱自己拆了。
 */
export function openExternal(url: unknown): boolean {
  if (typeof url !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(url, window.location.href)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const win = window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
  // 被浏览器拦截时 win 为 null：不抛错，界面上也不会因此中断
  return Boolean(win)
}

/** 桥接约定：所有消息都带 `__nucleus: 1`，避免和第三方库的消息混在一起。 */
export function isBridgeMessage(data: unknown): data is { __nucleus: number; kind?: string; [key: string]: unknown } {
  return Boolean(data && typeof data === 'object' && (data as { __nucleus?: number }).__nucleus === 1)
}

/**
 * 心跳判活。
 *
 * 为什么不用 `iframe.onerror` 或超时：死循环不产生任何事件，页面就是"安静地不响应"。
 * 唯一能观察到的信号是"它不再回消息了"，所以按固定节奏 ping，数秒没 pong 就算卡住。
 *
 * 返回一个 stop 函数。`onChange(stalled)` 只在状态翻转时被调用，
 * 避免每秒都触发一次 React 更新。
 */
export function watchFrame(
  frame: HTMLIFrameElement,
  onChange: (stalled: boolean) => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 3000
  let lastPong = Date.now()
  let stalled = false
  let seq = 0

  const onMessage = (event: MessageEvent) => {
    if (event.data && event.data.__nucleus === 1 && event.data.kind === 'pong') lastPong = Date.now()
  }
  window.addEventListener('message', onMessage)

  const timer = window.setInterval(() => {
    const win = frame.contentWindow
    if (!win) return
    try {
      win.postMessage({ __nucleus_ping: ++seq }, '*')
    } catch {
      return
    }
    const next = Date.now() - lastPong > timeoutMs
    if (next !== stalled) {
      stalled = next
      onChange(next)
    }
  }, intervalMs)

  return () => {
    window.clearInterval(timer)
    window.removeEventListener('message', onMessage)
  }
}
