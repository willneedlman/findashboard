import { useState, useEffect } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { MapContainer, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import Lf from 'leaflet'
import 'leaflet/dist/leaflet.css'
import PageWrapper from '../components/PageWrapper'
import { readToken } from '../lib/theme'
import { L, Spark, StaleDot } from '../components/logi'

// Logistics Map — the single consolidated view for the Geo-Logistics hub. The map
// carries the geographic layers (air-cargo hubs, all ten chokepoints, liner ports,
// and live AIS vessels); a scrollable panel folds in every tabular detail from the
// former Container & Freight / Air Cargo / Freight Macro tabs. Reuses the /flows-map
// react-leaflet basemap and the live /api/maritime feeds for density.

const OCEAN = 'var(--theme-bg, #0b1626)'
const COAST = 'rgba(120,150,185,0.16)'

const AIRPORTS: Record<string, [number, number]> = {
  KMEM: [35.04, -89.98], KSDF: [38.17, -85.74], EDDF: [50.03, 8.57], VHHH: [22.31, 113.91],
}
const CHOKES: Record<string, { lat: number; lon: number; name: string }> = {
  hormuz: { lat: 26.57, lon: 56.25, name: 'Strait of Hormuz' },
  malacca: { lat: 1.43, lon: 102.9, name: 'Strait of Malacca' },
  suez: { lat: 30.42, lon: 32.35, name: 'Suez Canal' },
  bab: { lat: 12.58, lon: 43.33, name: 'Bab el-Mandeb' },
  panama: { lat: 9.08, lon: -79.68, name: 'Panama Canal' },
  bosphorus: { lat: 41.12, lon: 29.07, name: 'Turkish Straits' },
  danish: { lat: 55.70, lon: 12.70, name: 'Danish Straits' },
  goodhope: { lat: -34.36, lon: 18.47, name: 'Cape of Good Hope' },
  gibraltar: { lat: 35.97, lon: -5.50, name: 'Strait of Gibraltar' },
  taiwan: { lat: 24.50, lon: 119.5, name: 'Taiwan Strait' },
}
const PORTS: Record<string, { lat: number; lon: number; port: string }> = {
  'China': { lat: 31.2, lon: 121.5, port: 'Shanghai' },
  'Korea, Rep.': { lat: 35.1, lon: 129.04, port: 'Busan' },
  'Singapore': { lat: 1.26, lon: 103.8, port: 'Singapore' },
  'United States': { lat: 33.74, lon: -118.26, port: 'Los Angeles' },
  'Netherlands': { lat: 51.95, lon: 4.14, port: 'Rotterdam' },
  'Germany': { lat: 53.55, lon: 9.99, port: 'Hamburg' },
  'Japan': { lat: 35.45, lon: 139.65, port: 'Yokohama' },
}

const radius = (v: number, max: number, min = 6, cap = 22) =>
  max > 0 && v > 0 ? min + Math.sqrt(v / max) * (cap - min) : min

function SizeFix() {
  const map = useMap()
  useEffect(() => {
    const t1 = setTimeout(() => map.invalidateSize(), 80)
    const t2 = setTimeout(() => map.invalidateSize(), 340)
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(map.getContainer())
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

interface Hub { icao: string; city: string; movements: number; by_operator: Record<string, number> }
interface Air { hubs?: Hub[]; _stale?: boolean }
interface Econ { country: string; lsci: number }
interface MF { lsci?: { economies?: Econ[]; _stale?: boolean }; wci?: { composite_usd_per_40ft?: number; _stale?: boolean } }
interface FM { inventory_sales?: { latest?: { ratio: number }; series?: { ratio: number }[]; _stale?: boolean }; freight_indices?: { indices?: Record<string, { latest?: { value: number }; series?: { value: number }[] }>; _stale?: boolean } }
interface Vessel { mmsi: string; lat?: number; lon?: number; category?: string }
interface ChokeStat { id: string; name: string; avg7: number }

function Dot({ c }: { c: string }) { return <span style={{ width: 9, height: 9, borderRadius: '50%', background: c, flex: 'none' }} /> }
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontFamily: L.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: L.gold, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  )
}

export default function LogisticsMap() {
  const [layers, setLayers] = useState({ air: true, choke: true, port: true, vessels: true })
  const AIR = readToken('--theme-tertiary', '#60a5fa')
  const CHOKE = readToken('--theme-primary', '#c9a84c')
  const PORT = readToken('--theme-positive', '#3fb6a0')
  const VESSEL = readToken('--theme-secondary', '#8099b0')
  const LAND = readToken('--theme-surface', '#0f1d31')

  const air = useQuery<Air>({ queryKey: ['lm-air'], queryFn: () => axios.get('/api/logistics/air-cargo/vulnerability').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const mf = useQuery<MF>({ queryKey: ['lm-mf'], queryFn: () => axios.get('/api/logistics/maritime-freight').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const fm = useQuery<FM>({ queryKey: ['lm-fm'], queryFn: () => axios.get('/api/logistics/freight-macro').then(r => r.data), staleTime: 12 * 3600e3, retry: 1 })
  const cs = useQuery<{ stats?: ChokeStat[] }>({ queryKey: ['lm-choke'], queryFn: () => axios.get('/api/maritime/chokepoint-stats').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const vq = useQuery<{ vessels?: Vessel[] }>({ queryKey: ['lm-vessels'], queryFn: () => axios.get('/api/maritime/vessels?classified_only=true').then(r => r.data), staleTime: 60e3, refetchInterval: 60e3, retry: 1 })

  const hubs = air.data?.hubs ?? []
  const maxAir = Math.max(1, ...hubs.map(h => h.movements))
  const econ = mf.data?.lsci?.economies ?? []
  const maxLsci = Math.max(1, ...econ.map(e => e.lsci))
  const chokeAvg: Record<string, number> = Object.fromEntries((cs.data?.stats ?? []).map(s => [s.id, s.avg7]))
  const maxChoke = Math.max(1, ...Object.values(chokeAvg))
  // Cargo/container ships only — tankers and LNG carriers are energy and live on
  // the Energy Flows map, not here.
  const vessels = (vq.data?.vessels ?? []).filter(v => v.category === 'cargo' && v.lat != null && v.lon != null).slice(0, 700)
  const idx = fm.data?.freight_indices?.indices ?? {}

  const stat = (label: string, val?: number | null, unit?: string, series?: number[], stale?: boolean) => (
    <div style={{ padding: '6px 0', borderBottom: `1px solid ${L.border}` }}>
      <div style={{ fontFamily: L.mono, fontSize: 8.5, letterSpacing: '0.06em', color: L.faint, marginBottom: 2 }}>{label}<StaleDot stale={stale} /></div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: L.mono, fontSize: 17, fontWeight: 700, color: L.text }}>{val != null ? val.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}{unit && <span style={{ fontSize: 8.5, color: L.sec, fontWeight: 400 }}> {unit}</span>}</span>
        {series && series.length > 1 && <Spark data={series} w={64} h={20} color={L.sec} />}
      </div>
    </div>
  )
  const line = (a: string, b: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0', fontFamily: L.mono, fontSize: 10.5 }}>
      <span style={{ color: L.sec, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a}</span>
      <span style={{ color: L.text, fontWeight: 700, flex: 'none' }}>{b}</span>
    </div>
  )

  return (
    <PageWrapper>
      <style>{`.lm-map { background: ${OCEAN}; } .lm-map .leaflet-tooltip { background: var(--theme-surface); color: var(--theme-text); border: 1px solid var(--theme-border); font-family: var(--theme-mono); font-size: 11px; }`}</style>
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontFamily: L.mono, fontSize: 15, fontWeight: 700, letterSpacing: '0.2em', color: L.gold }}>LOGISTICS MAP</div>
          <div style={{ fontFamily: L.sans, fontSize: 11, color: L.sec, marginTop: 5 }}>Air hubs, chokepoints, connectivity ports, and live cargo ships — the supply chain on one map.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {([['vessels', 'Cargo ships', VESSEL], ['air', 'Air hubs', AIR], ['choke', 'Chokepoints', CHOKE], ['port', 'LSCI ports', PORT]] as const).map(([k, lbl, c]) => (
            <button key={k} onClick={() => setLayers(s => ({ ...s, [k]: !s[k] }))}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', cursor: 'pointer', background: 'transparent', border: `1px solid ${layers[k] ? c : L.border}`, color: layers[k] ? L.text : L.faint, fontFamily: L.mono, fontSize: 10, fontWeight: 700 }}>
              <Dot c={c} />{lbl}
            </button>
          ))}
        </div>
      </div>

      <div style={{ position: 'relative', height: '76vh', minHeight: 480, border: `1px solid ${L.border}`, borderRadius: 6, overflow: 'hidden' }}>
        <MapContainer className="lm-map" center={[26, 40]} zoom={2.1} minZoom={2} maxZoom={6} worldCopyJump preferCanvas style={{ height: '100%', width: '100%' }}>
          <SizeFix />
          <Basemap land={LAND} />
          {layers.vessels && vessels.map(v => (
            <CircleMarker key={`v-${v.mmsi}`} center={[v.lat as number, v.lon as number]} radius={2} pathOptions={{ color: VESSEL, fillColor: VESSEL, fillOpacity: 0.5, weight: 0 }} />
          ))}
          {layers.port && econ.map(e => { const p = PORTS[e.country]; return p && (
            <CircleMarker key={`p-${e.country}`} center={[p.lat, p.lon]} radius={radius(e.lsci, maxLsci)} pathOptions={{ color: PORT, fillColor: PORT, fillOpacity: 0.35, weight: 1 }}>
              <Tooltip>{p.port} · LSCI {e.lsci.toFixed(1)}</Tooltip>
            </CircleMarker>
          )})}
          {layers.choke && Object.entries(CHOKES).map(([id, g]) => { const t = chokeAvg[id] ?? 0; return (
            <CircleMarker key={`c-${id}`} center={[g.lat, g.lon]} radius={radius(t, maxChoke)} pathOptions={{ color: CHOKE, fillColor: CHOKE, fillOpacity: 0.4, weight: 1 }}>
              <Tooltip>{g.name}{t ? ` · ${Math.round(t)} transits/d` : ''}</Tooltip>
            </CircleMarker>
          )})}
          {layers.air && hubs.map(h => { const a = AIRPORTS[h.icao]; return a && (
            <CircleMarker key={`a-${h.icao}`} center={a} radius={radius(h.movements, maxAir)} pathOptions={{ color: AIR, fillColor: AIR, fillOpacity: 0.4, weight: 1 }}>
              <Tooltip>{h.city} ({h.icao}) · {h.movements} freighter moves/24h<br />{Object.entries(h.by_operator).map(([o, n]) => `${o} ${n}`).join(' · ')}</Tooltip>
            </CircleMarker>
          )})}
        </MapContainer>

        {/* Folded-in detail: every former tab's data in one scrollable panel */}
        <div style={{ position: 'absolute', top: 12, right: 12, bottom: 12, width: 236, overflowY: 'auto', background: 'color-mix(in srgb, var(--theme-surface) 95%, transparent)', border: `1px solid ${L.border}`, borderRadius: 5, padding: '11px 13px', zIndex: 500 }}>
          <Section title="CONTAINER & FREIGHT">
            {stat('DREWRY WCI', mf.data?.wci?.composite_usd_per_40ft, '$/40ft', undefined, mf.data?.wci?._stale)}
            <div style={{ marginTop: 6 }}>
              {econ.slice(0, 6).map(e => line(PORTS[e.country]?.port ?? e.country, e.lsci.toFixed(1)))}
              <div style={{ fontFamily: L.sans, fontSize: 8, color: L.faint, marginTop: 3 }}>Liner Shipping Connectivity Index</div>
            </div>
          </Section>

          <Section title="AIR CARGO">
            {hubs.map(h => { const top = Object.entries(h.by_operator).sort((a, b) => b[1] - a[1])[0]; return line(`${h.city} (${h.icao})`, `${h.movements}${top ? ` · ${top[0]}` : ''}`) })}
            {!hubs.length && <div style={{ fontFamily: L.mono, fontSize: 10, color: L.faint }}>No freighter data.</div>}
            <div style={{ fontFamily: L.sans, fontSize: 8, color: L.faint, marginTop: 3 }}>Freighter movements · 24h · OpenSky</div>
          </Section>

          <Section title="FREIGHT MACRO">
            {stat('INVENTORIES / SALES', fm.data?.inventory_sales?.latest?.ratio, '', (fm.data?.inventory_sales?.series ?? []).map(p => p.ratio), fm.data?.inventory_sales?._stale)}
            {stat('CASS SHIPMENTS', idx.cass_shipments?.latest?.value, '', (idx.cass_shipments?.series ?? []).map(o => o.value), fm.data?.freight_indices?._stale)}
            {stat('TRUCK TONNAGE', idx.truck_tonnage?.latest?.value, '', (idx.truck_tonnage?.series ?? []).map(o => o.value), fm.data?.freight_indices?._stale)}
          </Section>
        </div>
      </div>
      <div style={{ fontFamily: L.sans, fontSize: 9.5, color: L.faint, marginTop: 8 }}>
        Marker size ∝ value within its layer. Live cargo ships (AIS) + chokepoints (IMF PortWatch), air hubs from OpenSky (~12h lag), LSCI ports from World Bank/UNCTAD. Freight-macro indices are US national aggregates (Census, FRED). Tankers and LNG carriers live on the Energy Flows map.
      </div>
    </PageWrapper>
  )
}
