import { Link2, Link2Off } from 'lucide-react'
import { useTickerLink, setLinkOn } from '../lib/tickerLink'

// Sidebar chip for linked-ticker mode. ON: gold, shows the shared symbol every
// linked tool inherits. OFF: muted. Sits under the command-palette launcher.
export default function TickerLinkChip({ collapsed }: { collapsed: boolean }) {
  const { on, sym } = useTickerLink()
  const GOLD = 'var(--theme-primary, #c9a84c)'
  const SEC = 'var(--theme-secondary, #8099b0)'
  return (
    <div style={{ margin: '6px 8px 0' }}>
      <button
        onClick={() => setLinkOn(!on)}
        title={on
          ? `Linked ticker mode on${sym ? `. Tools open with ${sym}` : ''}. Click to unlink.`
          : 'Link tools to one ticker: any symbol you open follows you across tools.'}
        style={{
          width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between', gap: 8,
          padding: collapsed ? '6px 0' : '6px 10px', cursor: 'pointer',
          background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'var(--theme-bg, #101c2e)',
          border: `1px solid ${on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)' : 'var(--theme-border, rgba(255,255,255,0.1))'}`,
          color: on ? GOLD : SEC, fontFamily: 'var(--theme-sans)',
        }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {on ? <Link2 size={13} /> : <Link2Off size={13} />}
          {!collapsed && (
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              {on ? 'Linked' : 'Link ticker'}
            </span>
          )}
        </span>
        {!collapsed && on && sym && (
          <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700 }}>{sym}</span>
        )}
      </button>
    </div>
  )
}
