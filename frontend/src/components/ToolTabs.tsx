// Shared underline tab bar for consolidated tools (Implied Volatility, Market
// Maker Simulator, Implied Volatility). Active tab in gold with an underline.
export interface ToolTab { key: string; label: string }

export default function ToolTabs({ tabs, value, onChange }: { tabs: ToolTab[]; value: string; onChange: (k: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
      {tabs.map(t => {
        const active = t.key === value
        return (
          <button key={t.key} onClick={() => onChange(t.key)}
            style={{
              fontFamily: 'var(--theme-sans)', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              padding: '8px 14px', cursor: 'pointer', background: 'none', border: 'none', marginBottom: -1,
              color: active ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
              borderBottom: `2px solid ${active ? 'var(--theme-primary, #c9a84c)' : 'transparent'}`,
              transition: 'color 0.12s ease',
            }}>
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
