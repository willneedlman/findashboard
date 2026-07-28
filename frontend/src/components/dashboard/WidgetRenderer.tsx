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
import SectorRotationWidget from './widgets/SectorRotationWidget'
import DealerGEXWidget from './widgets/DealerGEXWidget'
import VolSkewWidget from './widgets/VolSkewWidget'
import SentimentWidget from './widgets/SentimentWidget'
import ScreenerWidget from './widgets/ScreenerWidget'
import PMPortfoliosWidget from './widgets/PMPortfoliosWidget'
import PaperTradeWidget from './widgets/PaperTradeWidget'
import IndexTapeWidget from './widgets/IndexTapeWidget'
import AnalystRatingsWidget from './widgets/AnalystRatingsWidget'
import ValuationWidget from './widgets/ValuationWidget'
import InsiderWidget from './widgets/InsiderWidget'
import RiskMetricsWidget from './widgets/RiskMetricsWidget'
import PnLAttributionWidget from './widgets/PnLAttributionWidget'
import FactorDecompositionWidget from './widgets/FactorDecompositionWidget'
import TimeAndSalesWidget from './widgets/TimeAndSalesWidget'
import UnusualFlowWidget from './widgets/UnusualFlowWidget'
import HeatmapWidget from './widgets/HeatmapWidget'
import TradeBlotterWidget from './widgets/TradeBlotterWidget'
import PositionSizerWidget from './widgets/PositionSizerWidget'
import MarketHoursWidget from './widgets/MarketHoursWidget'

export default function WidgetRenderer({ config }: { config: WidgetConfig }) {
  switch (config.type) {
    case 'market-hours':      return <MarketHoursWidget config={config} />
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
    case 'sector-rotation':    return <SectorRotationWidget config={config} />
    case 'dealer-gex':         return <DealerGEXWidget config={config} />
    case 'vol-skew':           return <VolSkewWidget config={config} />
    case 'sentiment-gauge':    return <SentimentWidget config={config} />
    case 'screener':           return <ScreenerWidget config={config} />
    case 'pm-portfolios':      return <PMPortfoliosWidget config={config} />
    case 'paper-trade':        return <PaperTradeWidget config={config} />
    case 'index-tape':         return <IndexTapeWidget config={config} />
    case 'analyst-ratings':    return <AnalystRatingsWidget config={config} />
    case 'valuation':          return <ValuationWidget config={config} />
    case 'insider-activity':   return <InsiderWidget config={config} />
    case 'risk-metrics':       return <RiskMetricsWidget config={config} />
    case 'pnl-attribution':    return <PnLAttributionWidget config={config} />
    case 'factor-decomposition': return <FactorDecompositionWidget config={config} />
    case 'time-and-sales':     return <TimeAndSalesWidget config={config} />
    case 'unusual-flow':       return <UnusualFlowWidget config={config} />
    case 'heatmap':            return <HeatmapWidget config={config} />
    case 'trade-blotter':      return <TradeBlotterWidget config={config} />
    case 'position-sizer':     return <PositionSizerWidget config={config} />
    default:                   return null
  }
}
