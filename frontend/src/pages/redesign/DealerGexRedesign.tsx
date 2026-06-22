import { BarChart, Bar, Cell, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts'
import { T } from '../../lib/theme'
import {
  TitleBar, VerdictStrip, EYEBROW, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TICK,
} from '../valuationShared'

export interface GexData {
  spot: string; asOf: string; subtitle: string
  netGamma: string; regime: string
  flip: string; callWall: string; putWall: string; cwNote: string; pwNote: string; flipNote: string
  rail: { ticker: string; strikes: string; expiry: string; callG: string; putG: string; net: string; oi: string }
  bars: { strike: number; gamma: number }[]
  flipStrike: number; spotStrike: number
  levels: { label: string; tone: 'pos' | 'neg' | 'gold' | 'text'; price: string; g: string }[]
}

const rail = '1px solid var(--theme-border, rgba(255,255,255,0.08))'
const LEVEL_TONE = { pos: T.pos, neg: T.neg, gold: T.gold, text: T.text }

export default function DealerGexRedesign({ data }: { data: GexData }) {
  return (
    <>
      <TitleBar name="DEALER GEX" subtitle={data.subtitle}
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>spot {data.spot} · {data.asOf}</span>} />

      <VerdictStrip
        primary={{ label: 'Net gamma / 1%', value: data.netGamma, tone: 'pos', context: data.regime, contextTone: 'pos' }}
        cells={[
          { label: 'Gamma flip', value: data.flip, sub: data.flipNote },
          { label: 'Call wall', value: data.callWall, labelTone: 'pos', sub: data.cwNote },
          { label: 'Put wall', value: data.putWall, labelTone: 'neg', sub: data.pwNote },
        ]}
      />

      <div style={{ display: 'flex' }}>
        <div style={{ width: 236, flex: 'none', borderRight: rail }}>
          <div style={{ padding: '11px 14px', borderBottom: rail }}><span style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.16em', color: T.gold }}>GEX Parameters</span></div>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', marginBottom: 4 }}>Ticker</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px' }}>{data.rail.ticker}</div></div>
            <div><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', marginBottom: 4 }}>Strikes each side</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px' }}>{data.rail.strikes}</div></div>
            <div><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', marginBottom: 4 }}>Expiry</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color: T.muted, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px' }}>{data.rail.expiry}</div></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.07))', paddingTop: 11 }}>
              {[['Total call gamma', data.rail.callG, T.pos], ['Total put gamma', data.rail.putG, T.neg], ['Net', data.rail.net, T.pos], ['Contracts', data.rail.oi, T.text]].map(([k, v, c]) => (
                <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.muted }}>{k}</span><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: c as string }}>{v}</span></div>
              ))}
            </div>
            <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(8), color: T.gold, textAlign: 'center', padding: '8px 0', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Load GEX profile</div>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ border: rail, position: 'relative', padding: '30px 12px 12px' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(20,32,50,0.9))', padding: '4px 10px', ...EYEBROW, color: T.text, borderRight: rail, borderBottom: rail }}>Gamma exposure by strike ($Bn / 1% move)</div>
            <div style={{ position: 'absolute', top: 6, right: 12, display: 'flex', gap: 14 }}>
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.blue }}>■ positive</span>
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.neg }}>■ negative</span>
            </div>
            <div style={{ height: 232 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.bars} margin={{ top: 16, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
                  <XAxis dataKey="strike" tick={TICK} axisLine={false} tickLine={false} interval={3} />
                  <YAxis domain={[-2, 2.6]} hide />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'rgba(255,255,255,0.05)' }} formatter={(v: number) => [`${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}Bn`, 'GEX']} />
                  <ReferenceLine y={0} stroke="var(--theme-border, rgba(255,255,255,0.18))" />
                  <ReferenceLine x={data.flipStrike} stroke={T.gold} strokeWidth={1.5} strokeDasharray="5 4" label={{ value: `flip ${data.flip}`, position: 'top', fill: T.gold, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
                  <ReferenceLine x={data.spotStrike} stroke={T.text} strokeWidth={1.5} label={{ value: 'spot', position: 'top', fill: T.text, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
                  <Bar dataKey="gamma" isAnimationActive={false}>
                    {data.bars.map((b, i) => <Cell key={i} fill={b.gamma >= 0 ? T.blue : T.neg} fillOpacity={0.85} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ border: rail }}>
            <div style={{ ...EYEBROW, color: T.text, padding: '8px 12px', borderBottom: rail, background: 'var(--theme-hover, rgba(0,0,0,0.14))' }}>Key levels</div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.levels.map((l, i) => (
                <div key={l.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 14px', borderBottom: i < data.levels.length - 1 ? ' 1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' : undefined }}>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: LEVEL_TONE[l.tone] }}>{l.label}</span>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text }}>{l.price}</span>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.muted }}>{l.g}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export const SAMPLE_GEX: GexData = {
  spot: '$747.17', asOf: '11:43 AM', subtitle: 'SPY · all expiries aggregated · 20 strikes / side',
  netGamma: '+$3.21Bn', regime: 'Positive gamma · vol suppressed',
  flip: '$741.80', callWall: '$750', putWall: '$734', cwNote: '+$2.4Bn · upside magnet', pwNote: '−$1.7Bn · downside support', flipNote: 'spot is above → stable',
  rail: { ticker: 'SPY', strikes: '20', expiry: 'All expiries', callG: '+$6.9Bn', putG: '−$3.7Bn', net: '+$3.2Bn', oi: '2.4M OI' },
  bars: [
    { strike: 730, gamma: -0.6 }, { strike: 732, gamma: -1.0 }, { strike: 734, gamma: -1.7 }, { strike: 736, gamma: -1.0 },
    { strike: 738, gamma: -0.4 }, { strike: 740, gamma: 0.1 }, { strike: 742, gamma: 0.4 }, { strike: 744, gamma: 0.9 },
    { strike: 746, gamma: 1.3 }, { strike: 748, gamma: 1.7 }, { strike: 750, gamma: 2.4 }, { strike: 752, gamma: 1.9 },
    { strike: 754, gamma: 1.3 }, { strike: 756, gamma: 0.8 }, { strike: 758, gamma: 0.5 }, { strike: 760, gamma: 0.3 }, { strike: 762, gamma: 0.2 },
  ],
  flipStrike: 742, spotStrike: 748,
  levels: [
    { label: 'Call wall', tone: 'pos', price: '$750.00', g: '+$2.4Bn' },
    { label: 'Spot', tone: 'text', price: '$747.17', g: '—' },
    { label: 'Gamma flip', tone: 'gold', price: '$741.80', g: 'zero' },
    { label: 'Put wall', tone: 'neg', price: '$734.00', g: '−$1.7Bn' },
  ],
}
