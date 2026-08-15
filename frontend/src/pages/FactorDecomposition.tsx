import { useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip, CartesianGrid } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import HelpTip from '../components/HelpTip'
import { INPUT, Select, LABEL, TICK, TOOLTIP_STYLE } from './valuationShared'
import { fetchFactorDecomposition } from '../hooks/useApi'
import { readPMBooks, normalizeTicker, type PMPortfolio } from '../lib/pmImport'
import { T } from '../lib/theme'
import { MONO, SANS, mix, Panel, seg, KpiStrip } from './cockpitKit'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip } from '../lib/reportCaptureRegistry'

interface FactorRow { factor: string; proxy: string; beta: number; t_stat: number | null; risk_pct: number }
interface HoldingDetail { ticker: string; weight: number; betas: Record<string, number>; idiosyncratic_pct: number; book_var_share_pct: number }
interface Resp {
  mode: 'macro' | 'style'
  factors: FactorRow[]; rolling: Record<string, { date: string; beta: number }[]>
  holdings_detail: HoldingDetail[]; book_betas: Record<string, number>; roll_window: number
  r_squared: number; systematic_pct: number; idiosyncratic_pct: number; ann_vol_pct: number; alpha_ann_pct: number
  concentration: { holdings: number; hhi: number; effective_n: number | null; top_weight: number | null; top: { ticker: string; weight: number }[] }
  observations: number; lookback_days: number; weighting: string; dropped: string[]; source: string
}

interface Row { ticker: string; weight: string }
const LOOKBACKS: [string, number][] = [['6M', 180], ['1Y', 365], ['2Y', 730], ['3Y', 1095], ['5Y', 1826], ['10Y', 3653]]

export default function FactorDecomposition() {
  const books = useMemo(() => readPMBooks().filter(p => p.holdings.length), [])
  const [mode, setMode] = useState<'saved' | 'custom'>(books.length ? 'saved' : 'custom')
  const [bookId, setBookId] = useState(books[0]?.id ?? '')
  const [rows, setRows] = useState<Row[]>([{ ticker: 'NVDA', weight: '40' }, { ticker: 'AAPL', weight: '35' }, { ticker: 'TLT', weight: '25' }])
  const [lookback, setLookback] = useState(365)
  const [factorSet, setFactorSet] = useState<'macro' | 'style'>('macro')

  const m = useMutation<Resp>({
    mutationFn: () => {
      const extra = { mode: factorSet }
      if (mode === 'saved') {
        const book = books.find(b => b.id === bookId) as PMPortfolio
        const holdings = book.holdings.filter(h => h.ticker && h.shares).map(h => ({ ticker: normalizeTicker(h.ticker), shares: h.shares }))
        return fetchFactorDecomposition({ holdings, lookback_days: lookback, ...extra })
      }
      const holdings = rows.filter(r => r.ticker.trim() && Number(r.weight) > 0).map(r => ({ ticker: normalizeTicker(r.ticker), weight: Number(r.weight) }))
      return fetchFactorDecomposition({ holdings, lookback_days: lookback, ...extra })
    },
  })
  const setRow = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const rail = (
    <div style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 9 }}>Book source</div>
        <div style={{ display: 'flex', gap: 5 }}>
          <button onClick={() => setMode('saved')} disabled={!books.length} style={{ ...seg(mode === 'saved', !books.length), flex: 1.4 }}>Saved book</button>
          <button onClick={() => setMode('custom')} style={seg(mode === 'custom')}>Custom</button>
        </div>
      </div>
      {mode === 'saved' ? (
        <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ ...LABEL, marginBottom: 7 }}>Portfolio</div>
          {books.length ? <Select value={bookId} onChange={e => setBookId(e.target.value)}>{books.map(b => <option key={b.id} value={b.id}>{b.name} ({b.holdings.length})</option>)}</Select>
            : <p style={{ fontFamily: MONO, fontSize: 10, color: T.muted, lineHeight: 1.5 }}>No saved book. Build one in Portfolio Manager, or switch to Custom.</p>}
          <p style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, marginTop: 7, lineHeight: 1.5 }}>Weighted by market value from the latest close. Options and futures excluded.</p>
        </div>
      ) : (
        <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ ...LABEL, marginBottom: 7 }}>Holdings · weight %</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 5 }}>
                <input value={r.ticker} onChange={e => setRow(i, { ticker: e.target.value.toUpperCase() })} placeholder="TICKER" style={{ ...INPUT, flex: 1 }} />
                <input value={r.weight} onChange={e => setRow(i, { weight: e.target.value })} placeholder="%" style={{ ...INPUT, width: 54 }} />
                <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} style={{ background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', width: 26, fontFamily: MONO }}>×</button>
              </div>
            ))}
          </div>
          <button onClick={() => setRows(rs => [...rs, { ticker: '', weight: '' }])} style={{ marginTop: 6, background: 'transparent', border: `1px dashed ${T.border}`, color: T.muted, cursor: 'pointer', fontFamily: MONO, fontSize: 10, padding: '5px 0', width: '100%' }}>+ add holding</button>
        </div>
      )}
      <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ ...LABEL, marginBottom: 7 }}>Window</div>
        <div style={{ display: 'flex', gap: 5 }}>{LOOKBACKS.map(([l, d]) => <button key={d} onClick={() => setLookback(d)} style={seg(lookback === d)}>{l}</button>)}</div>
      </div>
      <div style={{ padding: '12px 12px 13px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
          <span style={LABEL}>Factor set</span>
          <HelpTip anchor="left" title="Macro vs. style factors" body="Macro: sensitivity to market, rates, credit, oil, and the dollar via liquid ETF proxies. Style: Fama-French/Carhart tilt toward size, value, and momentum, from the Ken French Data Library. Different lenses on the same book: macro sensitivity against equity style tilt." source="Two independent factor models" />
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          <button onClick={() => setFactorSet('macro')} style={seg(factorSet === 'macro')}>Macro</button>
          <button onClick={() => setFactorSet('style')} style={seg(factorSet === 'style')}>Style</button>
        </div>
      </div>
      <div style={{ padding: '13px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <button onClick={() => m.mutate()} disabled={m.isPending} style={{ textAlign: 'center', fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, border: `1px solid ${T.gold}`, background: mix(T.gold, 8), padding: '9px 8px', cursor: m.isPending ? 'wait' : 'pointer' }}>{m.isPending ? 'Running' : 'Decompose'}</button>
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, lineHeight: 1.5 }}>Hover any info icon for what a metric means.</div>
      </div>
    </div>
  )

  return (
    <PageWrapper title="Factor Decomposition">
      <SidebarLayout sidebar={rail} sidebarTitle="Book">
        {m.isPending ? <LoadingState label="Regressing the book on its factors" />
          : m.error ? <ErrorState title="Decomposition failed" message={(m.error as any)?.response?.data?.detail || 'The book could not be decomposed. Retry, or pick a shorter window.'} onRetry={() => m.mutate()} />
          : m.data ? <Results key={m.data.mode} d={m.data} />
          : <EmptyState title="Factor Decomposition" hint="Load a saved book or enter weights to measure factor exposure and beta drift."
            keys={['Market', 'Rates', 'Credit', 'Oil', 'Dollar']} action="Decompose" />}
      </SidebarLayout>
    </PageWrapper>
  )
}

const barColor = (v: number) => (v >= 0 ? T.gold : T.neg)

function Results({ d }: { d: Resp }) {
  const factorKeys = Object.keys(d.book_betas)
  const [factor, setFactor] = useState(factorKeys[0] ?? 'market')
  const [holding, setHolding] = useState(d.holdings_detail[0]?.ticker ?? '')
  const top = d.factors[0]

  useReportCapture(() => {
    const pieces: ClipDraft[] = [
      kpiClip('Factor Decomposition', `Factor Decomposition · ${d.mode}`, [
        { label: 'Ann. Vol', value: `${d.ann_vol_pct}%` },
        { label: 'Systematic', value: `${d.systematic_pct}%` },
        { label: 'Idiosyncratic', value: `${d.idiosyncratic_pct}%` },
        { label: 'Alpha (ann)', value: `${d.alpha_ann_pct > 0 ? '+' : ''}${d.alpha_ann_pct}%` },
        { label: 'Dominant', value: top ? top.factor : '—' },
        { label: 'Effective N', value: d.concentration.effective_n != null ? String(d.concentration.effective_n) : '—' },
      ]),
      tableClip(
        'Factor Decomposition',
        'Factor Exposures',
        ['Factor', 'Proxy', 'Beta', 't-stat', 'Risk %'],
        d.factors.map(f => [f.factor, f.proxy, f.beta, f.t_stat, f.risk_pct]),
      ),
    ]
    if (d.holdings_detail.length) {
      pieces.push(tableClip(
        'Factor Decomposition',
        'Holdings · Weight & Variance Share',
        ['Ticker', 'Weight %', 'Idiosyncratic %', 'Book Var Share %'],
        d.holdings_detail.slice(0, 20).map(h => [h.ticker, h.weight, h.idiosyncratic_pct, h.book_var_share_pct]),
      ))
    }
    const roll = d.rolling[factor] ?? []
    if (roll.length) {
      const step = Math.max(1, Math.ceil(roll.length / 80))
      const sampled = roll.filter((_, i) => i % step === 0 || i === roll.length - 1)
      pieces.push(chartClip(
        'Factor Decomposition',
        `Rolling Exposure · ${factor} · ${d.roll_window}d`,
        'line',
        'date',
        sampled.map(p => ({ date: p.date, beta: p.beta })),
        [{ key: 'beta', label: `${factor} β` }],
      ))
    }
    return pieces
  }, { disabled: !d.factors.length, sourceTab: 'Factor Decomposition' })

  const kpis = [
    { label: 'Annualized vol', value: `${d.ann_vol_pct}%`, sub: 'book returns', tip: { title: 'Annualized volatility', body: `The book's own return volatility, annualized. ${d.ann_vol_pct}% is the swing you actually live with — before deciding whether it comes from the market or from single names.`, source: 'Daily book returns × √252' } },
    { label: 'Systematic', value: `${d.systematic_pct}%`, vc: T.gold, sub: 'R² on factors', tip: { title: 'Systematic share', body: `Share of the book's variance the five factors explain. At ${d.systematic_pct}%, the rest (${d.idiosyncratic_pct}%) is name-specific risk the factors cannot see or hedge.`, source: 'R² of the factor regression' } },
    { label: 'Idiosyncratic', value: `${d.idiosyncratic_pct}%`, sub: 'name-specific', tip: { title: 'Idiosyncratic share', body: `Variance the factors do not explain — single-name risk. ${d.idiosyncratic_pct}% ${d.idiosyncratic_pct > 50 ? 'is high: the book is concentrated, so stock-picking drives it more than factors.' : 'is moderate: factor exposure dominates.'}`, source: '1 − R²' } },
    { label: 'Dominant factor', value: top ? top.factor : '—', vc: T.blue, sub: top ? `β ${top.beta} · t ${top.t_stat}` : undefined, tip: { title: 'Dominant factor', body: `The factor carrying the most of the book's risk. ${top?.factor} at β ${top?.beta} (t ${top?.t_stat}) — this is the exposure that moves the book most, ${(top?.t_stat ?? 0) >= 2 ? 'and it is statistically solid.' : 'though the t-stat is weak.'}`, source: 'Largest risk share' } },
    { label: 'Effective names', value: d.concentration.effective_n != null ? String(d.concentration.effective_n) : '—', sub: `${d.concentration.holdings} held · HHI ${d.concentration.hhi}`, tip: { title: 'Effective names', body: `Diversification as 1/HHI. The book behaves like ~${d.concentration.effective_n} equally-weighted names across its ${d.concentration.holdings} holdings — well below the count means a few positions dominate.`, source: 'Herfindahl of weights' } },
  ]
  const maxRisk = Math.max(1, ...d.factors.map(f => Math.abs(f.risk_pct)))
  const rollFull = d.book_betas[factor]
  const rollData = d.rolling[factor] ?? []
  const hd = d.holdings_detail.find(h => h.ticker === holding) ?? d.holdings_detail[0]
  const maxWeight = Math.max(1, ...d.holdings_detail.map(h => h.weight))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <KpiStrip cells={kpis} />

      {/* Factor exposures */}
      <Panel label="Factor Exposures" meta={`${d.observations} days · partial betas — each holds the others fixed · ${d.source}`} style={{ padding: '32px 0 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '110px 80px 100px 90px 1fr 90px', padding: '0 14px' }}>
          {['Factor', 'Proxy', 'Beta', 't-stat', 'Risk share', ''].map((h, i) => (
            <div key={h + i} style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: i >= 2 && i <= 3 ? 'flex-end' : i === 4 ? 'flex-end' : 'flex-start', fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, padding: '8px 4px', borderBottom: `1px solid ${T.border}` }}>
              {h}{i === 4 && <HelpTip anchor="right" title="Risk share" body={`Each factor's contribution to the book's return variance. The five shares sum to the systematic ${d.systematic_pct}%; the rest is name-specific. Negative shares are small hedging offsets.`} source="β·cov decomposition" />}
            </div>
          ))}
        </div>
        {d.factors.map(f => {
          const posW = f.risk_pct >= 0 ? (f.risk_pct / maxRisk) * 86 : 0
          const negW = f.risk_pct < 0 ? Math.max(1.2, (Math.abs(f.risk_pct) / maxRisk) * 9) : 0
          return (
            <div key={f.factor} style={{ display: 'grid', gridTemplateColumns: '110px 80px 100px 90px 1fr 90px', padding: '0 14px', borderBottom: `1px solid ${mix(T.text, 4)}` }}>
              <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: T.text, padding: '9px 4px' }}>{f.factor}</div>
              <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted, padding: '9px 4px' }}>{f.proxy}</div>
              <div style={{ fontFamily: MONO, fontSize: 12, color: T.text, padding: '9px 4px', textAlign: 'right' }}>{f.beta > 0 ? '+' : ''}{f.beta}</div>
              <div style={{ fontFamily: MONO, fontSize: 12, color: (f.t_stat != null && Math.abs(f.t_stat) >= 2) ? T.text : T.muted, padding: '9px 4px', textAlign: 'right' }}>{f.t_stat == null ? '—' : f.t_stat}</div>
              <div style={{ padding: '9px 10px' }}>
                <div style={{ position: 'relative', height: 14, background: 'rgba(0,0,0,0.25)' }}>
                  <div style={{ position: 'absolute', top: 0, bottom: 0, left: '10%', width: 1, background: mix(T.text, 18) }} />
                  {f.risk_pct >= 0
                    ? <div style={{ position: 'absolute', top: 0, bottom: 0, left: '10%', width: `${posW}%`, background: T.gold, opacity: 0.85 }} />
                    : <div style={{ position: 'absolute', top: 0, bottom: 0, right: '90%', width: `${negW}%`, background: T.neg, opacity: 0.85 }} />}
                </div>
              </div>
              <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: barColor(f.risk_pct), padding: '9px 4px', textAlign: 'right' }}>{f.risk_pct > 0 ? '+' : ''}{f.risk_pct}%</div>
            </div>
          )
        })}
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, padding: '9px 14px', lineHeight: 1.5 }}>Risk shares sum to the systematic {d.systematic_pct}%. The rest is name-specific. Annualized alpha {d.alpha_ann_pct > 0 ? '+' : ''}{d.alpha_ann_pct}%.</div>
      </Panel>

      {/* Rolling exposure */}
      <Panel label={`Rolling Exposure · ${d.roll_window}d Window`} style={{ padding: '32px 14px 8px' }}
        meta={<span style={{ display: 'flex', gap: 5 }}>{factorKeys.map(k => (
          <button key={k} onClick={() => setFactor(k)} style={{ fontFamily: MONO, fontSize: 9, fontWeight: factor === k ? 700 : 400, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 6px', cursor: 'pointer', background: factor === k ? mix(T.gold, 14) : 'transparent', color: factor === k ? T.gold : T.muted, border: `1px solid ${factor === k ? T.gold : T.border}` }}>{k}</button>
        ))}</span>}>
        <div style={{ height: 150 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rollData} margin={{ top: 4, right: 62, bottom: 0, left: -20 }}>
              <CartesianGrid stroke={T.borderFaint} vertical={false} />
              <XAxis dataKey="date" tick={TICK} minTickGap={70} axisLine={{ stroke: T.border }} tickLine={false} />
              <YAxis tick={TICK} domain={['auto', 'auto']} axisLine={false} tickLine={false} width={38} />
              <Tooltip contentStyle={{ ...TOOLTIP_STYLE, fontFamily: 'var(--theme-mono)', fontSize: 11 }} labelStyle={{ color: T.muted }} />
              <ReferenceLine y={1} stroke={mix(T.text, 12)} label={{ value: 'β 1.0', position: 'right', fill: T.textDim, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
              <ReferenceLine y={rollFull} stroke={T.gold} strokeDasharray="6 5" label={{ value: `full-sample ${rollFull}`, position: 'right', fill: T.gold, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
              <Line type="monotone" dataKey="beta" stroke={T.blue} strokeWidth={1.6} dot={false} isAnimationActive={false} name={`${factor} β`} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      {/* Holdings + drill */}
      <div style={{ display: 'flex', gap: 10 }}>
        <Panel label="Holdings" meta="mkt-value wt" style={{ width: 284, flexShrink: 0, padding: '32px 0 0', overflow: 'hidden' }}>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {d.holdings_detail.map(h => {
              const on = h.ticker === holding
              return (
                <div key={h.ticker} onClick={() => setHolding(h.ticker)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: `1px solid ${mix(T.text, 4)}`, cursor: 'pointer', background: on ? mix(T.gold, 8) : 'transparent' }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: on ? T.gold : T.text, width: 46 }}>{h.ticker}</span>
                  <div style={{ flex: 1, height: 6, background: 'rgba(0,0,0,0.25)' }}><div style={{ height: '100%', width: `${(h.weight / maxWeight) * 100}%`, background: mix(T.gold, 30) }} /></div>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted, width: 40, textAlign: 'right' }}>{h.weight}%</span>
                </div>
              )
            })}
          </div>
        </Panel>
        <Panel label={`Holding Drill · ${hd?.ticker ?? ''}`} labelColor={T.gold} style={{ flex: 1, padding: '32px 16px 12px', overflow: 'hidden' }}
          meta={<span style={{ display: 'flex', gap: 12 }}><span style={{ color: T.gold }}>■ {hd?.ticker}</span><span style={{ color: mix(T.text, 45) }}>■ book</span></span>}>
          {hd && <Drill hd={hd} book={d.book_betas} systematic={d.systematic_pct} factorKeys={factorKeys} />}
        </Panel>
      </div>
    </div>
  )
}

function Drill({ hd, book, systematic, factorKeys }: { hd: HoldingDetail; book: Record<string, number>; systematic: number; factorKeys: string[] }) {
  const bar = (v: number, color: string) => {
    const w = Math.min(50, (Math.abs(v) / 3.3) * 50)
    return (
      <div style={{ position: 'relative', height: 8, background: 'rgba(0,0,0,0.25)' }}>
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, background: mix(T.text, 18) }} />
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: v >= 0 ? '50%' : undefined, right: v < 0 ? '50%' : undefined, width: `${w}%`, background: color, opacity: 0.85 }} />
      </div>
    )
  }
  const takeaway = hd.book_var_share_pct > 25
    ? `One name, ${hd.weight < 25 ? 'a fraction' : 'a chunk'} of the book, ${hd.book_var_share_pct}% of its risk.`
    : `${hd.weight}% of the book, ${hd.book_var_share_pct}% of its variance — pulling its weight, not dominating it.`
  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1.4, display: 'flex', flexDirection: 'column' }}>
        {factorKeys.map(k => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: `1px solid ${mix(T.text, 4)}` }}>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted, width: 52, textTransform: 'capitalize' }}>{k}</span>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>{bar(hd.betas[k] ?? 0, T.gold)}{bar(book[k] ?? 0, mix(T.text, 30))}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 52, textAlign: 'right' }}>
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: T.gold }}>{(hd.betas[k] ?? 0) > 0 ? '+' : ''}{(hd.betas[k] ?? 0).toFixed(2)}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted }}>{(book[k] ?? 0) > 0 ? '+' : ''}{(book[k] ?? 0).toFixed(2)}</span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ width: 196, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, borderLeft: `1px solid ${T.borderFaint}`, paddingLeft: 16 }}>
        {([['Weight', `${hd.weight}%`, T.text], ['Idiosyncratic', `${hd.idiosyncratic_pct}%`, T.text], ['Share of book variance', `${hd.book_var_share_pct}%`, T.gold]] as [string, string, string][]).map(([l, v, c]) => (
          <div key={l}>
            <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>{l}</div>
            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: c, marginTop: 3 }}>{v}</div>
          </div>
        ))}
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, lineHeight: 1.55, marginTop: 'auto' }}>{takeaway} Systematic {systematic}% book-wide.</div>
      </div>
    </div>
  )
}
