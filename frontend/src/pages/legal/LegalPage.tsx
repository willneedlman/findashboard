import { Link } from 'react-router-dom'
import PageWrapper from '../../components/PageWrapper'

const S = {
  bg:     '#101c2e',
  border: '#2e394d',
  header: '#142032',
  gold:   '#c9a84c',
  text:   '#d7e3fc',
  muted:  '#5e768f',
  dim:    '#3a4d62',
  mono:   'JetBrains Mono, monospace',
  label:  'IBM Plex Sans, sans-serif',
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontFamily: S.mono, fontSize: 12, fontWeight: 700, color: S.gold, letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 10, borderBottom: `1px solid ${S.border}`, paddingBottom: 6 }}>
        {title}
      </h2>
      <div style={{ fontFamily: S.label, fontSize: 13, color: S.text, lineHeight: 1.75 }}>
        {children}
      </div>
    </div>
  )
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: '0 0 10px' }}>{children}</p>
}

function UL({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: '0 0 10px', paddingLeft: 20 }}>
      {items.map((item, i) => <li key={i} style={{ marginBottom: 4, color: S.muted }}>{item}</li>)}
    </ul>
  )
}

interface Props { title: string; lastUpdated: string; children: React.ReactNode }

export default function LegalPage({ title, lastUpdated, children }: Props) {
  return (
    <PageWrapper>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {/* Back */}
        <Link to="/" style={{ fontFamily: S.label, fontSize: 11, color: S.muted, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 24, letterSpacing: '0.06em' }}>
          ← Back to Terminal
        </Link>

        {/* Header */}
        <div style={{ background: S.header, border: `1px solid ${S.border}`, padding: '16px 20px', marginBottom: 28 }}>
          <h1 style={{ fontFamily: S.mono, fontSize: 16, fontWeight: 700, color: S.gold, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 4px' }}>
            {title}
          </h1>
          <span style={{ fontFamily: S.label, fontSize: 10, color: S.dim }}>Last updated: {lastUpdated}</span>
        </div>

        {/* Content */}
        <div style={{ background: S.bg, border: `1px solid ${S.border}`, padding: '24px 24px 32px' }}>
          {children}
        </div>
      </div>
    </PageWrapper>
  )
}

export { Section, P, UL }
