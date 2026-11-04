/**
 * HTTP 层唯一的错误类型。
 *
 * `code` 是**语义码**（not_found / busy / provider_unavailable …），不是 HTTP 短语：
 * 前端据此决定"该弹提示还是该跳设置页"，跟状态码是两件事。
 * 把状态码和语义码绑在同一个对象里，是为了让路由里只 throw 一次，
 * 由统一的出口决定怎么写响应 —— 而不是在每个 handler 里各写一遍 res.writeHead。
 */
export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
