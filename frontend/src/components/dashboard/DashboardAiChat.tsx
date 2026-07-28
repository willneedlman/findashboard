import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { Sparkles, X, RefreshCw } from 'lucide-react'
import {
  WIDGET_LABELS, WIDGET_DESCRIPTIONS, WIDGET_DEFAULT_SIZE, WIDGET_MIN_SIZES,
  WIDGET_DEFINITIONS, TICKER_WIDGET_TYPES, type WidgetType, type WidgetConfig, type AiDashboardItem,
} from '../../hooks/useDashboard'

// AI dashboard architect — mirrors the options / algo strategy chat. The user
// describes what they want to monitor or trade; the model chooses widgets, sizes
// them, and arranges them, then the user applies it (replace / add / new tab).

type Msg = { role: 'user' | 'assistant'; content: string }
type DraftItem = { type: WidgetType; config?: Partial<WidgetConfig>; w?: number; h?: number }
type Draft = { name: string; action: 'replace' | 'append' | 'new'; summary: string; items: DraftItem[] }

// Built from the live widget registry so it can never drift from what exists.
const CATALOG = (Object.keys(WIDGET_LABELS) as WidgetType[])
  .filter(t => t !== 'ticker-control')
  .map(t => ({
    type: t, label: WIDGET_LABELS[t], description: WIDGET_DESCRIPTIONS[t],
    defW: WIDGET_DEFAULT_SIZE[t].w, defH: WIDGET_DEFAULT_SIZE[t].h,
    minW: WIDGET_MIN_SIZES[t]?.minW ?? 1, minH: WIDGET_MIN_SIZES[t]?.minH ?? 1,
    ticker: TICKER_WIDGET_TYPES.includes(t),
    category: WIDGET_DEFINITIONS[t].category,
    purpose: WIDGET_DEFINITIONS[t].purpose,
    dataType: WIDGET_DEFINITIONS[t].dataType,
    priority: WIDGET_DEFINITIONS[t].priority,
    region: WIDGET_DEFINITIONS[t].region,
    compatible: WIDGET_DEFINITIONS[t].compatible,
    related: WIDGET_DEFINITIONS[t].related,
    conflicts: WIDGET_DEFINITIONS[t].conflicts,
    configOptions: WIDGET_DEFINITIONS[t].configOptions,
    multiple: WIDGET_DEFINITIONS[t].multiple,
  }))
const VALID = new Set<string>(CATALOG.map(c => c.type))

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.10))', text: 'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #99907e)', dim: 'var(--theme-text-faint, rgba(255,255,255,0.3))',
  gold: 'var(--theme-primary, #c9a84c)', neg: 'var(--theme-negative, #e05c6e)', mono: 'var(--theme-mono, monospace)',
  sans: 'var(--theme-sans, sans-serif)',
}
const chip = (on: boolean): React.CSSProperties => ({
  background: on ? T.gold : 'transparent', border: `1px solid ${on ? T.gold : T.border}`,
  color: on ? 'var(--theme-bg)' : T.muted, fontFamily: T.sans, fontSize: 9.5, fontWeight: 700,
  letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 11px', cursor: 'pointer',
})
const ADJ: Record<string, string> = { replace: 'Replace', append: 'Add', new: 'New tab' }

export default function DashboardAiChat({
  current, applyAiDashboard, onClose,
}: {
  current: WidgetConfig[]
  applyAiDashboard: (items: AiDashboardItem[], mode: 'replace' | 'append' | 'new', name?: string) => void
  onClose: () => void
}) {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [mode, setMode] = useState<'replace' | 'append' | 'new'>('replace')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight }, [messages, pending])

  const send = async (text: string) => {
    if (!text.trim() || pending) return
    const next: Msg[] = [...messages, { role: 'user', content: text.trim() }]
    setMessages(next); setInput(''); setError(''); setPending(true); setDraft(null)
    try {
      const { data } = await axios.post('/api/ai/dashboard-chat', {
        messages: next,
        catalog: CATALOG,
        current: current.map(w => ({ type: w.type, ticker: w.ticker, title: w.title })),
        cols: 12,
      })
      if (data?.type === 'draft' && Array.isArray(data.items)) {
        const items: DraftItem[] = data.items.filter((it: DraftItem) => VALID.has(it.type))
        if (!items.length) { setMessages(m => [...m, { role: 'assistant', content: 'I could not turn that into widgets — try naming a theme or ticker.' }]); return }
        const d: Draft = {
          name: String(data.name || 'AI Dashboard'),
          action: (['replace', 'append', 'new'].includes(data.action) ? data.action : 'replace'),
          summary: String(data.summary || ''),
          items,
        }
        setDraft(d); setMode(d.action)
        setMessages(m => [...m, { role: 'assistant', content: d.summary || `Proposed ${items.length} widgets.` }])
      } else {
        setMessages(m => [...m, { role: 'assistant', content: data?.text || 'Could you clarify what this dashboard should show?' }])
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Request failed')
    } finally { setPending(false) }
  }

  const apply = () => {
    if (!draft) return
    applyAiDashboard(draft.items.map(it => ({ type: it.type, config: it.config, w: it.w, h: it.h })), mode, draft.name)
    onClose()
  }

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="AI dashboard builder"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(560px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: T.surface, border: `1px solid color-mix(in srgb, var(--theme-primary) 34%, transparent)`, borderRadius: 8, boxShadow: '0 24px 70px rgba(0,0,0,0.55)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: T.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>
            <Sparkles size={13} /> Build with AI
          </span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.muted }}><X size={16} /></button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div ref={listRef} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto' }}>
            {messages.length === 0 && (
              <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.dim, lineHeight: 1.6, fontStyle: 'italic' }}>
                Describe the dashboard. e.g. "a macro cockpit for rates and credit", "options flow + GEX + vol skew for NVDA", "portfolio risk and P&L", or "add a heatmap and a news feed".
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '86%' }}>
                <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginBottom: 2, letterSpacing: '0.08em', textTransform: 'uppercase', textAlign: m.role === 'user' ? 'right' : 'left' }}>{m.role === 'user' ? 'You' : 'AI'}</div>
                <div style={{ fontSize: 11, fontFamily: T.sans, lineHeight: 1.5, padding: '6px 9px', whiteSpace: 'pre-wrap', color: T.text, background: m.role === 'user' ? `color-mix(in srgb, var(--theme-primary) 12%, transparent)` : T.bg, border: `1px solid ${m.role === 'user' ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : T.border}` }}>{m.content}</div>
              </div>
            ))}
            {pending && <div style={{ fontSize: 9.5, color: T.dim, fontFamily: T.mono, fontStyle: 'italic' }}>Designing…</div>}
          </div>

          {draft && (
            <div style={{ border: `1px solid color-mix(in srgb, var(--theme-primary) 40%, transparent)`, background: `color-mix(in srgb, var(--theme-primary) 6%, transparent)`, padding: '10px 12px' }}>
              <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, fontFamily: T.sans, marginBottom: 7 }}>
                {draft.name} · {draft.items.length} widgets
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                {draft.items.map((it, i) => (
                  <span key={i} style={{ fontFamily: T.mono, fontSize: 9, color: T.text, border: `1px solid ${T.border}`, padding: '2px 6px' }}>
                    {WIDGET_LABELS[it.type]}{it.config?.ticker ? ` · ${it.config.ticker}` : ''}
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: T.sans, fontSize: 8.5, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Apply as</span>
                {(['replace', 'append', 'new'] as const).map(m => (
                  <button key={m} onClick={() => setMode(m)} style={chip(mode === m)}>{ADJ[m]}</button>
                ))}
                <button onClick={apply} style={{ ...chip(true), marginLeft: 'auto', padding: '5px 14px' }}>Apply</button>
                <button onClick={() => { setDraft(null); send(messages.filter(m => m.role === 'user').slice(-1)[0]?.content ?? '') }} title="Try again" style={{ background: 'none', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', padding: 5 }}><RefreshCw size={12} /></button>
              </div>
            </div>
          )}

          {error && <div style={{ fontSize: 10, color: T.neg, fontFamily: T.mono }}>{error}</div>}

          <div style={{ display: 'flex', gap: 6 }}>
            <input value={input} onChange={e => setInput(e.target.value)} autoFocus
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
              placeholder={messages.length ? 'Refine or ask for changes…' : 'Describe your dashboard…'}
              disabled={pending}
              style={{ flex: 1, background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.sans, fontSize: 12, padding: '8px 10px', outline: 'none' }} />
            <button onClick={() => send(input)} disabled={pending || !input.trim()}
              style={{ ...chip(true), padding: '8px 14px', opacity: (pending || !input.trim()) ? 0.5 : 1 }}>Send</button>
          </div>
        </div>
      </div>
    </div>
  )
}
