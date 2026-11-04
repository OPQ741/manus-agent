/**
 * 设置视图：把"存储里的偏好 + 目录里的通道"投影成前端能直接渲染的一份快照。
 *
 * 这里最值钱的不是 `settingsView` 本身，而是 `explainActive` ——
 * 解析链有三层回退（点名 → 主力 → 免 Key），任何一层静默失效，
 * 用户看到的都是"我明明选了 A 却在跑 B"。与其让他去猜 Key 是不是没保存，
 * 不如直接回一句话告诉他这次为什么是这一家。
 */

import type { DesignPrefs, ProviderInfo, PublicSettings } from '../../shared/types'
import type { ResolvedCatalog, ResolvedProvider } from '../agent/providers'
import { catalogView, resolveChain } from '../agent/providers'
import { readBuildMeta } from '../build-info'
import type { Store, StoredSettings } from '../store/store'

/** 解析链 → 这次实际会打给谁（访客自带 Key 优先，其次服务端主力）。 */
export function activeOf(chain: ResolvedProvider[]): ProviderInfo | null {
  const first = chain[0]
  if (!first) return null
  return { id: first.profile.id, label: first.profile.label, model: first.profile.model, free: Boolean(first.profile.free) }
}

export function settingsView(store: Store, catalog: ResolvedCatalog): PublicSettings {
  const settings = store.getSettings()
  const chain = resolveChain(catalog, userFromSettings(settings))
  const build = readBuildMeta()
  return {
    ...store.publicSettings(),
    // 版本号跟着产物走：以前这里和 /api/health 各写一份 '1.0.0'，永远无法回答
    // "线上跑的是哪一版" —— 现在两处都来自同一次构建写入的 build.json。
    version: build.version,
    build,
    providers: catalogView(catalog),
    active: activeOf(chain),
    activeReason: explainActive(catalog, settings, chain),
    warnings: catalog.warnings ?? [],
  }
}

function explainActive(
  catalog: ResolvedCatalog,
  settings: { provider: string; baseUrl: string; model: string; apiKey: string },
  chain: ResolvedProvider[],
): string {
  const first = chain[0]
  if (!first) return '没有可用通道：免 Key 通道被关掉了，也没有配置任何 Key'
  const provider = settings.provider.trim()

  if (provider === 'custom') {
    if (first.profile.id === 'custom') return '使用你自带的 Key'
    if (!settings.baseUrl.trim() || !settings.model.trim() || !settings.apiKey.trim()) {
      return '自带 Key 还差 Base URL / 模型名 / Key 其中一项，已回退到服务端通道'
    }
    return '自带 Key 的地址不可用（内网地址会被拒绝），已回退到服务端通道'
  }

  if (provider) {
    const named = catalog.entries.find((entry) => entry.profile.id === provider)
    if (!named) return `点名的通道「${provider}」不在目录里，已回退到 ${first.profile.label}`
    if (!named.ready) return `「${named.profile.label}」还没有 Key，已回退到 ${first.profile.label}`
    if (first.profile.id === provider) {
      const model = first.profile.model
      return `按你的选择使用「${named.profile.label}」（${model}）`
    }
    return `点名的「${named.profile.label}」这次没排上，已回退到 ${first.profile.label}`
  }

  return first.profile.id === catalog.defaultId
    ? '服务端默认通道'
    : `服务端默认通道不可用，已回退到 ${first.profile.label}`
}

/* ------------------------------------------------------------------ */
/* 入参清洗：所有写接口共用，避免同一段校验在路由里抄三份               */
/* ------------------------------------------------------------------ */

export function sanitizeDesign(input: Partial<DesignPrefs> | undefined, fallback: DesignPrefs): DesignPrefs {
  const design: DesignPrefs = { ...fallback }
  if (input?.accent && /^#[0-9a-fA-F]{6}$/.test(input.accent)) design.accent = input.accent
  if (input?.theme === 'light' || input?.theme === 'dark' || input?.theme === 'auto') design.theme = input.theme
  if (input?.locale === 'zh' || input?.locale === 'en') design.locale = input.locale
  return design
}

/** 自定义通道的输出上限：给一个人类填得出来的区间，别让一个 0 或 1e9 把上游打爆。 */
export function sanitizeMaxTokens(input: number | null | undefined, fallback?: number): number | undefined {
  if (input === null) return undefined
  if (typeof input !== 'number' || !Number.isFinite(input)) return fallback
  return Math.min(Math.max(Math.round(input), 256), 32_768)
}

export function sanitizeTemperature(input: number | null | undefined, fallback?: number): number | undefined {
  if (input === null) return undefined
  if (typeof input !== 'number' || !Number.isFinite(input)) return fallback
  return Math.min(Math.max(input, 0), 2)
}

/** 存储里的设置 → 解析链需要的"访客自带上游"。 */
export function userFromSettings(settings: StoredSettings) {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    provider: settings.provider,
    modelOverride: settings.modelOverride,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
  }
}

export function storeSettingsUser(store: Store) {
  return userFromSettings(store.getSettings())
}
