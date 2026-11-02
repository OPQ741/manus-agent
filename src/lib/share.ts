/**
 * 分享链接生成。
 *
 * 为什么不让 `window.location.origin` 直接拼完事：
 * 这个 Demo 部署在带访问口令的托管网关上（`?sharecode=…`）。网关只认**带口令的请求**，
 * 应用内复制出来的 `/p/<slug>` 链接会把口令丢掉，别人（以及刷新后的自己）拿到的就是一页
 * "链接不完整"。所以这里固定做一件事：把当前地址上的口令类查询参数原样带过去。
 *
 * 本地 `npm start`（无口令）时结果和以前完全一致，不做任何特殊分支。
 */

/** 需要在分享链接之间透传的访问参数（托管网关口令等）。 */
const PASS_THROUGH = ['sharecode']

/** 当前页面的访问参数，原样复制成 URLSearchParams（只挑白名单里的键）。 */
export function accessParams(search: string = window.location.search): URLSearchParams {
  const incoming = new URLSearchParams(search)
  const outgoing = new URLSearchParams()
  for (const key of PASS_THROUGH) {
    const value = incoming.get(key)
    if (value) outgoing.set(key, value)
  }
  return outgoing
}

/** 分享链接：<origin>/?<访问参数>#/p/<slug>。hash 路由，静态托管零配置。 */
export function shareUrlFor(slug: string, origin: string, search?: string): string {
  const query = accessParams(search).toString()
  // origin 可能带尾斜杠（少数代理/托管环境会这样），统一去掉再拼，避免出现 `//`；
  // hash 前始终保留一个 `/`，有口令时把 `?sharecode=…` 插在它之前。
  const cleanOrigin = origin.replace(/\/+$/, '')
  return `${cleanOrigin}/${query ? `?${query}` : ''}#/p/${slug}`
}
