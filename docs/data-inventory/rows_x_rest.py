from build_inv import row, prov

# ── Paper Trading ──
PA = prov('/api/paper/account')
def pt(id, name, defn, formula, interp, lim, kind='derived_metric'):
    row(id, kind, 'Paper Trading', name, defn, formula, 'in-house paper engine, SQLite persisted',
        PA, 'polling; scheduler loop every 3s', interp, lim)

pt('pt_equity','Account equity and buying power','Total account value and what can still be deployed.',
   'equity = cash + marked position value; buying power from the margin model',
   'The simulated account state. Equity is marked continuously against live quotes rather than at end of day.',
   'Margin model is simplified: one maintenance rate rather than per-security requirements, and no portfolio margin.')
pt('pt_positions','Open positions and unrealised P&L','Live positions with mark and gain or loss.',
   'quantity x (mark - average entry); options marked at the chain mid or a BS value',
   'Equity and multi-leg option positions in one book. Structures built in the Options tools arrive here through a localStorage handoff as an approvable order.',
   'Marks at mid with no bid-ask haircut, so an illiquid option position shows an unrealisably good P&L.')
pt('pt_orders','Working and filled orders','Order state through the lifecycle.','-',
   'Includes multi-leg option orders, which is the part most paper simulators omit.',
   'Fills at the quoted mid with no slippage, no partial fills and no queue position. Any strategy whose edge depends on execution is flattered.', 'feed_field')
pt('pt_realized','Realised P&L','Locked-in profit and loss on closed positions.',
   'sum over closed lots of (exit - entry) x quantity, less modelled fees',
   'The scoreboard. Separate from unrealised so a book cannot look profitable purely on paper marks.',
   'No tax-lot selection: closes are matched in engine order rather than by a user-chosen lot, so this cannot support tax reporting.')
pt('pt_scheduler','Scheduled strategy jobs','Automated strategies running against the paper account.',
   'jobs evaluated on a 3s loop, default 60s cadence per job, 3s for fast jobs',
   'Turns a saved strategy into something that runs unattended, which is the closest the app gets to live automation.',
   'Runs only while the server is up; a restart drops in-flight state back to the last persisted job record.', 'model')

# ── Global Markets board detail ──
GB = prov('/api/market/global-board')
def gb(id, name, defn, interp, lim, formula='-', kind='feed_field'):
    row(id, kind, 'Global Markets', name, defn, formula, 'yfinance batched download; FRED for the 2-year yield',
        GB, '10m-1h intraday, cached 2m in memory and on disk', interp, lim)

gb('gm_indices','World equity indices','25 index rows across Americas, Europe and Asia-Pacific.',
   'One batched request covers the whole board. Outside the US cash session the Americas rows swap to CME futures proxies and are flagged is_cme_proxy.',
   'A futures proxy is a different instrument from the cash index. Foreign indices show their last completed session, so a green row can be many hours old.')
gb('gm_fx','FX pairs','Ten major currency pairs including the dollar index.',
   'Quoting convention differs by pair and is shown as labelled (EUR/USD versus USD/JPY), so the sign of a move means opposite things across rows.',
   'yfinance FX is indicative rather than a tradable quote and carries no spread. Weekend prints are stale from the Friday close.')
gb('gm_commodities','Commodities','Ten futures rows across energy, metals and grains.',
   'Front-month futures, so a roll shows as a price jump that is not a market move.',
   'No term structure, roll yield or contango indication anywhere in the app; that would need a futures data vendor. Contract months are not labelled on the board.')
gb('gm_yields','US Treasury yields','Five points on the curve from 13-week to 30-year.',
   'The board switches these rows to basis-point changes rather than percentage returns, because a yield going 4.00 to 4.66 has not returned 16%.',
   'The 2-year comes from FRED and updates on a different schedule from the yfinance rows beside it, so the curve can be internally inconsistent intraday.')
gb('gm_crypto','Crypto','Bitcoin, Ethereum and Solana spot.',
   'Trades continuously, so these are the only rows that are live at the weekend.',
   'Spot only. No dominance, funding rate or open interest, which are perpetual-swap data and would need a derivatives source; Binance.US does not list perps.')
gb('gm_spark','Row sparkline and status','A short price path per row, and the freshness of the data.',
   'Status is one of intraday, delayed, end_of_day or unavailable and should be read before the number itself.',
   'The sparkline is drawn from the same window as the selected performance period, so changing the window changes the shape as well as the number.',
   'sequence of closes over the selected window', 'derived_metric')

# ── Geo-Logistics detail ──
def geo(id, tool, name, defn, formula, src, p, cad, interp, lim, kind='feed_field'):
    row(id, kind, tool, name, defn, formula, src, p, cad, interp, lim)

geo('fm_vessels','Freight Map','Live vessel positions and classification',
    'Ships on the map with type, speed, heading and destination.',
    'AIS position reports matched to a vessel registry and classified by type',
    'aisstream websocket', prov('/api/maritime/vessels'), 'streaming, 96h rolling window',
    'The live layer. Vessel type classification is what makes a tanker count meaningful rather than a boat count.',
    'Requires AISSTREAM_API_KEY, and the whole live maritime subsystem is gated off on Fly by ENABLE_LIVE_MARITIME, so production currently shows no vessels at all. AIS coverage is patchy beyond coastal receivers and transponders can be switched off.')
geo('fm_chokepoints','Freight Map','Chokepoint transit counts and status',
    'Daily transits through each major strait, and a congestion status.',
    'PortWatch transit counts, with a status derived against the trailing baseline',
    'IMF PortWatch ArcGIS', prov('/api/maritime/chokepoint-stats'), 'cached 1h, source lags 3-4 days',
    'The structural series. A congested status against a multi-year baseline is more meaningful than a raw count, which is seasonal.',
    'PortWatch publishes 3-4 days behind, so this cannot show a disruption as it happens. Port ids are resolved by keyword at runtime, which is how the Danish straits map to Oresund.', 'derived_metric')
geo('fm_chokepoint_history','Energy Flows','Chokepoint transit history and comparison',
    'Transit counts over time per chokepoint, comparable across straits.',
    'the PortWatch series accumulated and normalised for comparison',
    'IMF PortWatch', prov('/api/maritime/chokepoint-history'), 'cached 1h',
    'Puts a current reading in context. A 20% fall means nothing without the seasonal shape behind it.',
    'Inherits the 3-4 day lag. History depth varies by chokepoint depending on when PortWatch began covering it.', 'derived_metric')
geo('sc_facilities','Supply Chain Map','Supplier facilities and geocoded nodes',
    'Physical supplier locations tied to listed companies.', '-',
    'bundled supply_chain.db from Veridion/Dewey extracts', prov('/api/corporate/facilities'),
    'build-time ETL, bounded SQLite',
    'The physical layer under the relationship graph: where production actually sits, rather than where a company is domiciled.',
    'Only geocoded, tickered companies appear, which is a small and biased subset of the roughly 16k-company database. No as-of date is surfaced in the UI.')
geo('tf_partners','Trade Flows','Partner breakdown and share',
    'Trade value and weight by partner country for a reporter and commodity.',
    'share = partner value / total reported value',
    'UN Comtrade', prov('/api/comtrade/flows'), 'annual data, cached',
    'The concentration read: a commodity where one partner is 60% of flow is a supply-chain risk that no company-level disclosure will show.',
    'Annual and lagged a year or more. Reporter and partner figures for the same flow routinely disagree because of valuation and transshipment; only the reporter side is shown.', 'derived_metric')

# ── Misc singles ──
row('ipo_pricing','feed_field','IPO Scanner','Price range, shares and expected proceeds',
    'Deal terms for an upcoming listing.', 'proceeds = shares x midpoint of the range',
    'Finnhub /calendar/ipo', prov('/api/ipo/calendar'), 'daily',
    'Deal size against the range is the read on demand: an upsized deal priced above the range is a different signal from one cut and priced below.',
    'Finnhub free coverage is inconsistent for smaller listings, withdrawn deals linger, and there is no post-listing performance tracking.')
row('mr_zscore','derived_metric','Mover Radar','Move z-score and relative volume',
    'How unusual today move and volume are for this name.',
    'z = (today return - mean) / stdev over the trailing window; relative volume = today volume / 20-day average',
    'yfinance history', prov('/api/movers/explain'), 'on request',
    'A z-score above 2 with no evidence found is itself the finding: the move is not explained by anything public. Relative volume separates a real move from a thin-tape drift.',
    'The trailing distribution includes the current regime, so during a volatile period everything looks normal. Relative volume is distorted by index rebalance days.')
row('mr_excess','derived_metric','Mover Radar','Excess return vs the market',
    'How much of the move is the name rather than the market.',
    'stock return minus benchmark return over the same session',
    'yfinance', prov('/api/movers/explain'), 'on request',
    'Strips out the day beta. A 4% move on a 3% market day is a much smaller story than the headline number suggests.',
    'Simple difference rather than a beta-adjusted residual, so a high-beta name shows spurious excess return on a large market day.')
row('sent_asset_class','derived_metric','Sentiment Tracker','Sentiment by asset class',
    'Separate scores for Equities, Crypto, Macro and Commodities.',
    'headline scores grouped by the asset class the lexicon assigns',
    'the sentiment engine', prov('/api/sentiment/snapshot'), 'per refresh',
    'A single market sentiment number hides that crypto and macro news frequently point in opposite directions. Four classes only, because FX and fixed income proved too ambiguous to score and were dropped rather than left noisy.',
    'Assignment is lexical, so a story touching two classes lands in one. Commodities coverage is thin relative to Equities.')
row('sent_horizon','derived_metric','Sentiment Tracker','Forward and backward-looking sentiment',
    'Whether the news is describing what happened or what is expected.',
    'a deterministic horizon classifier splits each headline, then forward and backward subscores are aggregated separately',
    'the sentiment engine', prov('/api/sentiment/history'), 'per refresh',
    '"The news is bad" and "the news says things will be bad" are different claims, and only the forward series has any predictive pretension at all.',
    'The classifier is rule-based, so a headline mixing a result and a guidance change is assigned one horizon. History is aggregate rather than per ticker.')
row('positioning_extremes','derived_metric','Trader Positioning','Net positioning and percentile',
    'Net long or short by trader category, and where that sits against history.',
    'net = long contracts - short contracts per category; percentile against the trailing history of the same series',
    'CFTC COT reports', prov('/api/official/cot'), 'weekly, Friday for Tuesday',
    'The percentile is the tradable version. A record net short by managed money is a contrarian marker; the raw contract count means nothing without that context.',
    'Always at least three days stale and often more. Covers futures only, so a position hedged with options or swaps is invisible. Category definitions changed in 2009, which breaks long histories.')
row('hm_prices','feed_field','Housing Market','Home price index and mortgage rate',
    'National house prices and the prevailing 30-year mortgage rate.','-',
    'FRED', prov('/api/housing/report'), 'monthly on release',
    'The two inputs whose ratio drives affordability. Rate moves transmit to demand within a quarter; prices respond over years.',
    'Some series in this tool run on a deterministic three-year mock cycle rather than live data, which is not distinguished in the UI.')
