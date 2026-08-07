import { useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { KpiCell } from '../components/mmCockpit'
import { fetchOptionsChain } from '../hooks/useApi'
import { syntheticChains } from '../lib/syntheticChain'
import { useChartColors } from '../hooks/useChartColors'
import { T } from '../lib/theme'
import { MONO, SANS, mix } from './cockpitKit'
import { TOOLTIP_STYLE, TICK } from './valuationShared'

// DEMO — evaluating whether Chain Scanner (/chain) and Options Flow
// (/unusual-options) should be one tool. Both originals are untouched.
//
// The case for merging is not just UX. Flow is a SCREEN over contracts and the
// chain is the LADDER those contracts live in — two stages of one question
// ("what moved, and where does it sit?"). Today you read a flow row, then
// retype the ticker into Chain Scanner and hunt for the strike by eye.
//
// The data layer settles it. `/api/options/chain` already returns volume and
// open interest per contract, which is the ENTIRE input to the unusual screen.
// So one chain load per ticker/expiry feeds both halves and the flow filter
// becomes client-side arithmetic — no second vendor, no second round trip.
// That also sidesteps a live outage: /api/options/unusual is Tradier-only and
// is currently returning 401 Unauthorized, so Options Flow shows "no contracts
// cleared the thresholds" when it actually failed to fetch anything.

interface Contract {
  strike: number
  lastPrice?: number | null
  bid?: number | null
  ask?: number | null
  volume?: number | null
  openInterest?: number | null
  impliedVolatility?: number | null
}
interface Chain {
  ticker: string
  expiry: string
  expirations: string[]
  spot: number | null
  calls: Contract[]
  puts: Contract[]
}
interface FlowRow {
  ticker: string; expiry: string; dte: number
  type: 'call' | 'put'
  strike: number; spot: number | null; moneyness: number | null
  volume: number; openInterest: number; volOiRatio: number
  iv: number; mid: number; premium: number
}

const TICKER_CAP = 6   // yfinance runs on a 2-slot semaphore; keep the demo honest about that

const usd = (v: number) => `$${v.toFixed(2)}`
const fmtNum = (n: number) => n.toLocaleString('en-US')
const fmtPremium = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`

const dteOf = (expiry: string) => {
  const d = new Date(`${expiry}T00:00:00`)
  const t = new Date(); t.setHours(0, 0, 0, 0)
  return Math.max(0, Math.round((+d - +t) / 86_400_000))
}

/** The unusual screen, applied to chain rows. Mirrors the backend's own rule. */
function deriveFlow(chains: Chain[], minVolume: number, minVolOi: number): FlowRow[] {
  const out: FlowRow[] = []
  for (const ch of chains) {
    const dte = dteOf(ch.expiry)
    for (const [type, list] of [['call', ch.calls], ['put', ch.puts]] as const) {
      for (const c of list) {
        const volume = c.volume ?? 0
        const openInterest = c.openInterest ?? 0
        if (volume < minVolume) continue
        // No prior OI means a freshly opened position — always notable, so it
        // bypasses the ratio gate rather than dividing by zero.
        const volOiRatio = openInterest > 0 ? volume / openInterest : volume
        if (openInterest > 0 && volOiRatio < minVolOi) continue
        const mid = ((c.bid ?? 0) + (c.ask ?? 0)) / 2 || (c.lastPrice ?? 0)
        out.push({
          ticker: ch.ticker, expiry: ch.expiry, dte, type,
          strike: c.strike, spot: ch.spot,
          moneyness: ch.spot ? (c.strike / ch.spot - 1) * 100 : null,
          volume, openInterest, volOiRatio,
          iv: (c.impliedVolatility ?? 0) * 100,
          mid, premium: volume * mid * 100,
        })
      }
    }
  }
  return out.sort((a, b) => b.premium - a.premium)
}

export function OptionsDeskDemoContent() {
  const cc = useChartColors()
  // Synthetic mode manufactures the chains locally so the layout can be
  // reviewed with a vendor down or the market shut. It is never the default —
  // the live path works on the yfinance fallback — and the whole surface is
  // labelled while it is on.
  const [synthetic, setSynthetic] = useState(false)
  const [tickersDraft, setTickersDraft] = useState('SPY, NVDA')
  const [expiries, setExpiries] = useState(2)
  const [minVolume, setMinVolume] = useState(300)
  const [minVolOi, setMinVolOi] = useState(1.5)

  const [chains, setChains] = useState<Chain[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ran, setRan] = useState(false)
  const [sel, setSel] = useState<{ ticker: string; expiry: string; strike: number; type: 'call' | 'put' } | null>(null)
  const [side, setSide] = useState<'calls' | 'puts'>('calls')

  const scan = async () => {
    const syms = [...new Set(
      tickersDraft.split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    )].slice(0, TICKER_CAP)
    if (!syms.length) return
    setLoading(true); setError(null); setRan(true); setSel(null)
    if (synthetic) {
      setChains(syms.flatMap(sym => syntheticChains(sym, Math.max(1, expiries)).map(c => ({
        ticker: c.ticker, expiry: c.expiry, expirations: c.expirations,
        spot: c.spot, calls: c.calls, puts: c.puts,
      } as Chain))))
      setLoading(false)
      return
    }
    try {
      // One chain load per ticker/expiry, and it serves BOTH panes — the flow
      // screen on the left and the ladder on the right read the same objects.
      const perTicker = await Promise.all(syms.map(async sym => {
        const first = await fetchOptionsChain(sym)
        const exps: string[] = first.expirations ?? []
        const rest = exps.slice(1, Math.max(1, expiries))
        const others = await Promise.all(
          rest.map((e: string) => fetchOptionsChain(sym, e).catch(() => null)),
        )
        return [first, ...others].filter(Boolean).map((d: any) => ({
          ticker: sym,
          expiry: d.expiry,
          expirations: exps,
          spot: d.spot ?? null,
          calls: d.calls ?? [],
          puts: d.puts ?? [],
        } as Chain))
      }))
      setChains(perTicker.flat())
    } catch (e: any) {
      setError(e?.message ?? 'Chain fetch failed.')
      setChains([])
    } finally {
      setLoading(false)
    }
  }

  const flow = useMemo(() => deriveFlow(chains, minVolume, minVolOi), [chains, minVolume, minVolOi])

  // Every strike that cleared the screen, so the ladder can flag them in place.
  const flowKeys = useMemo(() => {
    const m = new Map<string, FlowRow>()
    for (const r of flow) m.set(`${r.ticker}|${r.expiry}|${r.type}|${r.strike}`, r)
    return m
  }, [flow])

  const selChain = useMemo(
    () => (sel ? chains.find(c => c.ticker === sel.ticker && c.expiry === sel.expiry) ?? null : null),
    [chains, sel],
  )

  const pick = (r: FlowRow) => {
    setSel({ ticker: r.ticker, expiry: r.expiry, strike: r.strike, type: r.type })
    setSide(r.type === 'call' ? 'calls' : 'puts')
  }

  const totalPremium = flow.reduce((s, r) => s + r.premium, 0)
  const callPremium = flow.filter(r => r.type === 'call').reduce((s, r) => s + r.premium, 0)
  const callPct = totalPremium > 0 ? Math.round(callPremium / totalPremium * 100) : 0

  // Chain-side stats for the selected name/expiry — Chain Scanner's own strip.
  const stats = useMemo(() => {
    if (!selChain) return null
    const callOI = selChain.calls.reduce((s, c) => s + (c.openInterest ?? 0), 0)
    const putOI = selChain.puts.reduce((s, c) => s + (c.openInterest ?? 0), 0)
    const avg = (l: Contract[]) => l.length ? l.reduce((s, c) => s + (c.impliedVolatility ?? 0), 0) / l.length : 0
    const avgCallIV = avg(selChain.calls), avgPutIV = avg(selChain.puts)
    return {
      callOI, putOI,
      pcRatio: callOI > 0 ? putOI / callOI : 0,
      avgCallIV, avgPutIV, ivSkew: (avgPutIV - avgCallIV) * 100,
    }
  }, [selChain])

  // Ladder + OI chart, both centred on the selected strike rather than on spot —
  // the point of arriving here from a flow row is to see THAT contract in context.
  const ladder = useMemo(() => {
    if (!selChain || !sel) return []
    const list = side === 'calls' ? selChain.calls : selChain.puts
    return [...list]
      .sort((a, b) => Math.abs(a.strike - sel.strike) - Math.abs(b.strike - sel.strike))
      .slice(0, 21)
      .sort((a, b) => a.strike - b.strike)
  }, [selChain, sel, side])

  const oiChart = useMemo(() => {
    if (!selChain || !sel) return []
    const near = [...selChain.calls]
      .sort((a, b) => Math.abs(a.strike - sel.strike) - Math.abs(b.strike - sel.strike))
      .slice(0, 21).map(c => c.strike).sort((a, b) => a - b)
    return near.map(strike => ({
      strike,
      callOI: selChain.calls.find(c => c.strike === strike)?.openInterest ?? 0,
      putOI: -(selChain.puts.find(p => p.strike === strike)?.openInterest ?? 0),
    }))
  }, [selChain, sel])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {synthetic ? (
        <div style={{
          background: T.surface, border: `1px solid ${T.warn}`, borderLeft: `3px solid ${T.warn}`,
          padding: '8px 12px', fontFamily: SANS, fontSize: 10.5, color: T.text, lineHeight: 1.5,
        }}>
          <b style={{ color: T.warn, letterSpacing: '0.1em' }}>SYNTHETIC DATA</b> — every strike, quote, volume
          and open-interest figure below is manufactured for layout review. None of it is a market quote and none
          of it is tradeable. Switch to LIVE for real chains.
        </div>
      ) : (
        <div style={{
          background: T.surface, border: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}`,
          padding: '8px 12px', fontFamily: SANS, fontSize: 10.5, color: T.muted, lineHeight: 1.5,
        }}>
          <b style={{ color: T.gold, letterSpacing: '0.1em' }}>DEMO</b> — Chain Scanner + Options Flow as one surface.
          One chain load per ticker/expiry feeds both panes: the screen on the left, the ladder on the right.
          Click any flow row to drop into its chain. Both original tools are untouched.
        </div>
      )}

      {/* Scan controls — one input set for both halves */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12,
        background: T.surface, border: `1px solid ${T.border}`, padding: '10px 12px',
      }}>
        <div style={{ flex: '1 1 260px', minWidth: 180 }}>
          <label style={lbl} htmlFor="od-tickers">Tickers (max {TICKER_CAP})</label>
          <input id="od-tickers" value={tickersDraft} onChange={e => setTickersDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void scan() }}
            placeholder="SPY, NVDA, TSLA" style={{ ...inp, width: '100%' }} />
        </div>
        <div style={{ width: 104 }}>
          <label style={lbl} htmlFor="od-exp">Expiries</label>
          <select id="od-exp" value={expiries} onChange={e => setExpiries(+e.target.value)} style={{ ...inp, width: '100%' }}>
            {[1, 2, 3].map(n => <option key={n} value={n}>{n} nearest</option>)}
          </select>
        </div>
        <div style={{ width: 104 }}>
          <label style={lbl} htmlFor="od-vol">Min volume</label>
          <input id="od-vol" type="number" min={0} step={50} value={minVolume}
            onChange={e => setMinVolume(+e.target.value)} style={{ ...inp, width: '100%' }} />
        </div>
        <div style={{ width: 104 }}>
          <label style={lbl} htmlFor="od-voloi">Min vol/OI</label>
          <input id="od-voloi" type="number" min={0} step={0.5} value={minVolOi}
            onChange={e => setMinVolOi(+e.target.value)} style={{ ...inp, width: '100%' }} />
        </div>
        <div style={{ width: 132 }}>
          <label style={lbl}>Data</label>
          <div style={{ display: 'flex' }}>
            {([['live', 'Live'], ['synthetic', 'Fake']] as const).map(([k, label]) => {
              const on = (k === 'synthetic') === synthetic
              return (
                <button key={k} onClick={() => setSynthetic(k === 'synthetic')} style={{
                  flex: 1, fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em',
                  textTransform: 'uppercase', padding: '7px 0', cursor: 'pointer',
                  background: on ? (k === 'synthetic' ? T.warn : T.gold) : 'transparent',
                  color: on ? T.bg : T.muted,
                  border: `1px solid ${on ? (k === 'synthetic' ? T.warn : T.gold) : T.border}`,
                }}>{label}</button>
              )
            })}
          </div>
        </div>
        <button onClick={() => void scan()} disabled={loading} style={{
          background: T.goldTint(16), border: `1px solid ${T.gold}`, color: T.gold,
          fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', padding: '7px 18px', cursor: loading ? 'wait' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}>{loading ? 'Scanning…' : 'Scan'}</button>
      </div>

      {/* Flow pulse — the screen's own read, across every name scanned */}
      {flow.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto', background: T.surface, border: `1px solid ${T.border}` }}>
          <KpiCell grow minWidth={150} label="Total premium" value={fmtPremium(totalPremium)} color={T.gold} valueSize={16}
            sub={`${flow.length} contracts`} />
          <KpiCell grow label="Calls" value={`${callPct}%`} color={T.pos} sub={fmtPremium(callPremium)} />
          <KpiCell grow label="Puts" value={`${100 - callPct}%`} color={T.neg} sub={fmtPremium(totalPremium - callPremium)} />
          <KpiCell grow label="Top vol/OI" value={`${flow.slice().sort((a, b) => b.volOiRatio - a.volOiRatio)[0].ticker} ${flow.slice().sort((a, b) => b.volOiRatio - a.volOiRatio)[0].volOiRatio.toFixed(1)}`} />
          <KpiCell grow label="Chains loaded" value={String(chains.length)} sub={`${new Set(chains.map(c => c.ticker)).size} names`} />
        </div>
      )}

      {error && (
        <div style={{ fontFamily: MONO, fontSize: 11, color: T.neg, padding: 12, border: `1px solid ${T.border}` }}>{error}</div>
      )}

      {!ran && !loading && (
        <EmptyState title="Options Desk (demo)" action="SCAN"
          hint="Enter tickers and thresholds, then SCAN. The screen and the chain come from one load." />
      )}
      {loading && <EmptyState title="Loading…" variant="loading" hint="Fetching chains — one per ticker and expiry…" />}
      {ran && !loading && !error && flow.length === 0 && (
        <EmptyState title="Nothing Unusual"
          hint={chains.length
            ? `Loaded ${chains.length} chains, but no contract cleared ${minVolume} volume and ${minVolOi}x vol/OI. Lower the thresholds.`
            : 'No chains loaded for those tickers.'} />
      )}

      {/* The fused surface: screen left, ladder right */}
      {flow.length > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>

          <div style={{ flex: '1 1 460px', minWidth: 340, border: `1px solid ${T.border}` }}>
            <div style={paneHead}>
              Unusual flow · {flow.length} contracts
              <span style={{ color: mix(T.muted, 70), fontWeight: 400, letterSpacing: 0 }}> · click a row for its chain</span>
              {synthetic && <span style={syntheticTag}>Synthetic</span>}
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                <thead>
                  <tr style={{ background: T.surface }}>
                    {['Ticker', 'Type', 'Strike', 'Expiry', 'DTE', 'OTM%', 'Volume', 'OI', 'Vol/OI', 'Premium'].map((h, i) => (
                      <th key={h} style={{ ...th, textAlign: i < 2 ? 'left' : 'right' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {flow.slice(0, 120).map((r, i) => {
                    const on = sel?.ticker === r.ticker && sel?.expiry === r.expiry && sel?.strike === r.strike && sel?.type === r.type
                    const hot = r.volOiRatio >= 5
                    return (
                      <tr key={`${r.ticker}-${r.type}-${r.strike}-${r.expiry}-${i}`} onClick={() => pick(r)}
                        style={{
                          borderBottom: `1px solid ${T.borderFaint}`, cursor: 'pointer',
                          background: on ? T.goldTint(12) : 'transparent',
                        }}>
                        <td style={{ ...td, textAlign: 'left', color: T.text, fontWeight: 700 }}>{r.ticker}</td>
                        <td style={{ ...td, textAlign: 'left', color: r.type === 'call' ? T.pos : T.neg, fontWeight: 700, fontSize: 10 }}>
                          {r.type.toUpperCase()}
                        </td>
                        <td style={td}>{r.strike.toFixed(2)}</td>
                        <td style={{ ...td, color: T.muted }}>{r.expiry.slice(5)}</td>
                        <td style={{ ...td, color: T.muted }}>{r.dte}d</td>
                        <td style={{ ...td, color: r.moneyness == null ? T.muted : r.moneyness >= 0 ? T.pos : T.neg }}>
                          {r.moneyness == null ? '—' : `${r.moneyness >= 0 ? '+' : ''}${r.moneyness.toFixed(1)}%`}
                        </td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmtNum(r.volume)}</td>
                        <td style={{ ...td, color: T.muted }}>{fmtNum(r.openInterest)}</td>
                        <td style={{ ...td, color: hot ? T.gold : T.text, fontWeight: hot ? 700 : 400 }}>
                          {r.volOiRatio.toFixed(1)}{r.openInterest === 0 ? '+' : ''}
                        </td>
                        <td style={{ ...td, color: T.gold, fontWeight: 700 }}>{fmtPremium(r.premium)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ flex: '1 1 460px', minWidth: 340, border: `1px solid ${T.border}` }}>
            {!sel || !selChain ? (
              <>
                <div style={paneHead}>Chain context</div>
                <div style={{ padding: 28, textAlign: 'center', fontFamily: SANS, fontSize: 11, color: T.muted }}>
                  Pick a contract on the left. Its chain is already loaded — no second fetch.
                </div>
              </>
            ) : (
              <>
                <div style={paneHead}>
                  {sel.ticker} · {sel.expiry} · {sel.type.toUpperCase()} {sel.strike}
                  {synthetic && <span style={syntheticTag}>Synthetic</span>}
                  {selChain.spot != null && (
                    <span style={{ color: T.gold, fontWeight: 400, letterSpacing: 0 }}> · spot {usd(selChain.spot)}</span>
                  )}
                </div>

                {stats && (
                  <div style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto', borderBottom: `1px solid ${T.border}` }}>
                    <KpiCell grow minWidth={120} label={stats.pcRatio < 1 ? 'P/C OI · Bullish' : 'P/C OI · Bearish'}
                      value={stats.pcRatio.toFixed(2)} color={stats.pcRatio < 1 ? T.pos : T.neg} valueSize={15} />
                    <KpiCell grow label="Call OI" value={fmtNum(stats.callOI)} color={T.pos} />
                    <KpiCell grow label="Put OI" value={fmtNum(stats.putOI)} color={T.neg} />
                    <KpiCell grow label="IV skew (P−C)" value={`${stats.ivSkew > 0 ? '+' : ''}${stats.ivSkew.toFixed(1)}%`}
                      color={stats.ivSkew > 0 ? T.neg : T.pos} />
                  </div>
                )}

                <div style={{ padding: '6px 6px 0' }}>
                  <ResponsiveContainer width="100%" height={168}>
                    <BarChart data={oiChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                      <XAxis dataKey="strike" tick={TICK} />
                      <YAxis tick={TICK} width={46} tickFormatter={v => Math.abs(v).toLocaleString()} />
                      <Tooltip formatter={(v: number) => [Math.abs(v).toLocaleString(), '']} contentStyle={TOOLTIP_STYLE}
                        cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                      <Bar dataKey="callOI" name="Call OI" fill={cc.gainMuted} />
                      <Bar dataKey="putOI" name="Put OI" fill={cc.lossMuted} />
                      {/* Where the flow print sits inside the OI structure. */}
                      <ReferenceLine x={sel.strike} stroke={T.gold} strokeDasharray="3 3" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}`, borderTop: `1px solid ${T.border}` }}>
                  {(['calls', 'puts'] as const).map(s => (
                    <button key={s} onClick={() => setSide(s)} style={{
                      padding: '6px 14px', fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em',
                      textTransform: 'uppercase', background: 'none', border: 'none', cursor: 'pointer',
                      color: side === s ? T.gold : mix(T.muted, 70),
                      borderBottom: side === s ? `2px solid ${T.gold}` : '2px solid transparent', marginBottom: -1,
                    }}>{s}</button>
                  ))}
                </div>

                <div style={{ overflowX: 'auto', maxHeight: 260, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: T.surface }}>
                        {['Strike', 'Bid', 'Ask', 'Volume', 'OI', 'IV', 'Flow'].map((h, i) => (
                          <th key={h} style={{ ...th, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ladder.map(row => {
                        const type = side === 'calls' ? 'call' : 'put'
                        const hit = flowKeys.get(`${sel.ticker}|${sel.expiry}|${type}|${row.strike}`)
                        const isSel = row.strike === sel.strike && type === sel.type
                        return (
                          <tr key={row.strike} style={{
                            borderBottom: `1px solid ${T.borderFaint}`,
                            background: isSel ? T.goldTint(12) : hit ? T.goldTint(5) : 'transparent',
                          }}>
                            <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: isSel ? T.gold : T.text }}>{row.strike}</td>
                            <td style={{ ...td, color: T.muted }}>{row.bid?.toFixed(2) ?? '—'}</td>
                            <td style={{ ...td, color: T.muted }}>{row.ask?.toFixed(2) ?? '—'}</td>
                            <td style={td}>{row.volume?.toLocaleString() ?? '—'}</td>
                            <td style={{ ...td, color: T.muted }}>{row.openInterest?.toLocaleString() ?? '—'}</td>
                            <td style={td}>{row.impliedVolatility != null ? `${(row.impliedVolatility * 100).toFixed(1)}%` : '—'}</td>
                            <td style={{ ...td, color: T.gold, fontWeight: 700 }}>
                              {hit ? `${hit.volOiRatio.toFixed(1)}x` : ''}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ fontFamily: MONO, fontSize: 9, color: T.muted, opacity: 0.75, lineHeight: 1.6 }}>
        {synthetic && 'Synthetic mode: chains are generated locally from a seed of ticker + expiry, so the same inputs always render the same book. '}
        Flow is derived from the same chain rows the ladder shows: volume ≥ min, and vol/OI ≥ min unless open
        interest is zero (a freshly opened position, marked "+"). Premium = volume × mid × 100. The FLOW column
        marks every strike in this expiry that cleared the screen, so the ladder shows where today's positioning went.
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: T.muted, marginBottom: 4, display: 'block',
}
const inp: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.goldTint(35)}`, color: T.text,
  fontFamily: MONO, fontSize: 11.5, padding: '6px 8px', outline: 'none', boxSizing: 'border-box',
}
const syntheticTag: React.CSSProperties = {
  marginLeft: 8, fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: T.warn, border: `1px solid ${T.warn}`, padding: '1px 6px',
}
const paneHead: React.CSSProperties = {
  padding: '7px 10px', background: T.surface, borderBottom: `1px solid ${T.border}`,
  fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: T.text,
}
const th: React.CSSProperties = {
  fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: T.muted, padding: '7px 10px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap',
  position: 'sticky', top: 0, background: T.surface,
}
const td: React.CSSProperties = {
  padding: '6px 10px', textAlign: 'right', color: T.text,
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

export default function OptionsDeskDemo() {
  return <PageWrapper title="Options Desk (demo)"><OptionsDeskDemoContent /></PageWrapper>
}
