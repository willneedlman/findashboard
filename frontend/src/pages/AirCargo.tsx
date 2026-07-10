import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import { L, Card, PageHead } from '../components/logi'

// Air Cargo Vulnerability — freighter movements at the four global cargo hubs from
// OpenSky. Community ADS-B: undercounts, ~12h lag; a relative signal, not a manifest.

interface Hub { icao: string; city: string; movements: number; by_operator: Record<string, number> }
interface Payload { configured?: boolean; note?: string; source?: string; _stale?: boolean; hubs?: Hub[] }

export default function AirCargo() {
  const q = useQuery<Payload>({
    queryKey: ['logi-air-cargo'],
    queryFn: () => axios.get('/api/logistics/air-cargo/vulnerability').then(r => r.data),
    staleTime: 6 * 3600 * 1000, retry: 1,
  })
  const hubs = q.data?.hubs ?? []
  const maxMv = hubs.length ? Math.max(...hubs.map(h => h.movements), 1) : 1

  return (
    <PageWrapper>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PageHead title="AIR CARGO VULNERABILITY" sub="Freighter frequency at the major cargo hubs — a drop signals supply-chain stress." />

        {q.isLoading ? <div style={{ fontFamily: L.mono, fontSize: 12, color: L.sec, padding: 40 }}>Loading…</div>
          : q.data?.configured === false ? (
            <Card title="NOT CONFIGURED">
              <div style={{ fontFamily: L.sans, fontSize: 12, color: L.sec }}>{q.data.note}</div>
            </Card>
          ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {hubs.map(h => (
              <Card key={h.icao} title={`${h.city.toUpperCase()} · ${h.icao}`} stale={q.data?._stale}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontFamily: L.mono, fontSize: 30, fontWeight: 700, color: L.text }}>{h.movements}</span>
                  <span style={{ fontFamily: L.sans, fontSize: 10, color: L.sec }}>freighter movements · 24h</span>
                </div>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {Object.entries(h.by_operator).sort((a, b) => b[1] - a[1]).map(([op, n]) => (
                    <div key={op} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontFamily: L.sans, fontSize: 11, color: L.text, width: 108, flex: 'none' }}>{op}</span>
                      <span style={{ flex: 1, height: 7, background: L.border, borderRadius: 2, overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', width: `${(n / maxMv) * 100}%`, background: L.goldTint }} />
                      </span>
                      <span style={{ fontFamily: L.mono, fontSize: 11, fontWeight: 700, color: L.text, width: 26, textAlign: 'right' }}>{n}</span>
                    </div>
                  ))}
                  {!Object.keys(h.by_operator).length && <span style={{ fontFamily: L.mono, fontSize: 10, color: L.faint }}>No freighters observed in window.</span>}
                </div>
              </Card>
            ))}
          </div>
        )}
        <div style={{ fontFamily: L.sans, fontSize: 9.5, color: L.faint }}>
          {q.data?.source ?? 'OpenSky Network'} — coverage is partial community ADS-B and lags ~12h, so counts are a relative trend signal, not a manifest. Operators: FedEx, UPS, DHL, Atlas Air, Cargolux, Lufthansa Cargo, and other freighters by callsign.
        </div>
      </div>
    </PageWrapper>
  )
}
