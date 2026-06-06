import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { AnalysisProvider } from './context/AnalysisContext'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15 * 60_000,  // treat cached data as fresh for 15 min globally
      gcTime:    60 * 60_000,  // keep in memory for 1 hour
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AnalysisProvider>
          <App />
        </AnalysisProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
