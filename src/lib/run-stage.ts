import type { LiveFile, LiveState } from '../components/ChatStream'

/**
 * 生成过程的三个阶段 —— 全系统只有这一份定义。
 *
 * 以前「阶段文案」散在两处（左下角的 STAGE_TEXT、右上角页签的 Badge），
 * 改一个词要改两遍，而且两处的粒度还不一样（一个只说阶段，一个只说文件名），
 * 用户得在屏幕两头各看一眼才知道发生了什么。现在阶段名、进行中文案、
 * 进度计算都从这里出，任何一处状态展示都只是它的一种渲染。
 */
export type RunStage = 'plan' | 'write' | 'verify'

export interface RunStageMeta {
  key: RunStage
  /** 时间线上的静态名（拆解需求 / 编写代码 / 静态自检） */
  label: string
  /** 状态条上的进行中文案（正在写代码） */
  ing: string
  /** 一句话解释这一步在干什么，用于 tooltip */
  hint: string
}

export const RUN_STAGES: RunStageMeta[] = [
  { key: 'plan', label: '拆解需求', ing: '正在拆解需求', hint: '理解需求并给出方案：要建哪些文件、按什么顺序写' },
  { key: 'write', label: '编写代码', ing: '正在写代码', hint: '按方案逐个文件生成，写完一个就落一个' },
  { key: 'verify', label: '静态自检', ing: '正在自检', hint: '检查入口文件、标签闭合、资源引用等结构性问题' },
]

/** 时间线上的静态阶段名。用字面量而不是从 RUN_STAGES 里取，是为了让索引访问不出 undefined。 */
export const STAGE_LABEL: Record<RunStage, string> = {
  plan: '拆解需求',
  write: '编写代码',
  verify: '静态自检',
}

export function stageText(stage: RunStage | null | undefined): string {
  if (!stage) return '正在启动'
  return RUN_STAGES.find((item) => item.key === stage)?.ing ?? '正在生成'
}

export function stageIndex(stage: RunStage | null | undefined): number {
  if (!stage) return 0
  return Math.max(0, RUN_STAGES.findIndex((item) => item.key === stage))
}

/**
 * 当前实际所处的阶段。
 *
 * 不能直接读 `live.stage`：服务端在"某个阶段结束"时会把 stage 置回 null
 * （plan done → null → write running），整轮跑完停在 verify done 也就是 null。
 * 直接拿 null 当"plan"用，界面就会出现"3/3 个文件已完成 + 正在拆解需求 + 12%"
 * 这种自相矛盾的显示。这里按已有事实回推：有自检结果 → 自检；文件都写完了 → 收尾；
 * 写了文件 → 编码；否则 → 拆解。
 */
export function effectiveStage(live: { stage?: RunStage | null; files: { done: boolean }[]; checks: unknown[] }): RunStage {
  if (live.stage) return live.stage
  if (live.checks.length > 0) return 'verify'
  if (live.files.length > 0) return live.files.every((file) => file.done) ? 'verify' : 'write'
  return 'plan'
}

/**
 * 整体进度（0~1）。
 *
 * 生成是一次"总时长不可知"的任务，所以这个值刻意做得**保守且连续**：
 * 阶段权重固定（拆解 12% / 编码 70% / 自检 18%），编码段再按文件数细分。
 * 目的是让进度条始终在动 —— 一条卡住不动的进度条比没有进度条更让人不安。
 */
export function runProgress(live: Pick<LiveState, 'stage' | 'files' | 'plan' | 'checks'>): number {
  const stage = effectiveStage(live)
  const planned = live.plan?.files?.length ?? 0
  const total = Math.max(live.files.length, planned, 1)
  const done = live.files.filter((file) => file.done).length

  if (stage === 'plan') return live.plan ? 0.12 : 0.06
  if (stage === 'write') {
    // 一个文件都没开始写时也要有可见的推进，否则首个文件到来前进度条是死的
    const ratio = live.files.length === 0 ? 0.08 : done / total
    return 0.12 + 0.7 * Math.min(1, ratio)
  }
  const checked = live.checks.length
  return checked ? 0.82 + 0.18 * Math.min(1, (checked + 1) / Math.max(checked + 2, 4)) : 0.88
}

/** 当前"正在写"的那个文件：状态条和时间线要用同一个判据，别各算一套。 */
export function runningFile(files: LiveFile[]): LiveFile | null {
  return files.find((file) => !file.done) ?? null
}
