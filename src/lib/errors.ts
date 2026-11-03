/**
 * 错误码 → 人话 + 下一步动作。
 *
 * 为什么要单独一层：服务端返回的是**归一化的错误码**（llm_auth / llm_quota / …），
 * 但用户看到的不应该是 "Request failed with status 401"。PRD §6 要求每个错误场景
 * 都能回答两个问题：「发生了什么」和「我现在该点什么」。
 *
 * 这一层是纯函数，没有副作用，可以直接被单测覆盖。
 */

export type ErrorActionKind = 'settings' | 'retry' | 'home' | 'none'

export interface ErrorAction {
  kind: ErrorActionKind
  label: string
}

export interface ErrorExplanation {
  /** 一句话结论：发生了什么 */
  title: string
  /** 原因或下一步的细节 */
  hint: string
  /** 建议用户点哪里 */
  action: ErrorAction
}

interface Rule {
  title: string
  hint: string
  action: ErrorAction
}

const RULES: Record<string, Rule> = {
  llm_auth: {
    title: '模型拒绝了这个请求',
    hint: '多半是 API Key 填错、已过期或没有该模型的权限。Key 只存在服务端，不写日志。',
    action: { kind: 'settings', label: '去设置检查 Key' },
  },
  llm_quota: {
    title: '额度或速率限制',
    hint: '这一家的配额到了（免 Key 通道约 30 秒 1 次）。稍等一下重试，或在设置里换成你自己的 Key。',
    action: { kind: 'retry', label: '重新生成' },
  },
  llm_timeout: {
    title: '模型响应超时',
    hint: '30 秒没有收到首字节，或传输中途断开了。重试一次；反复超时的话，换一家模型。',
    action: { kind: 'retry', label: '重新生成' },
  },
  llm_network: {
    title: '连不上模型服务',
    hint: '检查网络、模型地址是否可达。注意：出于安全考虑，不允许指向内网或本机地址。',
    action: { kind: 'settings', label: '去设置检查地址' },
  },
  protocol_error: {
    title: '模型没有按协议输出',
    hint: '这家模型没遵守输出协议（可能是太小或太爱解释）。换个说法重试，或在设置里换一家。',
    action: { kind: 'retry', label: '重新生成' },
  },
  provider_unavailable: {
    title: '没有可用的模型通道',
    hint: '服务端把免 Key 通道关掉了，也没有填自己的 Key。到设置里选一个已就绪的预设，或填上你的 Key。',
    action: { kind: 'settings', label: '去设置' },
  },
  busy: {
    title: '这个项目正在生成',
    hint: '同一个项目同时只能有一个生成任务。先等它跑完，或者点「停止」。',
    action: { kind: 'none', label: '' },
  },
  not_found: {
    title: '项目不存在',
    hint: '它可能已经被删除了，或者链接拼错了。',
    action: { kind: 'home', label: '回首页' },
  },
  bad_request: {
    title: '请求参数不合法',
    hint: '检查一下输入内容是否为空、是否超过 2000 字。',
    action: { kind: 'none', label: '' },
  },
  internal: {
    title: '服务端出了点问题',
    hint: '这不是你的操作导致的。重试一次；仍然失败的话，可以换一个需求描述试试。',
    action: { kind: 'retry', label: '重新生成' },
  },
}

const FALLBACK: Rule = {
  title: '出了点问题',
  hint: '重试一次通常就好了。如果反复失败，换个说法再试试。',
  action: { kind: 'retry', label: '重新生成' },
}

export function explainError(code: string | undefined, message: string): ErrorExplanation {
  const rule = (code && RULES[code]) || FALLBACK
  const detail = message?.trim()
  return {
    title: rule.title,
    hint: detail && detail.length > 4 ? `${rule.hint}\n原始信息：${detail.slice(0, 160)}` : rule.hint,
    action: rule.action,
  }
}

/** 页面顶部提示条用的简短版本（只有一句话）。 */
export function errorTitle(code: string | undefined, message: string): string {
  if (code && RULES[code]) return RULES[code]!.title
  return message?.trim().slice(0, 60) || '出了点问题'
}
