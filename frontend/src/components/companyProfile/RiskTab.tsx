import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import EmptyState from '../EmptyState'
import { Panel, Cell, DataTable, MONO, SANS } from './ui'
import { fetchBetaSuite } from '../../hooks/useApi'
import { DASH, compact, count, multiple, pct, shortDate, tone } from './format'

interface Credit {
  synthetic_rating?: string; rating_basis?: string
  default_spread_pct?: number | null; interest_coverage?: number | null
  debt_to_ebitda?: number | null; net_debt?: number | null; total_debt?: number | null
  altman_z?: number | null; altman_zone?: string
}
interface Bucket { label: string; amount: number | null }
interface DebtMaturity {
  as_of?: string; fiscal_year?: number; filed?: string
  buckets?: Bucket[]; total?: number | null; source?: string
}
interface ShortInterest {
  exchange?: string; current_short_position?: number | null
  previous_short_position?: number | null; avg_daily_volume?: number | null
  days_to_cover?: number | null; change_pct?: number | null
  settlement_date?: string; percent_of_float?: number | null
}
interface Deal {
  date_announced?: string; deal_status?: string; role?: string
  target_name?: string; acquirer_name?: string
  deal_value?: number | null; deal_terms?: string
}

export default function RiskTab({ ticker }: { ticker: string }) {
  const get = <R,>(path: string) => ({
    queryKey: [path, ticker],
    queryFn: () => axios.get(`/api/corporate/${path}?ticker=${encodeURIComponent(ticker)}`).then(r => r.data as R),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })
  const credit = useQuery<Credit>(get<Credit>('credit'))
  const debt = useQuery<DebtMaturity>(get<DebtMaturity>('debt-maturity'))
  const short = useQuery<ShortInterest>(get<ShortInterest>('short-interest'))
  const deals = useQuery<{ deals?: Deal[] }>(get<{ deals?: Deal[] }>('deals'))

  // Market risk, regressed rather than vendor-supplied. This is the analysis the
  // retired Market Performance tab carried; the redesign has no such tab, and
  // dropping a real regression silently would be a regression of its own.
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const since = new Date()
  since.setFullYear(since.getFullYear() - 1)
  const beta = useQuery({
    queryKey: ['cp-risk-beta', ticker],
    queryFn: () => fetchBetaSuite(ticker, iso(since), iso(new Date()), 'ff3'),
    staleTime: 300_000, retry: 0, enabled: !!ticker,
  })

  const c = credit.data ?? {}
  const hasCredit = c.synthetic_rating != null || c.interest_coverage != null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Panel title="Credit quality" meta={c.rating_basis ? `Synthetic rating, ${c.rating_basis} basis` : 'Synthetic rating'}>
        {hasCredit ? (
          // Every metric names its own basis. A rating without the basis it was
          // built on is a number the reader cannot check.
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 1, background: T.borderFaint,
          }}>
            <Cell label="Synthetic rating" value={c.synthetic_rating ?? DASH} note="Interest-coverage basis" tone={T.gold} />
            <Cell label="Default spread" value={pct(c.default_spread_pct, 2)} note="Over the risk-free rate" />
            <Cell label="Interest coverage" value={c.interest_coverage == null ? DASH : `${multiple(c.interest_coverage, 1)}x`} note="EBIT over interest expense" />
            <Cell label="Debt to EBITDA" value={c.debt_to_ebitda == null ? DASH : `${multiple(c.debt_to_ebitda, 2)}x`} note="Total debt basis" />
            <Cell
              label="Net debt"
              value={compact(c.net_debt)}
              note={(c.net_debt ?? 0) < 0 ? 'Net cash position' : 'Debt over cash'}
              tone={tone(c.net_debt == null ? null : -c.net_debt)}
            />
            <Cell
              label="Altman Z"
              value={multiple(c.altman_z, 1)}
              note={c.altman_zone === 'safe' ? 'Above the 2.99 safe threshold' : `Zone: ${c.altman_zone ?? DASH}`}
            />
          </div>
        ) : (
          <EmptyState
            title="Credit quality"
            hint="No income-statement data to model a rating from. Expected for an ETF, a fund, or a name that does not report earnings."
          />
        )}
      </Panel>

      {beta.data?.available && (
        <Panel
          title="Market risk"
          meta={`Regressed on one year of daily returns${beta.data.ff3?.observations ? `, n=${beta.data.ff3.observations}` : ''}`}
        >
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 1, background: T.borderFaint,
          }}>
            <Cell
              label="CAPM beta"
              value={multiple(beta.data.capm?.betas?.mktrf, 2)}
              note={beta.data.capm?.r_squared != null
                ? `R² ${beta.data.capm.r_squared.toFixed(2)}, computed not vendor`
                : 'Computed, not vendor'}
            />
            <Cell
              label="Scholes-Williams beta"
              value={multiple(beta.data.scholes_williams?.beta, 2)}
              note={beta.data.thin_trading_flag ? 'Thin trading detected' : 'Corrects for stale prices'}
            />
            <Cell label="Market factor" value={multiple(beta.data.ff3?.betas?.mktrf, 2)}
              note={`t ${multiple(beta.data.ff3?.t_stats?.mktrf, 1)}`} />
            <Cell label="Size factor (SMB)" value={multiple(beta.data.ff3?.betas?.smb, 2)}
              note={`t ${multiple(beta.data.ff3?.t_stats?.smb, 1)}`} />
            <Cell label="Value factor (HML)" value={multiple(beta.data.ff3?.betas?.hml, 2)}
              note={`t ${multiple(beta.data.ff3?.t_stats?.hml, 1)}`} />
            <Cell
              label="Idiosyncratic share"
              value={pct(beta.data.ivol_tvol?.idiosyncratic_pct)}
              note={beta.data.ivol_tvol?.ivol_annualized_pct != null
                ? `IVOL ${pct(beta.data.ivol_tvol.ivol_annualized_pct)} of TVOL ${pct(beta.data.ivol_tvol.tvol_annualized_pct)}`
                : 'Name-specific share of total variance'}
            />
          </div>
        </Panel>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 20 }}>
        <Panel
          title="Debt maturity wall"
          meta={debt.data?.fiscal_year
            ? `FY${debt.data.fiscal_year} filing, filed ${debt.data.filed ?? DASH}`
            : undefined}
        >
          {debt.data?.buckets?.length ? (
            <MaturityWall data={debt.data} cash={c.net_debt != null && c.total_debt != null
              ? c.total_debt - c.net_debt : null} />
          ) : (
            <EmptyState
              title="Debt maturity"
              hint="No maturity schedule filed for this name. It resolves for US filers that tag a debt schedule, and returns nothing for foreign filers, ETFs and thin names."
            />
          )}
        </Panel>

        <Panel title="Short interest" meta={short.data?.settlement_date ? `Settlement ${short.data.settlement_date}` : undefined}>
          {short.data?.current_short_position != null ? (
            <div>
              <Row label="Shares short" value={count(short.data.current_short_position)} />
              <Row label="Previous settlement" value={count(short.data.previous_short_position)} />
              <Row label="Change" value={pct(short.data.change_pct, 2, true)} tone={tone(short.data.change_pct)} />
              <Row label="Short percent of float" value={pct(short.data.percent_of_float, 2)} />
              <Row label="Average daily volume" value={count(short.data.avg_daily_volume)} />
              <Row label="Days to cover" value={multiple(short.data.days_to_cover, 1)} />
              <Row label="Exchange" value={short.data.exchange ?? DASH} last />
            </div>
          ) : (
            <EmptyState title="Short interest" hint="No FINRA short interest reported for this symbol." />
          )}
        </Panel>
      </div>

      <Panel title="Deal history" meta="M&A, via SDC">
        {deals.data?.deals?.length ? (
          <DataTable
            head={['Date', 'Role', 'Counterparty', 'Value', 'Status']}
            align={['left', 'left', 'left', 'right', 'left']}
            rows={deals.data.deals.slice(0, 25).map(d => [
              shortDate(d.date_announced),
              d.role ?? DASH,
              // The counterparty is whichever side is not this company.
              (d.role ?? '').toLowerCase().includes('acquir')
                ? (d.target_name ?? DASH)
                : (d.acquirer_name ?? d.target_name ?? DASH),
              d.deal_value == null ? (d.deal_terms || DASH) : compact(d.deal_value),
              d.deal_status ?? DASH,
            ])}
          />
        ) : (
          <EmptyState title="Deal history" hint="No transactions recorded for this name." />
        )}
      </Panel>
    </div>
  )
}

function MaturityWall({ data, cash }: { data: DebtMaturity; cash: number | null }) {
  const buckets = data.buckets ?? []
  const max = Math.max(...buckets.map(b => Math.abs(b.amount ?? 0)), 1)
  const near = buckets.find(b => /12|within|current|year 1/i.test(b.label))
  return (
    <div style={{ padding: '18px 18px 14px' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', height: 140 }}>
        {buckets.map(b => {
          const amt = b.amount ?? 0
          // An empty bucket is a stub with an em-dash, not a gap. A missing bar
          // and a zero bar look identical, and they are not the same fact.
          const h = amt > 0 ? Math.max(3, (Math.abs(amt) / max) * 112) : 2
          return (
            <div key={b.label} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: amt > 0 ? T.text : 'var(--theme-text-dim, rgba(255,255,255,0.35))' }}>
                {amt > 0 ? compact(amt) : DASH}
              </span>
              <div style={{
                width: '100%', height: h,
                background: amt > 0
                  ? 'color-mix(in srgb, var(--theme-primary) 48%, transparent)'
                  : 'rgba(255,255,255,0.08)',
              }} />
            </div>
          )
        })}
      </div>
      <div style={{
        display: 'flex', gap: 12, marginTop: 8, paddingTop: 8,
        borderTop: `1px solid ${T.borderFaint}`,
      }}>
        {buckets.map(b => (
          <span key={b.label} style={{
            flex: 1, textAlign: 'center', fontFamily: MONO, fontSize: 10,
            color: 'var(--theme-text-dim, rgba(255,255,255,0.35))',
          }}>
            {b.label}
          </span>
        ))}
      </div>
      <div style={{
        display: 'flex', gap: 22, flexWrap: 'wrap', marginTop: 12, paddingTop: 12,
        borderTop: `1px solid ${T.borderFaint}`,
        fontFamily: MONO, fontSize: 11, color: T.muted,
      }}>
        <span>Total {compact(data.total)}</span>
        {cash != null && <span>Cash {compact(cash)}</span>}
        <span>Due within 12 months {near ? compact(near.amount) : DASH}</span>
      </div>
    </div>
  )
}

function Row({ label, value, tone: t, last }: {
  label: string; value: string; tone?: string; last?: boolean
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14,
      padding: '11px 18px',
      borderBottom: last ? 'none' : '1px solid rgba(255,255,255,0.04)',
    }}>
      <span style={{ fontFamily: SANS, fontSize: 11.5, color: T.muted }}>{label}</span>
      <span style={{
        fontFamily: MONO, fontSize: 12.5, fontWeight: 700,
        fontVariantNumeric: 'tabular-nums', color: t ?? T.text,
      }}>
        {value}
      </span>
    </div>
  )
}
