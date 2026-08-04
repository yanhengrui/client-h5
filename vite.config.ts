import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const gate = process.env.VITE_GATE_PROXY ?? 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: gate, changeOrigin: true },
      '/ws': { target: gate.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
})
