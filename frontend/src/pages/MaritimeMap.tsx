import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import PageWrapper from '../components/PageWrapper'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.09))',
  text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)',
  faint: 'var(--theme-text-faint, rgba(255,255,255,0.4))', gold: 'var(--theme-primary, #c9a84c)',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

// Fixed semantic marker colors (concrete hex — CSS var() is unreliable in Leaflet SVG paths).
const VESSEL_COLOR: Record<string, string> = { tanker: '#22c55e', lng: '#3b82f6', cargo: '#eab308', other: '#94a3b8' }
const VESSEL_LABEL: Record<string, string> = { tanker: 'Crude Tanker', lng: 'LNG / Gas Carrier', cargo: 'Cargo / Dry Bulk', other: 'Other' }
const PIPE_COLOR: Record<string, string> = { gas: '#f59e0b', oil: '#8b1a1a', product: '#c084fc', other: '#6b7280' }
const PORT_COLOR = { oil: '#8b1a1a', lng: '#c084fc' } as const
const CHOKE_COLOR = '#c9a84c'
const OSM_PORT_COLOR = '#2dd4bf'
const LNG_TERM_COLOR = '#38bdf8'
const WPI_COLOR = '#64748b'
const DETAIL_MIN_ZOOM = 5          // gate rate-limited/heavy layers to zoomed-in views

interface Vessel {
  mmsi: string; name?: string; lat: number; lon: number; sog?: number; cog?: number
  heading?: number; destination?: string; category?: string; time_utc?: string
}
interface Chokepoint { id: string; name: string; lat: number; lon: number; oil_mbd: number; note: string }
interface Port { name: string; country: string; lat: number; lon: number; kind: 'oil' | 'lng'; throughput: string }
interface Pipeline { name: string; substance: string; coords: [number, number][] }
interface LngTerm { n: string; la: number; lo: number; st: string; ie: string; cap: number | null }
interface WpiPort { n: string; la: number; lo: number; c: string; s: string }

const DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const TILE_ATTR = '&copy; OpenStreetMap &copy; CARTO'

function FocusController({ focus }: { focus: { lat: number; lon: number; zoom: number } | null }) {
  const map = useMap()
  useEffect(() => { if (focus) map.flyTo([focus.lat, focus.lon], focus.zoom, { duration: 1.2 }) }, [focus, map])
  return null
}

function ViewportWatcher({ onChange }: { onChange: (bbox: string, zoom: number) => void }) {
  const map = useMap()
  const emit = () => {
    const b = map.getBounds()
    onChange(`${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`, map.getZoom())
  }
  useMapEvents({ moveend: emit })
  useEffect(() => { emit() }, [])   // emit the initial viewport once
  return null
}

const chip: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }

function Toggle({ label, color, on, onChange }: { label: string; color?: string; on: boolean; onChange: () => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', padding: '4px 0' }}>
      <input type="checkbox" checked={on} onChange={onChange} style={{ accentColor: T.gold, width: 14, height: 14, cursor: 'pointer' }} />
      {color && <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flex: 'none' }} />}
      <span style={{ fontFamily: T.sans, fontSize: 12, color: on ? T.text : T.muted }}>{label}</span>
    </label>
  )
}

export function MaritimeMapContent() {
  const [layers, setLayers] = useState({
    pipelines: true, lngTerminals: true, terminals: true, worldPorts: false, chokepoints: true,
    osm: false, eia: false,
    tanker: true, lngShip: true, cargo: true, unclassified: false,
  })
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom: number } | null>(null)
  const [view, setView] = useState<{ bbox: string; zoom: number } | null>(null)
  const [gemPipes, setGemPipes] = useState<Pipeline[]>([])
  const [osmPipes, setOsmPipes] = useState<Pipeline[]>([])
  const [osmPorts, setOsmPorts] = useState<{ name: string; lat: number; lon: number }[]>([])
  const [eiaPipes, setEiaPipes] = useState<Pipeline[]>([])
  const [worldPorts, setWorldPorts] = useState<WpiPort[]>([])
  const toggle = (k: keyof typeof layers) => setLayers(s => ({ ...s, [k]: !s[k] }))

  // Combined, debounced viewport fetch for the bbox-driven layers.
  useEffect(() => {
    if (!view) return
    const { bbox, zoom } = view
    const t = setTimeout(() => {
      if (layers.pipelines) {
        const url = zoom < 4 ? '/api/maritime/pipelines?source=gem' : `/api/maritime/pipelines?source=gem&bbox=${bbox}`
        axios.get(url).then(r => setGemPipes(r.data.pipelines || [])).catch(() => {})
      }
      if (layers.osm && zoom >= DETAIL_MIN_ZOOM) {
        axios.get(`/api/maritime/pipelines?source=osm&bbox=${bbox}`).then(r => setOsmPipes(r.data.pipelines || [])).catch(() => {})
        axios.get(`/api/maritime/ports?bbox=${bbox}`).then(r => setOsmPorts(r.data.osm_ports || [])).catch(() => {})
      }
      if (layers.eia && zoom >= DETAIL_MIN_ZOOM) {
        axios.get(`/api/maritime/pipelines?source=eia&bbox=${bbox}`).then(r => setEiaPipes(r.data.pipelines || [])).catch(() => {})
      }
      if (layers.worldPorts) {
        axios.get(`/api/maritime/world-ports?bbox=${bbox}`).then(r => setWorldPorts(r.data.ports || [])).catch(() => {})
      }
    }, 500)
    return () => clearTimeout(t)
  }, [view, layers.pipelines, layers.osm, layers.eia, layers.worldPorts])

  // Clear layer data the moment its toggle goes off.
  useEffect(() => { if (!layers.pipelines) setGemPipes([]) }, [layers.pipelines])
  useEffect(() => { if (!layers.osm) { setOsmPipes([]); setOsmPorts([]) } }, [layers.osm])
  useEffect(() => { if (!layers.eia) setEiaPipes([]) }, [layers.eia])
  useEffect(() => { if (!layers.worldPorts) setWorldPorts([]) }, [layers.worldPorts])

  const choke = useQuery<{ chokepoints: Chokepoint[] }>({ queryKey: ['mar-choke'], queryFn: () => axios.get('/api/maritime/chokepoints').then(r => r.data), staleTime: Infinity })
  const ports = useQuery<{ ports: Port[] }>({ queryKey: ['mar-ports'], queryFn: () => axios.get('/api/maritime/ports').then(r => r.data), staleTime: Infinity })
  const lngQ = useQuery<{ lng: LngTerm[] }>({ queryKey: ['mar-lng'], queryFn: () => axios.get('/api/maritime/lng').then(r => r.data), staleTime: Infinity })
  const vess = useQuery<{ vessels: Vessel[]; count: number; status: { key_present: boolean; connected: boolean } }>({
    queryKey: ['mar-vessels'], queryFn: () => axios.get('/api/maritime/vessels').then(r => r.data),
    refetchInterval: 8000, staleTime: 4000,
  })

  const catShown = (c?: string) => {
    if (c === 'tanker') return layers.tanker
    if (c === 'lng') return layers.lngShip
    if (c === 'cargo') return layers.cargo
    return layers.unclassified
  }
  const vessels = (vess.data?.vessels ?? []).filter(v => catShown(v.category))
  const keyMissing = vess.data?.status && !vess.data.status.key_present
  const pcol = (s: string) => PIPE_COLOR[s] ?? PIPE_COLOR.other
  const zoomHint = layers.osm || layers.eia
  const needZoom = zoomHint && (view?.zoom ?? 0) < DETAIL_MIN_ZOOM

  return (
    <div style={{ display: 'flex', gap: 14, height: '80vh', minHeight: 540 }}>
      <style>{`
        .leaflet-popup-content-wrapper, .leaflet-popup-tip, .leaflet-tooltip {
          background: var(--theme-surface, #0d1826); color: var(--theme-text, #d7e3fc);
          border: 1px solid var(--theme-border, rgba(255,255,255,0.14)); border-radius: 2px;
          box-shadow: 0 6px 22px rgba(0,0,0,0.55);
        }
        .leaflet-popup-content { margin: 10px 12px; }
        .leaflet-tooltip { font-family: var(--theme-sans); font-size: 11px; box-shadow: none; }
        .leaflet-tooltip-top:before { border-top-color: var(--theme-border, rgba(255,255,255,0.14)); }
        .leaflet-tooltip-bottom:before { border-bottom-color: var(--theme-border, rgba(255,255,255,0.14)); }
        .leaflet-tooltip-left:before { border-left-color: var(--theme-border, rgba(255,255,255,0.14)); }
        .leaflet-tooltip-right:before { border-right-color: var(--theme-border, rgba(255,255,255,0.14)); }
        .leaflet-container a.leaflet-popup-close-button { color: var(--theme-secondary, #8099b0); }
        .leaflet-bar a, .leaflet-bar a:hover { background: var(--theme-surface, #0d1826); color: var(--theme-text, #d7e3fc); border-color: var(--theme-border, rgba(255,255,255,0.14)); }
        .leaflet-control-attribution { background: rgba(0,0,0,0.5) !important; color: var(--theme-secondary, #8099b0) !important; }
        .leaflet-control-attribution a { color: var(--theme-primary, #c9a84c) !important; }
      `}</style>

      {/* Controls */}
      <div style={{ width: 236, flex: 'none', display: 'flex', flexDirection: 'column', gap: 14, background: T.surface, border: `1px solid ${T.border}`, padding: '16px 16px', overflowY: 'auto' }}>
        <div>
          <div style={{ ...chip, marginBottom: 8 }}>Jump To</div>
          <select
            value=""
            onChange={e => {
              const id = e.target.value
              if (id === 'global') { setFocus({ lat: 20, lon: 30, zoom: 2 }); return }
              const c = choke.data?.chokepoints.find(x => x.id === id)
              if (c) setFocus({ lat: c.lat, lon: c.lon, zoom: 7 })
            }}
            style={{ width: '100%', background: T.bg, color: T.text, border: `1px solid ${T.border}`, fontFamily: T.sans, fontSize: 12, padding: '7px 8px' }}
          >
            <option value="" disabled>Select a chokepoint…</option>
            <option value="global">Global view</option>
            {choke.data?.chokepoints.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        <div>
          <div style={{ ...chip, marginBottom: 4 }}>Infrastructure</div>
          <Toggle label="Pipelines (GEM)" color={PIPE_COLOR.gas} on={layers.pipelines} onChange={() => toggle('pipelines')} />
          <Toggle label="LNG terminals" color={LNG_TERM_COLOR} on={layers.lngTerminals} onChange={() => toggle('lngTerminals')} />
          <Toggle label="Export terminals" color={PORT_COLOR.oil} on={layers.terminals} onChange={() => toggle('terminals')} />
          <Toggle label="World ports (WPI)" color={WPI_COLOR} on={layers.worldPorts} onChange={() => toggle('worldPorts')} />
          <Toggle label="Chokepoints" color={CHOKE_COLOR} on={layers.chokepoints} onChange={() => toggle('chokepoints')} />
        </div>

        <div>
          <div style={{ ...chip, marginBottom: 4 }}>Overlays</div>
          <Toggle label="OSM infrastructure" color={OSM_PORT_COLOR} on={layers.osm} onChange={() => toggle('osm')} />
          <Toggle label="US pipelines (EIA)" on={layers.eia} onChange={() => toggle('eia')} />
          {needZoom && <div style={{ fontFamily: T.sans, fontSize: 9.5, color: T.faint, lineHeight: '14px', paddingLeft: 23 }}>Zoom in to load OSM / EIA detail.</div>}
        </div>

        <div>
          <div style={{ ...chip, marginBottom: 4 }}>Live Vessels</div>
          <Toggle label="Crude tankers" color={VESSEL_COLOR.tanker} on={layers.tanker} onChange={() => toggle('tanker')} />
          <Toggle label="LNG carriers" color={VESSEL_COLOR.lng} on={layers.lngShip} onChange={() => toggle('lngShip')} />
          <Toggle label="Cargo / dry bulk" color={VESSEL_COLOR.cargo} on={layers.cargo} onChange={() => toggle('cargo')} />
          <Toggle label="Unclassified" color={VESSEL_COLOR.other} on={layers.unclassified} onChange={() => toggle('unclassified')} />
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: vess.data?.status?.connected ? VESSEL_COLOR.tanker : T.faint }} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{vess.data?.count ?? 0} vessels live</span>
          </div>
          {keyMissing && (
            <div style={{ fontFamily: T.sans, fontSize: 10, color: T.faint, lineHeight: '15px' }}>
              Live AIS idle. Set <span style={{ color: T.gold }}>AISSTREAM_API_KEY</span> to stream vessels.
            </div>
          )}
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, minWidth: 0, border: `1px solid ${T.border}`, position: 'relative' }}>
        <MapContainer center={[20, 30]} zoom={2} minZoom={2} worldCopyJump preferCanvas style={{ height: '100%', width: '100%', background: T.bg }}>
          <TileLayer url={DARK_TILES} attribution={TILE_ATTR} />
          <FocusController focus={focus} />
          <ViewportWatcher onChange={(bbox, zoom) => setView({ bbox, zoom })} />

          {layers.pipelines && gemPipes.map((p, i) => (
            <Polyline key={`gem-${i}`} positions={p.coords} pathOptions={{ color: pcol(p.substance), weight: 2, opacity: 0.85 }}>
              <Tooltip sticky>{p.name} · {p.substance === 'gas' ? 'Natural gas' : p.substance === 'oil' ? 'Crude / NGL' : p.substance} · GEM</Tooltip>
            </Polyline>
          ))}

          {layers.eia && eiaPipes.map((p, i) => (
            <Polyline key={`eia-${i}`} positions={p.coords} pathOptions={{ color: PIPE_COLOR.gas, weight: 1.5, opacity: 0.6 }}>
              <Tooltip sticky>{p.name} · US gas · EIA</Tooltip>
            </Polyline>
          ))}

          {layers.osm && osmPipes.map((p, i) => (
            <Polyline key={`osm-${i}`} positions={p.coords} pathOptions={{ color: pcol(p.substance), weight: 2, opacity: 0.7, dashArray: '4 4' }}>
              <Tooltip sticky>{p.name} · {p.substance} · OSM</Tooltip>
            </Polyline>
          ))}

          {layers.osm && osmPorts.map((p, i) => (
            <CircleMarker key={`osmport-${i}`} center={[p.lat, p.lon]} radius={3} pathOptions={{ color: OSM_PORT_COLOR, fillColor: OSM_PORT_COLOR, fillOpacity: 0.75, weight: 1 }}>
              <Tooltip>{p.name} <span style={{ opacity: 0.6 }}>· OSM port</span></Tooltip>
            </CircleMarker>
          ))}

          {layers.worldPorts && worldPorts.map((p, i) => (
            <CircleMarker key={`wpi-${i}`} center={[p.la, p.lo]} radius={2.5} pathOptions={{ color: WPI_COLOR, fillColor: WPI_COLOR, fillOpacity: 0.8, weight: 0.5 }}>
              <Tooltip>{p.n}{p.c ? ` · ${p.c}` : ''}{p.s ? ` · ${p.s} harbour` : ''} <span style={{ opacity: 0.6 }}>· WPI</span></Tooltip>
            </CircleMarker>
          ))}

          {layers.lngTerminals && lngQ.data?.lng.map((t, i) => (
            <CircleMarker key={`lng-${i}`} center={[t.la, t.lo]} radius={4} pathOptions={{ color: LNG_TERM_COLOR, fillColor: LNG_TERM_COLOR, fillOpacity: 0.85, weight: 1 }}>
              <Tooltip>
                <b>{t.n}</b><br />LNG terminal{t.ie ? ` · ${t.ie}` : ''} · {t.st}{t.cap ? `<br />~${t.cap} Mtpa` : ''}
              </Tooltip>
            </CircleMarker>
          ))}

          {layers.terminals && ports.data?.ports.map(p => (
            <CircleMarker key={`term-${p.name}`} center={[p.lat, p.lon]} radius={5} pathOptions={{ color: PORT_COLOR[p.kind], fillColor: PORT_COLOR[p.kind], fillOpacity: 0.85, weight: 1 }}>
              <Tooltip><b>{p.name}</b> — {p.country}<br />{p.kind.toUpperCase()} terminal · {p.throughput}</Tooltip>
            </CircleMarker>
          ))}

          {layers.chokepoints && choke.data?.chokepoints.map(c => (
            <CircleMarker key={`cp-${c.id}`} center={[c.lat, c.lon]} radius={8} pathOptions={{ color: CHOKE_COLOR, fillColor: CHOKE_COLOR, fillOpacity: 0.18, weight: 2 }}>
              <Tooltip><b>{c.name}</b><br />~{c.oil_mbd} Mb/d oil transit<br />{c.note}</Tooltip>
            </CircleMarker>
          ))}

          {vessels.map(v => {
            const cat = v.category ?? 'other'
            const col = VESSEL_COLOR[cat] ?? VESSEL_COLOR.other
            const unknown = cat === 'other'
            return (
              <CircleMarker key={`v-${v.mmsi}`} center={[v.lat, v.lon]} radius={unknown ? 3 : 4} pathOptions={{ color: col, fillColor: col, fillOpacity: unknown ? 0.5 : 0.9, weight: 1 }}>
                <Popup>
                  <div style={{ fontFamily: 'var(--theme-mono, monospace)', fontSize: 12, minWidth: 180 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{v.name || `MMSI ${v.mmsi}`}</div>
                    <TelemetryRow k="Type" val={VESSEL_LABEL[cat]} />
                    <TelemetryRow k="Destination" val={v.destination || '—'} />
                    <TelemetryRow k="Speed" val={v.sog != null ? `${v.sog.toFixed(1)} kn` : '—'} />
                    <TelemetryRow k="Heading" val={v.heading != null && v.heading !== 511 ? `${v.heading}°` : v.cog != null ? `${v.cog.toFixed(0)}° (COG)` : '—'} />
                    <TelemetryRow k="Updated" val={v.time_utc ? new Date(v.time_utc).toLocaleTimeString() : '—'} />
                  </div>
                </Popup>
              </CircleMarker>
            )
          })}
        </MapContainer>
      </div>
    </div>
  )
}

function TelemetryRow({ k, val }: { k: string; val: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, lineHeight: '18px' }}>
      <span style={{ color: 'var(--theme-secondary, #8099b0)' }}>{k}</span><span style={{ fontWeight: 600 }}>{val}</span>
    </div>
  )
}

export default function MaritimeMap() {
  return <PageWrapper title="Global Flows Map"><MaritimeMapContent /></PageWrapper>
}
