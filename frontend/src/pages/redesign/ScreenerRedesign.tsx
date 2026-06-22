import { T } from '../../lib/theme'
import { TitleBar, EYEBROW } from '../valuationShared'

export interface ScreenRow {
  ticker: string; name: string; sector: string; price: string; mktCap: string
  pe: string; fwdPe: string; revGr: number; margin: string; oneY: number
}
export interface ScreenData {
  filters: { metric: string; op: string; value: string }[]
  matches: number; chips: string[]; rows: ScreenRow[]; showing: string
}

const rail = '1px solid var(--theme-border, rgba(255,255,255,0.08))'
const box: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, border: '1px solid var(--theme-border, rgba(255,255,255,0.1))', padding: '6px 8px' }
const railLabel: React.CSSProperties = { ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', marginBottom: 4 }
const th: React.CSSProperties = { ...EYEBROW, fontSize: 9, letterSpacing: '0.08em', padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.1))' }
const td: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 11, color: T.text, padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }

export default function ScreenerRedesign({ data }: { data: ScreenData }) {
  return (
    <>
      <TitleBar name="STOCK SCREENER" subtitle="Market cap, valuation, growth, profitability"
        right={<span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>US equities · updated 11:42 AM</span>} />
      <div style={{ display: 'flex' }}>
        {/* filter rail */}
        <div style={{ width: 236, flex: 'none', borderRight: rail }}>
          <div style={{ padding: '11px 14px', borderBottom: rail }}><span style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.16em', color: T.gold }}>Screen Controls</span></div>
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div><div style={railLabel}>Sector</div><div style={{ ...box, display: 'flex', justifyContent: 'space-between' }}>All Sectors <span style={{ color: T.muted }}>▾</span></div></div>
            <div><div style={railLabel}>Exchange</div><div style={{ ...box, display: 'flex', justifyContent: 'space-between' }}>All Exchanges <span style={{ color: T.muted }}>▾</span></div></div>
            <div style={{ ...EYEBROW, fontSize: 9, letterSpacing: '0.13em', color: T.muted, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.07))', paddingTop: 11 }}>Filters</div>
            {data.filters.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ ...box, fontSize: 10, flex: 1, padding: '5px 7px' }}>{f.metric}</span>
                <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: T.gold, border: `1px solid ${T.goldTint(40)}`, padding: '5px 8px' }}>{f.op}</span>
                <span style={{ ...box, fontSize: 10, padding: '5px 8px', width: 46 }}>{f.value}</span>
              </div>
            ))}
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: T.muted }}>+ Add filter</div>
            <div style={{ display: 'flex', gap: 8, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.07))', paddingTop: 11 }}>
              <div style={{ flex: 1 }}><div style={{ ...railLabel, letterSpacing: '0.1em' }}>Sort by</div><div style={box}>Mkt Cap</div></div>
              <div style={{ width: 58 }}><div style={{ ...railLabel, letterSpacing: '0.1em' }}>Dir</div><div style={{ ...box, textAlign: 'center' }}>↓</div></div>
            </div>
            <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(8), color: T.gold, textAlign: 'center', padding: '8px 0', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>Run Screen</div>
          </div>
        </div>
        {/* results */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderBottom: rail, background: T.hover, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, fontWeight: 700, color: T.gold }}>{data.matches} matches</span>
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>sorted by market cap</span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {data.chips.map(c => <span key={c} style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: T.muted, border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', padding: '3px 9px' }}>{c}</span>)}
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={{ ...th, textAlign: 'left', padding: '8px 14px' }}>Ticker</th>
              <th style={{ ...th, textAlign: 'left' }}>Sector</th>
              <th style={th}>Price</th>
              <th style={{ ...th, color: T.gold }}>Mkt Cap</th>
              <th style={th}>P/E</th><th style={th}>Fwd P/E</th><th style={th}>Rev Gr</th><th style={th}>Margin</th>
              <th style={{ ...th, padding: '8px 14px' }}>1Y</th>
            </tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.ticker}>
                  <td style={{ ...td, textAlign: 'left', padding: '7px 14px' }}><span style={{ fontWeight: 700 }}>{r.ticker}</span> <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>{r.name}</span></td>
                  <td style={{ ...td, textAlign: 'left', fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>{r.sector}</td>
                  <td style={td}>{r.price}</td>
                  <td style={td}>{r.mktCap}</td>
                  <td style={td}>{r.pe}</td>
                  <td style={td}>{r.fwdPe}</td>
                  <td style={{ ...td, color: r.revGr >= 0 ? T.pos : T.neg }}>+{r.revGr.toFixed(1)}%</td>
                  <td style={td}>{r.margin}</td>
                  <td style={{ ...td, padding: '7px 14px', color: r.oneY >= 0 ? T.pos : T.neg }}>+{r.oneY.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))' }}><span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: T.muted }}>{data.showing}</span></div>
        </div>
      </div>
    </>
  )
}

export const SAMPLE_SCREEN: ScreenData = {
  filters: [
    { metric: 'Mkt Cap ($B)', op: '>', value: '50' },
    { metric: 'P/E', op: '<', value: '35' },
    { metric: 'Rev growth %', op: '>', value: '10' },
  ],
  matches: 47, chips: ['Mkt cap > $50B', 'P/E < 35', 'Rev gr > 10%'], showing: 'Showing 10 of 47 matches',
  rows: [
    { ticker: 'NVDA', name: 'NVIDIA', sector: 'Technology', price: '$211.15', mktCap: '$5.15T', pe: '32.1', fwdPe: '28.4', revGr: 69.2, margin: '55.8%', oneY: 41.3 },
    { ticker: 'MSFT', name: 'Microsoft', sector: 'Technology', price: '$498.20', mktCap: '$3.70T', pe: '34.6', fwdPe: '30.1', revGr: 15.8, margin: '36.2%', oneY: 18.9 },
    { ticker: 'GOOGL', name: 'Alphabet', sector: 'Communication', price: '$201.40', mktCap: '$2.44T', pe: '24.8', fwdPe: '21.3', revGr: 13.9, margin: '28.6%', oneY: 22.1 },
    { ticker: 'AMZN', name: 'Amazon', sector: 'Consumer Disc.', price: '$243.94', mktCap: '$2.55T', pe: '33.9', fwdPe: '26.7', revGr: 11.2, margin: '9.8%', oneY: 12.4 },
    { ticker: 'META', name: 'Meta Platforms', sector: 'Communication', price: '$712.30', mktCap: '$1.81T', pe: '26.4', fwdPe: '22.8', revGr: 16.5, margin: '37.9%', oneY: 29.7 },
    { ticker: 'AVGO', name: 'Broadcom', sector: 'Technology', price: '$268.70', mktCap: '$1.26T', pe: '31.6', fwdPe: '27.0', revGr: 44.0, margin: '29.4%', oneY: 38.5 },
    { ticker: 'JPM', name: 'JPMorgan', sector: 'Financials', price: '$298.10', mktCap: '$821.0B', pe: '13.4', fwdPe: '14.1', revGr: 11.6, margin: '32.7%', oneY: 24.8 },
    { ticker: 'LLY', name: 'Eli Lilly', sector: 'Health Care', price: '$902.40', mktCap: '$812.0B', pe: '34.2', fwdPe: '28.9', revGr: 32.4, margin: '24.1%', oneY: 15.2 },
    { ticker: 'V', name: 'Visa', sector: 'Financials', price: '$352.80', mktCap: '$682.0B', pe: '31.0', fwdPe: '27.5', revGr: 10.4, margin: '53.1%', oneY: 14.0 },
    { ticker: 'COST', name: 'Costco', sector: 'Consumer Staples', price: '$1,041.20', mktCap: '$462.0B', pe: '52.8', fwdPe: '48.0', revGr: 10.9, margin: '3.0%', oneY: 9.7 },
  ],
}
