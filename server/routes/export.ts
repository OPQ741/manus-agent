/**
 * GET /api/projects/:id/export —— 下载 ZIP。
 *
 * 两个细节值得留在这：
 *  - 导出要带上项目当前的设计微调（否则"下载下来跟预览长得不一样"）；
 *  - 中文项目名不能直接进 Content-Disposition（HTTP 头只允许 ASCII），
 *    走 RFC 5987 的 filename*，另给一个 ASCII 兜底名。
 */

import { injectTweak } from '../../shared/preview/tweak'
import { HttpError } from '../http/errors'
import { route, type Route } from '../http/router'
import { createZip } from '../export/zip'
import type { Store } from '../store/store'

export function exportRoute(deps: { store: Store }): Route {
  return route('/api/projects/:id/export', ['GET'], async ({ res, params, method }) => {
    const project = deps.store.getProject(params['id']!)
    if (!project) throw new HttpError(404, 'not_found', '项目不存在')
    if (project.files.length === 0) throw new HttpError(400, 'bad_request', '这个项目还没有生成任何文件')

    const hasReadme = project.files.some((file) => /^readme\.md$/i.test(file.path))
    /**
     * 微调是"项目当前外观"的一部分：导出也必须带上，否则"下载下来跟预览长得不一样"。
     *
     * 多页面项目要给**每个** html 都注入：只改入口的话，翻到第二页主色就变回去了。
     */
    const entries = project.files.map((file) => ({
      name: file.path,
      content: project.tweak && /\.html?$/i.test(file.path) ? injectTweak(file.content, project.tweak) : file.content,
    }))
    if (!hasReadme) {
      entries.push({
        name: 'README.md',
        content: `# ${project.name}\n\n${project.summary}\n\n由 Nucleus Studio 生成（v${project.version}，模型：${project.providerLabel || project.provider}）。\n`,
      })
    }
    const zip = createZip(entries)
    const safeName = project.name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'nucleus-app'
    // HTTP 头只能放 ASCII：中文名走 RFC 5987 的 filename*，另给一个 ASCII 兜底
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '').replace(/^-+/, '') || 'nucleus-app'
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${encodeURIComponent(safeName)}.zip`,
      'content-length': String(zip.length),
    })
    res.end(method === 'HEAD' ? undefined : zip)
  })
}
