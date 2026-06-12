import { Link } from 'react-router-dom'

const S = {
  border: 'var(--theme-border, rgba(255,255,255,0.07))',
  muted:  'var(--theme-text-faint, var(--theme-text-faint, rgba(255,255,255,0.22)))',
  text:   'var(--theme-secondary, #5e768f)',
  gold:   'var(--theme-primary, #c9a84c)',
  mono:   'var(--theme-mono)',
  label:  'var(--theme-sans)',
}

const LINKS = [
  { label: 'Privacy Policy',    to: '/privacy' },
  { label: 'Terms of Use',      to: '/terms' },
  { label: 'Risk Disclosure',   to: '/risk-disclosure' },
  { label: 'Data Sources',      to: '/data-sources' },
]

export default function Footer() {
  return (
    <footer style={{
      borderTop: `1px solid ${S.border}`,
      marginTop: 32,
      padding: '18px 0 28px',
    }}>
      {/* Disclaimer banner */}
      <div style={{
        background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 4%, var(--theme-surface, #0d1826))',
        border: `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 20%, transparent)`,
        borderLeft: `3px solid var(--theme-primary, #c9a84c)`,
        borderRadius: 3,
        padding: '10px 16px',
        marginBottom: 18,
      }}>
        <p style={{
          fontFamily: S.label, fontSize: 10, color: S.text, lineHeight: 1.65,
          margin: 0,
        }}>
          <span style={{ color: S.gold, fontWeight: 700, letterSpacing: '0.08em' }}>IMPORTANT DISCLAIMER · </span>
          This platform is provided for <strong style={{ color: S.text }}>informational and educational purposes only</strong> and does not
          constitute investment advice, financial advice, trading advice, or any other type of advice. Nothing on this
          platform should be construed as a recommendation to buy, sell, or hold any security, financial product, or
          instrument. All data, analytics, and model outputs are provided without warranty of accuracy or completeness.
          Options, derivatives, and leveraged instruments involve substantial risk of loss and are not appropriate for all
          investors. Past performance is not indicative of future results. You should consult a qualified financial adviser
          before making any investment decision.
        </p>
      </div>

      {/* Links row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {LINKS.map(({ label, to }) => (
            <Link
              key={to}
              to={to}
              style={{
                fontFamily: S.label, fontSize: 10, color: S.text,
                textDecoration: 'none', letterSpacing: '0.08em',
                transition: 'color 0.12s',
              }}
              onMouseEnter={e => ((e.target as HTMLElement).style.color = S.gold)}
              onMouseLeave={e => ((e.target as HTMLElement).style.color = S.text)}
            >
              {label}
            </Link>
          ))}
        </div>
        <span style={{ fontFamily: S.mono, fontSize: 9, color: S.muted, letterSpacing: '0.1em' }}>
          © {new Date().getFullYear()} Alphatape Terminal · Not FINRA/SEC registered · Not investment advice
        </span>
      </div>
    </footer>
  )
}
