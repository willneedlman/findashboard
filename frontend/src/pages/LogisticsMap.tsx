import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { MapContainer, CircleMarker, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import Lf from 'leaflet'
import 'leaflet/dist/leaflet.css'
import PageWrapper from '../components/PageWrapper'
import { readToken } from '../lib/theme'
import { L, Spark } from '../components/logi'

// Logistics Map — the full-screen supply-chain view. Layers: live cargo ships and
// cargo flights, air-cargo hubs, all ten chokepoints, and liner-connectivity ports.
// A VIEW sidebar + legend mirror the Energy Flows map; ships and flights are
// clickable into an inspector. Tankers/LNG are energy and live on the Energy map.

const OCEAN = 'var(--theme-bg, #0b1626)'
const COAST = 'rgba(120,150,185,0.16)'

const AIRPORTS: Record<string, [number, number]> = {
  KMEM: [35.04, -89.98], KSDF: [38.17, -85.74], EDDF: [50.03, 8.57], VHHH: [22.31, 113.91],
  PANC: [61.17, -149.99], KCVG: [39.05, -84.67], EDDP: [51.42, 12.24], ZSPD: [31.14, 121.81],
  RKSI: [37.46, 126.44], OMDB: [25.25, 55.36], WSSS: [1.36, 103.99], KIND: [39.72, -86.29],
}
const CHOKES: Record<string, { lat: number; lon: number; name: string }> = {
  hormuz: { lat: 26.57, lon: 56.25, name: 'Strait of Hormuz' }, malacca: { lat: 1.43, lon: 102.9, name: 'Strait of Malacca' },
  suez: { lat: 30.42, lon: 32.35, name: 'Suez Canal' }, bab: { lat: 12.58, lon: 43.33, name: 'Bab el-Mandeb' },
  panama: { lat: 9.08, lon: -79.68, name: 'Panama Canal' }, bosphorus: { lat: 41.12, lon: 29.07, name: 'Turkish Straits' },
  danish: { lat: 55.70, lon: 12.70, name: 'Danish Straits' }, goodhope: { lat: -34.36, lon: 18.47, name: 'Cape of Good Hope' },
  gibraltar: { lat: 35.97, lon: -5.50, name: 'Strait of Gibraltar' }, taiwan: { lat: 24.50, lon: 119.5, name: 'Taiwan Strait' },
}
const PORTS: Record<string, { lat: number; lon: number; port: string }> = {
  CHN: { lat: 31.2, lon: 121.5, port: 'Shanghai' }, KOR: { lat: 35.1, lon: 129.04, port: 'Busan' },
  SGP: { lat: 1.26, lon: 103.8, port: 'Singapore' }, USA: { lat: 33.74, lon: -118.26, port: 'Los Angeles' },
  NLD: { lat: 51.95, lon: 4.14, port: 'Rotterdam' }, DEU: { lat: 53.55, lon: 9.99, port: 'Hamburg' },
  JPN: { lat: 35.45, lon: 139.65, port: 'Yokohama' }, GBR: { lat: 51.95, lon: 1.32, port: 'Felixstowe' },
  BEL: { lat: 51.28, lon: 4.32, port: 'Antwerp' }, ESP: { lat: 39.44, lon: -0.32, port: 'Valencia' },
  ARE: { lat: 25.0, lon: 55.06, port: 'Jebel Ali' }, MYS: { lat: 3.0, lon: 101.4, port: 'Port Klang' },
  IND: { lat: 18.95, lon: 72.95, port: 'Nhava Sheva' }, ITA: { lat: 38.43, lon: 15.9, port: 'Gioia Tauro' },
}

const radius = (v: number, max: number, min = 6, cap = 22) => max > 0 && v > 0 ? min + Math.sqrt(v / max) * (cap - min) : min

function SizeFix() {
  const map = useMap()
  useEffect(() => {
    const t1 = setTimeout(() => map.invalidateSize(), 80), t2 = setTimeout(() => map.invalidateSize(), 340)
    const ro = new ResizeObserver(() => map.invalidateSize()); ro.observe(map.getContainer())
    return () => { clearTimeout(t1); clearTimeout(t2); ro.disconnect() }
  }, [map])
  return null
}
function Basemap({ land }: { land: string }) {
  const map = useMap()
  useEffect(() => {
    let layer: Lf.Layer | undefined
    fetch('/world-countries.geo.json').then(r => r.json()).then(gj => {
      layer = Lf.geoJSON(gj, { style: { fillColor: land, color: COAST, weight: 0.6, fillOpacity: 1 } as Lf.PathOptions, interactive: false }).addTo(map)
      ;(layer as Lf.GeoJSON).bringToBack()
    }).catch(() => {
      layer = Lf.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 6 }).addTo(map)
      ;(layer as Lf.TileLayer).bringToBack()
    })
    return () => { if (layer) map.removeLayer(layer) }
  }, [map, land])
  return null
}

// Reports the map's viewport (debounced) so the supplier layer loads only what's
// on screen — local density instead of a global 6k sample.
function BoundsWatch({ onChange }: { onChange: (b: [number, number, number, number]) => void }) {
  const tmr = useRef<number | undefined>(undefined)
  const last = useRef<[number, number, number, number] | null>(null)
  const emit = (m: Lf.Map) => {
    const b = m.getBounds()
    const next: [number, number, number, number] = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]
    const p = last.current
    // Skip near-identical bounds so invalidateSize()-triggered moveends (no real
    // pan) don't churn state and re-fetch — a key source of the flicker.
    if (p && p.every((v, i) => Math.abs(v - next[i]) < 1e-4)) return
    last.current = next
    onChange(next)
  }
  const map = useMapEvents({
    moveend: (e) => { window.clearTimeout(tmr.current); tmr.current = window.setTimeout(() => emit(e.target as Lf.Map), 350) },
  })
  useEffect(() => { emit(map); return () => window.clearTimeout(tmr.current) }, [])  // initial bounds on mount
  return null
}

interface Hub { icao: string; city: string; movements: number; by_operator: Record<string, number> }
interface Econ { country: string; lsci: number; iso?: string }
interface MF { lsci?: { economies?: Econ[]; _stale?: boolean }; wci?: { composite_usd_per_40ft?: number; _stale?: boolean } }
interface FM { inventory_sales?: { latest?: { ratio: number }; series?: { ratio: number }[]; _stale?: boolean }; freight_indices?: { indices?: Record<string, { latest?: { value: number }; series?: { value: number }[] }>; _stale?: boolean } }
interface Vessel { mmsi: string; lat?: number; lon?: number; category?: string; name?: string; destination?: string; sog?: number; heading?: number; cog?: number }
interface Flight { icao24: string; callsign: string; operator: string; lat: number; lon: number; alt_m?: number; vel_ms?: number; heading?: number; origin_country?: string }
type Insp = { kind: 'ship'; v: Vessel } | { kind: 'flight'; f: Flight }
interface SupplierFeature { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: { company_name: string | null; company_industry: string | null; product_names: string | null } }
interface SupplierFC { type: string; features?: SupplierFeature[]; count: number; available: boolean }
interface Facets { industries?: string[]; products?: string[]; available: boolean }

const panel = 'color-mix(in srgb, var(--theme-surface) 95%, transparent)'
function Dot({ c }: { c: string }) { return <span style={{ width: 9, height: 9, borderRadius: '50%', background: c, flex: 'none' }} /> }
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 12 }}><div style={{ fontFamily: L.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: L.gold, marginBottom: 6 }}>{title}</div>{children}</div>
}

export default function LogisticsMap() {
  const [layers, setLayers] = useState({ vessels: true, flights: true, air: true, choke: true, port: true, suppliers: true })
  const [insp, setInsp] = useState<Insp | null>(null)
  const [supIndustry, setSupIndustry] = useState('')
  const [supProduct, setSupProduct] = useState('')
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null)
  const AIR = readToken('--theme-tertiary', '#60a5fa'), CHOKE = readToken('--theme-primary', '#c9a84c')
  const PORT = readToken('--theme-positive', '#3fb6a0'), VESSEL = readToken('--theme-secondary', '#8099b0')
  const FLIGHT = readToken('--theme-accent-violet', '#a78bfa'), LAND = readToken('--theme-surface', '#0f1d31')
  const SUPPLIER = readToken('--theme-accent-cyan', '#22d3ee')
  // Small glyph markers (ship / jet) instead of plain dots. currentColor + a CSS
  // :hover rule gives the colour-on-hover; the jet rotates to its heading.
  const shipIcon = Lf.divIcon({ className: 'lm-mk', iconSize: [15, 15], iconAnchor: [7.5, 7.5],
    html: `<svg class="lm-ship" width="15" height="15" viewBox="0 0 24 24" style="color:${VESSEL}"><path fill="currentColor" d="M3 14l1.8 5h14.4L21 14H3zm3-2V8l6-4 6 4v4H6z"/></svg>` })
  const jetIcon = (h: number) => Lf.divIcon({ className: 'lm-mk', iconSize: [16, 16], iconAnchor: [8, 8],
    html: `<svg class="lm-jet" width="16" height="16" viewBox="0 0 24 24" style="color:${FLIGHT};transform:rotate(${h}deg)"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-4.5l8 2.5z"/></svg>` })

  const air = useQuery<{ hubs?: Hub[] }>({ queryKey: ['lm-air'], queryFn: () => axios.get('/api/logistics/air-cargo/vulnerability').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const mf = useQuery<MF>({ queryKey: ['lm-mf'], queryFn: () => axios.get('/api/logistics/maritime-freight').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const fm = useQuery<FM>({ queryKey: ['lm-fm'], queryFn: () => axios.get('/api/logistics/freight-macro').then(r => r.data), staleTime: 12 * 3600e3, retry: 1 })
  const cs = useQuery<{ stats?: { id: string; avg7: number }[] }>({ queryKey: ['lm-choke'], queryFn: () => axios.get('/api/maritime/chokepoint-stats').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const vq = useQuery<{ vessels?: Vessel[] }>({ queryKey: ['lm-vessels'], queryFn: () => axios.get('/api/maritime/vessels?classified_only=true').then(r => r.data), staleTime: 60e3, refetchInterval: 60e3, retry: 1 })
  const fq = useQuery<{ flights?: Flight[] }>({ queryKey: ['lm-flights'], queryFn: () => axios.get('/api/logistics/flights').then(r => r.data), staleTime: 120e3, refetchInterval: 120e3, retry: 1 })
  const facetsQ = useQuery<Facets>({ queryKey: ['lm-facets'], queryFn: () => axios.get('/api/logistics/supplier-facets').then(r => r.data), staleTime: 24 * 3600e3, retry: 1 })
  const bboxParam = bbox ? bbox.join(',') : null
  const supQ = useQuery<SupplierFC>({
    queryKey: ['lm-suppliers', supIndustry, supProduct, bboxParam],
    queryFn: () => { const p = new URLSearchParams({ limit: '6000' }); if (supIndustry) p.set('industry', supIndustry); if (supProduct) p.set('product_keyword', supProduct); if (bboxParam) p.set('bbox', bboxParam); return axios.get(`/api/logistics/supplier-nodes?${p.toString()}`).then(r => r.data) },
    enabled: layers.suppliers && !!bbox,
    // Keep the prior viewport's nodes on screen while the new bbox loads — no flash.
    placeholderData: keepPreviousData,
    staleTime: 6 * 3600e3, retry: 1,
  })

  const supFeatures = supQ.data?.features ?? []
  const facetInds = facetsQ.data?.industries ?? []
  const hubs = air.data?.hubs ?? []
  const maxAir = Math.max(1, ...hubs.map(h => h.movements))
  const econ = mf.data?.lsci?.economies ?? []
  const maxLsci = Math.max(1, ...econ.map(e => e.lsci))
  const chokeAvg: Record<string, number> = Object.fromEntries((cs.data?.stats ?? []).map(s => [s.id, s.avg7]))
  const maxChoke = Math.max(1, ...Object.values(chokeAvg))
  const vessels = (vq.data?.vessels ?? []).filter(v => v.category === 'cargo' && v.lat != null && v.lon != null).slice(0, 1200)
  const flights = (fq.data?.flights ?? []).filter(f => f.lat != null && f.lon != null)
  const idx = fm.data?.freight_indices?.indices ?? {}
  const portOf = (e: Econ) => PORTS[e.iso ?? ''] ?? PORTS[e.country]

  const eyebrow: React.CSSProperties = { fontFamily: L.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: L.gold }
  const goldTint = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)'
  const VIEW: ['vessels' | 'flights' | 'air' | 'choke' | 'port' | 'suppliers', string, string, number][] = [
    ['suppliers', 'Suppliers', SUPPLIER, supFeatures.length],
    ['vessels', 'Cargo ships', VESSEL, vessels.length], ['flights', 'Cargo flights', FLIGHT, flights.length],
    ['air', 'Air hubs', AIR, hubs.length], ['choke', 'Chokepoints', CHOKE, Object.keys(CHOKES).length], ['port', 'LSCI ports', PORT, econ.length],
  ]
  const selStyle: React.CSSProperties = { flex: 1, minWidth: 0, background: 'var(--theme-bg, #0b1626)', color: L.text, border: `1px solid ${L.border}`, borderRadius: 3, fontFamily: L.mono, fontSize: 10, padding: '4px 6px' }
  const selLbl: React.CSSProperties = { display: 'block', fontFamily: L.sans, fontSize: 9, color: L.faint, marginBottom: 3 }

  // Freight-macro (+ container spot rate) ride the docked bottom tape, energy-map style.
  const ser = (k: string) => (idx[k]?.series ?? []).map(o => o.value)
  const TAPE: { k: string; label: string; val?: number | null; unit: string; series: number[] }[] = [
    { k: 'wci', label: 'DREWRY WCI', val: mf.data?.wci?.composite_usd_per_40ft, unit: '$/40ft', series: [] },
    { k: 'inv', label: 'INV / SALES', val: fm.data?.inventory_sales?.latest?.ratio, unit: 'ratio', series: (fm.data?.inventory_sales?.series ?? []).map(p => p.ratio) },
    { k: 'cass_s', label: 'CASS SHIPMENTS', val: idx.cass_shipments?.latest?.value, unit: 'idx', series: ser('cass_shipments') },
    { k: 'cass_e', label: 'CASS EXPEND', val: idx.cass_expenditures?.latest?.value, unit: 'idx', series: ser('cass_expenditures') },
    { k: 'truck', label: 'TRUCK TONNAGE', val: idx.truck_tonnage?.latest?.value, unit: 'idx', series: ser('truck_tonnage') },
  ]
  const colHead = (a: string, b: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: L.mono, fontSize: 7.5, letterSpacing: '0.08em', color: L.faint, paddingBottom: 3, marginBottom: 2, borderBottom: `1px solid ${L.border}` }}><span>{a}</span><span>{b}</span></div>
  )
  const line = (a: string, b: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0', fontFamily: L.mono, fontSize: 10.5 }}>
      <span style={{ color: L.sec, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a}</span>
      <span style={{ color: L.text, fontWeight: 700, flex: 'none' }}>{b}</span>
    </div>
  )
  const irow = (k: string, v: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
      <span style={{ fontFamily: L.sans, fontSize: 11, color: L.sec }}>{k}</span>
      <span style={{ fontFamily: L.mono, fontSize: 11, fontWeight: 600, color: L.text, textAlign: 'right' }}>{v}</span>
    </div>
  )

  return (
    <PageWrapper>
      <style>{`.lm-map { background: ${OCEAN}; } .lm-map .leaflet-tooltip { background: var(--theme-surface); color: var(--theme-text); border: 1px solid var(--theme-border); font-family: var(--theme-mono); font-size: 11px; }
        .lm-mk svg { transition: color .12s ease; cursor: pointer; } .lm-mk:hover svg { color: var(--theme-primary, #c9a84c) !important; }`}</style>
      <div style={{ height: 'calc(100vh - 32px)', minHeight: 620, display: 'flex', flexDirection: 'column', border: `1px solid ${L.border}`, borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <MapContainer className="lm-map" center={[30, 30]} zoom={2.3} minZoom={2} maxZoom={6} worldCopyJump preferCanvas zoomControl={false} style={{ position: 'absolute', inset: 0, height: '100%', width: '100%' }}>
          <SizeFix /><Basemap land={LAND} /><BoundsWatch onChange={setBbox} />
          {layers.suppliers && supFeatures.map((f, i) => (
            <CircleMarker key={`s-${i}`} center={[f.geometry.coordinates[1], f.geometry.coordinates[0]]} radius={2.5} pathOptions={{ color: SUPPLIER, fillColor: SUPPLIER, fillOpacity: 0.9, weight: 0.5 }}>
              <Tooltip>
                <div style={{ fontWeight: 700 }}>{f.properties.company_name || '—'}</div>
                <div>{f.properties.company_industry || '—'}</div>
                {f.properties.product_names && <div style={{ opacity: 0.8 }}>{String(f.properties.product_names).slice(0, 80)}</div>}
              </Tooltip>
            </CircleMarker>
          ))}
          {layers.vessels && vessels.map(v => (
            <Marker key={`v-${v.mmsi}`} position={[v.lat as number, v.lon as number]} icon={shipIcon} eventHandlers={{ click: () => setInsp({ kind: 'ship', v }) }} />
          ))}
          {layers.flights && flights.map(f => (
            <Marker key={`f-${f.icao24}`} position={[f.lat, f.lon]} icon={jetIcon(f.heading ?? 0)} eventHandlers={{ click: () => setInsp({ kind: 'flight', f }) }} />
          ))}
          {layers.port && econ.map(e => { const p = portOf(e); return p && (
            <CircleMarker key={`p-${e.iso ?? e.country}`} center={[p.lat, p.lon]} radius={radius(e.lsci, maxLsci)} pathOptions={{ color: PORT, fillColor: PORT, fillOpacity: 0.35, weight: 1 }}><Tooltip>{p.port} · LSCI {e.lsci.toFixed(1)}</Tooltip></CircleMarker>
          )})}
          {layers.choke && Object.entries(CHOKES).map(([id, g]) => { const t = chokeAvg[id] ?? 0; return (
            <CircleMarker key={`c-${id}`} center={[g.lat, g.lon]} radius={radius(t, maxChoke)} pathOptions={{ color: CHOKE, fillColor: CHOKE, fillOpacity: 0.4, weight: 1 }}><Tooltip>{g.name}{t ? ` · ${Math.round(t)} transits/d` : ''}</Tooltip></CircleMarker>
          )})}
          {layers.air && hubs.map(h => { const a = AIRPORTS[h.icao]; return a && (
            <CircleMarker key={`a-${h.icao}`} center={a} radius={radius(h.movements, maxAir)} pathOptions={{ color: AIR, fillColor: AIR, fillOpacity: 0.4, weight: 1 }}><Tooltip>{h.city} ({h.icao}) · {h.movements} freighter moves/24h</Tooltip></CircleMarker>
          )})}
        </MapContainer>

        {/* Top-left: title + live count */}
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 520, display: 'flex', alignItems: 'center', gap: 12, padding: '8px 13px', background: panel, border: `1px solid ${L.border}` }}>
          <span style={{ fontFamily: L.mono, fontSize: 13, fontWeight: 700, letterSpacing: '0.18em', color: L.gold }}>LOGISTICS MAP</span>
          <span style={{ fontFamily: L.mono, fontSize: 9, color: L.pos }}>● LIVE · {flights.length} flights · {vessels.length} ships</span>
        </div>

        {/* Left column: VIEW + LEGEND (bottom) */}
        <div style={{ position: 'absolute', top: 56, left: 12, bottom: 12, zIndex: 520, width: 210, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto', background: panel, border: `1px solid ${L.border}`, padding: '12px 12px 8px' }}>
            <div style={{ ...eyebrow, color: 'var(--theme-text-dim, #56708a)', marginBottom: 6 }}>View</div>
            {VIEW.map(([k, lbl, c, n]) => { const on = layers[k]; return (
              <div key={k} onClick={() => setLayers(s => ({ ...s, [k]: !s[k] }))}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 9px', cursor: 'pointer', background: on ? `color-mix(in srgb, ${c} 13%, transparent)` : 'transparent', borderLeft: on ? `2px solid ${c}` : '2px solid transparent' }}>
                <span style={{ fontFamily: L.sans, fontSize: 11.5, fontWeight: on ? 600 : 400, color: on ? L.text : L.sec }}>{lbl}</span>
                <span style={{ fontFamily: L.mono, fontSize: 10, color: on ? c : L.faint }}>{n}</span>
              </div>
            )})}
          </div>
          <div style={{ pointerEvents: 'auto', background: panel, border: `1px solid ${L.border}`, padding: '12px 12px 11px' }}>
            <div style={{ ...eyebrow, color: 'var(--theme-text-dim, #56708a)', marginBottom: 8 }}>Filters</div>
            <label style={selLbl}>Suppliers · product class</label>
            <select value={supIndustry} onChange={e => setSupIndustry(e.target.value)} style={{ ...selStyle, width: '100%', marginBottom: 6 }}>
              <option value="">{facetInds.length ? 'All industries' : 'No data yet'}</option>
              {facetInds.map(i => <option key={i} value={i}>{i}</option>)}
            </select>
            <input value={supProduct} onChange={e => setSupProduct(e.target.value)} placeholder="product keyword…" style={{ ...selStyle, width: '100%' }} />
            {supQ.data && !supQ.data.available && <div style={{ fontFamily: L.sans, fontSize: 8.5, color: L.faint, marginTop: 7, lineHeight: 1.5 }}>Supplier data not yet ingested — run the Veridion ETL with a valid DEWEY_API_KEY.</div>}
          </div>
          <div style={{ marginTop: 'auto', pointerEvents: 'auto', background: panel, border: `1px solid ${L.border}`, padding: '13px 16px' }}>
            <div style={{ fontFamily: L.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', color: L.text, marginBottom: 9 }}>LEGEND</div>
            {([['Supplier node', SUPPLIER, 'dot'], ['Cargo ship', VESSEL, 'ship'], ['Cargo flight', FLIGHT, 'jet'], ['Air cargo hub', AIR, 'dot'], ['Chokepoint', CHOKE, 'dot'], ['Connectivity port', PORT, 'dot']] as [string, string, 'ship' | 'jet' | 'dot'][]).map(([lbl, c, t]) => (
              <div key={lbl} style={{ display: 'flex', alignItems: 'center', gap: 9, lineHeight: '22px' }}>
                <span style={{ width: 16, display: 'flex', justifyContent: 'center', flex: 'none' }}>
                  {t === 'ship' ? <svg width="15" height="15" viewBox="0 0 24 24" style={{ color: c }}><path fill="currentColor" d="M3 14l1.8 5h14.4L21 14H3zm3-2V8l6-4 6 4v4H6z" /></svg>
                    : t === 'jet' ? <svg width="15" height="15" viewBox="0 0 24 24" style={{ color: c }}><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-4.5l8 2.5z" /></svg>
                      : <Dot c={c} />}
                </span>
                <span style={{ fontFamily: L.sans, fontSize: 11.5, color: L.sec }}>{lbl}</span>
              </div>
            ))}
            <div style={{ fontFamily: L.sans, fontSize: 8.5, color: L.faint, marginTop: 8, lineHeight: 1.5 }}>Marker size ∝ value in layer. Click a ship or flight to inspect.</div>
          </div>
        </div>

        {/* Right: inspector (when selected) + folded detail */}
        <div style={{ position: 'absolute', top: 12, right: 12, bottom: 12, width: 250, overflowY: 'auto', background: panel, border: `1px solid ${L.border}`, padding: '11px 13px', zIndex: 520 }}>
          {insp && (
            <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${L.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ ...eyebrow }}>{insp.kind === 'ship' ? 'Cargo ship' : 'Cargo flight'}</span>
                <button onClick={() => setInsp(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: L.mono, fontSize: 12, color: L.faint }}>x</button>
              </div>
              {insp.kind === 'ship' ? (<>
                <div style={{ fontFamily: L.sans, fontSize: 14, fontWeight: 700, color: L.text, margin: '6px 0 8px' }}>{insp.v.name || `MMSI ${insp.v.mmsi}`}</div>
                {irow('Type', 'Cargo / dry bulk')}
                {irow('Destination', insp.v.destination || '—')}
                {irow('Speed', insp.v.sog != null ? `${insp.v.sog.toFixed(1)} kn` : '—')}
                {irow('Heading', insp.v.heading != null && insp.v.heading !== 511 ? `${insp.v.heading}°` : insp.v.cog != null ? `COG ${Math.round(insp.v.cog)}°` : '—')}
                {irow('MMSI', insp.v.mmsi)}
              </>) : (<>
                <div style={{ fontFamily: L.sans, fontSize: 14, fontWeight: 700, color: L.text, margin: '6px 0 8px' }}>{insp.f.callsign}</div>
                {irow('Operator', insp.f.operator)}
                {irow('Origin', insp.f.origin_country || '—')}
                {irow('Altitude', insp.f.alt_m != null ? `${Math.round(insp.f.alt_m * 3.281).toLocaleString()} ft` : '—')}
                {irow('Ground speed', insp.f.vel_ms != null ? `${Math.round(insp.f.vel_ms * 1.944)} kn` : '—')}
                {irow('Heading', insp.f.heading != null ? `${Math.round(insp.f.heading)}°` : '—')}
              </>)}
            </div>
          )}

          <Section title="CONTAINER & FREIGHT">
            <div>
              {colHead('PORT', 'LSCI')}
              {econ.slice(0, 8).map(e => line(portOf(e)?.port ?? e.country, e.lsci.toFixed(1)))}
              <div style={{ fontFamily: L.sans, fontSize: 8, color: L.faint, marginTop: 3 }}>Liner Shipping Connectivity Index (higher = better connected)</div>
            </div>
          </Section>

          <Section title="AIR CARGO">
            {colHead('HUB', '24H MOVES · TOP OP')}
            {hubs.map(h => { const top = Object.entries(h.by_operator).sort((a, b) => b[1] - a[1])[0]; return line(`${h.city} (${h.icao})`, `${h.movements}${top ? ` · ${top[0]}` : ''}`) })}
            {!hubs.length && <div style={{ fontFamily: L.mono, fontSize: 10, color: L.faint }}>No freighter data.</div>}
            <div style={{ fontFamily: L.sans, fontSize: 8, color: L.faint, marginTop: 3 }}>Freighter arrivals + departures, last 24h (OpenSky, ~12h lag)</div>
          </Section>

        </div>
        </div>

        {/* Docked freight-macro tape — energy-map bottom-strip style */}
        <div style={{ height: 44, flex: 'none', display: 'grid', gridTemplateColumns: `repeat(${TAPE.length}, 1fr)`, background: 'var(--theme-surface, #0d1826)', borderTop: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)' }}>
          {TAPE.map((t, i) => (
            <div key={t.k} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '0 14px', borderLeft: i ? '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' : 'none', minWidth: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }} title="Monthly · seasonally adjusted · Census, FRED, Drewry">
              <span style={{ fontFamily: L.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em', color: L.faint, flex: 'none' }}>{t.label}</span>
              <span style={{ fontFamily: L.mono, fontSize: 13, fontWeight: 700, color: L.text, flex: 'none' }}>{t.val != null ? t.val.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</span>
              <span style={{ fontFamily: L.mono, fontSize: 8, color: L.sec, flex: 'none' }}>{t.unit}</span>
              {t.series.length > 1 && <span style={{ marginLeft: 'auto', flex: 'none' }}><Spark data={t.series} w={54} h={18} color={L.sec} /></span>}
            </div>
          ))}
        </div>
      </div>
    </PageWrapper>
  )
}
