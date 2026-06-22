import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ComposedChart, Line } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import HelpTip from '../components/HelpTip'
import ExpirySelect from '../components/ExpirySelect'
import { GammaScalpingContent } from './GammaScalping'
import CustomStrategyModal, { type CustomStrategyDef } from '../components/CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy } from '../utils/customStrategies'
import { useTheme } from '../contexts/ThemeContext'
import { buildOCC, parseOCC, isOCC } from '../lib/occ'
import PaperChart, { type ChartFill } from '../components/PaperChart'
import { loadActivePortfolio } from '../components/dashboard/widgets/usePortfolio'
import { EMPTY_LEG, OPTION_STRATEGY_TEMPLATES, type LegState, type StrategyTemplate } from './paper-trading/optionTemplates'
import { useAuth, adaptAccount, T, inp, sel, lbl, btn, sectionHeader, fmt$, fmtDate, statusColor, computeReplayStats, applyRiskToChart, PT_LS_KEY, BUILTIN_STRATEGY_INFO, PAPER_DEFAULT_PARAMS, PAPER_PARAM_LABELS, STRATEGY_TEMPLATE, RISK_DEFAULTS, type Balances, type Position, type Order, type AccountData, type PendingOptionStrategy, type ChartPoint, type StrategyEntry, type ReplayEvent, type ReplayResult, type RiskConfig, type SchedulerStatus, type SchedulerJob, type SchedulerLogEntry } from './paper-trading/shared'
import { OrderTicket } from './paper-trading/OrderTicket'
import { PositionsPanel, OrdersPanel } from './paper-trading/Positions'
import { StrategyPanel } from './paper-trading/StrategyPanel'


// OCC option symbol helpers live in lib/occ (shared with the paper-trade widget).


// ─── Main page ────────────────────────────────────────────────────────────────
export default function PaperTrading() {
  const queryClient = useQueryClient()
  const { uid, authed, headers } = useAuth()

  const { data, isError, isLoading, refetch } = useQuery<AccountData>({
    queryKey: ['trading-account', uid],
    queryFn: () => axios.get(`/api/paper/account?user_id=${uid}`, headers).then(r => adaptAccount(r.data)),
    enabled: authed,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => axios.delete(`/api/paper/order/${id}?user_id=${uid}`, headers).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trading-account'] }),
  })

  const cancelAllMutation = useMutation({
    mutationFn: async () => {
      const pending = (orders ?? []).filter(o =>
        ['pending', 'open', 'partially_filled'].includes((o.status ?? '').toLowerCase()))
      if (pending.length === 0) return
      const results = await Promise.allSettled(pending.map(o => axios.delete(`/api/paper/order/${o.id}?user_id=${uid}`, headers)))
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) throw new Error(`${failed} of ${pending.length} cancellations failed`)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trading-account'] }),
    onError: () => queryClient.invalidateQueries({ queryKey: ['trading-account'] }),
  })

  function invalidateAccount() {
    queryClient.invalidateQueries({ queryKey: ['trading-account'] })
  }

  const bal = data?.balances
  const positions = data?.positions ?? []
  const orders = [...(data?.orders ?? [])].sort((a, b) =>
    new Date(b.create_date).getTime() - new Date(a.create_date).getTime()
  )

  // Filled orders → buy/sell markers on the chart for the matching ticker.
  const chartFills: ChartFill[] = orders
    .filter(o => (o.status ?? '').toLowerCase() === 'filled' && o.create_date)
    .map(o => {
      const occ = isOCC(o.symbol)
      return { time: Math.floor(new Date(o.create_date).getTime() / 1000), side: o.side, symbol: occ ? undefined : o.symbol, option_symbol: occ ? o.symbol : undefined }
    })
  const chartInitTicker = positions.find(p => /^[A-Z.]{1,6}$/.test(p.symbol))?.symbol || 'SPY'

  const dayChangeColor = bal
    ? bal.day_change >= 0 ? T.pos : T.neg
    : T.muted

  const [gammaOpen, setGammaOpen] = useState(false)

  // Automated order tracking: orderId → strategyName
  const [automatedOrders, setAutomatedOrders] = useState<Record<string, string>>({})
  const handleAutomatedOrder = (id: string, name: string) =>
    setAutomatedOrders(prev => ({ ...prev, [id]: name }))

  // Template import from StrategyPanel → OrderTicket
  const [importedTemplate, setImportedTemplate] = useState<StrategyTemplate | null>(null)

  // Pending strategy sent from Strategy Builder via localStorage
  const [pendingBuilderStrategy, setPendingBuilderStrategy] = useState<PendingOptionStrategy | null>(() => {
    try { return JSON.parse(localStorage.getItem(PT_LS_KEY) ?? 'null') } catch { return null }
  })

  const approveBuilderStrategy = (ps: PendingOptionStrategy) => {
    // Convert PendingOptionStrategy legs into multileg OrderTicket state
    const asTpl: StrategyTemplate = {
      name: ps.name, shortName: ps.name,
      orderType: ps.orderType,
      description: `Imported from Strategy Builder · ${ps.legs.length} legs`,
      legs: ps.legs.map(l => ({ side: l.side, qty: l.qty, hint: l.hint })),
    }
    // Pre-fill OCC symbols by injecting them via a special channel
    setPendingOCCLegs(ps.legs.map(l => ({ symbol: l.occ, side: l.side, qty: l.qty })))
    setPendingUnderlying(ps.underlying)
    setImportedTemplate(asTpl)
    localStorage.removeItem(PT_LS_KEY)
    setPendingBuilderStrategy(null)
  }

  const [pendingOCCLegs, setPendingOCCLegs] = useState<{ symbol: string; side: string; qty: string }[] | null>(null)
  const [pendingUnderlying, setPendingUnderlying] = useState<string | null>(null)

  // Column height tracking
  const [bodyHeight, setBodyHeight] = useState('calc(100vh - 130px)')
  useEffect(() => {
    function updateHeight() {
      setBodyHeight(`calc(100vh - 130px)`)
    }
    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [])

  if (!authed) return (
    <PageWrapper title="Paper Trading">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', textAlign: 'center' }}>
        <div style={{ fontFamily: T.mono, color: T.muted, fontSize: 13, lineHeight: 1.6 }}>
          Sign in to paper-trade your own account.<br />
          <span style={{ fontSize: 11, color: T.dim }}>Each account gets its own $100k book, positions, and strategies.</span>
        </div>
      </div>
    </PageWrapper>
  )

  return (
    <PageWrapper title="Paper Trading">
      <div style={{ fontFamily: T.mono, color: T.text, display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* ── Error banner ── */}
        {isError && (
          <div style={{
            padding: '9px 14px', marginBottom: 8,
            background: 'color-mix(in srgb, var(--theme-negative) 10%, transparent)', border: `1px solid color-mix(in srgb, var(--theme-negative) 40%, transparent)`,
            color: T.neg, fontSize: 12, fontFamily: T.mono,
          }}>
            Tradier sandbox unavailable — check API key in .env
          </div>
        )}

        {/* ── Header bar ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
          padding: '10px 14px',
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderBottom: `2px solid ${T.gold}`,
          marginBottom: 10,
        }}>
          {/* Sandbox badge */}
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '2px 7px',
            background: 'color-mix(in srgb, var(--theme-warn) 18%, transparent)', color: T.warn,
            border: `1px solid rgba(249,115,22,0.4)`, letterSpacing: '0.1em',
          }}>
            SANDBOX
          </span>

          <div style={{ width: 1, height: 18, background: T.border }} />

          {/* Metrics */}
          {isLoading ? (
            <span style={{ fontSize: 11, color: T.dim }}>Loading…</span>
          ) : bal ? (
            <>
              <HeaderMetric label="EQUITY" value={fmt$(bal.total_equity)} />
              <HeaderMetric label="BUYING POWER" value={fmt$(bal.buying_power)} />
              <HeaderMetric label="TOTAL P&L" value={fmt$(bal.day_change)} valueColor={dayChangeColor} />
              <HeaderMetric label="CASH" value={fmt$(bal.cash)} />
            </>
          ) : null}

          <div style={{ marginLeft: 'auto' }}>
            <button
              onClick={() => refetch()}
              title="Refresh"
              style={{
                background: 'none', border: `1px solid ${T.border}`, color: T.muted,
                cursor: 'pointer', padding: '4px 10px', fontFamily: T.mono, fontSize: 13,
                transition: 'border-color 0.15s, color 0.15s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = T.gold
                ;(e.currentTarget as HTMLButtonElement).style.color = T.gold
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = T.border
                ;(e.currentTarget as HTMLButtonElement).style.color = T.muted
              }}
            >
              ↻
            </button>
          </div>
        </div>

        {(<>
        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-start',
          height: bodyHeight, overflow: 'hidden',
        }}>
          {/* Left: Order Ticket — 300px */}
          <div style={{
            width: 300, flexShrink: 0,
            background: T.surface,
            border: `1px solid ${T.border}`,
            display: 'flex', flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}>
            <OrderTicket
              onOrderPlaced={invalidateAccount}
              importTemplate={importedTemplate}
              onTemplateConsumed={() => { setImportedTemplate(null); setPendingOCCLegs(null); setPendingUnderlying(null) }}
              importOCCLegs={pendingOCCLegs}
              importUnderlying={pendingUnderlying}
            />
          </div>

          {/* Middle: Chart over Positions — flex */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'hidden' }}>
            <div style={{ flex: '3 1 0', minHeight: 0, background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
              <PaperChart initialTicker={chartInitTicker} fills={chartFills} storageKey={uid || 'page'} />
            </div>
            <div style={{ flex: '2 1 0', minHeight: 0, background: T.surface, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <PositionsPanel positions={positions} />
            </div>
          </div>

          {/* Right: Orders — 280px */}
          <div style={{
            width: 280, flexShrink: 0,
            background: T.surface,
            border: `1px solid ${T.border}`,
            display: 'flex', flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}>
            <OrdersPanel
              orders={orders}
              onCancel={id => cancelMutation.mutate(id)}
              onCancelAll={() => cancelAllMutation.mutate()}
              cancelAllPending={cancelAllMutation.isPending}
              cancelAllError={cancelAllMutation.isError}
              automatedOrders={automatedOrders}
            />
          </div>
        </div>

        {/* ── Strategy Panel ── */}
        <StrategyPanel
          pendingBuilderStrategy={pendingBuilderStrategy}
          onApproveBuilderStrategy={approveBuilderStrategy}
          onDismissBuilderStrategy={() => { localStorage.removeItem(PT_LS_KEY); setPendingBuilderStrategy(null) }}
          onAutomatedOrder={handleAutomatedOrder}
        />

        </>)}
      </div>
    </PageWrapper>
  )
}


function HeaderMetric({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.13em', color: T.muted, textTransform: 'uppercase' as const }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: valueColor ?? T.text }}>
        {value}
      </span>
    </div>
  )
}
