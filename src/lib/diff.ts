/**
 * 版本差异统计。
 *
 * 只做"给人看的摘要"（每个文件增删多少行），不做完整 patch —— 在 Demo 的
 * 体量下，精确到文件已经足够让人判断"这次改了哪些地方"。
 */

export interface FileDiff {
  path: string
  added: number
  removed: number
  status: 'added' | 'removed' | 'modified' | 'same'
}

function splitLines(text: string): string[] {
  if (!text) return []
  return text.split(/\r\n|\n|\r/)
}

/** 经典 LCS，超过上限时退化为行数差，避免大文件把主线程卡住。 */
export function textDiff(before: string, after: string): { added: number; removed: number } {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length * b.length > 250_000) {
    const delta = b.length - a.length
    return delta >= 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta }
  }

  let previous = new Uint32Array(b.length + 1)
  let current = new Uint32Array(b.length + 1)

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      current[j] = a[i] === b[j] ? previous[j + 1]! + 1 : Math.max(previous[j]!, current[j + 1]!)
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }

  const common = previous[0] ?? 0
  return { added: b.length - common, removed: a.length - common }
}

export function diffFiles(
  before: { path: string; content: string }[],
  after: { path: string; content: string }[],
): FileDiff[] {
  const beforeMap = new Map(before.map((file) => [file.path, file.content]))
  const afterMap = new Map(after.map((file) => [file.path, file.content]))
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort()

  const result: FileDiff[] = []
  for (const path of paths) {
    const old = beforeMap.get(path)
    const next = afterMap.get(path)
    if (old === undefined) {
      result.push({ path, added: splitLines(next ?? '').length, removed: 0, status: 'added' })
      continue
    }
    if (next === undefined) {
      result.push({ path, added: 0, removed: splitLines(old).length, status: 'removed' })
      continue
    }
    if (old === next) continue
    const { added, removed } = textDiff(old, next)
    result.push({ path, added, removed, status: 'modified' })
  }
  return result
}
