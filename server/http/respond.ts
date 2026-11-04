/**
 * 响应与请求体的读写原语。
 *
 * 只用 node:http 的 ServerResponse/IncomingMessage，不引入框架 ——
 * 这样 SSE、导出下载、静态文件三者的写出口是同一个，不存在"框架接管了
 * 一部分响应、我们接管另一部分"的割裂。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError } from './errors'

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

/**
 * 统一错误出口。
 *
 * 非 HttpError 一律记日志 + 500：把内部错误原样回给前端，等于把上游地址、
 * Key 片段、调用栈一起送出去，见过一次就该堵死。
 */
export function sendError(res: ServerResponse, error: unknown) {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: error.code, message: error.message })
    return
  }
  console.error('[nucleus] unhandled', error)
  sendJson(res, 500, { error: 'internal', message: '服务端出了点问题，请重试' })
}

/**
 * 读 JSON 请求体。
 *
 * 三个容易被框架默认值改掉的行为，这里显式钉住：
 *  - 上限 512KB → 413（不是 400）；
 *  - 空 body → `{}` 而不是解析失败（"什么都没改"是合法的 PUT）；
 *  - 非法 JSON → 400，且 message 是给人看的中文。
 */
export async function readJson<T>(req: IncomingMessage, limit = 1024 * 512): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new HttpError(413, 'bad_request', '请求体过大')
    chunks.push(buf)
  }
  if (size === 0) return {} as T
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'bad_request', '请求体不是合法 JSON')
  }
}
