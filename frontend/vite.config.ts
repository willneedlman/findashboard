import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// react-grid-layout v1 (via react-draggable/react-resizable) reads
// `process.env.NODE_ENV` inside its drag/resize handlers. Under Vite 8/Rolldown
// `process` is undefined in the browser, so without this define the handlers
// throw "process is not defined" and drag/resize silently abort.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(mode),
  },
  optimizeDeps: {
    include: ['react-grid-layout'],
    esbuildOptions: {
      define: {
        'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
}))
