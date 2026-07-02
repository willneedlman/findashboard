import { Fragment, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { MapContainer, Polyline, CircleMarker, Marker, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import PageWrapper from '../components/PageWrapper'
import { readToken } from '../lib/theme'

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
  }
}

const VLABEL: Record<string, string> = { tanker: 'Crude Tanker', lng: 'LNG / Gas Carrier', cargo: 'Cargo / Dry Bulk', other: 'Vessel' }
const DETAIL_MIN_ZOOM = 5

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
const arrowIcon = (color: string, heading: number, s = 9) => L.divIcon({
  className: '', iconSize: [s + 4, s + 4], iconAnchor: [(s + 4) / 2, (s + 4) / 2],
  html: `<div style="width:${s + 4}px;height:${s + 4}px;transform:rotate(${heading}deg);display:flex;align-items:center;justify-content:center;"><div style="width:0;height:0;border-left:${s * 0.4}px solid transparent;border-right:${s * 0.4}px solid transparent;border-bottom:${s}px solid ${color};filter:drop-shadow(0 0 1.5px ${color});"></div></div>`,
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
interface Facility { n: string; la: number; lo: number; k: string; x?: string | number }
interface OsmPort { name: string; lat: number; lon: number; kind: string }
interface EmodFeat { kind: string; n: string; coords?: [number, number][]; la?: number; lo?: number }
interface HelcomFeat { coords: [number, number][]; location: string; crossings: number }

type LayerKey = 'tanker' | 'lng' | 'cargo' | 'pGem' | 'pEia' | 'pOsm' | 'pEmod' | 'terminals' | 'lngTerm' | 'fields' | 'refineries' | 'power' | 'coal' | 'wpi' | 'chokepoints' | 'helcom'

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

// ── Rail/legend glyphs (match map symbology) ─────────────────────────────────
const gArrow = (c: string): React.CSSProperties => ({ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderBottom: `11px solid ${c}` })
const gLine = (c: string, dash = false): React.CSSProperties => ({ width: 18, height: 0, borderTop: `2px ${dash ? 'dashed' : 'solid'} ${c}` })
const gDot = (c: string): React.CSSProperties => ({ width: 10, height: 10, borderRadius: '50%', background: c })
const gRing = (c: string): React.CSSProperties => ({ width: 11, height: 11, borderRadius: '50%', border: `2px solid ${c}` })
const gDiamond = (c: string): React.CSSProperties => ({ width: 9, height: 9, background: c, transform: 'rotate(45deg)' })
const gDiamondO = (c: string): React.CSSProperties => ({ width: 9, height: 9, border: `1.5px solid ${c}`, transform: 'rotate(45deg)' })
const gSquare = (c: string): React.CSSProperties => ({ width: 10, height: 10, background: c })
const gSquareO = (c: string): React.CSSProperties => ({ width: 10, height: 10, border: `1.5px solid ${c}` })

const railLabel: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--theme-secondary)' }
const srcTag: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 8.5, letterSpacing: '0.08em', color: 'var(--theme-text-faint)', marginLeft: 'auto' }

function Toggle({ glyph, label, on, src, onToggle }: { glyph: React.CSSProperties; label: string; on: boolean; src?: string; onToggle: () => void }) {
  return (
    <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', cursor: 'pointer' }}>
      <span style={{ width: 15, height: 15, borderRadius: 2, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${on ? 'var(--theme-primary)' : 'var(--theme-border)'}`, background: on ? 'var(--theme-primary)' : 'transparent', color: 'var(--theme-bg)', fontSize: 11, fontWeight: 800 }}>{on ? '✓' : ''}</span>
      <span style={{ width: 22, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={glyph} /></span>
      <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: on ? 'var(--theme-text)' : 'var(--theme-secondary)' }}>{label}</span>
      {src && <span style={srcTag}>{src}</span>}
    </div>
  )
}

export function MaritimeMapContent() {
  const [C, setC] = useState<Colors>(buildColors)
  useEffect(() => {
    const rc = () => setC(buildColors())
    rc()
    const mo = new MutationObserver(rc)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => mo.disconnect()
  }, [])

  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({
    tanker: true, lng: true, cargo: true, pGem: true, pEia: false, pOsm: false, pEmod: false,
    terminals: true, lngTerm: true, fields: true, refineries: false, power: false, coal: false,
    wpi: false, chokepoints: true, helcom: false,
  })
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom: number } | null>(null)
  const [view, setView] = useState<{ bbox: string; zoom: number } | null>(null)
  const [gemPipes, setGemPipes] = useState<Pipeline[]>([])
  const [eiaPipes, setEiaPipes] = useState<Pipeline[]>([])
  const [osmPipes, setOsmPipes] = useState<Pipeline[]>([])
  const [osmPlatforms, setOsmPlatforms] = useState<OsmPort[]>([])
  const [emod, setEmod] = useState<EmodFeat[]>([])
  const [fac, setFac] = useState<Facility[]>([])
  const [wpiPorts, setWpiPorts] = useState<WpiPort[]>([])
  const [helcom, setHelcom] = useState<HelcomFeat[]>([])
  const toggle = (k: LayerKey) => setLayers(s => ({ ...s, [k]: !s[k] }))

  const anyFac = layers.fields || layers.refineries || layers.power || layers.coal

  const VCOLOR = useMemo<Record<string, string>>(() => ({ tanker: C.tanker, lng: C.lng, cargo: C.cargo, other: C.cargo }), [C])
  const GLYPH = useMemo<Record<LayerKey, React.CSSProperties>>(() => ({
    tanker: gArrow(C.tanker), lng: gArrow(C.lng), cargo: gArrow(C.cargo),
    pGem: gLine(C.gold), pEia: gLine(C.gold), pOsm: gLine(C.gold), pEmod: gLine(C.gold),
    terminals: gDot(C.oilTerm), lngTerm: gRing(C.lngTerm), fields: gDiamond(C.field),
    refineries: gSquare(C.refinery), power: gDot(C.power), coal: gSquare(C.coal),
    wpi: gSquareO(C.wpi), chokepoints: gRing(C.gold), helcom: gLine(C.helcom),
  }), [C])

  useEffect(() => {
    if (!view) return
    const { bbox, zoom } = view
    const t = setTimeout(() => {
      if (layers.pGem) axios.get(zoom < 4 ? '/api/maritime/pipelines?source=gem' : `/api/maritime/pipelines?source=gem&bbox=${bbox}`).then(r => setGemPipes(r.data.pipelines || [])).catch(() => {})
      if (layers.pEia && zoom >= DETAIL_MIN_ZOOM) axios.get(`/api/maritime/pipelines?source=eia&bbox=${bbox}`).then(r => setEiaPipes(r.data.pipelines || [])).catch(() => {})
      if (layers.pOsm && zoom >= DETAIL_MIN_ZOOM) {
        axios.get(`/api/maritime/pipelines?source=osm&bbox=${bbox}`).then(r => setOsmPipes(r.data.pipelines || [])).catch(() => {})
        axios.get(`/api/maritime/ports?bbox=${bbox}`).then(r => setOsmPlatforms((r.data.osm_ports || []).filter((p: OsmPort) => p.kind === 'platform'))).catch(() => {})
      }
      if (layers.pEmod) axios.get(`/api/maritime/emodnet?bbox=${bbox}`).then(r => setEmod(r.data.features || [])).catch(() => {})
      if (anyFac) axios.get(zoom < 4 ? '/api/maritime/facilities' : `/api/maritime/facilities?bbox=${bbox}`).then(r => setFac(r.data.facilities || [])).catch(() => {})
      if (layers.wpi) axios.get(`/api/maritime/world-ports?bbox=${bbox}`).then(r => setWpiPorts(r.data.ports || [])).catch(() => {})
      if (layers.helcom) axios.get(`/api/maritime/helcom?bbox=${bbox}`).then(r => setHelcom(r.data.features || [])).catch(() => {})
    }, 450)
    return () => clearTimeout(t)
  }, [view, layers.pGem, layers.pEia, layers.pOsm, layers.pEmod, anyFac, layers.wpi, layers.helcom])

  useEffect(() => { if (!layers.pGem) setGemPipes([]) }, [layers.pGem])
  useEffect(() => { if (!layers.pEia) setEiaPipes([]) }, [layers.pEia])
  useEffect(() => { if (!layers.pOsm) { setOsmPipes([]); setOsmPlatforms([]) } }, [layers.pOsm])
  useEffect(() => { if (!layers.pEmod) setEmod([]) }, [layers.pEmod])
  useEffect(() => { if (!anyFac) setFac([]) }, [anyFac])
  useEffect(() => { if (!layers.wpi) setWpiPorts([]) }, [layers.wpi])
  useEffect(() => { if (!layers.helcom) setHelcom([]) }, [layers.helcom])

  const choke = useQuery<{ chokepoints: Chokepoint[] }>({ queryKey: ['mar-choke'], queryFn: () => axios.get('/api/maritime/chokepoints').then(r => r.data), staleTime: Infinity })
  const terms = useQuery<{ ports: Port[] }>({ queryKey: ['mar-terms'], queryFn: () => axios.get('/api/maritime/ports').then(r => r.data), staleTime: Infinity })
  const lngQ = useQuery<{ lng: LngTerm[] }>({ queryKey: ['mar-lng'], queryFn: () => axios.get('/api/maritime/lng').then(r => r.data), staleTime: Infinity })
  const vess = useQuery<{ vessels: Vessel[]; count: number; status: { key_present: boolean; connected: boolean } }>({
    queryKey: ['mar-vessels'], queryFn: () => axios.get('/api/maritime/vessels').then(r => r.data), refetchInterval: 12000, staleTime: 8000,
  })

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

  const catShown = (c?: string) => c === 'lng' ? layers.lng : c === 'cargo' ? layers.cargo : c === 'tanker' ? layers.tanker : layers.cargo
  const vessels = cull((vess.data?.vessels ?? []).filter(v => catShown(v.category)), v => v.lat, v => v.lon, 350)
  const facBy = (k: string) => cull(fac.filter(f => f.k === k), f => f.la, f => f.lo, 300)
  const refs = cull(fac.filter(f => f.k === 'refinery' || f.k === 'processing'), f => f.la, f => f.lo, 300)
  const wpiShown = cull(wpiPorts, p => p.la, p => p.lo, 600)
  const platformsShown = cull(osmPlatforms, p => p.lat, p => p.lon, 300)
  const emodPlatforms = cull(emod.filter(f => f.kind === 'platform' && f.la != null), f => f.la!, f => f.lo!, 300)
  const emodWind = cull(emod.filter(f => f.kind === 'windfarm' && f.la != null), f => f.la!, f => f.lo!, 300)
  const pipeStyle = (sub: string) => ({ color: C.gold, weight: 2, opacity: 0.9, dashArray: sub === 'gas' ? '6 6' : undefined })

  const legend = buildLegend(layers, C)

  return (
    <div style={{ display: 'flex', gap: 14, height: '78vh', minHeight: 640 }}>
      <style>{`
        .gfm-map { background: var(--theme-bg); }
        .flow-lane { stroke-dasharray: 3 9; animation: gfm-flow 1.4s linear infinite; }
        @keyframes gfm-flow { to { stroke-dashoffset: -12; } }
        .choke-pulse { animation: gfm-pulse 2.6s ease-in-out infinite; }
        @keyframes gfm-pulse { 0%,100% { opacity: .9 } 50% { opacity: .35 } }
        @media (prefers-reduced-motion: reduce) { .flow-lane, .choke-pulse { animation: none !important; } }
        .leaflet-popup-content-wrapper, .leaflet-popup-tip, .leaflet-tooltip {
          background: var(--theme-surface); color: var(--theme-text); border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent); border-radius: 2px; box-shadow: 0 8px 26px rgba(0,0,0,0.6);
        }
        .leaflet-popup-content { margin: 10px 12px; }
        .leaflet-tooltip { font-family: var(--theme-sans); font-size: 11px; box-shadow: none; }
        .leaflet-tooltip-top:before { border-top-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-tooltip-bottom:before { border-bottom-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-tooltip-left:before { border-left-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-tooltip-right:before { border-right-color: color-mix(in srgb, var(--theme-primary) 30%, transparent); }
        .leaflet-container a.leaflet-popup-close-button { color: var(--theme-secondary); }
        .leaflet-bar a, .leaflet-bar a:hover { width: 28px; height: 28px; line-height: 28px; background: var(--theme-surface); color: var(--theme-text); border-color: color-mix(in srgb, var(--theme-primary) 28%, transparent); }
        .leaflet-bar a:hover { background: var(--theme-hover); color: var(--theme-primary); }
        .leaflet-control-attribution { background: color-mix(in srgb, var(--theme-bg) 72%, transparent) !important; color: var(--theme-secondary) !important; font-size: 9px; }
        .leaflet-control-attribution a { color: var(--theme-primary) !important; }
      `}</style>

      {/* Control rail */}
      <div style={{ width: 252, flex: 'none', display: 'flex', flexDirection: 'column', background: 'var(--theme-surface)', border: '1px solid var(--theme-border)', overflowY: 'auto' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--theme-border-faint)' }}>
          <div style={{ ...railLabel, marginBottom: 8 }}>Jump To</div>
          <select value="" onChange={e => {
            const id = e.target.value
            if (id === 'global') { setFocus({ lat: 24, lon: 40, zoom: 2.4 }); return }
            const c = choke.data?.chokepoints.find(x => x.id === id)
            if (c) setFocus({ lat: c.lat, lon: c.lon, zoom: 6 })
          }} style={{ width: '100%', background: 'var(--theme-bg)', color: 'var(--theme-text)', border: '1px solid var(--theme-border)', fontFamily: 'var(--theme-sans)', fontSize: 12, padding: '7px 8px' }}>
            <option value="" disabled>Select…</option>
            <option value="global">Global view</option>
            {choke.data?.chokepoints.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <RailSection label="Live Vessels" note="AISStream · Kystverket (NO) · VesselAPI">
          <Toggle glyph={GLYPH.tanker} label="Crude tankers" on={layers.tanker} onToggle={() => toggle('tanker')} />
          <Toggle glyph={GLYPH.lng} label="LNG carriers" on={layers.lng} onToggle={() => toggle('lng')} />
          <Toggle glyph={GLYPH.cargo} label="Cargo / dry bulk" on={layers.cargo} onToggle={() => toggle('cargo')} />
        </RailSection>

        <RailSection label="Pipelines">
          <Toggle glyph={GLYPH.pGem} label="Global pipelines" src="GEM" on={layers.pGem} onToggle={() => toggle('pGem')} />
          <Toggle glyph={GLYPH.pEia} label="US pipelines" src="EIA" on={layers.pEia} onToggle={() => toggle('pEia')} />
          <Toggle glyph={GLYPH.pOsm} label="OSM infrastructure" src="OSM" on={layers.pOsm} onToggle={() => toggle('pOsm')} />
          <Toggle glyph={GLYPH.pEmod} label="EU offshore" src="EMODnet" on={layers.pEmod} onToggle={() => toggle('pEmod')} />
        </RailSection>

        <RailSection label="Facilities">
          <Toggle glyph={GLYPH.terminals} label="Export terminals" src="Curated" on={layers.terminals} onToggle={() => toggle('terminals')} />
          <Toggle glyph={GLYPH.lngTerm} label="LNG terminals" src="GEM" on={layers.lngTerm} onToggle={() => toggle('lngTerm')} />
          <Toggle glyph={GLYPH.fields} label="Oil & gas fields" src="GEM" on={layers.fields} onToggle={() => toggle('fields')} />
          <Toggle glyph={GLYPH.refineries} label="Refineries" src="NETL" on={layers.refineries} onToggle={() => toggle('refineries')} />
          <Toggle glyph={GLYPH.power} label="Power plants" src="GEM" on={layers.power} onToggle={() => toggle('power')} />
          <Toggle glyph={GLYPH.coal} label="Coal terminals" src="GEM" on={layers.coal} onToggle={() => toggle('coal')} />
        </RailSection>

        <RailSection label="Ports & Chokepoints">
          <Toggle glyph={GLYPH.wpi} label="World ports" src="WPI" on={layers.wpi} onToggle={() => toggle('wpi')} />
          <Toggle glyph={GLYPH.chokepoints} label="Chokepoints" on={layers.chokepoints} onToggle={() => toggle('chokepoints')} />
        </RailSection>

        <RailSection label="Overlays">
          <Toggle glyph={GLYPH.helcom} label="Baltic shipping" src="HELCOM" on={layers.helcom} onToggle={() => toggle('helcom')} />
        </RailSection>

        <div style={{ marginTop: 'auto', padding: '14px 18px', borderTop: '1px solid var(--theme-border-faint)' }}>
          <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 22, fontWeight: 700, color: 'var(--theme-text)' }}>{vess.data?.count ?? 0}</div>
          <div style={{ ...railLabel, marginTop: 2 }}>Vessels Live</div>
          <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-text-faint)', marginTop: 6, lineHeight: '14px' }}>18 feeds · AIS, pipelines, facilities, ports & shipping context</div>
        </div>
      </div>

      {/* Map panel */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative', border: '1px solid var(--theme-border)', overflow: 'hidden' }}>
        <MapContainer className="gfm-map" center={[24, 40]} zoom={2.4} minZoom={2} maxZoom={6} worldCopyJump preferCanvas
          maxBounds={[[-78, -200], [86, 220]]} maxBoundsViscosity={0.7} style={{ position: 'absolute', inset: 0, background: C.ocean }}>
          <VectorBasemap land={C.land} coast={C.coast} />
          <SizeFix />
          <FocusController focus={focus} />
          <ViewportWatcher onChange={(bbox, zoom) => setView({ bbox, zoom })} />

          {/* Shipping lanes (grouped under vessel toggles) */}
          {LANES.filter(l => layers[l.type]).map((l, i) => (
            <Polyline key={`lane-${i}`} positions={l.pts} pathOptions={{ color: C.lane, weight: 1.4, opacity: 0.5, className: 'flow-lane' }} />
          ))}

          {/* Pipelines: glow + core (gas dashed) */}
          {[layers.pGem && gemPipes, layers.pEia && eiaPipes, layers.pOsm && osmPipes, layers.pEmod && emod.filter(f => f.kind === 'pipeline').map(f => ({ name: f.n, substance: 'oil', coords: f.coords! }))]
            .filter(Boolean).flatMap((arr, gi) => (arr as Pipeline[]).map((p, i) => (
              <Fragment key={`pg-${gi}-${i}`}>
                {(view?.zoom ?? 2) >= 5 && <Polyline positions={p.coords} pathOptions={{ color: C.gold, weight: 6, opacity: 0.1 }} />}
                <Polyline positions={p.coords} pathOptions={pipeStyle(p.substance)}>
                  <Tooltip sticky>{p.name} · {p.substance === 'gas' ? 'Natural gas' : 'Crude oil'}</Tooltip>
                </Polyline>
              </Fragment>
            )))}

          {/* Offshore platforms (OSM + EMODnet) + wind farms (EMODnet) */}
          {layers.pOsm && platformsShown.map((p, i) => <Marker key={`osmp-${i}`} position={[p.lat, p.lon]} icon={platformIcon(C.gold)}><Tooltip>{p.name} · Offshore platform · OSM</Tooltip></Marker>)}
          {layers.pEmod && emodPlatforms.map((f, i) => <Marker key={`emp-${i}`} position={[f.la!, f.lo!]} icon={platformIcon(C.gold)}><Tooltip>{f.n} · platform · EMODnet</Tooltip></Marker>)}
          {layers.pEmod && emodWind.map((f, i) => <CircleMarker key={`emw-${i}`} center={[f.la!, f.lo!]} radius={4} pathOptions={{ color: C.wind, weight: 1.5, fillOpacity: 0 }}><Tooltip>{f.n} · wind farm · EMODnet</Tooltip></CircleMarker>)}

          {/* Vessels — heading arrows + telemetry popup */}
          {vessels.map(v => {
            const cat = v.category ?? 'other'
            const hd = v.heading != null && v.heading !== 511 ? v.heading : (v.cog ?? 0)
            return (
              <Marker key={`v-${v.mmsi}`} position={[v.lat, v.lon]} icon={arrowIcon(VCOLOR[cat] ?? C.cargo, hd, 9)}>
                <Popup>
                  <div style={{ fontFamily: 'var(--theme-mono, monospace)', fontSize: 12, minWidth: 200 }}>
                    <div style={{ fontWeight: 700, color: VCOLOR[cat] ?? 'var(--theme-text)', marginBottom: 6 }}>{v.name || `MMSI ${v.mmsi}`}</div>
                    <Row k="Type" v={VLABEL[cat]} /><Row k="MMSI" v={v.mmsi} />
                    <Row k="Destination" v={v.destination || '—'} />
                    <Row k="Speed" v={v.sog != null ? `${v.sog.toFixed(1)} kn` : '—'} />
                    <Row k="Heading" v={v.heading != null && v.heading !== 511 ? `${v.heading}°${v.cog != null ? ` · COG ${v.cog.toFixed(0)}°` : ''}` : v.cog != null ? `COG ${v.cog.toFixed(0)}°` : '—'} />
                    <Row k="Updated" v={v.time_utc ? new Date(v.time_utc).toLocaleTimeString() : '—'} />
                    <Row k="Source" v={v.source === 'kystverket' ? 'Kystverket' : v.source === 'vesselapi' ? 'VesselAPI' : 'AISStream'} />
                  </div>
                </Popup>
              </Marker>
            )
          })}

          {/* Facilities */}
          {layers.fields && facBy('field').map((f, i) => <Marker key={`fld-${i}`} position={[f.la, f.lo]} icon={fieldIcon(C.field)}><Tooltip>{f.n} · Oil/gas field{f.x ? ` · ${f.x}` : ''} · GEM</Tooltip></Marker>)}
          {layers.refineries && refs.map((f, i) => <Marker key={`ref-${i}`} position={[f.la, f.lo]} icon={refIcon(C.refinery)}><Tooltip>{f.n} · {f.k === 'processing' ? 'Processing plant' : 'Refinery'}{f.x ? ` · ${f.x}` : ''} · NETL</Tooltip></Marker>)}
          {layers.power && facBy('plant').map((f, i) => <CircleMarker key={`pw-${i}`} center={[f.la, f.lo]} radius={3.6} pathOptions={{ color: C.power, fillColor: C.power, fillOpacity: 0.9, weight: 0 }}><Tooltip>{f.n} · Oil/gas power plant{f.x ? ` · ${f.x}` : ''} · GEM</Tooltip></CircleMarker>)}
          {layers.coal && facBy('coal_terminal').map((f, i) => <Marker key={`cl-${i}`} position={[f.la, f.lo]} icon={coalIcon(C.coal)}><Tooltip>{f.n} · Coal terminal{f.x ? ` · ${f.x} Mt` : ''} · GEM</Tooltip></Marker>)}

          {/* LNG terminals (GEM) — purple rings */}
          {layers.lngTerm && lngQ.data?.lng.map((t, i) => <CircleMarker key={`lt-${i}`} center={[t.la, t.lo]} radius={5} pathOptions={{ color: C.lngTerm, weight: 2, fillOpacity: 0 }}><Tooltip><b>{t.n}</b><br />LNG {t.ie || ''} terminal · {t.st} · GEM{t.cap ? `<br />~${t.cap} Mtpa` : ''}</Tooltip></CircleMarker>)}

          {/* Export terminals (curated) */}
          {layers.terminals && terms.data?.ports.map(p => {
            const col = p.kind === 'lng' ? C.lngTerm : C.oilTerm
            return <CircleMarker key={`term-${p.name}`} center={[p.lat, p.lon]} radius={4.5} pathOptions={{ color: col, fillColor: col, fillOpacity: 0.9, weight: 1 }}>
              <Tooltip><b>{p.name}</b> — {p.country}<br />{p.kind.toUpperCase()} export · {p.throughput}{p.cppi ? `<br />CPPI #${p.cppi}/405` : ''}</Tooltip>
            </CircleMarker>
          })}

          {/* World ports (WPI) — hollow squares sized by harbour size */}
          {layers.wpi && wpiShown.map((p, i) => <Marker key={`wpi-${i}`} position={[p.la, p.lo]} icon={wpiIcon(p.s, C.wpi)}><Tooltip>{p.n}{p.c ? ` · ${p.c}` : ''}{p.s ? ` · ${p.s} harbour` : ''}{p.cppi ? ` · CPPI #${p.cppi}/405` : ''} · WPI</Tooltip></Marker>)}

          {/* Chokepoints — pulsing gold rings */}
          {layers.chokepoints && choke.data?.chokepoints.map(c => (
            <Fragment key={`cp-${c.id}`}>
              <CircleMarker center={[c.lat, c.lon]} radius={9} pathOptions={{ color: C.gold, fillColor: C.gold, fillOpacity: 0.1, weight: 2, className: 'choke-pulse' }}><Tooltip><b>{c.name}</b><br />~{c.oil_mbd} Mb/d oil transit</Tooltip></CircleMarker>
              <CircleMarker center={[c.lat, c.lon]} radius={2.5} pathOptions={{ color: C.gold, fillColor: C.gold, fillOpacity: 1, weight: 0 }} />
            </Fragment>
          ))}

          {/* HELCOM Baltic passage lines */}
          {layers.helcom && helcom.map((h, i) => <Polyline key={`hc-${i}`} positions={h.coords} pathOptions={{ color: C.helcom, weight: 3, opacity: 0.85 }}><Tooltip>{h.location || 'Passage line'} · {h.crossings.toLocaleString()} crossings · HELCOM</Tooltip></Polyline>)}
        </MapContainer>

        {/* Dynamic legend */}
        <div style={{ position: 'absolute', right: 14, bottom: 22, zIndex: 500, background: 'color-mix(in srgb, var(--theme-surface) 92%, transparent)', backdropFilter: 'blur(4px)', border: '1px solid color-mix(in srgb, var(--theme-primary) 28%, transparent)', borderRadius: 2, padding: '12px 14px', minWidth: 186, maxHeight: 'calc(100% - 44px)', overflowY: 'auto' }}>
          <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.16em', color: 'var(--theme-text)', marginBottom: 8 }}>LEGEND</div>
          {legend.map(g => (
            <div key={g.group} style={{ marginBottom: 8 }}>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary)', marginBottom: 4 }}>{g.group}</div>
              {g.items.map(it => (
                <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 9, lineHeight: '17px' }}>
                  <span style={{ width: 22, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={it.glyph} /></span>
                  <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text-muted)' }}>{it.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RailSection({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--theme-border-faint)' }}>
      <div style={{ ...railLabel, marginBottom: 4 }}>{label}</div>
      {children}
      {note && <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-text-faint)', marginTop: 4 }}>{note}</div>}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, lineHeight: '19px' }}><span style={{ color: 'var(--theme-secondary)' }}>{k}</span><span style={{ color: 'var(--theme-text)', fontWeight: 600 }}>{v}</span></div>
}

function buildLegend(l: Record<LayerKey, boolean>, C: Colors) {
  const G: { group: string; items: { glyph: React.CSSProperties; label: string }[] }[] = []
  let it: { glyph: React.CSSProperties; label: string }[] = []
  if (l.tanker) it.push({ glyph: gArrow(C.tanker), label: 'Crude tanker' })
  if (l.lng) it.push({ glyph: gArrow(C.lng), label: 'LNG carrier' })
  if (l.cargo) it.push({ glyph: gArrow(C.cargo), label: 'Cargo / dry bulk' })
  if (l.tanker || l.lng || l.cargo) it.push({ glyph: gLine(C.lane, true), label: 'Shipping lane' })
  if (it.length) G.push({ group: 'Vessels & lanes', items: it })

  it = []
  const anyPipe = l.pGem || l.pEia || l.pOsm || l.pEmod
  if (anyPipe) { it.push({ glyph: gLine(C.gold), label: 'Oil pipeline' }); it.push({ glyph: gLine(C.gold, true), label: 'Gas pipeline' }) }
  if (l.pOsm || l.pEmod) it.push({ glyph: gDiamondO(C.gold), label: 'Offshore platform' })
  if (l.pEmod) it.push({ glyph: gRing(C.wind), label: 'Offshore wind farm' })
  if (it.length) G.push({ group: 'Pipelines & offshore', items: it })

  it = []
  if (l.terminals) { it.push({ glyph: gDot(C.oilTerm), label: 'Oil export terminal' }); it.push({ glyph: gDot(C.lngTerm), label: 'LNG export terminal' }) }
  if (l.lngTerm) it.push({ glyph: gRing(C.lngTerm), label: 'LNG terminal (GEM)' })
  if (l.fields) it.push({ glyph: gDiamond(C.field), label: 'Oil / gas field' })
  if (l.refineries) it.push({ glyph: gSquare(C.refinery), label: 'Refinery / processing' })
  if (l.power) it.push({ glyph: gDot(C.power), label: 'Power plant (oil/gas)' })
  if (l.coal) it.push({ glyph: gSquare(C.coal), label: 'Coal terminal' })
  if (it.length) G.push({ group: 'Facilities', items: it })

  it = []
  if (l.wpi) it.push({ glyph: gSquareO(C.wpi), label: 'World port (WPI)' })
  if (l.chokepoints) it.push({ glyph: gRing(C.gold), label: 'Chokepoint' })
  if (it.length) G.push({ group: 'Ports & points', items: it })

  it = []
  if (l.helcom) it.push({ glyph: gLine(C.helcom), label: 'Baltic passage (HELCOM)' })
  if (it.length) G.push({ group: 'Overlays', items: it })
  return G
}

export default function MaritimeMap() {
  return <PageWrapper title="Global Flows Map"><MaritimeMapContent /></PageWrapper>
}
