import { Button, Tooltip } from 'antd'
import {
  BulbOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  FileTextOutlined,
  LoadingOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { fmtSec } from '../lib/format'
import { effectiveStage, RUN_STAGES, runProgress, runningFile, stageIndex, stageText, type RunStage } from '../lib/run-stage'
import { useTicker, type LiveState } from './ChatStream'

/**
 * 生成状态条 —— 全界面**唯一**的实时状态出口。
 *
 * 之前同一件事被画了两遍：左下角一个转圈 + 阶段名，右上角页签旁一个
 * "写入 app.js" 徽标。两处粒度还不一样，用户要在屏幕对角线上来回看。
 * 现在收敛到这一条：阶段（含图标）+ 分段进度 + 百分比条 + 当前文件 + 已用时 + 停止。
 *
 * 位置选在输入框上方而不是页签旁：停止按钮必须和"我刚发出的那句话"在一起，
 * 页签旁那个徽标离得太远，点停止要横跨整个右半屏。
 */
const STAGE_ICON: Record<RunStage, React.ReactNode> = {
  plan: <BulbOutlined />,
  write: <CodeOutlined />,
  verify: <SafetyCertificateOutlined />,
}

export function RunStatusBar({ live, onStop }: { live: LiveState; onStop: () => void }) {
  // 秒表自己走：状态条出现在对话流之外，不该依赖那边的 ticker 顺带刷新
  const now = useTicker(live.running)
  const elapsed = live.startedAt ? now - live.startedAt : 0
  // 走 effectiveStage 而不是裸读 live.stage：阶段结束事件会把 stage 置回 null，
  // 直接兜底成 'plan' 会出现"文件全写完了却显示正在拆解需求"的矛盾状态
  const stage = effectiveStage(live)
  const current = stageIndex(stage)
  const percent = Math.round(runProgress(live) * 100)
  const active = runningFile(live.files)
  const doneCount = live.files.filter((file) => file.done).length
  const total = Math.max(live.files.length, live.plan?.files?.length ?? 0)

  return (
    <div className="run-status" role="status" aria-live="polite">
      <div className="run-status-head">
        <span className={`run-status-chip is-${stage}`}>
          <span className="run-status-icon">{STAGE_ICON[stage]}</span>
          {stageText(stage)}
        </span>

        <div className="spacer" />

        <span className="run-status-clock">
          <ClockCircleOutlined /> {fmtSec(elapsed)}
        </span>

        <Tooltip title="中断这一轮；已经写完的文件会保留成新版本">
          {/* aria-label 与图标并存时无障碍名会变成「stop 停止」，
              按名字定位的脚本和读屏都会被这半截英文带偏，所以显式钉死中文名 */}
          <Button size="small" danger icon={<StopOutlined />} onClick={onStop} aria-label="停止">
            停止
          </Button>
        </Tooltip>
      </div>

      {/*
        分段单独占一行：和阶段名挤在一排时，380px 宽的对话栏里
        第三段必然被压成"静态…"，反而比不显示更糟。
      */}
      <ol className="run-status-steps" aria-label="生成阶段">
        {RUN_STAGES.map((item, index) => {
          const state = index < current ? 'done' : index === current ? 'now' : 'todo'
          return (
            <li key={item.key} className={`run-status-step is-${state}`} title={item.hint}>
              <span className="run-status-step-dot">
                {state === 'done' ? <CheckOutlined /> : state === 'now' ? <LoadingOutlined spin /> : null}
              </span>
              <span className="run-status-step-label">{item.label}</span>
            </li>
          )
        })}
      </ol>

      <div className="run-status-track" aria-hidden="true">
        <span className="run-status-fill" style={{ width: `${percent}%` }} />
      </div>

      <div className="run-status-detail">
        {active ? (
          <>
            <span className="run-status-file mono">
              <FileTextOutlined /> {active.path}
            </span>
            <span className="run-status-note">{active.lines} 行 · 写入中</span>
          </>
        ) : total > 0 ? (
          <span className="run-status-note">{doneCount}/{total} 个文件已完成</span>
        ) : (
          <span className="run-status-note">{live.plan ? '方案已就绪，正在准备写入…' : '正在理解需求…'}</span>
        )}
        <div className="spacer" />
        <span className="run-status-pct">{percent}%</span>
      </div>
    </div>
  )
}
