/**
 * 每个项目自己的"用哪个模型"。
 *
 * 放在 localStorage 而不是服务端 settings：这是一次次生成时的临时选择，
 * 不该把 A 项目试出来的模型名带到 B 项目上（那正是"设置页改全局"的痛点）。
 * 服务端的持久字段只有一个 —— project.providerModel，用来回答"上一版是谁写的"。
 */
export interface ModelChoice {
  provider: string
  model: string
}

const keyOf = (projectId: string) => `nucleus.model.${projectId}`

export function readModelChoice(projectId: string): ModelChoice | null {
  try {
    const raw = localStorage.getItem(keyOf(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ModelChoice>
    if (!parsed || typeof parsed.provider !== 'string' || !parsed.provider) return null
    return { provider: parsed.provider, model: typeof parsed.model === 'string' ? parsed.model : '' }
  } catch {
    return null
  }
}

export function writeModelChoice(projectId: string, choice: ModelChoice | null): void {
  try {
    if (!choice) localStorage.removeItem(keyOf(projectId))
    else localStorage.setItem(keyOf(projectId), JSON.stringify(choice))
  } catch {
    /* 隐私模式下写不了 localStorage：选择只在本次会话有效，不阻断生成 */
  }
}
