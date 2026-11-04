/**
 * 设置相关：读/写偏好、拉上游模型列表、测连通性。
 *
 * 三条接口共享"目标是谁"的判定（点名预设用服务端 Key，还是用访客正在填的草稿），
 * 所以放在同一个文件里，改一处判定三处一致。
 */

import type { DesignPrefs } from '../../shared/types'
import { LlmError, listModels, testConnection, validateBaseUrl } from '../agent/llm'
import { resolveChain, type ResolvedCatalog } from '../agent/providers'
import { HttpError } from '../http/errors'
import { readJson, sendJson } from '../http/respond'
import { action, route, type Route } from '../http/router'
import {
  sanitizeDesign,
  sanitizeMaxTokens,
  sanitizeTemperature,
  settingsView,
  storeSettingsUser,
} from '../services/settings-view'
import type { Store } from '../store/store'

interface Deps {
  store: Store
  getCatalog: () => Promise<ResolvedCatalog>
}

export function settingsRoutes(deps: Deps): Route[] {
  return [
    route('/api/settings', ['GET', 'PUT'], async ({ req, res, method }) => {
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, settingsView(deps.store, await deps.getCatalog()))
        return
      }

      const body = await readJson<{
        provider?: string
        baseUrl?: string
        model?: string
        modelOverride?: string
        apiKey?: string
        maxTokens?: number | null
        temperature?: number | null
        design?: Partial<DesignPrefs>
      }>(req)
      const current = deps.store.getSettings()
      let baseUrl = current.baseUrl
      if (typeof body.baseUrl === 'string') {
        const trimmed = body.baseUrl.trim()
        if (trimmed) {
          // 内网地址会被拒绝：这个服务会把 Key 带上去请求，不能变成 SSRF 跳板
          const guard = validateBaseUrl(trimmed)
          if (!guard.ok) throw new HttpError(400, 'bad_request', guard.reason)
          baseUrl = guard.url
        } else {
          baseUrl = ''
        }
      }
      await deps.store.updateSettings({
        provider: typeof body.provider === 'string' ? body.provider.trim().slice(0, 40) : current.provider,
        baseUrl,
        model: typeof body.model === 'string' ? body.model.trim().slice(0, 120) : current.model,
        modelOverride:
          typeof body.modelOverride === 'string' ? body.modelOverride.trim().slice(0, 120) : current.modelOverride,
        maxTokens: sanitizeMaxTokens(body.maxTokens, current.maxTokens),
        temperature: sanitizeTemperature(body.temperature, current.temperature),
        // 显式传空串 = 清除 Key；不传这个键 = 保持不动。
        // 少了这条，访客换到服务端预设后，自己的旧 Key 会一直悄悄优先。
        apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : current.apiKey,
        design: sanitizeDesign(body.design, current.design),
      })
      sendJson(res, 200, settingsView(deps.store, await deps.getCatalog()))
    }),

    /**
     * 拉上游模型列表。
     *
     * 两种用法：`{ provider }` 拉某个已配置预设的（用服务端的 Key），
     * 或 `{ baseUrl, apiKey }` 拉用户正在填的草稿（还不用保存）。
     * 拉不到不算错 —— 前端允许继续手填模型名。
     */
    action('/api/settings/models', async ({ req, res }) => {
      const body = await readJson<{ baseUrl?: string; apiKey?: string; provider?: string }>(req)
      const current = deps.store.getSettings()
      const named =
        body.provider && body.provider !== 'custom'
          ? (await deps.getCatalog()).entries.find((entry) => entry.profile.id === body.provider)
          : undefined

      let target: { baseUrl: string; apiKey: string; headers?: Record<string, string>; authHeader?: string; source: string }
      if (named) {
        if (!named.ready) {
          throw new HttpError(412, 'provider_unavailable', `「${named.profile.label}」还没有 Key，先填 Key 再拉列表`)
        }
        target = {
          baseUrl: named.profile.baseUrl,
          apiKey: named.apiKey,
          headers: named.profile.headers,
          authHeader: named.profile.authHeader,
          source: named.profile.label,
        }
      } else {
        const rawBase = (body.baseUrl ?? current.baseUrl).trim()
        if (!rawBase) throw new HttpError(400, 'bad_request', '先填 Base URL')
        const guard = validateBaseUrl(rawBase)
        if (!guard.ok) throw new HttpError(400, 'bad_request', guard.reason)
        target = { baseUrl: guard.url, apiKey: (body.apiKey ?? current.apiKey).trim(), source: '自定义通道' }
      }

      try {
        const models = await listModels(target)
        sendJson(res, 200, { models, source: target.source })
      } catch (error) {
        // 502 而不是 500：错在上游，不在我们；把上游的错误码透出去便于对账
        const code = error instanceof LlmError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { error: code, message })
      }
    }),

    /**
     * 测一次真上游。
     *
     * 支持直接测「还没保存的草稿」；没有草稿（body 为空）时测当前解析链的第一家 ——
     * 也就是"现在点生成会打给谁"。
     */
    action('/api/settings/test', async ({ req, res }) => {
      const body = await readJson<{ baseUrl?: string; model?: string; apiKey?: string }>(req)
      const current = deps.store.getSettings()
      const wantsDraft = Boolean(body.baseUrl?.trim() || body.model?.trim() || body.apiKey?.trim())

      let target: {
        baseUrl: string
        apiKey: string
        model: string
        label: string
        headers?: Record<string, string>
        authHeader?: string
      }
      if (wantsDraft) {
        const guard = validateBaseUrl((body.baseUrl ?? current.baseUrl).trim())
        if (!guard.ok) throw new HttpError(400, 'bad_request', guard.reason)
        const model = (body.model ?? current.model).trim()
        if (!model) throw new HttpError(400, 'bad_request', '模型名不能为空')
        target = { baseUrl: guard.url, model, apiKey: (body.apiKey ?? current.apiKey).trim(), label: '我的 Key' }
      } else {
        const chain = resolveChain(await deps.getCatalog(), storeSettingsUser(deps.store))
        const first = chain[0]
        if (!first) {
          throw new HttpError(412, 'provider_unavailable', '没有可测的模型通道：先选一个已就绪的预设，或填自己的 Key')
        }
        target = {
          baseUrl: first.profile.baseUrl,
          model: first.profile.model,
          apiKey: first.apiKey,
          label: first.profile.id,
          headers: first.profile.headers,
          authHeader: first.profile.authHeader,
        }
      }

      try {
        const result = await testConnection({
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          maxTokens: 32,
          temperature: 0,
          headers: target.headers,
          authHeader: target.authHeader,
        })
        sendJson(res, 200, {
          ok: true,
          ms: result.ms,
          sample: result.sample,
          model: target.model,
          provider: target.label,
        })
      } catch (error) {
        const code = error instanceof LlmError ? error.code : 'internal'
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 502, { ok: false, error: code, message })
      }
    }),
  ]
}
