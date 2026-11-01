import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 沙箱把系统临时目录重定向到了不可写的路径，这里把 Vite/vitest 的缓存
  // 固定到项目内的 node_modules，避免并行 worker 抢写缓存导致 EPERM。
  cacheDir: 'node_modules/.vite-vitest',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    fileParallelism: false,
    reporters: ['default'],
  },
})
