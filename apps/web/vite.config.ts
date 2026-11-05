import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // changeOrigin must stay false: the server compares Origin to Host to block cross-site writes.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } } },
  // Older iPhones keep old iOS (and Safari) for years; don't ship syntax they can't parse.
  build: { target: ['es2020', 'safari14'] },
})
