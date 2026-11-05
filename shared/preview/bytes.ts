/**
 * UTF-8 字节数。
 *
 * 单独成一个模块，只因为组装器和资产的预算判定都要用：前端也要组装预览
 * （边生成边看，见 Studio 的 liveHtml），所以这里不能直接用 `Buffer` ——
 * 浏览器里没有它，一引用就抛。Node 走 Buffer，浏览器走 TextEncoder，
 * 两者对 UTF-8 的计数结果一致，体积闸门在两边判出来的结论相同。
 *
 * 放在这里而不是 assemble.ts，是为了避免 assets.ts 与 assemble.ts 互相 import
 * 形成环（环在 ESM 里能跑，但初始化顺序会变得依赖打包器，不值得赌）。
 */
export function byteLength(text: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8')
  return new TextEncoder().encode(text).length
}
