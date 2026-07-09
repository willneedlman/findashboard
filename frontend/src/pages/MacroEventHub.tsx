import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Loader2, Inbox } from 'lucide-react'
import { T } from '../lib/theme'
import { useTheme } from '../contexts/ThemeContext'
import PageWrapper from '../components/PageWrapper'
import { MOCK_EVENTS, type MacroEvent } from '../data/mockEventsData'
import MacroToolbar, { type Filters } from '../components/macroEvents/MacroToolbar'
import ReleaseTape, { type Section, type Sort } from '../components/macroEvents/ReleaseTape'
import { dayKey, dayLabel, sortValue } from '../components/macroEvents/tapeUtils'

interface EventsResponse { events: MacroEvent[]; source: string; note?: string }
interface AlertRow { id: string; condition: string; payload: string | null }
const ALERT_DAYS = 3   // heads-up window for a tape bell
const seriesName = (e: MacroEvent) => e.name.split(' (')[0]

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>{label}</span>
    </span>
  )
}

function MacroEventHubContent() {
  const [filters, setFilters] = useState<Filters>({ query: '', region: 'ALL', impact: 'ALL', from: '', to: '' })
  const [sort, setSort] = useState<Sort>({ column: 'time', dir: 'asc' })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const { user } = useTheme()
  const qc = useQueryClient()

  // Countdowns re-render once a minute.
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 60_000); return () => clearInterval(id) }, [])

  const { data, isLoading } = useQuery<EventsResponse>({
    queryKey: ['macro-events'],
    queryFn: async () => (await axios.get('/api/macro-events')).data,
    staleTime: 6 * 3600 * 1000,
  })

  const live = (data?.events?.length ?? 0) > 0
  const events = useMemo(() => (live ? data!.events : MOCK_EVENTS), [live, data])

  // Default range spans the currently loaded events. Derived (not stored) so it
  // tracks the live set once it replaces the seed; a user edit sets filters.from
  // and takes over.
  const defaultRange = useMemo(() => {
    if (!events.length) return { from: '', to: '' }
    const d = events.map(e => e.datetime.slice(0, 10)).sort()
    return { from: d[0], to: d[d.length - 1] }
  }, [events])
  const fromEff = filters.from || defaultRange.from
  const toEff = filters.to || defaultRange.to

  // Release-tape bells are real macro alerts, keyed by event series name so all
  // rows of one series (e.g. every CPI print) share a single recurring alert.
  const { data: alertData } = useQuery<{ alerts: AlertRow[] }>({
    queryKey: ['alerts', user?.id],
    queryFn: () => axios.get(`/api/alerts/${user!.id}`).then(r => r.data),
    enabled: !!user,
  })
  const seriesAlerts = useMemo(() => {
    const map = new Map<string, string>()   // series name -> alert id
    for (const a of alertData?.alerts ?? []) {
      if (a.condition !== 'macro_event_within_days' || !a.payload) continue
      try {
        const p = JSON.parse(a.payload)
        if (p.source === 'release-hub') for (const n of p.names ?? []) map.set(n, a.id)
      } catch { /* skip malformed */ }
    }
    return map
  }, [alertData])

  const createMut = useMutation({
    mutationFn: (body: object) => axios.post('/api/alerts', body).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts', user?.id] }),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => axios.delete(`/api/alerts/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts', user?.id] }),
  })

  const isAlerted = (e: MacroEvent) => seriesAlerts.has(seriesName(e))
  const toggleAlert = (e: MacroEvent) => {
    if (!user) return
    const name = seriesName(e)
    const existing = seriesAlerts.get(name)
    if (existing) deleteMut.mutate(existing)
    else createMut.mutate({ user_id: user.id, ticker: 'MARKET', condition: 'macro_event_within_days', threshold: ALERT_DAYS, payload: { source: 'release-hub', names: [name], label: name } })
  }

  const onSort = (col: Sort['column']) =>
    setSort(s => (s.column === col ? { column: col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { column: col, dir: 'asc' }))

  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase()
    const [lo, hi] = fromEff && toEff && fromEff > toEff ? [toEff, fromEff] : [fromEff, toEff]
    return events.filter(e => {
      if (filters.region !== 'ALL' && e.region !== filters.region) return false
      if (filters.impact !== 'ALL' && e.impact !== filters.impact) return false
      if (q && !`${e.name} ${e.country} ${e.category}`.toLowerCase().includes(q)) return false
      const d = e.datetime.slice(0, 10)
      if (lo && d < lo) return false
      if (hi && d > hi) return false
      return true
    })
  }, [events, filters, fromEff, toEff])

  const sections: Section[] = useMemo(() => {
    if (sort.column !== 'time') {
      const dir = sort.dir === 'asc' ? 1 : -1
      const rows = [...filtered].sort((a, b) => {
        const va = sortValue(a, sort.column), vb = sortValue(b, sort.column)
        return va < vb ? -dir : va > vb ? dir : 0
      })
      return [{ id: 'flat', label: null, rows }]
    }
    const up = filtered.filter(e => e.status === 'upcoming').sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime))
    const rel = filtered.filter(e => e.status === 'released').sort((a, b) => +new Date(b.datetime) - +new Date(a.datetime))
    const out: Section[] = []

    let curKey = ''
    for (const e of up) {
      const k = dayKey(e.datetime)
      if (k !== curKey) { curKey = k; out.push({ id: 'up-' + k, label: dayLabel(e.datetime), sub: '', rows: [] }) }
      out[out.length - 1].rows.push(e)
    }
    for (const s of out) {
      const high = s.rows.filter(r => r.impact === 'High').length
      s.sub = `${s.rows.length} RELEASE${s.rows.length > 1 ? 'S' : ''}${high ? ` · ${high} HIGH` : ''}`
    }

    if (rel.length) {
      const recentKey = dayKey(rel[0].datetime)
      const recent = rel.filter(e => dayKey(e.datetime) === recentKey)
      const earlier = rel.filter(e => dayKey(e.datetime) !== recentKey)
      out.push({ id: 'rel-recent', label: `RELEASED · ${dayLabel(rel[0].datetime).replace(' · ', ' ')}`, muted: true, rows: recent })
      if (earlier.length) out.push({ id: 'rel-earlier', label: 'RELEASED · EARLIER', muted: true, rows: earlier })
    }
    return out
  }, [filtered, sort])

  const nextHigh = useMemo(() =>
    events.filter(e => e.status === 'upcoming' && e.impact === 'High')
      .sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime))[0] ?? null, [events])

  const stats = useMemo(() => ({
    tracked: events.length,
    upcoming: events.filter(e => e.status === 'upcoming').length,
    high: events.filter(e => e.impact === 'High').length,
  }), [events])

  return (
    <PageWrapper>
      <div style={{ overflowX: 'auto' }}>
        <div style={{ width: '100%', minWidth: 960, maxWidth: 1700, margin: '0 auto' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, paddingBottom: 14, borderBottom: `1px solid ${T.goldTint(45)}` }}>
            <h1 className="ft-page-title" style={{ margin: 0 }}>MACRO EVENT RELEASE HUB</h1>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.label, fontSize: 10, color: T.muted }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: live ? T.pos : T.gold, display: 'inline-block' }} />
              {isLoading ? 'Loading live releases' : live ? 'Live · FRED + Rate Engine' : 'Showing bundled seed'}
            </span>
            <span style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 22 }}>
              <Stat value={stats.tracked} label="Tracked" color={T.text} />
              <Stat value={stats.upcoming} label="Upcoming" color={T.gold} />
              <Stat value={stats.high} label="High Impact" color={T.neg} />
            </div>
          </div>

          <MacroToolbar filters={{ ...filters, from: fromEff, to: toEff }} onChange={setFilters} count={filtered.length} />

          {filtered.length === 0
            ? <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '56px 20px', color: T.muted, border: `1px dashed ${T.border}`, background: T.surface }}>
                {isLoading ? <Loader2 size={22} style={{ animation: 'me-spin 0.7s linear infinite' }} /> : <Inbox size={28} />}
                <span style={{ fontFamily: T.label, fontSize: 13 }}>{isLoading ? 'Loading live releases…' : 'No events match these filters.'}</span>
                {!isLoading && <button type="button" onClick={() => setFilters(f => ({ ...f, query: '', region: 'ALL', impact: 'ALL' }))}
                  style={{ marginTop: 4, padding: '6px 14px', background: 'transparent', border: `1px solid ${T.goldTint(50)}`, color: T.gold, fontFamily: T.label, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Reset filters</button>}
              </div>
            : <ReleaseTape sections={sections} totalCount={filtered.length} nextHigh={nextHigh}
                sort={sort} onSort={onSort}
                expandedId={expandedId} onToggle={id => setExpandedId(cur => (cur === id ? null : id))}
                isAlerted={isAlerted} onAlert={toggleAlert} />}
        </div>
      </div>
      <style>{'@keyframes me-spin{to{transform:rotate(360deg)}}.mev-expand{transition:grid-template-rows 180ms cubic-bezier(0.23,1,0.32,1)}.mev-fade{transition:opacity 180ms ease}@media (prefers-reduced-motion: reduce){.mev-expand,.mev-fade{transition:none}}'}</style>
    </PageWrapper>
  )
}

export default function MacroEventHub() {
  return <MacroEventHubContent />
}
