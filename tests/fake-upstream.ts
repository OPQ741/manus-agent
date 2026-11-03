/**
 * 假上游模型（OpenAI 兼容 SSE）。
 *
 * 本地编译器删掉之后，集成测试里**每一条**生成都必须经过"发请求 → 解 SSE →
 * 解协议 → 组装"这条真实链路，否则就等于没测。这里模拟的是上游那一端：
 * 它按请求体里最后一条 user 消息的关键词决定输出什么代码，
 * 于是"迭代改主色""回滚""停止保留"这些用例仍然有确定的期望值可断言。
 *
 * 它不是被测对象的一部分：被测的是我们这一侧的解析、编排、落库与错误映射。
 */

import { createServer, type Server } from 'node:http'

export type FakeMode = 'ok' | 'auth' | 'quota' | 'empty' | 'slow'

export interface FakeCall {
  body: { model?: string; messages?: { role: string; content: string }[]; max_tokens?: number }
  prompt: string
}

export interface FakeUpstream {
  /** 直接当作 LlmConfig.baseUrl 用 */
  url: string
  /** 收到过几次请求（含被中断的） */
  calls(): number
  /** 每次请求解析出来的 user prompt（按到达顺序） */
  received(): string[]
  lastBody(): FakeCall['body'] | null
  setMode(mode: FakeMode): void
  close(): Promise<void>
}

/** 从需求里挑主色：让"改成红色"这类迭代指令在假上游上也有确定产物。 */
export function accentFor(prompt: string): string {
  if (/红色|玫红/.test(prompt)) return '#C2405C'
  if (/墨绿|绿色/.test(prompt)) return '#12715B'
  if (/蓝色|天蓝/.test(prompt)) return '#2563C9'
  return '#4B3BFF'
}

export function nameFor(prompt: string): string {
  const quoted = /[「"']([^」"']{1,16})[」"']/.exec(prompt)
  return quoted?.[1] ?? '假模型应用'
}

/** 一版最小但合法的 NWF 协议输出（三个文件、引用完整、能通过 assemble 自检）。 */
export function nwfFor(prompt: string, options: { omitCss?: boolean } = {}): string {
  const name = nameFor(prompt)
  const accent = accentFor(prompt)
  const plan = `<plan>{"name":"${name}","summary":"来自假上游的一次生成","stack":"HTML + CSS + JS","steps":["出结构","出样式"],"files":[{"path":"index.html","purpose":"入口"}${options.omitCss ? '' : ',{"path":"styles.css","purpose":"样式"}'},{"path":"app.js","purpose":"逻辑"}]}</plan>\n`
  const html =
    `<file path="index.html">\n<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<title>${name}</title>\n${options.omitCss ? '' : '<link rel="stylesheet" href="styles.css">'}\n</head>\n<body>\n<h1>${name}</h1>\n<p id="total">0</p>\n<script src="app.js"></script>\n</body>\n</html>\n</file>\n`
  const css = options.omitCss
    ? ''
    : `<file path="styles.css">\n:root { --accent: ${accent}; --radius: 14px; }\nbody { color: #16161A; }\nh1 { color: var(--accent); }\n</file>\n`
  const js = `<file path="app.js">\nconst KEY = 'nucleus:demo:v1';\nlet rows = [];\ntry { rows = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}\nfunction render() { document.getElementById('total').textContent = String(rows.length); }\nfunction add() { rows.push({ at: Date.now() }); try { localStorage.setItem(KEY, JSON.stringify(rows)); } catch (e) {} render(); }\ndocument.addEventListener('click', add);\nrender();\n</file>\n`
  return plan + html + css + js
}

/** 故意"引用了 app.js 却不输出它"的一轮：用来测补全轮。 */
export function nwfMissingJs(prompt: string): string {
  const name = nameFor(prompt)
  const accent = accentFor(prompt)
  return (
    `<plan>{"name":"${name}","summary":"缺一个文件的产物","stack":"HTML + CSS + JS","steps":["出结构"],"files":[{"path":"index.html","purpose":"入口"}]}</plan>\n` +
    `<file path="index.html">\n<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<title>${name}</title>\n<link rel="stylesheet" href="styles.css">\n</head>\n<body>\n<h1>${name}</h1>\n<button id="add">加一笔</button>\n<p id="total">0</p>\n<script src="app.js"></script>\n</body>\n</html>\n</file>\n` +
    `<file path="styles.css">\n:root { --accent: ${accent}; --radius: 14px; }\nh1 { color: var(--accent); }\n</file>\n`
  )
}

/** 只补 app.js 的一轮。 */
export function nwfJsOnly(): string {
  return `<file path="app.js">\nconst KEY = 'nucleus:demo:v1';\nlet rows = [];\ntry { rows = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}\nfunction render() { document.getElementById('total').textContent = String(rows.length); }\ndocument.getElementById('add').addEventListener('click', function () { rows.push(Date.now()); localStorage.setItem(KEY, JSON.stringify(rows)); render(); });\nrender();\n</file>\n`
}

export async function startFakeUpstream(
  build: (prompt: string) => string = nwfFor,
): Promise<FakeUpstream> {
  let mode: FakeMode = 'ok'
  const received: string[] = []
  let lastBody: FakeCall['body'] | null = null
  let count = 0

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      count++
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as FakeCall['body']
      } catch {
        lastBody = {}
      }
      const messages = lastBody?.messages ?? []
      const prompt = String(messages[messages.length - 1]?.content ?? '')
      received.push(prompt)

      if (mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      if (mode === 'quota') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
        res.end(JSON.stringify({ error: { message: 'rate limit' } }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })

      if (mode === 'empty') {
        // 上游活着但完全不按协议出码：应该被翻译成交互可见的 protocol_error
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '好的，我可以帮你做一个应用。' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      const text = build(prompt)
      const step = mode === 'slow' ? 24 : 220
      let index = 0
      const timer = setInterval(() => {
        if (index >= text.length) {
          res.write(`data: ${JSON.stringify({ usage: { total_tokens: 4321 } })}\n\n`)
          res.write('data: [DONE]\n\n')
          clearInterval(timer)
          res.end()
          return
        }
        const slice = text.slice(index, index + step)
        index += step
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: slice } }] })}\n\n`)
      }, mode === 'slow' ? 60 : 4)
      // 注意是 res 而不是 req：Node 的 IncomingMessage 在请求体读完就会 emit 'close'，
      // 挂在 req 上会让这个定时器立刻被清掉、响应永远不结束（客户端表现为超时挂死）。
      res.on('close', () => clearInterval(timer))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls: () => count,
    received: () => [...received],
    lastBody: () => lastBody,
    setMode: (next) => {
      mode = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
