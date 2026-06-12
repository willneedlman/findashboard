import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Layout from './components/Layout'
import { ThemeProvider } from './contexts/ThemeContext'
import { PortfolioProvider } from './contexts/PortfolioContext'

// Lazy-load all pages — crash in one route can't bring down the whole app
const Home               = lazy(() => import('./pages/Home'))
const MarketData         = lazy(() => import('./pages/MarketData'))
const OptionsPricer      = lazy(() => import('./pages/OptionsPricer'))
const BondAnalytics      = lazy(() => import('./pages/BondAnalytics'))
const NAVTracker         = lazy(() => import('./pages/NAVTracker'))
const PortfolioBacktester = lazy(() => import('./pages/PortfolioBacktester'))
const MonteCarlo         = lazy(() => import('./pages/MonteCarlo'))
const ImpliedProbability = lazy(() => import('./pages/ImpliedProbability'))
const FedRates           = lazy(() => import('./pages/FedRates'))
const CorporateHub       = lazy(() => import('./pages/CorporateHub'))
const DCFValuation       = lazy(() => import('./pages/DCFValuation'))
const OptionsChainScanner = lazy(() => import('./pages/OptionsChainScanner'))
const CorrelationMatrix  = lazy(() => import('./pages/CorrelationMatrix'))
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
const StressTester       = lazy(() => import('./pages/StressTester'))
const SectorRotation     = lazy(() => import('./pages/SectorRotation'))
const CreditSpreads      = lazy(() => import('./pages/CreditSpreads'))
const RelativeValuation  = lazy(() => import('./pages/RelativeValuation'))
const SupplyChain        = lazy(() => import('./pages/SupplyChain'))
const TradeJournal       = lazy(() => import('./pages/TradeJournal'))
const PaperTrading       = lazy(() => import('./pages/PaperTrading'))
const AlgoRunner         = lazy(() => import('./pages/AlgoRunner'))
const SentimentTracker   = lazy(() => import('./pages/SentimentTracker'))
const AlertsPage         = lazy(() => import('./pages/Alerts'))
const RegressionAnalysis = lazy(() => import('./pages/RegressionAnalysis'))
const OptionsHub         = lazy(() => import('./pages/OptionsHub'))
const MacroHub           = lazy(() => import('./pages/MacroHub'))
const ResearchHub        = lazy(() => import('./pages/ResearchHub'))
const IVTracker          = lazy(() => import('./pages/IVTracker'))
const OptionsMarketMaker = lazy(() => import('./pages/OptionsMarketMaker'))
const UnusualOptions     = lazy(() => import('./pages/UnusualOptions'))

function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#2e4460' }}>
        Loading…
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
      <PortfolioProvider>
      <Layout>
        <AnimatePresence mode="wait">
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/"           element={<Home />} />
              <Route path="/market"     element={<MarketData />} />
              <Route path="/options"    element={<OptionsPricer />} />
              <Route path="/bond"       element={<BondAnalytics />} />
              <Route path="/nav"        element={<NAVTracker />} />
              <Route path="/portfolio"  element={<PortfolioBacktester />} />
              <Route path="/portfolio-manager" element={<PortfolioManager />} />
              <Route path="/montecarlo" element={<MonteCarlo />} />
              <Route path="/probability" element={<ImpliedProbability />} />
              <Route path="/fed"        element={<FedRates />} />
              <Route path="/corporate"  element={<CorporateHub />} />
              <Route path="/dcf"        element={<DCFValuation />} />
              <Route path="/chain"      element={<OptionsChainScanner />} />
              <Route path="/correlation" element={<CorrelationMatrix />} />
              <Route path="/strategy"   element={<StrategyBuilder />} />
              <Route path="/gex"        element={<DealerGEX />} />
              <Route path="/dashboard"       element={<CustomDashboard />} />
              <Route path="/privacy"         element={<PrivacyPolicy />} />
              <Route path="/terms"           element={<TermsOfUse />} />
              <Route path="/risk-disclosure" element={<RiskDisclosure />} />
              <Route path="/data-sources"    element={<DataSources />} />
              <Route path="/settings"        element={<SettingsPage />} />
              <Route path="/screener"        element={<StockScreener />} />
              <Route path="/earnings"        element={<EarningsSummarizer />} />
              <Route path="/admin"           element={<AdminTester />} />
              <Route path="/stress-test"     element={<StressTester />} />
              <Route path="/sector-rotation" element={<SectorRotation />} />
              <Route path="/credit-spreads"      element={<CreditSpreads />} />
              <Route path="/relative-valuation"  element={<RelativeValuation />} />
              <Route path="/supply-chain"        element={<SupplyChain />} />
              <Route path="/gamma-scalping"      element={<Navigate to="/paper-trading" replace />} />
              <Route path="/trade-journal"       element={<TradeJournal />} />
              <Route path="/paper-trading"       element={<PaperTrading />} />
              <Route path="/algo-runner"         element={<AlgoRunner />} />
              <Route path="/sentiment"           element={<SentimentTracker />} />
              <Route path="/alerts"             element={<AlertsPage />} />
              <Route path="/regression"         element={<RegressionAnalysis />} />
              <Route path="/options-hub"        element={<OptionsHub />} />
              <Route path="/macro-hub"          element={<MacroHub />} />
              <Route path="/research-hub"       element={<ResearchHub />} />
              <Route path="/iv-tracker"         element={<IVTracker />} />
              <Route path="/market-maker"       element={<OptionsMarketMaker />} />
              <Route path="/unusual-options"    element={<UnusualOptions />} />
            </Routes>
          </Suspense>
        </AnimatePresence>
      </Layout>
      </PortfolioProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}
