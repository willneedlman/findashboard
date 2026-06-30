import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import { Widget, KpiCell } from '../components/mmCockpit'
import { RailSection } from './valuationShared'

const GOLD = 'var(--theme-primary, #c9a84c)'
const SEC = 'var(--theme-secondary, #8099b0)'
const BODY = 'var(--theme-text, #d7e3fc)'
const FAINT = 'var(--theme-text-faint, #5e768f)'
const MONO = 'var(--theme-mono, monospace)'
const HAIR = 'rgba(255,255,255,0.06)'
const SURFACE = 'var(--theme-surface, #0d1826)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: SURFACE, border: `1px solid ${BORDER}`, borderTop: `2px solid ${GOLD}`,
}

interface Supported { ticker: string; label: string }
interface XrayResult {
  funds: { fund: string; name: string; as_of: string; count: number; top10: number }[]
  unique_holdings: number
  overlapping_holdings: number
  aggregate: { ticker: string; name: string; weight: number; fund_count: number; funds: string[] }[]
  overlap: { a: string; b: string; overlap: number; shared: number }[]
}

export function EtfXrayContent() {
  const [picked, setPicked] = useState<string[]>(['SPY', 'XLK', 'XLF'])
  const [open, setOpen] = useState(true)

  const { data: supported } = useQuery<{ funds: Supported[] }>({
    queryKey: ['etf-supported'],
    queryFn: () => axios.get('/api/etf/supported').then(r => r.data),
    staleTime: Infinity,
  })

  const { mutate: runXray, data, isPending, isError, error } = useMutation<XrayResult>({
    mutationFn: async () => {
      const { data } = await axios.post('/api/etf/xray', { funds: picked })
      return data
    },
  })

  const toggle = (t: string) => setPicked(p => p.includes(t) ? p.filter(x => x !== t) : p.length < 8 ? [...p, t] : p)

  // Symmetric overlap lookup for the matrix.
  const ov: Record<string, Record<string, number>> = {}
  if (data) for (const o of data.overlap) { (ov[o.a] ??= {})[o.b] = o.overlap; (ov[o.b] ??= {})[o.a] = o.overlap }
  const fundList = data?.funds.map(f => f.fund) ?? []
  const maxOverlap = data ? Math.max(0, ...data.overlap.map(o => o.overlap)) : 0

  return (
    <SidebarLayout sidebarWidth={220} sidebarTitle="" sidebar={<>
      <RailSection title={`ETFs · ${picked.length}/8`} open={open} onToggle={() => setOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {(supported?.funds ?? []).map(f => {
            const on = picked.includes(f.ticker)
            return (
              <div key={f.ticker} onClick={() => toggle(f.ticker)}
                style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 9px',
                  border: `1px solid ${on ? GOLD : BORDER}`, background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)' : 'transparent' }}>
                <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: on ? GOLD : BODY }}>{f.ticker}</span>
                <span style={{ fontSize: 9, color: SEC, fontFamily: 'var(--theme-sans)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.label}</span>
              </div>
            )
          })}
        </div>
      </RailSection>
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button onClick={() => runXray()} disabled={picked.length < 2 || isPending} style={{
          width: '100%', background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)',
          fontFamily: 'inherit', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 0',
          cursor: (picked.length < 2 || isPending) ? 'default' : 'pointer', opacity: (picked.length < 2 || isPending) ? 0.6 : 1,
        }}>{isPending ? 'Loading…' : 'Run X-ray'}</button>
        {picked.length < 2 && <div style={{ fontSize: 9, color: FAINT, fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>Select at least two ETFs.</div>}
        {isError && <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-sans)', textAlign: 'center' }}>{(error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'X-ray failed'}</div>}
      </div>
    </>}>
      {!data && !isPending && <EmptyState title="ETF X-ray" hint="Pick two or more SPDR ETFs and run the X-ray to see look-through holdings, pairwise overlap, and concentration." />}
      {isPending && <EmptyState title="Reading holdings…" hint="Pulling each fund's daily holdings file." />}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={STRIP}>
            <KpiCell grow minWidth={120} label="ETFs" value={String(data.funds.length)} valueSize={21} />
            <KpiCell grow label="Unique Holdings" value={String(data.unique_holdings)} valueSize={21} color={GOLD} />
            <KpiCell grow label="Overlapping Names" value={String(data.overlapping_holdings)} valueSize={21} />
            <KpiCell grow label="Max Pair Overlap" value={`${maxOverlap.toFixed(1)}%`} valueSize={21} color={GOLD} />
          </div>

          <Widget title="Holdings Overlap — % By Weight">
            <div style={{ overflowX: 'auto', padding: 8 }}>
              <table style={{ borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                <thead>
                  <tr>
                    <th style={{ padding: '5px 9px' }} />
                    {fundList.map(f => <th key={f} style={{ padding: '5px 9px', color: SEC, fontWeight: 700, textAlign: 'center' }}>{f}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {fundList.map(rf => (
                    <tr key={rf}>
                      <td style={{ padding: '5px 9px', color: SEC, fontWeight: 700 }}>{rf}</td>
                      {fundList.map(cf => {
                        const self = rf === cf
                        const v = self ? 100 : (ov[rf]?.[cf] ?? 0)
                        return (
                          <td key={cf} style={{
                            padding: '6px 10px', textAlign: 'center', minWidth: 56,
                            color: self ? FAINT : v > 0.05 ? BODY : FAINT,
                            background: self ? 'transparent' : `color-mix(in srgb, ${GOLD} ${Math.min(100, v)}%, transparent)`,
                            border: `1px solid ${HAIR}`,
                          }}>{self ? '—' : `${v.toFixed(1)}`}</td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 9, color: FAINT, fontFamily: MONO, marginTop: 6 }}>Weight overlap = sum of min shared-holding weights. Higher = more duplicated exposure.</div>
            </div>
          </Widget>

          <Widget title={`Look-Through Holdings — Top ${Math.min(25, data.aggregate.length)} of ${data.unique_holdings}`} right={<span style={{ fontFamily: MONO, fontSize: 9, color: SEC }}>equal-weight blend</span>}>
            <div style={{ padding: 8 }}>
              {data.aggregate.slice(0, 25).map((a, i) => (
                <div key={a.ticker} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 6px', borderBottom: i < 24 ? `1px solid ${HAIR}` : 'none' }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: GOLD, width: 64, flexShrink: 0 }}>{a.ticker}</span>
                  <span style={{ fontSize: 11, color: BODY, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                  <span style={{ fontSize: 9, color: SEC, fontFamily: MONO, flexShrink: 0, width: 70, textAlign: 'right' }}>{a.fund_count} fund{a.fund_count > 1 ? 's' : ''}</span>
                  <div style={{ width: 120, height: 8, background: 'rgba(255,255,255,0.05)', flexShrink: 0 }}>
                    <div style={{ width: `${Math.min(100, a.weight * 4)}%`, height: '100%', background: GOLD }} />
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: BODY, width: 56, textAlign: 'right', flexShrink: 0 }}>{a.weight.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </Widget>

          <Widget title="Per-Fund Concentration">
            <div style={{ padding: 8 }}>
              {data.funds.map((f, i) => (
                <div key={f.fund} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px', borderBottom: i < data.funds.length - 1 ? `1px solid ${HAIR}` : 'none' }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: GOLD, width: 56, flexShrink: 0 }}>{f.fund}</span>
                  <span style={{ fontSize: 11, color: BODY, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ fontSize: 10, color: SEC, fontFamily: MONO, flexShrink: 0 }}>{f.count} holdings</span>
                  <span style={{ fontSize: 10, color: BODY, fontFamily: MONO, width: 110, textAlign: 'right', flexShrink: 0 }}>top-10 {f.top10.toFixed(1)}%</span>
                </div>
              ))}
              {data.funds[0]?.as_of && <div style={{ fontSize: 9, color: FAINT, fontFamily: MONO, marginTop: 6 }}>Holdings as of {data.funds[0].as_of} · SPDR/SSGA daily files.</div>}
            </div>
          </Widget>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function EtfXray() {
  return <PageWrapper title="ETF X-ray"><EtfXrayContent /></PageWrapper>
}
