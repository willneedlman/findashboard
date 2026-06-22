import { T } from '../../lib/theme'
import { TitleBar, EYEBROW } from '../valuationShared'

export interface FlowRow {
  ticker: string; type: 'CALL' | 'PUT'; strike: string; expiry: string; dte: string
  spot: string; otm: number; volume: string; oi: string; volOi: string; hot?: boolean; iv: string; premium: string
}
export interface FlowData {
  asOf: string; subtitle: string
  totalPrem: string; callPct: number; callPrem: string; putPrem: string
  topVolOi: string; mostActive: string
  byTicker: { sym: string; callW: number; putW: number; total: string }[]
  rows: FlowRow[]
}

const filterCell = (label: string, value: string, flex?: number) => (
  <div style={{ padding: '9px 14px', flex }}>
    <span style={{ ...EYEBROW, fontSize: 8, letterSpacing: '0.12em', color: T.muted, display: 'block', marginBottom: 3 }}>{label}</span>
    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text }}>{value}</span>
  </div>
)

const th: React.CSSProperties = {
  ...EYEBROW, fontSize: 9, letterSpacing: '0.08em', padding: '8px 10px', textAlign: 'right',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.1))',
}
const td: React.CSSProperties = {
  fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, padding: '7px 10px', textAlign: 'right',
  borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))',
}

export default function OptionsFlowRedesign({ data }: { data: FlowData }) {
  return (
    <>
      <TitleBar name="OPTIONS FLOW" subtitle={data.subtitle}
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>as of {data.asOf}</span>} />

      {/* filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: T.hover, padding: '0 8px' }}>
        {filterCell('Tickers', 'blank = liquid default set', 1)}
        {filterCell('Expiries', '2 nearest')}
        {filterCell('Min volume', '300')}
        {filterCell('Min vol/OI', '1.5')}
        <div style={{ padding: '9px 14px' }}>
          <span style={{ ...EYEBROW, letterSpacing: '0.12em', color: T.gold, border: `1px solid ${T.gold}`, background: T.goldTint(8), padding: '6px 16px' }}>Scan</span>
        </div>
      </div>

      {/* summary strip */}
      <div style={{ display: 'flex', alignItems: 'stretch', flexWrap: 'wrap', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'rgba(0,0,0,0.16)' }}>
        <div style={{ padding: '14px 22px', borderRight: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))' }}>
          <div style={{ ...EYEBROW, marginBottom: 7 }}>Total premium</div>
          <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 26, fontWeight: 700, color: T.gold, lineHeight: 1 }}>{data.totalPrem}</div>
        </div>
        <div style={{ flex: 1, minWidth: 240, padding: '14px 22px', display: 'flex', flexDirection: 'column', justifyContent: 'center', borderRight: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ ...EYEBROW, color: T.pos }}>Calls {data.callPct}%</span>
            <span style={{ ...EYEBROW, color: T.neg }}>Puts {100 - data.callPct}%</span>
          </div>
          <div style={{ display: 'flex', height: 10, border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={{ width: `${data.callPct}%`, background: T.posTint(55) }} />
            <div style={{ flex: 1, background: T.negTint(50) }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.pos }}>{data.callPrem}</span>
            <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.neg }}>{data.putPrem}</span>
          </div>
        </div>
        <div style={{ padding: '14px 22px', display: 'flex', gap: 24, alignItems: 'center' }}>
          <div><div style={{ ...EYEBROW, marginBottom: 6 }}>Top vol/OI</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 15, color: T.gold }}>{data.topVolOi}</div></div>
          <div><div style={{ ...EYEBROW, marginBottom: 6 }}>Most active</div><div style={{ fontFamily: 'var(--theme-mono)', fontSize: 15, color: T.text }}>{data.mostActive}</div></div>
        </div>
      </div>

      {/* premium by ticker */}
      <div style={{ padding: '14px 22px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
          <span style={{ ...EYEBROW, color: T.text }}>Premium by ticker</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, background: T.posTint(55) }} /><span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.muted }}>calls</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, background: T.negTint(50) }} /><span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.muted }}>puts</span></div>
        </div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {data.byTicker.map(b => (
            <div key={b.sym} style={{ flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: T.text, width: 46 }}>{b.sym}</span>
              <div style={{ flex: 1, display: 'flex', height: 16, background: 'rgba(255,255,255,0.03)' }}>
                <div style={{ width: `${b.callW}%`, background: T.posTint(50) }} />
                <div style={{ width: `${b.putW}%`, background: T.negTint(45) }} />
              </div>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.text, width: 52, textAlign: 'right' }}>{b.total}</span>
            </div>
          ))}
        </div>
      </div>

      {/* scanner table */}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={{ ...th, textAlign: 'left', padding: '8px 14px' }}>Ticker</th>
          <th style={{ ...th, textAlign: 'left' }}>Type</th>
          {['Strike', 'Expiry', 'DTE', 'Spot', 'OTM%', 'Volume', 'OI'].map(h => <th key={h} style={th}>{h}</th>)}
          <th style={{ ...th, color: T.gold }}>Vol/OI</th>
          <th style={th}>IV%</th>
          <th style={{ ...th, padding: '8px 14px' }}>Premium</th>
        </tr></thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i}>
              <td style={{ ...td, textAlign: 'left', padding: '7px 14px', fontWeight: 700 }}>{r.ticker}</td>
              <td style={{ ...td, textAlign: 'left' }}><span style={{ fontSize: 10, color: r.type === 'CALL' ? T.pos : T.neg }}>{r.type}</span></td>
              <td style={td}>{r.strike}</td>
              <td style={{ ...td, color: T.muted }}>{r.expiry}</td>
              <td style={{ ...td, color: T.muted }}>{r.dte}</td>
              <td style={td}>{r.spot}</td>
              <td style={{ ...td, color: r.otm >= 0 ? T.pos : T.neg }}>{r.otm >= 0 ? '+' : '−'}{Math.abs(r.otm).toFixed(1)}%</td>
              <td style={td}>{r.volume}</td>
              <td style={{ ...td, color: T.muted }}>{r.oi}</td>
              <td style={{ ...td, color: r.hot ? T.gold : T.text, fontWeight: r.hot ? 700 : 400, background: r.hot ? T.goldTint(16) : undefined }}>{r.volOi}</td>
              <td style={{ ...td, color: T.muted }}>{r.iv}</td>
              <td style={{ ...td, padding: '7px 14px' }}>{r.premium}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export const SAMPLE_FLOW: FlowData = {
  asOf: '11:39:32 AM', subtitle: '60 contracts · min vol/OI 1.5 · 2 nearest expiries',
  totalPrem: '$182.4M', callPct: 68, callPrem: '$124.0M', putPrem: '$58.4M',
  topVolOi: 'AMZN 2982+', mostActive: 'NVDA 41.1K',
  byTicker: [
    { sym: 'TSLA', callW: 38, putW: 36, total: '$45.8M' },
    { sym: 'SPY', callW: 64, putW: 4, total: '$44.1M' },
    { sym: 'QQQ', callW: 60, putW: 6, total: '$36.4M' },
    { sym: 'NVDA', callW: 52, putW: 5, total: '$32.5M' },
  ],
  rows: [
    { ticker: 'TSLA', type: 'CALL', strike: '390.00', expiry: '06-22', dte: '4d', spot: '393.20', otm: -0.8, volume: '26,533', oi: '773', volOi: '34.3', hot: true, iv: '31.0', premium: '$17.78M' },
    { ticker: 'TSLA', type: 'PUT', strike: '400.00', expiry: '06-22', dte: '4d', spot: '393.20', otm: 1.7, volume: '17,816', oi: '2,585', volOi: '6.9', iv: '31.7', premium: '$16.26M' },
    { ticker: 'QQQ', type: 'CALL', strike: '737.00', expiry: '06-22', dte: '4d', spot: '739.77', otm: -0.4, volume: '22,884', oi: '679', volOi: '33.7', hot: true, iv: '15.7', premium: '$13.83M' },
    { ticker: 'SPY', type: 'CALL', strike: '745.00', expiry: '06-22', dte: '4d', spot: '747.17', otm: -0.3, volume: '28,195', oi: '2,568', volOi: '11.0', iv: '9.5', premium: '$11.83M' },
    { ticker: 'NVDA', type: 'CALL', strike: '210.00', expiry: '06-22', dte: '4d', spot: '211.15', otm: -0.5, volume: '41,100', oi: '9,708', volOi: '4.2', iv: '22.7', premium: '$11.59M' },
    { ticker: 'SPY', type: 'CALL', strike: '747.00', expiry: '06-22', dte: '4d', spot: '747.17', otm: 0.0, volume: '36,465', oi: '947', volOi: '38.5', hot: true, iv: '9.0', premium: '$10.57M' },
    { ticker: 'TSLA', type: 'PUT', strike: '395.00', expiry: '06-22', dte: '4d', spot: '393.20', otm: 0.5, volume: '20,010', oi: '1,195', volOi: '16.7', iv: '31.2', premium: '$11.71M' },
    { ticker: 'AMZN', type: 'PUT', strike: '275.00', expiry: '06-22', dte: '4d', spot: '243.94', otm: 12.7, volume: '2,982', oi: '0', volOi: '2982+', hot: true, iv: '27.4', premium: '$9.30M' },
    { ticker: 'QQQ', type: 'CALL', strike: '740.00', expiry: '06-22', dte: '4d', spot: '739.77', otm: 0.0, volume: '21,340', oi: '2,822', volOi: '7.6', iv: '15.0', premium: '$9.09M' },
  ],
}
