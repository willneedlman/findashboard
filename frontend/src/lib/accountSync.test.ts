import { describe, expect, it } from 'vitest'
import { isSynced } from './accountSync'

// What must never follow the account matters more than what does: uploading the
// session token would hand one device's login to every other device on the
// account, and a one-shot handoff blob would replay a stale trade ticket.
describe('what syncs', () => {
  it('carries the saved work', () => {
    for (const key of [
      'pm-portfolios-v2', 'ft-portfolio-manager', 'pm-options-v1', 'pm-futures-v1',
      'alerts', 'watchlist', 'finance-terminal-dashboard-v3', 'fdb_custom_strategies',
      'fdb_screener_saved_screens_v1', 'ft_custom_metrics_v1', 'fdb_report_creator_v1',
      'ft_recents', 'ft_recent_tickers', 'ft_nav_favorites', 'pe_wl',
    ]) {
      expect(isSynced(key), key).toBe(true)
    }
  })

  it('carries keys whose name holds an id', () => {
    expect(isSynced('paper-overlays-abc123')).toBe(true)
    expect(isSynced('paper-chart-overlays-main')).toBe(true)
  })

  it('never carries credentials, device flags, or handoffs', () => {
    for (const key of [
      'ft-session-token',          // uploading this shares the login itself
      'ft-notif-asked',            // a permission this browser granted
      'ft-alert-toasts',           // transient queue
      'ft-morning-brief-seen-day', // per-device day gate
      'ft-launched',
      'ft_pending_option_strategy',                  // one-shot handoff
      'fdb_algo_universe_monte_carlo_handoff',       // one-shot handoff
      'ft-portfolio',              // has its own portfolio_json sync; two writers would fight
    ]) {
      expect(isSynced(key), key).toBe(false)
    }
  })

  it('does not match a prefix that only looks similar', () => {
    expect(isSynced('paper-overlays')).toBe(false)
    expect(isSynced('ft_recents_backup')).toBe(false)
  })
})
