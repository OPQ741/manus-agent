/** 首页 → 工作台之间传递"首轮 prompt"，避免把它塞进 URL。 */

const KEY = 'nucleus.pending'

export function setPendingPrompt(projectId: string, prompt: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ projectId, prompt, at: Date.now() }))
  } catch {
    /* noop */
  }
}

export function takePendingPrompt(projectId: string): string | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { projectId: string; prompt: string; at: number }
    if (parsed.projectId !== projectId) return null
    sessionStorage.removeItem(KEY)
    if (Date.now() - parsed.at > 5 * 60_000) return null
    return parsed.prompt
  } catch {
    return null
  }
}
