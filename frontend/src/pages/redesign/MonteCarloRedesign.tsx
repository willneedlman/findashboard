import {
  ComposedChart, Area, Line, BarChart, Bar, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip,
} from 'recharts'
import { T } from '../../lib/theme'
import {
  TitleBar, VerdictStrip, EYEBROW, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TICK,
} from '../valuationShared'

export interface MonteData {
  subtitle: string; median: string; expected: string
  cells: { label: string; value: string; tone?: 'pos' | 'neg'; labelTone?: 'pos' | 'neg'; sub?: string }[]
  weights: { sym: string; pct: number }[]
  settings: { k: string; v: string }[]
  cone: { t: string; p5: number; p25: number; median: number; p75: number; p95: number }[]
  dist: { v: number; c: number }[]
  medianV: number; breakeven: number
}

const rail = '1px solid var(--theme-border, rgba(255,255,255,0.08))'
const BLUE_OUTER = 'color-mix(in srgb, var(--theme-tertiary) 12%, transparent)'
const BLUE_INNER = 'color-mix(in srgb, var(--theme-tertiary) 22%, transparent)'

export default function MonteCarloRedesign({ data }: { data: MonteData }) {
  const cone = data.cone.map(p => ({ ...p, oBase: p.p5, oBand: p.p95 - p.p5, iBase: p.p25, iBand: p.p75 - p.p25 }))
  return (
    <>
      <TitleBar name="MONTE CARLO SIMULATOR" subtitle={data.subtitle}
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>$100,000 start</span>} />

      <VerdictStrip
        primary={{ label: 'Median ending value', value: data.median, tone: 'gold', context: data.expected, contextTone: 'pos' }}
        cells={data.cells}
      />

      <div style={{ display: 'flex' }}>
        <div style={{ width: 236, flex: 'none', borderRight: rail }}>
          <div style={{ padding: '11px 14px', borderBottom: rail }}><span style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.16em', color: T.gold }}>Simulation Parameters</span></div>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            {data.weights.map(w => (
              <div key={w.sym} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text }}>{w.sym}</span>
                <div style={{ flex: 1, height: 8, margin: '0 10px', background: 'rgba(255,255,255,0.04)' }}><div style={{ width: `${w.pct}%`, height: '100%', background: `color-mix(in srgb, var(--theme-tertiary) 50%, transparent)` }} /></div>
                <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.muted }}>{w.pct}%</span>
              </div>
            ))}
            <div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', color: T.muted, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.07))', paddingTop: 11 }}>Settings</div>
            {data.settings.map(s => (
              <div key={s.k} style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.muted }}>{s.k}</span><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text }}>{s.v}</span></div>
            ))}
            <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(8), color: T.gold, textAlign: 'center', padding: '8px 0', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginTop: 4 }}>Run Simulation</div>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* cone */}
          <div style={{ border: rail, position: 'relative', padding: '30px 12px 12px' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(20,32,50,0.9))', padding: '4px 10px', ...EYEBROW, color: T.text, borderRight: rail, borderBottom: rail }}>Percentile cone · portfolio value</div>
            <div style={{ position: 'absolute', top: 6, right: 12, display: 'flex', gap: 14, zIndex: 1 }}>
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.blue }}>■ P5–P95</span>
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.gold }}>■ median</span>
            </div>
            <div style={{ height: 216 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={cone} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <XAxis dataKey="t" tick={TICK} axisLine={{ stroke: T.border }} tickLine={false} />
                  <YAxis tick={TICK} axisLine={false} tickLine={false} width={42} domain={['dataMin - 10', 'dataMax + 10']} tickFormatter={(v: number) => `$${Math.round(v)}k`} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ stroke: T.border }} formatter={(v: number, n: string) => [`$${v.toFixed(0)}k`, n]} />
                  <Area dataKey="oBase" stackId="o" stroke="none" fill="none" isAnimationActive={false} legendType="none" />
                  <Area dataKey="oBand" stackId="o" stroke="none" fill={BLUE_OUTER} isAnimationActive={false} legendType="none" name="P5–P95" />
                  <Area dataKey="iBase" stackId="i" stroke="none" fill="none" isAnimationActive={false} legendType="none" />
                  <Area dataKey="iBand" stackId="i" stroke="none" fill={BLUE_INNER} isAnimationActive={false} legendType="none" name="P25–P75" />
                  <Line dataKey="p95" stroke={T.blue} strokeWidth={1.2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                  <Line dataKey="p5" stroke={T.neg} strokeWidth={1.2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                  <Line dataKey="median" stroke={T.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* distribution */}
          <div style={{ border: rail, position: 'relative', padding: '30px 12px 12px' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(20,32,50,0.9))', padding: '4px 10px', ...EYEBROW, color: T.text, borderRight: rail, borderBottom: rail }}>Ending-value distribution</div>
            <div style={{ height: 130 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.dist} margin={{ top: 14, right: 12, bottom: 0, left: 4 }}>
                  <XAxis type="number" dataKey="v" domain={[55, 245]} tick={TICK} axisLine={{ stroke: T.border }} tickLine={false} tickFormatter={(v: number) => `$${v}k`} ticks={[75, 100, 128, 175, 215]} />
                  <YAxis hide />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'rgba(255,255,255,0.05)' }} formatter={(v: number) => [`${v}%`, 'paths']} labelFormatter={(v) => `$${v}k`} />
                  <ReferenceLine x={data.breakeven} stroke={T.muted} strokeDasharray="4 3" label={{ value: '$100k', position: 'insideTopLeft', fill: T.muted, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
                  <ReferenceLine x={data.medianV} stroke={T.gold} strokeWidth={1.5} label={{ value: `median $${data.medianV}k`, position: 'insideTopRight', fill: T.gold, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
                  <Bar dataKey="c" fill={T.blue} fillOpacity={0.8} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export const SAMPLE_MONTE: MonteData = {
  subtitle: '10,000 paths · 1y horizon · GBM, correlated', median: '$128,400', expected: '+28.4% expected',
  cells: [
    { label: '5th pct', value: '$74,200', labelTone: 'neg', sub: '−25.8%' },
    { label: '95th pct', value: '$214,600', labelTone: 'pos', sub: '+114.6%' },
    { label: 'Prob of profit', value: '71%', tone: 'pos' },
    { label: '95% VaR', value: '−$25,800', tone: 'neg' },
  ],
  weights: [
    { sym: 'GRPN', pct: 26 }, { sym: 'MSTR', pct: 22 }, { sym: 'NVDA', pct: 18 }, { sym: 'AMZN', pct: 16 }, { sym: 'TOST', pct: 18 },
  ],
  settings: [
    { k: 'Paths', v: '10,000' }, { k: 'Horizon', v: '252 days' }, { k: 'Model', v: 'GBM' }, { k: 'Correlation', v: 'Historical' },
  ],
  cone: [
    { t: 'start', p5: 100, p25: 100, median: 100, p75: 100, p95: 100 },
    { t: '3m', p5: 92, p25: 104, median: 108, p75: 118, p95: 130 },
    { t: '6m', p5: 85, p25: 108, median: 115, p75: 140, p95: 160 },
    { t: '9m', p5: 79, p25: 112, median: 122, p75: 162, p95: 188 },
    { t: '12m', p5: 74.2, p25: 116, median: 128.4, p75: 185, p95: 214.6 },
  ],
  dist: [
    { v: 64, c: 8 }, { v: 73, c: 16 }, { v: 82, c: 30 }, { v: 91, c: 50 }, { v: 100, c: 68 },
    { v: 109, c: 78 }, { v: 118, c: 72 }, { v: 128, c: 60 }, { v: 137, c: 46 }, { v: 146, c: 36 },
    { v: 155, c: 28 }, { v: 164, c: 22 }, { v: 173, c: 17 }, { v: 182, c: 13 }, { v: 191, c: 10 },
    { v: 200, c: 8 }, { v: 209, c: 6 }, { v: 218, c: 5 }, { v: 227, c: 4 }, { v: 236, c: 3 },
  ],
  medianV: 128, breakeven: 100,
}
