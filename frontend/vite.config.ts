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
        // Dev talks to PRODUCTION by default. Saved data (portfolios, screens,
        // recents) is account-scoped on the server, and the local backend keeps
        // its own users database, so a local login was a different account and
        // nothing ever followed you between dev, the live site and the desktop
        // app. Pointing dev at prod makes them one account.
        //
        // This means dev writes reach live data. Set VITE_API to work against a
        // local backend instead:
        //   VITE_API=local npm run dev
        //   VITE_API=http://127.0.0.1:9000 npm run dev
        target: apiTarget(),
        changeOrigin: true,
        secure: true,
        ws: true,
      },
    },
  },
}))

const LOCAL_API = 'http://127.0.0.1:8000'
const PROD_API = 'https://finance-terminal.fly.dev'

function apiTarget(): string {
  const v = (process.env.VITE_API || '').trim()
  if (!v) return PROD_API
  if (v === 'local') return LOCAL_API
  if (v === 'prod') return PROD_API
  return v
}
