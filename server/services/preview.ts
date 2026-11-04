/**
 * 预览投影的薄封装。
 *
 * 详情、分享、PATCH 三处都要"文件 → 可运行 HTML"，统一从这里出，
 * 免得有一天改组装规则只改了两处。
 */

import type { Check, DesignTweak, FileEntry } from '../../shared/types'
import { assemble } from '../../shared/preview/assemble'

export function previewOf(files: FileEntry[], tweak?: DesignTweak): { html: string; checks: Check[] } {
  const result = assemble(files, tweak)
  return { html: result.html, checks: result.checks }
}
