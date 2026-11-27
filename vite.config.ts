import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// PWA plugin is added in Phase 3.
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5190, strictPort: true },
  preview: { host: '127.0.0.1', port: 5191, strictPort: true },
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), sheet: resolve(__dirname, 'dev/sheet.html') },
    },
  },
})
