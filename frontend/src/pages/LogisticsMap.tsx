import { useState, useEffect } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { MapContainer, CircleMarker, Tooltip, useMap } from 'react-leaflet'
import Lf from 'leaflet'
import 'leaflet/dist/leaflet.css'
import PageWrapper from '../components/PageWrapper'
import { readToken } from '../lib/theme'
import { L, Spark, StaleDot } from '../components/logi'

// Logistics Map — the geographic overview for the Geo-Logistics hub. Air-cargo
// hubs, canal chokepoints, and liner-connectivity ports are the map's markers;
// the non-geographic freight-macro indices ride an edge stat strip (they're US
// national aggregates, not points). Reuses the /flows-map react-leaflet basemap.

// OCEAN is CSS-only (map background) so a var() is fine. The Leaflet SVG colors
// (land + markers) can't consume var() and are resolved via readToken in-component.
const OCEAN = 'var(--theme-bg, #0b1626)'
const COAST = 'rgba(120,150,185,0.16)'

const AIRPORTS: Record<string, [number, number]> = {
  KMEM: [35.04, -89.98], KSDF: [38.17, -85.74], EDDF: [50.03, 8.57], VHHH: [22.31, 113.91],
}
const CHOKES: Record<string, { lat: number; lon: number; name: string }> = {
  suez: { lat: 30.42, lon: 32.35, name: 'Suez Canal' },
  panama: { lat: 9.08, lon: -79.68, name: 'Panama Canal' },
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

interface Air { hubs?: { icao: string; city: string; movements: number; by_operator: Record<string, number> }[]; _stale?: boolean }
interface MF { lsci?: { economies?: { country: string; lsci: number }[]; _stale?: boolean }; wci?: { composite_usd_per_40ft?: number; _stale?: boolean }; chokepoints?: { chokepoints?: Record<string, { latest?: { total: number | null } }>; _stale?: boolean } }
interface FM { inventory_sales?: { latest?: { ratio: number }; series?: { ratio: number }[]; _stale?: boolean }; freight_indices?: { indices?: Record<string, { latest?: { value: number }; series?: { value: number }[] }>; _stale?: boolean } }

function Dot({ c }: { c: string }) { return <span style={{ width: 9, height: 9, borderRadius: '50%', background: c, flex: 'none' }} /> }

export default function LogisticsMap() {
  const [layers, setLayers] = useState({ air: true, choke: true, port: true })
  // Leaflet needs concrete colors, not CSS var() — resolved here so they track presets.
  const AIR = readToken('--theme-tertiary', '#60a5fa')
  const CHOKE = readToken('--theme-primary', '#c9a84c')
  const PORT = readToken('--theme-positive', '#3fb6a0')
  const LAND = readToken('--theme-surface', '#0f1d31')
  const air = useQuery<Air>({ queryKey: ['lm-air'], queryFn: () => axios.get('/api/logistics/air-cargo/vulnerability').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const mf = useQuery<MF>({ queryKey: ['lm-mf'], queryFn: () => axios.get('/api/logistics/maritime-freight').then(r => r.data), staleTime: 6 * 3600e3, retry: 1 })
  const fm = useQuery<FM>({ queryKey: ['lm-fm'], queryFn: () => axios.get('/api/logistics/freight-macro').then(r => r.data), staleTime: 12 * 3600e3, retry: 1 })

  const hubs = air.data?.hubs ?? []
  const maxAir = Math.max(1, ...hubs.map(h => h.movements))
  const econ = mf.data?.lsci?.economies ?? []
  const maxLsci = Math.max(1, ...econ.map(e => e.lsci))
  const chokeData = mf.data?.chokepoints?.chokepoints ?? {}
  const maxChoke = Math.max(1, ...Object.values(chokeData).map(c => c.latest?.total ?? 0))
  const idx = fm.data?.freight_indices?.indices ?? {}

  const stat = (label: string, val?: number | null, unit?: string, series?: number[], stale?: boolean) => (
    <div style={{ padding: '8px 0', borderBottom: `1px solid ${L.border}` }}>
      <div style={{ fontFamily: L.mono, fontSize: 8.5, letterSpacing: '0.08em', color: L.faint, marginBottom: 3 }}>{label}<StaleDot stale={stale} /></div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontFamily: L.mono, fontSize: 19, fontWeight: 700, color: L.text }}>{val != null ? val.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}{unit && <span style={{ fontSize: 9, color: L.sec, fontWeight: 400 }}> {unit}</span>}</span>
        {series && series.length > 1 && <Spark data={series} w={72} h={22} color={L.sec} />}
      </div>
    </div>
  )

  return (
    <PageWrapper>
      <style>{`.lm-map { background: ${OCEAN}; } .lm-map .leaflet-tooltip { background: var(--theme-surface); color: var(--theme-text); border: 1px solid var(--theme-border); font-family: var(--theme-mono); font-size: 11px; }`}</style>
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontFamily: L.mono, fontSize: 15, fontWeight: 700, letterSpacing: '0.2em', color: L.gold }}>LOGISTICS MAP</div>
          <div style={{ fontFamily: L.sans, fontSize: 11, color: L.sec, marginTop: 5 }}>Cargo hubs, canal chokepoints, and connectivity ports — the physical trade network on one map.</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {([['air', 'Air hubs', AIR], ['choke', 'Chokepoints', CHOKE], ['port', 'LSCI ports', PORT]] as const).map(([k, lbl, c]) => (
            <button key={k} onClick={() => setLayers(s => ({ ...s, [k]: !s[k] }))}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', cursor: 'pointer', background: 'transparent', border: `1px solid ${layers[k] ? c : L.border}`, color: layers[k] ? L.text : L.faint, fontFamily: L.mono, fontSize: 10, fontWeight: 700 }}>
              <Dot c={c} />{lbl}
            </button>
          ))}
        </div>
      </div>

      <div style={{ position: 'relative', height: '74vh', minHeight: 460, border: `1px solid ${L.border}`, borderRadius: 6, overflow: 'hidden' }}>
        <MapContainer className="lm-map" center={[26, 30]} zoom={2.1} minZoom={2} maxZoom={6} worldCopyJump preferCanvas style={{ height: '100%', width: '100%' }}>
          <SizeFix />
          <Basemap land={LAND} />
          {layers.port && econ.map(e => { const p = PORTS[e.country]; return p && (
            <CircleMarker key={`p-${e.country}`} center={[p.lat, p.lon]} radius={radius(e.lsci, maxLsci)} pathOptions={{ color: PORT, fillColor: PORT, fillOpacity: 0.35, weight: 1 }}>
              <Tooltip>{p.port} · LSCI {e.lsci.toFixed(1)}</Tooltip>
            </CircleMarker>
          )})}
          {layers.choke && Object.entries(chokeData).map(([id, c]) => { const g = CHOKES[id]; const t = c.latest?.total ?? 0; return g && (
            <CircleMarker key={`c-${id}`} center={[g.lat, g.lon]} radius={radius(t, maxChoke)} pathOptions={{ color: CHOKE, fillColor: CHOKE, fillOpacity: 0.4, weight: 1 }}>
              <Tooltip>{g.name} · {t} transits/d</Tooltip>
            </CircleMarker>
          )})}
          {layers.air && hubs.map(h => { const a = AIRPORTS[h.icao]; return a && (
            <CircleMarker key={`a-${h.icao}`} center={a} radius={radius(h.movements, maxAir)} pathOptions={{ color: AIR, fillColor: AIR, fillOpacity: 0.4, weight: 1 }}>
              <Tooltip>{h.city} ({h.icao}) · {h.movements} freighter moves/24h<br />{Object.entries(h.by_operator).map(([o, n]) => `${o} ${n}`).join(' · ')}</Tooltip>
            </CircleMarker>
          )})}
        </MapContainer>

        {/* Freight-macro edge strip — national aggregates, not points */}
        <div style={{ position: 'absolute', top: 12, right: 12, width: 210, background: 'color-mix(in srgb, var(--theme-surface) 94%, transparent)', border: `1px solid ${L.border}`, borderRadius: 5, padding: '10px 12px', zIndex: 500, pointerEvents: 'auto' }}>
          <div style={{ fontFamily: L.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: L.gold, marginBottom: 4 }}>FREIGHT MACRO</div>
          {stat('DREWRY WCI', mf.data?.wci?.composite_usd_per_40ft, '$/40ft', undefined, mf.data?.wci?._stale)}
          {stat('INVENTORIES / SALES', fm.data?.inventory_sales?.latest?.ratio, '', (fm.data?.inventory_sales?.series ?? []).map(p => p.ratio), fm.data?.inventory_sales?._stale)}
          {stat('CASS SHIPMENTS', idx.cass_shipments?.latest?.value, '', (idx.cass_shipments?.series ?? []).map(o => o.value), fm.data?.freight_indices?._stale)}
          {stat('TRUCK TONNAGE', idx.truck_tonnage?.latest?.value, '', (idx.truck_tonnage?.series ?? []).map(o => o.value), fm.data?.freight_indices?._stale)}
        </div>
      </div>
      <div style={{ fontFamily: L.sans, fontSize: 9.5, color: L.faint, marginTop: 8 }}>
        Marker size ∝ value within its layer. Air hubs (OpenSky, ~12h lag), chokepoints (IMF PortWatch), LSCI ports (World Bank/UNCTAD). Freight-macro indices are US national aggregates and ride the strip, not the map.
      </div>
    </PageWrapper>
  )
}
