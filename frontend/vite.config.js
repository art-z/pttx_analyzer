import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        lite: resolve(__dirname, 'lite.html'),
      },
    },
  },
  server: {
    proxy: {
      '/analyze': apiProxyTarget,
      '/create-presentation': apiProxyTarget,
      '/prompts': apiProxyTarget,
      '/jobs': apiProxyTarget,
      '/fonts': apiProxyTarget
    }
  }
})
