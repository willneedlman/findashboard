import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { CalendarClock, CalendarRange, AlertTriangle, Inbox, Loader2 } from 'lucide-react'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import { MOCK_EVENTS, type MacroEvent } from '../data/mockEventsData'
import EventCard from '../components/macroEvents/EventCard'
import FilterBar, { type Filters } from '../components/macroEvents/FilterBar'

interface EventsResponse { events: MacroEvent[]; source: string; as_of?: string; note?: string }

function SummaryStat({ icon, value, label, color }: { icon: React.ReactNode; value: number; label: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, background: T.surface, border: `1px solid ${T.border}`, padding: '13px 16px', flex: '1 1 150px' }}>
      <span style={{ color, display: 'flex' }}>{icon}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color: T.text, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>{label}</span>
      </div>
    </div>
  )
}

function Section({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ color: T.gold, display: 'flex' }}>{icon}</span>
        <h2 style={{ margin: 0, fontFamily: T.label, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text }}>{title}</h2>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>({count})</span>
        <span style={{ flex: 1, height: 1, background: T.border, marginLeft: 4 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </section>
  )
}

function MacroEventHubContent() {
  const [filters, setFilters] = useState<Filters>({ query: '', region: 'ALL', impact: 'ALL' })

  const { data, isLoading } = useQuery<EventsResponse>({
    queryKey: ['macro-events'],
    queryFn: async () => (await axios.get('/api/macro-events')).data,
    staleTime: 6 * 3600 * 1000,
  })

  // Live FRED feed when it returns events, the bundled seed otherwise so the page
  // is never empty.
  const live = (data?.events?.length ?? 0) > 0
  const events = live ? data!.events : MOCK_EVENTS
  const source = live ? (data!.source ?? 'FRED') : 'seed'

  const filtered = useMemo(() => {
    const q = filters.query.trim().toLowerCase()
    return events.filter(e => {
      if (filters.region !== 'ALL' && e.region !== filters.region) return false
      if (filters.impact !== 'ALL' && e.impact !== filters.impact) return false
      if (q && !(`${e.name} ${e.country} ${e.category}`.toLowerCase().includes(q))) return false
      return true
    })
  }, [filters, events])

  const upcoming = useMemo(
    () => filtered.filter(e => e.status === 'upcoming').sort((a, b) => +new Date(a.datetime) - +new Date(b.datetime)),
    [filtered],
  )
  const released = useMemo(
    () => filtered.filter(e => e.status === 'released').sort((a, b) => +new Date(b.datetime) - +new Date(a.datetime)),
    [filtered],
  )

  return (
    <PageWrapper title="Macro Event Release Hub">
      <style>{'@keyframes me-spin{to{transform:rotate(360deg)}}'}</style>
      <p style={{ fontFamily: T.label, fontSize: 12.5, color: T.muted, margin: '0 0 12px', maxWidth: 720, lineHeight: 1.5 }}>
        Major US economic releases on one feed, with the print, the prior read, and the release-day cross-asset reaction. Search by name and filter by region or impact.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, fontFamily: T.label, fontSize: 10, color: T.muted }}>
        {isLoading
          ? <><Loader2 size={12} style={{ animation: 'me-spin 0.7s linear infinite' }} /> Loading live releases</>
          : live
            ? <><span style={{ width: 6, height: 6, borderRadius: '50%', background: T.pos, display: 'inline-block' }} /> Live from {source}. Reaction is the release-day move. Consensus is not published on this data tier.</>
            : <><span style={{ width: 6, height: 6, borderRadius: '50%', background: T.gold, display: 'inline-block' }} /> Showing bundled seed. Live feed unavailable.</>}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <SummaryStat icon={<CalendarRange size={20} />} value={events.length} label="Tracked" color={T.blue} />
        <SummaryStat icon={<CalendarClock size={20} />} value={events.filter(e => e.status === 'upcoming').length} label="Upcoming" color={T.gold} />
        <SummaryStat icon={<AlertTriangle size={20} />} value={events.filter(e => e.impact === 'High').length} label="High Impact" color={T.neg} />
      </div>

      <FilterBar filters={filters} onChange={setFilters} count={filtered.length} />

      {filtered.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '56px 20px', color: T.muted, border: `1px dashed ${T.border}` }}>
          <Inbox size={30} />
          <span style={{ fontFamily: T.label, fontSize: 13 }}>No events match these filters.</span>
          <button type="button" onClick={() => setFilters({ query: '', region: 'ALL', impact: 'ALL' })}
            style={{ marginTop: 4, padding: '6px 14px', background: 'transparent', border: `1px solid ${T.goldTint(50)}`, color: T.gold, fontFamily: T.label, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            Reset filters
          </button>
        </div>
      )}

      {upcoming.length > 0 && (
        <Section icon={<CalendarClock size={15} />} title="Upcoming" count={upcoming.length}>
          {upcoming.map(e => <EventCard key={e.id} event={e} />)}
        </Section>
      )}
      {released.length > 0 && (
        <Section icon={<CalendarRange size={15} />} title="Recent Releases" count={released.length}>
          {released.map(e => <EventCard key={e.id} event={e} />)}
        </Section>
      )}
    </PageWrapper>
  )
}

export default function MacroEventHub() {
  return <MacroEventHubContent />
}
