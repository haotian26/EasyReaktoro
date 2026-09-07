import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative assets are required by Tauri's release custom protocol. Absolute
  // `/assets/...` URLs produce a blank WebView outside the Vite dev server.
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: { strictPort: true, port: 1420 },
})
