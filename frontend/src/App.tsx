import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import Layout from './components/Layout'
import { ThemeProvider } from './contexts/ThemeContext'

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

function PageLoader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
      <div style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#2e4460' }}>
        Loading…
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
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
            </Routes>
          </Suspense>
        </AnimatePresence>
      </Layout>
      </ThemeProvider>
    </BrowserRouter>
  )
}
