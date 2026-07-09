import { Suspense, useEffect, useRef, useState } from 'react'
import { lazyWithReload } from './lib/chunkReload'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import CommandPalette from './components/CommandPalette'
import { TICKER_SYM_RE, LINKED_ROUTES, setLinkedTicker, getLinkedTicker, isLinkOn } from './lib/tickerLink'
import { recordRecentTicker } from './lib/recentTickers'

// Lazy so axios + the drawer UI stay out of the critical-path index chunk;
// the host below owns the open event and mounts it on first use.
const TickerDrawerPanel = lazyWithReload(() => import('./components/TickerDrawer'))

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
import { findToolByLocation } from './lib/hubs'
import { recordRecent } from './lib/recents'

// Marketing launchpad — chrome-free, lives at / and /product/*
const Landing        = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.Landing })))
const MktResearch    = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.ResearchPage })))
const MktOptions     = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.OptionsPage })))
const MktValuation   = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.ValuationPage })))
const MktCharting    = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.ChartingPage })))
const MktMacro       = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.MacroPage })))
const MktTrading     = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.TradingPage })))
const MktShell       = lazyWithReload(() => import('./marketing/Marketing').then(m => ({ default: m.MarketingShell })))

// Lazy-load all pages — crash in one route can't bring down the whole app
const Home               = lazyWithReload(() => import('./pages/Home'))
const ChartStudio        = lazyWithReload(() => import('./pages/ChartStudio'))
const OptionsPricer      = lazyWithReload(() => import('./pages/OptionsPricer'))
const BondAnalytics      = lazyWithReload(() => import('./pages/BondAnalytics'))
const CusipLookup        = lazyWithReload(() => import('./pages/CusipLookup'))
const NAVTracker         = lazyWithReload(() => import('./pages/NAVTracker'))
const ImpliedProbability = lazyWithReload(() => import('./pages/ImpliedProbability'))
const FedRates           = lazyWithReload(() => import('./pages/FedRates'))
const CorporateHub       = lazyWithReload(() => import('./pages/CorporateHub'))
const EarningsCalendar   = lazyWithReload(() => import('./pages/EarningsCalendar'))
const IpoCalendar        = lazyWithReload(() => import('./pages/IpoCalendar'))
const DCFValuation       = lazyWithReload(() => import('./pages/DCFValuation'))
const DividendDiscount   = lazyWithReload(() => import('./pages/DividendDiscount'))
const SOTP               = lazyWithReload(() => import('./pages/SOTP'))
const Multiples          = lazyWithReload(() => import('./pages/Multiples'))
const ReverseDCF         = lazyWithReload(() => import('./pages/ReverseDCF'))
const OptionsChainScanner = lazyWithReload(() => import('./pages/OptionsChainScanner'))
const RegressionAnalysis = lazyWithReload(() => import('./pages/RegressionAnalysis'))
const CorrelationAnalysis = lazyWithReload(() => import('./pages/CorrelationAnalysis'))
const PortfolioBacktester = lazyWithReload(() => import('./pages/PortfolioBacktester'))
const MonteCarlo         = lazyWithReload(() => import('./pages/MonteCarlo'))
const PortfolioOptimizer = lazyWithReload(() => import('./pages/PortfolioOptimizer'))
const PortfolioCompare   = lazyWithReload(() => import('./pages/PortfolioCompare'))
const StrategyBuilder    = lazyWithReload(() => import('./pages/StrategyBuilder'))
const AlgoStrategyBuilder = lazyWithReload(() => import('./pages/AlgoStrategyBuilder'))
const EtfXray            = lazyWithReload(() => import('./pages/EtfXray'))
const DealerGEX          = lazyWithReload(() => import('./pages/DealerGEX'))
const CustomDashboard    = lazyWithReload(() => import('./pages/CustomDashboard'))
const PrivacyPolicy      = lazyWithReload(() => import('./pages/legal/PrivacyPolicy'))
const TermsOfUse         = lazyWithReload(() => import('./pages/legal/TermsOfUse'))
const RiskDisclosure     = lazyWithReload(() => import('./pages/legal/RiskDisclosure'))
const DataSources        = lazyWithReload(() => import('./pages/legal/DataSources'))
const SettingsPage       = lazyWithReload(() => import('./pages/Settings'))
const StockScreener      = lazyWithReload(() => import('./pages/StockScreener'))
const EarningsSummarizer = lazyWithReload(() => import('./pages/EarningsSummarizer'))
const PortfolioManager   = lazyWithReload(() => import('./pages/PortfolioManager'))
const AdminTester        = lazyWithReload(() => import('./pages/AdminTester'))
const CreditSpreads      = lazyWithReload(() => import('./pages/CreditSpreads'))
const CreditDelinquencies = lazyWithReload(() => import('./pages/CreditDelinquencies'))
const HousingMarket       = lazyWithReload(() => import('./pages/HousingMarket'))
const MarketHours        = lazyWithReload(() => import('./pages/MarketHours'))
const CurrencyMatrix     = lazyWithReload(() => import('./pages/CurrencyMatrix'))
const MaritimeMap        = lazyWithReload(() => import('./pages/MaritimeMap'))
const RelativeValuation  = lazyWithReload(() => import('./pages/RelativeValuation'))
const SupplyChain        = lazyWithReload(() => import('./pages/SupplyChain'))
const TradeJournal       = lazyWithReload(() => import('./pages/TradeJournal'))
const PaperTrading       = lazyWithReload(() => import('./pages/PaperTrading'))
const SentimentTracker   = lazyWithReload(() => import('./pages/SentimentTracker'))
const AlertsPage         = lazyWithReload(() => import('./pages/Alerts'))
const EconomyMonitor     = lazyWithReload(() => import('./pages/EconomyMonitor'))
const MacroEventHub      = lazyWithReload(() => import('./pages/MacroEventHub'))
const SectorRotation     = lazyWithReload(() => import('./pages/SectorRotation'))
const IVTracker          = lazyWithReload(() => import('./pages/IVTracker'))
const SkewTool           = lazyWithReload(() => import('./pages/SkewTool'))
const MarketMakerSimulator = lazyWithReload(() => import('./pages/MarketMakerSimulator'))
const UnusualOptions     = lazyWithReload(() => import('./pages/UnusualOptions'))
const Compare            = lazyWithReload(() => import('./pages/Compare'))
const ResetPassword      = lazyWithReload(() => import('./pages/ResetPassword'))
const HubLanding         = lazyWithReload(() => import('./pages/HubLanding'))
const GlobalMarkets      = lazyWithReload(() => import('./pages/GlobalMarkets'))

function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)' }}>
        Loading…
      </div>
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
      <AnimatePresence mode="wait">
        <Suspense key={location.pathname} fallback={<LoadingState />}>
          {holdForInject ? <LoadingState /> : <Outlet />}
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
        <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Marketing launchpad — no terminal chrome */}
            <Route path="/"                  element={<RootGate />} />
            <Route path="/product/research"  element={<MktResearch />} />
            <Route path="/product/options"   element={<MktOptions />} />
            <Route path="/product/valuation" element={<MktValuation />} />
            <Route path="/product/charting"  element={<MktCharting />} />
            <Route path="/product/macro"     element={<MktMacro />} />
            <Route path="/product/trading"   element={<MktTrading />} />
            <Route path="/product/portfolio" element={<Navigate to="/product/trading" replace />} />

            {/* Password reset — chrome-free, reached from the email link */}
            <Route path="/reset-password"    element={<ResetPassword />} />

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
              <Route path="/hub/portfolio" element={<Navigate to="/hub/trading" replace />} />
              <Route path="/hub/:slug"  element={<HubLanding />} />
              <Route path="/market"     element={<RedirectWithSearch to="/supply-chain" />} />
              <Route path="/global-markets" element={<GlobalMarkets />} />
              <Route path="/chart-studio" element={<ChartStudio />} />
              <Route path="/options"    element={<OptionsPricer />} />
              <Route path="/bond"       element={<BondAnalytics />} />
              <Route path="/cusip"      element={<CusipLookup />} />
              <Route path="/nav"        element={<NAVTracker />} />
              <Route path="/portfolio-manager" element={<PortfolioManager />} />
              {/* Portfolio tools — now standalone (legacy /portfolio-skills hub dismantled) */}
              <Route path="/backtest"         element={<PortfolioBacktester />} />
              <Route path="/montecarlo"       element={<MonteCarlo />} />
              <Route path="/portfolio-optimizer" element={<PortfolioOptimizer />} />
              <Route path="/portfolio-compare" element={<PortfolioCompare />} />
              <Route path="/portfolio"        element={<Navigate to="/backtest" replace />} />
              <Route path="/portfolio-skills" element={<Navigate to="/backtest" replace />} />
              {/* Valuation tools — now standalone (legacy /valuation hub dismantled) */}
              <Route path="/dcf"         element={<DCFValuation />} />
              <Route path="/ddm"         element={<DividendDiscount />} />
              <Route path="/sotp"        element={<SOTP />} />
              <Route path="/multiples"   element={<Multiples />} />
              <Route path="/reverse-dcf" element={<ReverseDCF />} />
              <Route path="/valuation"   element={<Navigate to="/dcf" replace />} />
              <Route path="/probability" element={<ImpliedProbability />} />
              <Route path="/skew"       element={<SkewTool />} />
              <Route path="/fed"        element={<FedRates />} />
              <Route path="/corporate"  element={<CorporateHub />} />
              <Route path="/chain"      element={<OptionsChainScanner />} />
              <Route path="/correlation" element={<CorrelationAnalysis />} />
              <Route path="/strategy"   element={<StrategyBuilder />} />
              <Route path="/algo-strategy" element={<AlgoStrategyBuilder />} />
              <Route path="/gex"        element={<DealerGEX />} />
              <Route path="/dashboard"       element={<CustomDashboard />} />
              <Route path="/settings"        element={<SettingsPage />} />
              <Route path="/screener"        element={<StockScreener />} />
              <Route path="/earnings"        element={<EarningsSummarizer />} />
              <Route path="/earnings-calendar" element={<EarningsCalendar />} />
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
              <Route path="/relative-valuation"  element={<RelativeValuation />} />
              <Route path="/supply-chain"        element={<SupplyChain />} />
              <Route path="/gamma-scalping"      element={<Navigate to="/paper-trading" replace />} />
              <Route path="/trade-journal"       element={<TradeJournal />} />
              <Route path="/paper-trading"       element={<PaperTrading />} />
              <Route path="/algo-runner"         element={<Navigate to="/admin" replace />} />
              <Route path="/sentiment"           element={<SentimentTracker />} />
              <Route path="/alerts"             element={<AlertsPage />} />
              <Route path="/regression"         element={<RegressionAnalysis />} />
              <Route path="/options-hub"        element={<Navigate to="/options" replace />} />
              <Route path="/macro-hub"          element={<Navigate to="/fed" replace />} />
              <Route path="/research-hub"       element={<Navigate to="/corporate" replace />} />
              <Route path="/iv-tracker"         element={<IVTracker />} />
              <Route path="/market-maker"       element={<MarketMakerSimulator />} />
              <Route path="/fixed-income-mm"    element={<Navigate to="/market-maker?desk=fixed-income" replace />} />
              <Route path="/unusual-options"    element={<UnusualOptions />} />
              <Route path="/compare"            element={<Compare />} />
              <Route path="/etf-analyzer"       element={<EtfXray />} />
              <Route path="/etf-xray"           element={<Navigate to="/etf-analyzer" replace />} />
              <Route path="*"                   element={<Navigate to="/app" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </PortfolioProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
