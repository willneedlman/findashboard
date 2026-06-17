import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Layout from './components/Layout'
import { ThemeProvider, useTheme } from './contexts/ThemeContext'
import { PortfolioProvider } from './contexts/PortfolioContext'
import AccountSync from './components/AccountSync'
import { findToolByLocation } from './lib/hubs'
import { recordRecent } from './lib/recents'

// Marketing launchpad — chrome-free, lives at / and /product/*
const Landing        = lazy(() => import('./marketing/Marketing').then(m => ({ default: m.Landing })))
const MktOptions     = lazy(() => import('./marketing/Marketing').then(m => ({ default: m.OptionsPage })))
const MktValuation   = lazy(() => import('./marketing/Marketing').then(m => ({ default: m.ValuationPage })))
const MktPortfolio   = lazy(() => import('./marketing/Marketing').then(m => ({ default: m.PortfolioPage })))
const MktMacro       = lazy(() => import('./marketing/Marketing').then(m => ({ default: m.MacroPage })))
const MktTrading     = lazy(() => import('./marketing/Marketing').then(m => ({ default: m.TradingPage })))
const MktShell       = lazy(() => import('./marketing/Marketing').then(m => ({ default: m.MarketingShell })))

// Lazy-load all pages — crash in one route can't bring down the whole app
const Home               = lazy(() => import('./pages/Home'))
const MarketData         = lazy(() => import('./pages/MarketData'))
const OptionsPricer      = lazy(() => import('./pages/OptionsPricer'))
const BondAnalytics      = lazy(() => import('./pages/BondAnalytics'))
const NAVTracker         = lazy(() => import('./pages/NAVTracker'))
const ImpliedProbability = lazy(() => import('./pages/ImpliedProbability'))
const FedRates           = lazy(() => import('./pages/FedRates'))
const CorporateHub       = lazy(() => import('./pages/CorporateHub'))
const DCFValuation       = lazy(() => import('./pages/DCFValuation'))
const DividendDiscount   = lazy(() => import('./pages/DividendDiscount'))
const SOTP               = lazy(() => import('./pages/SOTP'))
const Multiples          = lazy(() => import('./pages/Multiples'))
const ReverseDCF         = lazy(() => import('./pages/ReverseDCF'))
const OptionsChainScanner = lazy(() => import('./pages/OptionsChainScanner'))
const RegressionAnalysis = lazy(() => import('./pages/RegressionAnalysis'))
const PortfolioBacktester = lazy(() => import('./pages/PortfolioBacktester'))
const MonteCarlo         = lazy(() => import('./pages/MonteCarlo'))
const PortfolioCompare   = lazy(() => import('./pages/PortfolioCompare'))
const SkewTool           = lazy(() => import('./pages/SkewTool'))
const StrategyBuilder    = lazy(() => import('./pages/StrategyBuilder'))
const DealerGEX          = lazy(() => import('./pages/DealerGEX'))
const CustomDashboard    = lazy(() => import('./pages/CustomDashboard'))
const PrivacyPolicy      = lazy(() => import('./pages/legal/PrivacyPolicy'))
const TermsOfUse         = lazy(() => import('./pages/legal/TermsOfUse'))
const RiskDisclosure     = lazy(() => import('./pages/legal/RiskDisclosure'))
const DataSources        = lazy(() => import('./pages/legal/DataSources'))
const SettingsPage       = lazy(() => import('./pages/Settings'))
const StockScreener      = lazy(() => import('./pages/StockScreener'))
const EarningsSummarizer = lazy(() => import('./pages/EarningsSummarizer'))
const PortfolioManager   = lazy(() => import('./pages/PortfolioManager'))
const AdminTester        = lazy(() => import('./pages/AdminTester'))
const CreditSpreads      = lazy(() => import('./pages/CreditSpreads'))
const RelativeValuation  = lazy(() => import('./pages/RelativeValuation'))
const SupplyChain        = lazy(() => import('./pages/SupplyChain'))
const TradeJournal       = lazy(() => import('./pages/TradeJournal'))
const PaperTrading       = lazy(() => import('./pages/PaperTrading'))
const SentimentTracker   = lazy(() => import('./pages/SentimentTracker'))
const AlertsPage         = lazy(() => import('./pages/Alerts'))
const EconomyMonitor     = lazy(() => import('./pages/EconomyMonitor'))
const SectorRotation     = lazy(() => import('./pages/SectorRotation'))
const ResearchHub        = lazy(() => import('./pages/ResearchHub'))
const IVTracker          = lazy(() => import('./pages/IVTracker'))
const OptionsMarketMaker = lazy(() => import('./pages/OptionsMarketMaker'))
const UnusualOptions     = lazy(() => import('./pages/UnusualOptions'))
const Compare            = lazy(() => import('./pages/Compare'))
const ResetPassword      = lazy(() => import('./pages/ResetPassword'))
const HubLanding         = lazy(() => import('./pages/HubLanding'))

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
  // Record tool visits for the Home "Jump Back In" row.
  useEffect(() => {
    const tool = findToolByLocation(location.pathname, location.search)
    if (tool) recordRecent(tool.route)
  }, [location.pathname, location.search])
  return (
    <Layout>
      <AnimatePresence mode="wait">
        <Suspense key={location.pathname} fallback={<PageLoader />}>
          <Outlet />
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
            <Route path="/product/options"   element={<MktOptions />} />
            <Route path="/product/valuation" element={<MktValuation />} />
            <Route path="/product/portfolio" element={<MktPortfolio />} />
            <Route path="/product/macro"     element={<MktMacro />} />
            <Route path="/product/trading"   element={<MktTrading />} />

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
              <Route path="/hub/:slug"  element={<HubLanding />} />
              <Route path="/market"     element={<MarketData />} />
              <Route path="/options"    element={<OptionsPricer />} />
              <Route path="/bond"       element={<BondAnalytics />} />
              <Route path="/nav"        element={<NAVTracker />} />
              <Route path="/portfolio-manager" element={<PortfolioManager />} />
              {/* Portfolio tools — now standalone (legacy /portfolio-skills hub dismantled) */}
              <Route path="/backtest"         element={<PortfolioBacktester />} />
              <Route path="/montecarlo"       element={<MonteCarlo />} />
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
              <Route path="/correlation" element={<Navigate to="/regression" replace />} />
              <Route path="/strategy"   element={<StrategyBuilder />} />
              <Route path="/gex"        element={<DealerGEX />} />
              <Route path="/dashboard"       element={<CustomDashboard />} />
              <Route path="/settings"        element={<SettingsPage />} />
              <Route path="/screener"        element={<StockScreener />} />
              <Route path="/earnings"        element={<EarningsSummarizer />} />
              <Route path="/admin"           element={<AdminTester />} />
              <Route path="/stress-test"     element={<Navigate to="/admin" replace />} />
              <Route path="/sector-rotation" element={<SectorRotation />} />
              <Route path="/economy"             element={<EconomyMonitor />} />
              <Route path="/credit-spreads"      element={<CreditSpreads />} />
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
              <Route path="/research-hub"       element={<ResearchHub />} />
              <Route path="/iv-tracker"         element={<IVTracker />} />
              <Route path="/market-maker"       element={<OptionsMarketMaker />} />
              <Route path="/unusual-options"    element={<UnusualOptions />} />
              <Route path="/compare"            element={<Compare />} />
              <Route path="*"                   element={<Navigate to="/app" replace />} />
            </Route>
          </Routes>
        </Suspense>
      </PortfolioProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
