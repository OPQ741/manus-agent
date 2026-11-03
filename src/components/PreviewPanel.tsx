import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Flex, Space, Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled,
  DesktopOutlined,
  ExclamationCircleFilled,
  ExportOutlined,
  MobileOutlined,
  ReloadOutlined,
  ShareAltOutlined,
  BgColorsOutlined,
  TabletOutlined,
} from '@ant-design/icons'
import type { Check, DesignTweak } from '../../shared/types'
import { tweakVars } from '../../shared/theme'
import { injectSeed, readSeed } from '../lib/seed'
import { TweakPanel } from './TweakPanel'
import { toast } from './ui'

const { Text } = Typography

type Device = 'desktop' | 'tablet' | 'mobile'

const DEVICES: { value: Device; label: string; icon: React.ReactNode }[] = [
  { value: 'desktop', label: '桌面', icon: <DesktopOutlined /> },
  { value: 'tablet', label: '平板', icon: <TabletOutlined /> },
  { value: 'mobile', label: '手机', icon: <MobileOutlined /> },
]

interface Props {
  projectId: string
  html: string
  checks: Check[]
  errors: string[]
  tweak?: DesignTweak
  onTweakSave: (next: DesignTweak | undefined) => Promise<void>
  onHeal: () => void
  onRefresh: () => void
  shareUrl: string | null
}

export function PreviewPanel({ projectId, html, checks, errors, tweak, onTweakSave, onHeal, onRefresh, shareUrl }: Props) {
  const [device, setDevice] = useState<Device>('desktop')
  const [nonce, setNonce] = useState(0)
  const [showChecks, setShowChecks] = useState(false)
  const [showTweak, setShowTweak] = useState(false)
  const [draft, setDraft] = useState<DesignTweak>(tweak ?? {})
  const [saving, setSaving] = useState(false)

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

  const srcDoc = useMemo(() => injectSeed(html, readSeed(projectId)), [html, projectId, nonce])

  const blocking = checks.find((check) => check.level === 'block' && !check.ok)
  const passed = checks.filter((check) => check.ok).length
  const warned = checks.filter((check) => !check.ok && check.level !== 'block').length
  const failed = checks.filter((check) => !check.ok && check.level === 'block').length
  const health = failed > 0 ? 'bad' : warned > 0 ? 'warn' : 'ok'
  const healthLabel = failed > 0 ? `${failed} 项阻断` : warned > 0 ? `${warned} 项提醒` : `${passed} 项检查通过`
  const supportsTokens = checks.find((check) => check.id === 'theme_vars')?.ok ?? true

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

  const copyShare = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      toast('分享链接已复制')
    } catch {
      toast(shareUrl)
    }
  }

  return (
    <>
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
          <Space.Compact>
            {DEVICES.map((item) => (
              <Tooltip key={item.value} title={item.label}>
                <Button
                  size="small"
                  type={device === item.value ? 'primary' : 'default'}
                  aria-label={item.label}
                  aria-pressed={device === item.value}
                  icon={item.icon}
                  onClick={() => setDevice(item.value)}
                />
              </Tooltip>
            ))}
          </Space.Compact>

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
              type={showTweak ? 'primary' : 'text'}
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
          <Tooltip title="在新窗口打开">
            <Button size="small" type="text" aria-label="在新窗口打开" icon={<ExportOutlined />} onClick={openStandalone} />
          </Tooltip>
          <Tooltip title="复制分享链接">
            <Button
              size="small"
              type="text"
              aria-label="复制分享链接"
              disabled={!shareUrl}
              icon={<ShareAltOutlined />}
              onClick={() => void copyShare()}
            />
          </Tooltip>
        </Flex>

        {showTweak ? (
          <TweakPanel tweak={draft} supportsTokens={supportsTokens} saving={saving} onChange={change} onReset={reset} />
        ) : null}

        {showChecks && checks.length > 0 ? (
          <Card size="small" className="health-panel">
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {checks.map((check) => (
                <Flex key={check.id} align="flex-start" gap={7} className={`health-row ${check.ok ? 'ok' : check.level}`}>
                  {check.ok ? (
                    <CheckCircleFilled style={{ color: 'var(--ok)', marginTop: 3 }} />
                  ) : (
                    <ExclamationCircleFilled style={{ color: 'var(--warn)', marginTop: 3 }} />
                  )}
                  <Text style={{ fontSize: 12.5 }}>{check.label}</Text>
                  {check.detail ? (
                    <Text type="secondary" className="mono" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
                      {check.detail}
                    </Text>
                  ) : null}
                </Flex>
              ))}
            </Space>
          </Card>
        ) : null}

        {html ? (
          <div className={`frame-wrap device-${device}`}>
            <iframe
              key={nonce}
              ref={frameRef}
              title="应用预览"
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              srcDoc={srcDoc}
              // 重载后用当前草稿补一次：否则保存期间的刷新会闪回旧配色
              onLoad={() => applyLive(draftRef.current)}
            />
          </div>
        ) : (
          <Empty
            className="preview-empty"
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
