import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite dev server with proxy for /api -> Flask backend
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
        // optional: logLevel: 'debug',
      }
    }
  }
})
