import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import { Panel, MONO, SANS, BRIGHT, DIM, ROW_LINE } from './ui'
import { DASH, shortDate } from './format'

interface NewsItem {
  id?: string
  content?: {
    title?: string
    description?: string
    pubDate?: string
    displayTime?: string
    provider?: { displayName?: string }
    canonicalUrl?: { url?: string }
    clickThroughUrl?: { url?: string }
  }
}

interface Filing {
  form?: string; date?: string; url?: string; accession?: string
  /** 8-K item codes. A filing has no title on this source, so the items are
   *  what distinguishes one 8-K from the next. */
  items?: string | string[]
}

const FORM_LABEL: Record<string, string> = {
  '10-K': 'Annual report',
  '10-Q': 'Quarterly report',
  '8-K': 'Current report',
  '4': 'Insider transaction',
  '3': 'Initial insider holdings',
  '5': 'Annual insider statement',
  'DEF 14A': 'Proxy statement',
  'S-8': 'Employee benefit registration',
  'SC 13G': 'Passive stake',
  'SC 13D': 'Activist stake',
  '144': 'Proposed insider sale',
}

/** What the row says about the filing. Item codes when the form carries them,
 *  otherwise what the form IS. The accession number is an internal identifier
 *  and was the only thing most rows showed. */
function describe(f: Filing): string {
  const items = Array.isArray(f.items) ? f.items.join(', ') : f.items
  const label = FORM_LABEL[(f.form ?? '').trim()]
  if (items) return label ? `${label} \u00b7 items ${items}` : `Items ${items}`
  return label ?? f.accession ?? DASH
}

/** "4h ago" / "3d ago". A wall-clock timestamp makes a reader do the
 *  subtraction; a headline feed is read by recency. */
function age(iso?: string): string {
  if (!iso) return DASH
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return DASH
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000))
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

const LIST_MAX_HEIGHT = 520

/** Forms in the order a reader looks for them, not the order they were filed.
 *  Anything the issuer files that is not in this list still gets a chip, after
 *  these. */
const FORM_ORDER = ['10-K', '10-Q', '8-K', 'DEF 14A', '4']

export default function NewsTab({ ticker }: { ticker: string }) {
  const [form, setForm] = useState<string>('all')
  const news = useQuery<{ news?: NewsItem[] }>({
    queryKey: ['cp-news', ticker],
    queryFn: () => axios.get(`/api/market/news?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const filings = useQuery<{ filings?: Filing[] }>({
    queryKey: ['cp-filings', ticker],
    queryFn: () => axios.get(`/api/filings/filings/${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 600_000, retry: 0, enabled: !!ticker,
  })

  const items = news.data?.news ?? []
  const allFilings = filings.data?.filings ?? []

  const forms = useMemo(() => {
    const present = new Set(allFilings.map(f => f.form).filter((f): f is string => !!f))
    const known = FORM_ORDER.filter(f => present.has(f))
    const rest = [...present].filter(f => !FORM_ORDER.includes(f)).sort()
    return [...known, ...rest]
  }, [allFilings])

  const rows = form === 'all' ? allFilings : allFilings.filter(f => f.form === form)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 20, alignItems: 'start' }}>
      <Panel
        title="SEC filings"
        meta={allFilings.length
          ? (form === 'all' ? `${allFilings.length} most recent` : `${rows.length} of ${allFilings.length}`)
          : undefined}
      >
        {forms.length > 1 && (
          <div style={{
            display: 'flex', gap: 2, flexWrap: 'wrap',
            padding: '9px 14px', borderBottom: `1px solid ${T.borderFaint}`,
          }}>
            {['all', ...forms].map(f => {
              const on = f === form
              return (
                <button key={f} onClick={() => setForm(f)} style={{
                  fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                  padding: '3px 8px', cursor: 'pointer', background: 'transparent',
                  border: `1px solid ${on ? 'color-mix(in srgb, var(--theme-primary) 40%, transparent)' : 'transparent'}`,
                  color: on ? T.gold : T.muted,
                  transition: 'color 120ms cubic-bezier(0.23,1,0.32,1), border-color 120ms cubic-bezier(0.23,1,0.32,1)',
                }}>
                  {f === 'all' ? 'All' : f}
                </button>
              )
            })}
          </div>
        )}
        {rows.length ? (
          <div style={{
            maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto',
            maskImage: 'linear-gradient(to bottom, #000 calc(100% - 26px), transparent)',
            WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 26px), transparent)',
          }}>
          {rows.map((f, i) => (
            <a
              key={`${f.form}-${f.date}-${i}`}
              href={f.url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 18px', borderBottom: i === rows.length - 1 ? 'none' : ROW_LINE,
                textDecoration: 'none', color: 'inherit',
              }}
            >
              <span style={{
                fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
                color: T.gold, minWidth: 66, textAlign: 'center',
                padding: '3px 6px',
                border: '1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)',
                background: 'color-mix(in srgb, var(--theme-primary) 5%, transparent)',
              }}>
                {f.form ?? DASH}
              </span>
              <span style={{
                flex: 1, fontFamily: SANS, fontSize: 12, color: T.text, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {describe(f)}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: T.muted }}>{shortDate(f.date)}</span>
              <span style={{ color: T.gold }}>›</span>
            </a>
          ))}
          </div>
        ) : (
          <Note>
            {filings.isLoading
              ? 'Loading filings.'
              : allFilings.length
                ? `No ${form} filings in this window.`
                : 'No filings indexed for this symbol. Expected for a security that does not file with the SEC.'}
          </Note>
        )}
      </Panel>

      <Panel title="Headline feed" meta={items.length ? `${items.length} stories` : undefined}>
        {items.length ? (
          <div style={{
            maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto',
            maskImage: 'linear-gradient(to bottom, #000 calc(100% - 26px), transparent)',
            WebkitMaskImage: 'linear-gradient(to bottom, #000 calc(100% - 26px), transparent)',
          }}>
          {items.map((n, i) => {
            const c = n.content ?? {}
            const url = c.clickThroughUrl?.url || c.canonicalUrl?.url
            const body = (
              <>
                <div style={{
                  fontFamily: SANS, fontSize: 12.5, lineHeight: 1.55, color: BRIGHT,
                  textWrap: 'pretty',
                }}>
                  {c.title ?? DASH}
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 7, flexWrap: 'wrap' }}>
                  <span style={{
                    fontFamily: MONO, fontSize: 10, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: T.muted,
                  }}>
                    {c.provider?.displayName ?? DASH}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: DIM }}>
                    {age(c.pubDate ?? c.displayTime)}
                  </span>
                </div>
              </>
            )
            const style: React.CSSProperties = {
              display: 'block', padding: '13px 18px',
              borderBottom: i === items.length - 1 ? 'none' : ROW_LINE,
              textDecoration: 'none', color: 'inherit',
            }
            return url
              ? <a key={n.id ?? i} href={url} target="_blank" rel="noreferrer" style={style}>{body}</a>
              : <div key={n.id ?? i} style={style}>{body}</div>
          })}
          </div>
        ) : (
          <Note>
            {news.isLoading ? 'Loading headlines.' : 'No headlines published for this symbol.'}
          </Note>
        )}
      </Panel>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 18, fontFamily: MONO, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
      {children}
    </div>
  )
}
