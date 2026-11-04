/**
 * 对外入口 —— 只做再导出，保持 `import { createNucleusServer } from './index'` 不变。
 *
 * 实际实现在 app.ts（组装）与 http/ routes/ services/（传输、接口、业务）。
 * 保留这个文件名有两个具体理由：tests/server.test.ts、scripts/make-factory.ts、
 * server/main.ts 都从这里取工厂函数，改名等于把"重构"变成"改调用方"。
 *
 * 注意：这个模块**只导出工厂函数**，导入即启动是一类难查的副作用 ——
 * 脚本和测试只要 import 就会顺带占掉 8787 端口（真踩过：EADDRINUSE
 * 出现在完全无关的调用栈里）。
 */

export { createNucleusServer, type ServerOptions } from './app'
export { settingsView } from './services/settings-view'
