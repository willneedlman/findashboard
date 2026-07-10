import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import { L, Card, Spark, PageHead } from '../components/logi'

// Freight Macro — US domestic freight health: inventories-to-sales (Census MTIS),
// Cass Freight (Shipments + Expenditures) and Truck Tonnage (all via FRED).

interface Obs { date: string; value: number }
interface InvSales { _stale?: boolean; source?: string; metric?: string; latest?: { time: string; ratio: number }; series?: { time: string; ratio: number }[] }
interface Idx { latest?: Obs; series?: Obs[] }
interface Freight { _stale?: boolean; source?: string; indices?: Record<string, Idx> }
interface Payload { inventory_sales: InvSales; freight_indices: Freight }

function Metric({ label, value, unit, series, stale, source }: { label: string; value?: number | null; unit?: string; series?: number[]; stale?: boolean; source?: string }) {
  return (
    <Card title={label} source={source} stale={stale}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontFamily: L.mono, fontSize: 30, fontWeight: 700, color: L.text }}>
          {value != null ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
          {unit && <span style={{ fontSize: 12, color: L.sec, fontWeight: 400 }}> {unit}</span>}
        </div>
        {series && series.length > 1 && <Spark data={series} w={130} h={34} />}
      </div>
    </Card>
  )
}

export default function FreightMacro() {
  const q = useQuery<Payload>({
    queryKey: ['logi-freight-macro'],
    queryFn: () => axios.get('/api/logistics/freight-macro').then(r => r.data),
    staleTime: 12 * 3600 * 1000, retry: 1,
  })
  const inv = q.data?.inventory_sales
  const idx = q.data?.freight_indices?.indices ?? {}
  const ser = (k: string) => (idx[k]?.series ?? []).map(o => o.value)

  return (
    <PageWrapper>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <PageHead title="FREIGHT MACRO" sub="US inventories, Cass freight, and truck tonnage — the domestic freight cycle." />

        {q.isLoading ? <div style={{ fontFamily: L.mono, fontSize: 12, color: L.sec, padding: 40 }}>Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
          <Metric label="INVENTORIES / SALES" value={inv?.latest?.ratio} unit={inv?.latest?.time} source={inv?.source} stale={inv?._stale}
            series={(inv?.series ?? []).map(p => p.ratio)} />
          <Metric label="CASS SHIPMENTS" value={idx.cass_shipments?.latest?.value} unit={idx.cass_shipments?.latest?.date?.slice(0, 7)} source={q.data?.freight_indices?.source} stale={q.data?.freight_indices?._stale} series={ser('cass_shipments')} />
          <Metric label="CASS EXPENDITURES" value={idx.cass_expenditures?.latest?.value} unit={idx.cass_expenditures?.latest?.date?.slice(0, 7)} stale={q.data?.freight_indices?._stale} series={ser('cass_expenditures')} />
          <Metric label="TRUCK TONNAGE" value={idx.truck_tonnage?.latest?.value} unit={idx.truck_tonnage?.latest?.date?.slice(0, 7)} stale={q.data?.freight_indices?._stale} series={ser('truck_tonnage')} />
        </div>
        )}
        <div style={{ fontFamily: L.sans, fontSize: 9.5, color: L.faint }}>
          Inventories-to-sales: US Census MTIS (total business, seasonally adjusted), monthly. Cass Freight and Truck Tonnage indices via FRED. Cached for the release cadence; CACHED marks a served stale copy.
        </div>
      </div>
    </PageWrapper>
  )
}
