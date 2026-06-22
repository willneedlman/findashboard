import { useState, useMemo, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import { useChartColors } from '../hooks/useChartColors'
import StrategySelector, { STRATEGIES, CUSTOM_STRATEGY_KEY, type StrategyParams } from '../components/StrategySelector'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import { FUTURES } from '../lib/futures'
import ChartTooltip from '../components/ChartTooltip'
import axios from 'axios'
import SidebarLayout from '../components/SidebarLayout'
import { RailSection } from './valuationShared'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import PMImportPicker from '../components/PMImportPicker'
import { CASH_SYMBOL, type ImportResult } from '../lib/pmImport'
import { usePortfolio } from '../contexts/PortfolioContext'
import { weightTotal, normalizeTo100 } from '../components/portfolio/weights'
import HelpTip from '../components/HelpTip'
import { PortfolioTab } from './portfolio-backtester/components'

// ── Backtester page ──────────────────────────────────────────────────────────

export default function PortfolioBacktester() {
  return (
    <PageWrapper title="Portfolio Backtester">
      <PortfolioTab />
    </PageWrapper>
  )
}
