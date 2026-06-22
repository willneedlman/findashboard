import { BarChart, Bar, Cell, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { T } from '../../lib/theme'
import {
  TitleBar, TitleAction, VerdictStrip, RangeTrack, EYEBROW, TH, TD, heatColor,
  TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TICK,
} from '../valuationShared'

export interface DcfData {
  intrinsic: number; price: number | null; upsidePct: number; verdict: string
  bear: number; bull: number; ev: string; equity: string; tvPct: number
  proj: { yr: number; rev: string; growth: number; fcff: string; pv: number }[]
  tv?: number
  sens: { rowAxis: string; colLabels: string[]; rows: { label: string; cells: { v: number; base?: boolean }[] }[] }
}

const rule = '1px solid var(--theme-border, rgba(255,255,255,0.08))'

export default function DcfRedesign({ data, rail, subtitle, titleRight }:
  { data: DcfData | null; rail: React.ReactNode; subtitle: string; titleRight?: React.ReactNode }) {
  return (
    <>
      <TitleBar name="DCF VALUATION" subtitle={subtitle}
        right={titleRight ?? <><TitleAction label="Export" /><TitleAction label="Re-run" primary /></>} />
      {data ? <Verdict data={data} /> : <EmptyVerdict />}
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        <div style={{ width: 236, flex: 'none', borderRight: rule, alignSelf: 'stretch' }}>{rail}</div>
        <div style={{ flex: 1, minWidth: 320, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {data ? <Results data={data} /> : (
            <div style={{ padding: '64px 16px', textAlign: 'center', fontFamily: 'var(--theme-mono)', fontSize: 12, color: T.muted }}>
              Run the model to see the valuation, projection and sensitivity.
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function EmptyVerdict() {
  return (
    <VerdictStrip
      primary={{ label: 'Intrinsic / share', value: '—', tone: 'muted', context: 'run the model' }}
      cells={[{ label: 'Enterprise', value: '—' }, { label: 'Equity', value: '—' }, { label: 'TV % of EV', value: '—' }]}
    />
  )
}

function Verdict({ data }: { data: DcfData }) {
  const hasPrice = data.price != null && data.bull > data.bear
  const fairPct = hasPrice ? ((data.intrinsic - data.bear) / (data.bull - data.bear)) * 100 : 0
  const pricePct = hasPrice ? ((data.price! - data.bear) / (data.bull - data.bear)) * 100 : 0
  return (
    <VerdictStrip
      primary={{
        label: 'Intrinsic / share', value: `$${data.intrinsic.toFixed(2)}`, tone: 'gold',
        context: data.price != null ? `vs market $${data.price.toFixed(2)}` : 'no live market price',
      }}
      range={hasPrice ? (
        <RangeTrack
          title="Valuation range"
          chip={{ text: `${data.verdict} · ${data.upsidePct >= 0 ? '+' : '−'}${Math.abs(data.upsidePct).toFixed(1)}%`, tone: data.upsidePct >= 0 ? 'pos' : 'neg' }}
          gradient={`linear-gradient(90deg, ${T.posTint(35)}, color-mix(in srgb, var(--theme-secondary) 22%, transparent), ${T.negTint(35)})`}
          ticks={[{ pct: Math.max(0, Math.min(100, fairPct)), tone: 'gold' }, { pct: Math.max(0, Math.min(100, pricePct)), tone: 'text' }]}
          labels={[
            { text: `$${data.bear.toFixed(0)} bear`, pct: 0, tone: 'muted' },
            { text: `fair $${data.intrinsic.toFixed(2)}`, pct: Math.max(0, Math.min(100, fairPct)), tone: 'gold' },
            { text: `price $${data.price!.toFixed(2)}`, pct: Math.max(0, Math.min(100, pricePct)), tone: 'text' },
            { text: `$${data.bull.toFixed(0)} bull`, pct: 100, tone: 'muted' },
          ]}
        />
      ) : undefined}
      cells={[
        { label: 'Enterprise', value: data.ev },
        { label: 'Equity', value: data.equity },
        { label: 'TV % of EV', value: `${data.tvPct}%`, tone: 'blue' },
      ]}
    />
  )
}

function Results({ data }: { data: DcfData }) {
  const chart = [
    ...data.proj.map(p => ({ x: `Y${p.yr}`, pv: p.pv, tv: false })),
    ...(data.tv ? [{ x: 'TV', pv: data.tv, tv: true }] : []),
  ]
  const sensDiffs = data.sens.rows.flatMap(r => r.cells.map(c => c.v - (data.price ?? data.intrinsic)))
  const dmin = Math.min(...sensDiffs, -1), dmax = Math.max(...sensDiffs, 1)
  const anchor = data.price ?? data.intrinsic
  return (
    <>
      <div style={{ border: rule, position: 'relative', padding: '30px 12px 12px' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(20,32,50,0.9))', padding: '4px 10px', ...EYEBROW, color: T.text, borderRight: rule, borderBottom: rule }}>Present value of free cash flow by year</div>
        <div style={{ height: 190 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="x" tick={TICK} axisLine={{ stroke: T.border }} tickLine={false} />
              <YAxis hide />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'rgba(255,255,255,0.05)' }} formatter={(v: number) => [`$${Math.round(v).toLocaleString()}M`, 'PV']} />
              <Bar dataKey="pv" radius={0} isAnimationActive={false}>
                {chart.map((d, i) => <Cell key={i} fill={d.tv ? T.gold : T.blue} fillOpacity={d.tv ? 0.8 : 0.85} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: '1.3 1 320px', border: rule }}>
          <div style={{ ...EYEBROW, color: T.text, padding: '8px 12px', borderBottom: rule, background: 'var(--theme-hover, rgba(0,0,0,0.14))' }}>Cash flow projection</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={{ ...TH, textAlign: 'left' }}>Yr</th><th style={TH}>Revenue</th><th style={TH}>Growth</th><th style={TH}>FCFF</th><th style={TH}>PV</th></tr></thead>
            <tbody>
              {data.proj.map(p => (
                <tr key={p.yr}>
                  <td style={{ ...TD, textAlign: 'left', color: T.muted, fontSize: 11 }}>{p.yr}</td>
                  <td style={{ ...TD, fontSize: 11 }}>{p.rev}</td>
                  <td style={{ ...TD, fontSize: 11, color: p.growth >= 0 ? T.pos : T.neg }}>{p.growth >= 0 ? '+' : '−'}{Math.abs(p.growth).toFixed(1)}%</td>
                  <td style={{ ...TD, fontSize: 11 }}>{p.fcff}</td>
                  <td style={{ ...TD, fontSize: 11, color: T.blue }}>{Math.round(p.pv).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ flex: '1 1 300px', border: rule }}>
          <div style={{ ...EYEBROW, color: T.text, padding: '8px 12px', borderBottom: rule, background: 'var(--theme-hover, rgba(0,0,0,0.14))' }}>Sensitivity · intrinsic / share</div>
          <div style={{ padding: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: `auto repeat(${data.sens.colLabels.length}, 1fr)`, gap: 3 }}>
              <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, color: T.muted, display: 'flex', alignItems: 'flex-end', paddingBottom: 3 }}>{data.sens.rowAxis}</div>
              {data.sens.colLabels.map(c => <div key={c} style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: T.muted, textAlign: 'center', padding: '3px 0' }}>{c}</div>)}
              {data.sens.rows.map(row => (
                <RowCells key={row.label} label={row.label} cells={row.cells} anchor={anchor} dmin={dmin} dmax={dmax} />
              ))}
            </div>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.muted, marginTop: 11, lineHeight: 1.5 }}>
              Green cells sit above {data.price != null ? `the $${data.price.toFixed(2)} market price` : 'the base case'}, red below. Base case outlined in gold.
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function RowCells({ label, cells, anchor, dmin, dmax }:
  { label: string; cells: { v: number; base?: boolean }[]; anchor: number; dmin: number; dmax: number }) {
  return (
    <>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: T.muted, display: 'flex', alignItems: 'center' }}>{label}</div>
      {cells.map((c, i) => (
        <div key={i} style={{
          fontFamily: 'var(--theme-mono)', fontSize: 10.5, color: c.base ? T.gold : T.text, textAlign: 'center', padding: '7px 0',
          background: c.base ? T.goldTint(22) : heatColor(c.v - anchor, dmin, dmax),
          border: c.base ? `1px solid ${T.gold}` : undefined,
        }}>{Math.round(c.v)}</div>
      ))}
    </>
  )
}

// ── Sample (the /redesign preview): static rail + AAPL fixture ───────────────
function railBox(label: string, value: string, accent?: boolean): React.ReactNode {
  return (
    <div><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.1em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: T.text, border: `1px solid ${accent ? T.goldTint(40) : 'var(--theme-border, rgba(255,255,255,0.1))'}`, padding: '6px 8px' }}>{value}</div></div>
  )
}

export function SampleDcfRail() {
  return (
    <>
      <div style={{ padding: '11px 14px', borderBottom: rule, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.16em', color: T.gold }}>Model Inputs</span>
        <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.muted }}>AAPL</span>
      </div>
      <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
        {railBox('Base revenue ($M)', '416,000')}
        <div style={{ display: 'flex', gap: 8 }}><div style={{ flex: 1 }}>{railBox('Op margin', '31.5%')}</div><div style={{ flex: 1 }}>{railBox('Target', '32.0%')}</div></div>
        <div style={{ display: 'flex', gap: 8 }}><div style={{ flex: 1 }}>{railBox('WACC', '8.5%', true)}</div><div style={{ flex: 1 }}>{railBox('Term g', '2.5%', true)}</div></div>
        <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(8), color: T.gold, textAlign: 'center', padding: '8px 0', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Run DCF model</div>
      </div>
    </>
  )
}

export const SAMPLE_DCF: DcfData = {
  intrinsic: 264.80, price: 291.52, upsidePct: -9.2, verdict: 'Modestly overvalued',
  bear: 180, bull: 360, ev: '$3.88T', equity: '$3.93T', tvPct: 64,
  proj: [
    { yr: 1, rev: '449,280', growth: 8, fcff: '116,813', pv: 107663 }, { yr: 2, rev: '485,222', growth: 8, fcff: '130,002', pv: 110400 },
    { yr: 3, rev: '524,040', growth: 8, fcff: '144,100', pv: 112800 }, { yr: 4, rev: '555,482', growth: 6, fcff: '155,535', pv: 112200 },
    { yr: 5, rev: '588,811', growth: 6, fcff: '167,811', pv: 111600 }, { yr: 6, rev: '624,140', growth: 6, fcff: '180,001', pv: 110300 },
    { yr: 7, rev: '661,588', growth: 6, fcff: '193,200', pv: 109100 }, { yr: 8, rev: '688,052', growth: 4, fcff: '203,000', pv: 105600 },
    { yr: 9, rev: '715,574', growth: 4, fcff: '213,400', pv: 102300 }, { yr: 10, rev: '744,197', growth: 4, fcff: '224,300', pv: 99100 },
  ],
  tv: 200000,
  sens: {
    rowAxis: 'g \\ WACC', colLabels: ['7.5%', '8.5%', '9.5%', '10.5%'],
    rows: [
      { label: '3.0%', cells: [{ v: 328 }, { v: 289 }, { v: 258 }, { v: 232 }] },
      { label: '2.5%', cells: [{ v: 301 }, { v: 265, base: true }, { v: 238 }, { v: 216 }] },
      { label: '2.0%', cells: [{ v: 279 }, { v: 246 }, { v: 222 }, { v: 203 }] },
    ],
  },
}
