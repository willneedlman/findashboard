import { useState } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

const inp: React.CSSProperties = {
  background: T.surface,
  border: `1px solid ${T.border}`,
  color: T.text,
  fontFamily: T.mono,
  fontSize: 11,
  padding: '5px 8px',
  outline: 'none',
}

const GREEK_COLORS: Record<string, string> = {
  delta: '#60a5fa',
  gamma: '#22c55e',
  theta: '#ef4444',
  vega:  '#a78bfa',
}

interface PositionInput {
  id:            number
  ticker:        string
  strike:        string
  expiry:        string
  qty:           string
  option_type:   'call' | 'put'
  position_type: 'long' | 'short'
}

interface PositionResult {
  ticker:        string
  strike:        number
  expiry:        string
  qty:           number
  option_type:   string
  position_type: string
  spot:          number
  dte:           number
  delta:         number
  gamma:         number
  theta:         number
  vega:          number
  scaled_delta:  number
  scaled_gamma:  number
  scaled_theta:  number
  scaled_vega:   number
}

interface AggregateResult {
  positions: PositionResult[]
  net: { delta: number; gamma: number; theta: number; vega: number }
}

let _id = 0
const newPos = (): PositionInput => ({
  id: ++_id, ticker: '', strike: '', expiry: '', qty: '1', option_type: 'call', position_type: 'long',
})

function MetricCard({ label, value, color }: { label: string; value: number | null; color: string }) {
  const v = value ?? 0
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${color}30`,
      padding: '12px 16px',
      minWidth: 150,
    }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>
        Net {label}
      </div>
      <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 700, color }}>
        {v >= 0 ? '+' : ''}{v.toFixed(4)}
      </div>
    </div>
  )
}

export default function GreeksAggregator() {
  const [positions, setPositions] = useState<PositionInput[]>([newPos()])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)
  const [result,    setResult]    = useState<AggregateResult | null>(null)
  const [fetching,  setFetching]  = useState<Record<number, boolean>>({})

  const addRow = () => setPositions(p => [...p, newPos()])
  const removeRow = (id: number) => setPositions(p => p.filter(r => r.id !== id))

  const update = (id: number, field: keyof PositionInput, value: string) => {
    setPositions(p => p.map(r => r.id === id ? { ...r, [field]: value } : r))
  }

  const fetchSpot = async (id: number) => {
    const row = positions.find(r => r.id === id)
    if (!row?.ticker?.trim()) return
    setFetching(f => ({ ...f, [id]: true }))
    try {
      const res = await axios.get(`/api/market/history?ticker=${row.ticker.toUpperCase()}&start=2024-01-01`)
      const price: number | undefined = res.data?.metrics?.current_price
      if (price) {
        const atm = String(Math.round(price / 5) * 5)
        setPositions(p => p.map(r => r.id === id ? { ...r, strike: atm } : r))
      }
    } catch { /* ignore */ }
    setFetching(f => ({ ...f, [id]: false }))
  }

  const calculate = async () => {
    const valid = positions.filter(p => p.ticker && p.strike && p.expiry)
    if (!valid.length) { setError('Add at least one complete position.'); return }
    setLoading(true)
    setError(null)
    try {
      const payload = {
        positions: valid.map(p => ({
          ticker:        p.ticker.toUpperCase(),
          strike:        parseFloat(p.strike),
          expiry:        p.expiry,
          qty:           parseFloat(p.qty) || 1,
          option_type:   p.option_type,
          position_type: p.position_type,
        })),
      }
      const res = await axios.post('/api/options/aggregate-greeks', payload)
      setResult(res.data)
    } catch {
      setError('Calculation failed. Check your inputs.')
    } finally {
      setLoading(false)
    }
  }

  const selStyle: React.CSSProperties = {
    ...inp,
    appearance: 'none' as const,
    WebkitAppearance: 'none' as const,
  }

  return (
    <PageWrapper>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>

        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.gold, letterSpacing: '0.08em', margin: 0 }}>
            GREEKS AGGREGATOR
          </h1>
          <p style={{ fontFamily: T.label, fontSize: 11, color: T.muted, marginTop: 6 }}>
            Compute per-position and portfolio net greeks using Black-Scholes. Assumes 25% IV and 5% risk-free rate.
          </p>
        </div>

        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {['Ticker', 'Strike', 'Expiry', 'Qty', 'Type', 'Position', ''].map(h => (
                  <th key={h} style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, textAlign: 'left', padding: '6px 6px', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map(row => (
                <tr key={row.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ padding: '4px 6px' }}>
                    <div style={{ display: 'flex', gap: 3 }}>
                      <input value={row.ticker} onChange={e => update(row.id, 'ticker', e.target.value.toUpperCase())}
                        onKeyDown={e => e.key === 'Enter' && fetchSpot(row.id)}
                        placeholder="AAPL" maxLength={6} style={{ ...inp, width: 60 }} />
                      <button
                        onClick={() => fetchSpot(row.id)}
                        disabled={fetching[row.id] || !row.ticker.trim()}
                        title="Fetch live spot price → set ATM strike"
                        style={{
                          background: T.surface, border: `1px solid rgba(201,168,76,0.35)`,
                          color: fetching[row.id] ? T.muted : T.gold,
                          fontSize: 13, padding: '0 6px', cursor: fetching[row.id] ? 'default' : 'pointer',
                          flexShrink: 0, lineHeight: 1,
                        }}
                      >
                        {fetching[row.id] ? '…' : '↓'}
                      </button>
                    </div>
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <input value={row.strike} onChange={e => update(row.id, 'strike', e.target.value)} placeholder="150" type="number" style={{ ...inp, width: 80 }} />
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <input value={row.expiry} onChange={e => update(row.id, 'expiry', e.target.value)} placeholder="2025-12-19" type="date" style={{ ...inp, width: 130 }} />
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <input value={row.qty} onChange={e => update(row.id, 'qty', e.target.value)} type="number" min={1} style={{ ...inp, width: 60 }} />
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <select value={row.option_type} onChange={e => update(row.id, 'option_type', e.target.value)} style={{ ...selStyle, width: 60 }}>
                      <option value="call">Call</option>
                      <option value="put">Put</option>
                    </select>
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <select value={row.position_type} onChange={e => update(row.id, 'position_type', e.target.value)} style={{ ...selStyle, width: 70 }}>
                      <option value="long">Long</option>
                      <option value="short">Short</option>
                    </select>
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    <button onClick={() => removeRow(row.id)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, padding: 2 }}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
          <button onClick={addRow} style={{ ...inp, cursor: 'pointer', color: T.muted, fontSize: 10, letterSpacing: '0.06em' }}>
            + Add Position
          </button>
          <button
            onClick={calculate}
            disabled={loading}
            style={{
              background: loading ? T.surface : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
              border: `1px solid ${T.gold}60`,
              color: loading ? T.muted : T.gold,
              fontFamily: T.mono,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              padding: '5px 16px',
              cursor: loading ? 'not-allowed' : 'pointer',
              outline: 'none',
            }}
          >
            {loading ? 'COMPUTING…' : 'CALCULATE GREEKS'}
          </button>
        </div>

        {error && (
          <div style={{ background: 'rgba(239,68,68,0.08)', border: `1px solid rgba(239,68,68,0.3)`, color: T.neg, fontFamily: T.mono, fontSize: 11, padding: '8px 12px', marginBottom: 16 }}>
            {error}
          </div>
        )}

        {result && (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
              <MetricCard label="Delta"  value={result.net.delta} color={GREEK_COLORS.delta} />
              <MetricCard label="Gamma"  value={result.net.gamma} color={GREEK_COLORS.gamma} />
              <MetricCard label="Theta"  value={result.net.theta} color={GREEK_COLORS.theta} />
              <MetricCard label="Vega"   value={result.net.vega}  color={GREEK_COLORS.vega}  />
            </div>

            <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
              Per-Position Greeks
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                    {['Ticker', 'Strike', 'Expiry', 'DTE', 'Spot', 'Type', 'Pos', 'Qty',
                      'Delta', 'Gamma', 'Theta', 'Vega',
                      'Net Δ', 'Net Γ', 'Net Θ', 'Net ν'].map((h, i) => (
                      <th key={h} style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, textAlign: i === 0 ? 'left' : 'right', padding: '6px 8px', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.positions.map((pos, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                      <td style={{ padding: '7px 8px', color: T.gold, textAlign: 'left' }}>{pos.ticker}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', color: T.text }}>{pos.strike}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', color: T.text }}>{pos.expiry}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', color: T.muted }}>{pos.dte}d</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', color: T.text }}>{pos.spot.toFixed(2)}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', color: T.muted }}>{pos.option_type}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', color: pos.position_type === 'long' ? T.pos : T.neg }}>{pos.position_type}</td>
                      <td style={{ padding: '7px 8px', textAlign: 'right', color: T.text }}>{pos.qty}</td>
                      {(['delta', 'gamma', 'theta', 'vega'] as const).map(g => (
                        <td key={g} style={{ padding: '7px 8px', textAlign: 'right', color: GREEK_COLORS[g] }}>
                          {pos[g].toFixed(4)}
                        </td>
                      ))}
                      {(['scaled_delta', 'scaled_gamma', 'scaled_theta', 'scaled_vega'] as const).map(g => {
                        const v = pos[g]
                        const greek = g.replace('scaled_', '') as 'delta' | 'gamma' | 'theta' | 'vega'
                        return (
                          <td key={g} style={{ padding: '7px 8px', textAlign: 'right', color: GREEK_COLORS[greek], fontWeight: 600 }}>
                            {v >= 0 ? '+' : ''}{v.toFixed(4)}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                  <tr style={{ borderTop: `2px solid ${T.border}`, background: 'rgba(201,168,76,0.05)' }}>
                    <td colSpan={12} style={{ padding: '7px 8px', color: T.gold, fontWeight: 700, fontFamily: T.label, fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                      PORTFOLIO NET
                    </td>
                    {(['delta', 'gamma', 'theta', 'vega'] as const).map(g => {
                      const v = result.net[g]
                      return (
                        <td key={g} style={{ padding: '7px 8px', textAlign: 'right', color: GREEK_COLORS[g], fontWeight: 700 }}>
                          {v >= 0 ? '+' : ''}{v.toFixed(4)}
                        </td>
                      )
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </PageWrapper>
  )
}
