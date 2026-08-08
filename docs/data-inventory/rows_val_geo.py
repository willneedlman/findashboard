from build_inv import row, prov
D = 'backend/routers/dcf.py'; M = 'backend/routers/master_valuation.py'

row('dcf_fair_value','model','DCF Valuation','Intrinsic value per share',
    'Discounted free cash flow to the firm with a perpetuity terminal value.',
    'project revenue at a fading growth rate, apply an operating margin path, derive FCFF, discount each year at WACC, add TV = FCFF_final x (1+g) / (WACC - g), subtract net debt, divide by shares',
    'yfinance/SEC financials; bundled Damodaran industry snapshot backstops beta and operating margin',
    prov('/api/dcf/calculate', f'{D}:171 _project()'),
    'on request',
    'The output is a function of the assumptions, not of the company. Read the sensitivity grid before the point estimate: a 1pp change in WACC or terminal growth typically moves fair value more than any operating assumption.',
    'Terminal value is usually 60-80% of the total, so the perpetuity growth rate dominates. Requires WACC > terminal growth or the formula diverges. Beta and operating margin silently backstop from the bundled Damodaran snapshot when the vendor has no value, which is not a user-visible option.')

row('dcf_statements','feed_field','DCF Valuation','Financial statement inputs',
    'Revenue, margins, capex, working capital, shares and net debt used to seed the model.',
    '-', 'SEC EDGAR first (sec_fundamentals.py), yfinance and FMP as fallbacks',
    prov('/api/dcf/fundamentals', f'{D}:49 get_fundamentals()'),
    'cached; SEC filings on publication',
    'SEC-first by design, so the statements come from the filing rather than a vendor normalisation wherever possible.',
    'Vendor fallbacks normalise line items differently, so a company switching source can shift a margin without the business changing. TTM figures lag the most recent quarter.')

row('reverse_dcf','model','Reverse DCF','Implied expectations',
    'The growth rate the current share price already embeds.',
    'solve for the revenue growth that makes the DCF output equal the market price, holding other assumptions fixed',
    'same inputs as the DCF', prov('/api/dcf/reverse', f'{D}:611'),
    'on request',
    'Reframes the question from "what is it worth" to "what does the market already believe", which is a far more answerable question. Compare the implied rate against the company own history and the industry.',
    'Inherits every DCF assumption. Solving for one variable while holding the rest fixed attributes all disagreement to growth, when it may live in the margin or the discount rate.')

row('multiples_valuation','model','Multiples','Peer-multiple implied value',
    'Value per share implied by applying peer multiples to the company own metrics.',
    'peer median multiple x company metric (earnings, EBITDA, sales, book), converted to per-share equity value',
    'peer financials from yfinance/FMP + bundled seed',
    prov('/api/corporate/peer-valuation', f'{M} multiples blend'),
    'on request',
    'Fast and market-anchored. The spread between methods (P/E vs EV/EBITDA vs P/S) is informative: a wide spread means the capital structure or the margin profile differs from the peers.',
    'Assumes the peer group is fairly valued, which is exactly what is in question in a bubble or a washout. Meaningless on negative earnings, and the tool suppresses rather than prints those.')

row('ddm_value','model','Dividend Discount','Dividend discount value',
    'Present value of the expected dividend stream.',
    'Gordon growth or multi-stage: PV = sum(D_t/(1+r)^t) + terminal D(1+g)/(r-g)',
    'dividend history from yfinance', prov('/api/master-valuation/analyze', f'{M} DDM leg'),
    'on request',
    'Only meaningful for a mature payer with a stable policy. For those it is the most direct valuation available because the cash flow to the shareholder is observed rather than modelled.',
    'Useless for non-payers and misleading for irregular payers. Requires r > g. Buybacks, which are the dominant return-of-capital route for US large caps, are invisible to it.')

row('sotp_value','model','Sum of the Parts','Segment-based value',
    'Value built by applying a multiple to each business segment.',
    'per-segment revenue share x segment multiple, summed, less net debt, per share',
    'reported business segments auto-loaded from filings where available',
    prov('/api/master-valuation/analyze', f'{M} SOTP leg'),
    'on request',
    'The right frame for a conglomerate, where a blended multiple is meaningless. Reported segments load automatically so the starting point is the company own disclosure rather than a guess.',
    'Segment disclosure is coarse and inconsistent between companies. Revenue shares normalise to 100%, so an omitted segment silently inflates the rest. No conglomerate discount is applied.')

row('master_blend','model','Master Valuation','Blended fair value',
    'One value per share from DCF, multiples, DDM and SOTP with user-set weights.',
    'weighted mean of the enabled methods; weights renormalise over methods that produced a value (active_weights)',
    'the four models above', prov('/api/master-valuation/analyze', f'{M}:334'),
    'on request',
    'The blend forces the disagreement between methods into the open. Effective weights are shown separately from requested weights, so a method that failed to produce a value does not silently drag the blend.',
    'Averaging four models does not reduce the error if they share an input, and they do: three of the four use the same share count and net debt. A confident-looking blend can rest on one bad balance sheet.')

row('valuation_sensitivity','derived_metric','Master Valuation','Sensitivity grid',
    'Blended value across a grid of two assumptions.',
    'recompute the blend across a 2-D grid (discount rate, CAGR and margin, growth and risk, or margin and EV/EBITDA); outline the current model cell',
    'the blend above', prov('/api/master-valuation/analyze', f'{M}'),
    'on request',
    'The most honest output in the valuation hub: it shows the range the model supports rather than a single number. If the grid spans 2x, the point estimate is not a price target.',
    'Two dimensions at a time, so interactions with a third assumption are invisible. The grid bounds are chosen, not derived, so the visible range is itself an assumption.')

# ── Geo-Logistics ──
row('port_calls','feed_field','Freight Map','Port calls and trade volumes',
    'Vessel calls and estimated trade volume by port.',
    '-', 'IMF PortWatch ArcGIS feed', prov('/api/maritime/ports'),
    'PortWatch publishes with a 3-4 day lag; cached 1h',
    'The structural view of seaborne trade. The chokepoint history and comparison panels are built on the same feed.',
    'PortWatch lags 3 to 4 days, so it cannot show a disruption as it happens. That gap is the reason the live AIS nowcast exists alongside it.')

row('ais_nowcast','derived_metric','Energy Flows','Live vessel transit nowcast',
    'Near-real-time tanker transits through maritime chokepoints.',
    'AIS positions matched against chokepoint crossing geometry, accumulated into a 96-hour disk-backed transit log; disruption scored against a tanker baseline',
    'aisstream live AIS', prov('/api/maritime/vessels', 'backend/energy_nowcaster.py 96h transit log'),
    'streaming, 96h rolling window',
    'Bridges the 3-4 day PortWatch lag: this is what is moving now, not last week. Feeds the chokepoint disruption score.',
    'Requires AISSTREAM_API_KEY; without it the vessel stream is disabled and the log stays empty. AIS coverage is patchy outside coastal receiver range, and vessels can and do switch off transponders in exactly the situations that matter most.')

row('chokepoint_exposure','model','Chokepoint Exposure','Equity exposure to chokepoint stress',
    'Which listed companies benefit or suffer as a maritime chokepoint comes under stress.',
    'curated company-to-chokepoint exposure map x a live disruption score per chokepoint, producing a signed score per ticker',
    'curated map + PortWatch + AIS nowcast',
    prov('/api/maritime/exposure', 'backend/routers/maritime.py:1472 _choke_disruption()'),
    'hourly',
    'Connects a geopolitical event to a tradable list. Top beneficiary and most pressured are the two headline reads.',
    'The company-to-chokepoint mapping is curated by hand, not derived from disclosure, so it reflects a judgement about exposure rather than a measured one. A score of zero across all straits means no stress, not no exposure, and the panel says so.')

row('comtrade_flows','feed_field','Trade Flows','Bilateral trade flows',
    'Reported trade value and weight between a reporter country and its partners, by commodity and year.',
    'share = partner value / total reported value',
    'UN Comtrade', prov('/api/comtrade/flows'),
    'annual data; cached',
    'The structural picture of who trades what with whom. Useful as the denominator for any supply-chain or tariff question.',
    'Annual and reported with a long lag, often a year or more. Reporter and partner figures for the same flow routinely disagree because of valuation and transshipment; only the reporter side is shown.')

row('supply_chain_peers','derived_metric','Supply Chain Map','Supplier and customer relationships',
    'Disclosed supply-chain relationships and tag-overlap peers for a listed company.',
    'peer overlap scored by shared supply-chain tags; relationships from disclosed FAS 131 customer concentration',
    'bundled supply_chain.db built from Veridion/Dewey supplier nodes and Comtrade macro flows',
    prov('/api/corporate/supply-chain', 'backend/routers/corporate.py:1283'),
    'build-time ETL into a bounded SQLite',
    'A different peer definition from sector classification: names that share suppliers or customers rather than an industry code.',
    'Only relationships where both companies are geocoded and tickered appear, which is a small and biased subset. FAS 131 requires disclosure only of customers above 10% of revenue, so the map is sparse by construction.')

row('energy_infrastructure','bundled_dataset','Energy Flows','Pipelines, LNG terminals and facilities',
    'Global energy infrastructure geometry for the map layers.',
    '-', 'bundled Global Energy Monitor extracts (gem_pipelines.json 4.6MB, gem_lng.json, gem_facilities.json 1.1MB), NETL facilities, EMODnet',
    'backend/data/gem_pipelines.json etc, served by backend/routers/logistics.py:57 supplier_nodes() and siblings',
    'static, refreshed by rebuilding the extracts',
    'The static backdrop the live vessel and flow layers are drawn against.',
    'Snapshot data with no as-of date surfaced in the UI. A pipeline commissioned or shut since the extract was built will be wrong, and nothing in the app will say so.')
