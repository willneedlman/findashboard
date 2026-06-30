import { Component, type ReactNode, type ErrorInfo } from 'react'
import AlphaMark from './AlphaMark'
import { isChunkLoadError, reloadForChunkError } from '../lib/chunkReload'

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
      // Stale-chunk error after a deploy: reload is already firing in
      // componentDidCatch, so show a plain loading screen (never an error card).
      if (isChunkLoadError(this.state.error)) {
        return (
          <div aria-busy="true" style={{
            minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--theme-bg, #0a1628)', flexDirection: 'column', gap: 16, padding: 32,
          }}>
            <AlphaMark size={40} tile />
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)' }}>
              Loading…
            </div>
          </div>
        )
      }
      return (
        <div role="alert" aria-live="assertive" style={{
          minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--theme-bg, #0a1628)', flexDirection: 'column', gap: 16, padding: 32,
        }}>
          <AlphaMark size={40} tile />
          <div style={{ fontFamily: 'Cinzel, Georgia, serif', color: 'var(--theme-primary, #c9a84c)', fontSize: 18, fontWeight: 700, letterSpacing: '0.08em' }}>
            ALPHATAPE TERMINAL
          </div>
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid #8c2e36', padding: '16px 20px', maxWidth: 560, width: '100%' }}>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-negative, #ef4444)', marginBottom: 8 }}>
              Application Error
            </div>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '18px', wordBreak: 'break-all' }}>
              {this.state.error.message}
            </div>
          </div>
          <button
            onClick={() => { this.setState({ error: null }); window.location.href = '/app' }}
            style={{ background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)', padding: '8px 20px', cursor: 'pointer', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}
          >
            Return to Home
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
