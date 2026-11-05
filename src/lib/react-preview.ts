/**
 * 浏览器端的打包入口（懒加载）。
 *
 * 为什么全部走动态 import：sucrase 约 300 KB、React UMD 约 141 KB，
 * 而 90% 的项目是原生 HTML/CSS/JS，根本用不到它们。
 * 只有真的打开了 `.jsx` / `.tsx` 工程，才把这套东西拉进内存。
 *
 * 服务端有一份等价的装配（server/services/preview.ts），两边共用
 * shared/preview/bundle.ts 的编译参数 —— 预览与落库产物必须是同一套规则。
 */

import { assemble } from '../../shared/preview/assemble'
import { isModuleProject, transformOptions } from '../../shared/preview/bundle'
import type { AssembleOptions } from '../../shared/preview/assemble'
import type { Check, DesignTweak, FileEntry } from '../../shared/types'

let pending: Promise<AssembleOptions> | null = null

async function loadOptions(): Promise<AssembleOptions> {
  pending ??= (async () => {
    const [sucrase, react, reactDom] = await Promise.all([
      import('sucrase'),
      // `?raw` 读成源码字符串：沙箱里没有网络，运行时只能内联
      import('react-umd?raw'),
      import('react-dom-umd?raw'),
    ])
    return {
      compile: (code: string, path: string) => sucrase.transform(code, transformOptions(path)).code,
      runtime: { react: react.default, reactDom: reactDom.default },
    }
  })()
  return pending
}

export interface BundledPreview {
  html: string
  checks: Check[]
}

/**
 * 把一份模块工程组装成可预览的 HTML。
 * 不是模块工程时返回 null —— 调用方继续走原来的同步组装路径。
 */
export async function bundlePreview(files: FileEntry[], tweak?: DesignTweak): Promise<BundledPreview | null> {
  if (!isModuleProject(files)) return null
  try {
    const options = await loadOptions()
    const result = assemble(files, tweak, options)
    return { html: result.html, checks: result.checks }
  } catch {
    // 打包器自身崩了不该让预览区白屏：交给上层的兜底空态
    return null
  }
}
