import { Component, type ReactNode, type ErrorInfo } from 'react'
import AlphaMark from './AlphaMark'

const RELOAD_KEY = 'at-chunk-reload-at'

function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null
  const msg = e?.message || ''
  return (
    e?.name === 'ChunkLoadError' ||
    /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i.test(msg)
  )
}

// A new deploy rotates the content-hashed chunk filenames, so a tab still
// running the previous index.html requests assets that no longer exist. Reload
// once to pull the fresh manifest. The 8s guard breaks the loop if the asset is
// genuinely unreachable (rollback, CDN miss) so the user sees a real error
// instead of a reload storm.
function reloadForChunkError(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - last > 8000) {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
      window.location.reload()
      return true
    }
  } catch { /* sessionStorage unavailable */ }
  return false
}

interface Props { children: ReactNode }
interface State { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidMount() {
    window.addEventListener('vite:preloadError', this.onPreloadError as EventListener)
  }

  componentWillUnmount() {
    window.removeEventListener('vite:preloadError', this.onPreloadError as EventListener)
  }

  onPreloadError = (e: Event) => {
    e.preventDefault()
    reloadForChunkError()
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkLoadError(error)) {
      reloadForChunkError()
      return
    }
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      const stale = isChunkLoadError(this.state.error)
      return (
        <div role="alert" aria-live="assertive" style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--theme-bg, #0a1628)', flexDirection: 'column', gap: 16, padding: 32,
        }}>
          <AlphaMark size={40} tile />
          <div style={{ fontFamily: 'Cinzel, Georgia, serif', color: 'var(--theme-primary, #c9a84c)', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em' }}>
            ALPHATAPE TERMINAL
          </div>
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: `1px solid ${stale ? 'var(--theme-primary, #c9a84c)' : '#8c2e36'}`, padding: '16px 20px', maxWidth: 560, width: '100%' }}>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: stale ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-negative, #ef4444)', marginBottom: 8 }}>
              {stale ? 'Updating' : 'Application Error'}
            </div>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '18px', wordBreak: 'break-all' }}>
              {stale ? 'A new version is live. Reloading to update.' : this.state.error.message}
            </div>
          </div>
          <button
            onClick={() => {
              if (stale) { window.location.reload(); return }
              this.setState({ error: null }); window.location.href = '/app'
            }}
            style={{ background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)', padding: '8px 20px', cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}
          >
            {stale ? 'Reload now' : 'Return to Home'}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
