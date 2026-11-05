/**
 * 分栏宽度偏好。
 *
 * 和 ui-prefs 一样属于「每台浏览器自己的事」：宽度是屏幕尺寸的函数，
 * 不该跟着项目走，也不该写进服务端设置。
 */

const KEY = 'nucleus.studio.chatWidth'

export const CHAT_MIN = 300
export const CHAT_MAX = 720
export const CHAT_DEFAULT = 380

export function readChatWidth(): number {
  try {
    const raw = Number(localStorage.getItem(KEY))
    if (!Number.isFinite(raw) || raw <= 0) return CHAT_DEFAULT
    return Math.min(Math.max(Math.round(raw), CHAT_MIN), CHAT_MAX)
  } catch {
    return CHAT_DEFAULT
  }
}

export function writeChatWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(Math.round(width)))
  } catch {
    /* 隐私模式下写不进去：本次会话内仍然生效 */
  }
}
