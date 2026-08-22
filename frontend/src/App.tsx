import { Suspense, useEffect, useRef, useState } from 'react'
import { lazyWithReload } from './lib/chunkReload'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import CommandPalette from './components/CommandPalette'
import ReportCaptureHost from './components/ReportCaptureHost'
import { TICKER_SYM_RE, LINKED_ROUTES, setLinkedTicker, getLinkedTicker, isLinkOn } from './lib/tickerLink'
import { recordRecentTicker } from './lib/recentTickers'

// Lazy so axios + the drawer UI stay out of the critical-path index chunk;
// the host below owns the open event and mounts it on first use.
const TickerDrawerPanel = lazyWithReload(() => import('./components/TickerDrawer'))

// A redirect that carries the query string. Both renamed routes take ?ticker=,
// and a bare <Navigate> drops it, so every saved link and every hand-off from
// another tool would arrive with no symbol and look broken rather than moved.
function KeepQuery({ to }: { to: string }) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}

function TickerDrawerHost() {
  const [sym, setSym] = useState('')   // '' until first open; sym never resets, keeping the panel mounted for its exit animation
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onOpen = (e: Event) => {
      const s = String((e as CustomEvent).detail ?? '').trim().toUpperCase()
      if (!s) return
      setSym(s); setOpen(true)
      recordRecentTicker(s)
    }
    window.addEventListener('ft:ticker-drawer', onOpen)
    return () => window.removeEventListener('ft:ticker-drawer', onOpen)
  }, [])
  if (!sym) return null
  return (
    <Suspense fallback={null}>
      <TickerDrawerPanel open={open} sym={sym} onClose={() => setOpen(false)} />
    </Suspense>
  )
}
import LoadingState from './components/LoadingState'
import Layout from './components/Layout'
import { ThemeProvider, useTheme } from './contexts/ThemeContext'
import { PortfolioProvider } from './contexts/PortfolioContext'
import AccountSync from './components/AccountSync'
import SettingsOverlay from './components/SettingsOverlay'
import { findToolByLocation } from './lib/hubs'
import { recordRecent } from './lib/recents'
import EmptyState from './components/EmptyState'

// Marketing launchpad — chrome-free, lives at / and /product/*
const Landing        = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.Landing })))
const MktResearch    = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.ResearchPage })))
const MktOptions     = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.OptionsPage })))
const MktValuation   = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.ValuationPage })))
const MktLogistics   = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.LogisticsPage })))
const MktCharting    = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.ChartingPage })))
const MktMacro       = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.MacroPage })))
const MktTrading     = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.TradingPage })))
const MktShell       = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.MarketingShell })))
const NotFound       = lazyWithReload(() => import('./pages/NotFound'))

// Lazy-load all pages — crash in one route can't bring down the whole app
const Home               = lazyWithReload(() => import('./pages/Home'))
const ChartStudio        = lazyWithReload(() => import('./pages/ChartStudio'))
const OptionsPricer      = lazyWithReload(() => import('./pages/OptionsPricer'))
const BondAnalytics      = lazyWithReload(() => import('./pages/BondAnalytics'))
const CusipLookup        = lazyWithReload(() => import('./pages/CusipLookup'))
const NAVTracker         = lazyWithReload(() => import('./pages/NAVTracker'))
const ImpliedProbability = lazyWithReload(() => import('./pages/ImpliedProbability'))
const FedRates           = lazyWithReload(() => import('./pages/FedRates'))
const EarningsScanner    = lazyWithReload(() => import('./pages/EarningsScanner'))
const IpoCalendar        = lazyWithReload(() => import('./pages/IpoCalendar'))
const DCFValuation       = lazyWithReload(() => import('./pages/DCFValuation'))
const MasterValuation    = lazyWithReload(() => import('./pages/MasterValuation'))
const DividendDiscount   = lazyWithReload(() => import('./pages/DividendDiscount'))
const SOTP               = lazyWithReload(() => import('./pages/SOTP'))
const Multiples          = lazyWithReload(() => import('./pages/Multiples'))
const ReverseDCF         = lazyWithReload(() => import('./pages/ReverseDCF'))
const OptionsScanner     = lazyWithReload(() => import('./pages/OptionsScanner'))
const OptionsMM2         = lazyWithReload(() => import('./pages/OptionsMM2'))
const FixedIncomeMM2     = lazyWithReload(() => import('./pages/FixedIncomeMM2'))
const RegressionAnalysis = lazyWithReload(() => import('./pages/RegressionAnalysis'))
const CorrelationAnalysis = lazyWithReload(() => import('./pages/CorrelationAnalysis'))
const PortfolioBacktester = lazyWithReload(() => import('./pages/PortfolioBacktester'))
const MonteCarlo         = lazyWithReload(() => import('./pages/MonteCarlo'))
const PortfolioAllocator = lazyWithReload(() => import('./pages/PortfolioAllocator'))
const FactorDecomposition = lazyWithReload(() => import('./pages/FactorDecomposition'))
const PairsTrader = lazyWithReload(() => import('./pages/PairsTrader'))
const PortfolioCompare   = lazyWithReload(() => import('./pages/PortfolioCompare'))
const StrategyBuilder    = lazyWithReload(() => import('./pages/StrategyBuilder'))
const AlgoStrategyBuilder = lazyWithReload(() => import('./pages/AlgoStrategyBuilder'))
const EtfXray            = lazyWithReload(() => import('./pages/EtfXray'))
const DealerGEX          = lazyWithReload(() => import('./pages/DealerGEX'))
const loadCustomDashboard = () => import('./pages/CustomDashboard')
const CustomDashboard    = lazyWithReload(loadCustomDashboard)
const PrivacyPolicy      = lazyWithReload(() => import('./pages/legal/PrivacyPolicy'))
const TermsOfUse         = lazyWithReload(() => import('./pages/legal/TermsOfUse'))
const RiskDisclosure     = lazyWithReload(() => import('./pages/legal/RiskDisclosure'))
const DataSources        = lazyWithReload(() => import('./pages/legal/DataSources'))
const SettingsPage       = lazyWithReload(() => import('./pages/Settings'))
const StockScreener      = lazyWithReload(() => import('./pages/StockScreener'))
const PortfolioWorkspace = lazyWithReload(() => import('./pages/PortfolioWorkspace'))
const PortfolioAnalysis  = lazyWithReload(() => import('./pages/PortfolioAnalysis'))
const TradeHistoryAnalyzer = lazyWithReload(() => import('./pages/TradeHistoryAnalyzer'))
const AdminTester        = lazyWithReload(() => import('./pages/AdminTester'))
const CreditSpreads      = lazyWithReload(() => import('./pages/CreditSpreads'))
const CreditDelinquencies = lazyWithReload(() => import('./pages/CreditDelinquencies'))
const HousingMarket       = lazyWithReload(() => import('./pages/HousingMarket'))
const MarketHours        = lazyWithReload(() => import('./pages/MarketHours'))
const CurrencyMatrix     = lazyWithReload(() => import('./pages/CurrencyMatrix'))
const MaritimeMap        = lazyWithReload(() => import('./pages/MaritimeMap'))
const RelativeValuation  = lazyWithReload(() => import('./pages/RelativeValuation'))
const MoverRadar         = lazyWithReload(() => import('./pages/MoverRadar'))
const MarketBreadth      = lazyWithReload(() => import('./pages/MarketBreadth'))
const Seasonality        = lazyWithReload(() => import('./pages/Seasonality'))
const SupplyChain        = lazyWithReload(() => import('./pages/SupplyChain'))
const FundamentalOverlay = lazyWithReload(() => import('./pages/FundamentalOverlay'))
const SupplyChainMap     = lazyWithReload(() => import('./pages/SupplyChainPeers'))
const PaperTrading       = lazyWithReload(() => import('./pages/PaperTrading'))
const SentimentTracker   = lazyWithReload(() => import('./pages/SentimentTracker'))
const EconomyMonitor     = lazyWithReload(() => import('./pages/EconomyMonitor'))
const MacroEventHub      = lazyWithReload(() => import('./pages/MacroEventHub'))
const SectorRotation     = lazyWithReload(() => import('./pages/SectorRotation'))
const VolatilityScanner  = lazyWithReload(() => import('./pages/VolatilityScanner'))
const Compare            = lazyWithReload(() => import('./pages/Compare'))
const ResetPassword      = lazyWithReload(() => import('./pages/ResetPassword'))
const HubLanding         = lazyWithReload(() => import('./pages/HubLanding'))
const GlobalMarkets      = lazyWithReload(() => import('./pages/GlobalMarkets'))
const LogisticsMap       = lazyWithReload(() => import('./pages/LogisticsMap'))
const ChokepointExposure = lazyWithReload(() => import('./pages/ChokepointExposure'))
const TradeFlows = lazyWithReload(() => import('./pages/TradeFlows'))
const TraderPositioning = lazyWithReload(() => import('./pages/TraderPositioning'))
const ReportCreator      = lazyWithReload(() => import('./pages/ReportCreator'))
const ReportPrint        = lazyWithReload(() => import('./pages/ReportPrint'))

function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <EmptyState variant="loading" size="compact" title="Loading the page" />
    </div>
  )
}

// Fire-and-forget first-party pageview beacon on every route change (landing +
// terminal). Cookieless; the backend hashes the IP so nothing here identifies a
// user. Never blocks or breaks navigation.
function PageviewTracker() {
  const location = useLocation()
  useEffect(() => {
    try {
      fetch('/api/analytics/pageview', {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname, referrer: document.referrer || '' }),
      }).catch(() => {})
    } catch { /* analytics must never affect the page */ }
  }, [location.pathname])
  return null
}

function TerminalChrome() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCustomDashboard().catch(() => {})
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [])
  // Record tool visits for the Home "Jump Back In" row.
  useEffect(() => {
    const tool = findToolByLocation(location.pathname, location.search)
    if (tool) recordRecent(tool.route)
  }, [location.pathname, location.search])

  // Linked-ticker mode. Both branches act only on pathname TRANSITIONS: DCF
  // mirrors ?ticker= to the URL per keystroke, so reacting to same-path search
  // churn would record partial symbols ("T", "TS") and fight cleared inputs.
  const prevPath = useRef<string | null>(null)
  const arriving = prevPath.current !== location.pathname
  const sp = new URLSearchParams(location.search)
  // Injection must happen BEFORE the page mounts — pages read ?ticker= in
  // their state initializers, so a post-mount URL rewrite is a silent no-op.
  // While an injection is pending we render the loader instead of the Outlet;
  // the effect below rewrites the URL and the page then mounts once, with it.
  const holdForInject = arriving && !sp.has('ticker')
    && isLinkOn() && !!getLinkedTicker() && LINKED_ROUTES.has(location.pathname)
  useEffect(() => {
    if (arriving) {
      const t = (sp.get('ticker') || '').toUpperCase()
      if (t && TICKER_SYM_RE.test(t)) setLinkedTicker(t)
      else if (holdForInject) {
        navigate(`${location.pathname}?ticker=${getLinkedTicker()}`, { replace: true })
      }
    }
    prevPath.current = location.pathname
  })
  return (
    <Layout>
      <CommandPalette />
      <TickerDrawerHost />
      <ReportCaptureHost />
      <AnimatePresence mode="wait">
        <Suspense key={location.pathname} fallback={<LoadingState label={location.pathname === '/dashboard' ? 'Loading your dashboard' : 'Loading'} />}>
          {holdForInject ? <LoadingState label="Loading linked ticker" /> : <Outlet />}
        </Suspense>
      </AnimatePresence>
    </Layout>
  )
}

// Root route gate. New visitors (no account yet) get the marketing landing.
// Returning users who already have an account skip the splash and land on the
// terminal home — but only on the first launch of a browser session, so they
// can still navigate back to / to view the marketing page if they want.
function RootGate() {
  const { allUsers } = useTheme()
  const hasAccount = allUsers.length > 0
  if (hasAccount && sessionStorage.getItem('ft-launched') !== '1') {
    sessionStorage.setItem('ft-launched', '1')
    return <Navigate to="/app" replace />
  }
  return <Landing />
}

// Redirect that carries the query string along (?ticker=... must survive).
function RedirectWithSearch({ to }: { to: string }) {
  const location = useLocation()
  return <Navigate to={`${to}${location.search}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <PageviewTracker />
      <ThemeProvider>
      <PortfolioProvider>
        <AccountSync />
        <SettingsOverlay />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Marketing launchpad — no terminal chrome */}
            <Route path="/"                  element={<RootGate />} />
            <Route path="/product/research"  element={<MktResearch />} />
            <Route path="/product/options"   element={<MktOptions />} />
            <Route path="/product/valuation" element={<MktValuation />} />
            <Route path="/product/logistics" element={<MktLogistics />} />
            <Route path="/product/charting"  element={<MktCharting />} />
            <Route path="/product/macro"     element={<MktMacro />} />
            <Route path="/product/trading"   element={<MktTrading />} />
            <Route path="/product/portfolio" element={<Navigate to="/product/trading" replace />} />

            {/* Password reset — chrome-free, reached from the email link */}
            <Route path="/reset-password"    element={<ResetPassword />} />

            {/* Report export — chrome-free print/PDF layout */}
            <Route path="/report-creator/print/:id" element={<ReportPrint />} />

            {/* Legal — marketing chrome (no terminal sidebar) */}
            <Route element={<MktShell />}>
              <Route path="/privacy"         element={<PrivacyPolicy />} />
              <Route path="/terms"           element={<TermsOfUse />} />
              <Route path="/risk-disclosure" element={<RiskDisclosure />} />
              <Route path="/data-sources"    element={<DataSources />} />
            </Route>

            {/* Terminal — wrapped in the sidebar Layout */}
            <Route element={<TerminalChrome />}>
              <Route path="/app"        element={<Home />} />
              <Route path="/hub/research"  element={<Navigate to="/hub/companies" replace />} />
              <Route path="/hub/charting"  element={<Navigate to="/hub/charts" replace />} />
              <Route path="/hub/trading"   element={<Navigate to="/hub/portfolio" replace />} />
              <Route path="/hub/logistics" element={<Navigate to="/hub/trade-routes" replace />} />
              <Route path="/hub/:slug"  element={<HubLanding />} />
              <Route path="/market"     element={<RedirectWithSearch to="/company-profile" />} />
              <Route path="/global-markets" element={<GlobalMarkets />} />
              <Route path="/breadth" element={<MarketBreadth />} />
              <Route path="/seasonality" element={<Seasonality />} />
              <Route path="/report-creator" element={<ReportCreator />} />
              <Route path="/chart-studio" element={<ChartStudio />} />
              <Route path="/options"    element={<OptionsPricer />} />
              <Route path="/bond"       element={<BondAnalytics />} />
              <Route path="/cusip"      element={<CusipLookup />} />
              <Route path="/nav"        element={<NAVTracker />} />
              <Route path="/portfolio-manager" element={<PortfolioWorkspace />} />
              {/* Merged into the workspace's Live tab; old route keeps working. */}
              <Route path="/portfolio-live" element={<Navigate to="/portfolio-manager?view=live" replace />} />
              <Route path="/portfolio-analysis" element={<PortfolioAnalysis />} />
              <Route path="/trade-history" element={<TradeHistoryAnalyzer />} />
              {/* Portfolio tools — now standalone (legacy /portfolio-skills hub dismantled) */}
              <Route path="/backtest"         element={<PortfolioBacktester />} />
              <Route path="/montecarlo"       element={<MonteCarlo />} />
              <Route path="/portfolio-allocator" element={<PortfolioAllocator />} />
              {/* Builder and Optimizer are fused into the allocator; both old routes redirect. */}
              <Route path="/portfolio-optimizer" element={<Navigate to="/portfolio-allocator" replace />} />
              <Route path="/portfolio-builder" element={<Navigate to="/portfolio-allocator" replace />} />
              <Route path="/factor-decomposition" element={<FactorDecomposition />} />
              <Route path="/pairs-trader"       element={<PairsTrader />} />
              <Route path="/portfolio-compare" element={<PortfolioCompare />} />
              <Route path="/portfolio"        element={<Navigate to="/backtest" replace />} />
              <Route path="/portfolio-skills" element={<Navigate to="/backtest" replace />} />
              {/* Valuation tools — now standalone (legacy /valuation hub dismantled) */}
              <Route path="/master-valuation" element={<MasterValuation />} />
              <Route path="/dcf"         element={<DCFValuation />} />
              <Route path="/dcf-pro"     element={<RedirectWithSearch to="/dcf" />} />
              <Route path="/ddm"         element={<DividendDiscount />} />
              <Route path="/sotp"        element={<SOTP />} />
              <Route path="/multiples"   element={<Multiples />} />
              <Route path="/reverse-dcf" element={<ReverseDCF />} />
              <Route path="/valuation"   element={<RedirectWithSearch to="/master-valuation" />} />
              <Route path="/probability" element={<ImpliedProbability />} />
              <Route path="/volatility-scanner" element={<VolatilityScanner />} />
              {/* IV Rank and Vol Skew are fused into the scanner; every old route redirects. */}
              <Route path="/volatility"  element={<RedirectWithSearch to="/volatility-scanner" />} />
              <Route path="/skew"       element={<RedirectWithSearch to="/volatility-scanner" />} />
              <Route path="/fed"        element={<FedRates />} />
              {/* Portfolio Earnings is now the book scope of the fused Earnings tool. */}
              <Route path="/corporate"  element={<RedirectWithSearch to="/earnings" />} />
              {/* Chain Scanner + Options Flow merged. The old routes redirect so
                  existing links and saved tabs keep working. */}
              <Route path="/options-scanner" element={<OptionsScanner />} />
              <Route path="/options-mm-2" element={<OptionsMM2 />} />
              <Route path="/fixed-income-mm-2" element={<FixedIncomeMM2 />} />
              <Route path="/chain"      element={<RedirectWithSearch to="/options-scanner" />} />
              <Route path="/options-desk-demo" element={<RedirectWithSearch to="/options-scanner" />} />
              <Route path="/options-desk" element={<RedirectWithSearch to="/options-scanner" />} />
              <Route path="/correlation" element={<CorrelationAnalysis />} />
              <Route path="/strategy"   element={<StrategyBuilder />} />
              <Route path="/algo-strategy" element={<AlgoStrategyBuilder />} />
              <Route path="/dealer-exposure" element={<DealerGEX />} />
              {/* The route said gex while the tool said Dealer Exposure. */}
              <Route path="/gex"        element={<KeepQuery to="/dealer-exposure" />} />
              <Route path="/dashboard"       element={<CustomDashboard />} />
              <Route path="/settings"        element={<SettingsPage />} />
              <Route path="/screener"        element={<StockScreener />} />
              {/* Summarizer, Portfolio Earnings and the Scanner are fused here. */}
              <Route path="/earnings"        element={<EarningsScanner />} />
              <Route path="/earnings-calendar" element={<RedirectWithSearch to="/earnings" />} />
              <Route path="/ipo-calendar"    element={<IpoCalendar />} />
              <Route path="/admin"           element={<AdminTester />} />
              <Route path="/stress-test"     element={<Navigate to="/admin" replace />} />
              <Route path="/sector-rotation" element={<SectorRotation />} />
              <Route path="/economy"             element={<EconomyMonitor />} />
              <Route path="/macro-events"        element={<MacroEventHub />} />
              <Route path="/credit-spreads"      element={<CreditSpreads />} />
              <Route path="/credit-delinquencies" element={<CreditDelinquencies />} />
              <Route path="/housing"             element={<HousingMarket />} />
              <Route path="/market-hours"        element={<MarketHours />} />
              <Route path="/currency"            element={<CurrencyMatrix />} />
              <Route path="/flows-map"           element={<MaritimeMap />} />
              <Route path="/peer-comparison"     element={<RelativeValuation />} />
              <Route path="/fundamental-overlay" element={<FundamentalOverlay />} />
              {/* The route claimed a valuation tool. It benchmarks peers on
                  growth and returns as well as on multiples, and never
                  produces an intrinsic value. */}
              <Route path="/relative-valuation"  element={<KeepQuery to="/peer-comparison" />} />
              <Route path="/mover-radar"          element={<MoverRadar />} />
              <Route path="/company-profile"     element={<SupplyChain />} />
              <Route path="/supply-chain"        element={<RedirectWithSearch to="/company-profile" />} />
              {/* Retired from the Trade Routes hub 2026-08-19: the "verified" tier is a
                  10-record hand-curated ledger covering AAPL and MSFT, so the board could
                  not honestly sit beside the live-data tools. Route kept so the work is
                  not lost and existing links still resolve. */}
              <Route path="/supply-chain-peers"  element={<SupplyChainMap />} />
              <Route path="/gamma-scalping"      element={<Navigate to="/paper-trading" replace />} />
              <Route path="/paper-trading"       element={<PaperTrading />} />
              <Route path="/algo-runner"         element={<Navigate to="/admin" replace />} />
              <Route path="/sentiment"           element={<SentimentTracker />} />
              <Route path="/alerts"             element={<Navigate to="/settings?tab=alerts" replace />} />
              <Route path="/regression"         element={<RegressionAnalysis />} />
              <Route path="/options-hub"        element={<Navigate to="/options" replace />} />
              <Route path="/macro-hub"          element={<Navigate to="/fed" replace />} />
              <Route path="/research-hub"       element={<Navigate to="/earnings" replace />} />
              <Route path="/iv-tracker"         element={<RedirectWithSearch to="/volatility-scanner" />} />
              {/* The legacy two-desk simulator is gone, replaced by the two
                  MM terminals. Its routes redirect to the desk that took over
                  rather than 404, so an old bookmark still lands somewhere. */}
              <Route path="/market-maker"       element={<RedirectWithSearch to="/options-mm-2" />} />
              <Route path="/fixed-income-mm"    element={<RedirectWithSearch to="/fixed-income-mm-2" />} />
              <Route path="/unusual-options"    element={<RedirectWithSearch to="/options-scanner" />} />
              <Route path="/asset-overlay"      element={<Compare />} />
              <Route path="/compare"            element={<RedirectWithSearch to="/asset-overlay" />} />
              <Route path="/etf-analyzer"       element={<EtfXray />} />
              <Route path="/logistics-map"      element={<LogisticsMap />} />
              <Route path="/chokepoint-exposure" element={<ChokepointExposure />} />
              <Route path="/trade-flows"        element={<TradeFlows />} />
              <Route path="/trader-positioning" element={<TraderPositioning />} />
              <Route path="/maritime-freight"   element={<Navigate to="/logistics-map" replace />} />
              <Route path="/air-cargo"          element={<Navigate to="/logistics-map" replace />} />
              <Route path="/freight-macro"      element={<Navigate to="/logistics-map" replace />} />
              <Route path="/etf-xray"           element={<RedirectWithSearch to="/etf-analyzer" />} />
            </Route>

            {/* Anything unrouted: a real 404 in marketing chrome, not a silent
                redirect into the terminal. */}
            <Route element={<MktShell />}>
              <Route path="*"                 element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </PortfolioProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
