import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API_TARGET = process.env.NUCLEUS_API ?? 'http://127.0.0.1:8787'
const ROOT = fileURLToPath(new URL('.', import.meta.url))

/**
 * 构建指纹由 scripts/build-meta.mjs 提前算好。
 *
 * 读不到（例如只跑了 `vite build` 而没走 `npm run build`）时给一份 dev 兜底，
 * 而不是抛错 —— 少一次构建信息，不该让整个前端构建失败。
 */
function readBuildMeta() {
  try {
    return JSON.parse(readFileSync(`${ROOT}.tmp-build/meta.json`, 'utf8'))
  } catch {
    return {
      version: '0.0.0',
      commit: 'unknown',
      commitFull: 'unknown',
      branch: 'unknown',
      dirty: false,
      builtAt: '',
    }
  }
}

const BUILD = readBuildMeta()

export default defineConfig({
  plugins: [react()],
  define: {
    /**
     * 只把提交信息注入前端，不注入构建时间。
     *
     * 构建时间每次构建都不同，一旦进了 bundle，同一份源码产出的文件名（内容哈希）
     * 每次都会变：缓存全失效，而且"资源名相同 = 同版"这个判据永远不成立。
     * 构建时间由服务端从 dist/build.json 提供，前端没必要自己存一份。
     */
    __BUILD__: JSON.stringify({ commit: BUILD.commit, commitFull: BUILD.commitFull }),
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2020',
    // antd 组件库本身就有几百 KB：拆成稳定 vendor 包，业务代码改动时浏览器缓存不失效
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
})
