import { T } from '../../lib/theme'
import { TitleBar, TitleAction, EYEBROW } from '../valuationShared'

type Tone = 'pos' | 'neg' | 'muted'
const TONE: Record<Tone, string> = { pos: T.pos, neg: T.neg, muted: T.muted }

export interface EarningsCard {
  ticker: string; name: string; mono: string; period: string; reaction: number
  metrics: { label: string; value: string; sub: string; subTone: Tone }[]
  summary: string
  segments: { label: string; value: string; pct: number }[]
  guidance: { label: string; text: string; tail: string; tailTone: Tone }
}
export interface EarningsData { generated: string; cards: EarningsCard[] }

const cardBorder = '1px solid var(--theme-border, rgba(255,255,255,0.08))'

export default function EarningsRedesign({ data }: { data: EarningsData }) {
  return (
    <>
      <TitleBar name="EARNINGS SUMMARIZER" subtitle="AI-written earnings recaps · latest quarter"
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>Generated {data.generated}</span>} />

      {/* control bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, borderBottom: cardBorder, background: 'rgba(0,0,0,0.16)', padding: '10px 22px', flexWrap: 'wrap' }}>
        <span style={{ ...EYEBROW, fontSize: 8, color: T.muted }}>Tickers</span>
        {data.cards.map(c => (
          <span key={c.ticker} style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', padding: '4px 10px' }}>{c.ticker} ×</span>
        ))}
        <div style={{ width: 1, alignSelf: 'stretch', background: T.border }} />
        <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.text }}><span style={{ color: T.gold }}>■</span> Quarterly (10-Q)</span>
        <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.muted }}>□ Annual (10-K)</span>
        <div style={{ width: 1, alignSelf: 'stretch', background: T.border }} />
        <span style={{ ...EYEBROW, fontSize: 8, color: T.muted }}>Calls</span>
        {['1', '2', '4'].map(n => (
          <span key={n} style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: n === '1' ? T.gold : T.muted, border: `1px solid ${n === '1' ? T.gold : T.border}`, padding: '3px 9px' }}>{n}</span>
        ))}
        <span style={{ marginLeft: 'auto' }}><TitleAction label="Analyze" primary /></span>
      </div>

      {/* cards */}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {data.cards.map(c => (
          <div key={c.ticker} style={{ border: cardBorder }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: cardBorder, background: 'rgba(0,0,0,0.14)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: T.surface, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text, fontWeight: 700 }}>{c.mono}</span>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 14, fontWeight: 700, color: T.text }}>{c.ticker} <span style={{ color: T.muted, fontWeight: 400 }}>{c.name}</span></div>
                  <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted, marginTop: 1 }}>{c.period}</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...EYEBROW, fontSize: 8, marginBottom: 3 }}>Reaction</div>
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 15, color: c.reaction >= 0 ? T.pos : T.neg }}>{c.reaction >= 0 ? '+' : '−'}{Math.abs(c.reaction).toFixed(1)}%</div>
              </div>
            </div>

            <div style={{ display: 'flex', borderBottom: cardBorder, flexWrap: 'wrap' }}>
              {c.metrics.map((m, i) => (
                <div key={i} style={{ flex: '1 1 130px', padding: '12px 16px', borderRight: i < c.metrics.length - 1 ? '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))' : undefined }}>
                  <div style={{ ...EYEBROW, fontSize: 8, marginBottom: 6 }}>{m.label}</div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 18, fontWeight: 700, color: m.subTone === 'pos' && m.label.includes('YoY') ? T.pos : T.text }}>{m.value}</div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: TONE[m.subTone], marginTop: 2 }}>{m.sub}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              <div style={{ flex: '1.4 1 320px', padding: '14px 16px', borderRight: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))' }}>
                <div style={{ ...EYEBROW, fontSize: 8, color: T.gold, marginBottom: 8 }}>AI summary</div>
                <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, lineHeight: 1.65, color: T.text }}>{c.summary}</div>
              </div>
              <div style={{ flex: '1 1 240px', padding: '14px 16px' }}>
                <div style={{ ...EYEBROW, fontSize: 8, marginBottom: 8 }}>Segment revenue</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                  {c.segments.map(s => (
                    <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text, width: 96 }}>{s.label}</span>
                      <div style={{ flex: 1, height: 13, background: 'rgba(255,255,255,0.04)' }}>
                        <div style={{ width: `${s.pct}%`, height: '100%', background: T.blue, opacity: 0.5 }} />
                      </div>
                      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text, width: 48, textAlign: 'right' }}>{s.value}</span>
                    </div>
                  ))}
                </div>
                <div style={{ border: `1px solid ${T.goldTint(30)}`, background: T.goldTint(5), padding: '8px 11px', marginTop: 12 }}>
                  <div style={{ ...EYEBROW, fontSize: 8, color: T.gold, marginBottom: 3 }}>{c.guidance.label}</div>
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text }}>{c.guidance.text} · <span style={{ color: TONE[c.guidance.tailTone] }}>{c.guidance.tail}</span></div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export const SAMPLE_EARNINGS: EarningsData = {
  generated: 'Jun 18, 2026 · 11:41 AM',
  cards: [
    {
      ticker: 'NVDA', name: 'NVIDIA Corp', mono: 'NV', period: 'Q1 FY2026 · reported May 28 · after close', reaction: 6.4,
      metrics: [
        { label: 'EPS', value: '$0.96', sub: 'vs $0.92 est · beat +4.3%', subTone: 'pos' },
        { label: 'Revenue', value: '$44.1B', sub: 'vs $43.3B est · beat +1.8%', subTone: 'pos' },
        { label: 'Rev YoY', value: '+69%', sub: 'vs +75% prior Q', subTone: 'muted' },
        { label: 'Gross margin', value: '71.0%', sub: '−180bps QoQ', subTone: 'neg' },
      ],
      summary: 'Another clean double-beat driven by Data Center, up 73% YoY to $39.1B as the Blackwell ramp offset the $4.5B H20 China write-down. Gross margin compressed on the charge but management guided a return to the mid-70s by year-end. Sequential growth is decelerating off a huge base, and the China headwind is now an explicit risk. Guidance for Q2 came in slightly ahead of the Street.',
      segments: [
        { label: 'Data Center', value: '$39.1B', pct: 89 }, { label: 'Gaming', value: '$3.8B', pct: 9 },
        { label: 'Auto', value: '$0.6B', pct: 2 }, { label: 'Pro Viz', value: '$0.5B', pct: 2 },
      ],
      guidance: { label: 'Q2 guidance', text: '$45.0B ±2%', tail: 'above $44.8B cons', tailTone: 'pos' },
    },
    {
      ticker: 'AAPL', name: 'Apple Inc.', mono: 'AA', period: 'Q2 FY2026 · reported May 1 · after close', reaction: 0.8,
      metrics: [
        { label: 'EPS', value: '$1.65', sub: 'vs $1.63 est · beat +1.2%', subTone: 'pos' },
        { label: 'Revenue', value: '$95.4B', sub: 'vs $94.6B est · beat +0.8%', subTone: 'pos' },
        { label: 'Rev YoY', value: '+5.1%', sub: 'Services record', subTone: 'muted' },
        { label: 'Gross margin', value: '47.1%', sub: '+40bps QoQ', subTone: 'pos' },
      ],
      summary: 'A modest beat carried by Services, which hit a record $26.6B at 75% gross margin and now anchors the multiple. iPhone was roughly flat as the upgrade cycle stayed muted, and Greater China declined 2% YoY. Management called out tariff exposure as a $900M cost headwind next quarter but reiterated the buyback. Quality of the beat is high given the margin mix shift toward Services.',
      segments: [
        { label: 'iPhone', value: '$46.8B', pct: 74 }, { label: 'Services', value: '$26.6B', pct: 42 },
        { label: 'Mac + iPad', value: '$15.8B', pct: 25 }, { label: 'Wearables', value: '$6.2B', pct: 10 },
      ],
      guidance: { label: 'Q3 guidance', text: 'Rev +low-to-mid single digits', tail: 'in line', tailTone: 'muted' },
    },
  ],
}
