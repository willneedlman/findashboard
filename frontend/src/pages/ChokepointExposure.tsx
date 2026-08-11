import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import PageWrapper from '../components/PageWrapper'
import LoadingState from '../components/LoadingState'
import ErrorState from '../components/ErrorState'
import TickerLink from '../components/TickerLink'
import StationBoardPanel from '../components/StationBoardPanel'
import { fetchChokepointExposure } from '../hooks/useApi'
import { T } from '../lib/theme'
import { WORLD_DOT_PATH } from '../lib/worldDotMap'
import { MONO, SANS, mix, chg, signed, Panel, KpiStrip } from './cockpitKit'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip } from '../lib/reportCaptureRegistry'

interface Driver { strait: string; status: string; direction: number; contribution: number }
interface Quote { price: number | null; change_pct: number | null; spark: number[] }
interface Exposure extends Quote { ticker: string; group: string; group_key: string; direction: number; note: string }
interface ChokeCard { id: string; name: string; oil_mbd: number; status: string | null; delta_pct: number | null; share_pct: number | null; disruption: number; series30: number[]; series30_live_from: number | null; baseline_as_of: string | null; baseline_age_days: number | null; baseline_outdated: boolean; live_as_of: string | null; live_confidence: string; live_reliable: boolean; exposures: Exposure[] }
interface Leader extends Quote { ticker: string; group: string; group_key: string; direction: number; score: number; chokepoints: string[]; links: number; drivers: Driver[] }
interface Resp { chokepoints: ChokeCard[]; leaders: Leader[]; any_stress: boolean; priced: number; outdated_count: number; freshness_threshold_days: number; source: string }

const STRAIT_POS: Record<string, { x: number; y: number; labelX: number; labelY: number; lab: 'l' | 'r' }> = {
  // Markers sit on their geographic position; labels fan into distinct lanes so
  // the crowded Mediterranean / Middle-East cluster does not overlap.
  taiwan: { x: 555, y: 103, labelX: 570, labelY: 104, lab: 'r' },
  malacca: { x: 519, y: 144, labelX: 534, labelY: 152, lab: 'r' },
  hormuz: { x: 439, y: 98, labelX: 462, labelY: 92, lab: 'r' },
  bab: { x: 415, y: 125, labelX: 400, labelY: 152, lab: 'l' },
  suez: { x: 395, y: 92, labelX: 372, labelY: 120, lab: 'l' },
  bosphorus: { x: 388, y: 70, labelX: 412, labelY: 46, lab: 'r' },
  gibraltar: { x: 325, y: 80, labelX: 296, labelY: 84, lab: 'l' },
  danish: { x: 355, y: 41, labelX: 350, labelY: 22, lab: 'l' },
  panama: { x: 189, y: 132, labelX: 176, labelY: 128, lab: 'l' },
  goodhope: { x: 369, y: 215, labelX: 382, labelY: 214, lab: 'r' },
}
const statusColor = (s: string | null) => (s === 'congested' ? T.neg : s === 'watch' ? T.gold : T.muted)

// Name-specific exposure briefing copy, keyed by basket (from the handoff).
const BRIEF: Record<string, (t: string) => string> = {
  'Container liners': t => `${t} prices disruption as scarcity. When strait transits fall, Asia loops reroute or slow, effective capacity tightens, and spot container rates gap higher. A spot-weighted fleet turns day-rate moves into revenue within weeks.`,
  'Defense': t => `${t} carries a conflict-risk premium. Sustained congestion at a strait reprices regional escalation odds, and with them multi-year procurement expectations. The move is expectations-led, so the signal can persist while the tape drifts.`,
  'Semiconductors': t => t === 'TSM'
    ? `TSM's fabs sit on the strait itself. Congestion prices blockade risk directly: wafer exports, tool imports and the Asia trade lanes that carry them are gated by the same water. That is why the basket reads headwind even on green days.`
    : `${t} is fabless: nearly all leading-edge output crosses the Taiwan Strait twice, as wafers into packaging then finished parts into the channel. Strait stress is supply risk, not demand news, so it reads headwind regardless of the day's tape.`,
  'Tankers': t => `${t} earns tonne-miles. Reroutes around a stressed strait send crude the long way via the Cape, absorbing fleet supply and lifting day-rates while the disruption lasts. Most straits feed this basket, so the score is broad but shallow.`,
  'Refiners': t => `${t} is squeezed from the input side: strait stress bids up crude feedstock while product prices lag, compressing crack spreads. The Gulf chokepoints dominate the driver mix.`,
  'Oil majors & E&P': t => `${t} is levered to the crude price that strait stress supports. Supply-at-risk through the Gulf and Red Sea firms the barrel, and the majors' cash flows move with it, though the equity reaction is slower than the tape.`,
  'LNG': t => `${t} gains when cargoes reroute and gas tightens. Congestion lengthens voyages and strands supply behind the strait, widening regional price gaps that flow into terminal economics.`,
}
const BASKETS = ['All', 'Tankers', 'Container liners', 'Semiconductors', 'Defense', 'Refiners', 'LNG', 'Oil majors & E&P']

const pct = (v: number | null) => (v == null ? '—' : `${signed(v, 2)}%`)
function Spark({ data, color, w = 60, h = 16, liveFrom }: { data: number[]; color: string; w?: number; h?: number; liveFrom?: number | null }) {
  const pts = (data || []).filter(v => v != null)
  if (pts.length < 2) return null
  const mn = Math.min(...pts), mx = Math.max(...pts), rng = mx - mn || 1
  const xy = (v: number, i: number) => `${(i / (pts.length - 1) * w).toFixed(1)},${(h - (v - mn) / rng * h).toFixed(1)}`
  // The AIS-supplemented tail (live_from onward) draws as a gold dashed segment,
  // joined to the last PortWatch point, so the live estimate reads distinctly.
  const lf = liveFrom != null && liveFrom > 0 && liveFrom < pts.length ? liveFrom : null
  const base = pts.slice(0, lf ?? pts.length).map((v, i) => xy(v, i)).join(' ')
  const live = lf != null ? pts.slice(lf - 1).map((v, i) => xy(v, lf - 1 + i)).join(' ') : ''
  return <svg width={w} height={h} style={{ display: 'block' }}>
    <polyline points={base} fill="none" stroke={color} strokeWidth={1.2} />
    {live && <polyline points={live} fill="none" stroke={T.gold} strokeWidth={1.2} strokeDasharray="2.5 2" />}
  </svg>
}

export default function ChokepointExposure() {
  // Backend caches the PortWatch baseline 1h; poll hourly so a newly-published
  // day (and the live nowcast layer) surface promptly, consistent with the map.
  const HOUR_MS = 3_600_000
  const { data, isLoading, error, refetch } = useQuery<Resp>({ queryKey: ['chokepoint-exposure'], queryFn: fetchChokepointExposure, staleTime: HOUR_MS, refetchInterval: HOUR_MS, refetchOnWindowFocus: false })
  return (
    <PageWrapper title="Chokepoint Exposure">
      {isLoading ? <LoadingState label="Mapping chokepoint stress to exposed names" />
        : error || !data ? <ErrorState title="Exposure feed unavailable" message="Chokepoint exposure did not load. Retry in a moment." onRetry={() => refetch()} />
        : <Board data={data} />}
    </PageWrapper>
  )
}

function Board({ data }: { data: Resp }) {
  const straits = data.chokepoints
  const stressed = straits.filter(c => c.disruption > 0)
  const benefit = data.leaders.filter(l => l.score > 0)
  const pressured = data.leaders.filter(l => l.score < 0)
  const [strait, setStrait] = useState(straits.slice().sort((a, b) => b.disruption - a.disruption)[0]?.id ?? '')
  const [basket, setBasket] = useState('All')
  const [dir, setDir] = useState<'all' | 'tailwind' | 'headwind'>('all')
  const [open, setOpen] = useState<string | null>(pressured[0]?.ticker ?? data.leaders[0]?.ticker ?? null)
  const navigate = useNavigate()

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

  const sel = straits.find(c => c.id === strait)
  const kpis = [
    { label: 'Chokepoints', value: String(straits.length), tip: { title: 'Chokepoints tracked', body: `The ${straits.length} maritime straits and canals the tool watches. Each is scored for transit stress from IMF PortWatch and the live AIS nowcast.`, source: 'IMF PortWatch + AIS' } },
    { label: 'Under stress', value: String(stressed.length), vc: stressed.length ? T.gold : T.muted, sub: `${straits.filter(c => c.status === 'congested').length} congested · ${straits.filter(c => c.status === 'watch').length} watch`, tip: { title: 'Under stress', body: `Straits whose transits are dropping versus the prior week. ${stressed.length} of ${straits.length} right now — congestion is the disruptive signal that drives the exposure scores.`, source: 'Δ vs prior-week transits' } },
    { label: 'Top beneficiary', value: benefit[0]?.ticker ?? '—', vc: T.pos, sub: benefit[0] ? `score ${signed(benefit[0].score, 1)}` : undefined, tip: { title: 'Top beneficiary', body: `The name most helped by today's chokepoint stress. ${benefit[0]?.ticker ?? '—'} scores highest because disruption is a tailwind for its basket across the stressed straits.`, source: 'Highest positive score' } },
    { label: 'Most pressured', value: pressured[0]?.ticker ?? '—', vc: T.neg, sub: pressured[0] ? `score ${signed(pressured[0].score, 1)}` : undefined, tip: { title: 'Most pressured', body: `The name most hurt by today's stress. ${pressured[0]?.ticker ?? '—'} sits behind a stressed strait where disruption is a headwind for its basket.`, source: 'Lowest negative score' } },
    { label: 'Names priced', value: String(data.priced), tip: { title: 'Names priced', body: `${data.priced} exposed equities with a live quote attached. Prices are daily closes from yfinance, mapped to straits through the curated exposure map.`, source: 'yfinance closes' } },
  ]

  useReportCapture(() => {
    if (!straits.length) return null
    const pieces: ClipDraft[] = [
      kpiClip('Chokepoint Exposure', 'Chokepoint Stress Snapshot', [
        { label: 'Chokepoints', value: String(straits.length) },
        { label: 'Under stress', value: String(stressed.length) },
        { label: 'Top beneficiary', value: benefit[0]?.ticker ?? '—', sub: benefit[0] ? `score ${signed(benefit[0].score, 1)}` : undefined },
        { label: 'Most pressured', value: pressured[0]?.ticker ?? '—', sub: pressured[0] ? `score ${signed(pressured[0].score, 1)}` : undefined },
        { label: 'Names priced', value: String(data.priced) },
      ]),
      tableClip(
        'Chokepoint Exposure',
        'Chokepoint Status',
        ['Strait', 'Status', 'Oil mbd', 'Δ %', 'Disruption'],
        straits.slice(0, 20).map(c => [
          c.name,
          c.status ?? '—',
          c.oil_mbd,
          c.delta_pct != null ? `${signed(c.delta_pct, 1)}%` : '—',
          +c.disruption.toFixed(2),
        ]),
      ),
    ]
    if (data.leaders.length) {
      pieces.push(tableClip(
        'Chokepoint Exposure',
        'Exposed Names',
        ['Ticker', 'Group', 'Score', 'Price', 'Chg %', 'Chokepoints'],
        data.leaders.slice(0, 20).map(l => [
          l.ticker,
          l.group,
          +l.score.toFixed(1),
          l.price != null ? `$${l.price.toFixed(2)}` : '—',
          l.change_pct != null ? `${signed(l.change_pct, 2)}%` : '—',
          l.chokepoints.slice(0, 3).join(', '),
        ]),
      ))
    }
    return pieces
  }, { disabled: !straits.length, sourceTab: 'Chokepoint Exposure' })

  const rows = data.leaders.filter(l => (basket === 'All' || l.group === basket) && (dir === 'all' || (dir === 'tailwind' ? l.score > 0 : l.score < 0)))
  const maxScore = Math.max(1, ...data.leaders.map(l => Math.abs(l.score)))
  // Only warn where a stale PortWatch baseline has no reliable live AIS to fill it.
  // A stale baseline that live AIS is supplementing is not a data gap.
  const outdated = straits.filter(c => c.baseline_outdated && !c.live_reliable)
  const oldestConfirmed = outdated
    .filter(c => c.baseline_as_of)
    .sort((a, b) => (a.baseline_as_of ?? '').localeCompare(b.baseline_as_of ?? ''))[0]?.baseline_as_of

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <KpiStrip cells={kpis} />

      {outdated.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${mix(T.gold, 55)}`, background: mix(T.gold, 8), padding: '8px 11px' }}>
          <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', color: T.gold, whiteSpace: 'nowrap' }}>DATA FRESHNESS WARNING</span>
          <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted, lineHeight: 1.45 }}>
            {outdated.length} of {straits.length} straits have a PortWatch baseline more than {data.freshness_threshold_days} days old with no reliable live AIS to fill the gap{oldestConfirmed ? `. The oldest is confirmed only through ${oldestConfirmed}` : ''}. Elsewhere, live AIS supplements the disruption score.
          </span>
        </div>
      )}

      {/* Map + drill dock */}
      <div style={{ display: 'flex', gap: 10 }}>
        <Panel label="Transit Stress Map" meta="click a strait to drill it · drag to pan · scroll to zoom · double click to reset" style={{ flex: 1, minWidth: 0, padding: '32px 10px 8px' }}>
          <div style={{ position: 'relative', overflow: 'hidden' }}>
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
            width: '100%',
            height: 'auto',
            aspectRatio: '660 / 250',
            userSelect: 'none',
            cursor: isDragging ? 'grabbing' : zoom > 1 ? 'grab' : 'default'
          }}
        >
              <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                <path d={WORLD_DOT_PATH} fill={mix(T.text, 14)} />
                {straits.slice().sort((a, b) => Number(a.id === strait) - Number(b.id === strait)).map(c => {
                  const pos = STRAIT_POS[c.id]; if (!pos) return null
                  const color = statusColor(c.status)
                  const on = c.id === strait
                  return (
                    <g
                      key={c.id}
                      onClick={() => setStrait(c.id)}
                      style={{ cursor: 'pointer', outline: 'none', transform: 'none' }}
                    >
                      <line x1={pos.x} y1={pos.y} x2={pos.labelX} y2={pos.labelY} stroke={on ? mix(T.gold, 65) : mix(T.text, 28)} strokeWidth={0.65 / zoom} pointerEvents="none" />
                      {on && <rect x={pos.x - 8 / zoom} y={pos.y - 8 / zoom} width={16 / zoom} height={16 / zoom} fill="none" stroke={T.gold} strokeWidth={1 / zoom} pointerEvents="none" />}
                      {c.status === 'congested' && (
                        <rect
                          x={pos.x - 9 / zoom}
                          y={pos.y - 9 / zoom}
                          width={18 / zoom}
                          height={18 / zoom}
                          fill="none"
                          stroke={T.neg}
                          strokeWidth={1 / zoom}
                          pointerEvents="none"
                          style={{ transformOrigin: `${pos.x}px ${pos.y}px`, animation: 'at-choke-pulse 1.8s ease-out infinite' }}
                        />
                      )}
                      <rect x={pos.x - 4.5 / zoom} y={pos.y - 4.5 / zoom} width={9 / zoom} height={9 / zoom} fill={color} stroke={T.bg} strokeWidth={2 / zoom} pointerEvents="none" />
                      <rect x={pos.x - 12 / zoom} y={pos.y - 12 / zoom} width={24 / zoom} height={24 / zoom} fill="transparent" pointerEvents="all">
                        <title>{`${c.name} · PortWatch confirmed through ${c.baseline_as_of ?? 'unknown'}${c.baseline_outdated ? ' · OUTDATED' : ''}`}</title>
                      </rect>
                      {c.baseline_outdated && (
                        <g pointerEvents="none">
                          <circle cx={pos.x + 6 / zoom} cy={pos.y - 6 / zoom} r={4.2 / zoom} fill={T.gold} stroke={T.bg} strokeWidth={1.2 / zoom} />
                          <text x={pos.x + 6 / zoom} y={pos.y - 4.2 / zoom} textAnchor="middle" fill={T.bg} fontFamily={MONO} fontSize={5.5 / zoom} fontWeight={900}>!</text>
                        </g>
                      )}
                      <text
                        x={pos.labelX}
                        y={pos.labelY - 3 / zoom}
                        textAnchor={pos.lab === 'r' ? 'start' : 'end'}
                        fill={mix(T.text, 85)}
                        stroke={T.bg}
                        strokeWidth={3 / zoom}
                        paintOrder="stroke"
                        fontFamily={MONO}
                        fontSize={9.5 / zoom}
                        fontWeight={700}
                        pointerEvents="none"
                      >
                        {c.name.replace('Strait of ', '').replace(' + SUMED', '')}
                      </text>
                      <text
                        x={pos.labelX}
                        y={pos.labelY + 7 / zoom}
                        textAnchor={pos.lab === 'r' ? 'start' : 'end'}
                        fill={color}
                        stroke={T.bg}
                        strokeWidth={3 / zoom}
                        paintOrder="stroke"
                        fontFamily={MONO}
                        fontSize={8.5 / zoom}
                        pointerEvents="none"
                      >
                        {`${c.oil_mbd} Mb/d · ${c.delta_pct != null ? signed(c.delta_pct, 1) + '%' : '—'}${c.baseline_outdated ? ` · ${c.baseline_age_days ?? '?'}D OLD` : ''}`}
                      </text>
                    </g>
                  )
                })}
              </g>
            </svg>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 6, paddingTop: 7, borderTop: `1px solid ${T.borderFaint}` }}>
            {([['congested', T.neg], ['watch', T.gold], ['normal', T.muted]] as [string, string][]).map(([l, c]) => (
              <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 9, color: T.muted }}><span style={{ width: 9, height: 9, background: c }} />{l}</span>
            ))}
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 9, color: T.gold }}><span style={{ width: 11, height: 11, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: T.gold, color: T.bg, fontSize: 8, fontWeight: 900 }}>!</span>outdated baseline</span>
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, color: T.textDim }}>Mb/d = seaborne oil transit · deltas vs prior week</span>
          </div>
        </Panel>

        {sel && <DrillDock c={sel} navigate={navigate} />}
      </div>

      {sel && (
        <Panel
          label="Station Board"
          meta="each transit measure read on its own · descriptive, not a forecast"
          style={{ padding: '30px 12px 14px' }}
        >
          <StationBoardPanel chokepointId={sel.id} />
        </Panel>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {BASKETS.filter(bk => bk === 'All' || data.leaders.some(l => l.group === bk)).map(bk => {
          const on = basket === bk
          return <button key={bk} onClick={() => setBasket(bk)} style={{ fontFamily: MONO, fontSize: 10, padding: '4px 8px', cursor: 'pointer', background: on ? mix(T.gold, 14) : 'transparent', color: on ? T.gold : T.muted, border: `1px solid ${on ? T.gold : T.border}` }}>{bk}</button>
        })}
        <div style={{ width: 1, alignSelf: 'stretch', background: T.border, margin: '0 6px' }} />
        {(['all', 'tailwind', 'headwind'] as const).map(dv => {
          const on = dir === dv
          return <button key={dv} onClick={() => setDir(dv)} style={{ fontFamily: MONO, fontSize: 10, padding: '4px 8px', textTransform: 'capitalize', cursor: 'pointer', background: on ? mix(T.gold, 14) : 'transparent', color: on ? T.gold : T.muted, border: `1px solid ${on ? T.gold : T.border}` }}>{dv}</button>
        })}
        <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, color: T.textDim }}>click a row for its exposure briefing</span>
      </div>

      {/* Leaders table */}
      <Panel label="Most-Exposed Names" meta="score = Σ direction × strait disruption · click a row for the briefing" style={{ padding: '30px 0 0' }}>
        <div style={{ display: 'grid', gridTemplateColumns: LEADER_COLS, padding: '0 12px' }}>
          {[['#', 'l'], ['TICKER', 'l'], ['BASKET', 'l'], ['SIGNAL', 'l'], ['SCORE', 'r'], ['', 'l'], ['DRIVEN BY', 'l'], ['CHG', 'r'], ['30D', 'r']].map(([h, ta], i) => (
            <div key={i} style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, padding: '6px 4px', textAlign: ta === 'r' ? 'right' : 'left', borderBottom: `1px solid ${T.border}` }}>{h}</div>
          ))}
        </div>
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {rows.map((l, i) => <LeaderRow key={l.ticker} l={l} rank={i + 1} maxScore={maxScore} open={open === l.ticker} onToggle={() => setOpen(o => o === l.ticker ? null : l.ticker)} navigate={navigate} />)}
          {rows.length === 0 && <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted, padding: 14 }}>No names match this filter.</div>}
        </div>
      </Panel>
    </div>
  )
}

function DrillDock({ c, navigate }: { c: ChokeCard; navigate: (p: string) => void }) {
  const color = statusColor(c.status)
  const falling = (c.delta_pct ?? 0) < 0
  const stats: [string, string, string][] = [
    ['Status', (c.status ?? 'normal').toUpperCase(), color],
    ['Oil transit', `${c.oil_mbd} Mb/d`, T.text],
    ['Seaborne oil share', c.share_pct != null ? `${c.share_pct}%` : '—', T.text],
    ['Disruption score', c.disruption.toFixed(1), c.disruption > 0 ? T.gold : T.muted],
    ['Names mapped', String(c.exposures.length), T.text],
  ]
  return (
    <div style={{ width: 302, flexShrink: 0, boxSizing: 'border-box', background: T.surface, border: `1px solid ${mix(T.gold, 35)}`, padding: '12px 14px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>{c.name}</span>
        <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', color, border: `1px solid ${color}`, padding: '2px 6px' }}>{(c.status ?? 'normal').toUpperCase()} {c.delta_pct != null ? signed(c.delta_pct, 1) + '%' : ''}</span>
      </div>
      <div style={{ marginTop: 9, border: `1px solid ${c.baseline_outdated ? mix(T.gold, 65) : T.border}`, background: c.baseline_outdated ? mix(T.gold, 9) : 'transparent', padding: '7px 8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: MONO, fontSize: 8.5, fontWeight: 800, letterSpacing: '0.08em', color: c.baseline_outdated ? T.gold : T.pos }}>
          <span>{c.baseline_outdated ? 'OUTDATED PORTWATCH BASELINE' : 'CURRENT PORTWATCH BASELINE'}</span>
          <span>{c.baseline_age_days == null ? 'AGE UNKNOWN' : `${c.baseline_age_days}D OLD`}</span>
        </div>
        <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 8.5, color: T.muted, lineHeight: 1.45 }}>
          Confirmed through {c.baseline_as_of ?? 'an unknown date'}. {c.live_reliable ? `Live AIS supplement: ${c.live_confidence}, as of ${c.live_as_of}.` : `No reliable live AIS replacement${c.live_confidence && c.live_confidence !== 'none' ? ` (${c.live_confidence} confidence)` : ''}.`}
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9, color: T.muted }}><span>30-day transits</span><span style={{ color: falling ? T.neg : T.pos }}>{falling ? 'falling' : 'steady'}</span></div>
        <div style={{ marginTop: 4 }}><Spark data={c.series30} color={falling ? T.neg : T.pos} w={272} h={44} liveFrom={c.series30_live_from} /></div>
        {c.series30_live_from != null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontFamily: MONO, fontSize: 8, color: T.gold }}>
            <span style={{ width: 12, height: 0, borderTop: `1.4px dashed ${T.gold}` }} />live AIS estimate{c.live_as_of ? ` · as of ${c.live_as_of.slice(0, 10)}` : ''}
          </div>
        )}
      </div>
      <div style={{ marginTop: 8 }}>
        {stats.map(([k, v, cc]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${T.borderFaint}` }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: T.muted }}>{k}</span>
            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: cc }}>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginTop: 9 }}>Names it moves</div>
      <div style={{ overflowY: 'auto' }}>
        {c.exposures.map(e => (
          <div key={e.ticker} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: `1px solid ${mix(T.text, 4)}` }}>
            <TickerLink ticker={e.ticker} style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: T.text, width: 42 }} />
            <span style={{ fontFamily: MONO, fontSize: 7.5, fontWeight: 700, letterSpacing: '0.1em', color: e.direction > 0 ? T.pos : T.neg, border: `1px solid ${e.direction > 0 ? T.pos : T.neg}`, padding: '1px 4px' }}>{e.direction > 0 ? 'BENEFITS' : 'PRESSURED'}</span>
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: chg(e.change_pct) }}>{pct(e.change_pct)}</span>
            <Spark data={e.spark} color={chg(e.change_pct)} />
          </div>
        ))}
      </div>
    </div>
  )
}

const LEADER_COLS = '34px 62px 1fr 88px 56px 0.9fr 150px 66px 72px'
function LeaderRow({ l, rank, maxScore, open, onToggle, navigate }: { l: Leader; rank: number; maxScore: number; open: boolean; onToggle: () => void; navigate: (p: string) => void }) {
  const tail = l.score > 0
  const sigC = tail ? T.pos : T.neg
  const w = Math.min(Math.abs(l.score) / maxScore * 46, 46)
  const d0 = l.drivers[0]
  const srcColor = statusColor(d0?.status ?? 'normal')
  const brief = (BRIEF[l.group] ?? ((t: string) => `${t} moves with chokepoint stress through its ${l.group.toLowerCase()} exposure.`))(l.ticker)
  return (
    <div>
      <div onClick={onToggle} style={{ display: 'grid', gridTemplateColumns: LEADER_COLS, padding: '0 12px', borderBottom: `1px solid ${mix(T.text, 4)}`, cursor: 'pointer', background: open ? mix(T.gold, 6) : 'transparent' }}>
        <div style={{ fontFamily: MONO, fontSize: 10, color: T.textDim, padding: '5px 4px' }}>{String(rank).padStart(2, '0')}</div>
        <div style={{ padding: '5px 4px' }} onClick={e => e.stopPropagation()}><TickerLink ticker={l.ticker} style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: T.text }} /></div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted, padding: '5px 4px' }}>{l.group}</div>
        <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: sigC, padding: '6px 4px' }}>{tail ? 'TAILWIND' : 'HEADWIND'}</div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: sigC, padding: '5px 4px', textAlign: 'right' }}>{signed(l.score, 1)}</div>
        <div style={{ padding: '5px 10px' }}>
          <div style={{ position: 'relative', height: 12, background: 'rgba(0,0,0,0.22)' }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1, background: mix(T.text, 16) }} />
            <div style={{ position: 'absolute', top: 4, bottom: 4, ...(tail ? { left: '50%' } : { right: '50%' }), width: `${w}%`, background: tail ? mix(T.pos, 60) : mix(T.neg, 60) }} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 4px', overflow: 'hidden' }}>
          {d0 && <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: srcColor, border: `1px solid ${srcColor}`, padding: '1px 5px', whiteSpace: 'nowrap' }}>{d0.strait.replace('Strait of ', '').replace(' + SUMED', '').slice(0, 10)}</span>}
          {l.links > 1 && <span style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, whiteSpace: 'nowrap' }}>+{l.links - 1}</span>}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: chg(l.change_pct), padding: '5px 4px', textAlign: 'right' }}>{pct(l.change_pct)}</div>
        <div style={{ padding: '4px 4px', display: 'flex', justifyContent: 'flex-end' }}><Spark data={l.spark} color={chg(l.change_pct)} /></div>
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 22, background: T.surface, borderBottom: `1px solid ${T.border}`, borderLeft: `2px solid ${T.gold}`, padding: '13px 18px' }}>
          <div style={{ flex: 1.35, minWidth: 0 }}>
            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.gold }}>Exposure briefing · {l.ticker}</div>
            <div style={{ fontFamily: SANS, fontSize: 11.5, color: T.muted, lineHeight: 1.65, marginTop: 7 }}>{brief}</div>
            <div onClick={() => navigate(`/company-profile?ticker=${l.ticker}`)} style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: T.gold, marginTop: 9, cursor: 'pointer' }}>OPEN {l.ticker} IN RESEARCH ↗</div>
          </div>
          <div style={{ width: 308, flexShrink: 0 }}>
            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.muted }}>Drivers · direction × disruption</div>
            <div style={{ marginTop: 6 }}>
              {l.drivers.filter(dr => dr.contribution !== 0).slice(0, 5).map(dr => (
                <div key={dr.strait} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: `1px solid ${mix(T.text, 4)}` }}>
                  <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: statusColor(dr.status), border: `1px solid ${statusColor(dr.status)}`, padding: '1px 5px', width: 88, textAlign: 'center', boxSizing: 'border-box' }}>{dr.strait.replace('Strait of ', '').replace(' + SUMED', '')}</span>
                  <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: dr.contribution > 0 ? T.pos : T.neg }}>{dr.contribution > 0 ? 'BENEFITS' : 'PRESSURED'}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: dr.contribution > 0 ? T.pos : T.neg }}>{signed(dr.contribution, 1)}</span>
                </div>
              ))}
              {l.drivers.every(dr => dr.contribution === 0) && <div style={{ fontFamily: MONO, fontSize: 10, color: T.muted, padding: '4px 0' }}>No straits under stress right now. Score reflects structural exposure ({l.links} straits).</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0' }}>
                <span style={{ fontFamily: MONO, fontSize: 9, color: T.textDim }}>Σ score</span>
                <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: sigC }}>{signed(l.score, 1)}</span>
              </div>
            </div>
          </div>
          <div style={{ width: 150, flexShrink: 0 }}>
            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.muted }}>30 days</div>
            <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: chg(l.change_pct), marginTop: 6 }}>{pct(l.change_pct)}</div>
            <div style={{ marginTop: 6 }}><Spark data={l.spark} color={chg(l.change_pct)} w={140} h={32} /></div>
          </div>
        </div>
      )}
    </div>
  )
}
