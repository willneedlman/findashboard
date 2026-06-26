// Timed-challenge mode + global leaderboard for the two MM simulators.
// Unlimited mode keeps the old free-play behavior (adjustable speed, no board);
// the 5-minute challenge locks the sim to 0.5x, counts down, and on time-out posts
// the trader's final Net P&L to the durable global leaderboard. Theme tokens only.
import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { useTheme } from '../contexts/ThemeContext'

const V = {
  surface: 'var(--theme-surface, #0d1826)',
  bg: 'var(--theme-bg, #101c2e)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  sec: 'var(--theme-secondary, #8099b0)',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
  mono: 'var(--theme-mono)',
  sans: 'var(--theme-sans)',
}

export type SimMode = 'unlimited' | 'challenge'
export const CHALLENGE_SECONDS = 300        // 5 minutes
export const CHALLENGE_SPEED = 0.5          // locked sim speed in challenge mode
const NAME_LS_KEY = 'mm-leaderboard-name'

interface BoardEntry { rank: number; name: string; score: number; created: number }

// ── Challenge clock + auto-end hook ──────────────────────────────────────────
// Counts down only while the desk is live; on reaching 0 it stops the sim and
// snapshots the final score. `getScore` is read through a ref so the value
// captured at time-out is the latest, not the one from when the timer started.
export function useChallenge(
  mode: SimMode,
  running: boolean,
  setRunning: (v: boolean) => void,
  getScore: () => number,
) {
  const [remaining, setRemaining] = useState(CHALLENGE_SECONDS)
  const [ended, setEnded] = useState(false)
  const [finalScore, setFinalScore] = useState(0)
  const scoreRef = useRef(getScore)
  scoreRef.current = getScore

  useEffect(() => {
    if (mode !== 'challenge' || !running || ended) return
    const id = setInterval(() => setRemaining(r => Math.max(0, r - 1)), 1000)
    return () => clearInterval(id)
  }, [mode, running, ended])

  useEffect(() => {
    if (mode === 'challenge' && running && !ended && remaining === 0) {
      setFinalScore(scoreRef.current())
      setEnded(true)
      setRunning(false)
    }
  }, [remaining, mode, running, ended, setRunning])

  const reset = useCallback(() => {
    setRemaining(CHALLENGE_SECONDS)
    setEnded(false)
    setFinalScore(0)
  }, [])

  return { remaining, ended, finalScore, reset }
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

// ── Mode toggle: [ Unlimited | 5-Min Challenge ] ─────────────────────────────
export function ModeToggle({ mode, onChange }: { mode: SimMode; onChange: (m: SimMode) => void }) {
  const opts: { id: SimMode; label: string }[] = [
    { id: 'unlimited', label: 'Unlimited' },
    { id: 'challenge', label: '5-Min Challenge' },
  ]
  return (
    <div style={{ display: 'flex', border: `1px solid ${V.border}`, marginBottom: 8 }}>
      {opts.map((o, i) => {
        const on = o.id === mode
        return (
          <button key={o.id} onClick={() => onChange(o.id)}
            style={{
              flex: 1, padding: '6px 0', fontFamily: V.sans, fontSize: 9, fontWeight: 700,
              letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
              background: on ? V.gold : 'transparent', color: on ? V.bg : V.sec, border: 'none',
              borderRight: i === 0 ? `1px solid ${V.border}` : 'none',
            }}>{o.label}</button>
        )
      })}
    </div>
  )
}

// ── Countdown readout that replaces the Sim Speed slider in challenge mode ────
export function ChallengeClock({ remaining, ended }: { remaining: number; ended: boolean }) {
  const low = remaining <= 30 && !ended
  return (
    <div style={{ marginBottom: 5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: V.sec, fontFamily: V.sans }}>Time Left</span>
        <span style={{ fontSize: 10, fontFamily: V.mono, color: V.sec }}>0.5x locked</span>
      </div>
      <div style={{ fontFamily: V.mono, fontSize: 26, fontWeight: 700, lineHeight: 1.1, color: ended ? V.sec : low ? V.neg : V.gold, fontVariantNumeric: 'tabular-nums' }}>
        {fmtClock(remaining)}
      </div>
    </div>
  )
}

// ── End-of-run leaderboard modal ─────────────────────────────────────────────
export function LeaderboardModal({ game, score, scoreLabel, fmtScore, onPlayAgain, onClose }: {
  game: string
  score: number
  scoreLabel: string
  fmtScore: (n: number) => string
  onPlayAgain: () => void
  onClose: () => void
}) {
  const { user } = useTheme()
  const [name, setName] = useState(() => user?.displayName || localStorage.getItem(NAME_LS_KEY) || '')
  const [board, setBoard] = useState<BoardEntry[]>([])
  const [rank, setRank] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    axios.get(`/api/leaderboard/${game}`).then(r => setBoard(r.data.top ?? [])).catch(() => {})
  }, [game])

  // Escape to dismiss; matches the dialog UX guidance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (submitting || submitted) return
    setSubmitting(true); setError('')
    try {
      const clean = (name.trim() || 'Anonymous').slice(0, 24)
      localStorage.setItem(NAME_LS_KEY, clean)
      const r = await axios.post(`/api/leaderboard/${game}`, { name: clean, score })
      setBoard(r.data.top ?? [])
      setRank(r.data.rank ?? null)
      setSubmitted(true)
    } catch {
      setError('Could not submit score. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const pos = score >= 0
  const btn = (color: string, fill: boolean): React.CSSProperties => ({
    flex: 1, padding: '9px 0', fontFamily: V.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase', cursor: 'pointer', color: fill ? V.bg : color,
    background: fill ? color : 'transparent', border: `1px solid ${color}`,
  })

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Challenge results"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(4,10,20,0.74)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(440px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: V.surface, border: `1px solid ${V.gold}`, boxShadow: '0 18px 60px rgba(0,0,0,0.6)' }}>

        {/* header */}
        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${V.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: V.sans, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: V.gold }}>Global Leaderboard</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: V.sec, cursor: 'pointer', fontFamily: V.mono, fontSize: 16, lineHeight: 1 }}>×</button>
        </div>

        {/* final score */}
        <div style={{ padding: '18px', textAlign: 'center', borderBottom: `1px solid ${V.border}` }}>
          <div style={{ fontFamily: V.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: V.sec }}>Final {scoreLabel}</div>
          <div style={{ fontFamily: V.mono, fontSize: 34, fontWeight: 700, color: pos ? V.pos : V.neg, lineHeight: 1.25, fontVariantNumeric: 'tabular-nums' }}>{fmtScore(score)}</div>
          {submitted && rank != null && (
            <div style={{ fontFamily: V.mono, fontSize: 12, color: V.gold, marginTop: 2 }}>You ranked #{rank} of all time</div>
          )}
        </div>

        {/* submit row */}
        {!submitted && (
          <div style={{ padding: '14px 18px', borderBottom: `1px solid ${V.border}` }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={name} onChange={e => setName(e.target.value)} maxLength={24} autoFocus
                placeholder="Your name" aria-label="Your name"
                onKeyDown={e => { if (e.key === 'Enter') submit() }}
                onFocus={e => (e.currentTarget.style.borderColor = V.gold)}
                onBlur={e => (e.currentTarget.style.borderColor = V.border)}
                style={{ flex: 1, fontFamily: V.mono, fontSize: 13, color: V.text, background: V.bg, border: `1px solid ${V.border}`, padding: '8px 10px', outline: 'none' }} />
              <button onClick={submit} disabled={submitting}
                style={{ ...btn(V.gold, true), flex: 'none', padding: '8px 16px', opacity: submitting ? 0.6 : 1 }}>
                {submitting ? '…' : 'Submit'}
              </button>
            </div>
            {error && <div role="alert" style={{ fontFamily: V.mono, fontSize: 10, color: V.neg, marginTop: 6 }}>{error}</div>}
          </div>
        )}

        {/* board */}
        <div style={{ padding: '6px 0' }}>
          {board.length === 0 ? (
            <div style={{ padding: '14px 18px', fontFamily: V.mono, fontSize: 12, color: V.sec }}>No scores yet. Be the first.</div>
          ) : board.map(e => {
            const mine = submitted && rank === e.rank && e.name === (name.trim() || 'Anonymous').slice(0, 24)
            return (
              <div key={`${e.rank}-${e.created}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 18px', background: mine ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent', borderLeft: `2px solid ${mine ? V.gold : 'transparent'}` }}>
                <span style={{ fontFamily: V.mono, fontSize: 12, fontWeight: 700, color: e.rank <= 3 ? V.gold : V.sec, width: 26 }}>#{e.rank}</span>
                <span style={{ fontFamily: V.sans, fontSize: 12, color: V.text, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
                <span style={{ fontFamily: V.mono, fontSize: 12, fontWeight: 700, color: e.score >= 0 ? V.pos : V.neg, fontVariantNumeric: 'tabular-nums' }}>{fmtScore(e.score)}</span>
              </div>
            )
          })}
        </div>

        {/* actions */}
        <div style={{ display: 'flex', gap: 8, padding: '14px 18px', borderTop: `1px solid ${V.border}` }}>
          <button onClick={onPlayAgain} style={btn(V.gold, false)}>Play Again</button>
          <button onClick={onClose} style={btn(V.sec, false)}>Close</button>
        </div>
      </div>
    </div>
  )
}
