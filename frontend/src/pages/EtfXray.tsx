import { useState, useEffect, useMemo, Fragment } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import { KpiCell } from '../components/mmCockpit'
import { RailSection } from './valuationShared'

const GOLD = 'var(--theme-primary, #c9a84c)'
const SEC = 'var(--theme-secondary, #8099b0)'
const BODY = 'var(--theme-text, #d7e3fc)'
const FAINT = 'var(--theme-text-faint, #5e768f)'
const MONO = 'var(--theme-mono, monospace)'
const SANS = 'var(--theme-sans, sans-serif)'
const HAIR = 'rgba(255,255,255,0.06)'
const SURFACE = 'var(--theme-surface, #0d1826)'
const ACCENT = 'var(--theme-bg, #101c2e)'
const CHROME = 'var(--theme-surface, #142032)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
// Fund identity colors, assigned by selection order (SPY gold, XLK blue, ...).
const PALETTE = ['#c9a84c', '#60a5fa', '#3fb950', '#d97736', '#9d8cf0', '#e06c75', '#56b6c2', '#d19a66']

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: SURFACE, border: `1px solid ${BORDER}`, borderTop: `2px solid ${GOLD}`,
}
const EYEBROW: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', fontFamily: SANS }

interface Supported { ticker: string; label: string; partial: boolean }
interface FundRow { fund: string; name: string; as_of: string; count: number; top10: number; partial: boolean; coverage: number; total: number | null }
interface AggRow { ticker: string; name: string; weight: number; fund_count: number; funds: string[]; by_fund: Record<string, number> }
interface XrayResult {
  funds: FundRow[]
  unique_holdings: number
  overlapping_holdings: number
  any_partial: boolean
  aggregate: AggRow[]
  overlap: { a: string; b: string; overlap: number; shared: number }[]
}

function Panel({ title, right, children, style, bodyStyle }: { title: string; right?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties; bodyStyle?: React.CSSProperties }) {
  return (
    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, background: CHROME, padding: '5px 10px', borderBottom: `1px solid ${HAIR}` }}>
        <span style={{ ...EYEBROW, fontSize: 10, letterSpacing: '0.16em', color: GOLD }}>{title}</span>
        {right && <span style={{ fontFamily: MONO, fontSize: 9, color: SEC, letterSpacing: '0.04em', textAlign: 'right' }}>{right}</span>}
      </div>
      <div style={{ minWidth: 0, ...bodyStyle }}>{children}</div>
    </div>
  )
}

export function EtfXrayContent() {
  const [picked, setPicked] = useState<string[]>([])
  const [open, setOpen] = useState(true)
  const [sort, setSort] = useState<'weight' | 'funds' | 'ticker'>('weight')
  const [fundFilter, setFundFilter] = useState<string[]>([])
  const [filterMode, setFilterMode] = useState<'shared' | 'union' | 'only'>('shared')
  const [pair, setPair] = useState<[string, string] | null>(null)
  const [hover, setHover] = useState('')
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })

  const { data: supported } = useQuery<{ funds: Supported[] }>({
    queryKey: ['etf-supported'], queryFn: () => axios.get('/api/etf/supported').then(r => r.data), staleTime: Infinity,
  })

  const { mutate: runXray, data, isPending, isError, error } = useMutation<XrayResult>({
    mutationFn: async () => (await axios.post('/api/etf/xray', { funds: picked })).data,
  })

  const toggle = (t: string) => setPicked(p => p.includes(t) ? p.filter(x => x !== t) : p.length < 8 ? [...p, t] : p)

  const fundColor = (f: string) => PALETTE[Math.max(0, data?.funds.findIndex(x => x.fund === f) ?? 0) % PALETTE.length]

  // Max-overlap pair = default matrix selection.
  const maxPair = useMemo<[string, string] | null>(() => {
    if (!data?.overlap.length) return null
    const m = data.overlap.reduce((a, b) => b.overlap > a.overlap ? b : a)
    return [m.a, m.b]
  }, [data])
  useEffect(() => { setPair(maxPair); setFundFilter([]); setSort('weight'); setFilterMode('shared') }, [maxPair])

  const ov: Record<string, Record<string, number>> = {}
  if (data) for (const o of data.overlap) { (ov[o.a] ??= {})[o.b] = o.overlap; (ov[o.b] ??= {})[o.a] = o.overlap }
  const fundList = data?.funds.map(f => f.fund) ?? []
  const maxOverlap = data ? Math.max(0.01, ...data.overlap.map(o => o.overlap)) : 1
  const aggByTicker = useMemo(() => { const m: Record<string, string[]> = {}; if (data) for (const a of data.aggregate) m[a.ticker] = a.funds; return m }, [data])
  const hoverFunds = hover ? (aggByTicker[hover] ?? []) : []

  const rows = useMemo(() => {
    if (!data) return []
    let r = data.aggregate
    if (fundFilter.length) {
      // shared = held by ALL selected · union = held by ANY · only = held by
      // exactly one of the selected funds. Re-blend weight over the selected set.
      const inSel = (a: AggRow) => fundFilter.filter(f => a.funds.includes(f)).length
      const keep = filterMode === 'union' ? (a: AggRow) => inSel(a) >= 1
        : filterMode === 'only' ? (a: AggRow) => inSel(a) === 1
        : (a: AggRow) => inSel(a) === fundFilter.length
      r = r.filter(keep)
        .map(a => ({ ...a, weight: fundFilter.reduce((sum, f) => sum + (a.by_fund[f] ?? 0), 0) / fundFilter.length }))
    }
    const s = [...r]
    if (sort === 'funds') s.sort((a, b) => b.fund_count - a.fund_count || b.weight - a.weight)
    else if (sort === 'ticker') s.sort((a, b) => a.ticker.localeCompare(b.ticker))
    else s.sort((a, b) => b.weight - a.weight)
    return s
  }, [data, fundFilter, sort, filterMode])
  const hovered = hover ? rows.find(r => r.ticker === hover) ?? null : null

  const activePair = pair ?? maxPair
  const sharedNames = useMemo(() => {
    if (!data || !activePair) return []
    const [a, b] = activePair
    return data.aggregate.filter(x => x.funds.includes(a) && x.funds.includes(b)).sort((x, y) => y.weight - x.weight)
  }, [data, activePair])

  const groups = useMemo(() => {
    const all = supported?.funds ?? []
    return [
      { label: 'SPDR / SSGA', funds: all.filter(f => !f.partial) },
      { label: 'Other Issuers', funds: all.filter(f => f.partial) },
    ].filter(g => g.funds.length)
  }, [supported])

  const tag = (f: string) => (
    <span key={f} style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, color: fundColor(f), border: `1px solid ${fundColor(f)}`, padding: '1px 4px', whiteSpace: 'nowrap' }}>{f}</span>
  )

  return (
    <SidebarLayout sidebarWidth={220} sidebarTitle="" sidebar={<>
      <RailSection title={`ETFs · ${picked.length}/8`} open={open} onToggle={() => setOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {groups.map(g => (
            <div key={g.label}>
              <div style={{ ...EYEBROW, fontSize: 8, color: FAINT, marginBottom: 5 }}>{g.label}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {g.funds.map(f => {
                  const on = picked.includes(f.ticker)
                  return (
                    <div key={f.ticker} onClick={() => toggle(f.ticker)}
                      style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 9px',
                        border: `1px solid ${on ? GOLD : BORDER}`, background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'transparent' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: on ? GOLD : BODY }}>{f.ticker}</span>
                        {f.partial && <span title="top 25 holdings only" style={{ fontFamily: MONO, fontSize: 8, color: FAINT }}>·25</span>}
                      </span>
                      <span style={{ fontSize: 9, color: SEC, fontFamily: SANS, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>{f.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </RailSection>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button onClick={() => runXray()} disabled={picked.length < 1 || isPending} style={{
          width: '100%', background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)',
          fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '9px 0',
          cursor: (picked.length < 1 || isPending) ? 'default' : 'pointer', opacity: (picked.length < 1 || isPending) ? 0.6 : 1,
        }}>{isPending ? 'Loading…' : 'Run Analysis'}</button>
        {picked.length < 1 && <div style={{ fontSize: 9, color: FAINT, fontFamily: SANS, textAlign: 'center' }}>Select at least one ETF.</div>}
        {isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: SANS, textAlign: 'center' }}>{(error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Analysis failed'}</div>}
      </div>
    </>}>
      {!data && !isPending && <EmptyState title="ETF Analyzer" hint="Pick one or more ETFs and run the analysis: what you own, where the funds overlap, and how concentrated each is. With two or more, you also get the pairwise overlap matrix and shared names." />}
      {isPending && <EmptyState title="Reading holdings…" hint="Pulling each fund's holdings." />}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Selected-fund pills */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ ...EYEBROW, fontSize: 9, color: FAINT }}>Look-through of</span>
            {data.funds.map(f => (
              <span key={f.fund} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', border: `1px solid ${fundColor(f.fund)}`, background: `color-mix(in srgb, ${fundColor(f.fund)} 10%, transparent)` }}>
                <span style={{ width: 7, height: 7, background: fundColor(f.fund) }} />
                <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: fundColor(f.fund) }}>{f.fund}</span>
              </span>
            ))}
          </div>

          {/* KPI strip */}
          <div style={STRIP}>
            <KpiCell grow label="ETFs" value={String(data.funds.length)} valueSize={25} sub={data.funds.length > 1 ? 'funds blended' : 'single fund'} />
            <KpiCell grow label="Unique Holdings" value={String(data.unique_holdings)} valueSize={25} color={GOLD} sub={data.funds.length > 1 ? 'across all funds' : 'in this fund'} />
            <KpiCell grow label="Overlapping Names" value={data.funds.length > 1 ? String(data.overlapping_holdings) : '—'} valueSize={25} sub="held in ≥2 funds" />
            <KpiCell grow label="Max Pair Overlap" value={maxPair ? `${(ov[maxPair[0]]?.[maxPair[1]] ?? 0).toFixed(1)}%` : '—'} valueSize={25} color={GOLD} sub={maxPair ? `${maxPair[0]} × ${maxPair[1]} by weight` : 'needs 2+ funds'} />
          </div>

          {/* Two-column results */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {/* Left — Look-through holdings */}
            <Panel title="Look-Through Holdings" right={`hover for per-fund weights · ${fundFilter.length === 0 ? `all ${rows.length}` : fundFilter.length === 1 ? `${rows.length} in ${fundFilter[0]}` : `${rows.length} ${filterMode === 'union' ? 'in any of' : filterMode === 'only' ? 'in only one of' : 'held by all of'} ${fundFilter.join(' + ')}`}`} style={{ flex: '1.55 1 460px' }} bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 9, flex: 1, minHeight: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ ...EYEBROW, fontSize: 8, color: SEC }}>Sort</span>
                  <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
                    {([['weight', 'Weight'], ['funds', 'Funds'], ['ticker', 'A–Z']] as const).map(([k, lbl]) => (
                      <button key={k} onClick={() => setSort(k)} style={{
                        background: sort === k ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'transparent',
                        border: 'none', borderRight: k !== 'ticker' ? `1px solid ${BORDER}` : 'none', cursor: 'pointer',
                        color: sort === k ? GOLD : SEC, fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '4px 10px',
                      }}>{lbl}</button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ ...EYEBROW, fontSize: 8, color: SEC }}>Fund</span>
                  <button onClick={() => setFundFilter([])} style={{ background: !fundFilter.length ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'transparent', border: `1px solid ${!fundFilter.length ? GOLD : BORDER}`, cursor: 'pointer', color: !fundFilter.length ? GOLD : SEC, fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '3px 8px' }}>ALL</button>
                  {data.funds.map(f => {
                    const lit = hoverFunds.includes(f.fund)
                    const sel = fundFilter.includes(f.fund)
                    return (
                      <button key={f.fund} onClick={() => setFundFilter(ff => ff.includes(f.fund) ? ff.filter(x => x !== f.fund) : [...ff, f.fund])}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, background: sel ? `color-mix(in srgb, ${fundColor(f.fund)} 16%, transparent)` : 'transparent',
                          border: `1px solid ${sel || lit ? fundColor(f.fund) : BORDER}`, outline: lit ? `1px solid ${fundColor(f.fund)}` : 'none', cursor: 'pointer',
                          color: sel || lit ? fundColor(f.fund) : SEC, fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '3px 8px' }}>
                        <span style={{ width: 6, height: 6, background: fundColor(f.fund) }} />{f.fund}
                      </button>
                    )
                  })}
                </div>
                {fundFilter.length > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ ...EYEBROW, fontSize: 8, color: SEC }}>Show</span>
                    <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
                      {([['shared', 'Held by all'], ['union', 'In any'], ['only', 'In only one']] as const).map(([k, lbl], i) => (
                        <button key={k} onClick={() => setFilterMode(k)} style={{
                          background: filterMode === k ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 16%, transparent)' : 'transparent',
                          border: 'none', borderRight: i < 2 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer',
                          color: filterMode === k ? GOLD : SEC, fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', padding: '4px 10px',
                        }}>{lbl}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ flex: 1, minHeight: 160, maxHeight: 'calc(100vh - 250px)', overflowY: 'auto' }}>
                  {rows.length === 0 && fundFilter.length > 1 && (
                    <div style={{ fontSize: 10, color: SEC, fontFamily: SANS, padding: '20px 8px', textAlign: 'center', lineHeight: 1.5 }}>
                      No holdings {filterMode === 'only' ? 'are unique to a single one of' : 'are shared by all of'} {fundFilter.join(' + ')}.
                    </div>
                  )}
                  {rows.map((a, i) => (
                    <div key={a.ticker}
                      onMouseEnter={e => { setHover(a.ticker); setHoverPos({ x: e.clientX, y: e.clientY }) }}
                      onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHover('')}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 4px', borderBottom: i < rows.length - 1 ? `1px solid ${HAIR}` : 'none', background: hover === a.ticker ? 'rgba(255,255,255,0.03)' : 'transparent', cursor: 'default' }}>
                      <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT, width: 18, flexShrink: 0, textAlign: 'right' }}>{String(i + 1).padStart(2, '0')}</span>
                      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: GOLD, width: 58, flexShrink: 0 }}>{a.ticker}</span>
                      <span style={{ fontSize: 11, color: BODY, flex: 1, minWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>{a.funds.map(tag)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Panel>

            {/* Right column */}
            <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              {fundList.length >= 2 && activePair && <>
              <Panel title="Pairwise Overlap" right="% by weight · click a cell">
                <div style={{ overflowX: 'auto', padding: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: `36px repeat(${fundList.length}, minmax(40px, 1fr))`, gap: 0 }}>
                    <div />
                    {fundList.map(f => <div key={f} style={{ padding: '4px 0', textAlign: 'center', fontFamily: MONO, fontSize: 10, fontWeight: 700, color: fundColor(f) }}>{f}</div>)}
                    {fundList.map(rf => (
                      <Fragment key={`r${rf}`}>
                        <div style={{ padding: '0 6px', display: 'flex', alignItems: 'center', fontFamily: MONO, fontSize: 10, fontWeight: 700, color: fundColor(rf) }}>{rf}</div>
                        {fundList.map(cf => {
                          const self = rf === cf
                          const v = self ? 0 : (ov[rf]?.[cf] ?? 0)
                          const intensity = self ? 0 : 16 + (v / maxOverlap) * 70
                          const isSel = !self && activePair && ((activePair[0] === rf && activePair[1] === cf) || (activePair[0] === cf && activePair[1] === rf))
                          return (
                            <div key={rf + cf} onClick={() => !self && setPair([rf, cf])}
                              style={{ padding: '9px 4px', textAlign: 'center', cursor: self ? 'default' : 'pointer', fontFamily: MONO, fontSize: 10, fontWeight: 700,
                                color: self ? FAINT : intensity > 42 ? '#0a1320' : BODY,
                                background: self ? 'transparent' : `color-mix(in srgb, ${GOLD} ${intensity}%, transparent)`,
                                border: `1px solid ${HAIR}`, outline: isSel ? `2px solid ${GOLD}` : 'none', outlineOffset: -2 }}>
                              {self ? '—' : v.toFixed(1)}
                            </div>
                          )
                        })}
                      </Fragment>
                    ))}
                  </div>
                  <div style={{ fontSize: 9, color: FAINT, fontFamily: MONO, marginTop: 6, lineHeight: 1.5 }}>Overlap = sum of min shared-holding weights. Higher = more duplicated exposure.</div>
                </div>
              </Panel>

              <Panel title={`Shared · ${activePair[0]} × ${activePair[1]}`} right={<span style={{ color: GOLD }}>{(ov[activePair[0]]?.[activePair[1]] ?? 0).toFixed(1)}%</span>} style={{ background: ACCENT, border: '1px solid rgba(201,168,76,0.3)' }}>
                <div style={{ padding: 8 }}>
                  {sharedNames.length === 0 ? (
                    <div style={{ fontSize: 10, color: SEC, fontFamily: SANS, padding: '12px 4px', lineHeight: 1.5 }}>No shared names — these funds are fully diversified against each other.</div>
                  ) : (
                    <>
                      <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                        {sharedNames.map((s, i) => (
                          <div key={s.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', borderBottom: i < sharedNames.length - 1 ? `1px solid ${HAIR}` : 'none' }}>
                            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: GOLD, width: 56, flexShrink: 0 }}>{s.ticker}</span>
                            <span style={{ fontSize: 10, color: BODY, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: BODY, flexShrink: 0 }}>{s.weight.toFixed(3)}%</span>
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize: 9, color: FAINT, fontFamily: MONO, marginTop: 6 }}>{sharedNames.length} shared name{sharedNames.length !== 1 ? 's' : ''} in look-through</div>
                    </>
                  )}
                </div>
              </Panel>
              </>}

              <Panel title="Per-Fund Concentration" right="top-10 share of fund">
                <div style={{ padding: 8 }}>
                  {data.funds.map((f, i) => (
                    <div key={f.fund} style={{ padding: '7px 2px', borderBottom: i < data.funds.length - 1 ? `1px solid ${HAIR}` : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ width: 8, height: 8, background: fundColor(f.fund), flexShrink: 0 }} />
                        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: fundColor(f.fund), flexShrink: 0 }}>{f.fund}</span>
                        <span style={{ fontSize: 10, color: SEC, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                        <span style={{ fontSize: 9, color: f.partial ? FAINT : SEC, fontFamily: MONO, flexShrink: 0 }}>{f.partial ? `top 25 · ${f.coverage.toFixed(0)}%` : `${f.count} holdings`}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.05)' }}>
                          <div style={{ width: `${Math.min(100, f.top10)}%`, height: '100%', background: fundColor(f.fund) }} />
                        </div>
                        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: BODY, flexShrink: 0 }}>top-10 {f.top10.toFixed(1)}%</span>
                      </div>
                    </div>
                  ))}
                  <div style={{ fontSize: 9, color: FAINT, fontFamily: MONO, marginTop: 6, lineHeight: 1.5 }}>
                    {data.funds[0]?.as_of && `Holdings as of ${data.funds[0].as_of}. `}{data.any_partial && '·25 funds expose only their top 25 holdings.'}
                  </div>
                </div>
              </Panel>
            </div>
          </div>

          {hovered && (
            <div style={{ position: 'fixed', left: Math.min(hoverPos.x + 16, window.innerWidth - 200), top: hoverPos.y + 14, zIndex: 60, background: SURFACE, border: `1px solid ${GOLD}`, padding: '8px 11px', minWidth: 150, boxShadow: '0 6px 20px rgba(0,0,0,0.45)', pointerEvents: 'none' }}>
              <div style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: GOLD, marginBottom: 5 }}>
                {hovered.ticker} <span style={{ color: SEC, fontWeight: 400 }}>weight by fund</span>
              </div>
              {Object.entries(hovered.by_fund).sort((a, b) => b[1] - a[1]).map(([f, w]) => (
                <div key={f} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontFamily: MONO, fontSize: 10, padding: '1px 0' }}>
                  <span style={{ color: fundColor(f), fontWeight: 700 }}>{f}</span>
                  <span style={{ color: BODY }}>{w.toFixed(3)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </SidebarLayout>
  )
}

export default function EtfXray() {
  return <PageWrapper title="ETF Analyzer"><EtfXrayContent /></PageWrapper>
}
