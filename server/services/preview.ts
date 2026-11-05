/**
 * 预览投影的薄封装。
 *
 * 详情、分享、PATCH 三处都要"文件 → 可运行 HTML"，统一从这里出，
 * 免得有一天改组装规则只改了两处。
 *
 * React/TSX 工程还要多两样东西：转译器与 React 运行时。它们在这里一次性装配，
 * 组装器本身（shared/preview/assemble）保持纯函数、不 import 任何 Node 模块 ——
 * 浏览器那边要复用同一个组装器。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { transform } from 'sucrase'
import type { Check, DesignTweak, FileEntry } from '../../shared/types'
import { assemble, type AssembleOptions } from '../../shared/preview/assemble'
import { transformOptions, type BundleRuntime } from '../../shared/preview/bundle'

const requireHere = createRequire(import.meta.url)

let cachedRuntime: BundleRuntime | null = null

/**
 * 从 node_modules 读 React 的 UMD 生产构建。
 *
 * 为什么不 `require('react/umd/...')`：react 18 的 package.json 有 exports 映射，
 * 没有导出 `./umd/*`，直接 require 会被拦。先解析 `react/package.json`
 * （它是显式导出的）再拼出 umd 目录，才是稳定路径。
 *
 * 读失败不该让整个预览挂掉：返回 null，让组装器如实报"当前环境没有运行时"，
 * 而不是抛一个 500 把项目详情页一起带走。
 */
function reactRuntime(): BundleRuntime | null {
  if (cachedRuntime) return cachedRuntime
  try {
    const read = (pkg: string, file: string) =>
      readFileSync(join(dirname(requireHere.resolve(`${pkg}/package.json`)), 'umd', file), 'utf8')
    cachedRuntime = {
      react: read('react', 'react.production.min.js'),
      reactDom: read('react-dom', 'react-dom.production.min.js'),
    }
    return cachedRuntime
  } catch {
    return null
  }
}

/** 组装选项：Node 端不需要懒加载，直接在首次使用时装配好。 */
export function assembleOptions(): AssembleOptions {
  const runtime = reactRuntime()
  return {
    compile: (code, path) => transform(code, transformOptions(path)).code,
    ...(runtime ? { runtime } : {}),
  }
}

export function assembleFiles(files: FileEntry[], tweak?: DesignTweak) {
  return assemble(files, tweak, assembleOptions())
}

export function previewOf(files: FileEntry[], tweak?: DesignTweak): { html: string; checks: Check[] } {
  const result = assembleFiles(files, tweak)
  return { html: result.html, checks: result.checks }
}
