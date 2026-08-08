from build_inv import row, prov
O = 'backend/routers/options.py'

row('gex_net','derived_metric','Dealer GEX','Net gamma exposure by strike',
    'Dealer gamma exposure in $mm per 1% move in the underlying, per strike.',
    'sign * open_interest * 100 * gamma * spot^2 * 0.01 / 1e6, summed calls positive and puts negative into net_gex per strike',
    'Tradier chain when the key is live, else yfinance chain; Black-Scholes gamma computed in-house',
    prov('/api/options/exposure', f'{O}:895 and {O}:941'),
    'intraday on request, cached per ticker/expiry set',
    'Positive net gamma means dealers are long gamma and hedge against the move, damping volatility. Negative means they hedge with the move, amplifying it. The magnitude is dollars of hedging per 1% move, so it scales with the underlying and is not comparable across tickers of different price.',
    'Assumes every open contract is dealer-short calls and dealer-long puts, which is the standard convention and frequently wrong for single names with heavy retail call buying. Open interest is previous-session settled, so intraday positioning is invisible.')

row('gex_flip','derived_metric','Dealer GEX','Gamma flip level',
    'The underlying price at which cumulative dealer gamma crosses zero.',
    'walk strikes ordered by price, linear interpolation between the two strikes where net_gex changes sign, pick the crossing nearest spot',
    'derived from the strike ladder', prov('/api/options/exposure', f'{O}:741-767 _gex_levels()'),
    'intraday, recorded into a daily snapshot table',
    'Above the flip, dealers dampen moves; below it they amplify. Traders treat it as a regime boundary rather than a target. Also available as an alert condition (price_cross_gex_flip) and stored in the GEX snapshot history so the level can be tracked over time.',
    'Interpolated, not observed, so it is only as good as the strike spacing. On a thin chain the nearest crossing can jump several percent between sessions for reasons that have nothing to do with positioning.')

row('gex_walls','derived_metric','Dealer GEX','Call wall / put wall',
    'The strikes carrying the largest positive and largest negative net gamma.',
    'argmax(net_gex) among positive strikes; argmin(net_gex) among negative strikes',
    'derived', prov('/api/options/exposure', f'{O}:756-764'),
    'intraday',
    'Commonly read as magnet or resistance levels because dealer hedging concentrates there. Most useful near expiry, when gamma is largest and the effect is strongest.',
    'A wall is only the biggest strike in the current chain; it moves when a single large position rolls. No implication that price will respect it.')

row('flow_vol_oi','derived_metric','Options Scanner','Volume / open interest ratio',
    'How today contract volume compares with the standing open interest at that strike.',
    'volume / open_interest per contract, filtered by min_volume and min_vol_oi thresholds',
    'Tradier chain, falling back to yfinance', prov('/api/options/unusual', f'{O}:1411 _scan_ticker_unusual()'),
    'intraday on request',
    'A ratio above 1 means more contracts traded today than were outstanding, which is the standard screen for new positioning rather than closing trades. Grouped by underlying so a name appearing on several strikes is visible as one story.',
    'This is the whole of what the tool calls "flow". Sweep, block and premium tagging are NOT derivable: Tradier returns 11 fields and volume is a daily aggregate with no trade-level prints, so the tagging column was removed rather than fabricated. Real flow tagging needs an OPRA-derived vendor. Tradier failures fall back to the chain and are reported per symbol in a `failed` map.')

row('iv_rank','derived_metric','Volatility Scanner','IV rank and IV percentile',
    'Where current implied volatility sits inside its own one-year range.',
    'iv_rank = (current - min) / (max - min) * 100; iv_percentile = share of days below current * 100',
    'IV series accrued into a local snapshot history',
    prov('/api/iv/rank', 'backend/routers/iv_tracker.py:201 iv_rank_percentile()'),
    'daily snapshot accrual',
    'Rank answers "how expensive is vol against its own year" and is the standard trigger for premium selling above ~50 and buying below ~20. Percentile is the more robust of the two because a single spike sets the range that rank divides by. Also available as an alert condition.',
    'Both need a year of accrued snapshots; a ticker only recently tracked has a short and therefore flattering range. There is no historical IV surface from any current vendor, so the series starts when this app started recording it, not when the option started trading.')

row('implied_move','derived_metric','Implied Probability','Implied move and straddle',
    'The move the options market is pricing into an expiry.',
    'ATM straddle mid price as a percentage of spot',
    'chain', prov('/api/prob/cone'),
    'intraday on request',
    'The break-even move for an ATM straddle buyer, and the market consensus range into an event. Compare with the historical average move for the same event to see whether options are cheap or dear.',
    'A single-expiry snapshot from mid prices; a wide bid-ask on either leg inflates it. Says nothing about direction.')

row('risk_neutral_density','model','Implied Probability','Probability of finishing above a strike',
    'The market-implied distribution of the underlying at expiry.',
    'Black-Scholes risk-neutral probability from the chain implied vol surface, rendered as a density and a cumulative curve',
    'chain + BS', prov('/api/prob/chain-distribution'),
    'intraday on request',
    'Answers "what odds is the market giving this level". The cumulative curve is the directly usable one for a strike decision.',
    'Risk-neutral, not real-world: it embeds the risk premium, so it is not a forecast of actual probability. Assumes lognormal BS dynamics, which understates tails. Unavailable when the ticker has no listed options, and the page says so rather than showing an empty chart.')

row('strategy_payoff','model','Options Strategy','Payoff and P&L at expiry',
    'Profit and loss across underlying prices for a multi-leg structure, with break-evens.',
    'sum of per-leg intrinsic value at expiry minus net premium, evaluated across a price grid; live P&L uses BS marks',
    'in-house', prov('/api/options/multi-leg'),
    'on request',
    'The standard structure diagram. Break-evens and max loss are the two numbers to read before the shape. A built structure can be handed to Paper Trading as a multi-leg order.',
    'Expiry payoff ignores the path, early assignment and financing. Max profit on a naked short leg is bounded in the chart but unbounded in reality.')
