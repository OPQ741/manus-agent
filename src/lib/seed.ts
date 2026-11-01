/**
 * 生成物在预览沙箱里是"不透明源"，原生 localStorage 会抛 SecurityError。
 * 桥接脚本在内层做了内存 shim，并把写入通过 postMessage 交给这里落盘，
 * 于是"刷新预览数据还在"这件事，在沙箱里也是成立的。
 */

const PREFIX = 'nucleus.seed.'

export type SeedMap = Record<string, string>

function storageKey(projectId: string): string {
  return PREFIX + projectId
}

export function readSeed(projectId: string): SeedMap {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SeedMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSeed(projectId: string, seed: SeedMap): void {
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(seed))
  } catch {
    /* 存储满/隐私模式：忽略，页面仍可用 */
  }
}

export function applyStorageMessage(
  projectId: string,
  payload: { op: 'set' | 'remove' | 'clear'; key?: string; value?: string },
): void {
  const seed = readSeed(projectId)
  if (payload.op === 'set' && payload.key) seed[payload.key] = payload.value ?? ''
  else if (payload.op === 'remove' && payload.key) delete seed[payload.key]
  else if (payload.op === 'clear') {
    for (const key of Object.keys(seed)) delete seed[key]
  }
  writeSeed(projectId, seed)
}

export function clearSeed(projectId: string): void {
  try {
    localStorage.removeItem(storageKey(projectId))
  } catch {
    /* noop */
  }
}

/** 把种子写进 HTML 的 <head> 之后，保证早于桥接脚本与业务脚本执行。 */
export function injectSeed(html: string, seed: SeedMap): string {
  if (!seed || Object.keys(seed).length === 0) return html
  const json = JSON.stringify(seed).replace(/<\//g, '<\\/')
  const script = `<script data-nucleus="seed">window.__NUCLEUS_SEED=${json};</script>`
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + script + html.slice(at)
  }
  return script + html
}
