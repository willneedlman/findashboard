import { useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import LoadingState from '../components/LoadingState'
import ErrorState from '../components/ErrorState'
import TickerLink from '../components/TickerLink'
import { L, Spark, Card } from '../components/logi'
import { KpiCell } from '../components/mmCockpit'
import { fetchChokepointExposure } from '../hooks/useApi'

interface Quote { price: number | null; change_pct: number | null; spark: number[] }
interface Exposure extends Quote { ticker: string; group: string; group_key: string; direction: number; note: string }
interface ChokeCard { id: string; name: string; oil_mbd: number; status: string | null; delta_pct: number | null; share_pct: number | null; disruption: number; exposures: Exposure[] }
interface Leader extends Quote { ticker: string; group: string; group_key: string; direction: number; score: number; chokepoints: string[]; links: number }
interface Resp { chokepoints: ChokeCard[]; leaders: Leader[]; any_stress: boolean; priced: number; source: string }

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: L.surface, border: `1px solid ${L.border}`, borderRadius: 6,
}
const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`)
const chgColor = (v: number | null) => (v == null ? L.sec : v > 0 ? L.pos : v < 0 ? L.neg : L.sec)

// Status pill for a chokepoint's live PortWatch read.
function StatusPill({ status, delta }: { status: string | null; delta: number | null }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    congested: { bg: L.neg, fg: L.neg, label: 'CONGESTED' },
    watch: { bg: L.gold, fg: L.gold, label: 'WATCH' },
    normal: { bg: L.sec, fg: L.sec, label: 'NORMAL' },
  }
  const s = map[status ?? 'normal'] ?? map.normal
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: L.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', color: s.fg, border: `1px solid ${s.fg}`, padding: '1px 6px', borderRadius: 3 }}>
      {s.label}{delta != null && <span style={{ color: L.sec }}>{delta > 0 ? '+' : ''}{delta}%</span>}
    </span>
  )
}

// Structural tendency badge: does disruption help or hurt this name.
function DirBadge({ direction }: { direction: number }) {
  const benefits = direction > 0
  const c = benefits ? L.pos : L.neg
  return (
    <span title={benefits ? 'tends to benefit when this chokepoint is disrupted' : 'tends to be pressured when this chokepoint is disrupted'}
      style={{ fontFamily: L.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: c, border: `1px solid ${c}`, padding: '0 4px', borderRadius: 3 }}>
      {benefits ? 'BENEFITS' : 'PRESSURED'}
    </span>
  )
}

// One exposed name as a compact chip inside a chokepoint card.
function NameChip({ e }: { e: Exposure }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: `1px solid ${L.border}` }}>
      <TickerLink ticker={e.ticker} style={{ fontFamily: L.mono, fontSize: 12, fontWeight: 700, color: L.text, width: 46 }} />
      <DirBadge direction={e.direction} />
      <span style={{ marginLeft: 'auto', fontFamily: L.mono, fontSize: 11, color: chgColor(e.change_pct) }}>{pct(e.change_pct)}</span>
      <div style={{ width: 60 }}>{e.spark.length > 1 && <Spark data={e.spark} color={chgColor(e.change_pct)} w={60} h={16} />}</div>
    </div>
  )
}

export default function ChokepointExposure() {
  const { data, isLoading, error, refetch } = useQuery<Resp>({
    queryKey: ['chokepoint-exposure'],
    queryFn: fetchChokepointExposure,
    staleTime: 300_000,
  })

  return (
    <PageWrapper title="Chokepoint Exposure">
      {isLoading ? (
        <LoadingState label="Mapping chokepoint stress to exposed names" />
      ) : error || !data ? (
        <ErrorState message="Could not load chokepoint exposure." onRetry={() => refetch()} />
      ) : (
        <ExposureBoard data={data} />
      )}
    </PageWrapper>
  )
}

function ExposureBoard({ data }: { data: Resp }) {
  const stressed = data.chokepoints.filter(c => c.disruption > 0)
  const benefit = data.leaders.filter(l => l.score > 0)
  const pressured = data.leaders.filter(l => l.score < 0)
  const topBenef = benefit[0]
  const topPress = pressured[0]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontFamily: L.sans, fontSize: 12, color: L.sec, lineHeight: 1.6, maxWidth: 760, margin: 0 }}>
        Live transit stress at the world's shipping chokepoints, mapped to the listed names it tends to move. When
        transits drop or reroute, tanker day-rates and crude tend to rise while refiners and Asia-trade names get
        pressured. Stress is IMF PortWatch plus the AIS nowcast; the exposure map is curated. Click any ticker to open
        it in the research tools.
      </p>

      <div style={STRIP}>
        <KpiCell label="Chokepoints" value={String(data.chokepoints.length)} align="top" />
        <KpiCell label="Under stress" value={String(stressed.length)} color={stressed.length ? L.gold : L.sec} align="top" />
        <KpiCell label="Top beneficiary" value={topBenef ? topBenef.ticker : '—'} color={L.pos}
          sub={topBenef ? pct(topBenef.change_pct) : undefined} subColor={topBenef ? chgColor(topBenef.change_pct) : undefined} align="top" />
        <KpiCell label="Most pressured" value={topPress ? topPress.ticker : '—'} color={L.neg}
          sub={topPress ? pct(topPress.change_pct) : undefined} subColor={topPress ? chgColor(topPress.change_pct) : undefined} align="top" />
        <KpiCell label="Names priced" value={String(data.priced)} align="top" grow />
      </div>

      {!data.any_stress && (
        <div style={{ fontFamily: L.mono, fontSize: 11, color: L.sec, background: L.surface, border: `1px solid ${L.border}`, borderRadius: 6, padding: '10px 14px' }}>
          No chokepoint is under stress right now. The board below ranks names by structural exposure breadth (how many
          chokepoints each sits behind), not an active signal.
        </div>
      )}

      <Card title="MOST-EXPOSED NAMES" source={data.source}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: L.mono, fontSize: 11.5 }}>
            <thead>
              <tr>
                {['#', 'Ticker', 'Basket', 'Signal', 'Score', 'Chokepoints', 'Chg', ''].map((h, i) => (
                  <th key={h} style={{ textAlign: i >= 4 && i <= 6 ? 'right' : 'left', padding: '6px 8px', fontSize: 8.5, letterSpacing: '0.1em', color: L.faint, borderBottom: `1px solid ${L.border}`, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.leaders.map((l, i) => {
                const signal = !data.any_stress || l.score === 0 ? '—' : l.score > 0 ? 'Tailwind' : 'Headwind'
                const sigColor = signal === 'Tailwind' ? L.pos : signal === 'Headwind' ? L.neg : L.sec
                return (
                  <tr key={l.ticker} style={{ borderBottom: `1px solid ${L.border}` }}>
                    <td style={{ padding: '6px 8px', color: L.faint }}>{i + 1}</td>
                    <td style={{ padding: '6px 8px' }}><TickerLink ticker={l.ticker} style={{ fontFamily: L.mono, fontSize: 12, fontWeight: 700, color: L.text }} /></td>
                    <td style={{ padding: '6px 8px', color: L.sec }}>{l.group}</td>
                    <td style={{ padding: '6px 8px', color: sigColor, fontWeight: 700 }}>{signal}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: l.score > 0 ? L.pos : l.score < 0 ? L.neg : L.sec }}>{l.score > 0 ? '+' : ''}{l.score}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: L.sec }} title={l.chokepoints.join(', ')}>{l.links}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: chgColor(l.change_pct) }}>{pct(l.change_pct)}</td>
                    <td style={{ padding: '6px 8px', width: 66 }}>{l.spark.length > 1 && <Spark data={l.spark} color={chgColor(l.change_pct)} w={60} h={16} />}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {data.chokepoints.map(c => (
          <Card key={c.id} title={c.name.toUpperCase()} source={c.oil_mbd ? `${c.oil_mbd} Mb/d` : undefined}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <StatusPill status={c.status} delta={c.delta_pct} />
              {c.share_pct != null && <span style={{ fontFamily: L.mono, fontSize: 9, color: L.faint }}>{c.share_pct}% seaborne oil</span>}
              {c.disruption > 0 && <span style={{ marginLeft: 'auto', fontFamily: L.mono, fontSize: 9, color: L.gold }}>disruption {c.disruption}</span>}
            </div>
            {c.exposures.map(e => <NameChip key={c.id + e.ticker} e={e} />)}
          </Card>
        ))}
      </div>
    </div>
  )
}
