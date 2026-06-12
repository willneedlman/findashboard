import type { WidgetConfig } from '../../hooks/useDashboard'
import PriceCard from './widgets/PriceCard'
import MiniChart from './widgets/MiniChart'
import NewsFeed from './widgets/NewsFeed'
import Watchlist from './widgets/Watchlist'
import MacroStrip from './widgets/MacroStrip'
import EarningsCalendar from './widgets/EarningsCalendar'
import OptionsSnapshot from './widgets/OptionsSnapshot'
import PortfolioSummary from './widgets/PortfolioSummary'
import OptionsPricerWidget from './widgets/OptionsPricerWidget'
import DeltaPriceTarget from './widgets/DeltaPriceTarget'
import TradingViewChart from './widgets/TradingViewChart'
import CorrelationMatrixWidget from './widgets/CorrelationMatrix'
import MacroCalendar from './widgets/MacroCalendar'
import GlobalMacro from './widgets/GlobalMacro'
import CreditSpreadsWidget from './widgets/CreditSpreadsWidget'
import YieldCurveWidget from './widgets/YieldCurveWidget'

export default function WidgetRenderer({ config }: { config: WidgetConfig }) {
  switch (config.type) {
    case 'price-card':        return <PriceCard config={config} />
    case 'mini-chart':        return <MiniChart config={config} />
    case 'news-feed':         return <NewsFeed config={config} />
    case 'watchlist':         return <Watchlist config={config} />
    case 'macro-strip':       return <MacroStrip config={config} />
    case 'earnings-calendar': return <EarningsCalendar config={config} />
    case 'options-snapshot':  return <OptionsSnapshot config={config} />
    case 'portfolio-summary': return <PortfolioSummary config={config} />
    case 'options-pricer':    return <OptionsPricerWidget config={config} />
    case 'delta-target':      return <DeltaPriceTarget config={config} />
    case 'tradingview-chart':  return <TradingViewChart config={config} />
    case 'correlation-matrix': return <CorrelationMatrixWidget config={config} />
    case 'macro-calendar':     return <MacroCalendar config={config} />
    case 'global-macro':       return <GlobalMacro config={config} />
    case 'credit-spreads':     return <CreditSpreadsWidget config={config} />
    case 'yield-curve':        return <YieldCurveWidget config={config} />
    default:                   return null
  }
}
