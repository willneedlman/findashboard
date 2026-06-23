import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import TickerLogo from '../components/TickerLogo'
import { fetchBondByCusip, fetchBondAnalytics, searchBondsByIssuer, resolveCusipBatch } from '../hooks/useApi'
import {
  INPUT, EYEBROW, PANEL, PRIMARY_BTN, TitleBar, TitleAction, VerdictStrip, MetricCard,
  toneColor, type VerdictTone,
} from './valuationShared'

const G = 'var(--theme-primary, #c9a84c)'
const SURFACE = 'var(--theme-surface, #0d1826)'
const BG = 'var(--theme-bg, #101c2e)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const HAIR = 'rgba(255,255,255,0.05)'
const SEC = 'var(--theme-secondary, #8099b0)'
const TEXT = 'var(--theme-text, #d7e3fc)'
const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'

interface ResolvedBond {
  found: boolean
  cusip: string
  source?: string
  figi?: string
  name?: string
  ticker?: string
  description?: string
  type?: string
  market_sector?: string
  coupon_rate?: number | null
  maturity_date?: string | null
  issue_date?: string | null
  years_to_maturity?: number | null
  market_price?: number | null
  price_source?: string | null
  price_as_of?: string | null
}
interface Derived { ytm: number; mod_duration: number; convexity: number }
interface BatchRow {
  cusip: string; found: boolean; error?: string
  name?: string; type?: string; coupon_rate?: number | null
  maturity_date?: string | null; market_price?: number | null
  price_source?: string | null; price_as_of?: string | null; ytm?: number | null
}

const RECENTS_KEY = 'ft_cusip_recents'
const SEED_RECENTS = ['037833AL4', '06051GGR4', '91282CQQ7']

// A CUSIP is 8 alphanumeric chars + a numeric check digit; the trailing-digit
// anchor keeps 9-letter issuer names (e.g. "microsoft") out of the CUSIP path.
const isCusip = (s: string) => /^[A-Z0-9]{8}[0-9]$/.test(s.toUpperCase().replace(/\s+/g, ''))

// Derive YTM/duration/convexity for a resolved bond. Requires a real price mark:
// without one there is no yield to solve, so we return null rather than invent an
// at-par figure that just echoes the coupon. Degrades to null if the model fails.
async function deriveFor(r: ResolvedBond): Promise<Derived | null> {
  if (r.coupon_rate == null || !r.years_to_maturity || r.market_price == null) return null
  try {
    const a = await fetchBondAnalytics({
      face: 1000, coupon_rate: r.coupon_rate,
      market_price: Math.round((r.market_price / 100) * 1000),
      maturity: Math.max(1, Math.round(r.years_to_maturity)),
    })
    return { ytm: a.ytm, mod_duration: a.mod_duration, convexity: a.convexity }
  } catch {
    return null
  }
}

const scaleOf = (b: ResolvedBond): { label: string; tone: VerdictTone } => {
  const sec = (b.market_sector || '').toLowerCase()
  if (b.source === 'treasury' || sec === 'govt') return { label: 'GOVT', tone: 'blue' }
  if (sec === 'muni') return { label: 'MUNI', tone: 'blue' }
  if (sec === 'corp') return { label: 'CORP', tone: 'gold' }
  return { label: (b.type || 'BOND').slice(0, 4).toUpperCase(), tone: 'muted' }
}
const monogram = (name?: string) => (name || '??').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '??'
// The issuer's equity ticker is the leading token of the bond ticker/description
// (e.g. "AAPL 3.85 05/04/43" -> "AAPL"), used to fetch the company logo.
const equityTickerOf = (b: ResolvedBond): string | null => {
  const first = (b.ticker || b.description || '').trim().split(/\s+/)[0] || ''
  return /^[A-Za-z]{1,5}$/.test(first) ? first.toUpperCase() : null
}
const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))
const num = (v: number | null | undefined, suffix = '') => (v == null ? '—' : `${v}${suffix}`)

function ScaleBadge({ s }: { s: { label: string; tone: VerdictTone } }) {
  const c = toneColor(s.tone)
  return (
    <span style={{ fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', color: c,
      border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`, padding: '2px 6px', whiteSpace: 'nowrap' }}>{s.label}</span>
  )
}

function BondCard({ cusip, bond, onClick, saved }: { cusip: string; bond?: ResolvedBond; onClick: () => void; saved?: boolean }) {
  const s = bond ? scaleOf(bond) : null
  return (
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderLeft: saved ? `2px solid ${G}` : `1px solid ${BORDER}`,
        padding: '13px 14px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 12, color: G, letterSpacing: '0.04em' }}>{saved ? '★ ' : ''}{cusip}</span>
        {s && <ScaleBadge s={s} />}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {bond?.name ? bond.name : cusip}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${HAIR}`, paddingTop: 6, fontFamily: MONO, fontSize: 10, color: SEC }}>
        <span>{bond?.coupon_rate != null ? `${bond.coupon_rate}%` : '—'} · {bond?.maturity_date || '—'}</span>
      </div>
    </div>
  )
}

const Strip = ({ children }: { children: React.ReactNode }) => (
  <div style={{ background: '#0d1826', padding: '8px 14px', ...EYEBROW }}>{children}</div>
)

function LayoutToggle({ layout, setView }: { layout: 'A' | 'B'; setView: (l: 'A' | 'B') => void }) {
  return (
    <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
      {(['A', 'B'] as const).map(l => (
        <button key={l} onClick={() => setView(l)} style={{
          fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
          padding: '6px 12px', cursor: 'pointer', border: 'none',
          color: layout === l ? G : SEC,
          background: layout === l ? 'rgba(201,168,76,0.1)' : 'transparent',
          borderRight: l === 'A' ? `1px solid ${BORDER}` : 'none',
        }}>{l === 'A' ? 'A · Cockpit' : 'B · Ledger'}</button>
      ))}
    </div>
  )
}

function CandidateCard({ b, onClick }: { b: ResolvedBond; onClick: () => void }) {
  return (
    <div role="button" tabIndex={0} onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      style={{ background: SURFACE, border: `1px solid ${BORDER}`, padding: '13px 14px', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 600, color: G }}>{num(b.coupon_rate, '%')}</span>
        <ScaleBadge s={scaleOf(b)} />
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, color: TEXT }}>Due {b.maturity_date || '—'}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${HAIR}`, paddingTop: 6, fontFamily: MONO, fontSize: 10, color: SEC }}>
        <span>{b.years_to_maturity != null ? `${b.years_to_maturity} yrs` : '—'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{b.description || ''}</span>
      </div>
    </div>
  )
}

export default function CusipLookup() {
  const nav = useNavigate()
  const [query, setQuery] = useState('')
  const [layout, setLayout] = useState<'A' | 'B'>(() => (localStorage.getItem('ft_cusip_layout') as 'A' | 'B') || 'A')
  const [result, setResult] = useState<ResolvedBond | null>(null)
  const [derived, setDerived] = useState<Derived | null>(null)
  const [candidates, setCandidates] = useState<ResolvedBond[] | null>(null)
  const [badQuery, setBadQuery] = useState<string | null>(null)
  const [recents, setRecents] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || 'null') || SEED_RECENTS } catch { return SEED_RECENTS }
  })
  const [cache, setCache] = useState<Record<string, ResolvedBond>>({})
  const [tab, setTab] = useState<'single' | 'batch'>('single')

  const setView = (l: 'A' | 'B') => { setLayout(l); localStorage.setItem('ft_cusip_layout', l) }
  const pushRecent = (cu: string) => setRecents(prev => {
    const next = [cu, ...prev.filter(r => r !== cu)].slice(0, 4)
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)) } catch { /* */ }
    return next
  })

  // CUSIP path: resolve identity + price, then derive analytics.
  const cusipMut = useMutation({
    mutationFn: async (raw: string) => {
      const r: ResolvedBond = await fetchBondByCusip(raw.toUpperCase().replace(/\s+/g, ''))
      return { r, d: r.found ? await deriveFor(r) : null }
    },
    onSuccess: ({ r, d }, raw) => {
      if (!r.found) { setResult(null); setDerived(null); setBadQuery(raw); return }
      setBadQuery(null); setCandidates(null); setResult(r); setDerived(d)
      setCache(c => ({ ...c, [r.cusip]: r }))
      pushRecent(r.cusip)
    },
  })

  // Issuer path: list the issuer's outstanding bonds (no CUSIP, terms only).
  const searchMut = useMutation({
    mutationFn: (raw: string) => searchBondsByIssuer(raw.trim()),
    onSuccess: (res: { results: ResolvedBond[] }, raw) => {
      const list = res.results || []
      if (!list.length) { setCandidates(null); setResult(null); setDerived(null); setBadQuery(raw); return }
      setBadQuery(null); setResult(null); setDerived(null); setCandidates(list)
    },
  })

  // Pick a listed candidate: promote to the full result view + derive at par.
  // Keep the candidate list in state so the result can return to it.
  const pickMut = useMutation({
    mutationFn: async (b: ResolvedBond) => ({ r: b, d: await deriveFor(b) }),
    onSuccess: ({ r, d }) => { setResult(r); setDerived(d) },
  })
  const backToList = () => { setResult(null); setDerived(null) }

  const isPending = cusipMut.isPending || searchMut.isPending || pickMut.isPending
  const isError = cusipMut.isError || searchMut.isError || pickMut.isError

  const run = (raw: string) => {
    if (!raw.trim()) return
    setBadQuery(null); setCandidates(null)
    if (isCusip(raw)) cusipMut.mutate(raw)
    else searchMut.mutate(raw)
  }
  const onSubmit = () => run(query)
  const clear = () => {
    setQuery(''); setResult(null); setDerived(null); setCandidates(null); setBadQuery(null)
    cusipMut.reset(); searchMut.reset(); pickMut.reset()
  }

  const seedImport = result && result.coupon_rate != null && result.years_to_maturity
  const doImport = () => {
    if (!result || !seedImport) return
    nav('/bond', { state: { seed: {
      face: 1000, coupon_rate: result.coupon_rate,
      market_price: result.market_price != null ? Math.round((result.market_price / 100) * 1000) : 1000,
      maturity: Math.max(1, Math.round(result.years_to_maturity!)),
      meta: { cusip: result.cusip, name: result.name },
    } } })
  }

  const mode: 'empty' | 'loading' | 'result' | 'candidates' | 'notfound' =
    isPending ? 'loading' : badQuery ? 'notfound'
      : result ? 'result' : candidates ? 'candidates' : 'empty'

  return (
    <PageWrapper>
      <div className="mx-auto w-full max-w-[1180px] 2xl:max-w-[1440px]" style={{ background: 'var(--theme-bg, #0a1422)', border: `1px solid ${BORDER}` }}>
        {/* header */}
        <div style={{ padding: '18px 22px 12px', borderBottom: `1px solid rgba(201,168,76,0.4)` }}>
          <div style={{ ...EYEBROW, letterSpacing: '0.22em' }}>FIXED INCOME · REFERENCE</div>
          <div style={{ fontFamily: MONO, fontSize: 19, fontWeight: 700, letterSpacing: '0.2em', color: G, marginTop: 4 }}>BOND LOOKUP</div>
        </div>

        {/* mode tabs */}
        <div style={{ display: 'flex', gap: 0, padding: '14px 22px 0' }}>
          {([['single', 'Single lookup'], ['batch', 'Batch import']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '8px 16px', cursor: 'pointer', background: 'transparent', border: 'none',
              color: tab === id ? G : SEC, borderBottom: `2px solid ${tab === id ? G : 'transparent'}`,
            }}>{label}</button>
          ))}
        </div>

        {tab === 'batch' ? <BatchView /> : <>

        {/* search bar */}
        <div style={{ padding: '16px 22px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 46, background: BG,
            border: '1px solid rgba(201,168,76,0.45)', padding: '0 14px' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={SEC} strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && onSubmit()}
              placeholder="Enter CUSIP or issuer  (e.g. 037833AL4, Apple, 91282CQQ7)"
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: TEXT, fontFamily: MONO, fontSize: 14 }} />
            {query && <button onClick={clear} aria-label="Clear" style={{ background: 'none', border: 'none', cursor: 'pointer', color: SEC, display: 'flex', padding: 0 }}>✕</button>}
          </div>
          <button onClick={onSubmit} disabled={isPending} style={{ ...PRIMARY_BTN, padding: '0 26px', height: 46, opacity: isPending ? 0.6 : 1 }}>
            {isPending ? 'Resolving…' : 'Look up'}
          </button>
        </div>

        <div style={{ padding: '0 22px 24px' }}>
          {mode === 'empty' && (
            <div>
              <div style={{ ...EYEBROW, letterSpacing: '0.18em', color: G, marginBottom: 10 }}>Recent</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                {recents.map(cu => <BondCard key={cu} cusip={cu} bond={cache[cu]} onClick={() => { setQuery(cu); run(cu) }} />)}
              </div>
            </div>
          )}

          {mode === 'notfound' && (
            <div style={{ background: SURFACE, borderLeft: '2px solid var(--theme-negative, #ef4444)', border: `1px solid ${BORDER}`, padding: '16px 18px' }}>
              <div style={{ fontFamily: SANS, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--theme-negative, #ef4444)' }}>NO SECURITY FOUND</div>
              <div style={{ fontFamily: SANS, fontSize: 12, color: SEC, marginTop: 6, lineHeight: 1.5 }}>
                No bond matches <span style={{ fontFamily: MONO, color: TEXT }}>{badQuery}</span> in the reference set. Check the 9-character CUSIP, or search by issuer name.
              </div>
              <div style={{ fontFamily: MONO, fontSize: 10, color: 'var(--theme-text-dim, #5e768f)', marginTop: 8 }}>CUSIP format: 6 issuer + 2 issue + 1 check digit.</div>
            </div>
          )}

          {mode === 'candidates' && candidates && (
            <div>
              <div style={{ ...EYEBROW, letterSpacing: '0.18em', color: G, marginBottom: 4 }}>{candidates[0]?.name || 'Issuer'} · Outstanding bonds</div>
              <div style={{ fontFamily: SANS, fontSize: 10.5, color: SEC, marginBottom: 12, lineHeight: 1.5 }}>
                Reference terms by issuer. CUSIP and live price are licensed and not shown here; select a bond to view its terms or import it.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
                {candidates.map((c, i) => <CandidateCard key={c.figi || i} b={c} onClick={() => pickMut.mutate(c)} />)}
              </div>
            </div>
          )}

          {isError && <div style={{ fontFamily: SANS, fontSize: 11, color: 'var(--theme-negative, #ef4444)', padding: '12px 0' }}>Server unavailable. Try again.</div>}

          {mode === 'result' && result && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                {candidates && candidates.length ? (
                  <button onClick={backToList} style={{ display: 'flex', alignItems: 'center', gap: 7,
                    fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: SEC, background: 'none', border: `1px solid ${BORDER}`, padding: '6px 12px', cursor: 'pointer' }}>
                    <span style={{ fontSize: 13, lineHeight: 1 }}>←</span> {candidates[0]?.name || 'Issuer'} bonds
                  </button>
                ) : <span />}
                <LayoutToggle layout={layout} setView={setView} />
              </div>
              {layout === 'A'
                ? <CockpitView b={result} d={derived} canImport={!!seedImport} onImport={doImport} />
                : <LedgerView b={result} d={derived} canImport={!!seedImport} onImport={doImport} />}
            </div>
          )}
        </div>
        </>}
      </div>
    </PageWrapper>
  )
}

function parseCusips(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)))
}

function BatchView() {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<BatchRow[] | null>(null)
  const parsed = parseCusips(text)

  const mut = useMutation({
    mutationFn: (list: string[]) => resolveCusipBatch(list),
    onSuccess: (res: { rows: BatchRow[] }) => setRows(res.rows || []),
  })

  const onFile = (f: File | undefined) => {
    if (!f) return
    f.text().then(t => setText(prev => (prev ? prev + '\n' : '') + t))
  }

  const exportCsv = () => {
    if (!rows) return
    const head = ['CUSIP', 'Issuer', 'Type', 'Coupon', 'Maturity', 'Price', 'Yield', 'Price Source', 'As Of']
    const lines = rows.map(r => [
      r.cusip, r.name || '', r.type || '', r.coupon_rate ?? '', r.maturity_date || '',
      r.market_price ?? '', r.ytm ?? '', r.price_source || '', r.price_as_of || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'cusip-batch.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const found = rows?.filter(r => r.found).length ?? 0
  return (
    <div style={{ padding: '16px 22px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontFamily: SANS, fontSize: 11, color: SEC, lineHeight: 1.5 }}>
        Paste or upload up to 100 CUSIPs (separated by commas, spaces, or new lines). Each resolves to issuer, price mark, yield, and the price date. Yield is shown only where a price mark exists.
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={5}
        placeholder={'037833AL4\n91282CQQ7\n06051GGR4'}
        style={{ width: '100%', background: BG, border: '1px solid rgba(201,168,76,0.45)', color: TEXT,
          fontFamily: MONO, fontSize: 13, padding: '12px 14px', outline: 'none', resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => parsed.length && mut.mutate(parsed)} disabled={!parsed.length || mut.isPending}
          style={{ ...PRIMARY_BTN, padding: '0 22px', height: 42, width: 'auto', opacity: !parsed.length || mut.isPending ? 0.5 : 1 }}>
          {mut.isPending ? 'Resolving…' : `Resolve ${parsed.length || ''} CUSIP${parsed.length === 1 ? '' : 's'}`.trim()}
        </button>
        <label style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: SEC, cursor: 'pointer', border: `1px solid ${BORDER}`, padding: '12px 16px' }}>
          Upload .csv / .txt
          <input type="file" accept=".csv,.txt,text/plain,text/csv" style={{ display: 'none' }}
            onChange={e => onFile(e.target.files?.[0])} />
        </label>
        {text && <button onClick={() => { setText(''); setRows(null) }} style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase', color: SEC, background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>}
        {rows && <button onClick={exportCsv} style={{ marginLeft: 'auto', fontFamily: SANS, fontSize: 10, fontWeight: 700,
          letterSpacing: '0.1em', textTransform: 'uppercase', color: G, background: 'none', border: `1px solid color-mix(in srgb, ${G} 40%, transparent)`,
          padding: '10px 14px', cursor: 'pointer' }}>Export CSV</button>}
      </div>

      {mut.isError && <div style={{ fontFamily: SANS, fontSize: 11, color: 'var(--theme-negative, #ef4444)' }}>Server unavailable. Try again.</div>}

      {rows && (
        <div style={{ ...PANEL, padding: 0 }}>
          <Strip>Resolved · {found} of {rows.length} found</Strip>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11.5 }}>
              <thead>
                <tr>{['CUSIP', 'Issuer', 'Coupon', 'Maturity', 'Price', 'Yield', 'As Of'].map((h, i) => (
                  <th key={h} style={{ textAlign: i < 2 ? 'left' : 'right', fontFamily: SANS, fontSize: 9, fontWeight: 700,
                    letterSpacing: '0.1em', textTransform: 'uppercase', color: SEC, padding: '9px 14px',
                    borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid rgba(255,255,255,0.04)` }}>
                    <td style={{ padding: '8px 14px', color: G }}>{r.cusip}</td>
                    <td style={{ padding: '8px 14px', fontFamily: SANS, color: r.found ? TEXT : 'var(--theme-text-dim, #5e768f)' }}>
                      {r.found ? (r.name || '—') : (r.error === 'invalid' ? 'Invalid CUSIP' : 'Not found')}
                    </td>
                    <td style={{ padding: '8px 14px', textAlign: 'right', color: TEXT }}>{r.coupon_rate != null ? `${r.coupon_rate}%` : '—'}</td>
                    <td style={{ padding: '8px 14px', textAlign: 'right', color: TEXT }}>{r.maturity_date || '—'}</td>
                    <td style={{ padding: '8px 14px', textAlign: 'right', color: TEXT }}>{r.market_price != null ? r.market_price : '—'}</td>
                    <td style={{ padding: '8px 14px', textAlign: 'right', color: r.ytm != null ? G : SEC }}>{r.ytm != null ? `${r.ytm}%` : '—'}</td>
                    <td style={{ padding: '8px 14px', textAlign: 'right', color: SEC, whiteSpace: 'nowrap' }}>{r.price_as_of || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '9px 15px', borderTop: `1px solid ${HAIR}`, fontFamily: SANS, fontSize: 9.5, color: 'var(--theme-text-dim, #5e768f)' }}>
            Price marks are ETF/N-PORT holdings, not live quotes. Yield is shown only where a price mark exists. Informational only.
          </div>
        </div>
      )}
    </div>
  )
}

function PriceNote({ b }: { b: ResolvedBond }) {
  if (b.market_price != null) {
    return <span>Price {b.market_price}/100 · {b.price_source}{b.price_as_of ? ` · as of ${b.price_as_of}` : ''}. A mark, not a live quote.</span>
  }
  return <span>Live pricing requires a market-data feed. Reference terms only.</span>
}

function KeyTermsGrid({ b, d }: { b: ResolvedBond; d: Derived | null }) {
  const noPrice = b.market_price == null
  const px = noPrice ? '—' : `${b.market_price}`
  const cells: { label: string; value: string; color?: string; sub?: string }[] = [
    { label: 'Coupon', value: num(b.coupon_rate, '%'), color: G },
    { label: 'Maturity', value: b.maturity_date || '—', sub: b.years_to_maturity ? `${b.years_to_maturity} yrs` : undefined },
    { label: 'Yield to Maturity', value: noPrice ? 'Price required' : (d ? `${d.ytm}%` : '—'), color: noPrice ? SEC : G },
    { label: 'Last Price', value: px, sub: b.price_source || undefined },
    { label: 'Mod. Duration', value: d ? `${d.mod_duration}` : '—' },
    { label: 'Convexity', value: d ? `${d.convexity}` : '—' },
    { label: 'Issue Date', value: b.issue_date || '—' },
    { label: 'Sector', value: b.market_sector || b.type || '—' },
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 1, background: 'rgba(255,255,255,0.06)' }}>
      {cells.map((c, i) => (
        <div key={i} style={{ background: BG, padding: '13px 15px' }}>
          <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: SEC, marginBottom: 5 }}>{c.label}</div>
          <div style={{ fontFamily: MONO, fontSize: 19, fontWeight: 600, color: c.color || TEXT }}>{c.value}</div>
          {c.sub && <div style={{ fontFamily: SANS, fontSize: 9.5, color: 'var(--theme-text-dim, #5e768f)', marginTop: 2 }}>{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}

function CockpitView({ b, d, canImport, onImport }: { b: ResolvedBond; d: Derived | null; canImport: boolean; onImport: () => void }) {
  const s = scaleOf(b)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...PANEL, padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '18px 20px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {equityTickerOf(b)
              ? <TickerLogo ticker={equityTickerOf(b)!} size={52} />
              : <div style={{ width: 52, height: 52, border: `1px solid rgba(201,168,76,0.5)`, background: 'rgba(201,168,76,0.07)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 15, fontWeight: 700, color: G }}>{monogram(b.name)}</div>}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: SANS, fontSize: 21, fontWeight: 700, color: '#f1f5ff', lineHeight: 1 }}>{dash(b.name)}</span>
                <ScaleBadge s={s} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: SANS, fontSize: 11.5, color: SEC }}>{dash(b.type)}</span>
                {(b.cusip || b.figi) && <span style={{ fontFamily: MONO, fontSize: 9, color: G, border: `1px solid color-mix(in srgb, ${G} 30%, transparent)`, padding: '2px 6px' }}>{b.cusip || `FIGI ${b.figi}`}</span>}
                {b.description && <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--theme-text-dim, #5e768f)' }}>{b.description}</span>}
              </div>
            </div>
          </div>
          {canImport && <button onClick={onImport} style={{ ...PRIMARY_BTN, padding: '8px 16px', width: 'auto' }}>Import to Bond Analytics →</button>}
        </div>
      </div>

      <div style={{ ...PANEL, padding: 0 }}>
        <Strip>Key Terms & Analytics</Strip>
        <KeyTermsGrid b={b} d={d} />
        <div style={{ padding: '9px 15px', borderTop: `1px solid ${HAIR}`, fontFamily: SANS, fontSize: 9.5, color: 'var(--theme-text-dim, #5e768f)' }}>
          <PriceNote b={b} /> Settlement T+2, 30/360 day count. Informational only, not a quote.
        </div>
      </div>
    </div>
  )
}

function LedgerView({ b, d, canImport, onImport }: { b: ResolvedBond; d: Derived | null; canImport: boolean; onImport: () => void }) {
  const ref: [string, string][] = [
    ['Issuer', dash(b.name)], ['CUSIP', b.cusip || (b.figi ? `FIGI ${b.figi}` : '—')], ['Security Type', dash(b.type)],
    ['Coupon', num(b.coupon_rate, '%')], ['Maturity', b.maturity_date || '—'],
    ['Years to Maturity', b.years_to_maturity != null ? `${b.years_to_maturity}` : '—'],
    ['Issue Date', b.issue_date || '—'], ['Market Sector', b.market_sector || '—'],
  ]
  const noPrice = b.market_price == null
  const ytmVal = noPrice ? 'Price required' : (d ? `${d.ytm}%` : '—')
  const risk: [string, string][] = [
    ['Last Price', noPrice ? '—' : `${b.market_price}`],
    ['Price Source', b.price_source || '—'], ['As Of', b.price_as_of || '—'],
    ['Yield to Maturity', ytmVal],
    ['Modified Duration', d ? `${d.mod_duration}` : '—'], ['Convexity', d ? `${d.convexity}` : '—'],
    ['Spread to Benchmark', '—'], ['OAS', '—'],
  ]
  return (
    <div style={{ ...PANEL, padding: 0 }}>
      <TitleBar name={b.cusip || b.name || '—'} subtitle={b.cusip ? b.name : b.description} right={canImport
        ? <span onClick={onImport} style={{ cursor: 'pointer' }}><TitleAction label="Import to Bond Analytics →" primary /></span>
        : <TitleAction label={(b.type || 'BOND')} />} />
      <VerdictStrip
        primary={{ label: 'Yield to Maturity', value: ytmVal,
          tone: noPrice ? 'muted' : 'gold', context: b.coupon_rate != null ? `Coupon ${b.coupon_rate}%` : undefined }}
        cells={[
          { label: 'Last Price', value: b.market_price != null ? `${b.market_price}` : '—' },
          { label: 'Mod. Duration', value: d ? `${d.mod_duration}` : '—' },
          { label: 'Convexity', value: d ? `${d.convexity}` : '—' },
          { label: 'Maturity', value: b.maturity_date || '—', sub: b.years_to_maturity ? `${b.years_to_maturity} yrs` : undefined },
        ]}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
        <LedgerTable title="Reference Terms" rows={ref} divider />
        <LedgerTable title="Pricing & Risk" rows={risk} />
      </div>
      <div style={{ padding: '9px 15px', borderTop: `1px solid ${HAIR}`, fontFamily: SANS, fontSize: 9.5, color: 'var(--theme-text-dim, #5e768f)' }}>
        <PriceNote b={b} /> Informational only, not a quote.
      </div>
    </div>
  )
}

function LedgerTable({ title, rows, divider }: { title: string; rows: [string, string][]; divider?: boolean }) {
  return (
    <div style={{ borderRight: divider ? `1px solid ${BORDER}` : undefined }}>
      <Strip>{title}</Strip>
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10,
          padding: '7px 15px', borderBottom: i < rows.length - 1 ? `1px solid rgba(255,255,255,0.04)` : 'none' }}>
          <span style={{ fontFamily: SANS, fontSize: 10, fontWeight: 600, color: SEC }}>{k}</span>
          <span style={{ fontFamily: MONO, fontSize: 11.5, color: TEXT, textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  )
}
