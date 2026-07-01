import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { MapContainer, TileLayer, Polyline, CircleMarker, Popup, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import PageWrapper from '../components/PageWrapper'

const T = {
  bg: 'var(--theme-bg, #101c2e)', surface: 'var(--theme-surface, #0d1826)',
  border: 'var(--theme-border, rgba(255,255,255,0.09))', borderFaint: 'var(--theme-border-faint, rgba(255,255,255,0.05))',
  text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)',
  faint: 'var(--theme-text-faint, rgba(255,255,255,0.4))', gold: 'var(--theme-primary, #c9a84c)',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

// Vessel classification colors (crude tanker green, LNG blue, cargo yellow).
const VESSEL_COLOR: Record<string, string> = {
  tanker: '#22c55e', lng: '#3b82f6', cargo: '#eab308', other: '#94a3b8',
}
const VESSEL_LABEL: Record<string, string> = {
  tanker: 'Crude Tanker', lng: 'LNG / Gas Carrier', cargo: 'Cargo / Dry Bulk', other: 'Other',
}
const PORT_COLOR = { oil: '#8b1a1a', lng: '#c084fc' } as const
// Concrete hex for Leaflet SVG paths — CSS var() is unreliable in SVG presentation
// attributes. Chokepoint gold is a fixed semantic marker color, not theme chrome.
const CHOKE_COLOR = '#c9a84c'

interface Vessel {
  mmsi: string; name?: string; lat: number; lon: number; sog?: number; cog?: number
  heading?: number; destination?: string; category?: string; time_utc?: string
}
interface Chokepoint { id: string; name: string; lat: number; lon: number; oil_mbd: number; note: string }
interface Port { name: string; country: string; lat: number; lon: number; kind: 'oil' | 'lng'; throughput: string }
interface Pipeline { name: string; substance: string; coords: [number, number][] }

const DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const TILE_ATTR = '&copy; OpenStreetMap &copy; CARTO'

function FocusController({ focus }: { focus: { lat: number; lon: number; zoom: number } | null }) {
  const map = useMap()
  useEffect(() => {
    if (focus) map.flyTo([focus.lat, focus.lon], focus.zoom, { duration: 1.2 })
  }, [focus, map])
  return null
}

const chip: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: T.muted,
}

function Toggle({ label, color, on, onChange }: { label: string; color?: string; on: boolean; onChange: () => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', padding: '5px 0' }}>
      <input type="checkbox" checked={on} onChange={onChange} style={{ accentColor: T.gold, width: 14, height: 14, cursor: 'pointer' }} />
      {color && <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flex: 'none' }} />}
      <span style={{ fontFamily: T.sans, fontSize: 12, color: on ? T.text : T.muted }}>{label}</span>
    </label>
  )
}

export function MaritimeMapContent() {
  const [layers, setLayers] = useState({ pipelines: true, tanker: true, lng: true, cargo: true, ports: true, chokepoints: true })
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom: number } | null>(null)
  const toggle = (k: keyof typeof layers) => setLayers(s => ({ ...s, [k]: !s[k] }))

  const choke = useQuery<{ chokepoints: Chokepoint[] }>({ queryKey: ['mar-choke'], queryFn: () => axios.get('/api/maritime/chokepoints').then(r => r.data), staleTime: Infinity })
  const ports = useQuery<{ ports: Port[] }>({ queryKey: ['mar-ports'], queryFn: () => axios.get('/api/maritime/ports').then(r => r.data), staleTime: Infinity })
  const pipes = useQuery<{ pipelines: Pipeline[]; colors: Record<string, string> }>({ queryKey: ['mar-pipes'], queryFn: () => axios.get('/api/maritime/pipelines').then(r => r.data), staleTime: 60 * 60 * 1000 })
  const vess = useQuery<{ vessels: Vessel[]; count: number; status: { key_present: boolean; connected: boolean } }>({
    queryKey: ['mar-vessels'], queryFn: () => axios.get('/api/maritime/vessels').then(r => r.data),
    refetchInterval: 8000, staleTime: 4000,
  })

  const catShown = (c?: string) => {
    const k = c === 'tanker' ? 'tanker' : c === 'lng' ? 'lng' : 'cargo'   // 'other' rides the cargo toggle
    return layers[k as 'tanker' | 'lng' | 'cargo']
  }
  const vessels = (vess.data?.vessels ?? []).filter(v => catShown(v.category))
  const keyMissing = vess.data?.status && !vess.data.status.key_present

  return (
    <div style={{ display: 'flex', gap: 14, height: '78vh', minHeight: 520 }}>
      {/* Leaflet's chrome ships light by default — retint it for the dark terminal. */}
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
        .leaflet-bar a, .leaflet-bar a:hover {
          background: var(--theme-surface, #0d1826); color: var(--theme-text, #d7e3fc);
          border-color: var(--theme-border, rgba(255,255,255,0.14));
        }
        .leaflet-control-attribution {
          background: rgba(0,0,0,0.5) !important; color: var(--theme-secondary, #8099b0) !important;
        }
        .leaflet-control-attribution a { color: var(--theme-primary, #c9a84c) !important; }
      `}</style>
      {/* Controls */}
      <div style={{ width: 232, flex: 'none', display: 'flex', flexDirection: 'column', gap: 16, background: T.surface, border: `1px solid ${T.border}`, padding: '16px 16px', overflowY: 'auto' }}>
        <div>
          <div style={{ ...chip, marginBottom: 8 }}>Jump To</div>
          <select
            value={focus ? 'set' : ''}
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
          <Toggle label="Pipelines" on={layers.pipelines} onChange={() => toggle('pipelines')} />
          <Toggle label="Export terminals" color={PORT_COLOR.oil} on={layers.ports} onChange={() => toggle('ports')} />
          <Toggle label="Chokepoints" color={T.gold} on={layers.chokepoints} onChange={() => toggle('chokepoints')} />
        </div>

        <div>
          <div style={{ ...chip, marginBottom: 4 }}>Live Vessels</div>
          <Toggle label="Crude tankers" color={VESSEL_COLOR.tanker} on={layers.tanker} onChange={() => toggle('tanker')} />
          <Toggle label="LNG carriers" color={VESSEL_COLOR.lng} on={layers.lng} onChange={() => toggle('lng')} />
          <Toggle label="Cargo / dry bulk" color={VESSEL_COLOR.cargo} on={layers.cargo} onChange={() => toggle('cargo')} />
        </div>

        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: vess.data?.status?.connected ? VESSEL_COLOR.tanker : T.faint }} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>{vess.data?.count ?? 0} vessels live</span>
          </div>
          {keyMissing && (
            <div style={{ fontFamily: T.sans, fontSize: 10, color: T.faint, lineHeight: '15px' }}>
              Live AIS is idle. Set <span style={{ color: T.gold }}>AISSTREAM_API_KEY</span> on the server to stream vessels around Malacca, Suez, Panama, and Hormuz.
            </div>
          )}
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, minWidth: 0, border: `1px solid ${T.border}`, position: 'relative' }}>
        <MapContainer center={[20, 30]} zoom={2} minZoom={2} worldCopyJump style={{ height: '100%', width: '100%', background: T.bg }}>
          <TileLayer url={DARK_TILES} attribution={TILE_ATTR} />
          <FocusController focus={focus} />

          {layers.pipelines && pipes.data?.pipelines.map((p, i) => (
            <Polyline key={`pipe-${i}`} positions={p.coords} pathOptions={{ color: pipes.data!.colors[p.substance] ?? '#6b7280', weight: 2.5, opacity: 0.85 }}>
              <Tooltip sticky>{p.name} · {p.substance === 'gas' ? 'Natural gas' : p.substance === 'oil' ? 'Crude oil' : p.substance}</Tooltip>
            </Polyline>
          ))}

          {layers.ports && ports.data?.ports.map(p => (
            <CircleMarker key={`port-${p.name}`} center={[p.lat, p.lon]} radius={5}
              pathOptions={{ color: PORT_COLOR[p.kind], fillColor: PORT_COLOR[p.kind], fillOpacity: 0.85, weight: 1 }}>
              <Tooltip>
                <b>{p.name}</b> — {p.country}<br />{p.kind.toUpperCase()} terminal · {p.throughput}
              </Tooltip>
            </CircleMarker>
          ))}

          {layers.chokepoints && choke.data?.chokepoints.map(c => (
            <CircleMarker key={`cp-${c.id}`} center={[c.lat, c.lon]} radius={8}
              pathOptions={{ color: CHOKE_COLOR, fillColor: CHOKE_COLOR, fillOpacity: 0.18, weight: 2 }}>
              <Tooltip>
                <b>{c.name}</b><br />~{c.oil_mbd} Mb/d oil transit<br />{c.note}
              </Tooltip>
            </CircleMarker>
          ))}

          {vessels.map(v => {
            const col = VESSEL_COLOR[v.category ?? 'other'] ?? VESSEL_COLOR.other
            return (
              <CircleMarker key={`v-${v.mmsi}`} center={[v.lat, v.lon]} radius={4}
                pathOptions={{ color: col, fillColor: col, fillOpacity: 0.9, weight: 1 }}>
                <Popup>
                  <div style={{ fontFamily: 'var(--theme-mono, monospace)', fontSize: 12, minWidth: 180 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>{v.name || `MMSI ${v.mmsi}`}</div>
                    <TelemetryRow k="Type" val={VESSEL_LABEL[v.category ?? 'other']} />
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
