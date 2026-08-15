// Option-strategy leg templates for the paper-trading order ticket.
// Pure data + the types they satisfy — extracted from PaperTrading.tsx so the
// page module carries logic and rendering, not static tables.

export interface LegState { expDate: string; strike: string; callPut: 'C' | 'P'; side: string; qty: string }
export const EMPTY_LEG: LegState = { expDate: '', strike: '', callPut: 'C', side: 'buy_to_open', qty: '1' }

export interface StrategyTemplate {
  name: string; shortName: string; orderType: string
  legs: { side: string; qty: string; hint: string }[]
  description: string
}

export const OPTION_STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    name: 'Bull Call Spread', shortName: 'Bull Call', orderType: 'debit',
    description: 'Buy lower strike call, sell higher strike call. Capped upside, defined risk.',
    legs: [
      { side: 'buy_to_open',  qty: '1', hint: 'Long call, lower strike (ATM)' },
      { side: 'sell_to_open', qty: '1', hint: 'Short call, higher strike (OTM)' },
    ],
  },
  {
    name: 'Bear Put Spread', shortName: 'Bear Put', orderType: 'debit',
    description: 'Buy higher strike put, sell lower strike put. Bearish, defined risk.',
    legs: [
      { side: 'buy_to_open',  qty: '1', hint: 'Long put, higher strike (ATM)' },
      { side: 'sell_to_open', qty: '1', hint: 'Short put, lower strike (OTM)' },
    ],
  },
  {
    name: 'Bull Put Spread', shortName: 'Bull Put', orderType: 'credit',
    description: 'Sell higher strike put, buy lower strike put. Collect premium. Profit if stock stays above short strike.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short put, higher strike (slightly OTM)' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long put, lower strike (further OTM)' },
    ],
  },
  {
    name: 'Bear Call Spread', shortName: 'Bear Call', orderType: 'credit',
    description: 'Sell lower strike call, buy higher strike call. Collect premium. Profit if stock stays below short strike.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short call, lower strike (slightly OTM)' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long call, higher strike (further OTM)' },
    ],
  },
  {
    name: 'Long Straddle', shortName: 'Straddle', orderType: 'debit',
    description: 'Buy ATM call + put same strike/expiry. Profits from large move in either direction.',
    legs: [
      { side: 'buy_to_open', qty: '1', hint: 'Long call. ATM strike' },
      { side: 'buy_to_open', qty: '1', hint: 'Long put, same ATM strike' },
    ],
  },
  {
    name: 'Short Straddle', shortName: 'Sh. Straddle', orderType: 'credit',
    description: 'Sell ATM call + put. Max profit if stock pins at strike. Unlimited risk.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short call. ATM strike' },
      { side: 'sell_to_open', qty: '1', hint: 'Short put, same ATM strike' },
    ],
  },
  {
    name: 'Long Strangle', shortName: 'Strangle', orderType: 'debit',
    description: 'Buy OTM call + OTM put. Cheaper than straddle. Needs bigger move.',
    legs: [
      { side: 'buy_to_open', qty: '1', hint: 'Long call. OTM strike above current' },
      { side: 'buy_to_open', qty: '1', hint: 'Long put. OTM strike below current' },
    ],
  },
  {
    name: 'Iron Condor', shortName: 'Iron Condor', orderType: 'credit',
    description: 'Sell OTM call spread + OTM put spread. Profit in range-bound market.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short put, lower inner strike' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long put, lowest strike (wing)' },
      { side: 'sell_to_open', qty: '1', hint: 'Short call, upper inner strike' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long call, highest strike (wing)' },
    ],
  },
  {
    name: 'Iron Butterfly', shortName: 'Iron Fly', orderType: 'credit',
    description: 'Sell ATM straddle + buy OTM wings. Max credit at-the-money.',
    legs: [
      { side: 'buy_to_open',  qty: '1', hint: 'Long put wing, lowest strike' },
      { side: 'sell_to_open', qty: '1', hint: 'Short put. ATM strike' },
      { side: 'sell_to_open', qty: '1', hint: 'Short call, same ATM strike' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long call wing, highest strike' },
    ],
  },
  {
    name: 'Covered Call', shortName: 'Cov. Call', orderType: 'credit',
    description: 'Long 100 shares (equity tab) + sell OTM call. Income on held position.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short call. OTM strike above cost basis' },
    ],
  },
  {
    name: 'Protective Put', shortName: 'Prot. Put', orderType: 'debit',
    description: 'Long 100 shares (equity tab) + buy put as insurance.',
    legs: [
      { side: 'buy_to_open', qty: '1', hint: 'Long put, strike at or below entry price' },
    ],
  },
  {
    name: 'Calendar Spread', shortName: 'Calendar', orderType: 'debit',
    description: 'Sell near-term ATM option, buy same-strike further-dated option. Profits from time decay difference.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short near-term, same strike, closer expiry' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long far-term, same strike, further expiry' },
    ],
  },
]
