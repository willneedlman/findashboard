import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'

// Dropdown restricted to a ticker's real option expiration dates. Listed option
// expiries are always trading days the market is open, so this is the single
// control that satisfies "only dates with option expiries, and the market is
// open" for any options-forecasting tool. Pass `expirations` to reuse a list the
// host already fetched; otherwise it fetches them itself.
function fmtExpiry(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  const dte = Math.round((d.getTime() - Date.now()) / 864e5)
  const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  return dte >= 0 ? `${label} · ${dte}d` : label
}

export default function ExpirySelect({
  ticker, value, onChange, expirations, style, disabled, autoSelect = true,
}: {
  ticker: string
  value: string
  onChange: (expiry: string) => void
  expirations?: string[]        // pass a known list to skip the fetch
  style?: React.CSSProperties
  disabled?: boolean
  // When true (default), auto-pick the nearest real expiry if the current value
  // isn't one — good for forecasting defaults. Set false for order entry, where a
  // blank expiry must stay blank until the user explicitly chooses.
  autoSelect?: boolean
}) {
  const sym = ticker.trim().toUpperCase()
  const shouldFetch = !expirations?.length && sym.length > 0 && !disabled
  const q = useQuery({
    queryKey: ['option-expirations', sym],
    queryFn:  () => axios.get(`/api/iv/expirations?ticker=${encodeURIComponent(sym)}`)
                      .then(r => (r.data?.expirations ?? []) as string[]),
    enabled:  shouldFetch,
    staleTime: 5 * 60_000,
    retry: 0,   // a no-options ticker 404s by design; don't retry/double-log it
  })
  const list = expirations?.length ? expirations : (q.data ?? [])
  const loading = shouldFetch && q.isLoading

  // Keep the selection valid: when the list arrives and the current value isn't a
  // real expiry, snap to the nearest one (or ~30d out when empty). The guard
  // returns early once value is in the list, so this can't loop.
  useEffect(() => {
    if (!autoSelect || !list.length || value && list.includes(value)) return
    const target = value ? new Date(value + 'T12:00:00').getTime() : Date.now() + 30 * 864e5
    const nearest = list.reduce((best, e) =>
      Math.abs(new Date(e + 'T12:00:00').getTime() - target) <
      Math.abs(new Date(best + 'T12:00:00').getTime() - target) ? e : best, list[0])
    onChange(nearest)
  }, [list, value, onChange])

  const base: React.CSSProperties = { ...style, cursor: 'pointer' }
  if (disabled || (!sym && !expirations?.length)) {
    return <select disabled style={{ ...base, cursor: 'not-allowed' }}><option>Enter a ticker</option></select>
  }
  if (loading) {
    return <select disabled style={base}><option>Loading expiries…</option></select>
  }
  if (!list.length) {
    return <select disabled style={{ ...base, cursor: 'not-allowed' }}><option>No listed options for this ticker</option></select>
  }
  return (
    <select value={list.includes(value) ? value : ''} onChange={e => onChange(e.target.value)} style={base}>
      {!list.includes(value) && <option value="" disabled>Select an expiry</option>}
      {list.map(e => <option key={e} value={e}>{fmtExpiry(e)}</option>)}
    </select>
  )
}
