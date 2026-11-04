/**
 * SSE 通道：一次生成 = 一条长连接。
 *
 * 单独封起来的理由不是"好看"，是这里有三个必须一起做对的动作：
 *  1. 写响应头（含 `x-accel-buffering: no`，否则 Nginx/网关会把流攒起来一次性下发，
 *     用户看到的是"转圈 30 秒然后全部蹦出来"）；
 *  2. 监听 close → 中断上游（访客关掉页面，模型调用不该继续烧 token）；
 *  3. 断开后**继续写会抛 ERR_STREAM_DESTROYED**，会顺着写调用把整台服务带崩，
 *     所以每帧写入都要先看 gone。
 */

import type { ServerResponse } from 'node:http'
import type { AgentEvent } from '../../shared/types'

export interface SseChannel {
  /** 客户端已经走了（或流已销毁）：此刻不能再写 */
  readonly gone: boolean
  send(event: AgentEvent): void
  end(): void
}

export function openSse(res: ServerResponse, onAbort: () => void): SseChannel {
  let gone = false

  res.on('close', () => {
    gone = true
    onAbort()
  })
  // 客户端断开后继续写会触发 ERR_STREAM_DESTROYED；这里只标记，不抛
  res.on('error', () => {
    gone = true
  })

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const send = (event: AgentEvent) => {
    if (gone || res.writableEnded || res.destroyed) return
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      gone = true
    }
  }

  return {
    get gone() {
      return gone
    },
    send,
    end: () => res.end(),
  }
}
