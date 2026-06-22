// Standalone preview of the redesigned tool pages (sample data, no live fetches).
// Reached at /redesign — chrome-free so each tool shows in its own faithful shell
// slice. Not linked in nav; existing pages are untouched. Adding a tool = import
// its component + sample and add one TOOLS entry.
import { useState } from 'react'
import { T } from '../../lib/theme'
import { ToolFrame } from './shell'
import DcfRedesign, { SAMPLE_DCF, SampleDcfRail } from './DcfRedesign'
import SectorRotationRedesign, { SAMPLE_SECTOR } from './SectorRotationRedesign'
import OptionsFlowRedesign, { SAMPLE_FLOW } from './OptionsFlowRedesign'
import EarningsRedesign, { SAMPLE_EARNINGS } from './EarningsRedesign'
import ScreenerRedesign, { SAMPLE_SCREEN } from './ScreenerRedesign'
import NavTrackerRedesign, { SAMPLE_NAV } from './NavTrackerRedesign'
import DealerGexRedesign, { SAMPLE_GEX } from './DealerGexRedesign'
import BacktesterRedesign, { SAMPLE_BACKTEST } from './BacktesterRedesign'
import MonteCarloRedesign, { SAMPLE_MONTE } from './MonteCarloRedesign'

interface Entry { key: string; label: string; rail: number; node?: React.ReactNode }

const TOOLS: Entry[] = [
  { key: 'dcf', label: 'DCF Valuation', rail: 1, node: <DcfRedesign data={SAMPLE_DCF} rail={<SampleDcfRail />} subtitle="Apple Inc. · AAPL · Technology" /> },
  { key: 'sector', label: 'Sector Rotation', rail: 1, node: <SectorRotationRedesign data={SAMPLE_SECTOR} /> },
  { key: 'options', label: 'Options Flow', rail: 2, node: <OptionsFlowRedesign data={SAMPLE_FLOW} /> },
  { key: 'earnings', label: 'Earnings AI', rail: 0, node: <EarningsRedesign data={SAMPLE_EARNINGS} /> },
  { key: 'screener', label: 'Stock Screener', rail: 0, node: <ScreenerRedesign data={SAMPLE_SCREEN} /> },
  { key: 'nav', label: 'NAV Tracker', rail: 1, node: <NavTrackerRedesign data={SAMPLE_NAV} /> },
  { key: 'gex', label: 'Dealer GEX', rail: 2, node: <DealerGexRedesign data={SAMPLE_GEX} /> },
  { key: 'backtest', label: 'Backtester', rail: 3, node: <BacktesterRedesign data={SAMPLE_BACKTEST} /> },
  { key: 'montecarlo', label: 'Monte Carlo', rail: 3, node: <MonteCarloRedesign data={SAMPLE_MONTE} /> },
]

function Placeholder({ label }: { label: string }) {
  return (
    <div style={{ padding: 64, textAlign: 'center', fontFamily: 'var(--theme-mono)', fontSize: 12, color: T.muted }}>
      {label} — in progress
    </div>
  )
}

export default function ToolsRedesignDemo() {
  const [active, setActive] = useState(TOOLS[0].key)
  const tool = TOOLS.find(t => t.key === active) ?? TOOLS[0]
  return (
    <div style={{ minHeight: '100vh', background: T.surface, padding: '28px 24px 64px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto 22px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'Cinzel, serif', fontSize: 16, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.gold }}>Tools Redesign</span>
          <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: T.muted }}>Preview · sample data · existing pages unchanged</span>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 16 }}>
          {TOOLS.map(t => {
            const on = t.key === active
            return (
              <button key={t.key} onClick={() => setActive(t.key)} style={{
                fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', padding: '7px 12px', cursor: 'pointer',
                color: on ? T.gold : T.muted,
                border: `1px solid ${on ? T.gold : T.border}`,
                background: on ? T.goldTint(8) : 'transparent',
                opacity: t.node ? 1 : 0.55,
              }}>{t.label}{!t.node && ' ·'}</button>
            )
          })}
        </div>
      </div>
      <ToolFrame railActive={tool.rail}>
        {tool.node ?? <Placeholder label={tool.label} />}
      </ToolFrame>
    </div>
  )
}
