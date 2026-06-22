import { T } from '../../lib/theme'
import { TitleBar, EYEBROW, heatColor } from '../valuationShared'

type Quad = 'lead' | 'improve' | 'lag' | 'weaken'
const QUAD_TONE: Record<Quad, string> = { lead: T.pos, improve: T.blue, lag: T.neg, weaken: T.gold }

export interface SectorRow {
  sym: string; name: string; price: string
  cols: number[]              // 1W, 1M, 3M, 6M, YTD, 1Y
  vsSpy: number; mom: 'up' | 'flat' | 'down'; rank: number
}
export interface SectorData {
  asOf: string
  spy: number[]               // benchmark row (1W..1Y)
  rows: SectorRow[]
  map: { sym: string; cx: number; cy: number; quad: Quad; r?: number }[]
  leaders: { rank: string; sym: string; pct: number; neg?: boolean; rankTone?: 'gold' | 'neg' }[]
}

const COL_LABELS = ['1W', '1M', '3M', '6M', 'YTD', '1Y']
const ARROW = { up: '↑', flat: '→', down: '↓' }
const ARROW_TONE = { up: T.pos, flat: T.muted, down: T.neg }
// Symmetric-ish heat domain spanning the table's return range.
const HMIN = -12, HMAX = 55

function pill(active: boolean): React.CSSProperties {
  return {
    fontFamily: 'var(--theme-mono)', fontSize: 10, padding: '5px 11px',
    color: active ? T.bg : T.muted, background: active ? T.gold : 'transparent',
    fontWeight: active ? 700 : 400, border: active ? 'none' : `1px solid ${T.border}`,
  }
}
const num = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`

const th: React.CSSProperties = {
  ...EYEBROW, letterSpacing: '0.1em', padding: '9px 8px', textAlign: 'center',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
}

export default function SectorRotationRedesign({ data }: { data: SectorData }) {
  return (
    <>
      <TitleBar name="SECTOR ROTATION" subtitle="11 GICS sectors vs S&P 500 · 1M lens"
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>Data as of {data.asOf} · 1h cache</span>} />

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 22px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: T.hover }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {['1W', '1M', '3M', '6M', 'YTD', '1Y'].map(t => <span key={t} style={pill(t === '1M')}>{t}</span>)}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <span style={{ ...EYEBROW, letterSpacing: '0.1em', color: T.gold, background: T.goldTint(12), border: `1px solid ${T.gold}`, padding: '5px 11px' }}>Return</span>
          <span style={{ ...EYEBROW, letterSpacing: '0.1em', padding: '5px 11px', border: `1px solid ${T.border}` }}>Momentum</span>
        </div>
      </div>

      {/* hero: rotation map + ranked leaders */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
        <div style={{ flex: 1, minWidth: 0, padding: '16px 22px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
          <div style={{ ...EYEBROW, color: T.text, marginBottom: 10 }}>Rotation map · relative strength vs momentum</div>
          <svg width="100%" height="330" viewBox="0 0 560 330" style={{ display: 'block' }}>
            <rect x="40" y="14" width="246" height="148" fill="color-mix(in srgb, var(--theme-tertiary) 6%, transparent)" />
            <rect x="286" y="14" width="234" height="148" fill={T.posTint(7)} />
            <rect x="40" y="162" width="246" height="148" fill={T.negTint(7)} />
            <rect x="286" y="162" width="234" height="148" fill={T.goldTint(6)} />
            <line x1="286" y1="14" x2="286" y2="310" stroke="var(--theme-border, rgba(255,255,255,0.14))" />
            <line x1="40" y1="162" x2="520" y2="162" stroke="var(--theme-border, rgba(255,255,255,0.14))" />
            <text x="48" y="30" fill={T.blue} fontSize="9" fontFamily="var(--theme-sans)" fontWeight="700" letterSpacing="1.5">IMPROVING</text>
            <text x="512" y="30" fill={T.pos} fontSize="9" fontFamily="var(--theme-sans)" fontWeight="700" letterSpacing="1.5" textAnchor="end">LEADING</text>
            <text x="48" y="302" fill={T.neg} fontSize="9" fontFamily="var(--theme-sans)" fontWeight="700" letterSpacing="1.5">LAGGING</text>
            <text x="512" y="302" fill={T.gold} fontSize="9" fontFamily="var(--theme-sans)" fontWeight="700" letterSpacing="1.5" textAnchor="end">WEAKENING</text>
            {data.map.map(m => {
              const right = m.cx > 430
              return (
                <g key={m.sym} fontFamily="var(--theme-mono)" fontSize="10" fontWeight="700">
                  <circle cx={m.cx} cy={m.cy} r={m.r ?? 6} fill={QUAD_TONE[m.quad]} />
                  <text x={right ? m.cx - 12 : m.cx + 12} y={m.cy + 4} fill={T.text} textAnchor={right ? 'end' : 'start'}>{m.sym}</text>
                </g>
              )
            })}
          </svg>
        </div>
        <div style={{ flex: 'none', width: 312, padding: '16px 22px' }}>
          <div style={{ ...EYEBROW, color: T.text, marginBottom: 12 }}>Ranked · 1M return</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.leaders.map((l, i) => {
              const w = Math.min(100, Math.abs(l.pct) / 11 * 100)
              return (
                <div key={i}>
                  {l.rank === '—' && <div style={{ height: 1, background: T.border, margin: '5px 0' }} />}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: l.rankTone === 'gold' ? T.gold : l.rankTone === 'neg' ? T.neg : T.muted, width: 22 }}>{l.rank}</span>
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, width: 42 }}>{l.sym}</span>
                    <div style={{ flex: 1, height: 14, background: 'rgba(255,255,255,0.04)', display: 'flex', justifyContent: l.neg ? 'flex-end' : 'flex-start' }}>
                      <div style={{ width: `${w}%`, height: '100%', background: l.neg ? heatColor(-Math.abs(l.pct), HMIN, HMAX) : heatColor(Math.abs(l.pct), HMIN, HMAX) }} />
                    </div>
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: l.neg ? T.neg : T.pos, width: 46, textAlign: 'right' }}>{num(l.pct)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* heat table */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={{ ...th, textAlign: 'left', padding: '9px 14px' }}>Sector</th>
          <th style={{ ...th, textAlign: 'right', padding: '9px 12px' }}>Price</th>
          {COL_LABELS.map(c => <th key={c} style={{ ...th, color: c === '1M' ? T.gold : T.muted }}>{c}</th>)}
          <th style={th}>vs SPY</th><th style={th}>Mom</th><th style={{ ...th, padding: '9px 14px' }}>Rank</th>
        </tr></thead>
        <tbody>
          <tr style={{ background: T.goldTint(5) }}>
            <td style={{ padding: '8px 14px', borderBottom: `1px solid ${T.borderFaint}` }}><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: T.gold }}>SPY</span> <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>S&P 500 Benchmark</span></td>
            <td style={cellR(T.muted)}>—</td>
            {data.spy.map((v, i) => <td key={i} style={cellC(T.text)}>{num(v)}</td>)}
            <td style={cellC(T.muted)}>—</td><td style={cellC(T.muted)}>—</td><td style={{ ...cellC(T.muted), padding: '8px 14px' }}>—</td>
          </tr>
          {data.rows.map(r => (
            <tr key={r.sym}>
              <td style={{ padding: '8px 14px', borderBottom: `1px solid ${T.borderFaint}` }}><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: T.text }}>{r.sym}</span> <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>{r.name}</span></td>
              <td style={cellR(T.text)}>{r.price}</td>
              {r.cols.map((v, i) => <td key={i} style={{ ...cellC(T.text), background: heatColor(v, HMIN, HMAX) }}>{num(v)}</td>)}
              <td style={cellC(r.vsSpy >= 0 ? T.pos : T.neg)}>{num(r.vsSpy)}</td>
              <td style={{ ...cellC(ARROW_TONE[r.mom]), fontSize: 12 }}>{ARROW[r.mom]}</td>
              <td style={{ ...cellC(r.rank === 1 ? T.gold : T.text), padding: '8px 14px', fontWeight: r.rank === 1 ? 700 : 400 }}>#{r.rank}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function cellC(color: string): React.CSSProperties {
  return { fontFamily: 'var(--theme-mono)', fontSize: 11, color, padding: '8px 8px', textAlign: 'center', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }
}
function cellR(color: string): React.CSSProperties {
  return { ...cellC(color), textAlign: 'right', padding: '8px 12px' }
}

export const SAMPLE_SECTOR: SectorData = {
  asOf: '2026-06-18',
  spy: [0.43, 0.99, 14.25, 8.49, 8.76, 25.44],
  map: [
    { sym: 'XLI', cx: 410, cy: 64, quad: 'lead' }, { sym: 'XLB', cx: 395, cy: 86, quad: 'lead' },
    { sym: 'XLF', cx: 378, cy: 102, quad: 'lead' }, { sym: 'XLK', cx: 452, cy: 198, quad: 'weaken', r: 7 },
    { sym: 'XLV', cx: 318, cy: 140, quad: 'improve' }, { sym: 'XLY', cx: 232, cy: 184, quad: 'lag' },
    { sym: 'XLU', cx: 210, cy: 202, quad: 'lag' }, { sym: 'XLRE', cx: 225, cy: 224, quad: 'lag' },
    { sym: 'XLP', cx: 180, cy: 248, quad: 'lag' }, { sym: 'XLC', cx: 150, cy: 272, quad: 'lag' },
    { sym: 'XLE', cx: 110, cy: 294, quad: 'lag' },
  ],
  leaders: [
    { rank: '#1', sym: 'XLK', pct: 7.25 }, { rank: '#2', sym: 'XLI', pct: 6.44 },
    { rank: '#3', sym: 'XLB', pct: 6.08 }, { rank: '#4', sym: 'XLF', pct: 5.77 },
    { rank: '#5', sym: 'XLV', pct: 2.30 },
    { rank: '—', sym: 'XLP', pct: -2.80, neg: true }, { rank: '#10', sym: 'XLC', pct: -5.74, neg: true },
    { rank: '#11', sym: 'XLE', pct: -10.80, neg: true, rankTone: 'neg' },
  ],
  rows: [
    { sym: 'XLK', name: 'Technology', price: '$185.80', cols: [1.41, 7.25, 37.51, 28.16, 28.92, 54.68], vsSpy: 6.26, mom: 'down', rank: 1 },
    { sym: 'XLI', name: 'Industrials', price: '$179.60', cols: [2.54, 6.44, 11.40, 14.68, 14.00, 27.99], vsSpy: 5.45, mom: 'up', rank: 2 },
    { sym: 'XLB', name: 'Materials', price: '$52.02', cols: [1.56, 6.08, 11.22, 14.41, 13.29, 21.91], vsSpy: 5.09, mom: 'up', rank: 3 },
    { sym: 'XLF', name: 'Financials', price: '$54.05', cols: [2.72, 5.77, 10.69, -1.79, -1.10, 9.29], vsSpy: 4.78, mom: 'up', rank: 4 },
    { sym: 'XLV', name: 'Health Care', price: '$150.71', cols: [-2.19, 2.30, 4.13, -2.56, -2.69, 15.13], vsSpy: 1.31, mom: 'flat', rank: 5 },
    { sym: 'XLY', name: 'Consumer Disc.', price: '$115.49', cols: [-0.70, 0.40, 7.41, -5.41, -2.22, 10.63], vsSpy: -0.59, mom: 'down', rank: 6 },
    { sym: 'XLU', name: 'Utilities', price: '$44.46', cols: [0.93, 0.27, 0.27, 5.42, 3.68, 13.52], vsSpy: -0.72, mom: 'flat', rank: 7 },
    { sym: 'XLRE', name: 'Real Estate', price: '$43.97', cols: [-2.11, 0.07, 9.06, 10.14, 9.62, 8.74], vsSpy: -0.92, mom: 'down', rank: 8 },
    { sym: 'XLP', name: 'Consumer Staples', price: '$83.68', cols: [-1.86, -2.80, 3.52, 8.05, 8.32, 6.92], vsSpy: -3.79, mom: 'down', rank: 9 },
    { sym: 'XLC', name: 'Communication', price: '$109.20', cols: [-2.60, -5.74, -2.39, -6.10, -6.29, 6.85], vsSpy: -6.73, mom: 'down', rank: 10 },
    { sym: 'XLE', name: 'Energy', price: '$54.67', cols: [-4.29, -10.80, -7.22, 24.67, 20.54, 28.12], vsSpy: -11.79, mom: 'down', rank: 11 },
  ],
}
