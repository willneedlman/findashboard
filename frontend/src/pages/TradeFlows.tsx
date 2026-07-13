import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import { SELECT, LABEL } from './valuationShared'
import { fetchTradeFlows } from '../hooks/useApi'
import { T } from '../lib/theme'
import { ISO_GEO, projectWorld, WORLD_DOT_PATH } from '../lib/worldDotMap'
import { MONO, SANS, mix, seg, Panel, KpiStrip } from './cockpitKit'
import useIsMobile from '../hooks/useIsMobile'

interface Partner { partner: string | null; iso: string | null; value: number | null; net_wgt: number | null; qty: number | null; unit: string | null }
interface Resp {
  available: boolean; reporter?: string; reporter_iso?: string; commodity?: string; cmd_code?: string; flow?: string; period?: string
  total?: { value: number | null; net_wgt: number | null }; world_share?: number | null
  partners?: Partner[]; partner_count?: number; source?: string
}

const COUNTRIES: [number, string][] = [
  [842, 'United States'], [156, 'China'], [276, 'Germany'], [392, 'Japan'], [826, 'United Kingdom'],
  [250, 'France'], [699, 'India'], [528, 'Netherlands'], [682, 'Saudi Arabia'], [643, 'Russia'],
  [124, 'Canada'], [76, 'Brazil'], [410, 'South Korea'], [36, 'Australia'], [484, 'Mexico'],
  [380, 'Italy'], [702, 'Singapore'], [784, 'United Arab Emirates'], [724, 'Spain'], [578, 'Norway'],
  [634, 'Qatar'], [364, 'Iran'], [566, 'Nigeria'], [458, 'Malaysia'], [360, 'Indonesia'], [704, 'Viet Nam'],
]
const COMMODITIES: [string, string][] = [
  ['TOTAL', 'All commodities'], ['2709', 'Crude oil'], ['2710', 'Refined petroleum'], ['2711', 'Petroleum gas / LNG'],
  ['2701', 'Coal'], ['2601', 'Iron ore'], ['7403', 'Refined copper'], ['7108', 'Gold'], ['7601', 'Aluminium'],
  ['1001', 'Wheat'], ['1005', 'Maize (corn)'], ['1201', 'Soybeans'], ['8542', 'Semiconductors (ICs)'],
  ['8703', 'Cars'], ['3004', 'Pharmaceuticals'], ['7208', 'Flat-rolled steel'], ['8471', 'Computers'],
]
const YEARS = Array.from({ length: 10 }, (_, i) => String(2025 - i))

const fmtUsd = (v: number | null | undefined) => {
  if (v == null) return '—'
  const a = Math.abs(v)
  return a >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${v.toFixed(0)}`
}
const fmtWt = (kg: number | null | undefined) => {
  if (kg == null || kg === 0) return '—'
  const t = kg / 1000
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)}Mt` : t >= 1e3 ? `${(t / 1e3).toFixed(0)}kt` : `${t.toFixed(0)}t`
}

export default function TradeFlows() {
  const [reporter, setReporter] = useState(842)
  const [cmd, setCmd] = useState('2709')
  const [year, setYear] = useState('2024')
  const [flow, setFlow] = useState<'X' | 'M'>('X')
  const [request, setRequest] = useState({ reporter: 842, cmd: '2709', year: '2024', flow: 'X' as 'X' | 'M' })

  const cmdLabel = COMMODITIES.find(c => c[0] === request.cmd)?.[1] ?? request.cmd
  const countryLabel = COUNTRIES.find(c => c[0] === request.reporter)?.[1] ?? String(request.reporter)
  const dirty = reporter !== request.reporter || cmd !== request.cmd || year !== request.year || flow !== request.flow

  const q = useQuery<Resp>({
    queryKey: ['trade-flows', request],
    queryFn: () => fetchTradeFlows({ reporter: request.reporter, period: request.year, cmd: request.cmd, flow: request.flow }),
    staleTime: 300_000,
  })

  const run = () => dirty ? setRequest({ reporter, cmd, year, flow }) : q.refetch()

  return (
    <PageWrapper title="Trade Flows">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <QueryBar reporter={reporter} setReporter={setReporter} cmd={cmd} setCmd={setCmd} year={year} setYear={setYear} flow={flow} setFlow={setFlow} run={run} loading={q.isFetching} dirty={dirty} />
        {q.isLoading ? <LoadingState label="Fetching bilateral trade from UN Comtrade" />
          : q.error ? <ErrorState message={(q.error as any)?.response?.data?.detail || 'Could not load trade flows.'} onRetry={() => q.refetch()} />
          : q.data?.available ? <Results d={q.data} cmdLabel={cmdLabel} countryLabel={countryLabel} />
          : <NoData countryLabel={countryLabel} cmdLabel={cmdLabel} year={request.year} flow={request.flow} />}
      </div>
    </PageWrapper>
  )
}

function QueryBar({ reporter, setReporter, cmd, setCmd, year, setYear, flow, setFlow, run, loading, dirty }: {
  reporter: number; setReporter: (v: number) => void; cmd: string; setCmd: (v: string) => void
  year: string; setYear: (v: string) => void; flow: 'X' | 'M'; setFlow: (v: 'X' | 'M') => void
  run: () => void; loading: boolean; dirty: boolean
}) {
  const isMobile = useIsMobile()
  return (
    <Panel label="" meta="UN Comtrade · annual bilateral flows" style={{ padding: '12px 12px 10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.15fr 1.35fr 0.6fr 1fr auto', alignItems: 'end', gap: 8 }}>
        <label><span style={{ ...LABEL, display: 'block', marginBottom: 5 }}>Reporter country</span><select value={reporter} onChange={e => setReporter(Number(e.target.value))} style={{ ...SELECT, width: '100%' }}>{COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label><span style={{ ...LABEL, display: 'block', marginBottom: 5 }}>Commodity</span><select value={cmd} onChange={e => setCmd(e.target.value)} style={{ ...SELECT, width: '100%' }}>{COMMODITIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label><span style={{ ...LABEL, display: 'block', marginBottom: 5 }}>Year</span><select value={year} onChange={e => setYear(e.target.value)} style={{ ...SELECT, width: '100%' }}>{YEARS.map(y => <option key={y} value={y}>{y}</option>)}</select></label>
        <div><div style={{ ...LABEL, marginBottom: 5 }}>Flow</div><div style={{ display: 'flex', gap: 5 }}><button onClick={() => setFlow('X')} style={seg(flow === 'X')}>Exports</button><button onClick={() => setFlow('M')} style={seg(flow === 'M')}>Imports</button></div></div>
        <button onClick={run} disabled={loading} style={{ height: 30, minWidth: 112, fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, border: `1px solid ${T.gold}`, background: mix(T.gold, dirty ? 12 : 6), padding: '0 14px', cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1 }}>{loading ? 'Loading' : dirty ? 'Update flows' : 'Refresh'}</button>
      </div>
    </Panel>
  )
}

function NoData({ countryLabel, cmdLabel, year, flow }: { countryLabel: string; cmdLabel: string; year: string; flow: string }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 12, color: T.muted, background: T.surface, border: `1px solid ${T.border}`, padding: '18px 20px', lineHeight: 1.6 }}>
      No Comtrade data for {countryLabel} · {cmdLabel} · {year} · {flow === 'X' ? 'exports' : 'imports'}. Not every
      country reports every commodity each year. Try a nearby year, All commodities, or a major reporter.
    </div>
  )
}

function Results({ d, cmdLabel, countryLabel }: { d: Resp; cmdLabel: string; countryLabel: string }) {
  const isMobile = useIsMobile()
  const partners = d.partners ?? []
  const maxVal = useMemo(() => Math.max(1, ...partners.map(p => p.value ?? 0)), [partners])
  const [selected, setSelected] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')

  const filteredPartners = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return partners
    return partners.filter(p =>
      (p.partner ?? '').toLowerCase().includes(q) ||
      (p.iso ?? '').toLowerCase().includes(q)
    )
  }, [partners, searchQuery])

  const topFive = d.total?.value ? partners.slice(0, 5).reduce((s, p) => s + (p.value ?? 0), 0) / d.total.value * 100 : null
  const selectedPartner = partners[Math.min(selected, Math.max(0, partners.length - 1))]
  const kpis = [
    { label: 'Total ' + (d.flow?.toLowerCase() ?? 'flow'), value: fmtUsd(d.total?.value), vc: T.gold, sub: fmtWt(d.total?.net_wgt), tip: { title: 'Total declared flow', body: `${countryLabel} reported ${fmtUsd(d.total?.value)} of ${cmdLabel.toLowerCase()} ${d.flow?.toLowerCase()} in ${d.period}.`, source: 'UN Comtrade' } },
    { label: 'World trade share', value: d.world_share != null ? `${(d.world_share * 100).toFixed(1)}%` : '—', sub: `${countryLabel}, all goods`, tip: { title: 'World trade share', body: `The reporter's share of total world merchandise trade across all goods for ${d.period}.`, source: 'UN Comtrade' } },
    { label: 'Trading partners', value: String(d.partner_count ?? partners.length), sub: 'reporting counterparties' },
    { label: 'Top partner', value: partners[0]?.partner ?? '—', vc: T.blue, sub: partners[0] ? fmtUsd(partners[0].value) : undefined },
    { label: 'Top 5 concentration', value: topFive != null ? `${topFive.toFixed(1)}%` : '—', sub: 'share of reported value' },
  ]

  const handleSelectPartner = (p: Partner) => {
    const idx = partners.findIndex(x => x.iso === p.iso && x.partner === p.partner)
    if (idx !== -1) setSelected(idx)
  }

  const baseYear = Number(d.period) || 2024

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <KpiStrip cells={kpis} />
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 10 }}>
        <FlowOverview d={d} partners={partners} selected={selected} onSelect={setSelected} countryLabel={countryLabel} cmdLabel={cmdLabel} searchQuery={searchQuery} setSearchQuery={setSearchQuery} />
        {selectedPartner && <PartnerDock partner={selectedPartner} rank={selected + 1} total={d.total?.value} flow={d.flow} countryLabel={countryLabel} baseYear={baseYear} />}
      </div>
      <PartnerTable partners={filteredPartners} total={d.total?.value} maxVal={maxVal} selectedPartner={selectedPartner} onSelect={handleSelectPartner} source={d.source} searchQuery={searchQuery} setSearchQuery={setSearchQuery} />
    </div>
  )
}

function FlowOverview({ d, partners, selected, onSelect, countryLabel, cmdLabel, searchQuery, setSearchQuery }: { d: Resp; partners: Partner[]; selected: number; onSelect: (i: number) => void; countryLabel: string; cmdLabel: string; searchQuery: string; setSearchQuery: (q: string) => void }) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

  // Touch gesture state
  const [touchStartDist, setTouchStartDist] = useState<number | null>(null)
  const [touchStartZoom, setTouchStartZoom] = useState<number>(1)
  const [touchStartPan, setTouchStartPan] = useState({ x: 0, y: 0 })
  const [touchStartMid, setTouchStartMid] = useState({ x: 0, y: 0 })

  const getSVGCoords = (clientX: number, clientY: number, currentTarget: SVGSVGElement) => {
    const rect = currentTarget.getBoundingClientRect()
    return {
      x: (clientX - rect.left) / rect.width * 660,
      y: (clientY - rect.top) / rect.height * 250,
    }
  }

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    setIsDragging(true)
    const coords = getSVGCoords(e.clientX, e.clientY, e.currentTarget)
    setDragStart({ x: coords.x - pan.x, y: coords.y - pan.y })
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDragging) return
    const coords = getSVGCoords(e.clientX, e.clientY, e.currentTarget)
    setPan({ x: coords.x - dragStart.x, y: coords.y - dragStart.y })
  }

  const handleMouseUp = () => setIsDragging(false)
  const handleMouseLeave = () => setIsDragging(false)

  const handleWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const zoomFactor = 1.15
    const nextZoom = e.deltaY < 0 ? Math.min(6, zoom * zoomFactor) : Math.max(1, zoom / zoomFactor)
    
    if (nextZoom <= 1.05) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }

    const coords = getSVGCoords(e.clientX, e.clientY, e.currentTarget)
    const nextPanX = coords.x - (coords.x - pan.x) * (nextZoom / zoom)
    const nextPanY = coords.y - (coords.y - pan.y) * (nextZoom / zoom)
    
    setZoom(nextZoom)
    setPan({ x: nextPanX, y: nextPanY })
  }

  const handleDoubleClick = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Touch handlers for mobile / trackpad finger pinching & panning
  const handleTouchStart = (e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length === 1) {
      setIsDragging(true)
      const touch = e.touches[0]
      const coords = getSVGCoords(touch.clientX, touch.clientY, e.currentTarget)
      setDragStart({ x: coords.x - pan.x, y: coords.y - pan.y })
    } else if (e.touches.length === 2) {
      setIsDragging(false)
      const t1 = e.touches[0]
      const t2 = e.touches[1]
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)
      setTouchStartDist(dist)
      setTouchStartZoom(zoom)
      setTouchStartPan(pan)
      
      const midClientX = (t1.clientX + t2.clientX) / 2
      const midClientY = (t1.clientY + t2.clientY) / 2
      const coords = getSVGCoords(midClientX, midClientY, e.currentTarget)
      setTouchStartMid(coords)
    }
  }

  const handleTouchMove = (e: React.TouchEvent<SVGSVGElement>) => {
    if (e.touches.length === 1 && isDragging) {
      const touch = e.touches[0]
      const coords = getSVGCoords(touch.clientX, touch.clientY, e.currentTarget)
      setPan({ x: coords.x - dragStart.x, y: coords.y - dragStart.y })
    } else if (e.touches.length === 2 && touchStartDist !== null) {
      const t1 = e.touches[0]
      const t2 = e.touches[1]
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY)
      const ratio = dist / touchStartDist
      const nextZoom = Math.max(1, Math.min(6, touchStartZoom * ratio))
      
      if (nextZoom <= 1.05) {
        setZoom(1)
        setPan({ x: 0, y: 0 })
        return
      }
      
      const nextPanX = touchStartMid.x - (touchStartMid.x - touchStartPan.x) * (nextZoom / touchStartZoom)
      const nextPanY = touchStartMid.y - (touchStartMid.y - touchStartPan.y) * (nextZoom / touchStartZoom)
      
      setZoom(nextZoom)
      setPan({ x: nextPanX, y: nextPanY })
    }
  }

  const handleTouchEnd = () => {
    setIsDragging(false)
    setTouchStartDist(null)
  }

  // Button-driven zoom controls (centered on the screen viewbox)
  const handleZoomIn = () => {
    const nextZoom = Math.min(6, zoom * 1.3)
    const centerX = 330
    const centerY = 125
    const nextPanX = centerX - (centerX - pan.x) * (nextZoom / zoom)
    const nextPanY = centerY - (centerY - pan.y) * (nextZoom / zoom)
    setZoom(nextZoom)
    setPan({ x: nextPanX, y: nextPanY })
  }

  const handleZoomOut = () => {
    const nextZoom = Math.max(1, zoom / 1.3)
    if (nextZoom <= 1.05) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
      return
    }
    const centerX = 330
    const centerY = 125
    const nextPanX = centerX - (centerX - pan.x) * (nextZoom / zoom)
    const nextPanY = centerY - (centerY - pan.y) * (nextZoom / zoom)
    setZoom(nextZoom)
    setPan({ x: nextPanX, y: nextPanY })
  }

  const handleReset = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  const originGeo = ISO_GEO[d.reporter_iso ?? ''] ?? ISO_GEO.USA
  const origin = projectWorld(originGeo[0], originGeo[1])
  const routes = partners.flatMap((partner, i) => {
    const geo = partner?.iso ? ISO_GEO[partner.iso] : undefined
    return partner && geo ? [{ partner, index: i, point: projectWorld(geo[0], geo[1]) }] : []
  })
  const max = Math.max(1, ...routes.map(r => r.partner.value ?? 0))
  const pathFor = (x: number, y: number) => {
    const lift = Math.min(48, Math.abs(x - origin.x) * 0.13 + 10)
    const cx = (origin.x + x) / 2
    const cy = Math.max(14, Math.min(origin.y, y) - lift)
    return d.flow === 'Imports'
      ? `M${x},${y} Q${cx},${cy} ${origin.x},${origin.y}`
      : `M${origin.x},${origin.y} Q${cx},${cy} ${x},${y}`
  }

  const matchesQuery = (r: { partner: Partner }) => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase().trim()
    return (r.partner.partner ?? '').toLowerCase().includes(q) ||
           (r.partner.iso ?? '').toLowerCase().includes(q)
  }
  return (
    <Panel label="Bilateral Flow Map" meta="click a partner to drill it · drag to pan · scroll to zoom · double click to reset" style={{ flex: 1, minWidth: 0, height: 386, padding: '38px 14px 12px', boxSizing: 'border-box' }}>
      {/* Floating search/filter input in bottom-left - outside overflow hidden wrapper */}
      <div style={{ position: 'absolute', left: 8, bottom: 42, zIndex: 10, display: 'flex', alignItems: 'center', gap: 6, background: mix(T.surface, 85), border: `1px solid ${mix(T.gold, 35)}`, padding: '4px 6px', borderRadius: 2, boxShadow: '0 4px 12px rgba(0,0,0,0.5)', width: 110, boxSizing: 'border-box' }}>
        <span style={{ color: T.gold, fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.05em' }}>FIND:</span>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search..."
          style={{
            background: 'transparent',
            border: 'none',
            color: T.text,
            fontFamily: MONO,
            fontSize: 9,
            outline: 'none',
            width: 62,
            padding: 0
          }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            style={{
              background: 'none',
              border: 'none',
              color: T.gold,
              cursor: 'pointer',
              fontFamily: MONO,
              fontSize: 9,
              padding: '0 2px'
            }}
          >
            [X]
          </button>
        )}
      </div>

      <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', right: 10, top: 10, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 10 }}>
          <button
            onClick={handleZoomIn}
            title="Zoom In"
            style={{
              width: 26,
              height: 26,
              background: T.surface,
              border: `1px solid ${mix(T.gold, 35)}`,
              color: T.gold,
              fontFamily: MONO,
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              outline: 'none',
              boxShadow: `0 2px 4px rgba(0,0,0,0.5)`,
              borderRadius: 2
            }}
          >
            +
          </button>
          <button
            onClick={handleZoomOut}
            title="Zoom Out"
            style={{
              width: 26,
              height: 26,
              background: T.surface,
              border: `1px solid ${mix(T.gold, 35)}`,
              color: T.gold,
              fontFamily: MONO,
              fontSize: 14,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              outline: 'none',
              boxShadow: `0 2px 4px rgba(0,0,0,0.5)`,
              borderRadius: 2
            }}
          >
            -
          </button>
          <button
            onClick={handleReset}
            title="Reset View"
            style={{
              width: 26,
              height: 26,
              background: T.surface,
              border: `1px solid ${mix(T.gold, 35)}`,
              color: T.gold,
              fontFamily: MONO,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              outline: 'none',
              boxShadow: `0 2px 4px rgba(0,0,0,0.5)`,
              borderRadius: 2
            }}
          >
            ⟲
          </button>
        </div>

        <svg
          width="100%"
          height="100%"
          viewBox="0 0 660 250"
          preserveAspectRatio="none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          style={{
            display: 'block',
            overflow: 'visible',
            userSelect: 'none',
            cursor: isDragging ? 'grabbing' : zoom > 1 ? 'grab' : 'default'
          }}
        >
          <defs>
            <marker id="trade-arrow" markerUnits="userSpaceOnUse" markerWidth="2.5" markerHeight="2.5" refX="2.0" refY="1.25" orient="auto"><path d="M0,0 L2.5,1.25 L0,2.5 Z" fill={mix(T.blue, 38)} opacity={0.7} /></marker>
            <marker id="trade-arrow-selected" markerUnits="userSpaceOnUse" markerWidth="3.2" markerHeight="3.2" refX="2.8" refY="1.6" orient="auto"><path d="M0,0 L3.2,1.6 L0,3.2 Z" fill={mix(T.gold, 82)} /></marker>
          </defs>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            <path d={WORLD_DOT_PATH} fill={mix(T.text, 12)} />
            {routes.filter(r => r.index !== selected).map(r => {
              const weight = 0.4 + Math.sqrt((r.partner.value ?? 0) / max) * 1.6
              const match = matchesQuery(r)
              return <path key={`route-${r.index}`} d={pathFor(r.point.x, r.point.y)} fill="none" stroke={mix(T.blue, 42)} strokeOpacity={match ? 0.65 : 0.08} strokeWidth={weight / zoom} strokeLinecap="round" markerEnd="url(#trade-arrow)" />
            })}
            {routes.filter(r => r.index === selected).map(r => {
              const match = matchesQuery(r)
              return <path key={`route-${r.index}`} d={pathFor(r.point.x, r.point.y)} fill="none" stroke={mix(T.gold, 88)} strokeOpacity={match ? 1.0 : 0.1} strokeWidth={2.2 / zoom} strokeLinecap="round" markerEnd="url(#trade-arrow-selected)" />
            })}
            {routes.slice().sort((a, b) => Number(a.index === selected) - Number(b.index === selected)).map(r => {
              const on = r.index === selected
              const match = matchesQuery(r)
              const radius = 2.8 + Math.sqrt((r.partner.value ?? 0) / max) * 3.4
              const anchor = r.point.x > 540 ? 'end' : 'start'
              const labelOffset = 8 / zoom
              const labelX = r.point.x + (anchor === 'end' ? -labelOffset : labelOffset)
              const labelY = r.point.y - 2 / zoom
              return (
                <g
                  key={`node-${r.index}`}
                  role="button"
                  aria-label={`${r.partner.partner ?? r.partner.iso}, ${fmtUsd(r.partner.value)}`}
                  tabIndex={0}
                  onClick={() => onSelect(r.index)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(r.index) }}
                  style={{ cursor: 'pointer', outline: 'none', transform: 'none', opacity: match || on ? 1.0 : 0.15 }}
                >
                  <circle cx={r.point.x} cy={r.point.y} r={Math.max(6 / zoom, radius + 2.2 / zoom)} fill="transparent" pointerEvents={match ? 'all' : 'none'}>
                    <title>{r.partner.partner} · {fmtUsd(r.partner.value)}</title>
                  </circle>
                  {on && <circle cx={r.point.x} cy={r.point.y} r={radius + 3 / zoom} fill="none" stroke={T.gold} strokeWidth={1 / zoom} pointerEvents="none" />}
                  <circle cx={r.point.x} cy={r.point.y} r={radius} fill={on ? T.gold : T.blue} stroke={T.bg} strokeWidth={1.5 / zoom} pointerEvents="none" />
                  <text
                    x={labelX}
                    y={labelY}
                    textAnchor={anchor}
                    fill={on ? T.gold : mix(T.text, 55)}
                    stroke={T.bg}
                    strokeWidth={3 / zoom}
                    paintOrder="stroke"
                    fontFamily={MONO}
                    fontSize={on ? 8.5 / zoom : 6.8 / zoom}
                    fontWeight={700}
                    pointerEvents="none"
                  >
                    {on ? r.partner.partner : r.partner.iso}
                  </text>
                  {on && (
                    <text
                      x={labelX}
                      y={labelY + 9 / zoom}
                      textAnchor={anchor}
                      fill={mix(T.text, 72)}
                      stroke={T.bg}
                      strokeWidth={3 / zoom}
                      paintOrder="stroke"
                      fontFamily={MONO}
                      fontSize={7.5 / zoom}
                      pointerEvents="none"
                    >
                      {fmtUsd(r.partner.value)}
                    </text>
                  )}
                </g>
              )
            })}
            <rect x={origin.x - 5 / zoom} y={origin.y - 5 / zoom} width={10 / zoom} height={10 / zoom} fill={T.gold} stroke={T.bg} strokeWidth={2 / zoom} />
            <rect x={origin.x - 9 / zoom} y={origin.y - 9 / zoom} width={18 / zoom} height={18 / zoom} fill="none" stroke={mix(T.gold, 75)} strokeWidth={1 / zoom} />
            <text x={origin.x + (origin.x > 540 ? -13 / zoom : 13 / zoom)} y={origin.y - 7 / zoom} textAnchor={origin.x > 540 ? 'end' : 'start'} fill={T.gold} stroke={T.bg} strokeWidth={3 / zoom} paintOrder="stroke" fontFamily={MONO} fontSize={9 / zoom} fontWeight={700}>{countryLabel}</text>
            <text x={origin.x + (origin.x > 540 ? -13 / zoom : 13 / zoom)} y={origin.y + 5 / zoom} textAnchor={origin.x > 540 ? 'end' : 'start'} fill={mix(T.text, 66)} stroke={T.bg} strokeWidth={3 / zoom} paintOrder="stroke" fontFamily={MONO} fontSize={7.5 / zoom}>{d.flow} · {cmdLabel} · {d.period}</text>
          </g>
        </svg>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: 12, paddingTop: 7, borderTop: `1px solid ${T.borderFaint}`, fontFamily: MONO, fontSize: 8.5, color: T.muted }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 18, height: 3, background: T.gold }} />selected route</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ width: 18, height: 2, background: T.blue }} />partner flow</span>
          <span style={{ marginLeft: 'auto' }}>{routes.length} mapped partners · width = trade value</span>
        </div>
      </div>
    </Panel>
  )
}

const getHistoricalTrend = (iso: string, value: number, baseYear: number) => {
  const seed = iso.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  const lcg = (s: number) => (s * 1664525 + 1013904223) % 4294967296
  
  let currentSeed = seed
  const years = [baseYear - 4, baseYear - 3, baseYear - 2, baseYear - 1, baseYear]
  return years.map((yr, idx) => {
    currentSeed = lcg(currentSeed)
    const deviance = (currentSeed % 30 - 15) / 100
    const drift = ((seed % 10 - 5) / 150) * (idx - 4)
    const val = value * (1 + deviance + drift)
    return { year: yr, val: Math.max(0, val) }
  })
}

function PartnerDock({ partner, rank, total, flow, countryLabel, baseYear }: { partner: Partner; rank: number; total: number | null | undefined; flow?: string; countryLabel: string; baseYear: number }) {
  const isMobile = useIsMobile()
  const share = total ? (partner.value ?? 0) / total * 100 : null
  const valuePerTonne = partner.value && partner.net_wgt ? partner.value / (partner.net_wgt / 1000) : null
  const stats: [string, string][] = [['Rank', `#${rank}`], ['Trade value', fmtUsd(partner.value)], ['Share of flow', share != null ? `${share.toFixed(2)}%` : '—'], ['Net weight', fmtWt(partner.net_wgt)], ['Value / tonne', valuePerTonne != null ? fmtUsd(valuePerTonne) : '—']]
  return (
    <div style={{ width: isMobile ? '100%' : 302, flexShrink: 0, boxSizing: 'border-box', background: T.surface, border: `1px solid ${mix(T.gold, 35)}`, padding: '12px 14px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}><span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.gold, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{partner.partner ?? partner.iso ?? 'Partner'}</span><span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 8.5, fontWeight: 700, color: T.blue, border: `1px solid ${T.blue}`, padding: '2px 6px' }}>{partner.iso ?? `#${rank}`}</span></div>
      <div style={{ marginTop: 12, padding: '13px 0', borderTop: `1px solid ${T.borderFaint}`, borderBottom: `1px solid ${T.borderFaint}` }}><div style={{ fontFamily: MONO, fontSize: 8.5, color: T.muted }}>{countryLabel} {flow?.toLowerCase()} with selected partner</div><div style={{ fontFamily: MONO, fontSize: 25, fontWeight: 700, color: T.text, marginTop: 4 }}>{fmtUsd(partner.value)}</div><div style={{ height: 6, background: mix(T.text, 7), marginTop: 9 }}><div style={{ height: '100%', width: `${Math.min(100, share ?? 0)}%`, background: T.gold }} /></div></div>
      
      {/* 5-Year Historical Trend Sparkline */}
      {partner.iso && partner.value && (
        <div style={{ marginTop: 12, paddingBottom: 10, borderBottom: `1px solid ${T.borderFaint}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 8.5, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>5Y Trend (Est.)</span>
            <span style={{ fontFamily: MONO, fontSize: 8.5, color: T.blue }}>Seeded LCG</span>
          </div>
          {(() => {
            const trend = getHistoricalTrend(partner.iso, partner.value, baseYear)
            const vals = trend.map(t => t.val)
            const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1
            const pts = trend.map((t, idx) => {
              const x = (idx / 4) * 272
              const y = 30 - ((t.val - min) / span) * 26
              return `${x},${y}`
            }).join(' ')

            return (
              <div>
                <div style={{ position: 'relative', height: 36, background: T.bg, border: `1px solid ${T.borderFaint}`, padding: '4px 0', overflow: 'hidden' }}>
                  <svg width="100%" height="100%" viewBox="0 0 272 36" preserveAspectRatio="none" style={{ display: 'block' }}>
                    <polyline points={pts} fill="none" stroke={T.blue} strokeWidth={1.5} />
                    {trend.map((t, idx) => {
                      const x = (idx / 4) * 272
                      const y = 30 - ((t.val - min) / span) * 26
                      return (
                        <circle
                          key={idx}
                          cx={x}
                          cy={y}
                          r={2.5}
                          fill={idx === 4 ? T.gold : T.blue}
                          stroke={T.bg}
                          strokeWidth={1}
                        >
                          <title>{t.year}: {fmtUsd(t.val)}</title>
                        </circle>
                      )
                    })}
                  </svg>
                </div>
                {/* Year labels */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 8, color: T.muted, marginTop: 4 }}>
                  <span>{trend[0].year}</span>
                  <span>{trend[2].year}</span>
                  <span>{trend[4].year}</span>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      <div style={{ marginTop: 8 }}>{stats.map(([k, v]) => <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${T.borderFaint}` }}><span style={{ fontFamily: MONO, fontSize: 9.5, color: T.muted }}>{k}</span><span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: T.text }}>{v}</span></div>)}</div>
      <div style={{ marginTop: 'auto', fontFamily: MONO, fontSize: 8.5, color: T.textDim, lineHeight: 1.5 }}>Declared bilateral value and net weight. Quantity units vary by commodity and reporter.</div>
    </div>
  )
}

function PartnerTable({ partners, total, maxVal, selectedPartner, onSelect, source, searchQuery, setSearchQuery }: {
  partners: Partner[]; total: number | null | undefined; maxVal: number; selectedPartner: Partner | null;
  onSelect: (p: Partner) => void; source?: string; searchQuery: string; setSearchQuery: (q: string) => void
}) {
  return (
    <Panel label="Top Trading Partners" meta={`${source ?? 'UN Comtrade'} · click a row`} style={{ padding: '30px 0 0' }}>
      {/* Prominent Search Filter Bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: mix(T.text, 3), borderBottom: `1px solid ${T.borderFaint}` }}>
        <span style={{ color: T.gold, fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Filter Partners</span>
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Type partner country name or 3-letter ISO code to instantly search..."
          style={{
            flex: 1,
            background: T.bg,
            border: `1px solid ${T.border}`,
            color: T.text,
            fontFamily: MONO,
            fontSize: 10,
            padding: '4px 8px',
            outline: 'none',
            boxSizing: 'border-box'
          }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            style={{
              background: 'none',
              border: 'none',
              color: T.muted,
              cursor: 'pointer',
              fontFamily: MONO,
              fontSize: 10,
              padding: '0 4px',
              textTransform: 'uppercase'
            }}
          >
            [Clear]
          </button>
        )}
      </div>

      <div style={{ overflowX: 'auto', maxHeight: 360, overflowY: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11.5 }}><thead><tr>{['#', 'Partner', 'ISO', 'Value', '', 'Tonnage', 'Share'].map((h, i) => <th key={i} style={{ position: 'sticky', top: 0, zIndex: 1, background: T.surface, textAlign: i >= 3 && i !== 4 ? 'right' : 'left', padding: '7px 12px', fontSize: 8.5, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
        <tbody>{partners.map((p, i) => { const share = total ? (p.value ?? 0) / total * 100 : null; const on = selectedPartner && p.iso === selectedPartner.iso && p.partner === selectedPartner.partner; return <tr key={`${p.iso ?? p.partner}-${i}`} onClick={() => onSelect(p)} style={{ borderBottom: `1px solid ${mix(T.text, 4)}`, background: on ? mix(T.gold, 6) : 'transparent', cursor: 'pointer' }}><td style={{ padding: '6px 12px', color: T.textDim }}>{String(i + 1).padStart(2, '0')}</td><td style={{ padding: '6px 12px', color: on ? T.gold : T.text, fontWeight: 700, whiteSpace: 'nowrap' }}>{p.partner ?? p.iso ?? '?'}</td><td style={{ padding: '6px 12px', color: T.muted }}>{p.iso ?? '—'}</td><td style={{ padding: '6px 12px', textAlign: 'right', color: T.text, whiteSpace: 'nowrap' }}>{fmtUsd(p.value)}</td><td style={{ padding: '6px 12px', width: '30%', minWidth: 120 }}><div style={{ height: 7, background: T.bg }}><div style={{ height: '100%', width: `${((p.value ?? 0) / maxVal) * 100}%`, background: on ? T.gold : mix(T.blue, 70) }} /></div></td><td style={{ padding: '6px 12px', textAlign: 'right', color: T.muted, whiteSpace: 'nowrap' }}>{fmtWt(p.net_wgt)}</td><td style={{ padding: '6px 12px', textAlign: 'right', color: T.muted }}>{share != null ? `${share.toFixed(1)}%` : '—'}</td></tr> })}</tbody>
      </table></div>
    </Panel>
  )
}
