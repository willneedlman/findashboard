import { useEffect, useState } from 'react'
import {
  PORTFOLIO_CONTEXT_EVENT,
  readActivePortfolioContext,
  type ActivePortfolioContext,
} from '../lib/pmImport'

export default function useActivePortfolio(): ActivePortfolioContext {
  const [portfolio, setPortfolio] = useState<ActivePortfolioContext>(readActivePortfolioContext)

  useEffect(() => {
    const refresh = () => setPortfolio(readActivePortfolioContext())
    window.addEventListener(PORTFOLIO_CONTEXT_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(PORTFOLIO_CONTEXT_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  return portfolio
}
