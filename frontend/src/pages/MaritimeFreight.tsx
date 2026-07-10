import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import { L, Card, Spark, PageHead } from '../components/logi'

// Container & Freight — liner connectivity (UNCTAD LSCI via World Bank), container
// spot rate (Drewry WCI), and canal chokepoint transits (IMF PortWatch). One cached
// backend call; every field degrades to stale-on-failure server-side.

interface Src { _stale?: boolean }
interface Lsci extends Src { economies?: { country: string; lsci: number; year: string }[]; source?: string }
interface Wci extends Src { composite_usd_per_40ft?: number; source?: string }
interface ChokePt { d: string; total: number | null }
interface Chokepoints extends Src { chokepoints?: Record<string, { latest?: ChokePt; series?: ChokePt[] }>; source?: string }
interface Payload { lsci: Lsci; wci: Wci; chokepoints: Chokepoints }

export default function MaritimeFreight() {
  const q = useQuery<Payload>({
    queryKey: ['logi-maritime-freight'],
    queryFn: () => axios.get('/api/logistics/maritime-freight').then(r => r.data),
    staleTime: 6 * 3600 * 1000, retry: 1,
  })
  const lsci = q.data?.lsci, wci = q.data?.wci, choke = q.data?.chokepoints
  const econ = lsci?.economies ?? []
  const maxLsci = econ.length ? Math.max(...econ.map(e => e.lsci)) : 1

  return (
    <PageWrapper>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PageHead title="CONTAINER &amp; FREIGHT" sub="Liner connectivity, container spot rates, and canal chokepoint transits." />

        {q.isLoading ? <div style={{ fontFamily: L.mono, fontSize: 12, color: L.sec, padding: 40 }}>Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>

          <Card title="DREWRY WCI" source={wci?.source} stale={wci?._stale}>
            <div style={{ fontFamily: L.mono, fontSize: 34, fontWeight: 700, color: L.text }}>
              {wci?.composite_usd_per_40ft != null ? `$${wci.composite_usd_per_40ft.toLocaleString()}` : '—'}
            </div>
            <div style={{ fontFamily: L.sans, fontSize: 10.5, color: L.sec, marginTop: 4 }}>Global composite, per 40ft container</div>
          </Card>

          <Card title="CANAL TRANSITS" source={choke?.source} stale={choke?._stale}>
            {['suez', 'panama'].map(id => {
              const c = choke?.chokepoints?.[id]
              const series = (c?.series ?? []).map(p => p.total).filter((v): v is number => v != null)
              return (
                <div key={id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: `1px solid ${L.border}` }}>
                  <div>
                    <div style={{ fontFamily: L.sans, fontSize: 12, fontWeight: 600, color: L.text, textTransform: 'capitalize' }}>{id}</div>
                    <div style={{ fontFamily: L.mono, fontSize: 9, color: L.faint }}>{c?.latest?.d ?? '—'}</div>
                  </div>
                  <Spark data={series} w={90} h={26} />
                  <div style={{ fontFamily: L.mono, fontSize: 18, fontWeight: 700, color: L.text, width: 44, textAlign: 'right' }}>{c?.latest?.total ?? '—'}</div>
                </div>
              )
            })}
            <div style={{ fontFamily: L.sans, fontSize: 9, color: L.faint, marginTop: 6 }}>Daily vessel transits</div>
          </Card>

          <Card title="LINER CONNECTIVITY (LSCI)" source={lsci?.source} stale={lsci?._stale}>
            {econ.slice(0, 7).map(e => (
              <div key={e.country} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
                <span style={{ fontFamily: L.sans, fontSize: 11, color: L.text, width: 92, flex: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.country}</span>
                <span style={{ flex: 1, height: 8, background: L.border, borderRadius: 2, overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${(e.lsci / maxLsci) * 100}%`, background: L.goldTint }} />
                </span>
                <span style={{ fontFamily: L.mono, fontSize: 11, fontWeight: 700, color: L.text, width: 44, textAlign: 'right' }}>{e.lsci.toFixed(1)}</span>
              </div>
            ))}
            {!econ.length && <div style={{ fontFamily: L.mono, fontSize: 11, color: L.faint }}>No LSCI data.</div>}
          </Card>

        </div>
        )}
        <div style={{ fontFamily: L.sans, fontSize: 9.5, color: L.faint }}>
          LSCI via World Bank (UNCTAD mirror), quarterly. WCI is a scraped public composite. Transits are IMF PortWatch (1-2d lag). Cached aggressively; fields marked CACHED are serving the last good fetch.
        </div>
      </div>
    </PageWrapper>
  )
}
