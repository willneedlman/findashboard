import { AreaChart, Area, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts'
import { T } from '../../lib/theme'
import {
  TitleBar, TitleAction, VerdictStrip, RangeTrack, EYEBROW,
  TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TICK,
} from '../valuationShared'

export interface NavData {
  asOf: string; multiple: number; premiumPct: number
  floor: number; median: number; now: number; peak: number
  mstrPrice: string; navPerShare: string
  cards: { label: string; value: string; sub: string; tone: 'gold' | 'neg' | 'blue' }[]
  history: { q: string; v: number }[]
  comp: { mktCap: string; nav: string; btcPct: number; btcLabel: string; debtLabel: string }
}

const rail = '1px solid var(--theme-border, rgba(255,255,255,0.08))'
const CARD_TONE = { gold: T.gold, neg: T.neg, blue: T.blue }

export default function NavTrackerRedesign({ data }: { data: NavData }) {
  const pct = (v: number) => ((v - data.floor) / (data.peak - data.floor)) * 100
  return (
    <>
      <TitleBar name="NAV PROXY TRACKER" subtitle="MSTR · Strategy Inc. vs BTC holdings"
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>Live SEC EDGAR + CoinGecko · Jun 18</span>} />

      <VerdictStrip
        primary={{ label: 'Market / NAV', value: `${data.multiple.toFixed(2)}×`, tone: 'gold', context: `+${data.premiumPct}% premium to NAV`, contextTone: 'pos' }}
        range={
          <RangeTrack
            title="Premium range · 2y"
            chip={{ text: `now ${data.now}× · median ${data.median}×`, tone: 'muted' }}
            gradient={`linear-gradient(90deg, ${T.posTint(32)}, color-mix(in srgb, var(--theme-secondary) 22%, transparent), ${T.negTint(32)})`}
            ticks={[{ pct: pct(data.median), tone: 'muted' }, { pct: pct(data.now), tone: 'gold' }]}
            labels={[
              { text: `${data.floor}× floor`, pct: 0, tone: 'muted' },
              { text: `median ${data.median}×`, pct: pct(data.median), tone: 'muted' },
              { text: `now ${data.now}×`, pct: pct(data.now), tone: 'gold' },
              { text: `${data.peak}× peak`, pct: 100, tone: 'muted' },
            ]}
          />
        }
        cells={[
          { label: 'MSTR price', value: data.mstrPrice },
          { label: 'NAV / share', value: data.navPerShare, tone: 'blue' },
        ]}
      />

      <div style={{ display: 'flex' }}>
        <div style={{ width: 236, flex: 'none', borderRight: rail }}>
          <div style={{ padding: '11px 14px', borderBottom: rail }}><span style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.16em', color: T.gold }}>NAV Parameters</span></div>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 11 }}>
            <div><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', marginBottom: 4 }}>Preset company</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px', display: 'flex', justifyContent: 'space-between' }}>MSTR — Strategy <span style={{ color: T.muted }}>▾</span></div></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.1em', marginBottom: 4 }}>Target</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px' }}>MSTR</div></div>
              <div style={{ flex: 1 }}><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.1em', marginBottom: 4 }}>Proxy</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px' }}>BTC-USD</div></div>
            </div>
            <div><div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', marginBottom: 4 }}>Analysis start</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px' }}>01 / 01 / 2024</div></div>
            <div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', color: T.muted, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.07))', paddingTop: 11 }}>Asset holdings</div>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.text }}><span style={{ color: T.gold }}>■</span> Use live / registry data</div>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, lineHeight: 1.5, color: T.muted }}>Holdings, debt and NAV are fetched live (SEC EDGAR for MSTR, CoinGecko for crypto).</div>
            <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(8), color: T.gold, textAlign: 'center', padding: '8px 0', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Calculate NAV</div>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {data.cards.map(c => (
              <div key={c.label} style={{ border: rail, borderTop: `2px solid ${CARD_TONE[c.tone]}`, padding: '11px 13px' }}>
                <div style={{ ...EYEBROW, fontSize: 8, marginBottom: 6 }}>{c.label}</div>
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: c.tone === 'blue' ? T.blue : T.text }}>{c.value}</div>
                <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.muted, marginTop: 2 }}>{c.sub}</div>
              </div>
            ))}
          </div>

          <div style={{ border: rail, position: 'relative', padding: '30px 12px 12px' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(20,32,50,0.9))', padding: '4px 10px', ...EYEBROW, color: T.text, borderRight: rail, borderBottom: rail }}>Market cap / NAV (mNAV) history</div>
            <div style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.history} margin={{ top: 8, right: 44, bottom: 0, left: 0 }}>
                  <XAxis dataKey="q" tick={TICK} axisLine={{ stroke: T.border }} tickLine={false} interval={2} />
                  <YAxis domain={[0.8, 2.5]} tick={TICK} axisLine={false} tickLine={false} width={34} tickFormatter={(v: number) => `${v.toFixed(1)}×`} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ stroke: T.border }} formatter={(v: number) => [`${v.toFixed(2)}×`, 'mNAV']} />
                  <ReferenceLine y={1.0} stroke={T.blue} strokeDasharray="5 4" label={{ value: '1.0× NAV', position: 'right', fill: T.blue, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
                  <Area type="monotone" dataKey="v" stroke={T.gold} strokeWidth={2} fill={T.goldTint(12)} isAnimationActive={false} dot={false} activeDot={{ r: 3.5, fill: T.gold }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={{ border: rail, padding: '12px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 9 }}>
              <span style={{ ...EYEBROW, color: T.text }}>NAV composition</span>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.muted }}>market cap {data.comp.mktCap} vs NAV {data.comp.nav}</span>
            </div>
            <div style={{ display: 'flex', height: 22, border: rail }}>
              <div style={{ width: `${data.comp.btcPct}%`, background: T.goldTint(45), display: 'flex', alignItems: 'center', paddingLeft: 10 }}><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text }}>{data.comp.btcLabel}</span></div>
              <div style={{ flex: 1, background: T.negTint(35), display: 'flex', alignItems: 'center', paddingLeft: 10 }}><span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text }}>{data.comp.debtLabel}</span></div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export const SAMPLE_NAV: NavData = {
  asOf: 'Jun 18', multiple: 1.81, premiumPct: 81, floor: 0.9, median: 1.6, now: 1.81, peak: 2.4,
  mstrPrice: '$342.10', navPerShare: '$188.40',
  cards: [
    { label: 'BTC holdings', value: '581,000', sub: 'BTC · ~2.8% of supply', tone: 'gold' },
    { label: 'BTC value', value: '$61.0B', sub: 'at $105,000 / BTC', tone: 'gold' },
    { label: 'Total debt', value: '$8.2B', sub: 'conv. notes + pref', tone: 'neg' },
    { label: 'Net asset value', value: '$52.8B', sub: 'BTC value − debt', tone: 'blue' },
  ],
  history: [
    { q: '24-Q1', v: 1.20 }, { q: '24-Q2', v: 1.42 }, { q: '24-Q3', v: 1.95 }, { q: '24-Q4', v: 2.25 },
    { q: '25-Q1', v: 2.38 }, { q: '25-Q2', v: 1.92 }, { q: '25-Q3', v: 1.68 }, { q: '25-Q4', v: 2.02 },
    { q: '26-Q1', v: 1.74 }, { q: 'recent', v: 1.86 }, { q: 'now', v: 1.81 },
  ],
  comp: { mktCap: '$95.8B', nav: '$52.8B', btcPct: 64, btcLabel: 'BTC $61.0B', debtLabel: 'Debt $8.2B + premium $34.8B' },
}
