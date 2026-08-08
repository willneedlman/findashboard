from build_inv import row, prov
O = prov('/api/options/exposure'); PR = prov('/api/options/price')

def gk(id, name, defn, formula, interp, lim, tool='Dealer GEX', p=None):
    row(id, 'derived_metric', tool, name, defn, formula,
        'Tradier or yfinance chain, greeks computed in-house from Black-Scholes',
        p or O, 'intraday on request', interp, lim)

gk('gex_delta','Dealer delta exposure by strike','Directional exposure dealers carry, per strike.',
   'sign x open_interest x 100 x delta x spot, aggregated per strike',
   'Where dealers are long or short the underlying. Large negative delta above spot means hedging pressure builds as price rises into it.',
   'Rests on the same sign convention as gamma: dealers assumed short calls and long puts. Frequently wrong for a single name with heavy retail call buying.')
gk('gex_vanna','Dealer vanna exposure','Sensitivity of dealer delta to a change in implied volatility.',
   'sign x open_interest x 100 x vanna x spot, per strike and expiry',
   'The channel through which a volatility move forces spot hedging even when price has not moved. Matters most into a vol crush after an event.',
   'Second-order greek computed from a chain IV that is itself derived from a mid price, so error compounds. Unreliable on illiquid strikes.')
gk('gex_charm','Dealer charm exposure','Decay of dealer delta as time passes.',
   'sign x open_interest x 100 x charm x spot, per strike and expiry',
   'Explains mechanical hedging flows into an expiry with no news, and is largest in the final days of a large open interest.',
   'Same second-order estimation problem as vanna, and it grows without bound as time to expiry approaches zero, so the final session is unstable.')
gk('gex_expiry_grid','Exposure by expiry','Gamma laid out across expiries as well as strikes.',
   'the same per-contract aggregation pivoted by expiration date',
   'Shows how much of the exposure rolls off at the next expiry, which is the difference between a level that matters this week and one that matters all quarter.',
   'Limited to 24 expiries. LEAPS carry small gamma but large delta, so a gamma-only read understates far-dated positioning.')
gk('gex_total_net','Total net gamma','Whole-chain dealer gamma in $mm per 1% move.',
   'sum of net_gex across all strikes and expiries',
   'The regime headline. Sign matters more than magnitude: positive damps volatility, negative amplifies it.',
   'Not comparable across tickers, because it scales with spot squared and with open interest. A large number on a mega cap and a small one on a small cap can mean the same thing in relative terms.')

def pg(id, name, defn, formula, interp, lim):
    row(id, 'model', 'Options Pricer', name, defn, formula,
        'in-house Black-Scholes over user or chain-sourced inputs', PR, 'on request, pure function', interp, lim)

pg('op_theo_price','Theoretical price','Black-Scholes value of a contract.',
   'closed-form BS on spot, strike, time to expiry, rate, volatility and type',
   'The reference against the market mid. A persistent gap is usually the IV input, not a mispricing.',
   'European exercise with no dividends. US single-name equity options are American, so the model is wrong for deep in-the-money puts and around ex-dividend dates.')
pg('op_delta','Delta','Change in option value per unit change in the underlying.','first derivative of BS price with respect to spot',
   'The hedge ratio, and loosely the risk-neutral probability of finishing in the money. Aggregating it across legs gives the structure directional exposure.',
   'Loses meaning as a probability under a skewed surface, which is exactly when people reach for it.')
pg('op_gamma','Gamma','Rate of change of delta.','second derivative of BS price with respect to spot',
   'How fast the hedge goes wrong. Largest at the money and near expiry, which is why short-dated ATM positions are the dangerous ones.',
   'Assumes constant volatility, so it understates the true convexity when vol moves with spot.')
pg('op_theta','Theta','Value lost per day from time decay.','derivative of BS price with respect to time, per calendar day',
   'The carry cost of being long options and the income of being short. Accelerates into expiry rather than running linearly.',
   'Quoted per calendar day while decay actually concentrates around trading sessions, so a weekend overstates the daily figure.')
pg('op_vega','Vega','Value change per point of implied volatility.','derivative of BS price with respect to volatility',
   'The volatility exposure. Two structures with identical delta can have opposite vega, which decides how they behave through an event.',
   'Assumes a parallel shift in the surface. Real vol moves are not parallel, so a vega number across expiries overstates hedge accuracy.')
pg('op_rho','Rho','Value change per point of interest rate.','derivative of BS price with respect to the risk-free rate',
   'Negligible for short-dated equity options and material for LEAPS, which is the only time it is worth reading.',
   'Uses a single flat rate rather than a term structure.')

row('vol_skew_curve','derived_metric','Volatility Scanner','Volatility skew',
    'Implied volatility across strikes at one expiry.',
    'per-strike IV from the chain, normalised through one shared _normalize_iv rule; 25-delta risk reversal and butterfly reported alongside',
    'Tradier or yfinance chain', prov('/api/prob/skew'), 'intraday on request',
    'A steep put skew means downside protection is bid, which is normal for an index and a signal in a single name. The 25-delta risk reversal is the compact numeric version of the same read.',
    'IV is normalised by one shared rule because the two sources quote it differently; before that fix the same contract could read 25% in one pane and 0% in another. No historical surface, so today skew cannot be compared with its own history.')
row('vol_term_structure','derived_metric','Volatility Scanner','Term structure',
    'ATM implied volatility across expiries.',
    'ATM IV per expiry across up to 16 expiries, with the front-to-back slope',
    'Tradier or yfinance chain', prov('/api/prob/skew'), 'intraday on request',
    'Backwardation, where the front is above the back, marks an event or a stress. Contango is the resting state. The slope figure is what the scanner sorts on.',
    'Chain-derived and point-in-time. Expiries are unevenly spaced, so the slope between adjacent expiries is not a constant-maturity measure.')
row('vol_iv_hv','derived_metric','Volatility Scanner','IV against realised volatility',
    'Implied volatility compared with recent realised volatility.',
    'ATM IV minus annualised 30-day realised volatility (the IV premium)',
    'chain + price history', prov('/api/prob/skew'), 'intraday',
    'The variance risk premium in one number. Persistently positive is the structural norm; a negative reading means options are cheap relative to how the stock is actually moving.',
    'Compares a forward-looking implied number against a backward-looking realised one over different windows, which is standard practice but not an apples-to-apples comparison.')

# ── Macro Monitor split ──
EC = prov('/api/rates/economy')
def ec(id, name, defn, formula, interp, lim):
    row(id, 'feed_field', 'Macro Monitor', name, defn, formula, 'FRED', EC,
        'monthly on release, disk-cached 15m', interp, lim)

ec('mm_unemployment','Unemployment rate','Headline U-3 unemployment, with a 24-month trend.','-',
   'The Fed half-mandate in one number, and the input to the Sahm gap in the cycle panel. The level matters less than the direction: unemployment rises non-linearly once it turns.',
   'U-3 excludes discouraged workers and the underemployed. Household-survey based, so it is noisier month to month than payrolls.')
ec('mm_payrolls','Nonfarm payrolls','Monthly change in employment.','current level minus prior month level, in thousands',
   'Roughly 100k a month keeps pace with labour-force growth, which is the line the cycle panel scores against. The single most market-moving monthly release.',
   'Revised twice and the revisions are frequently larger than the surprise that moved markets on the day. Establishment survey, so it counts jobs rather than people.')
ec('mm_cpi','CPI year over year','Headline consumer inflation.','current index / index 12 months prior - 1',
   'Plotted against the 2% target alongside core and PCE so the three can be read together rather than in isolation.',
   'Headline includes food and energy and is therefore the noisiest of the three. The Fed does not target it.')
ec('mm_core_cpi','Core CPI year over year','Consumer inflation excluding food and energy.','same, on the core index',
   'The persistence read. Core moving while headline falls means the disinflation is energy, not demand.',
   'Shelter is roughly a third of the basket and is measured with a long lag, so core turns later than the underlying reality.')
ec('mm_pce','PCE year over year','The Fed preferred inflation gauge.','same, on the PCE price index',
   'Structurally runs below CPI because of different weights and substitution assumptions. This is the series the 2% target actually refers to.',
   'Released later than CPI and revised more. The core variant, not shown separately here, is the one the Fed cites.')

# ── Bond Analytics split ──
BA = prov('/api/bond/analytics')
def bd(id, name, defn, formula, interp, lim):
    row(id, 'model', 'Bond Analytics', name, defn, formula, 'in-house bond math', BA, 'on request, pure function', interp, lim)

bd('bond_ytm','Yield to maturity','The discount rate that equates price to the present value of cash flows.',
   'solve for y in price = sum(coupon/(1+y/f)^t) + face/(1+y/f)^n, by bisection',
   'The single comparable number across bonds of different coupon and maturity. Assumes every coupon is reinvested at y, which is the assumption people forget.',
   'No embedded optionality: a callable priced here is wrong, and yield-to-worst is not computed. Ignores accrued interest conventions that differ by market.')
bd('bond_duration','Macaulay and modified duration','Weighted average time to cash flows, and price sensitivity to yield.',
   'Macaulay = sum(t x PV(CF_t)) / price; modified = Macaulay / (1 + y/f)',
   'Modified duration is the first-order price move per 100bp. It is the number to hedge on for small moves and the number that misleads for large ones.',
   'Linear approximation only; error grows with the square of the yield move, which is what convexity corrects. Assumes a parallel shift of the curve.')
bd('bond_convexity','Convexity','Curvature of the price-yield relationship.',
   'second derivative of price with respect to yield, scaled by price',
   'Decides between two bonds of equal duration: positive convexity gains more on a rally than it loses on a selloff. Matters for large moves and for barbell versus bullet structures.',
   'Also assumes parallel shifts and no optionality. Negative for callables and MBS, which this model cannot represent at all.')
bd('bond_price','Clean price and cash flows','Present value of the bond and its projected coupon schedule.',
   'discount each coupon and the principal at the yield or curve supplied',
   'The schedule beneath the number is the useful part: it shows exactly where the duration is coming from.',
   'Clean price, so accrued interest is excluded and the invoice price will differ. Fixed coupons only; floaters are not modelled.')
