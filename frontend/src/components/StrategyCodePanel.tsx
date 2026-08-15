import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { T } from '../lib/theme'
import type { StrategySetup } from './CustomStrategyModal'
import { MONO, SANS, mix } from '../pages/cockpitKit'

// Build with Code — the editor and the copilot side by side, in the strategy
// drawer where there is room for them. It lived in the 204px sidebar first and
// was unusable there: eighteen lines of Python in a column narrow enough to
// truncate every one of them.
//
// The code is part of the strategy definition (def.code / def.useCode), not a
// transient arming flag, so a code strategy is saved, reloaded and re-run like
// any other.

interface Diagnostic { level: string; severity: 'error' | 'warning'; message: string; line: number | null }
interface CompileResult {
  ok: boolean; source: string | null
  warmup?: { entries: number; exits: number }
  unsupported?: string; diagnostics: Diagnostic[]
}
interface GenResult {
  ok: boolean; source: string | null; diagnostics: Diagnostic[]
  attempts: number; intent: string; explanation: string | null
  /** The request needs data that has not happened yet. No code is written. */
  infeasible?: boolean
  /** Ticker, instrument and book the request named. `signal()` cannot express
   *  any of it — it is engine config — so it arrives separately and is saved
   *  onto the strategy. */
  setup?: StrategySetup
}
type Msg = { role: 'user' | 'assistant'; content: string }

const LEVEL_LABEL: Record<string, string> = {
  L0: 'Syntax', L1: 'Safety', L2: 'Contract', L3: 'Lookahead',
  L4: 'Warmup', L5: 'Determinism', L6: 'Sanity', L7: 'Mismatch', compile: 'Compile',
}

const KW = /(#.*$)|("""[\s\S]*?"""|'[^']*'|"[^"]*")|\b(def|return|if|else|elif|for|while|in|not|and|or|None|True|False|lambda)\b|\b(\d+\.?\d*)\b|\b(ind|np|c|Signals)\b/g

function highlight(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  KW.lastIndex = 0
  while ((m = KW.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index))
    const [tok, comment, str, kw, num, ns] = m
    const color = comment ? T.muted : str ? 'var(--theme-positive-strong, #15803D)'
      : kw ? 'var(--theme-tertiary, #60a5fa)' : num ? T.warn : ns ? T.gold : T.text
    out.push(<span key={m.index} style={{ color, fontStyle: comment ? 'italic' : undefined }}>{tok}</span>)
    last = m.index + tok.length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

/** Human summary of a setup patch, so applying it is never a silent change. */
function describeSetup(s: StrategySetup): string[] {
  const out: string[] = []
  if (s.ticker) out.push(`ticker ${s.ticker}`)
  if (s.side) out.push(s.side)
  if (s.instMode === 'option') {
    // otmPct is signed distance out of the money, so a negative value is IN the
    // money. Printing "-20% OTM" is technically right and reads as a mistake.
    const money = s.otmPct == null || s.otmPct === 0 ? 'ATM'
      : s.otmPct > 0 ? `${s.otmPct}% OTM` : `${Math.abs(s.otmPct)}% ITM`
    out.push(`${s.optType ?? 'call'} option ${money}${s.dte ? `, ${s.dte} DTE` : ''}`)
  } else if (s.instMode === 'combo') {
    out.push(`${s.comboLegs?.length ?? 0}-leg combo${s.comboDte ? `, ${s.comboDte} DTE` : ''}`)
  } else if (s.instMode === 'underlying') {
    out.push('shares')
  }
  if (s.timeframe && s.timeframe !== '1d') out.push(s.timeframe)
  if (s.positions?.length) out.push(`${s.positions.length}-name book`)
  if (s.portfolioTradeSize) out.push(`${s.portfolioTradeSize}% per position`)
  return out
}

export default function StrategyCodePanel({ rules, name, code, useCode, setup, onChange }: {
  /** The rule blocks, compiled to Python as the starting point. */
  rules: { buy: unknown; sell: unknown } | null
  name: string
  code: string | undefined
  useCode: boolean | undefined
  /** Current ticker/instrument/window, sent so a follow-up is read as a patch. */
  setup: StrategySetup | undefined
  onChange: (patch: { code?: string; useCode?: boolean; setup?: StrategySetup }) => void
}) {
  const [compiled, setCompiled] = useState<CompileResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [chat, setChat] = useState<Msg[]>([])
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<Diagnostic[] | null>(null)
  const [copied, setCopied] = useState(false)
  const gutRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const body = useMemo(
    () => (rules ? { rules: { buy: rules.buy, sell: rules.sell }, name } : null),
    [rules, name],
  )

  // Compile the blocks once, to seed the editor and to offer as a reset target.
  // Deliberately not a useQuery: this must not refetch while you type.
  useEffect(() => {
    if (!body) return
    let cancelled = false
    setLoading(true)
    axios.post('/api/strategy/compile', body)
      .then(r => { if (!cancelled) setCompiled(r.data) })
      .catch(() => { if (!cancelled) setCompiled(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [body])

  const source = code ?? compiled?.source ?? ''
  const fromRules = compiled?.source ?? ''
  const edited = code != null && code !== fromRules
  const diagnostics = checked ?? compiled?.diagnostics ?? []
  const errors = diagnostics.filter(d => d.severity === 'error')
  const warns = diagnostics.filter(d => d.severity === 'warning')

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }) }, [chat])

  const setSource = (next: string) => { onChange({ code: next }); setChecked(null) }

  const check = async () => {
    if (!source) return
    setChecking(true)
    try {
      const { data } = await axios.post('/api/strategy/compile', { source, check: true })
      setChecked(data.diagnostics ?? [])
    } catch {
      setChecked([{ level: 'compile', severity: 'error', message: 'Validation request failed.', line: null }])
    }
    setChecking(false)
  }

  const ask = async () => {
    const p = prompt.trim()
    if (!p || busy) return
    setBusy(true); setPrompt('')
    const next: Msg[] = [...chat, { role: 'user', content: p }]
    setChat(next)
    try {
      const { data } = await axios.post<GenResult>('/api/strategy/generate', {
        prompt: p, source: source || undefined, history: chat.slice(-8), name,
        setup: setup ?? undefined,
      })
      if (data.infeasible) {
        // A refusal never touches the editor: whatever is there still runs, and
        // nothing was quietly written in place of what was asked for.
        setChat([...next, { role: 'assistant', content: data.explanation ?? 'That is not backtestable.' }])
      } else if (data.explanation) {
        setChat([...next, { role: 'assistant', content: data.explanation }])
      } else if (data.source) {
        // Setup and code land together: the request named both what to trade
        // and when, and applying only half of it would leave the strategy
        // pointing at whatever ticker happened to be loaded.
        // The reply is a PATCH over the current setup, so merge rather than
        // replace — otherwise a message that only changes the option type would
        // wipe the ticker and expiry it never mentioned.
        const patch = data.setup && Object.keys(data.setup).length ? data.setup : undefined
        const merged = patch ? { ...(setup ?? {}), ...patch } : undefined
        onChange({ code: data.source, ...(merged ? { setup: merged } : {}) })
        setChecked(data.diagnostics ?? [])
        const changes = patch ? describeSetup(patch) : []
        setChat([...next, {
          role: 'assistant',
          content: [
            data.ok
              ? `Done${data.attempts > 1 ? `, after ${data.attempts} attempts, the first of which failed validation` : ''}.`
              : `Could not get this past validation in ${data.attempts} attempts. It is in the editor with its errors.`,
            changes.length ? `Setup: ${changes.join(' · ')}. Saved with the strategy.` : '',
          ].filter(Boolean).join('\n'),
        }])
      }
    } catch (e: any) {
      setChat([...next, { role: 'assistant', content: e?.response?.data?.detail ?? 'Request failed.' }])
    }
    setBusy(false)
  }

  const lines = source.split('\n')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontFamily: SANS, fontSize: 10.5, color: T.muted, lineHeight: 1.6 }}>
        Your rule blocks compiled to Python. Edit it, or describe a change below and the assistant
        rewrites it. Everything it writes is checked for lookahead bias, indicator warmup and
        whether it actually matches what you asked for.
      </div>

      {/* Run-with-code switch. Saved on the strategy, so it survives a reload. */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer',
        border: `1px solid ${useCode ? T.gold : T.border}`,
        background: useCode ? mix(T.gold, 8) : 'transparent',
      }}>
        <input type="checkbox" checked={!!useCode}
          disabled={!source || errors.length > 0}
          onChange={e => onChange({ useCode: e.target.checked, code: source })}
          style={{ accentColor: T.gold }} />
        <span style={{ fontFamily: SANS, fontSize: 11, color: T.text }}>
          Backtest this code instead of the rule blocks
        </span>
        {errors.length > 0 && (
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: T.neg, marginLeft: 'auto' }}>
            fix {errors.length} error{errors.length > 1 ? 's' : ''} first
          </span>
        )}
      </label>

      {loading && <div style={note}>Compiling…</div>}
      {compiled?.unsupported && (
        <div style={{ ...note, color: T.warn }}>
          No code equivalent yet: {compiled.unsupported}
          <div style={{ color: T.muted, marginTop: 4 }}>The rule blocks keep working, unchanged.</div>
        </div>
      )}

      {(errors.length > 0 || warns.length > 0) && (
        <div style={{ border: `1px solid ${T.border}` }}>
          {[...errors, ...warns].map((d, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline', gap: 9, padding: '7px 11px',
              borderTop: i ? `1px solid ${T.borderFaint}` : 'none',
              background: d.severity === 'error' ? mix(T.neg, 7) : 'transparent',
            }}>
              <span style={{
                fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em',
                textTransform: 'uppercase', whiteSpace: 'nowrap',
                color: d.severity === 'error' ? T.neg : T.warn,
              }}>{LEVEL_LABEL[d.level] ?? d.level}{d.line ? ` L${d.line}` : ''}</span>
              <span style={{ fontFamily: SANS, fontSize: 11, color: T.text, lineHeight: 1.5 }}>{d.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Editor */}
      <div style={{ border: `1px solid ${T.border}` }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
          background: T.surface, borderBottom: `1px solid ${T.border}`,
        }}>
          <span style={{
            fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: T.text,
          }}>signal(c)</span>
          {edited && <span style={{ fontFamily: MONO, fontSize: 9, color: T.warn }}>edited</span>}
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, color: T.textDim }}>
            warmup {compiled?.warmup?.entries ?? 0}/{compiled?.warmup?.exits ?? 0} bars
          </span>
        </div>

        <div style={{ display: 'flex', maxHeight: 380, overflow: 'auto' }}>
          <div ref={gutRef} style={{
            flexShrink: 0, padding: '10px 10px 10px 8px', textAlign: 'right', userSelect: 'none',
            fontFamily: MONO, fontSize: 12, lineHeight: '20px', color: T.textDim,
            background: T.surface, borderRight: `1px solid ${T.borderFaint}`,
          }}>
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            {/* Highlighted layer under a transparent textarea — same text, same
                metrics, so the caret lands where it looks like it should. */}
            <pre aria-hidden style={{
              margin: 0, padding: 10, fontFamily: MONO, fontSize: 12, lineHeight: '20px',
              whiteSpace: 'pre', pointerEvents: 'none', minHeight: 200,
            }}>
              {lines.map((ln, i) => <div key={i}>{highlight(ln) as any}{ln === '' ? '​' : ''}</div>)}
            </pre>
            <textarea
              value={source}
              spellCheck={false}
              onChange={e => setSource(e.target.value)}
              onScroll={e => { if (gutRef.current) gutRef.current.scrollTop = e.currentTarget.scrollTop }}
              onKeyDown={e => {
                // Tab indents instead of leaving the field — a code editor that
                // loses focus on Tab is unusable for anything but one-liners.
                if (e.key === 'Tab') {
                  e.preventDefault()
                  const el = e.currentTarget
                  const { selectionStart: a, selectionEnd: b } = el
                  const next = source.slice(0, a) + '    ' + source.slice(b)
                  setSource(next)
                  requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 4 })
                }
              }}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                padding: 10, margin: 0, border: 'none', outline: 'none', resize: 'none',
                fontFamily: MONO, fontSize: 12, lineHeight: '20px', whiteSpace: 'pre',
                background: 'transparent', color: 'transparent', caretColor: T.text,
                overflow: 'hidden',
              }} />
          </div>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '7px 10px', borderTop: `1px solid ${T.border}`, background: T.surface,
        }}>
          <button onClick={() => void check()} disabled={checking || !source} style={btn}>
            {checking ? 'Checking…' : 'Validate'}
          </button>
          {edited && (
            <button onClick={() => { onChange({ code: undefined, useCode: false }); setChecked(null) }} style={btn}>
              Reset to rules
            </button>
          )}
          <button
            onClick={() => { void navigator.clipboard?.writeText(source); setCopied(true); window.setTimeout(() => setCopied(false), 1500) }}
            style={{ ...btn, marginLeft: 'auto', color: copied ? T.pos : T.muted }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Copilot */}
      <div style={{ border: `1px solid ${T.border}` }}>
        <div style={{
          padding: '6px 10px', background: T.surface, borderBottom: `1px solid ${T.border}`,
          fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.text,
        }}>Copilot</div>
        <div style={{ maxHeight: 200, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {chat.length === 0 && (
            <div style={{ fontFamily: SANS, fontSize: 10.5, color: T.muted, lineHeight: 1.6 }}>
              Try "use a 50/200 crossover instead", "tighten the RSI threshold to 25",
              or "explain what this does".
            </div>
          )}
          {chat.map((m, i) => (
            <div key={i} style={{
              fontFamily: SANS, fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap',
              color: m.role === 'user' ? T.text : T.muted,
              borderLeft: `2px solid ${m.role === 'user' ? T.gold : T.border}`, paddingLeft: 9,
            }}>{m.content}</div>
          ))}
          <div ref={chatEndRef} />
        </div>
        <div style={{ display: 'flex', gap: 6, padding: 10, borderTop: `1px solid ${T.borderFaint}` }}>
          <input value={prompt} onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void ask() }}
            placeholder="Describe a strategy or a change..."
            style={{
              flex: 1, background: T.bg, border: `1px solid ${T.border}`, color: T.text,
              fontFamily: MONO, fontSize: 11.5, padding: '7px 9px', outline: 'none', minWidth: 0,
            }} />
          <button onClick={() => void ask()} disabled={busy || !prompt.trim()} style={{
            background: T.gold, border: 'none', color: T.bg, cursor: busy ? 'wait' : 'pointer',
            fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', padding: '0 16px', opacity: busy || !prompt.trim() ? 0.5 : 1,
          }}>{busy ? '…' : 'Send'}</button>
        </div>
      </div>
    </div>
  )
}

const note: React.CSSProperties = { padding: 12, fontFamily: SANS, fontSize: 11, color: T.muted, lineHeight: 1.6, border: `1px solid ${T.border}` }
const btn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer',
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '5px 12px',
}
