import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Flex, Space, Tooltip, Typography } from 'antd'
import {
  BgColorsOutlined,
  CheckCircleFilled,
  DesktopOutlined,
  ExclamationCircleFilled,
  ExpandAltOutlined,
  FileTextOutlined,
  MobileOutlined,
  ReloadOutlined,
  TabletOutlined,
} from '@ant-design/icons'
import type { Check, DesignTweak } from '../../shared/types'
import { tweakVars } from '../../shared/theme'
import { isBridgeMessage, openExternal, watchFrame } from '../lib/preview-host'
import { injectSeed, readSeed } from '../lib/seed'
import { effectiveStage, STAGE_LABEL } from '../lib/run-stage'
import { TweakPanel } from './TweakPanel'
import { toast } from './ui'
import type { LiveState } from './ChatStream'

const { Text } = Typography

/** live 为空（未生成）时的兜底：让 effectiveStage 拿到一个合法形状，省掉到处判空 */
const EMPTY_STAGE = { files: [], checks: [] } satisfies Parameters<typeof effectiveStage>[0]

type Device = 'desktop' | 'tablet' | 'mobile'

const DEVICES: { value: Device; label: string; icon: React.ReactNode }[] = [
  { value: 'desktop', label: '桌面', icon: <DesktopOutlined /> },
  { value: 'tablet', label: '平板', icon: <TabletOutlined /> },
  { value: 'mobile', label: '手机', icon: <MobileOutlined /> },
]

interface Props {
  projectId: string
  /** 服务端已落库的版本（最终真相） */
  html: string
  /** 生成过程中本地现组的版本：入口文件一写完就能看，不必等整轮结束 */
  liveHtml?: string
  checks: Check[]
  errors: string[]
  tweak?: DesignTweak
  /** 生成中的实时状态：非空表示这一轮还在跑 */
  live?: LiveState | null
  onTweakSave: (next: DesignTweak | undefined) => Promise<void>
  onHeal: () => void
  onRefresh: () => void
  /** 针对单个失败项让 Agent 定向修复 */
  onRepairCheck?: (check: Check) => void
  /** 跳过 Agent，直接去代码里改 */
  onOpenCheckFile?: (check: Check) => void
  /** 把失败的项一次性打包修复 */
  onRepairAll?: (checks: Check[]) => void
}

/**
 * 生成中的预览区。
 *
 * 以前这里直接落到一个"还没有可预览的内容"空态：右边整屏在几十秒里什么都没有，
 * 而真实情况是模型正在一个个文件地写。现在用骨架页（hero / 标题 / 卡片栅格）
 * 先把"即将出现的页面"撑起来，再叠一张状态卡说明此刻写到哪、还剩几个文件 ——
 * 骨架的作用是让等待可感知，状态卡的作用是让等待可理解。
 */
function PreviewBuilding({ live }: { live: LiveState }) {
  const stage = effectiveStage(live)
  const files = live.files
  const planned = live.plan?.files ?? []
  const done = files.filter((file) => file.done).length
  const total = Math.max(files.length, planned.length)
  const active = files.find((file) => !file.done)
  const upcoming = planned.filter((file) => !files.some((item) => item.path === file.path))

  return (
    <div className="preview-building">
      <div className="pb-skeleton" aria-hidden="true">
        <span className="pb-line" style={{ width: '38%' }} />
        <span className="pb-line pb-hero" />
        <span className="pb-line" style={{ width: '56%', height: 18 }} />
        <span className="pb-line" style={{ width: '78%' }} />
        <div className="pb-grid">
          <span className="pb-card-sk" />
          <span className="pb-card-sk" />
          <span className="pb-card-sk" />
        </div>
        <span className="pb-line" style={{ width: '46%' }} />
      </div>

      <div className="pb-status" role="status" aria-live="polite">
        <span className="pb-ring" aria-hidden="true" />
        <div className="pb-copy">
          <span className="pb-title">{STAGE_LABEL[stage]}</span>
          <span className="pb-sub">
            {active ? (
              <>
                正在写入 <span className="mono">{active.path}</span>
                {active.lines > 0 ? ` · ${active.lines} 行` : ''}
              </>
            ) : live.plan?.name ? (
              live.plan.name
            ) : (
              '正在理解需求…'
            )}
          </span>
        </div>
        {total > 0 ? (
          <span className="pb-count">
            {done}/{total}
          </span>
        ) : null}
      </div>

      {upcoming.length > 0 ? (
        <div className="pb-queue" aria-label="待生成文件">
          {upcoming.slice(0, 5).map((file) => (
            <span key={file.path} className="pb-chip mono" title={file.purpose || file.path}>
              {file.path}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function PreviewPanel({
  projectId,
  html,
  liveHtml = '',
  checks,
  errors,
  tweak,
  live,
  onTweakSave,
  onHeal,
  onRefresh,
  onRepairCheck,
  onOpenCheckFile,
  onRepairAll,
}: Props) {
  const [device, setDevice] = useState<Device>('desktop')
  const [nonce, setNonce] = useState(0)
  const [showChecks, setShowChecks] = useState(false)
  const [showTweak, setShowTweak] = useState(false)
  const [draft, setDraft] = useState<DesignTweak>(tweak ?? {})
  const [saving, setSaving] = useState(false)
  /** 预览失去响应（多半是死循环）：只遮住预览，不动编辑器 */
  const [stalled, setStalled] = useState(false)

  const frameRef = useRef<HTMLIFrameElement>(null)
  const saveTimer = useRef<number | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // 服务端是最终真相（刷新、回滚、换设备都以它为准），所以 prop 变了就同步草稿
  useEffect(() => {
    setDraft(tweak ?? {})
  }, [tweak?.accent, tweak?.radius])

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
  }, [])

  // 生成中的本地版本优先：它是用"本轮已写完的文件 + 上一版其余文件"现组的，
  // 比服务端那份还没落库的旧版本新。整轮结束后 liveHtml 归零，自动回到最终真相。
  const srcDoc = useMemo(() => injectSeed(liveHtml || html, readSeed(projectId)), [html, liveHtml, projectId, nonce])

  /**
   * 看门狗：每秒 ping 一次沙箱，3 秒没回应就认定卡住。
   *
   * 真正卡死的是预览的渲染线程，宿主本身没问题 —— 所以能做的不是"杀掉它"，
   * 而是把"为什么白屏"说清楚，并给一个重新加载的出口。重挂 iframe 会连同
   * 那个死循环一起丢掉（文档被丢弃，脚本自然不再执行）。
   */
  useEffect(() => {
    const frame = frameRef.current
    if (!frame || !srcDoc) return
    setStalled(false)
    return watchFrame(frame, setStalled)
  }, [srcDoc, nonce])

  /** 沙箱没有 allow-popups：生成物里的弹窗统一由宿主开，伪协议一律拒绝。 */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isBridgeMessage(event.data) || event.data.kind !== 'open') return
      openExternal(event.data.url)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])


  const blocking = checks.find((check) => check.level === 'block' && !check.ok)
  const passed = checks.filter((check) => check.ok).length
  const warned = checks.filter((check) => !check.ok && check.level !== 'block').length
  const failed = checks.filter((check) => !check.ok && check.level === 'block').length
  const health = failed > 0 ? 'bad' : warned > 0 ? 'warn' : 'ok'
  const healthLabel = failed > 0 ? `${failed} 项阻断` : warned > 0 ? `${warned} 项提醒` : `${passed} 项检查通过`
  const supportsTokens = checks.find((check) => check.id === 'theme_vars')?.ok ?? true
  /** 生成中：预览区要显示"正在搭"的过程，而不是一句"还没有可预览的内容" */
  const running = Boolean(live?.running)
  const activeFile = live?.files.find((file) => !file.done) ?? null

  /** 把草稿推给沙箱：只改变量、不重载文档，应用内的状态不会被打断。 */
  const applyLive = (next: DesignTweak) => {
    const win = frameRef.current?.contentWindow
    if (!win) return
    win.postMessage({ __nucleus_tweak: { reset: true, vars: tweakVars(next) } }, '*')
  }

  const persist = async (next: DesignTweak) => {
    setSaving(true)
    try {
      // 直接交给 api 归一：空对象 → null（清除）。
      // 这里不要写成 `Object.keys(next).length > 0 ? next : undefined`：
      // 那会在 JSON 序列化时把键整个丢掉，服务端收不到"清除"这个动作。
      await onTweakSave(next)
    } catch {
      toast('微调没保存成功，刷新后会回到上次保存的外观')
    } finally {
      setSaving(false)
    }
  }

  const change = (next: DesignTweak) => {
    setDraft(next)
    applyLive(next)
    // 拖动滑杆会连续触发：防抖，避免每移动 1px 就打一次接口
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => void persist(next), 400)
  }

  const reset = () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    setDraft({})
    applyLive({})
    void persist({})
  }

  const openStandalone = () => {
    try {
      const blob = new Blob([srcDoc], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      toast('打开失败，请先让 Agent 生成内容')
    }
  }

  return (
    <>
      {/*
        阻断项的常驻说明：以前它只藏在「N 项阻断」这个小胶囊后面，
        用户看到的是白屏 + 一个不解释的数字，根本不知道该点哪。
        这里把它提到预览上方，并直接给出两条出路（改代码 / 让 Agent 修）。
      */}
      {blocking ? (
        <Alert
          className="error-banner"
          type="error"
          showIcon
          message={
            <Text>
              阻断项「{blocking.label}」：<Text className="mono">{blocking.detail ?? '未通过'}</Text>
            </Text>
          }
          action={
            <Space size={6}>
              {onOpenCheckFile ? (
                <Button size="small" onClick={() => onOpenCheckFile(blocking)}>
                  手动改
                </Button>
              ) : null}
              {onRepairCheck ? (
                <Button size="small" type="primary" onClick={() => onRepairCheck(blocking)}>
                  让 Agent 修复
                </Button>
              ) : null}
            </Space>
          }
        />
      ) : null}

      {errors.length > 0 ? (
        <Alert
          className="error-banner"
          type="error"
          showIcon
          message={
            <Text>
              检测到 {errors.length} 个运行时错误：<Text className="mono">{errors[0]?.slice(0, 90)}</Text>
            </Text>
          }
          action={
            <Button size="small" type="primary" onClick={onHeal}>
              让 Agent 修复
            </Button>
          }
        />
      ) : null}

      <div className="preview-shell">
        <Flex className="preview-toolbar" align="center" gap={6} wrap>
          {/*
            设备切换不用 antd 的 primary 按钮：实心主色块会把图标整个吞掉
            （蓝底蓝描边，看不清是电脑还是手机）。这里改成浅主色底 + 主色图标，
            选中态靠"底色 + 描边"表达，图标本身保持线稿的辨识度。
          */}
          <div className="dev-switch" role="group" aria-label="预览设备">
            {DEVICES.map((item) => (
              <Tooltip key={item.value} title={item.label}>
                <button
                  type="button"
                  className={`dev-btn${device === item.value ? ' is-on' : ''}`}
                  aria-label={item.label}
                  aria-pressed={device === item.value}
                  onClick={() => setDevice(item.value)}
                >
                  {item.icon}
                </button>
              </Tooltip>
            ))}
          </div>

          <div className="url-pill">
            <span className="dot" />
            <Text className="mono" style={{ fontSize: 11.5 }} ellipsis>
              nucleus://preview/{projectId}
            </Text>
          </div>

          <div className="spacer" />

          <Tooltip title="设计微调：改主色 / 圆角，不用重新生成">
            <Button
              size="small"
              type="text"
              className={`tool-btn${showTweak ? ' is-on' : ''}`}
              aria-label="设计微调"
              aria-expanded={showTweak}
              icon={<BgColorsOutlined />}
              onClick={() => setShowTweak((value) => !value)}
            >
              设计
            </Button>
          </Tooltip>

          {checks.length > 0 ? (
            <Tooltip title="查看静态自检结果">
              <Button
                size="small"
                type="text"
                className={`health-pill ${health}`}
                aria-expanded={showChecks}
                onClick={() => setShowChecks((value) => !value)}
                icon={failed > 0 || warned > 0 ? <ExclamationCircleFilled /> : <CheckCircleFilled />}
              >
                {healthLabel}
              </Button>
            </Tooltip>
          ) : null}

          {/*
            预览自己的两个动作：刷新 / 新窗口。
            「分享」「导出」统一收在顶栏一处 —— 之前工具栏里也放了分享、新窗口又用了
            和导出几乎一样的图标，同一屏出现两套"分享/导出"，点错是必然的。
          */}
          <div className="tool-cluster">
            <Tooltip title="重新加载预览">
              <Button
                size="small"
                type="text"
                aria-label="重新加载预览"
                icon={<ReloadOutlined />}
                onClick={() => {
                  setNonce((value) => value + 1)
                  onRefresh()
                }}
              />
            </Tooltip>
            <Tooltip title="在新窗口打开预览">
              <Button size="small" type="text" aria-label="在新窗口打开预览" icon={<ExpandAltOutlined />} onClick={openStandalone} />
            </Tooltip>
          </div>
        </Flex>

        {showTweak ? (
          <TweakPanel tweak={draft} supportsTokens={supportsTokens} saving={saving} onChange={change} onReset={reset} />
        ) : null}

        {showChecks && checks.length > 0 ? (
          <Card
            size="small"
            className="health-panel"
            title={
              <Text style={{ fontSize: 12.5 }}>
                自检 · {passed} 项通过{failed + warned > 0 ? `，${failed + warned} 项待处理` : ''}
              </Text>
            }
            extra={
              onRepairAll && failed + warned > 0 ? (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  onClick={() => onRepairAll(checks.filter((check) => !check.ok))}
                >
                  全部修复
                </Button>
              ) : null
            }
          >
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              {checks.map((check) => (
                <div key={check.id} className={`health-row ${check.ok ? 'ok' : check.level}`}>
                  <Flex align="flex-start" gap={7}>
                    {check.ok ? (
                      <CheckCircleFilled style={{ color: 'var(--ok)', marginTop: 3 }} />
                    ) : (
                      <ExclamationCircleFilled
                        style={{ color: check.level === 'block' ? 'var(--danger)' : 'var(--warn)', marginTop: 3 }}
                      />
                    )}
                    <div className="health-copy">
                      <Text style={{ fontSize: 12.5 }}>{check.label}</Text>
                      {check.detail ? (
                        <Text type="secondary" className="mono health-detail">
                          {check.detail}
                        </Text>
                      ) : null}
                    </div>
                    {/*
                      失败项必须给出下一步：只报"未通过"而不给动作，
                      等于把问题丢回给用户，而他能做的只有重开一轮碰运气。
                    */}
                    {!check.ok ? (
                      <Space size={2} className="health-actions">
                        {onOpenCheckFile ? (
                          <Button size="small" type="text" onClick={() => onOpenCheckFile(check)}>
                            手动改
                          </Button>
                        ) : null}
                        {onRepairCheck ? (
                          <Button size="small" type="link" onClick={() => onRepairCheck(check)}>
                            让 Agent 修
                          </Button>
                        ) : null}
                      </Space>
                    ) : null}
                  </Flex>
                </div>
              ))}
            </Space>
          </Card>
        ) : null}

        {html || liveHtml ? (
          <>
            {running ? (
              <div className="preview-refreshing" role="status" aria-live="polite">
                <span className="pr-bar" />
                <span className="pr-text">
                  <span className="live-dot" />
                  {activeFile ? `正在写入 ${activeFile.path}` : `${STAGE_LABEL[effectiveStage(live ?? EMPTY_STAGE)]}…`}
                </span>
              </div>
            ) : null}
            <div className={`frame-wrap device-${device}`}>
              <iframe
                key={nonce}
                ref={frameRef}
                title="应用预览"
                /*
                 * 没有 allow-same-origin：文档拿到的是不透明源，碰不到宿主的 storage/cookie。
                 * 也没有 allow-popups：所有弹窗都要经桥接上报、由宿主开（见 preview-host.ts），
                 * 否则生成物可以拿它做钓鱼窗口。allow-downloads 保留 —— 导出按钮是常见需求。
                 */
                sandbox="allow-scripts allow-forms allow-modals allow-downloads"
                srcDoc={srcDoc}
                // 重载后用当前草稿补一次：否则保存期间的刷新会闪回旧配色
                onLoad={() => applyLive(draftRef.current)}
              />
              {stalled ? (
                /*
                 * 看门狗遮罩。说清三件事：卡在哪、为什么、现在点哪里 ——
                 * 死循环时用户看到的是纯白 + 没有报错，比任何红字都更像"这东西坏了"。
                 */
                <div className="frame-stalled" role="alert">
                  <div className="fs-card">
                    <Text strong style={{ fontSize: 14 }}>
                      预览没有响应
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12.5 }}>
                      生成的应用里可能有个死循环，把预览的渲染线程占住了。这里只能重新加载把它丢掉，
                      编辑器和已保存的版本不受影响。
                    </Text>
                    <Space size={8}>
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => {
                          setStalled(false)
                          setNonce((value) => value + 1)
                        }}
                      >
                        重新加载预览
                      </Button>
                    </Space>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : running && live ? (
          <PreviewBuilding live={live} />
        ) : (
          <Empty
            className="preview-empty"
            image={<div className="empty-art" aria-hidden="true"><FileTextOutlined /></div>}
            description={
              <Space direction="vertical" size={2}>
                <Text strong>还没有可预览的内容</Text>
                <Text type="secondary" style={{ fontSize: 12.5 }}>
                  {blocking?.detail ?? '先在左侧描述你要的应用，Agent 会生成入口文件。'}
                </Text>
              </Space>
            }
          />
        )}
      </div>
    </>
  )
}
