import { useMemo, useRef, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import axios from 'axios'
import { useTickerListParam, useTickerParam } from '../hooks/useTickerParam'
import { useToolState } from '../hooks/useToolState'
import PageWrapper from '../components/PageWrapper'
import useIsMobile from '../hooks/useIsMobile'
import EmptyState from '../components/EmptyState'
import { fetchOptionsChain } from '../hooks/useApi'
import { useChartColors } from '../hooks/useChartColors'
import { T } from '../lib/theme'
import { MONO, SANS, mix } from './cockpitKit'
import { TOOLTIP_STYLE, TICK } from './valuationShared'
import TickerBasket from '../components/TickerBasket'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip } from '../lib/reportCaptureRegistry'

// Options Scanner — Chain Scanner and Options Flow as one surface.
//
// Flow IS the page: one full-width table grouped by name, so the premium
// concentration across names is visible before any single contract is. The
// chain is an inspector that opens on a row and always shows that row's ticker
// and expiry — the previous half-and-half split reserved 45% of the width
// permanently and let the chain sit on a name the scan was not even screening.
//
// The bridge still runs both ways: a row opens its ladder, and the ladder flags
// every strike in that expiry that cleared the screen.

interface FlowRow {
  ticker: string; type: 'call' | 'put'; strike: number
  expiry: string; dte: number; spot: number | null; moneyness: number | null
  volume: number; openInterest: number; volOiRatio: number
  iv: number; mid: number; premium: number
  /** Sweep / block. The vendor exposes only daily aggregate volume, with no
   *  per-print or exchange detail, so nothing supplies this today and the
   *  column stays off rather than being guessed at. */
  print?: 'swp' | 'blk' | null
}
interface ScanResult {
  asOf: string; scanned: string[]; count: number; rows: FlowRow[]
  /** Symbols whose chain could not be fetched at all, with the reason. Without
   *  this an empty result is indistinguishable from a strict screen. */
  failed?: Record<string, string>
}
interface Contract {
  strike: number
  lastPrice?: number | null; bid?: number | null; ask?: number | null
  volume?: number | null; openInterest?: number | null; impliedVolatility?: number | null
}
interface Chain {
  ticker: string; expiry: string; expirations: string[]; spot: number | null
  calls: Contract[]; puts: Contract[]
}
type Sel = { ticker: string; expiry: string; strike: number; type: 'call' | 'put' }
type SortKey = 'strike' | 'dte' | 'moneyness' | 'volume' | 'openInterest' | 'volOiRatio' | 'iv' | 'premium'

const fmtNum = (n: number) => n.toLocaleString('en-US')
const fmtPrem = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`
const usd = (v: number) => `$${v.toFixed(2)}`

export function OptionsScannerContent() {
  const cc = useChartColors()
  const isMobile = useIsMobile()
  // The basket and all four scan thresholds survive leaving the page. Retuning
  // them from scratch every visit is the tax the audit measured.
  const [tickers, setTickers] = useToolState<string[]>('optionsScanner.tickers', ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA'])
  const [expiries, setExpiries] = useToolState('optionsScanner.expiries', 2)
  const [minVolume, setMinVolume] = useToolState('optionsScanner.minVolume', 300)
  const [minVolOi, setMinVolOi] = useToolState('optionsScanner.minVolOi', 1.5)

  const [scan, setScan] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'premium', dir: 'desc' })
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // /chain, /options-desk and /unusual-options all redirect here, and the
  // drawer offers this page for a symbol. It read neither ?ticker= nor
  // ?tickers=, so every one of those arrived on the hardcoded basket.
  useTickerParam(sym => setTickers([sym]))
  useTickerListParam(setTickers)

  const [sel, setSel] = useState<Sel | null>(null)
  const [chain, setChain] = useState<Chain | null>(null)
  const [chainLoading, setChainLoading] = useState(false)
  const [side, setSide] = useState<'calls' | 'puts'>('calls')
  const chainCache = useRef<Map<string, Chain>>(new Map())

  const runScan = async () => {
    const syms = tickers.slice(0, 25)
    if (!syms.length) return
    setLoading(true); setError(null); setSel(null); setChain(null); setCollapsed({})
    chainCache.current.clear()
    try {
      const { data } = await axios.get<ScanResult>('/api/options/unusual', {
        params: { tickers: syms.join(','), expiries, min_volume: minVolume, min_vol_oi: minVolOi, limit: 200 },
      })
      setScan(data)
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? 'Scan failed.')
      setScan(null)
    }
    setLoading(false)
  }

  const openLadder = async (r: FlowRow) => {
    setSel({ ticker: r.ticker, expiry: r.expiry, strike: r.strike, type: r.type })
    setSide(r.type === 'call' ? 'calls' : 'puts')
    const key = `${r.ticker}|${r.expiry}`
    const hit = chainCache.current.get(key)
    if (hit) { setChain(hit); return }
    setChainLoading(true)
    try {
      const d = await fetchOptionsChain(r.ticker, r.expiry)
      const c: Chain = {
        ticker: r.ticker, expiry: d.expiry ?? r.expiry, expirations: d.expirations ?? [],
        spot: d.spot ?? r.spot ?? null, calls: d.calls ?? [], puts: d.puts ?? [],
      }
      chainCache.current.set(key, c)
      setChain(c)
    } catch {
      setChain(null)
    }
    setChainLoading(false)
  }

  const rows = scan?.rows ?? []
  // No vendor supplies sweep/block, so the column is off. Driven by the data
  // rather than a constant, so it lights up the day the backend can fill it.
  const showTags = rows.some(r => r.print === 'swp' || r.print === 'blk')

  /** Rows bucketed by ticker, groups ordered by their own premium. */
  const groups = useMemo(() => {
    const by = new Map<string, FlowRow[]>()
    for (const r of rows) by.set(r.ticker, [...(by.get(r.ticker) ?? []), r])
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...by.entries()]
      .map(([ticker, list]) => {
        const premium = list.reduce((s, r) => s + r.premium, 0)
        const callPrem = list.filter(r => r.type === 'call').reduce((s, r) => s + r.premium, 0)
        return {
          ticker,
          premium,
          count: list.length,
          callPct: premium > 0 ? Math.round((callPrem / premium) * 100) : 0,
          spot: list.find(r => r.spot != null)?.spot ?? null,
          rows: [...list].sort((a, b) => (((a[sort.key] ?? 0) as number) - ((b[sort.key] ?? 0) as number)) * dir),
        }
      })
      .sort((a, b) => b.premium - a.premium)
  }, [rows, sort])

  const maxPremium = useMemo(() => Math.max(1, ...rows.map(r => r.premium)), [rows])

  // Every strike that cleared, so the ladder shows where the day's positioning
  // went rather than only the row that was clicked.
  const flowKeys = useMemo(() => {
    const m = new Map<string, FlowRow>()
    for (const r of rows) m.set(`${r.ticker}|${r.expiry}|${r.type}|${r.strike}`, r)
    return m
  }, [rows])

  const totalPremium = rows.reduce((s, r) => s + r.premium, 0)
  const callPremium = rows.filter(r => r.type === 'call').reduce((s, r) => s + r.premium, 0)
  const callPct = totalPremium > 0 ? Math.round((callPremium / totalPremium) * 100) : 0
  const topRatio = rows.length ? [...rows].sort((a, b) => b.volOiRatio - a.volOiRatio)[0] : null
  const clearedHere = sel ? rows.filter(r => r.ticker === sel.ticker && r.expiry === sel.expiry).length : 0

  const asOf = useMemo(() => {
    if (!scan?.asOf) return null
    const d = new Date(scan.asOf)
    return isNaN(+d) ? null : d.toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' })
  }, [scan])

  const stats = useMemo(() => {
    if (!chain) return null
    const callOI = chain.calls.reduce((s, c) => s + (c.openInterest ?? 0), 0)
    const putOI = chain.puts.reduce((s, c) => s + (c.openInterest ?? 0), 0)
    const avg = (l: Contract[]) => (l.length ? l.reduce((s, c) => s + (c.impliedVolatility ?? 0), 0) / l.length : 0)
    return { callOI, putOI, pcRatio: callOI > 0 ? putOI / callOI : 0, ivSkew: (avg(chain.puts) - avg(chain.calls)) * 100 }
  }, [chain])

  const ladder = useMemo(() => {
    if (!chain || !sel) return []
    const list = side === 'calls' ? chain.calls : chain.puts
    return [...list]
      .sort((a, b) => Math.abs(a.strike - sel.strike) - Math.abs(b.strike - sel.strike))
      .slice(0, 21).sort((a, b) => a.strike - b.strike)
  }, [chain, sel, side])

  const oiChart = useMemo(() => {
    if (!chain || !sel) return []
    const near = [...chain.calls]
      .sort((a, b) => Math.abs(a.strike - sel.strike) - Math.abs(b.strike - sel.strike))
      .slice(0, 21).map(c => c.strike).sort((a, b) => a - b)
    return near.map(strike => ({
      strike,
      callOI: chain.calls.find(c => c.strike === strike)?.openInterest ?? 0,
      putOI: -(chain.puts.find(p => p.strike === strike)?.openInterest ?? 0),
    }))
  }, [chain, sel])

  const failedList = Object.entries(scan?.failed ?? {})

  const TAB = 'Options Scanner'
  useReportCapture(() => {
    const pieces: ClipDraft[] = []
    if (rows.length) {
      pieces.push(kpiClip(TAB, `Unusual flow · ${(scan?.scanned ?? []).join(', ')}`, [
        { label: 'Total premium', value: fmtPrem(totalPremium), sub: `${rows.length} contracts` },
        { label: 'Calls', value: `${callPct}%`, sub: fmtPrem(callPremium) },
        { label: 'Puts', value: `${100 - callPct}%`, sub: fmtPrem(totalPremium - callPremium) },
        ...(topRatio ? [{ label: 'Top vol/OI', value: `${topRatio.volOiRatio.toFixed(1)}x`,
                          sub: `${topRatio.ticker} ${topRatio.strike} ${topRatio.type}` }] : []),
      ]))
      pieces.push(tableClip(TAB, `Unusual flow · ${rows.length} contracts`,
        ['Ticker', 'Type', 'Strike', 'Expiry', 'DTE', 'OTM%', 'Volume', 'OI', 'Vol/OI', 'IV', 'Premium'],
        groups.flatMap(g => g.rows).slice(0, 40).map(r => [
          r.ticker, r.type.toUpperCase(), String(r.strike), r.expiry, `${r.dte}d`,
          r.moneyness == null ? '—' : `${r.moneyness >= 0 ? '+' : ''}${r.moneyness.toFixed(1)}%`,
          fmtNum(r.volume), fmtNum(r.openInterest), `${r.volOiRatio.toFixed(1)}x`,
          r.iv ? `${r.iv.toFixed(1)}%` : '—', fmtPrem(r.premium),
        ])))
    }
    if (chain && stats && sel) {
      pieces.push(kpiClip(TAB, `${chain.ticker} chain · ${chain.expiry}`, [
        { label: 'P/C OI ratio', value: stats.pcRatio.toFixed(2), sub: stats.pcRatio < 1 ? 'Bullish' : 'Bearish' },
        { label: 'Call OI', value: fmtNum(stats.callOI) },
        { label: 'Put OI', value: fmtNum(stats.putOI) },
        { label: 'IV skew (P-C)', value: `${stats.ivSkew > 0 ? '+' : ''}${stats.ivSkew.toFixed(1)}%` },
        ...(chain.spot != null ? [{ label: 'Spot', value: usd(chain.spot) }] : []),
      ]))
      if (oiChart.length) {
        pieces.push(chartClip(TAB, `Open interest by strike · ${chain.ticker} ${chain.expiry}`, 'bar', 'strike',
          oiChart.map(o => ({ strike: o.strike, callOI: o.callOI, putOI: Math.abs(o.putOI) })),
          [{ key: 'callOI', label: 'Call OI' }, { key: 'putOI', label: 'Put OI' }]))
      }
      if (ladder.length) {
        pieces.push(tableClip(TAB, `${chain.ticker} ${chain.expiry} ${side} ladder`,
          ['Strike', 'Bid', 'Ask', 'Volume', 'OI', 'IV'],
          ladder.map(r => [
            String(r.strike), r.bid?.toFixed(2) ?? '—', r.ask?.toFixed(2) ?? '—',
            r.volume?.toLocaleString() ?? '—', r.openInterest?.toLocaleString() ?? '—',
            r.impliedVolatility != null ? `${(r.impliedVolatility * 100).toFixed(1)}%` : '—',
          ])))
      }
    }
    return pieces.length ? pieces : null
  }, { disabled: !scan && !chain, sourceTab: TAB })

  const colCount = showTags ? 9 : 8
  const sortBtn = (key: SortKey) => () =>
    setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))
  const arrow = (key: SortKey) =>
    sort.key === key ? <span style={{ color: T.gold }}>{sort.dir === 'desc' ? ' ↓' : ' ↑'}</span> : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* 1 · page header */}
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16,
        marginBottom: 4, paddingBottom: 12, borderBottom: `1px solid ${T.goldTint(45)}`,
      }}>
        <h1 style={{
          margin: 0, fontFamily: MONO, fontSize: 14, fontWeight: 700,
          letterSpacing: '0.18em', textTransform: 'uppercase', color: T.gold, lineHeight: 1.3,
        }}>Options Scanner</h1>
        {scan && (
          <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted, letterSpacing: '0.04em' }}>
            {scan.count} contracts cleared · {scan.scanned.length} name{scan.scanned.length === 1 ? '' : 's'}
            {asOf ? ` · as of ${asOf} ET` : ''}
          </span>
        )}
      </div>

      {/* 2 + 3 · ticker basket, with the scan params sharing its action row */}
      <TickerBasket
        value={tickers} onChange={setTickers} cap={25} label="Tickers"
        actions={<>
          <Param label="Expiries">
            <select value={expiries} onChange={e => setExpiries(+e.target.value)} style={field}>
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} nearest</option>)}
            </select>
          </Param>
          <Param label="Min vol">
            <input type="number" min={0} step={50} value={minVolume}
              onChange={e => setMinVolume(+e.target.value)} style={{ ...field, width: 56 }} />
          </Param>
          <Param label="Vol/OI">
            <input type="number" min={0} step={0.5} value={minVolOi}
              onChange={e => setMinVolOi(+e.target.value)} style={{ ...field, width: 46 }} />
          </Param>
          <button onClick={() => void runScan()} disabled={loading || !tickers.length} style={{
            height: 30, padding: '0 22px', background: T.gold, border: 'none', color: T.bg,
            fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
            cursor: loading ? 'wait' : 'pointer', opacity: loading || !tickers.length ? 0.6 : 1,
          }}>{loading ? 'Scanning…' : 'Scan'}</button>
        </>} />

      {error && <div style={{ ...note, color: T.neg }}>{error}</div>}
      {failedList.length > 0 && (
        <div style={{ ...note, borderColor: T.warn, color: T.text }}>
          <b style={{ color: T.warn }}>No chain data for {failedList.map(([s]) => s).join(', ')}.</b>{' '}
          Those names were not screened, so their absence below says nothing about their flow.
        </div>
      )}

      {!scan && !loading && !error && (
        <EmptyState title="No scan yet" action="SCAN"
          hint="Add tickers and press SCAN. The screen finds unusual contracts grouped by name; click any row to open the chain it sits in." />
      )}
      {loading && <EmptyState title="Scanning…" variant="loading" hint="Screening every listed contract in the window…" />}
      {scan && !loading && rows.length === 0 && failedList.length === 0 && (
        <EmptyState title="Nothing Unusual"
          hint={`${scan.scanned.length} name${scan.scanned.length === 1 ? '' : 's'} screened and no contract cleared ${minVolume} volume with ${minVolOi}× vol/OI. Lower the thresholds.`} />
      )}

      {/* 4 + 5 · flow table, inspector */}
      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: isMobile ? '1 1 100%' : 1, minWidth: 0, border: `1px solid ${T.border}` }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: isMobile ? 8 : 16, flexWrap: 'wrap',
              padding: '7px 10px', background: T.surface, borderBottom: `1px solid ${T.border}`,
            }}>
              <span style={{
                fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: T.text, whiteSpace: 'nowrap',
              }}>Unusual flow by name</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, maxWidth: 340 }}>
                <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: cc.gain }}>C {callPct}%</span>
                <SplitBar callPct={callPct} gain={cc.gain} loss={cc.loss} />
                <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: cc.loss }}>P {100 - callPct}%</span>
              </div>
              {topRatio && (
                <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted, whiteSpace: 'nowrap' }}>
                  top vol/OI{' '}
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: T.gold }}>{topRatio.volOiRatio.toFixed(1)}×</span>
                  {' '}{topRatio.ticker} {topRatio.strike} {topRatio.type.toUpperCase()}
                </span>
              )}
            </div>

            <div style={{ overflow: 'auto', maxHeight: 760 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Contract</th>
                    <th style={th} onClick={sortBtn('dte')}>DTE{arrow('dte')}</th>
                    <th style={th} onClick={sortBtn('moneyness')}>OTM%{arrow('moneyness')}</th>
                    <th style={th} onClick={sortBtn('volume')}>Volume{arrow('volume')}</th>
                    <th style={th} onClick={sortBtn('openInterest')}>OI{arrow('openInterest')}</th>
                    <th style={th} onClick={sortBtn('volOiRatio')}>Vol/OI{arrow('volOiRatio')}</th>
                    <th style={th} onClick={sortBtn('iv')}>IV{arrow('iv')}</th>
                    {showTags && <th style={{ ...th, textAlign: 'center', cursor: 'default' }}>Print</th>}
                    <th style={th} onClick={sortBtn('premium')}>Premium{arrow('premium')}</th>
                  </tr>
                </thead>

                {groups.map(g => {
                  const shut = !!collapsed[g.ticker]
                  return (
                    <tbody key={g.ticker}>
                      <tr>
                        <td colSpan={colCount} style={{
                          padding: 0, background: T.surface,
                          borderTop: `1px solid ${T.goldTint(28)}`, borderBottom: `1px solid ${T.border}`,
                          position: 'sticky', top: 28, zIndex: 1,
                        }}>
                          <div onClick={() => setCollapsed(c => ({ ...c, [g.ticker]: !c[g.ticker] }))}
                            style={{
                              display: 'flex', alignItems: 'center', flexWrap: 'wrap',
                              gap: isMobile ? 8 : 14, rowGap: 4,
                              padding: '8px 10px', cursor: 'pointer',
                            }}>
                            <span style={{ fontFamily: SANS, fontSize: 10, color: T.muted, width: 10, lineHeight: 1 }}>
                              {shut ? '▸' : '▾'}
                            </span>
                            <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, letterSpacing: '0.02em', color: '#dce3ed', width: 54 }}>
                              {g.ticker}
                            </span>
                            <span style={{
                              fontFamily: MONO, fontSize: 14, fontWeight: 700, color: T.text,
                              fontVariantNumeric: 'tabular-nums', width: 82, textAlign: 'right',
                            }}>{fmtPrem(g.premium)}</span>
                            <span style={{ fontFamily: MONO, fontSize: 9.5, color: T.muted, width: 92, whiteSpace: 'nowrap' }}>
                              {g.count} contract{g.count === 1 ? '' : 's'}
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: isMobile ? 90 : 140, maxWidth: 300 }}>
                              {!isMobile && <SplitBar callPct={g.callPct} gain={cc.gain} loss={cc.loss} faint />}
                              <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted, whiteSpace: 'nowrap' }}>
                                {g.callPct}% call
                              </span>
                            </div>
                            {g.spot != null && (
                              <span style={{ fontFamily: MONO, fontSize: 9.5, color: T.muted, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                                spot {usd(g.spot)}
                              </span>
                            )}
                            {shut && (
                              <span style={{
                                fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em',
                                textTransform: 'uppercase', color: T.gold, whiteSpace: 'nowrap',
                              }}>{g.count} hidden</span>
                            )}
                          </div>
                        </td>
                      </tr>

                      {!shut && g.rows.map((r, i) => {
                        const on = sel?.ticker === r.ticker && sel?.expiry === r.expiry
                          && sel?.strike === r.strike && sel?.type === r.type
                        const hot = r.volOiRatio >= 5
                        const pct = (r.premium / maxPremium) * 100
                        return (
                          <tr key={`${r.type}-${r.strike}-${r.expiry}-${i}`} onClick={() => void openLadder(r)}
                            style={{
                              borderBottom: `1px solid ${T.borderFaint}`, cursor: 'pointer',
                              background: on ? T.goldTint(12) : 'transparent',
                            }}>
                            <td style={{
                              ...td, textAlign: 'left',
                              borderLeft: `2px solid ${on ? T.gold : 'transparent'}`,
                            }}>
                              <span style={{ fontWeight: 700, color: T.text }}>{r.strike}</span>{' '}
                              <span style={{ fontWeight: 700, fontSize: 10, color: r.type === 'call' ? cc.gain : cc.loss }}>
                                {r.type.toUpperCase()}
                              </span>{' '}
                              <span style={{ color: T.muted }}>{r.expiry.slice(5)}</span>
                            </td>
                            <td style={{ ...td, color: T.muted }}>{r.dte}d</td>
                            <td style={{ ...td, color: r.moneyness == null ? T.muted : r.moneyness >= 0 ? cc.gain : cc.loss }}>
                              {r.moneyness == null ? '—' : `${r.moneyness >= 0 ? '+' : ''}${r.moneyness.toFixed(1)}%`}
                            </td>
                            <td style={{ ...td, fontWeight: 700 }}>{fmtNum(r.volume)}</td>
                            <td style={{ ...td, color: T.muted }}>{fmtNum(r.openInterest)}</td>
                            <td style={{ ...td, color: hot ? T.gold : T.text, fontWeight: hot ? 700 : 400 }}>
                              {r.volOiRatio.toFixed(1)}{r.openInterest === 0 ? '+' : ''}×
                            </td>
                            <td style={{ ...td, color: T.muted }}>{r.iv ? `${r.iv.toFixed(1)}%` : '—'}</td>
                            {showTags && (
                              <td style={{ ...td, textAlign: 'center' }}>
                                {r.print && (
                                  <span style={{
                                    fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', padding: '2px 5px',
                                    color: r.print === 'swp' ? T.gold : T.muted,
                                    border: `1px solid ${r.print === 'swp' ? T.goldTint(45) : 'rgba(255,255,255,0.10)'}`,
                                  }}>{r.print.toUpperCase()}</span>
                                )}
                              </td>
                            )}
                            <td style={{
                              ...td, color: T.gold, fontWeight: 700,
                              // Scan aid only — the number still carries the value.
                              backgroundImage: `linear-gradient(to left, ${T.goldTint(16)} ${pct}%, transparent ${pct}%)`,
                              backgroundRepeat: 'no-repeat',
                            }}>{fmtPrem(r.premium)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  )
                })}
              </table>
            </div>
          </div>

          {sel && (
            <div style={{
              width: isMobile ? '100%' : 400,
              flex: isMobile ? '1 1 100%' : '0 0 400px',
              minWidth: 0,
              border: `1px solid ${T.goldTint(35)}`, background: T.surface,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px 6px 10px',
                background: `color-mix(in srgb, var(--theme-primary) 10%, ${T.surface})`,
                borderBottom: `1px solid ${T.goldTint(35)}`,
              }}>
                <span style={{
                  fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em',
                  textTransform: 'uppercase', color: T.gold,
                }}>{sel.ticker} · {sel.expiry.slice(5)} · {sel.type.toUpperCase()} {sel.strike}</span>
                <button onClick={() => { setSel(null); setChain(null) }} style={{ ...btn, marginLeft: 'auto' }}>Close</button>
              </div>

              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                borderBottom: `1px solid ${T.border}`, fontFamily: MONO, fontSize: 10, color: T.muted,
              }}>
                {chain?.spot != null && <>spot {usd(chain.spot)}<span style={{ color: 'rgba(255,255,255,0.12)' }}>|</span></>}
                exp {sel.expiry}
                <span style={{ marginLeft: 'auto', color: T.gold }}>
                  {clearedHere} strike{clearedHere === 1 ? '' : 's'} cleared here
                </span>
              </div>

              {chainLoading && <div style={{ ...note, border: 'none' }}>Loading the chain…</div>}
              {!chainLoading && !chain && (
                <div style={{ ...note, border: 'none', color: T.warn }}>
                  Could not load {sel.ticker}'s chain for {sel.expiry}.
                </div>
              )}

              {chain && stats && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: T.borderFaint }}>
                    <Stat label={stats.pcRatio < 1 ? 'P/C OI · Bullish' : 'P/C OI · Bearish'}
                      value={stats.pcRatio.toFixed(2)} size={15} color={stats.pcRatio < 1 ? cc.gain : cc.loss} />
                    <Stat label="IV skew (P−C)" size={15}
                      value={`${stats.ivSkew > 0 ? '+' : ''}${stats.ivSkew.toFixed(1)}%`}
                      color={stats.ivSkew > 0 ? cc.loss : cc.gain} />
                    <Stat label="Call OI" value={fmtNum(stats.callOI)} size={13} color={cc.gain} />
                    <Stat label="Put OI" value={fmtNum(stats.putOI)} size={13} color={cc.loss} />
                  </div>

                  <div style={{ padding: '10px 10px 4px' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{
                        fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
                        textTransform: 'uppercase', color: T.muted,
                      }}>Open interest by strike</span>
                      <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted }}>
                        <span style={{ color: cc.gain }}>calls</span> ↑ · <span style={{ color: cc.loss }}>puts</span> ↓
                      </span>
                    </div>
                    <ResponsiveContainer width="100%" height={150}>
                      <BarChart data={oiChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                        <XAxis dataKey="strike" tick={TICK} />
                        <YAxis tick={TICK} width={42} tickFormatter={v => Math.abs(v).toLocaleString()} />
                        <Tooltip formatter={(v: number) => [Math.abs(v).toLocaleString(), '']}
                          contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                        <Bar isAnimationActive={false} dataKey="callOI" name="Call OI" fill={cc.gainMuted} />
                        <Bar isAnimationActive={false} dataKey="putOI" name="Put OI" fill={cc.lossMuted} />
                        <ReferenceLine x={sel.strike} stroke={T.gold} strokeDasharray="3 3" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <div style={{ display: 'flex', borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>
                    {(['calls', 'puts'] as const).map(s => (
                      <button key={s} onClick={() => setSide(s)} style={{
                        padding: '6px 14px', fontFamily: SANS, fontSize: 9.5, fontWeight: 700,
                        letterSpacing: '0.12em', textTransform: 'uppercase', background: 'none',
                        border: 'none', cursor: 'pointer', color: side === s ? T.gold : mix(T.muted, 70),
                        borderBottom: side === s ? `2px solid ${T.gold}` : '2px solid transparent', marginBottom: -1,
                      }}>{s}</button>
                    ))}
                  </div>

                  <div style={{ overflow: 'auto', maxHeight: 268 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                      <thead>
                        <tr>
                          {['Strike', 'Bid', 'Ask', 'Volume', 'OI', 'IV', 'Flow'].map((h, i) => (
                            <th key={h} style={{ ...th, cursor: 'default', textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
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
                              background: isSel ? T.goldTint(14) : hit ? T.goldTint(5) : 'transparent',
                            }}>
                              <td style={{
                                ...td, textAlign: 'left', fontWeight: 700,
                                color: isSel ? T.gold : T.text,
                                borderLeft: `2px solid ${isSel ? T.gold : 'transparent'}`,
                              }}>{row.strike}</td>
                              <td style={{ ...td, color: T.muted }}>{row.bid?.toFixed(2) ?? '—'}</td>
                              <td style={{ ...td, color: T.muted }}>{row.ask?.toFixed(2) ?? '—'}</td>
                              <td style={td}>{row.volume?.toLocaleString() ?? '—'}</td>
                              <td style={{ ...td, color: T.muted }}>{row.openInterest?.toLocaleString() ?? '—'}</td>
                              <td style={td}>{row.impliedVolatility != null ? `${(row.impliedVolatility * 100).toFixed(1)}%` : '—'}</td>
                              <td style={{ ...td, color: T.gold, fontWeight: 700 }}>
                                {hit ? `${hit.volOiRatio.toFixed(1)}×` : ''}
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
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.muted, opacity: 0.75, lineHeight: 1.6 }}>
          Cleared = volume ≥ {minVolume} and vol/OI ≥ {minVolOi}, or open interest 0 (a freshly opened
          position, marked "+"). Premium = volume × mid × 100. FLOW marks every strike in the open expiry
          that cleared.
        </div>
      )}
    </div>
  )
}

function SplitBar({ callPct, gain, loss, faint }: { callPct: number; gain: string; loss: string; faint?: boolean }) {
  return (
    <div style={{ display: 'flex', height: 6, flex: 1, background: faint ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.04)' }}>
      <div style={{ width: `${callPct}%`, background: gain, opacity: 0.85 }} />
      <div style={{ flex: 1, background: loss, opacity: 0.85 }} />
    </div>
  )
}

function Param({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: 30, background: T.bg, border: `1px solid ${T.border}` }}>
      <span style={{
        display: 'flex', alignItems: 'center', padding: '0 9px', whiteSpace: 'nowrap',
        fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: T.muted,
        background: T.surface, borderRight: `1px solid ${T.border}`,
      }}>{label}</span>
      {children}
    </div>
  )
}

function Stat({ label, value, size, color }: { label: string; value: string; size: number; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 12px', background: T.surface }}>
      <span style={{
        fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: T.muted,
      }}>{label}</span>
      <span style={{ fontFamily: MONO, fontSize: size, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}

const note: React.CSSProperties = {
  fontFamily: SANS, fontSize: 11, lineHeight: 1.6, color: T.muted,
  padding: '10px 12px', border: `1px solid ${T.border}`,
}
const field: React.CSSProperties = {
  background: 'transparent', border: 'none', outline: 'none',
  fontFamily: MONO, fontSize: 11.5, color: T.text, padding: '0 9px',
}
const btn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer',
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '5px 10px', whiteSpace: 'nowrap',
}
const th: React.CSSProperties = {
  fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  color: T.muted, padding: '7px 9px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap',
  position: 'sticky', top: 0, zIndex: 2, background: T.surface, textAlign: 'right', cursor: 'pointer',
}
const td: React.CSSProperties = {
  padding: '6px 9px', textAlign: 'right', color: T.text,
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

export default function OptionsScanner() {
  // No `title` — the page draws its own header row (title + scan summary), and
  // PageWrapper's PageHeader would repeat it.
  return <PageWrapper><OptionsScannerContent /></PageWrapper>
}
