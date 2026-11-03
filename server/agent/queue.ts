/**
 * 提供方配额闸门（per-provider rate gate）。
 *
 * 为什么需要它：免 Key 通道（Pollinations 匿名档）实测是**同一 IP 每 30 秒 1 次请求**，
 * 而线上服务端只有一个出口 IP —— 等于全站访客共享这一条配额。
 * 不做闸门的话，第二个人点"生成"直接吃 429，看起来像"这系统坏了"。
 *
 * 闸门做的事：把并发请求排成 FIFO，每个提供方按自己的 minIntervalMs 放行；
 * 等得太久（超过 maxWaitMs）就不排了，抛 QueueFull 让编排层换下一家。
 *
 * 单进程内存态足够：本项目的持久化层也是单文件 JSON（同一约束，见 docs/03 §2）。
 */

export class QueueFullError extends Error {
  readonly providerId: string
  readonly projectedWaitMs: number

  constructor(providerId: string, projectedWaitMs: number) {
    super(`提供方「${providerId}」排队预计需要 ${Math.round(projectedWaitMs / 1000)} 秒，已改走其他通道`)
    this.name = 'QueueFullError'
    this.providerId = providerId
    this.projectedWaitMs = projectedWaitMs
  }
}

interface GateState {
  /** 下一个请求被放行的时刻 */
  nextAt: number
}

const gates = new Map<string, GateState>()

/** 仅供测试：清空排队状态 */
export function resetGates(): void {
  gates.clear()
}

/** 当前排到什么时候（不占用槽位），给 UI 显示"前面还有几个人"用。 */
export function projectedWait(providerId: string, minIntervalMs: number): number {
  if (minIntervalMs <= 0) return 0
  const state = gates.get(providerId)
  if (!state) return 0
  return Math.max(0, state.nextAt - Date.now())
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface SlotOptions {
  minIntervalMs: number
  /** 最多愿意等多久；超过就不占槽，直接 QueueFull */
  maxWaitMs?: number
  signal?: AbortSignal
}

/**
 * 取一个发送槽。
 *
 * 「判断等待时长」与「推进 nextAt」必须在同一个同步块里完成 ——
 * Node 单线程，只要中间不 await 就不会有两个请求抢到同一个槽。
 *
 * @returns 实际等待的毫秒数（0 表示没排队）
 */
export async function waitForSlot(providerId: string, options: SlotOptions): Promise<number> {
  const { minIntervalMs, maxWaitMs = Number.POSITIVE_INFINITY, signal } = options
  if (minIntervalMs <= 0) return 0

  const now = Date.now()
  const state = gates.get(providerId) ?? { nextAt: 0 }
  const startAt = Math.max(now, state.nextAt)
  const wait = startAt - now

  if (wait > maxWaitMs) {
    // 不推进 nextAt：这次没排上，也不该把后面的人往后推
    throw new QueueFullError(providerId, wait)
  }

  state.nextAt = startAt + minIntervalMs
  gates.set(providerId, state)

  if (wait > 0) await sleep(wait, signal)
  return wait
}
