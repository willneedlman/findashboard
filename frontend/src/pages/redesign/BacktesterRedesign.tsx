import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import { T } from '../../lib/theme'
import {
  TitleBar, VerdictStrip, EYEBROW, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TICK,
} from '../valuationShared'

export interface BacktestData {
  subtitle: string; totalReturn: string; spyReturn: string
  cells: { label: string; value: string; tone?: 'neg' }[]
  weights: { sym: string; pct: number }[]
  settings: { k: string; v: string }[]
  curve: { t: string; port: number; spy: number }[]
  stats: { label: string; value: string; top: 'pos' | 'gold' | 'blue' | 'neg'; valueTone?: 'pos' | 'neg' }[]
}

const rail = '1px solid var(--theme-border, rgba(255,255,255,0.08))'
const TOP = { pos: T.pos, gold: T.gold, blue: T.blue, neg: T.neg }

export default function BacktesterRedesign({ data }: { data: BacktestData }) {
  return (
    <>
      <TitleBar name="PORTFOLIO BACKTESTER" subtitle={data.subtitle}
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>vs SPY benchmark</span>} />

      <VerdictStrip
        primary={{ label: 'Total return', value: data.totalReturn, tone: 'pos', context: data.spyReturn }}
        cells={data.cells.map(c => ({ label: c.label, value: c.value, tone: c.tone }))}
      />

      <div style={{ display: 'flex' }}>
        <div style={{ width: 236, flex: 'none', borderRight: rail }}>
          <div style={{ padding: '11px 14px', borderBottom: rail, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.16em', color: T.gold }}>Portfolio</span>
            <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: T.pos }}>100%</span>
          </div>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
            {data.weights.map(w => (
              <div key={w.sym} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text }}>{w.sym}</span>
                <div style={{ flex: 1, height: 8, margin: '0 10px', background: 'rgba(255,255,255,0.04)' }}><div style={{ width: `${w.pct}%`, height: '100%', background: T.goldTint(50) }} /></div>
                <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.muted }}>{w.pct}%</span>
              </div>
            ))}
            <div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', color: T.muted, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.07))', paddingTop: 11 }}>Settings</div>
            {data.settings.map(s => (
              <div key={s.k} style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.muted }}>{s.k}</span><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text }}>{s.v}</span></div>
            ))}
            <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(8), color: T.gold, textAlign: 'center', padding: '8px 0', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', marginTop: 4 }}>Run Backtest</div>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ border: rail, position: 'relative', padding: '30px 12px 12px' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(20,32,50,0.9))', padding: '4px 10px', ...EYEBROW, color: T.text, borderRight: rail, borderBottom: rail }}>Growth of $100,000</div>
            <div style={{ height: 216 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.curve} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <XAxis dataKey="t" tick={TICK} axisLine={{ stroke: T.border }} tickLine={false} interval={2} />
                  <YAxis tick={TICK} axisLine={false} tickLine={false} width={42} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ stroke: T.border }} formatter={(v: number, n: string) => [`$${v.toLocaleString()}`, n === 'port' ? 'Portfolio' : 'SPY']} />
                  <Legend verticalAlign="top" align="right" height={18} iconType="square" wrapperStyle={{ fontSize: 9, fontFamily: 'var(--theme-sans)' }} formatter={(v) => v === 'port' ? 'Portfolio' : 'SPY'} />
                  <Line type="monotone" dataKey="spy" stroke={T.blue} strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="port" stroke={T.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {data.stats.map(s => (
              <div key={s.label} style={{ border: rail, borderTop: `2px solid ${TOP[s.top]}`, padding: '11px 13px' }}>
                <div style={{ ...EYEBROW, fontSize: 8, marginBottom: 6 }}>{s.label}</div>
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 17, fontWeight: 700, color: s.valueTone === 'pos' ? T.pos : s.valueTone === 'neg' ? T.neg : T.text }}>{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

export const SAMPLE_BACKTEST: BacktestData = {
  subtitle: '5 holdings · buy & hold · 2020-01-01 → 2026-06-18', totalReturn: '+218.4%', spyReturn: 'SPY +118.0% over period',
  cells: [
    { label: 'CAGR', value: '+34.2%' }, { label: 'Sharpe', value: '1.32' }, { label: 'Volatility', value: '28.4%' },
    { label: 'Max drawdown', value: '−38.6%', tone: 'neg' }, { label: 'Beta', value: '1.45' },
  ],
  weights: [
    { sym: 'GRPN', pct: 26 }, { sym: 'MSTR', pct: 22 }, { sym: 'NVDA', pct: 18 }, { sym: 'AMZN', pct: 16 }, { sym: 'TOST', pct: 18 },
  ],
  settings: [
    { k: 'Strategy', v: 'Buy & hold' }, { k: 'Rebalance', v: 'None' }, { k: 'Start capital', v: '$100,000' },
  ],
  curve: [
    { t: '2020', port: 100000, spy: 100000 }, { t: '2020 H2', port: 152000, spy: 116000 },
    { t: '2021', port: 198000, spy: 132000 }, { t: '2021 H2', port: 255000, spy: 150000 },
    { t: '2022', port: 168000, spy: 138000 }, { t: '2022 H2', port: 150000, spy: 130000 },
    { t: '2023', port: 205000, spy: 150000 }, { t: '2023 H2', port: 242000, spy: 168000 },
    { t: '2024', port: 280000, spy: 182000 }, { t: '2024 H2', port: 262000, spy: 190000 },
    { t: '2025', port: 300000, spy: 202000 }, { t: '2025 H2', port: 312000, spy: 210000 },
    { t: '2026', port: 318400, spy: 218000 },
  ],
  stats: [
    { label: 'Final value', value: '$318,400', top: 'pos' },
    { label: 'Alpha vs SPY', value: '+100.4%', top: 'gold', valueTone: 'pos' },
    { label: 'Sortino', value: '1.94', top: 'blue' },
    { label: 'Worst month', value: '−19.2%', top: 'neg', valueTone: 'neg' },
  ],
}
