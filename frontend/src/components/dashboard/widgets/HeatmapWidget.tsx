import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'

const T = {
  bg: 'var(--theme-bg, #101c2e)', muted: 'var(--theme-secondary, #5e768f)',
  text: 'var(--theme-text, #d7e3fc)', mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
}

interface Tile { t: string; cap: number; chg: number }
interface Sector { name: string; tiles: Tile[] }
const SECTORS: Sector[] = [
  { name: 'Technology', tiles: [{ t: 'AAPL', cap: 34, chg: 0.9 }, { t: 'MSFT', cap: 30, chg: -1.5 }, { t: 'NVDA', cap: 28, chg: -2.4 }, { t: 'AVGO', cap: 12, chg: 1.2 }, { t: 'AMD', cap: 8, chg: -3.1 }, { t: 'CRM', cap: 6, chg: 0.4 }] },
  { name: 'Comm Svcs', tiles: [{ t: 'GOOGL', cap: 24, chg: 1.1 }, { t: 'META', cap: 22, chg: 1.8 }, { t: 'NFLX', cap: 9, chg: -0.6 }, { t: 'DIS', cap: 6, chg: 0.3 }] },
  { name: 'Consumer', tiles: [{ t: 'AMZN', cap: 28, chg: -0.4 }, { t: 'TSLA', cap: 16, chg: -1.6 }, { t: 'HD', cap: 9, chg: 0.7 }, { t: 'MCD', cap: 7, chg: 0.2 }, { t: 'NKE', cap: 5, chg: -2.2 }] },
  { name: 'Financials', tiles: [{ t: 'JPM', cap: 18, chg: 0.6 }, { t: 'BRK.B', cap: 16, chg: 0.4 }, { t: 'V', cap: 12, chg: 1.0 }, { t: 'BAC', cap: 8, chg: -0.9 }, { t: 'MA', cap: 9, chg: 0.8 }] },
  { name: 'Healthcare', tiles: [{ t: 'LLY', cap: 16, chg: 2.1 }, { t: 'UNH', cap: 12, chg: -1.1 }, { t: 'JNJ', cap: 10, chg: 0.3 }, { t: 'MRK', cap: 7, chg: -0.5 }, { t: 'ABBV', cap: 6, chg: 0.9 }] },
  { name: 'Energy', tiles: [{ t: 'XOM', cap: 12, chg: -1.8 }, { t: 'CVX', cap: 9, chg: -1.2 }, { t: 'COP', cap: 5, chg: -2.6 }] },
]
function heat(p: number): string {
  const x = Math.max(-1, Math.min(1, p / 4))
  return x >= 0 ? `rgba(34,197,94,${(0.12 + x * 0.5).toFixed(2)})` : `rgba(239,68,68,${(0.12 + -x * 0.5).toFixed(2)})`
}

export default function HeatmapWidget({ config: _c }: { config: WidgetConfig }) {
  return (
    <div style={{ display: 'flex', height: '100%', gap: 2, padding: 2, background: T.bg, overflow: 'hidden' }}>
      {SECTORS.map(sec => {
        const w = sec.tiles.reduce((s, t) => s + t.cap, 0)
        return (
          <div key={sec.name} style={{ flexGrow: w, flexBasis: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontFamily: T.label, fontSize: 7, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0, paddingLeft: 1 }}>{sec.name}</div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {sec.tiles.map(t => (
                <div key={t.t} style={{ flexGrow: t.cap, flexBasis: 0, minHeight: 0, background: heat(t.chg), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, overflow: 'hidden', padding: 1 }}>
                  {t.cap >= 6 && <TickerLogo ticker={t.t} size={Math.round(Math.min(22, 9 + t.cap / 3))} />}
                  <span style={{ fontFamily: T.mono, fontSize: Math.min(11, 6 + t.cap / 6), fontWeight: 700, color: T.text, lineHeight: 1, whiteSpace: 'nowrap' }}>{t.t}</span>
                  {t.cap >= 9 && <span style={{ fontFamily: T.mono, fontSize: 8, color: 'rgba(255,255,255,0.75)', marginTop: 1 }}>{t.chg >= 0 ? '+' : ''}{t.chg.toFixed(1)}%</span>}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
