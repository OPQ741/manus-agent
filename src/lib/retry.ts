/**
 * 「重新生成」到底该重发哪句话。
 *
 * 规则：错误消息里由服务端落库的 `meta.prompt` 才是这一轮**真正发出去**的指令，
 * 刷新、换设备、关掉页面再回来都还在。只有它缺失（老数据）才退回输入框的草稿。
 *
 * 为什么不能反过来：用户失败后往往先在输入框里改字，再点「重新生成」。如果输入框
 * 有内容就优先用它，这个按钮等于变成了「发送」，两条路径的语义就混在一起了 ——
 * 想改方向应该按发送，想原样再来一次才按重新生成。
 */

import type { Message } from '../../shared/types'

export function failedPromptOf(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    if (message.kind === 'error') {
      const prompt = message.meta?.prompt
      return typeof prompt === 'string' ? prompt.trim() : ''
    }
    // 错误之后又有过一轮成功产出：那条旧错误不再是「最近一次失败」
    if (message.role === 'agent' && (message.kind === 'text' || message.kind === 'plan')) return ''
  }
  return ''
}
