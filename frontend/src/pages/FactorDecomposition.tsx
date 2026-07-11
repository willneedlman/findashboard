import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import TickerLink from '../components/TickerLink'
import { KpiCell } from '../components/mmCockpit'
import { INPUT, SELECT, LABEL, SIDEBAR } from './valuationShared'
import { fetchFactorDecomposition } from '../hooks/useApi'
import { readPMPortfolios, normalizeTicker, type PMPortfolio } from '../lib/pmImport'
import { T } from '../lib/theme'

interface FactorRow { factor: string; proxy: string; beta: number; t_stat: number | null; risk_pct: number }
interface Concentration { holdings: number; hhi: number; effective_n: number | null; top_weight: number | null; top: { ticker: string; weight: number }[] }
interface Resp {
  factors: FactorRow[]; r_squared: number; systematic_pct: number; idiosyncratic_pct: number
  ann_vol_pct: number; alpha_ann_pct: number; concentration: Concentration
  observations: number; lookback_days: number; weighting: string; dropped: string[]; source: string
}

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: T.surface, border: `1px solid ${T.border}`,
}
const LOOKBACKS: [string, number][] = [['6M', 180], ['1Y', 365], ['2Y', 730], ['3Y', 1095]]
const sig = (t: number | null) => (t == null ? T.muted : Math.abs(t) >= 2 ? T.text : T.muted)

interface Row { ticker: string; weight: string }

export default function FactorDecomposition() {
  const books = useMemo(() => readPMPortfolios().filter(p => p.holdings.length), [])
  const [mode, setMode] = useState<'saved' | 'custom'>(books.length ? 'saved' : 'custom')
  const [bookId, setBookId] = useState(books[0]?.id ?? '')
  const [rows, setRows] = useState<Row[]>([{ ticker: 'AAPL', weight: '40' }, { ticker: 'MSFT', weight: '35' }, { ticker: 'TLT', weight: '25' }])
  const [lookback, setLookback] = useState(365)

  const m = useMutation<Resp>({
    mutationFn: () => {
      if (mode === 'saved') {
        const book = books.find(b => b.id === bookId) as PMPortfolio
        const holdings = book.holdings
          .filter(h => h.ticker && h.shares)
          .map(h => ({ ticker: normalizeTicker(h.ticker), shares: h.shares }))
        return fetchFactorDecomposition({ holdings, lookback_days: lookback })
      }
      const holdings = rows
        .filter(r => r.ticker.trim() && Number(r.weight) > 0)
        .map(r => ({ ticker: normalizeTicker(r.ticker), weight: Number(r.weight) }))
      return fetchFactorDecomposition({ holdings, lookback_days: lookback })
    },
  })

  const setRow = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows(rs => [...rs, { ticker: '', weight: '' }])
  const delRow = (i: number) => setRows(rs => rs.filter((_, j) => j !== i))

  const rail = (
    <div style={SIDEBAR}>
      <div>
        <span style={LABEL}>Book source</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['saved', 'custom'] as const).map(md => (
            <button key={md} onClick={() => setMode(md)} disabled={md === 'saved' && !books.length}
              style={{ flex: 1, padding: '6px 0', fontFamily: T.mono, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: md === 'saved' && !books.length ? 'not-allowed' : 'pointer',
                background: mode === md ? T.goldTint(14) : 'transparent', color: mode === md ? T.gold : T.muted, border: `1px solid ${mode === md ? T.gold : T.border}`, opacity: md === 'saved' && !books.length ? 0.4 : 1 }}>
              {md === 'saved' ? 'Saved book' : 'Custom'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'saved' ? (
        !books.length ? (
          <p style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, lineHeight: 1.5 }}>No saved Portfolio Manager book found. Build one in Portfolio Manager, or switch to Custom.</p>
        ) : (
          <div>
            <span style={LABEL}>Portfolio</span>
            <select value={bookId} onChange={e => setBookId(e.target.value)} style={SELECT}>
              {books.map(b => <option key={b.id} value={b.id}>{b.name} ({b.holdings.length})</option>)}
            </select>
            <p style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>Weighted by market value from the latest close. Options and futures are excluded.</p>
          </div>
        )
      ) : (
        <div>
          <span style={LABEL}>Holdings · weight %</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 5 }}>
                <input value={r.ticker} onChange={e => setRow(i, { ticker: e.target.value.toUpperCase() })} placeholder="TICKER" style={{ ...INPUT, flex: 1 }} />
                <input value={r.weight} onChange={e => setRow(i, { weight: e.target.value })} placeholder="%" inputMode="decimal" style={{ ...INPUT, width: 54 }} />
                <button onClick={() => delRow(i)} aria-label="Remove" style={{ background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', width: 26, fontFamily: T.mono }}>×</button>
              </div>
            ))}
          </div>
          <button onClick={addRow} style={{ marginTop: 6, background: 'transparent', border: `1px dashed ${T.border}`, color: T.muted, cursor: 'pointer', fontFamily: T.mono, fontSize: 10, padding: '5px 0', width: '100%' }}>+ add holding</button>
        </div>
      )}

      <div>
        <span style={LABEL}>Window</span>
        <div style={{ display: 'flex', gap: 5 }}>
          {LOOKBACKS.map(([lbl, d]) => (
            <button key={d} onClick={() => setLookback(d)} style={{ flex: 1, padding: '5px 0', fontFamily: T.mono, fontSize: 10, cursor: 'pointer', background: lookback === d ? T.goldTint(14) : 'transparent', color: lookback === d ? T.gold : T.muted, border: `1px solid ${lookback === d ? T.gold : T.border}` }}>{lbl}</button>
          ))}
        </div>
      </div>

      <button onClick={() => m.mutate()} disabled={m.isPending}
        style={{ padding: '9px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', cursor: m.isPending ? 'wait' : 'pointer', background: T.gold, color: T.bg, border: 'none' }}>
        {m.isPending ? 'Running' : 'Decompose'}
      </button>
    </div>
  )

  return (
    <PageWrapper title="Factor Decomposition">
      <SidebarLayout sidebar={rail} sidebarTitle="Book">
        {m.isPending ? (
          <LoadingState label="Regressing the book on its factors" />
        ) : m.error ? (
          <ErrorState message={(m.error as any)?.response?.data?.detail || 'Could not decompose the book.'} onRetry={() => m.mutate()} />
        ) : m.data ? (
          <Results d={m.data} />
        ) : (
          <EmptyState title="What is your book actually exposed to?"
            hint="Regress your portfolio's daily returns on the market, rates, credit, oil, and dollar factors. Load a saved book or enter weights, then decompose."
            keys={['Market', 'Rates', 'Credit', 'Oil', 'Dollar']} />
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}

function Results({ d }: { d: Resp }) {
  const top = d.factors[0]
  const maxRisk = Math.max(1, ...d.factors.map(f => Math.abs(f.risk_pct)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={STRIP}>
        <KpiCell label="Annualized vol" value={`${d.ann_vol_pct}%`} align="top" />
        <KpiCell label="Systematic" value={`${d.systematic_pct}%`} sub="R² on factors" color={T.gold} align="top" />
        <KpiCell label="Idiosyncratic" value={`${d.idiosyncratic_pct}%`} sub="name-specific" align="top" />
        <KpiCell label="Dominant factor" value={top ? top.factor : '—'} sub={top ? `β ${top.beta}` : undefined} color={T.blue} align="top" />
        <KpiCell label="Effective names" value={d.concentration.effective_n != null ? String(d.concentration.effective_n) : '—'} sub={`${d.concentration.holdings} held`} align="top" grow />
      </div>

      {d.dropped.length > 0 && (
        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.warn }}>Dropped (no price history): {d.dropped.join(', ')}</div>
      )}

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', color: T.gold }}>FACTOR EXPOSURES</span>
          <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{d.observations} days · partial betas · {d.source}</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 12 }}>
          <thead>
            <tr>{['Factor', 'Proxy', 'Beta', 't-stat', 'Risk share'].map((h, i) => (
              <th key={h} style={{ textAlign: i >= 2 ? 'right' : 'left', padding: '6px 8px', fontSize: 8.5, letterSpacing: '0.1em', color: T.muted, borderBottom: `1px solid ${T.border}`, textTransform: 'uppercase' }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {d.factors.map(f => (
              <tr key={f.factor} style={{ borderBottom: `1px solid ${T.borderFaint}` }}>
                <td style={{ padding: '7px 8px', color: T.text, fontWeight: 700 }}>{f.factor}</td>
                <td style={{ padding: '7px 8px', color: T.muted }}>{f.proxy}</td>
                <td style={{ padding: '7px 8px', textAlign: 'right', color: T.text }}>{f.beta > 0 ? '+' : ''}{f.beta}</td>
                <td style={{ padding: '7px 8px', textAlign: 'right', color: sig(f.t_stat) }}>{f.t_stat == null ? '—' : f.t_stat}</td>
                <td style={{ padding: '7px 8px', width: '38%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 7, background: T.bg, position: 'relative', overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', top: 0, bottom: 0, left: f.risk_pct >= 0 ? '50%' : undefined, right: f.risk_pct < 0 ? '50%' : undefined, width: `${(Math.abs(f.risk_pct) / maxRisk) * 50}%`, background: f.risk_pct >= 0 ? T.gold : T.neg, opacity: 0.8 }} />
                      <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: T.border }} />
                    </div>
                    <span style={{ width: 44, textAlign: 'right', color: f.risk_pct >= 0 ? T.text : T.neg }}>{f.risk_pct > 0 ? '+' : ''}{f.risk_pct}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, marginTop: 10, lineHeight: 1.5 }}>
          Betas are partial (each holds the others fixed). Risk share is each factor's contribution to return variance and sums to the systematic {d.systematic_pct}%; the rest is name-specific. Annualized alpha {d.alpha_ann_pct > 0 ? '+' : ''}{d.alpha_ann_pct}%.
        </p>
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', color: T.gold }}>CONCENTRATION</span>
          <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>HHI {d.concentration.hhi} · {d.weighting}-weighted</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {d.concentration.top.map(h => (
            <div key={h.ticker} style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${T.border}`, padding: '4px 8px' }}>
              <TickerLink ticker={h.ticker} style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text }} />
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{h.weight}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
