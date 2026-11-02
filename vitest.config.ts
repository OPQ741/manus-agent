import { defineConfig } from 'vitest/config'

/**
 * 缓存目录带进程内时间戳：每次运行都是全新的 transform 缓存。
 *
 * 为什么不用固定目录：集成测试会真起 HTTP 服务并断言服务端行为，一旦命中
 * 改动前的旧 transform 缓存，表现就是"代码明明改了但测试还是老结果"——
 * 这是最误导人的一类假绿/假红。固定目录是为了绕开沙箱不可写的系统临时目录，
 * 所以仍然留在项目内，只是名字每次不同。
 */
const runCacheDir = `node_modules/.vite-vitest-${process.pid}`

export default defineConfig({
  cacheDir: runCacheDir,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    fileParallelism: false,
    reporters: ['default'],
    isolate: true,
  },
})
