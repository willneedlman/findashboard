import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ObservationBoardPanel from '../components/ObservationBoardPanel'
import StationBoardPanel from '../components/StationBoardPanel'
import { fetchFlaringBoard, fetchPortBoard } from '../hooks/useApi'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { MapContainer, Polyline, CircleMarker, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTip } from 'recharts'
import { motion, useReducedMotion } from 'framer-motion'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import PageWrapper from '../components/PageWrapper'
import { readToken } from '../lib/theme'
import { formatLocalTime } from '../lib/time'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'
import ShellActions from '../components/ShellActions'

// Leaflet SVG/canvas can't consume CSS var(), so resolve theme tokens to concrete
// values at runtime (recomputed on preset change). Semantic categories map to the
// theme's accent palette so they follow presets while staying distinct.
type Colors = ReturnType<typeof buildColors>
function buildColors() {
  const t = (n: string, fb: string) => readToken(n, fb) || fb
  return {
    gold: t('--theme-primary', '#c9a84c'),
    ocean: t('--theme-bg', '#0b1626'),
    land: t('--theme-surface', '#0f1d31'),
    coast: 'rgba(120,150,185,0.16)',
    lane: t('--theme-tertiary', '#35b7c2'),
    spark: t('--theme-tertiary', '#60a5fa'),
    tanker: t('--theme-positive', '#3fb6a0'),
    lng: t('--theme-tertiary', '#5b93c9'),
    cargo: t('--theme-warn', '#cfa14b'),
    wind: t('--theme-positive', '#4a9e8f'),
    oilTerm: t('--theme-negative', '#cf4b3f'),
    lngTerm: t('--theme-accent-violet', '#c084fc'),
    field: t('--theme-accent-orange', '#d07b34'),
    power: t('--theme-primary', '#cbb26a'),
    coal: t('--theme-secondary', '#556070'),
    wpi: t('--theme-secondary', '#6f8bb0'),
    helcom: t('--theme-accent-violet', '#a07cc4'),
    refinery: t('--theme-primary', '#b88a3a'),
    flare: t('--theme-warn', '#e8894a'),
    positive: t('--theme-positive', '#22C55E'),
    negative: t('--theme-negative', '#EF4444'),
  }
}

const VLABEL: Record<string, string> = { tanker: 'Crude Tanker', lng: 'LNG / Gas Carrier', cargo: 'Cargo / Dry Bulk', other: 'Vessel' }
const HEAVY_MIN_ZOOM = 3.5
const DETAIL_MIN_ZOOM = 5
// Dewey PERFORMANCE_CHANGE is a fraction (0.25 = a 25% swing in 7-day port
// performance). Color a port only on a notable move so most ports stay neutral.
const DEWEY_CHANGE_HL = 0.25

// Curated major shipping lanes (illustrative, grouped under vessel toggles).
const LANES: { type: 'tanker' | 'lng' | 'cargo'; pts: [number, number][] }[] = [
  { type: 'tanker', pts: [[26.64, 50.16], [26.55, 56.4], [24, 60], [17, 64], [8, 76], [6, 88], [3, 96], [2.5, 101.5], [6, 105], [15, 112], [25, 120], [29.9, 122.6]] },
  { type: 'tanker', pts: [[26.55, 56.4], [20, 58], [14, 52], [12.6, 43.4], [20, 38], [27, 34.5], [30, 32.55], [32, 30], [35, 20], [37, 10], [37, 3], [36, -5.5], [43, -9], [49, -5], [51.95, 4.05]] },
  { type: 'tanker', pts: [[26.55, 56.4], [15, 62], [0, 60], [-15, 50], [-30, 35], [-34.6, 19.6], [-20, 5], [0, -2], [15, -18], [30, -18], [40, -12], [48, -8], [51.95, 4.05]] },
  { type: 'tanker', pts: [[29.35, -94.9], [26, -84], [25, -80], [30, -72], [38, -55], [45, -35], [49, -15], [50, -6], [51.95, 4.05]] },
  { type: 'tanker', pts: [[4.45, 7.17], [0, 0], [5, -20], [12, -40], [20, -60], [25, -80], [29.35, -94.9]] },
  { type: 'tanker', pts: [[60.35, 28.6], [59.5, 22], [58, 18], [55.7, 12.7], [57, 8], [54, 4], [51.95, 4.05]] },
  { type: 'lng', pts: [[-23.8, 151.25], [-15, 155], [-5, 150], [5, 140], [15, 135], [25, 130], [33, 135], [35, 139.8]] },
  { type: 'lng', pts: [[25.9, 51.6], [24, 58], [17, 64], [8, 76], [6, 88], [3, 96], [2.5, 101.5], [10, 110], [22, 120], [31, 128], [35, 139.8]] },
  { type: 'lng', pts: [[29.73, -93.87], [26, -84], [25, -80], [30, -72], [40, -55], [48, -25], [50, -8], [51.35, 3.2]] },
  { type: 'cargo', pts: [[31.2, 121.5], [30, 126], [20, 120], [8, 108], [2.5, 101.5], [6, 90], [10, 76], [18, 66], [25, 58], [26.55, 56.4]] },
  { type: 'cargo', pts: [[35, 139.8], [38, 150], [45, 160], [52, 175], [55, -165], [52, -140], [45, -128], [37, -123]] },
  { type: 'cargo', pts: [[-33.9, 18.4], [-20, 10], [0, -5], [10, -18], [20, -25], [30, -25], [40, -20], [48, -10], [51.95, 4.05]] },
]

// ── Leaflet divIcon factories (colors passed in) ─────────────────────────────
const arrowIcon = (color: string, heading: number, s = 9, opacity = 1) => L.divIcon({
  className: '', iconSize: [s + 4, s + 4], iconAnchor: [(s + 4) / 2, (s + 4) / 2],
  html: `<div style="width:${s + 4}px;height:${s + 4}px;transform:rotate(${heading}deg);opacity:${opacity};display:flex;align-items:center;justify-content:center;"><div style="width:0;height:0;border-left:${s * 0.4}px solid transparent;border-right:${s * 0.4}px solid transparent;border-bottom:${s}px solid ${color};filter:drop-shadow(0 0 1.5px ${color});"></div></div>`,
})
const boxIcon = (style: string, size: number) => L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<div style="${style}"></div>` })
const platformIcon = (c: string) => boxIcon(`width:9px;height:9px;border:1.5px solid ${c};transform:rotate(45deg);`, 12)
const fieldIcon = (c: string) => boxIcon(`width:9px;height:9px;background:${c};transform:rotate(45deg);border:1px solid rgba(0,0,0,0.5);`, 12)
const refIcon = (c: string) => boxIcon(`width:9px;height:9px;background:${c};border:1px solid rgba(0,0,0,0.4);`, 11)
const coalIcon = (c: string) => boxIcon(`width:9px;height:9px;background:${c};border:1px solid rgba(0,0,0,0.4);`, 11)
const wpiIcon = (s: string, c: string) => {
  const sz = s === 'Large' ? 11 : s === 'Medium' ? 9 : 7, b = sz - 3
  return boxIcon(`width:${b}px;height:${b}px;border:1.5px solid ${c};background:color-mix(in srgb, ${c} 16%, transparent);`, sz)
}

// ── Types ────────────────────────────────────────────────────────────────────
interface Vessel { mmsi: string; name?: string; lat: number; lon: number; sog?: number; cog?: number; heading?: number; destination?: string; category?: string; time_utc?: string; source?: string }
interface Chokepoint { id: string; name: string; lat: number; lon: number; oil_mbd: number; note: string }
interface Port { name: string; country: string; lat: number; lon: number; kind: 'oil' | 'lng'; throughput: string; cppi?: number }
interface Pipeline { name: string; substance: string; coords: [number, number][] }
interface LngTerm { n: string; la: number; lo: number; st: string; ie: string; cap: number | null }
interface WpiPort { n: string; la: number; lo: number; c: string; s: string; cppi?: number }
interface DeweyPort { port_id: string; name: string; country: string | null; latitude: number; longitude: number; latest_date: string; import_performance_hours: number | null; import_change_pct: number | null; import_flag: string | null; import_teu: number | null; export_performance_hours: number | null; export_change_pct: number | null; export_flag: string | null; export_teu: number | null; monthly_performance_hours: number | null; monthly_vessels: number | null; monthly_teu: number | null }
interface Facility { n: string; la: number; lo: number; k: string; x?: string | number }
interface OsmPort { name: string; lat: number; lon: number; kind: string }
interface EmodFeat { kind: string; n: string; coords?: [number, number][]; la?: number; lo?: number }
interface HelcomFeat { coords: [number, number][]; location: string; crossings: number }
interface HistPoint { d: string; tanker: number | null; cargo: number | null; total: number | null; cap: number | null }
interface HistNowcastPoint { total: number; tanker: number; cargo: number; cap: number }
interface HistSeries { id: string; name: string; points: HistPoint[]; nowcast_days?: string[]; nowcast_daily?: Record<string, HistNowcastPoint> }
type HistMetric = 'total' | 'tanker' | 'cargo' | 'cap'
interface Nowcast {
  calls_96h: number; calls_per_day_live: number; capacity_est_dwt: number | null
  capacity_coverage_pct: number | null; live_vs_baseline_pct: number | null
  confidence: 'high' | 'medium' | 'low' | 'stale' | 'none'; as_of: string | null
}
interface ChokeStat {
  id: string; name: string; oil_mbd: number; share_pct: number; avg7: number
  delta_pct: number | null; transits7: number; series30: number[]
  mix: { tanker: number | null; cargo: number | null; total: number | null }
  cap7: number | null; anomaly: 'high' | 'low' | null; status: 'normal' | 'watch' | 'congested'; as_of: string
  nowcast?: Nowcast | null
}
interface FlareSite { id: string; label: string; unit: string; bbox: number[] }
interface ReplayFrame { t: number; v: [string, number, number, number, string][] }

type LayerKey = 'tanker' | 'lng' | 'cargo' | 'lanes' | 'pGem' | 'pEia' | 'pOsm' | 'pEmod' | 'terminals' | 'lngTerm' | 'fields' | 'refineries' | 'power' | 'coal' | 'wpi' | 'chokepoints' | 'helcom' | 'flares'
type Preset = 'all' | 'oil' | 'lng' | 'coal' | 'choke'
type FineKey = 'pipes' | 'terminals' | 'fieldsRef' | 'flares' | 'wpi' | 'helcom'

interface Entity { kind: 'choke' | 'vessel' | 'terminal' | 'port' | 'field' | 'flare'; id: string; name: string; lat: number; lon: number; metric?: string }

const OFF: Record<LayerKey, boolean> = {
  tanker: false, lng: false, cargo: false, lanes: false, pGem: false, pEia: false, pOsm: false, pEmod: false,
  terminals: false, lngTerm: false, fields: false, refineries: false, power: false, coal: false,
  wpi: false, chokepoints: false, helcom: false, flares: false,
}
const PRESETS: Record<Preset, Record<LayerKey, boolean>> = {
  all: { ...OFF, tanker: true, lng: true, cargo: true, lanes: true, pGem: true, terminals: true, lngTerm: true, fields: true, chokepoints: true, flares: true },
  oil: { ...OFF, tanker: true, lanes: true, pGem: true, terminals: true, fields: true, refineries: true, chokepoints: true, flares: true },
  lng: { ...OFF, lng: true, lanes: true, pGem: true, lngTerm: true, chokepoints: true, flares: true },
  coal: { ...OFF, cargo: true, lanes: true, coal: true, chokepoints: true },
  choke: { ...OFF, tanker: true, lng: true, cargo: true, chokepoints: true },
}
const FINE_TO_LAYERS: Record<FineKey, LayerKey[]> = {
  pipes: ['pGem'], terminals: ['terminals'], fieldsRef: ['fields', 'refineries'], flares: ['flares'],
  wpi: ['wpi'], helcom: ['helcom'],
}
const HEAVY: Set<LayerKey> = new Set(['fields', 'refineries', 'power', 'coal', 'wpi', 'lngTerm'])
const STRIP_IDS = ['hormuz', 'malacca', 'taiwan', 'suez', 'bab', 'panama']
const PRESET_LABELS: { key: Preset; view: string; pill: string }[] = [
  { key: 'all', view: 'All flows', pill: 'ALL' }, { key: 'oil', view: 'Oil', pill: 'OIL' },
  { key: 'lng', view: 'LNG and gas', pill: 'LNG' }, { key: 'coal', view: 'Coal and bulk', pill: 'COAL' },
  { key: 'choke', view: 'Chokepoints', pill: 'CHOKE' },
]

// ── Map helper components ─────────────────────────────────────────────────────
function SizeFix() {
  const map = useMap()
  useEffect(() => {
    const t1 = setTimeout(() => map.invalidateSize(), 60)
    const t2 = setTimeout(() => map.invalidateSize(), 320)
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(map.getContainer())
    return () => { clearTimeout(t1); clearTimeout(t2); ro.disconnect() }
  }, [map])
  return null
}

function VectorBasemap({ land, coast }: { land: string; coast: string }) {
  const map = useMap()
  useEffect(() => {
    let layer: L.Layer | undefined
    fetch('/world-countries.geo.json').then(r => r.json()).then(gj => {
      layer = L.geoJSON(gj, { style: { fillColor: land, color: coast, weight: 0.6, fillOpacity: 1 } as L.PathOptions, interactive: false }).addTo(map)
      ;(layer as L.GeoJSON).bringToBack()
    }).catch(() => {
      layer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 6 }).addTo(map)
      ;(layer as L.TileLayer).bringToBack()
    })
    return () => { if (layer) map.removeLayer(layer) }
  }, [map, land, coast])
  return null
}

function FocusController({ focus }: { focus: { lat: number; lon: number; zoom: number } | null }) {
  const map = useMap()
  useEffect(() => { if (focus) map.flyTo([focus.lat, focus.lon], focus.zoom, { duration: 1.25 }) }, [focus, map])
  return null
}

function ViewportWatcher({ onChange }: { onChange: (bbox: string, zoom: number) => void }) {
  const map = useMap()
  const emit = () => {
    const b = map.getBounds()
    onChange(`${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`, map.getZoom())
  }
  useMapEvents({ moveend: emit })
  useEffect(() => { emit() }, [])
  return null
}

function MapClickCatcher({ onBackgroundClick, suppress }: { onBackgroundClick: () => void; suppress: React.MutableRefObject<number> }) {
  useMapEvents({ click: () => { if (Date.now() - suppress.current > 150) onBackgroundClick() } })
  return null
}

// ── Chrome glyphs & shared styles ─────────────────────────────────────────────
const gArrow = (c: string): React.CSSProperties => ({ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: `11px solid ${c}` })
const gRing = (c: string): React.CSSProperties => ({ width: 11, height: 11, borderRadius: '50%', border: `2px solid ${c}` })
const gLine = (c: string, dash = false): React.CSSProperties => ({ width: 18, height: 0, borderTop: `2px ${dash ? 'dashed' : 'solid'} ${c}` })
const gDot = (c: string): React.CSSProperties => ({ width: 10, height: 10, borderRadius: '50%', background: c })
const gDiamond = (c: string): React.CSSProperties => ({ width: 9, height: 9, background: c, transform: 'rotate(45deg)' })
const gDiamondO = (c: string): React.CSSProperties => ({ width: 9, height: 9, border: `1.5px solid ${c}`, transform: 'rotate(45deg)' })
const gSquare = (c: string): React.CSSProperties => ({ width: 10, height: 10, background: c })
const gSquareO = (c: string): React.CSSProperties => ({ width: 10, height: 10, border: `1.5px solid ${c}` })

// Grouped dynamic legend, 1:1 with the layers actually rendered (vis already
// carries the zoom gate, so gated-off layers drop out here too).
function buildLegend(v: Record<LayerKey, boolean>, C: Colors) {
  const G: { group: string; items: { glyph: React.CSSProperties; label: string }[] }[] = []
  let it: { glyph: React.CSSProperties; label: string }[] = []
  if (v.tanker) it.push({ glyph: gArrow(C.tanker), label: 'Crude tanker' })
  if (v.lng) it.push({ glyph: gArrow(C.lng), label: 'LNG carrier' })
  if (v.cargo) it.push({ glyph: gArrow(C.cargo), label: 'Cargo / dry bulk' })
  if (v.lanes) it.push({ glyph: gLine(C.lane, true), label: 'Shipping lane' })
  if (it.length) G.push({ group: 'Vessels & lanes', items: it })

  it = []
  if (v.pGem || v.pEia || v.pOsm || v.pEmod) { it.push({ glyph: gLine(C.gold), label: 'Oil pipeline' }); it.push({ glyph: gLine(C.gold, true), label: 'Gas pipeline' }) }
  if (v.pOsm || v.pEmod) it.push({ glyph: gDiamondO(C.gold), label: 'Offshore platform' })
  if (v.pEmod) it.push({ glyph: gRing(C.wind), label: 'Offshore wind farm' })
  if (it.length) G.push({ group: 'Pipelines & offshore', items: it })

  it = []
  if (v.terminals) { it.push({ glyph: gDot(C.oilTerm), label: 'Oil export terminal' }); it.push({ glyph: gDot(C.lngTerm), label: 'LNG export terminal' }) }
  if (v.lngTerm) it.push({ glyph: gRing(C.lngTerm), label: 'LNG terminal (GEM)' })
  if (v.fields) it.push({ glyph: gDiamond(C.field), label: 'Oil / gas field' })
  if (v.refineries) it.push({ glyph: gSquare(C.refinery), label: 'Refinery / processing' })
  if (v.power) it.push({ glyph: gDot(C.power), label: 'Power plant (oil/gas)' })
  if (v.coal) it.push({ glyph: gSquare(C.coal), label: 'Coal terminal' })
  if (it.length) G.push({ group: 'Facilities', items: it })

  it = []
  if (v.wpi) it.push({ glyph: gSquareO(C.wpi), label: 'World port (WPI)' })
  if (v.chokepoints) it.push({ glyph: gRing(C.gold), label: 'Chokepoint' })
  if (it.length) G.push({ group: 'Ports & points', items: it })

  it = []
  if (v.helcom) it.push({ glyph: gLine(C.helcom), label: 'Baltic passage (HELCOM)' })
  if (it.length) G.push({ group: 'Overlays', items: it })
  return G
}

const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'
const GOLD = 'var(--theme-primary, #c9a84c)'
const TEXT = 'var(--theme-text, #d7e3fc)'
const SEC = 'var(--theme-secondary, #8099b0)'
const MUTED = 'var(--theme-text-dim, #56708a)'
const FAINT = 'var(--theme-text-faint, #3f5670)'
const panelBg = (a = 0.94) => `color-mix(in srgb, var(--theme-surface, #0d1826) ${Math.round(a * 100)}%, transparent)`
const goldBorder = (a = 0.35) => `1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) ${Math.round(a * 100)}%, transparent)`
const neutralBorder = '1px solid var(--theme-border, rgba(255,255,255,0.10))'
const eyebrow: React.CSSProperties = { fontFamily: MONO, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.18em', color: MUTED }

function Sparkline({ data, w = 44, h = 15, color }: { data: number[]; w?: number; h?: number; color: string }) {
  if (!data.length) return null
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(' ')
  return <svg width={w} height={h} style={{ display: 'block' }}><polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} /></svg>
}

const fmtClockLocal = () => formatLocalTime(new Date())

export function MaritimeMapContent() {
  const [C, setC] = useState<Colors>(buildColors)
  const navigate = useNavigate()
  const reduced = useReducedMotion()
  useEffect(() => {
    const rc = () => setC(buildColors())
    rc()
    const mo = new MutationObserver(rc)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => mo.disconnect()
  }, [])

  // ── Cockpit state (preset + overrides + pins persisted) ──
  const persisted = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('flowsCockpit') || '{}') } catch { return {} }
  }, [])
  const [preset, setPreset] = useState<Preset>(persisted.preset && PRESETS[persisted.preset as Preset] ? persisted.preset : 'all')
  const [overrides, setOverrides] = useState<Partial<Record<FineKey, boolean>>>(persisted.overrides ?? {})
  const [pinned, setPinned] = useState<Entity[]>(persisted.pinned ?? [])
  const [inspected, setInspected] = useState<Entity | null>(null)
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom: number } | null>(null)
  const [view, setView] = useState<{ bbox: string; zoom: number } | null>(null)
  const [clock, setClock] = useState(fmtClockLocal)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchIdx, setSearchIdx] = useState(0)
  const [histOpen, setHistOpen] = useState(false)
  const [histIds, setHistIds] = useState<string[]>(['hormuz'])
  const [histDays, setHistDays] = useState(90)
  const [histMetric, setHistMetric] = useState<HistMetric>('total')
  const [replay, setReplay] = useState<{ open: boolean; playing: boolean; t: number; speed: 1 | 8 | 32 }>({ open: false, playing: false, t: 1, speed: 8 })
  const searchRef = useRef<HTMLInputElement>(null)
  const suppressMapClick = useRef(0)

  useEffect(() => {
    localStorage.setItem('flowsCockpit', JSON.stringify({ preset, overrides, pinned }))
  }, [preset, overrides, pinned])
  useEffect(() => {
    const id = setInterval(() => setClock(fmtClockLocal()), 30_000)
    return () => clearInterval(id)
  }, [])

  const [gemPipes, setGemPipes] = useState<Pipeline[]>([])
  const [eiaPipes, setEiaPipes] = useState<Pipeline[]>([])
  const [osmPipes, setOsmPipes] = useState<Pipeline[]>([])
  const [osmPlatforms, setOsmPlatforms] = useState<OsmPort[]>([])
  const [emod, setEmod] = useState<EmodFeat[]>([])
  const [fac, setFac] = useState<Facility[]>([])
  const [wpiPorts, setWpiPorts] = useState<WpiPort[]>([])
  const [helcom, setHelcom] = useState<HelcomFeat[]>([])

  // Visible layers = preset bundle + fine-tune overrides, then a zoom gate on
  // dense facility layers (the Z+ hint in the panel).
  const zoom = view?.zoom ?? 2.2
  const vis = useMemo(() => {
    const v = { ...PRESETS[preset] }
    for (const [fk, on] of Object.entries(overrides) as [FineKey, boolean][]) {
      for (const lk of FINE_TO_LAYERS[fk]) v[lk] = on
    }
    for (const lk of HEAVY) if (v[lk] && zoom < HEAVY_MIN_ZOOM) v[lk] = false
    return v
  }, [preset, overrides, zoom])
  const fineState = (fk: FineKey) => overrides[fk] ?? FINE_TO_LAYERS[fk].some(lk => PRESETS[preset][lk])
  const dimVessels = preset === 'choke'

  const anyFac = vis.fields || vis.refineries || vis.power || vis.coal

  const VCOLOR = useMemo<Record<string, string>>(() => ({ tanker: C.tanker, lng: C.lng, cargo: C.cargo, other: C.cargo }), [C])

  useEffect(() => {
    if (!view) return
    const { bbox, zoom } = view
    const t = setTimeout(() => {
      if (vis.pGem) axios.get(zoom < 4 ? '/api/maritime/pipelines?source=gem' : `/api/maritime/pipelines?source=gem&bbox=${bbox}`).then(r => setGemPipes(r.data.pipelines || [])).catch(() => {})
      if (vis.pEia && zoom >= DETAIL_MIN_ZOOM) axios.get(`/api/maritime/pipelines?source=eia&bbox=${bbox}`).then(r => setEiaPipes(r.data.pipelines || [])).catch(() => {})
      if (vis.pOsm && zoom >= DETAIL_MIN_ZOOM) {
        axios.get(`/api/maritime/pipelines?source=osm&bbox=${bbox}`).then(r => setOsmPipes(r.data.pipelines || [])).catch(() => {})
        axios.get(`/api/maritime/ports?bbox=${bbox}`).then(r => setOsmPlatforms((r.data.osm_ports || []).filter((p: OsmPort) => p.kind === 'platform'))).catch(() => {})
      }
      if (vis.pEmod) axios.get(`/api/maritime/emodnet?bbox=${bbox}`).then(r => setEmod(r.data.features || [])).catch(() => {})
      if (anyFac) axios.get(zoom < 4 ? '/api/maritime/facilities' : `/api/maritime/facilities?bbox=${bbox}`).then(r => setFac(r.data.facilities || [])).catch(() => {})
      if (vis.wpi) axios.get(`/api/maritime/world-ports?bbox=${bbox}`).then(r => setWpiPorts(r.data.ports || [])).catch(() => {})
      if (vis.helcom) axios.get(`/api/maritime/helcom?bbox=${bbox}`).then(r => setHelcom(r.data.features || [])).catch(() => {})
    }, 450)
    return () => clearTimeout(t)
  }, [view, vis.pGem, vis.pEia, vis.pOsm, vis.pEmod, anyFac, vis.wpi, vis.helcom])

  useEffect(() => { if (!vis.pGem) setGemPipes([]) }, [vis.pGem])
  useEffect(() => { if (!vis.pEia) setEiaPipes([]) }, [vis.pEia])
  useEffect(() => { if (!vis.pOsm) { setOsmPipes([]); setOsmPlatforms([]) } }, [vis.pOsm])
  useEffect(() => { if (!vis.pEmod) setEmod([]) }, [vis.pEmod])
  useEffect(() => { if (!anyFac) setFac([]) }, [anyFac])
  useEffect(() => { if (!vis.wpi) setWpiPorts([]) }, [vis.wpi])
  useEffect(() => { if (!vis.helcom) setHelcom([]) }, [vis.helcom])

  const choke = useQuery<{ chokepoints: Chokepoint[] }>({ queryKey: ['mar-choke'], queryFn: () => axios.get('/api/maritime/chokepoints').then(r => r.data), staleTime: Infinity })
  const terms = useQuery<{ ports: Port[] }>({ queryKey: ['mar-terms'], queryFn: () => axios.get('/api/maritime/ports').then(r => r.data), staleTime: Infinity })
  const lngQ = useQuery<{ lng: LngTerm[] }>({ queryKey: ['mar-lng'], queryFn: () => axios.get('/api/maritime/lng').then(r => r.data), staleTime: Infinity })
  const vess = useQuery<{ vessels: Vessel[]; count: number; status: { key_present: boolean; connected: boolean } }>({
    queryKey: ['mar-vessels'], queryFn: () => axios.get('/api/maritime/vessels').then(r => r.data), refetchInterval: 12000, staleTime: 8000,
  })
  // PortWatch transit data is daily; the backend caches it 1h, so poll hourly to
  // surface a newly-published day in the chokepoint strip, inspector and alerts
  // without waiting for a remount. (Live vessel layer above already polls at 12s.)
  const statsQ = useQuery<{ stats: ChokeStat[] }>({
    queryKey: ['choke-stats'], queryFn: () => axios.get('/api/maritime/chokepoint-stats').then(r => r.data),
    staleTime: 3600 * 1000, refetchInterval: 3600 * 1000,
  })
  const hist = useQuery<{ series: HistSeries[]; nowcast_meta?: { window_h: number; as_of: string | null } }>({
    queryKey: ['choke-hist', histIds.join(','), histDays],
    queryFn: () => axios.get(`/api/maritime/chokepoint-history?ids=${histIds.join(',')}&days=${histDays}`).then(r => r.data),
    enabled: histOpen && histIds.length > 0, staleTime: 30 * 1000, refetchInterval: 60 * 1000,
  })
  const flaresQ = useQuery<{ available: boolean; reason: string | null; sites: FlareSite[] }>({
    queryKey: ['mar-flares'], queryFn: () => axios.get('/api/maritime/flaring-sites').then(r => r.data),
    staleTime: Infinity,
  })

  const portPerfQ = useQuery<{ ports: DeweyPort[]; available: boolean; refresh?: string; frequency?: string }>({
    queryKey: ['port-performance', view?.bbox],
    queryFn: () => axios.get(`/api/maritime/port-performance${view?.bbox ? `?bbox=${view.bbox}` : ''}`).then(r => r.data),
    enabled: vis.wpi, staleTime: 60 * 60 * 1000, refetchInterval: 60 * 60 * 1000,
  })
  const replayQ = useQuery<{ frames: ReplayFrame[]; interval_s: number }>({
    queryKey: ['ais-replay'], queryFn: () => axios.get('/api/maritime/vessel-history').then(r => r.data),
    enabled: replay.open, staleTime: 5 * 60 * 1000,
  })

  const allVessels = vess.data?.vessels ?? []
  const counts = useMemo(() => ({
    all: allVessels.length,
    oil: allVessels.filter(v => v.category === 'tanker').length,
    lng: allVessels.filter(v => v.category === 'lng').length,
    coal: allVessels.filter(v => v.category === 'cargo').length,
    choke: choke.data?.chokepoints.length ?? 10,
  }), [allVessels, choke.data])

  // Viewport-cull + cap for DOM-marker (divIcon) layers — keeps the map smooth.
  const vb = view ? view.bbox.split(',').map(Number) : null   // [s, w, n, e]
  const M = 6
  const inView = (la: number, lo: number) => !vb || (la >= vb[0] - M && la <= vb[2] + M && lo >= vb[1] - M && lo <= vb[3] + M)
  function cull<T>(arr: T[], lat: (t: T) => number, lon: (t: T) => number, cap: number): T[] {
    const v = arr.filter(t => inView(lat(t), lon(t)))
    if (v.length <= cap) return v
    const step = Math.ceil(v.length / cap)
    return v.filter((_, i) => i % step === 0)
  }

  const catShown = (c?: string) => c === 'lng' ? vis.lng : c === 'tanker' ? vis.tanker : vis.cargo
  const liveVessels = cull(allVessels.filter(v => catShown(v.category)), v => v.lat, v => v.lon, 350)
  const facBy = (k: string) => cull(fac.filter(f => f.k === k), f => f.la, f => f.lo, 300)
  const refs = cull(fac.filter(f => f.k === 'refinery' || f.k === 'processing'), f => f.la, f => f.lo, 300)
  const wpiShown = cull(wpiPorts, p => p.la, p => p.lo, 600)
  const deweyPorts = cull(portPerfQ.data?.ports ?? [], p => p.latitude, p => p.longitude, 600)
  const platformsShown = cull(osmPlatforms, p => p.lat, p => p.lon, 300)
  const emodPlatforms = cull(emod.filter(f => f.kind === 'platform' && f.la != null), f => f.la!, f => f.lo!, 300)
  const emodWind = cull(emod.filter(f => f.kind === 'windfarm' && f.la != null), f => f.la!, f => f.lo!, 300)
  const pipeStyle = (sub: string) => ({ color: C.gold, weight: 2, opacity: 0.9, dashArray: sub === 'gas' ? '6 6' : undefined })

  // ── Replay playback ──
  const frames = replayQ.data?.frames ?? []
  useEffect(() => {
    if (!replay.open || !replay.playing || frames.length < 2) return
    // 1x plays the 24h window in 2 minutes; 8x and 32x scale from there.
    const step = 1 / (120 / replay.speed) / 30
    const id = setInterval(() => setReplay(r => {
      const t = r.t + step
      return t >= 1 ? { ...r, t: 1, playing: false } : { ...r, t }
    }), 1000 / 30)
    return () => clearInterval(id)
  }, [replay.open, replay.playing, replay.speed, frames.length])

  const replayVessels = useMemo(() => {
    if (!replay.open || frames.length < 2) return null
    const t0 = frames[0].t, t1 = frames[frames.length - 1].t
    const tAbs = t0 + (t1 - t0) * replay.t
    let i = frames.findIndex(f => f.t > tAbs)
    if (i <= 0) i = frames.length - 1
    const a = frames[i - 1], b = frames[i]
    const frac = b.t > a.t ? (tAbs - a.t) / (b.t - a.t) : 0
    const bByM = new Map(b.v.map(r => [r[0], r]))
    const out: { mmsi: string; lat: number; lon: number; hd: number; cat: string }[] = []
    for (const r of a.v) {
      const n = bByM.get(r[0])
      out.push(n
        ? { mmsi: r[0], lat: r[1] + (n[1] - r[1]) * frac, lon: r[2] + (n[2] - r[2]) * frac, hd: n[3], cat: r[4] }
        : { mmsi: r[0], lat: r[1], lon: r[2], hd: r[3], cat: r[4] })
    }
    return { vessels: out, time: new Date(tAbs * 1000) }
  }, [replay.open, replay.t, frames])
  const CAT_DECODE: Record<string, string> = { t: 'tanker', l: 'lng', c: 'cargo', o: 'other' }

  // ── Search ──
  const index = useMemo<Entity[]>(() => {
    const out: Entity[] = []
    for (const c of choke.data?.chokepoints ?? []) out.push({ kind: 'choke', id: c.id, name: c.name, lat: c.lat, lon: c.lon, metric: `${c.oil_mbd} Mb/d` })
    for (const p of terms.data?.ports ?? []) out.push({ kind: 'terminal', id: `term-${p.name.trim()}`, name: `${p.name.trim()} (${p.country})`, lat: p.lat, lon: p.lon, metric: p.throughput })
    for (const t of lngQ.data?.lng ?? []) out.push({ kind: 'terminal', id: `lng-${t.n}`, name: t.n, lat: t.la, lon: t.lo, metric: t.cap ? `~${t.cap} Mtpa` : 'LNG' })
    for (const v of allVessels) if (v.name) out.push({ kind: 'vessel', id: v.mmsi, name: v.name, lat: v.lat, lon: v.lon, metric: v.sog != null ? `${v.sog.toFixed(1)} kn` : VLABEL[v.category ?? 'other'] })
    for (const f of fac.filter(f => f.k === 'field')) out.push({ kind: 'field', id: `field-${f.n}`, name: f.n, lat: f.la, lon: f.lo, metric: 'Field' })
    for (const p of wpiPorts) out.push({ kind: 'port', id: `wpi-${p.n}`, name: p.c ? `${p.n} (${p.c})` : p.n, lat: p.la, lon: p.lo, metric: p.s ? `${p.s} harbour` : 'Port' })
    return out
  }, [choke.data, terms.data, lngQ.data, allVessels, fac, wpiPorts])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    return index
      .map(e => ({ e, i: e.name.toLowerCase().indexOf(q) }))
      .filter(x => x.i >= 0)
      .sort((a, b) => a.i - b.i || a.e.name.length - b.e.name.length)
      .slice(0, 8).map(x => x.e)
  }, [index, query])

  const flyTo = (e: Entity) => {
    setFocus({ lat: e.lat, lon: e.lon, zoom: e.kind === 'vessel' ? 6 : 5 })
    setInspected(e)
  }
  const pickResult = (e: Entity) => {
    flyTo(e)
    setSearchOpen(false); setQuery(''); searchRef.current?.blur()
  }

  // ── Keyboard: '/' focuses search, Esc closes layers ──
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName
      if (ev.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        ev.preventDefault(); searchRef.current?.focus()
      } else if (ev.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); searchRef.current?.blur() }
        else if (replay.open) setReplay(r => ({ ...r, open: false, playing: false }))
        else if (histOpen) setHistOpen(false)
        else setInspected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchOpen, replay.open, histOpen])

  const stats = statsQ.data?.stats ?? []
  const statById = useMemo(() => new Map(stats.map(s => [s.id, s])), [stats])

  // Alert widgets: chokepoints whose transit profile is off pattern.
  const alerts = useMemo(() => stats
    .filter(s => s.status !== 'normal')
    .sort((a, b) => (a.status === 'congested' ? 0 : 1) - (b.status === 'congested' ? 0 : 1) || Math.abs(b.delta_pct ?? 0) - Math.abs(a.delta_pct ?? 0))
    .slice(0, 2), [stats])

  const isPinned = (e: Entity) => pinned.some(p => p.kind === e.kind && p.id === e.id)
  const togglePin = (e: Entity) => setPinned(ps => isPinned(e) ? ps.filter(p => !(p.kind === e.kind && p.id === e.id)) : [...ps, e].slice(-8))

  // Pinned callouts: resolve live position for vessels, static otherwise.
  const callouts = useMemo(() => pinned.map(p => {
    if (p.kind === 'vessel') {
      const v = allVessels.find(v => v.mmsi === p.id)
      return v ? { ...p, lat: v.lat, lon: v.lon, metric: v.sog != null ? `${v.sog.toFixed(1)} kn` : p.metric } : null
    }
    if (p.kind === 'choke') {
      const c = choke.data?.chokepoints.find(c => c.id === p.id)
      return c ? { ...p, metric: `${c.oil_mbd} Mb/d` } : p
    }
    return p
  }).filter((p): p is Entity => p != null), [pinned, allVessels, choke.data])

  const inspectChoke = (c: Chokepoint) => { suppressMapClick.current = Date.now(); setInspected({ kind: 'choke', id: c.id, name: c.name, lat: c.lat, lon: c.lon }) }
  const openHistoryFor = (id: string) => {
    setHistIds(ids => ids.includes(id) ? ids : [...ids, id].slice(-4))
    setHistOpen(true)
  }

  const vesselsInStrait = (c: { lat: number; lon: number }) =>
    allVessels.filter(v => Math.abs(v.lat - c.lat) < 1.5 && Math.abs(v.lon - c.lon) < 1.5).length

  const legendGroups = useMemo(() => buildLegend(vis, C), [vis, C])

  const mv = (delay = 0) => reduced ? {} : {
    initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 },
    transition: { duration: 0.3, delay, ease: [0.23, 1, 0.32, 1] as [number, number, number, number] },
  }

  const inspectedStat = inspected?.kind === 'choke' ? statById.get(inspected.id) : undefined
  const inspectedVessel = inspected?.kind === 'vessel' ? allVessels.find(v => v.mmsi === inspected.id) : undefined

  return (
    // Fill the viewport (Layout adds 16px py gutters): the disclaimer footer
    // lands below the fold and only appears on scroll.
    <div className="gfm-shell" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 32px)', minHeight: 680, border: '1px solid var(--theme-border)' }}>
      <style>{`
        .gfm-map { background: var(--theme-bg); }
        .gfm-chip:hover { border-color: ${GOLD} !important; color: ${TEXT} !important; }
        .gfm-row:hover { background: var(--theme-hover, rgba(255,255,255,0.04)); }
        .gfm-cpcell { container-type: inline-size; overflow: hidden; }
        @container (max-width: 225px) { .gfm-spark { display: none; } }
        @container (max-width: 285px) { .gfm-spark-long { display: none; } }
        @container (max-width: 175px) { .gfm-transits { display: none; } }
        @container (max-width: 140px) { .gfm-delta { display: none; } }
        .leaflet-tooltip.gfm-callout {
          background: color-mix(in srgb, var(--theme-surface, #0d1826) 95%, transparent); color: ${TEXT};
          border: ${goldBorder(0.35)}; border-radius: 0; box-shadow: none;
          font-family: ${MONO}; font-size: 9.5px; padding: 3px 7px;
        }
        .leaflet-tooltip.gfm-callout:before { display: none; }
        .leaflet-tooltip { background: var(--theme-surface); color: var(--theme-text); border: ${goldBorder(0.3)}; border-radius: 2px; box-shadow: none; font-family: ${SANS}; font-size: 11px; }
        .leaflet-tooltip-top:before { border-top-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-tooltip-bottom:before { border-bottom-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-tooltip-left:before { border-left-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-tooltip-right:before { border-right-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-bar a, .leaflet-bar a:hover { width: 28px; height: 28px; line-height: 28px; background: var(--theme-surface); color: var(--theme-text); border-color: color-mix(in srgb, var(--theme-primary) 28%, transparent); }
        .leaflet-bar a:hover { background: var(--theme-hover); color: var(--theme-primary); }
        .leaflet-control-attribution { background: color-mix(in srgb, var(--theme-bg) 72%, transparent) !important; color: var(--theme-secondary) !important; font-size: 9px; }
        .leaflet-control-attribution a { color: var(--theme-primary) !important; }
        @keyframes gfm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
        @media (max-width: 767px) {
          .gfm-shell { height: calc(100dvh - 118px) !important; min-height: 560px !important; }
          .gfm-search { left: 12px !important; right: 12px !important; top: 58px !important; }
          .gfm-left-rail { display: none !important; }
          .gfm-right-rail { width: min(296px, calc(100% - 24px)) !important; top: 164px !important; right: 12px !important; bottom: 64px !important; }
          .gfm-bottom-chrome { left: 12px !important; right: 12px !important; bottom: 12px !important; }
          .gfm-cp-strip { display: flex !important; overflow-x: auto; overscroll-behavior-inline: contain; }
          .gfm-cp-strip > * { min-width: 142px !important; }
        }
      `}</style>

      {/* ── Map region with floating chrome ── */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <MapContainer className="gfm-map" center={[24, 40]} zoom={2.2} minZoom={2} maxZoom={6} worldCopyJump preferCanvas
          zoomControl={false} maxBounds={[[-78, -200], [86, 220]]} maxBoundsViscosity={0.7} style={{ position: 'absolute', inset: 0, background: C.ocean }}>
          <VectorBasemap land={C.land} coast={C.coast} />
          <SizeFix />
          <FocusController focus={focus} />
          <ViewportWatcher onChange={(bbox, zoom) => setView({ bbox, zoom })} />
          <MapClickCatcher suppress={suppressMapClick} onBackgroundClick={() => setInspected(null)} />

          {/* Shipping lanes — dashArray (not CSS class) so the dash renders on canvas */}
          {vis.lanes && LANES.filter(l => vis[l.type]).map((l, i) => (
            <Polyline key={`lane-${i}`} positions={l.pts} pathOptions={{ color: C.lane, weight: 1.2, opacity: 0.5, dashArray: '4 8' }} />
          ))}

          {/* Pipelines: glow + core (gas dashed) */}
          {[vis.pGem && gemPipes, vis.pEia && eiaPipes, vis.pOsm && osmPipes, vis.pEmod && emod.filter(f => f.kind === 'pipeline').map(f => ({ name: f.n, substance: 'oil', coords: f.coords! }))]
            .filter(Boolean).flatMap((arr, gi) => (arr as Pipeline[]).map((p, i) => (
              <Fragment key={`pg-${gi}-${i}`}>
                {zoom >= 5 && <Polyline positions={p.coords} pathOptions={{ color: C.gold, weight: 6, opacity: 0.1 }} />}
                <Polyline positions={p.coords} pathOptions={pipeStyle(p.substance)}>
                  <Tooltip sticky>{p.name} · {p.substance === 'gas' ? 'Natural gas' : 'Crude oil'}</Tooltip>
                </Polyline>
              </Fragment>
            )))}

          {/* Offshore platforms (OSM + EMODnet) + wind farms (EMODnet) */}
          {vis.pOsm && platformsShown.map((p, i) => <Marker key={`osmp-${i}`} position={[p.lat, p.lon]} icon={platformIcon(C.gold)}><Tooltip>{p.name} · Offshore platform · OSM</Tooltip></Marker>)}
          {vis.pEmod && emodPlatforms.map((f, i) => <Marker key={`emp-${i}`} position={[f.la!, f.lo!]} icon={platformIcon(C.gold)}><Tooltip>{f.n} · platform · EMODnet</Tooltip></Marker>)}
          {vis.pEmod && emodWind.map((f, i) => <CircleMarker key={`emw-${i}`} center={[f.la!, f.lo!]} radius={4} pathOptions={{ color: C.wind, weight: 1.5, fillOpacity: 0 }}><Tooltip>{f.n} · wind farm · EMODnet</Tooltip></CircleMarker>)}

          {/* Vessels — live (heading arrows, click to inspect) or replay frames */}
          {!replayVessels && liveVessels.map(v => {
            const cat = v.category ?? 'other'
            const hd = v.heading != null && v.heading !== 511 ? v.heading : (v.cog ?? 0)
            return (
              <Marker key={`v-${v.mmsi}`} position={[v.lat, v.lon]} icon={arrowIcon(VCOLOR[cat] ?? C.cargo, hd, 9, dimVessels ? 0.4 : 1)}
                eventHandlers={{ click: () => { suppressMapClick.current = Date.now(); setInspected({ kind: 'vessel', id: v.mmsi, name: v.name || `MMSI ${v.mmsi}`, lat: v.lat, lon: v.lon }) } }} />
            )
          })}
          {replayVessels && cull(replayVessels.vessels, v => v.lat, v => v.lon, 350).map(v => (
            <Marker key={`rv-${v.mmsi}`} position={[v.lat, v.lon]} icon={arrowIcon(VCOLOR[CAT_DECODE[v.cat]] ?? C.cargo, v.hd, 9)} />
          ))}

          {/* Facilities */}
          {vis.fields && facBy('field').map((f, i) => (
            <Marker key={`fld-${i}`} position={[f.la, f.lo]} icon={fieldIcon(C.field)}
              eventHandlers={{ click: () => { suppressMapClick.current = Date.now(); setInspected({ kind: 'field', id: `field-${f.n}`, name: f.n, lat: f.la, lon: f.lo, metric: f.x ? String(f.x) : undefined }) } }}>
              <Tooltip>{f.n} · Oil/gas field{f.x ? ` · ${f.x}` : ''} · GEM</Tooltip>
            </Marker>
          ))}
          {vis.refineries && refs.map((f, i) => <Marker key={`ref-${i}`} position={[f.la, f.lo]} icon={refIcon(C.refinery)}><Tooltip>{f.n} · {f.k === 'processing' ? 'Processing plant' : 'Refinery'}{f.x ? ` · ${f.x}` : ''} · NETL</Tooltip></Marker>)}
          {vis.power && facBy('plant').map((f, i) => <CircleMarker key={`pw-${i}`} center={[f.la, f.lo]} radius={3.6} pathOptions={{ color: C.power, fillColor: C.power, fillOpacity: 0.9, weight: 0 }}><Tooltip>{f.n} · Oil/gas power plant{f.x ? ` · ${f.x}` : ''} · GEM</Tooltip></CircleMarker>)}
          {vis.coal && facBy('coal_terminal').map((f, i) => <Marker key={`cl-${i}`} position={[f.la, f.lo]} icon={coalIcon(C.coal)}><Tooltip>{f.n} · Coal terminal{f.x ? ` · ${f.x} Mt` : ''} · GEM</Tooltip></Marker>)}

          {/* LNG terminals (GEM) — purple rings */}
          {vis.lngTerm && lngQ.data?.lng.map((t, i) => (
            <CircleMarker key={`lt-${i}`} center={[t.la, t.lo]} radius={5} pathOptions={{ color: C.lngTerm, weight: 2, fillOpacity: 0 }}
              eventHandlers={{ click: () => { suppressMapClick.current = Date.now(); setInspected({ kind: 'terminal', id: `lng-${t.n}`, name: t.n, lat: t.la, lon: t.lo, metric: t.cap ? `~${t.cap} Mtpa LNG` : `LNG ${t.ie || ''} terminal` }) } }}>
              <Tooltip><b>{t.n}</b><br />LNG {t.ie || ''} terminal · {t.st} · GEM{t.cap ? `<br />~${t.cap} Mtpa` : ''}</Tooltip>
            </CircleMarker>
          ))}

          {/* Export terminals (curated) */}
          {vis.terminals && terms.data?.ports.map(p => {
            const col = p.kind === 'lng' ? C.lngTerm : C.oilTerm
            return <CircleMarker key={`term-${p.name}`} center={[p.lat, p.lon]} radius={4.5} pathOptions={{ color: col, fillColor: col, fillOpacity: 0.9, weight: 1 }}
              eventHandlers={{ click: () => { suppressMapClick.current = Date.now(); setInspected({ kind: 'terminal', id: `term-${p.name.trim()}`, name: `${p.name.trim()} (${p.country})`, lat: p.lat, lon: p.lon, metric: p.throughput }) } }}>
              <Tooltip><b>{p.name}</b> — {p.country}<br />{p.kind.toUpperCase()} export · {p.throughput}{p.cppi ? `<br />CPPI #${p.cppi}/405` : ''}</Tooltip>
            </CircleMarker>
          })}

          {/* World ports (WPI) — hollow squares sized by harbour size */}
          {vis.wpi && wpiShown.map((p, i) => <Marker key={`wpi-${i}`} position={[p.la, p.lo]} icon={wpiIcon(p.s, C.wpi)}><Tooltip>{p.n}{p.c ? ` · ${p.c}` : ''}{p.s ? ` · ${p.s} harbour` : ''}{p.cppi ? ` · CPPI #${p.cppi}/405` : ''} · WPI</Tooltip></Marker>)}

          {/* Dewey operational ports — daily import/export data is distinct from
              energy throughput, but gives each energy route a current port-side
              congestion and container-flow signal. */}
          {vis.wpi && deweyPorts.map(p => {
            const change = p.import_change_pct ?? p.export_change_pct
            const color = change != null && change > DEWEY_CHANGE_HL ? C.negative : change != null && change < -DEWEY_CHANGE_HL ? C.positive : C.spark
            const imp = p.import_performance_hours != null ? `Import ${p.import_performance_hours.toFixed(1)}h` : null
            const exp = p.export_performance_hours != null ? `Export ${p.export_performance_hours.toFixed(1)}h` : null
            const metric = [imp, exp].filter(Boolean).join(' · ') || 'Port performance available'
            return <CircleMarker key={`dewey-${p.port_id}`} center={[p.latitude, p.longitude]} radius={4.5} pathOptions={{ color, fillColor: color, fillOpacity: 0.35, weight: 1.5 }}
              eventHandlers={{ click: () => { suppressMapClick.current = Date.now(); setInspected({ kind: 'port', id: p.port_id, name: `${p.name}${p.country ? ` (${p.country})` : ''}`, lat: p.latitude, lon: p.longitude, metric }) } }}>
              <Tooltip><b>{p.name}</b>{p.country ? ` · ${p.country}` : ''}<br />{metric}<br />As of {p.latest_date} · Dewey Data</Tooltip>
            </CircleMarker>
          })}

          {/* Flaring basins — plotted at the centroid of the polygon the thermal
              readings are summed over, so the marker matches what is measured. */}
          {vis.flares && flaresQ.data?.available && flaresQ.data.sites.map(site => {
            const [west, south, east, north] = site.bbox
            const lat = (south + north) / 2, lon = (west + east) / 2
            const short = site.label.replace(/ — .*$/, '')
            return (
              <CircleMarker key={`flare-${site.id}`} center={[lat, lon]} radius={6}
                pathOptions={{ color: C.flare, fillColor: C.flare, fillOpacity: 0.22, weight: 1.5 }}
                eventHandlers={{ click: () => setInspected({ kind: 'flare', id: site.id, name: short, lat, lon }) }}>
                <Tooltip><b>{short}</b><br />gas flaring · VIIRS radiant power</Tooltip>
              </CircleMarker>
            )
          })}

          {/* Chokepoints — pulsing gold rings, click to inspect */}
          {vis.chokepoints && choke.data?.chokepoints.map(c => (
            <Fragment key={`cp-${c.id}`}>
              <CircleMarker center={[c.lat, c.lon]} radius={9} pathOptions={{ color: C.gold, fillColor: C.gold, fillOpacity: 0.1, weight: 2 }}
                eventHandlers={{ click: () => inspectChoke(c) }}>
                <Tooltip><b>{c.name}</b><br />~{c.oil_mbd} Mb/d oil transit</Tooltip>
              </CircleMarker>
              <CircleMarker center={[c.lat, c.lon]} radius={2.5} pathOptions={{ color: C.gold, fillColor: C.gold, fillOpacity: 1, weight: 0 }} />
            </Fragment>
          ))}

          {/* Pinned entity callouts — permanently open labels */}
          {callouts.map(p => (
            <CircleMarker key={`pin-${p.kind}-${p.id}`} center={[p.lat, p.lon]} radius={1} pathOptions={{ opacity: 0, fillOpacity: 0 }}>
              <Tooltip permanent direction="top" offset={[0, -6]} className="gfm-callout">
                {p.name.toUpperCase()}{p.metric ? ` · ${p.metric}` : ''}
              </Tooltip>
            </CircleMarker>
          ))}

          {/* HELCOM Baltic passage lines */}
          {vis.helcom && helcom.map((h, i) => <Polyline key={`hc-${i}`} positions={h.coords} pathOptions={{ color: C.helcom, weight: 3, opacity: 0.85 }}><Tooltip>{h.location || 'Passage line'} · {h.crossings.toLocaleString()} crossings · HELCOM</Tooltip></Polyline>)}
        </MapContainer>

        {/* ── Brand chip ── */}
        <motion.div {...mv(0)} style={{ position: 'absolute', top: 14, left: 14, zIndex: 520, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 13px', background: panelBg(), border: goldBorder(0.4) }}>
          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', color: GOLD }}>ENERGY FLOWS</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.positive, boxShadow: `0 0 7px ${C.positive}`, animation: reduced ? undefined : 'gfm-pulse 2.6s infinite' }} />
            <span style={{ fontFamily: MONO, fontSize: 9, color: SEC }}>LIVE · {vess.data?.count ?? 0} · {clock}</span>
          </span>
          <ShellActions />
        </motion.div>

        {/* ── Left column: view panel on top, legend pinned to the bottom.
             One flex column so the two can never overlap on short screens —
             each scrolls internally instead. ── */}
        <div className="gfm-left-rail" style={{ position: 'absolute', top: 62, left: 14, bottom: 14, zIndex: 520, width: 218, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
        <motion.div {...mv(0.05)} style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', pointerEvents: 'auto', background: panelBg(), border: neutralBorder }}>
          <div style={{ padding: '12px 14px 4px' }}>
            <div style={{ ...eyebrow, marginBottom: 6 }}>View</div>
            {PRESET_LABELS.map(p => {
              const on = preset === p.key
              return (
                <div key={p.key} className="gfm-row" onClick={() => { setPreset(p.key); setOverrides({}) }}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 9px', cursor: 'pointer', background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'transparent', borderLeft: on ? `2px solid ${GOLD}` : '2px solid transparent' }}>
                  <span style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: on ? 600 : 400, color: on ? TEXT : SEC }}>{p.view}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: on ? GOLD : MUTED }}>{counts[p.key]}</span>
                </div>
              )
            })}
          </div>
          <div style={{ height: 1, background: 'var(--theme-border-faint, rgba(255,255,255,0.06))', margin: '8px 14px' }} />
          <div style={{ padding: '4px 14px 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={eyebrow}>Fine tune</span>
              <span style={{ fontFamily: MONO, fontSize: 8, color: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 75%, transparent)' }}>Z+ zoom to reveal</span>
            </div>
            {([
              ['pipes', 'Pipelines', 'GEM'], ['terminals', 'Export terminals', ''],
              ['fieldsRef', 'Fields and refineries', 'Z+'], ['flares', 'Gas flaring', 'VIIRS'],
              ['wpi', 'World ports', 'Z+'], ['helcom', 'Baltic overlay', 'HELCOM'],
            ] as [FineKey, string, string][]).map(([fk, label, src]) => {
              const on = fineState(fk)
              return (
                <div key={fk} className="gfm-row" onClick={() => setOverrides(o => ({ ...o, [fk]: !on }))}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', cursor: 'pointer' }}>
                  <span style={{ width: 12, height: 12, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? GOLD : 'transparent', border: on ? `1px solid ${GOLD}` : '1px solid var(--theme-border, rgba(255,255,255,0.22))', color: 'var(--theme-bg, #101c2e)', fontSize: 9, fontWeight: 800 }}>{on ? '✓' : ''}</span>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: on ? TEXT : SEC }}>{label}</span>
                  <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 8, letterSpacing: '0.08em', color: src === 'Z+' ? GOLD : FAINT }}>{src}</span>
                </div>
              )
            })}
          </div>
        </motion.div>

        {legendGroups.length > 0 && (
          <div style={{ marginTop: 'auto', flex: '0 1 auto', minHeight: 0, overflowY: 'auto', pointerEvents: 'auto', padding: '10px 13px', background: panelBg(0.92), border: neutralBorder }}>
            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', color: TEXT, marginBottom: 7 }}>LEGEND</div>
            {legendGroups.map(g => (
              <div key={g.group} style={{ marginBottom: 7 }}>
                <div style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: MUTED, marginBottom: 3 }}>{g.group}</div>
                {g.items.map(it => (
                  <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: '16px' }}>
                    <span style={{ width: 20, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={it.glyph} /></span>
                    <span style={{ fontFamily: SANS, fontSize: 10.5, color: SEC }}>{it.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        </div>

        {/* ── Search command bar + mode pills (left offset clears the brand chip) ── */}
        <div className="gfm-search" style={{ position: 'absolute', top: 14, left: 348, right: 324, zIndex: 540, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <motion.div {...mv(0.1)} style={{ width: 'min(520px, 100%)', pointerEvents: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', background: panelBg(), border: goldBorder(0.4) }}>
            <span style={{ fontFamily: MONO, fontSize: 12, color: GOLD }}>&gt;</span>
            <input ref={searchRef} value={query}
              onChange={e => { setQuery(e.target.value); setSearchOpen(true); setSearchIdx(0) }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIdx(i => Math.min(i + 1, results.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIdx(i => Math.max(i - 1, 0)) }
                else if (e.key === 'Enter' && results[searchIdx]) pickResult(results[searchIdx])
              }}
              placeholder="Search ports, vessels, terminals"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontFamily: SANS, fontSize: 12.5, color: TEXT }} />
            <span style={{ fontFamily: MONO, fontSize: 9, color: SEC, border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', padding: '1px 6px' }}>/</span>
          </div>
          {searchOpen && results.length > 0 && (
            <div style={{ marginTop: 4, background: panelBg(0.96), border: neutralBorder, maxHeight: 280, overflowY: 'auto' }}>
              {results.map((e, i) => {
                const kindCol = e.kind === 'choke' ? GOLD : e.kind === 'vessel' ? C.tanker : e.kind === 'terminal' ? C.lngTerm : C.spark
                return (
                  <div key={`${e.kind}-${e.id}`} onMouseDown={() => pickResult(e)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 12px', cursor: 'pointer', background: i === searchIdx ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'transparent' }}>
                    <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: kindCol, border: `1px solid ${kindCol}`, padding: '1px 5px', flex: 'none' }}>{e.kind === 'choke' ? 'CHOKE' : e.kind.toUpperCase()}</span>
                    <span style={{ fontFamily: SANS, fontSize: 11.5, color: TEXT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
                    <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: SEC, flex: 'none' }}>{e.metric}</span>
                  </div>
                )
              })}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 9, marginTop: 9 }}>
            {PRESET_LABELS.map(p => {
              const on = preset === p.key
              return (
                <button key={p.key} onClick={() => { setPreset(p.key); setOverrides({}) }} style={{
                  fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', padding: '5px 13px', cursor: 'pointer',
                  background: on ? GOLD : panelBg(0.92), color: on ? 'var(--theme-bg, #0a0e16)' : SEC,
                  border: on ? `1px solid ${GOLD}` : '1px solid var(--theme-border, rgba(255,255,255,0.14))',
                }}>{p.pill}</button>
              )
            })}
          </div>
        </motion.div>
        </div>

        {/* ── Alert widgets + inspector (one column so heights never collide) ── */}
        <div className="gfm-right-rail" style={{ position: 'absolute', top: 14, right: 14, bottom: 14, zIndex: 530, width: 296, display: 'flex', flexDirection: 'column', gap: 7, pointerEvents: 'none' }}>
          {alerts.map((a, i) => {
            const congested = a.status === 'congested'
            const accent = congested ? C.negative : GOLD
            return (
              <motion.div key={a.id} {...mv(0.05 * i)} onClick={() => { const c = choke.data?.chokepoints.find(c => c.id === a.id); if (c) flyTo({ kind: 'choke', id: c.id, name: c.name, lat: c.lat, lon: c.lon }) }}
                style={{ padding: '9px 12px', background: panelBg(), borderTop: neutralBorder, borderRight: neutralBorder, borderBottom: neutralBorder, borderLeft: `2px solid ${accent}`, cursor: 'pointer', pointerEvents: 'auto', flex: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: accent }}>{a.name.replace('Strait of ', '').replace(' Strait', '').replace(' + SUMED', '').replace(' Canal', '').toUpperCase()} {congested ? 'CONGESTION' : 'FLOW'}</span>
                  <span style={{ fontFamily: MONO, fontSize: 9, color: MUTED }}>{a.as_of.slice(5)}</span>
                </div>
                <div style={{ fontFamily: SANS, fontSize: 11, color: SEC }}>
                  {a.anomaly === 'high' ? 'Transit count 2σ above 30d mean.'
                    : a.anomaly === 'low' ? 'Transit count 2σ below 30d mean.'
                    : `Transits ${(a.delta_pct ?? 0) >= 0 ? 'up' : 'down'} ${Math.abs(a.delta_pct ?? 0).toFixed(1)}% vs prior 7d.`}
                </div>
              </motion.div>
            )
          })}

        {/* ── Inspector ── */}
        {inspected && (
          <motion.div key={`${inspected.kind}-${inspected.id}`}
            initial={reduced ? false : { opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
            style={{ marginTop: 3, pointerEvents: 'auto', overflowY: 'auto', background: panelBg(0.96), border: goldBorder(0.4) }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 12px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
              <span style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: GOLD }}>Inspector</span>
              <button onClick={() => setInspected(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 12, color: MUTED }}>x</button>
            </div>
            <div style={{ padding: '12px 14px' }}>
              <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em', color: GOLD, border: goldBorder(0.4), padding: '2px 7px' }}>
                {inspected.kind === 'choke' ? 'CHOKEPOINT' : inspected.kind.toUpperCase()}
              </span>
              <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: TEXT, marginTop: 8 }}>{inspected.name}</div>
              <div style={{ fontFamily: SANS, fontSize: 10.5, color: SEC, marginTop: 2 }}>
                {Math.abs(inspected.lat).toFixed(2)}{inspected.lat >= 0 ? 'N' : 'S'} {Math.abs(inspected.lon).toFixed(2)}{inspected.lon >= 0 ? 'E' : 'W'}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 12 }}>
                {inspected.kind === 'flare' && (
                  <ObservationBoardPanel
                    compact
                    queryKey={['flaring-board', inspected.id, 60]}
                    fetcher={() => fetchFlaringBoard(inspected.id, 60)}
                    emptyLabel="Flaring board unavailable. The thermal feed did not return a usable series."
                    footnote={
                      'Radiant power summed over the field polygon. Burned gas, not production: ' +
                      'a rise can mean more drilling or less capacity to capture it. Days too ' +
                      'obscured to measure are held out rather than averaged in as low readings.'
                    }
                  />
                )}
                {inspected.kind === 'choke' && (
                  <>
                    <StatRow k="Oil transit" v={inspectedStat ? `${inspectedStat.oil_mbd.toFixed(1)} Mb/d` : '…'} />
                    <StatRow k="Share of seaborne oil" v={inspectedStat ? `${inspectedStat.share_pct}%` : '…'} />
                    <StatRow k="Vessels in strait" v={String(vesselsInStrait(inspected))} />
                    <StatRow k="Transits (7d avg)" v={inspectedStat ? `${inspectedStat.avg7.toFixed(1)}/d` : '…'} />
                    <StatRow k="Mix (latest day)" v={inspectedStat?.mix ? `${inspectedStat.mix.tanker ?? 0} tanker · ${inspectedStat.mix.cargo ?? 0} cargo` : '…'} />
                    {inspectedStat && (
                      <div style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', padding: '6px 8px' }}>
                        <Sparkline data={inspectedStat.series30} w={252} h={36} color={C.spark} />
                        <div style={{ fontFamily: MONO, fontSize: 8, color: MUTED, marginTop: 3 }}>TRANSIT CALLS · 30D · PORTWATCH</div>
                      </div>
                    )}
                    {inspectedStat?.anomaly && (
                      <div style={{ borderLeft: `2px solid ${GOLD}`, background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, transparent)', padding: '6px 9px', fontFamily: SANS, fontSize: 10.5, color: GOLD }}>
                        Transit count 2σ {inspectedStat.anomaly === 'high' ? 'above' : 'below'} 30d mean
                      </div>
                    )}
                    {inspectedStat?.nowcast && <NowcastBlock nc={inspectedStat.nowcast} C={C} />}
                    <StationBoardPanel chokepointId={inspected.id} />
                  </>
                )}
                {inspected.kind === 'vessel' && (
                  <>
                    <StatRow k="Type" v={VLABEL[inspectedVessel?.category ?? 'other']} />
                    <StatRow k="MMSI" v={inspected.id} />
                    <StatRow k="Destination" v={inspectedVessel?.destination || '—'} />
                    <StatRow k="Speed" v={inspectedVessel?.sog != null ? `${inspectedVessel.sog.toFixed(1)} kn` : '—'} />
                    <StatRow k="Heading" v={inspectedVessel?.heading != null && inspectedVessel.heading !== 511 ? `${inspectedVessel.heading}°` : inspectedVessel?.cog != null ? `COG ${inspectedVessel.cog.toFixed(0)}°` : '—'} />
                    <StatRow k="Updated" v={inspectedVessel?.time_utc ? formatLocalTime(inspectedVessel.time_utc) : '—'} />
                    <StatRow k="Source" v={inspectedVessel?.source === 'kystverket' ? 'Kystverket' : inspectedVessel?.source === 'vesselapi' ? 'VesselAPI' : 'AISStream'} />
                  </>
                )}
                {(inspected.kind === 'terminal' || inspected.kind === 'port' || inspected.kind === 'field') && (
                  <StatRow k={inspected.kind === 'field' ? 'Field' : 'Throughput'} v={inspected.metric || '—'} />
                )}
                {inspected.kind === 'port' && (
                  <ObservationBoardPanel
                    compact
                    queryKey={['port-board', inspected.id, 180]}
                    fetcher={() => fetchPortBoard(inspected.id, 180)}
                    emptyLabel="No port board. Dewey has no usable series for this port in the window."
                    footnote={
                      'Import and export are read separately, and throughput is never merged with ' +
                      'call count: more boxes on fewer ships is a different fact from a busier port.'
                    }
                  />
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                {inspected.kind === 'choke' ? (
                  <>
                    <button onClick={() => navigate('/settings?tab=alerts')} style={{ flex: 1, padding: 7, cursor: 'pointer', background: GOLD, color: 'var(--theme-bg, #0a0e16)', border: 'none', fontFamily: SANS, fontSize: 11, fontWeight: 600 }}>Set alert</button>
                    <button onClick={() => openHistoryFor(inspected.id)} style={{ flex: 1, padding: 7, cursor: 'pointer', background: 'transparent', color: GOLD, border: goldBorder(0.45), fontFamily: SANS, fontSize: 11, fontWeight: 600 }}>Open history</button>
                  </>
                ) : (
                  <button onClick={() => togglePin(inspected)} style={{ flex: 1, padding: 7, cursor: 'pointer', background: isPinned(inspected) ? GOLD : 'transparent', color: isPinned(inspected) ? 'var(--theme-bg, #0a0e16)' : GOLD, border: goldBorder(0.45), fontFamily: SANS, fontSize: 11, fontWeight: 600 }}>
                    {isPinned(inspected) ? 'Unpin callout' : 'Pin callout'}
                  </button>
                )}
                {inspected.kind === 'choke' && (
                  <button onClick={() => togglePin(inspected)} style={{ flex: 'none', padding: '7px 10px', cursor: 'pointer', background: 'transparent', color: isPinned(inspected) ? GOLD : SEC, border: neutralBorder, fontFamily: SANS, fontSize: 11, fontWeight: 600 }}>
                    {isPinned(inspected) ? 'Unpin' : 'Pin'}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
        </div>

        {/* ── Bottom chrome: scrubber + history center, replay right. Offset
             past the left column so it can never slide under the legend. ── */}
        <div className="gfm-bottom-chrome" style={{ position: 'absolute', left: 246, right: 14, bottom: 14, zIndex: 540, display: 'flex', alignItems: 'flex-end', gap: 10, pointerEvents: 'none' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        {histOpen && (
          <div style={{ width: 'min(1020px, 100%)', pointerEvents: 'auto' }}>
            <HistoryPanel C={C} chokepoints={choke.data?.chokepoints ?? []} ids={histIds} days={histDays} metric={histMetric}
              series={hist.data?.series ?? []} loading={hist.isLoading}
              nowcastMeta={hist.data?.nowcast_meta}
              liveNow={vesselsInStrait} aisLive={vess.data?.status?.connected ?? false}
              onToggleId={id => setHistIds(ids => ids.includes(id) ? (ids.length > 1 ? ids.filter(x => x !== id) : ids) : [...ids, id].slice(-4))}
              onDays={setHistDays} onMetric={setHistMetric} onClose={() => setHistOpen(false)} />
          </div>
        )}
        {replay.open && (
          <motion.div initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
            style={{ width: 'min(760px, 100%)', pointerEvents: 'auto', background: panelBg(0.96), border: goldBorder(0.4), padding: '10px 14px' }}>
            {frames.length < 2 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: SANS, fontSize: 11, color: SEC }}>Recording AIS history. The scrubber needs at least 20 minutes of samples, check back shortly.</span>
                <button className="gfm-chip" onClick={() => setReplay(r => ({ ...r, open: false, playing: false }))} style={{ background: 'transparent', border: neutralBorder, color: SEC, fontFamily: MONO, fontSize: 10, padding: '3px 9px', cursor: 'pointer' }}>Close</button>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <button onClick={() => setReplay(r => ({ ...r, playing: !r.playing, t: r.t >= 1 ? 0 : r.t }))}
                    style={{ width: 26, height: 26, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: GOLD, border: 'none' }}>
                    {replay.playing
                      ? <span style={{ display: 'flex', gap: 2 }}><span style={{ width: 3, height: 10, background: 'var(--theme-bg, #0a0e16)' }} /><span style={{ width: 3, height: 10, background: 'var(--theme-bg, #0a0e16)' }} /></span>
                      : <span style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: '8px solid var(--theme-bg, #0a0e16)' }} />}
                  </button>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: GOLD }}>
                    {replayVessels ? formatLocalTime(replayVessels.time, { timeZone: 'UTC' }) : 'REPLAY'}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 9, color: MUTED }}>{frames.length} frames · 10 min sampling</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {([1, 8, 32] as const).map(s => (
                      <button key={s} onClick={() => setReplay(r => ({ ...r, speed: s }))} style={{
                        fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '3px 8px', cursor: 'pointer',
                        background: replay.speed === s ? GOLD : 'transparent', color: replay.speed === s ? 'var(--theme-bg, #0a0e16)' : SEC,
                        border: replay.speed === s ? `1px solid ${GOLD}` : '1px solid var(--theme-border, rgba(255,255,255,0.14))',
                      }}>{s}×</button>
                    ))}
                    <button onClick={() => setReplay(r => ({ ...r, open: false, playing: false }))} style={{ fontFamily: MONO, fontSize: 10, padding: '3px 9px', cursor: 'pointer', background: 'transparent', color: MUTED, border: neutralBorder }}>x</button>
                  </span>
                </div>
                <input type="range" min={0} max={1000} value={Math.round(replay.t * 1000)}
                  onChange={e => setReplay(r => ({ ...r, t: Number(e.target.value) / 1000, playing: false }))}
                  style={{ width: '100%', accentColor: C.gold, height: 4 }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
                  {['-24H', '-18H', '-12H', '-6H', 'NOW'].map(t => <span key={t} style={{ fontFamily: MONO, fontSize: 8.5, color: MUTED }}>{t}</span>)}
                </div>
              </>
            )}
          </motion.div>
        )}
        </div>

        {!replay.open && (
          <button onClick={() => setReplay(r => ({ ...r, open: true, t: 1, playing: false }))}
            style={{ flex: 'none', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 13px', cursor: 'pointer', background: panelBg(), border: goldBorder(0.45) }}>
            <span style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: `8px solid ${GOLD}` }} />
            <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.14em', color: GOLD }}>REPLAY 24H</span>
          </button>
        )}
        </div>
      </div>

      {/* ── Docked chokepoint strip ── */}
      <div className="gfm-cp-strip" style={{ height: 46, flex: 'none', display: 'grid', gridTemplateColumns: `repeat(${STRIP_IDS.length}, 1fr)`, background: 'var(--theme-surface, #0d1826)', borderTop: goldBorder(0.3) }}>
        {STRIP_IDS.map((id, i) => {
          const s = statById.get(id)
          const c = choke.data?.chokepoints.find(c => c.id === id)
          const short = (s?.name ?? c?.name ?? id).replace('Strait of ', '').replace(' Strait', '').replace(' + SUMED', '').replace(' Canal', '').toUpperCase()
          const dotCol = s?.status === 'congested' ? C.negative : s?.status === 'watch' ? C.gold : MUTED
          return (
            <div key={id} onClick={() => { if (c) flyTo({ kind: 'choke', id: c.id, name: c.name, lat: c.lat, lon: c.lon }) }}
              className="gfm-row gfm-cpcell"
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px', cursor: 'pointer', borderLeft: i ? '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' : 'none', fontVariantNumeric: 'tabular-nums', minWidth: 0, whiteSpace: 'nowrap' }}>
              <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: TEXT, flex: 'none' }}>{short}</span>
              <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: TEXT, flex: 'none' }}>{c?.oil_mbd.toFixed(1) ?? '—'}</span>
              {s?.delta_pct != null && (
                <span className="gfm-delta" style={{ fontFamily: MONO, fontSize: 9.5, color: s.delta_pct >= 0 ? C.positive : C.negative, flex: 'none' }}>
                  {s.delta_pct >= 0 ? '+' : ''}{s.delta_pct.toFixed(1)}%
                </span>
              )}
              {s && <span className="gfm-transits" style={{ fontFamily: MONO, fontSize: 9, color: MUTED, flex: 'none' }}>{s.transits7}t</span>}
              <span className={short.length > 8 ? 'gfm-spark gfm-spark-long' : 'gfm-spark'} style={{ marginLeft: 'auto', flex: 'none' }}>{s && <Sparkline data={s.series30} color={C.spark} />}</span>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotCol, flex: 'none', marginLeft: 'auto' }} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ fontFamily: SANS, fontSize: 11, color: SEC }}>{k}</span>
      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: TEXT, textAlign: 'right' }}>{v}</span>
    </div>
  )
}

// Live AIS nowcast that bridges PortWatch's 3-4 day reporting lag. Additive: it sits
// below the PortWatch stats and never replaces them.
function NowcastBlock({ nc, C }: { nc: Nowcast; C: Colors }) {
  const conf = nc.confidence
  const confColor = conf === 'high' ? C.positive : conf === 'medium' ? GOLD
    : conf === 'stale' ? C.negative : MUTED
  const vs = nc.live_vs_baseline_pct
  const capM = nc.capacity_est_dwt != null ? (nc.capacity_est_dwt / 1e6).toFixed(1) : null
  return (
    <div style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', padding: '7px 9px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: MUTED }}>LIVE AIS NOWCAST · 96H</span>
        <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', color: confColor, border: `1px solid ${confColor}`, padding: '1px 5px', textTransform: 'uppercase' }}>{conf}</span>
      </div>
      {conf === 'none' ? (
        <div style={{ fontFamily: SANS, fontSize: 10, color: MUTED }}>No live AIS coverage for this chokepoint.</div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 10.5, color: TEXT }}>
            <span>{nc.calls_per_day_live.toFixed(2)}/d live</span>
            {vs != null && <span style={{ color: vs >= 0 ? C.positive : C.negative }}>{vs >= 0 ? '+' : ''}{vs.toFixed(1)}% vs PortWatch</span>}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: MUTED, marginTop: 3 }}>
            {nc.calls_96h} crossings{capM ? ` · ~${capM}M t transited (est)` : ''}
          </div>
          <div style={{ fontFamily: SANS, fontSize: 8.5, color: FAINT, marginTop: 4 }}>
            Capacity is a draught-based estimate, not manifest tonnage.{nc.as_of ? ` Last ${formatLocalTime(nc.as_of)}.` : ''}
          </div>
        </>
      )}
    </div>
  )
}

// ── Chokepoint transit history (IMF PortWatch) ───────────────────────────────
const HIST_RANGES = [{ label: '1M', d: 30 }, { label: '3M', d: 90 }, { label: '6M', d: 180 }, { label: '1Y', d: 365 }, { label: '2Y', d: 730 }]
const HIST_METRICS: { k: HistMetric; label: string }[] = [
  { k: 'total', label: 'All vessels' }, { k: 'tanker', label: 'Tankers' }, { k: 'cargo', label: 'Cargo ships' }, { k: 'cap', label: 'Capacity (dwt)' },
]

const fmtVal = (v: number | null, metric: HistMetric) =>
  v == null ? '—' : metric === 'cap' ? (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1e3).toFixed(0)}k`) : `${Math.round(v)}`

const chipBtn = (on: boolean, color?: string): React.CSSProperties => ({
  padding: '4px 9px', cursor: 'pointer', background: 'transparent',
  border: `1px solid ${on ? (color || 'var(--theme-primary)') : 'var(--theme-border)'}`,
  color: on ? (color || 'var(--theme-primary)') : 'var(--theme-secondary)',
  fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
})

function HistoryPanel({ C, chokepoints, ids, days, metric, series, loading, nowcastMeta, liveNow, aisLive, onToggleId, onDays, onMetric, onClose }: {
  C: Colors; chokepoints: Chokepoint[]; ids: string[]; days: number; metric: HistMetric
  series: HistSeries[]; loading: boolean
  nowcastMeta?: { window_h: number; as_of: string | null }
  liveNow: (c: { lat: number; lon: number }) => number; aisLive: boolean
  onToggleId: (id: string) => void; onDays: (d: number) => void; onMetric: (m: HistMetric) => void; onClose: () => void
}) {
  const palette = [C.gold, C.lane, C.oilTerm, C.lngTerm, C.field, C.wind]
  const colorOf = (id: string) => palette[ids.indexOf(id) % palette.length]

  const { rows, summaries } = useMemo(() => {
    const byDate: Record<string, Record<string, number | string | null>> = {}
    const summaries: { id: string; name: string; last: number | null; delta: number | null; peak: number | null; low: number | null; liveAvailable: boolean }[] = []
    for (const s of series) {
      const vals = s.points.map(p => p[metric])
      const ma: (number | null)[] = s.points.map((_, i) => {
        const win = vals.slice(Math.max(0, i - 6), i + 1).filter((v): v is number => v != null)
        return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null
      })
      s.points.forEach((p, i) => { (byDate[p.d] ??= { d: p.d })[s.id] = ma[i] })
      const smoothed = ma.slice(6).filter((v): v is number => v != null)
      const first = smoothed[0], last = smoothed[smoothed.length - 1]
      const counts = s.nowcast_daily ?? {}
      const totalCrossings = Object.values(counts).reduce((sum, v) => sum + v.total, 0)
      if (s.nowcast_days?.length && last != null && totalCrossings > 0) {
        const lastD = s.points[s.points.length - 1]?.d
        const key: keyof HistNowcastPoint = metric === 'cap' ? 'cap' : metric
        const prior = Object.entries(counts)
          .filter(([day, v]) => day <= (lastD ?? '') && v[key] > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(-7)
          .map(([, v]) => v[key])
        // A newly deployed stream may begin after PortWatch's last confirmed day,
        // leaving no overlap yet. Use observed post-gap AIS days as a bounded
        // temporary anchor so the chart is live from day one, then automatically
        // switch to the stronger overlap calibration once seven days accumulate.
        const observed = Object.values(counts).map(v => v[key]).filter(v => v > 0)
        const reference = prior.length ? prior : observed
        const scale = reference.length ? last / (reference.reduce((a, b) => a + b, 0) / reference.length) : null
        const hasOverlap = prior.length > 0
        if (lastD && scale != null) (byDate[lastD] ??= { d: lastD })[`${s.id}__est`] = last
        for (const day of s.nowcast_days) {
          if (scale == null) continue
          const window = Object.entries(counts).filter(([d]) => d <= day).sort(([a], [b]) => a.localeCompare(b)).slice(-7).map(([, v]) => v[key])
          if (!window.length || window.every(v => v === 0)) continue
          const raw = (window.reduce((a, b) => a + b, 0) / window.length) * scale
          const estimated = hasOverlap ? raw : Math.max(last * 0.8, Math.min(last * 1.2, raw))
          ;(byDate[day] ??= { d: day })[`${s.id}__est`] = Math.round(estimated * 10) / 10
        }
      }
      summaries.push({
        id: s.id, name: s.name,
        last: last ?? null,
        delta: first && last != null ? ((last - first) / first) * 100 : null,
        peak: smoothed.length ? Math.max(...smoothed) : null,
        low: smoothed.length ? Math.min(...smoothed) : null,
        liveAvailable: Boolean(s.nowcast_days?.length && totalCrossings > 0),
      })
    }
    const rows = Object.values(byDate).sort((a, b) => String(a.d).localeCompare(String(b.d))).slice(6)
    return { rows, summaries }
  }, [series, metric])

  const confirmedDates = series.flatMap(s => s.points.map(p => p.d)).sort()
  const latestDate = confirmedDates.length ? confirmedDates[confirmedDates.length - 1] : null
  const hasLiveTail = summaries.some(s => s.liveAvailable)

  return (
    <div style={{ background: 'var(--theme-surface)', border: goldBorder(0.4) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', background: 'rgba(0,0,0,0.16)', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
        <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--theme-primary)' }}>Chokepoint Transit History</span>
        <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-faint)' }}>IMF PortWatch, 7-day average of daily transit calls</span>
        {latestDate && (
          <span title="The last confirmed PortWatch observation. The dotted AIS tail continues from this point when coverage is available."
            style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary)' }}>
            confirmed {latestDate}
          </span>
        )}
        {hasLiveTail && (
          <span title="The dotted tail uses a 14-day AIS crossing window, calibrated to the last confirmed PortWatch seven-day average. It is an estimate, not a PortWatch count."
            style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-positive, #3fb950)' }}>
            · · · live AIS tail {nowcastMeta?.as_of ? `through ${nowcastMeta.as_of}` : ''}
          </span>
        )}
        {!hasLiveTail && (
          <span title="No recent classified AIS crossings are available for this selection. Confirmed PortWatch history remains visible."
            style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary)' }}>
            live AIS data unavailable
          </span>
        )}
        <button className="gfm-chip" onClick={onClose} style={{ ...chipBtn(false), marginLeft: 'auto' }}>Close</button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '10px 14px 0' }}>
        {chokepoints.map(c => <button key={c.id} className="gfm-chip" onClick={() => onToggleId(c.id)} style={chipBtn(ids.includes(c.id), ids.includes(c.id) ? colorOf(c.id) : undefined)}>{c.name}</button>)}
        <span style={{ flex: 'none', width: 1, height: 18, background: 'var(--theme-border)', margin: '0 6px' }} />
        {HIST_RANGES.map(r => <button key={r.label} className="gfm-chip" onClick={() => onDays(r.d)} style={chipBtn(days === r.d)}>{r.label}</button>)}
        <span style={{ flex: 'none', width: 1, height: 18, background: 'var(--theme-border)', margin: '0 6px' }} />
        {HIST_METRICS.map(m => <button key={m.k} className="gfm-chip" onClick={() => onMetric(m.k)} style={chipBtn(metric === m.k)}>{m.label}</button>)}
      </div>

      <div style={{ height: 200, padding: '10px 14px 0' }}>
        {loading ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-secondary)' }}>Loading transit history…</div>
        ) : rows.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-secondary)' }}>Data unavailable. PortWatch returned no history for this selection.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--theme-border-faint, rgba(255,255,255,0.05))" vertical={false} />
              <XAxis dataKey="d" tick={{ fill: 'var(--theme-secondary)', fontSize: 9.5, fontFamily: 'var(--theme-mono)' }}
                tickFormatter={(d: string) => days >= 365 ? d.slice(0, 7) : d.slice(5)} minTickGap={42} axisLine={{ stroke: 'var(--theme-border)' }} tickLine={false} />
              <YAxis tick={{ fill: 'var(--theme-secondary)', fontSize: 9.5, fontFamily: 'var(--theme-mono)' }} width={44}
                tickFormatter={(v: number) => fmtVal(v, metric)} domain={['auto', 'auto']} axisLine={false} tickLine={false} />
              <ChartTip
                contentStyle={{ ...TOOLTIP_STYLE }}
                labelStyle={{ color: 'var(--theme-text)' }}
                formatter={(v: number, name: string) => [fmtVal(v, metric), series.find(s => s.id === name)?.name ?? name]} />
              {ids.map(id => <Line isAnimationActive={false} key={id} type="monotone" dataKey={id} stroke={colorOf(id)} strokeWidth={1.8} dot={false}
                strokeDasharray={['', '7 3', '2 3', '9 3 2 3'][ids.indexOf(id) % 4] || ''} />)}
              {/* The estimate tail keeps connectNulls on purpose. It is drawn dashed and
                  at reduced opacity precisely to say "not a confirmed reading", and the
                  backend already withholds it entirely when the AIS feed is dark, so it
                  can never bridge a window nothing was observed in. The confirmed series
                  above breaks at gaps like every other time axis in the app. */}
              {ids.map(id => <Line isAnimationActive={false} key={`${id}__est`} type="monotone" dataKey={`${id}__est`} stroke={colorOf(id)} strokeOpacity={0.7} strokeWidth={1.6} dot={false} connectNulls strokeDasharray="1 4" />)}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, padding: '10px 14px 12px' }}>
        {summaries.map(s => {
          const cp = chokepoints.find(c => c.id === s.id)
          return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ width: 10, height: 10, background: colorOf(s.id), alignSelf: 'center', flex: 'none' }} />
            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text)' }}>{s.name}</span>
            {s.last == null ? (
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary)' }}>data unavailable</span>
            ) : <>
            <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, fontWeight: 700, color: 'var(--theme-text)' }}>{fmtVal(s.last, metric)}<span style={{ fontSize: 9, color: 'var(--theme-secondary)', fontWeight: 400 }}>{metric === 'cap' ? ' dwt/d' : '/d'}</span></span>
            {s.delta != null && (
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: s.delta >= 0 ? 'var(--theme-positive, #3fb950)' : 'var(--theme-negative, #f85149)' }}>
                {s.delta >= 0 ? '↑' : '↓'} {Math.abs(s.delta).toFixed(1)}%
              </span>
            )}
            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9.5, color: 'var(--theme-text-faint)' }}>range {fmtVal(s.low, metric)}-{fmtVal(s.peak, metric)}</span>
            </>}
            {!s.liveAvailable && (
              <span title="No recent classified AIS crossings are available for this chokepoint, so a live estimate cannot be drawn."
                style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary)' }}>live AIS data unavailable</span>
            )}
            {aisLive && cp && (
              <span title="Vessels within ~1.5° of the chokepoint right now, from the live AIS stream. A real-time presence snapshot, not a PortWatch transit count."
                style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary)' }}>
                <span style={{ fontSize: 7.5, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--theme-positive, #3fb950)', border: '1px solid color-mix(in srgb, var(--theme-positive, #3fb950) 45%, transparent)', padding: '0 3px' }}>LIVE</span>
                {liveNow(cp)} in strait now
              </span>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}

export default function MaritimeMap() {
  return <PageWrapper><MaritimeMapContent /></PageWrapper>
}
