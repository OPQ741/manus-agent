/**
 * 进程入口：读环境变量、起监听、装信号处理。
 *
 * 单独成文件是为了让 server/index.ts 变成"纯导出"——
 * 测试与脚本 import 它时不会被顺带启动一个占端口的服务。
 */

import { createNucleusServer, settingsView } from './index'

const PORT = Number(process.env.PORT ?? 8787)

async function main() {
  const { server, store, catalog } = await createNucleusServer()
  server.listen(PORT, '0.0.0.0', () => {
    const view = settingsView(store, catalog)
    const ready = catalog.entries.filter((entry) => entry.ready)
    const build = view.build
    console.log(
      `[nucleus] http://localhost:${PORT}  active=${view.active?.id ?? '(none)'}  ` +
        `free=${ready.some((entry) => entry.profile.free) ? 'on' : 'off'}  ` +
        `providers=${ready.map((entry) => entry.profile.id).join(',') || '(none)'}  ` +
        // 启动日志里就报出这是哪一次构建：排查"线上是哪一版"时不用再另开一个请求
        `build=${build.commit}${build.dirty ? '+' : ''}${build.builtAt ? `@${build.builtAt}` : ''}`,
    )
  })
  const shutdown = () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[nucleus] 启动失败', error)
  process.exit(1)
})
