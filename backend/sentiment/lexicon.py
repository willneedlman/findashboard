"""Deterministic finance-sentiment scorer — the math core.

`score_text` is a pure function: identical text + entities always produce an
identical `LexScore`, with no I/O, clock, or randomness. This is what makes the
whole engine reproducible; the LLM layer only annotates, never scores.

Mathematical model
------------------
A headline is tokenised and matched (longest phrase first, non-overlapping)
against a curated finance lexicon, where each entry carries a signed polarity
``p ∈ [-1, 1]`` and a salience ``s > 0`` (how market-moving the term is). For
each matched term i:

    sign_i        = -1 if a negator sits within NEGATION_WINDOW tokens before it
    intensifier_i = INTENSIFIER_FACTOR if an intensifier is adjacent, else 1
    eff_i         = clip(p_i · intensifier_i, -1, 1) · sign_i

The salience-weighted mean polarity is

    R = Σ(eff_i · s_i) / Σ(s_i)            ∈ [-1, 1]

mapped to the legacy 0–100 scale through a smooth bounded squash:

    score = round(50 + 50 · tanh(K · R))   ∈ (0, 100)

Because R is a normalised mean and tanh is monotonic and bounded, the score is
stable: agreeing terms reinforce toward the strong band without overflowing, and
opposing terms cancel. `direction = (score − 50)/50`. Confidence rises with
lexical coverage and falls with internal disagreement (stdev of the eff_i).
"""
from __future__ import annotations

import math
import re
import statistics
from dataclasses import dataclass

from sentiment import config
from sentiment.schemas import Entity

# ── Entity lookup (ported verbatim from the legacy engine) ────────────────────
_ENTITY_MAP: dict[str, tuple[str, str]] = {
    "SPY": ("SPY", "Equities"), "SPX": ("SPX", "Equities"), "QQQ": ("QQQ", "Equities"),
    "S&P": ("SPX", "Equities"), "S&P 500": ("SPX", "Equities"), "NASDAQ": ("NDX", "Equities"),
    "DOW": ("DJIA", "Equities"), "DJIA": ("DJIA", "Equities"), "RUSSELL": ("RUT", "Equities"),
    "IWM": ("IWM", "Equities"), "VIX": ("VIX", "Equities"), "AAPL": ("AAPL", "Equities"),
    "MSFT": ("MSFT", "Equities"), "NVDA": ("NVDA", "Equities"), "TSLA": ("TSLA", "Equities"),
    "AMZN": ("AMZN", "Equities"), "GOOGL": ("GOOGL", "Equities"), "META": ("META", "Equities"),
    "JPM": ("JPM", "Equities"), "GS": ("GS", "Equities"), "BAC": ("BAC", "Equities"),
    # Company names — real headlines name the company, not the ticker.
    "APPLE": ("AAPL", "Equities"), "MICROSOFT": ("MSFT", "Equities"), "NVIDIA": ("NVDA", "Equities"),
    "AMAZON": ("AMZN", "Equities"), "TESLA": ("TSLA", "Equities"), "META": ("META", "Equities"),
    "FACEBOOK": ("META", "Equities"), "GOOGLE": ("GOOGL", "Equities"), "ALPHABET": ("GOOGL", "Equities"),
    "JPMORGAN": ("JPM", "Equities"), "GOLDMAN": ("GS", "Equities"), "GOLDMAN SACHS": ("GS", "Equities"),
    "BANK OF AMERICA": ("BAC", "Equities"),
    "XLF": ("XLF", "Equities"), "XLE": ("XLE", "Equities"), "XLK": ("XLK", "Equities"),
    "TREASURY": ("UST", "Fixed Income"), "TREASURIES": ("UST", "Fixed Income"),
    "10-YEAR": ("UST10Y", "Fixed Income"), "10Y": ("UST10Y", "Fixed Income"),
    "2-YEAR": ("UST2Y", "Fixed Income"), "2Y": ("UST2Y", "Fixed Income"),
    "30-YEAR": ("UST30Y", "Fixed Income"), "YIELD": ("UST", "Fixed Income"),
    "YIELDS": ("UST", "Fixed Income"), "BONDS": ("UST", "Fixed Income"),
    "TLT": ("TLT", "Fixed Income"), "AGG": ("AGG", "Fixed Income"),
    "DXY": ("DXY", "FX"), "DOLLAR": ("DXY", "FX"), "USD": ("USD", "FX"),
    "EUR": ("EUR/USD", "FX"), "EURO": ("EUR/USD", "FX"),
    "YEN": ("USD/JPY", "FX"), "JPY": ("USD/JPY", "FX"),
    "GBP": ("GBP/USD", "FX"), "POUND": ("GBP/USD", "FX"),
    "CNY": ("USD/CNY", "FX"), "YUAN": ("USD/CNY", "FX"),
    "OIL": ("WTI", "Commodities"), "WTI": ("WTI", "Commodities"),
    "CRUDE": ("WTI", "Commodities"), "BRENT": ("Brent", "Commodities"),
    "GOLD": ("XAU", "Commodities"), "XAU": ("XAU", "Commodities"),
    "SILVER": ("XAG", "Commodities"), "COPPER": ("Copper", "Commodities"),
    "WHEAT": ("Wheat", "Commodities"), "CORN": ("Corn", "Commodities"),
    "GLD": ("XAU", "Commodities"), "USO": ("WTI", "Commodities"),
    "BTC": ("BTC", "Crypto"), "BITCOIN": ("BTC", "Crypto"),
    "ETH": ("ETH", "Crypto"), "ETHEREUM": ("ETH", "Crypto"),
    "CRYPTO": ("Crypto", "Crypto"), "COINBASE": ("COIN", "Crypto"),
    "FED": ("Fed", "Macro"), "FEDERAL RESERVE": ("Fed", "Macro"),
    "FOMC": ("FOMC", "Macro"), "POWELL": ("Fed", "Macro"),
    "ECB": ("ECB", "Macro"), "BOJ": ("BOJ", "Macro"),
    "CPI": ("CPI", "Macro"), "PCE": ("PCE", "Macro"),
    "GDP": ("GDP", "Macro"), "NFP": ("NFP", "Macro"),
    "INFLATION": ("CPI", "Macro"), "UNEMPLOYMENT": ("NFP", "Macro"),
    "TARIFF": ("Trade", "Macro"), "TARIFFS": ("Trade", "Macro"),
    "DEBT": ("UST", "Fixed Income"), "DEFICIT": ("UST", "Fixed Income"),
}

_CROSS_IMPACT_RULES: list[tuple[re.Pattern[str], list[tuple[str, str]]]] = [
    (re.compile(r'\b(FED|FOMC|POWELL|RATE\s+HIKE|RATE\s+CUT|INTEREST\s+RATE|MONETARY\s+POLICY|CENTRAL\s+BANK|ECB|BOJ|BOE)\b'),
     [("SPX", "Equities"), ("UST10Y", "Fixed Income")]),
    (re.compile(r'\b(INFLATION|CPI|PCE|DEFLATION|STAGFLATION|PRICE\s+(PRESSURE|SURGE|SPIKE|RISE|FALL)|COST.OF.LIVING)\b'),
     [("SPX", "Equities"), ("UST", "Fixed Income"), ("XAU", "Commodities")]),
    (re.compile(r'\b(RECESSION|ECONOMIC\s+(SLOWDOWN|CONTRACTION|DOWNTURN|CRISIS)|GDP\s+(MISS|FALL|SHRINK|CONTRACT)|GROWTH\s+SCARE)\b'),
     [("SPX", "Equities"), ("UST10Y", "Fixed Income"), ("XAU", "Commodities")]),
    (re.compile(r'\b(JOBS?\s*(REPORT|DATA|MARKET|NUMBER)?|EMPLOYMENT|UNEMPLOYMENT|NONFARM\s+PAYROLLS?|NFP|PAYROLLS?|LABOR\s+MARKET|JOBLESS\s+CLAIMS?|HIRING|LAYOFFS?)\b', re.IGNORECASE),
     [("SPX", "Equities"), ("NFP", "Macro"), ("UST", "Fixed Income")]),
    (re.compile(r'\b(OIL\s+(PRICE|SURGE|DROP|FALL|RISE|SPIKE)|CRUDE\s+(OIL|PRICE)|ENERGY\s+(PRICE|COST|CRISIS)|OPEC)\b'),
     [("XLE", "Equities"), ("SPX", "Equities"), ("CPI", "Macro")]),
    (re.compile(r'\bTARIFFS?\b|\bTRADE\s+(WAR|DISPUTE|TENSION|DEAL|POLICY)\b|\bIMPORT\s+(TAX|DUTY)\b|\bSANCTIONS?\b'),
     [("SPX", "Equities"), ("Trade", "Macro"), ("DXY", "FX")]),
    (re.compile(r'\b(DOLLAR\s+\w*(STRENGTH|WEAKEN|RISE|FALL|SURGE|PLUNGE)\w*|STRONG\s+DOLLAR|WEAK\s+DOLLAR|DXY\s+(UP|DOWN|RISE|FALL))\b', re.IGNORECASE),
     [("SPX", "Equities"), ("WTI", "Commodities"), ("XAU", "Commodities")]),
    (re.compile(r'\b(CREDIT\s+(CRISIS|CRUNCH|SPREAD|RISK)|BANK\s+(FAILURE|CRISIS|RUN|COLLAPSE)|SYSTEMIC\s+RISK|LIQUIDITY\s+CRUNCH|DEFAULT\s+RISK)\b'),
     [("XLF", "Equities"), ("SPX", "Equities"), ("UST", "Fixed Income")]),
    (re.compile(r'\b(GOLD\s+(SURGE|RALLY|RISE|HIT|RECORD)|SAFE.HAVEN|RISK.OFF|FLIGHT\s+TO\s+(SAFETY|QUALITY))\b'),
     [("XAU", "Commodities"), ("SPX", "Equities"), ("UST10Y", "Fixed Income")]),
    (re.compile(r'\b(TREASURY\s+YIELD|BOND\s+YIELD|10.YEAR\s+YIELD|YIELD\s+(SURGE|SPIKE|RISE|INVERSION|CURVE))\b'),
     [("UST10Y", "Fixed Income"), ("SPX", "Equities")]),
    (re.compile(r'\b(WAR|CONFLICT|GEOPOLIT|MILITARY\s+(STRIKE|ACTION|TENSION)|NUCLEAR\s+THREAT|UKRAINE|MIDDLE\s+EAST\s+WAR)\b'),
     [("SPX", "Equities"), ("XAU", "Commodities"), ("WTI", "Commodities"), ("UST10Y", "Fixed Income")]),
    (re.compile(r'\b(CHINA\s+(ECONOMY|SLOWDOWN|CRISIS|GROWTH|TRADE|MARKET)|YUAN\s+(DEVALUE|WEAKEN|CRASH)|EM\s+CRISIS)\b'),
     [("SPX", "Equities"), ("Trade", "Macro"), ("USD/CNY", "FX")]),
    (re.compile(r'\bSEMICONDUCTORS?\b|\bCHIP\s+(SHORTAGE|BAN|EXPORT|WAR)\b|\bAI\s+(BUBBLE|CRASH|REGULATION|BAN)\b|\bBIG\s+TECH\s+(SELL|ROUT|ANTITRUST|REGULATION)\b'),
     [("QQQ", "Equities"), ("XLK", "Equities"), ("NVDA", "Equities")]),
    # Only market-wide earnings phrasing maps to the index. A single company's
    # "earnings beat/miss" stays scoped to that company so it doesn't inherit
    # broad-market weight.
    (re.compile(r'\b(EARNINGS\s+SEASON|CORPORATE\s+(PROFIT|EARNINGS|RESULTS|REVENUE)|S&P\s*\d*\s*EARNINGS|MARKET\s+EARNINGS|EARNINGS\s+RECESSION)\b'),
     [("SPX", "Equities")]),
]

_SPX_ENTITY_IMPACT: dict[str, float] = {
    "SPX": 1.0, "SPY": 1.0, "QQQ": 1.0, "NDX": 1.0,
    "DJIA": 1.0, "IWM": 0.9, "RUT": 0.9,
    "Fed": 1.0, "FOMC": 1.0, "CPI": 1.0, "PCE": 1.0, "GDP": 1.0,
    "NFP": 1.0, "Trade": 0.9, "UST": 0.85, "UST10Y": 0.9, "UST2Y": 0.8,
    "XLF": 0.7, "XLE": 0.7, "XLK": 0.7,
    "AAPL": 0.90, "MSFT": 0.85, "NVDA": 0.82, "AMZN": 0.60,
    "META": 0.50, "GOOGL": 0.45, "TSLA": 0.38, "JPM": 0.28,
    "GS": 0.20, "BAC": 0.18,
    "WTI": 0.65, "Brent": 0.60, "XAU": 0.45,
    "BTC": 0.25, "ETH": 0.18,
    "DXY": 0.55, "USD": 0.45, "EUR/USD": 0.35, "USD/JPY": 0.35,
}

_PRIVATE_CO_RE = re.compile(
    r'\b(spacex|starlink|stripe|openai|anthropic|databricks|shein|'
    r'bytedance|tiktok\s+parent|instacart\s+private|revolut|klarna\s+private)\b',
    re.IGNORECASE,
)

_BROAD_MARKET_KW = re.compile(
    r'\b(market|stocks|equities|wall\s+street|s&p|dow\s+jones|nasdaq|'
    r'fed\b|fomc|rate\s+(cut|hike)|inflation|recession|gdp|'
    r'treasury|yield|tariff|economy|economic|unemployment|payroll|'
    r'jobless|retail\s+sales|consumer\s+(confidence|spending|sentiment)|'
    r'\bpmi\b|\bism\b|housing|manufacturing|sector|index|indices)\b',
    re.IGNORECASE,
)

_TIER5_KW = re.compile(
    r'\b(rate\s+(hike|cut)|interest\s+rate|monetary\s+policy|central\s+bank|'
    r'systemic\s+risk|liquidity\s+crunch|credit\s+crunch|credit\s+crisis|'
    r'bank\s+(run|failure|collapse)|contagion|sovereign\s+default)\b', re.IGNORECASE,
)
_TIER4_KW = re.compile(
    r'\b(recession|inflation|deflation|stagflation|tariff|trade\s+war|gdp|'
    r'payrolls?|jobless|unemployment|selloff|sell-off|bear\s+market|'
    r'market\s+(crash|rout|meltdown)|sanctions?|debt\s+ceiling)\b', re.IGNORECASE,
)
_MEGACAP = frozenset({"AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"})

# Individual companies in the entity map. An article whose only entities are these
# — with no index, macro, rates, commodity, or FX context — is single-stock scoped
# and gets capped below any macro/index story.
_SINGLE_STOCK_ENTITIES = frozenset({
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "JPM", "GS", "BAC", "COIN",
})

# Top ~100 US companies by market cap + major banks/insurers. Each entry is
# (canonical_ticker, pre-cap S&P impact, alias keys matched in headlines). Keys
# are unambiguous company names / safe tickers — short or word-like tickers
# (T, F, C, V, MA, GM, GE, SO, MO, PM, ALL, ICE, LOW, CAT, BA, DE, KEY, RF, 3M…)
# are matched ONLY by name so everyday words don't false-match. All are
# single-stock scoped, so each is capped below any macro/index story.
_US_LARGECAPS: tuple[tuple[str, float, tuple[str, ...]], ...] = (
    ("BRK.B", 0.42, ("BERKSHIRE", "BERKSHIRE HATHAWAY", "BRK.B")),
    ("LLY",   0.42, ("ELI LILLY", "LILLY", "LLY")),
    ("AVGO",  0.42, ("BROADCOM", "AVGO")),
    ("V",     0.40, ("VISA",)),
    ("WMT",   0.40, ("WALMART", "WMT")),
    ("MA",    0.38, ("MASTERCARD",)),
    ("XOM",   0.40, ("EXXON", "EXXON MOBIL", "EXXONMOBIL", "XOM")),
    ("UNH",   0.40, ("UNITEDHEALTH", "UNITED HEALTH", "UNH")),
    ("ORCL",  0.40, ("ORACLE", "ORCL")),
    ("HD",    0.36, ("HOME DEPOT",)),
    ("PG",    0.38, ("PROCTER & GAMBLE", "PROCTER AND GAMBLE")),
    ("COST",  0.40, ("COSTCO", "COST")),
    ("JNJ",   0.40, ("JOHNSON & JOHNSON", "JOHNSON AND JOHNSON", "JNJ")),
    ("ABBV",  0.34, ("ABBVIE", "ABBV")),
    ("NFLX",  0.38, ("NETFLIX", "NFLX")),
    ("KO",    0.36, ("COCA-COLA", "COCA COLA", "COKE")),
    ("CRM",   0.36, ("SALESFORCE", "CRM")),
    ("CVX",   0.38, ("CHEVRON", "CVX")),
    ("MRK",   0.36, ("MERCK", "MRK")),
    ("AMD",   0.40, ("ADVANCED MICRO", "AMD")),
    ("PEP",   0.36, ("PEPSI", "PEPSICO", "PEP")),
    ("TMO",   0.30, ("THERMO FISHER", "TMO")),
    ("LIN",   0.30, ("LINDE",)),
    ("ADBE",  0.36, ("ADOBE", "ADBE")),
    ("WFC",   0.34, ("WELLS FARGO", "WFC")),
    ("ACN",   0.32, ("ACCENTURE", "ACN")),
    ("MCD",   0.34, ("MCDONALD", "MCDONALDS", "MCD")),
    ("CSCO",  0.34, ("CISCO", "CSCO")),
    ("ABT",   0.32, ("ABBOTT", "ABT")),
    ("GE",    0.32, ("GENERAL ELECTRIC", "GE AEROSPACE")),
    ("DHR",   0.28, ("DANAHER", "DHR")),
    ("IBM",   0.32, ("IBM",)),
    ("NOW",   0.32, ("SERVICENOW",)),
    ("TXN",   0.32, ("TEXAS INSTRUMENTS", "TXN")),
    ("DIS",   0.34, ("DISNEY", "DIS")),
    ("INTC",  0.34, ("INTEL", "INTC")),
    ("INTU",  0.30, ("INTUIT", "INTU")),
    ("CAT",   0.30, ("CATERPILLAR",)),
    ("QCOM",  0.32, ("QUALCOMM", "QCOM")),
    ("VZ",    0.30, ("VERIZON", "VZ")),
    ("AMGN",  0.30, ("AMGEN", "AMGN")),
    ("PFE",   0.32, ("PFIZER", "PFE")),
    ("CMCSA", 0.32, ("COMCAST", "CMCSA")),
    ("SPGI",  0.30, ("SPGI",)),
    ("RTX",   0.30, ("RAYTHEON", "RTX")),
    ("ISRG",  0.28, ("INTUITIVE SURGICAL", "ISRG")),
    ("UBER",  0.32, ("UBER",)),
    ("NEE",   0.26, ("NEXTERA", "NEXTERA ENERGY", "NEE")),
    ("HON",   0.30, ("HONEYWELL", "HON")),
    ("LOW",   0.30, ("LOWE'S", "LOWES")),
    ("PM",    0.28, ("PHILIP MORRIS",)),
    ("T",     0.30, ("AT&T",)),
    ("BA",    0.32, ("BOEING",)),
    ("UNP",   0.28, ("UNION PACIFIC", "UNP")),
    ("AMAT",  0.30, ("APPLIED MATERIALS", "AMAT")),
    ("GILD",  0.26, ("GILEAD", "GILD")),
    ("BKNG",  0.30, ("BOOKING HOLDINGS", "BOOKING", "BKNG")),
    ("SYK",   0.26, ("STRYKER", "SYK")),
    ("TJX",   0.26, ("TJX", "TJ MAXX")),
    ("VRTX",  0.26, ("VERTEX PHARMACEUTICALS", "VRTX")),
    ("MU",    0.30, ("MICRON", "MU")),
    ("ADP",   0.26, ("AUTOMATIC DATA", "ADP")),
    ("MDT",   0.26, ("MEDTRONIC", "MDT")),
    ("LRCX",  0.28, ("LAM RESEARCH", "LRCX")),
    ("PANW",  0.28, ("PALO ALTO NETWORKS", "PANW")),
    ("REGN",  0.26, ("REGENERON", "REGN")),
    ("KLAC",  0.26, ("KLA CORP", "KLAC")),
    ("SBUX",  0.30, ("STARBUCKS", "SBUX")),
    ("NKE",   0.30, ("NIKE", "NKE")),
    ("PLTR",  0.30, ("PALANTIR", "PLTR")),
    ("MMM",   0.28, ("MMM",)),
    ("CB",    0.24, ("CHUBB",)),
    ("CVS",   0.28, ("CVS HEALTH", "CVS")),
    ("ELV",   0.26, ("ELEVANCE", "ELEVANCE HEALTH")),
    ("CI",    0.24, ("CIGNA",)),
    ("HUM",   0.22, ("HUMANA",)),
    ("MO",    0.24, ("ALTRIA",)),
    ("SO",    0.22, ("SOUTHERN COMPANY",)),
    ("DUK",   0.22, ("DUKE ENERGY",)),
    ("ZTS",   0.24, ("ZOETIS", "ZTS")),
    ("BMY",   0.26, ("BRISTOL MYERS", "BRISTOL-MYERS", "BMY")),
    ("SHW",   0.24, ("SHERWIN-WILLIAMS", "SHERWIN WILLIAMS", "SHW")),
    ("ICE",   0.24, ("INTERCONTINENTAL EXCHANGE",)),
    ("CME",   0.24, ("CME GROUP",)),
    ("DE",    0.28, ("DEERE", "JOHN DEERE")),
    ("GD",    0.24, ("GENERAL DYNAMICS",)),
    ("LMT",   0.28, ("LOCKHEED", "LOCKHEED MARTIN", "LMT")),
    ("NOC",   0.24, ("NORTHROP", "NORTHROP GRUMMAN", "NOC")),
    ("MMC",   0.24, ("MARSH MCLENNAN", "MARSH & MCLENNAN", "MMC")),
    ("BX",    0.28, ("BLACKSTONE",)),
    ("BLK",   0.30, ("BLACKROCK", "BLK")),
    ("F",     0.26, ("FORD",)),
    ("GM",    0.26, ("GENERAL MOTORS",)),
    ("TGT",   0.26, ("TGT", "TARGET CORP")),
    ("PYPL",  0.26, ("PAYPAL", "PYPL")),
)

_US_BANKS: tuple[tuple[str, float, tuple[str, ...]], ...] = (
    ("C",    0.30, ("CITIGROUP", "CITIBANK", "CITI")),
    ("MS",   0.30, ("MORGAN STANLEY",)),
    ("USB",  0.24, ("U.S. BANCORP", "US BANCORP", "USB")),
    ("PNC",  0.24, ("PNC FINANCIAL", "PNC BANK", "PNC")),
    ("TFC",  0.22, ("TRUIST", "TFC")),
    ("COF",  0.24, ("CAPITAL ONE", "COF")),
    ("SCHW", 0.26, ("CHARLES SCHWAB", "SCHWAB", "SCHW")),
    ("BK",   0.22, ("BNY MELLON", "BANK OF NEW YORK", "BNY")),
    ("STT",  0.20, ("STATE STREET", "STT")),
    ("NTRS", 0.18, ("NORTHERN TRUST", "NTRS")),
    ("AXP",  0.28, ("AMERICAN EXPRESS", "AMEX", "AXP")),
    ("FITB", 0.16, ("FIFTH THIRD", "FITB")),
    ("MTB",  0.16, ("M&T BANK", "MTB")),
    ("HBAN", 0.16, ("HUNTINGTON BANCSHARES", "HBAN")),
    ("RF",   0.16, ("REGIONS FINANCIAL",)),
    ("CFG",  0.16, ("CITIZENS FINANCIAL", "CFG")),
    ("KEY",  0.16, ("KEYCORP",)),
    ("CMA",  0.16, ("COMERICA",)),
    ("ZION", 0.14, ("ZIONS BANCORP", "ZIONS", "ZION")),
    ("DFS",  0.20, ("DISCOVER FINANCIAL", "DFS")),
    ("SYF",  0.18, ("SYNCHRONY", "SYF")),
    ("ALLY", 0.18, ("ALLY FINANCIAL",)),
    ("AIG",  0.22, ("AMERICAN INTERNATIONAL", "AIG")),
    ("MET",  0.22, ("METLIFE",)),
    ("PRU",  0.20, ("PRUDENTIAL FINANCIAL",)),
    ("TRV",  0.22, ("TRAVELERS COMPANIES", "TRV")),
    ("PGR",  0.24, ("PROGRESSIVE CORP", "PGR")),
    ("ALL",  0.20, ("ALLSTATE",)),
)

for _tkr, _imp, _aliases in _US_LARGECAPS + _US_BANKS:
    for _alias in _aliases:
        _ENTITY_MAP.setdefault(_alias.upper(), (_tkr, "Equities"))
    _SPX_ENTITY_IMPACT.setdefault(_tkr, _imp)
_SINGLE_STOCK_ENTITIES = _SINGLE_STOCK_ENTITIES | {c[0] for c in _US_LARGECAPS + _US_BANKS}

# ── Finance lexicon: term -> (polarity ∈ [-1,1], salience > 0) ─────────────────
# Multi-word phrases are matched first; ambiguous movement verbs are scoped to a
# subject ("stocks plunge") so a lone "plunge" never guesses direction.
_LEXICON: dict[str, tuple[float, float]] = {
    # Monetary policy
    "rate cut": (0.85, 1.5), "rate cuts": (0.85, 1.5), "rate pause": (0.50, 1.2),
    "dovish": (0.70, 1.3), "stimulus": (0.70, 1.3), "quantitative easing": (0.70, 1.3),
    "monetary easing": (0.65, 1.2), "soft landing": (0.70, 1.3), "goldilocks": (0.65, 1.1),
    "policy pivot": (0.55, 1.2), "rate hike": (-0.85, 1.5), "rate hikes": (-0.85, 1.5),
    "hawkish": (-0.70, 1.3), "tightening": (-0.55, 1.2), "quantitative tightening": (-0.60, 1.2),
    "cuts rates": (0.85, 1.5), "cut rates": (0.85, 1.5), "cutting rates": (0.80, 1.4),
    "cuts interest rates": (0.85, 1.5), "hikes rates": (-0.85, 1.5), "hike rates": (-0.85, 1.5),
    "raises rates": (-0.80, 1.4), "raise rates": (-0.80, 1.4), "raising rates": (-0.80, 1.4),
    "hiking rates": (-0.80, 1.4), "raises interest rates": (-0.80, 1.4),
    # Inflation / growth
    "cooling inflation": (0.60, 1.3), "easing inflation": (0.60, 1.3), "disinflation": (0.55, 1.2),
    "inflation cools": (0.60, 1.3), "inflation eases": (0.60, 1.3), "inflation falls": (0.55, 1.3),
    "inflation slows": (0.50, 1.2), "inflation rises": (-0.60, 1.3), "inflation jumps": (-0.65, 1.3),
    "inflation accelerates": (-0.70, 1.3),
    "inflation surge": (-0.80, 1.4), "hot inflation": (-0.70, 1.3), "sticky inflation": (-0.60, 1.3),
    "inflation": (-0.50, 1.3), "deflation": (-0.40, 1.1), "stagflation": (-0.85, 1.4),
    "recession": (-0.85, 1.5), "soft landing hopes": (0.65, 1.3), "economic growth": (0.50, 1.2),
    "gdp growth": (0.50, 1.2), "expansion": (0.40, 1.1), "slowdown": (-0.50, 1.2),
    "contraction": (-0.60, 1.2), "downturn": (-0.60, 1.2), "growth scare": (-0.60, 1.2),
    # Trade / geopolitics
    "trade war": (-0.70, 1.3), "trade deal": (0.55, 1.2), "tariff": (-0.55, 1.2),
    "tariffs": (-0.55, 1.2), "sanctions": (-0.45, 1.0), "war": (-0.60, 1.2),
    # Sanctions EASING is de-escalation, not risk. Longest-first matching lets
    # these phrases claim the tokens before the bare bearish "sanctions" term.
    "sanctions waiver": (0.25, 1.0), "sanctions waivers": (0.25, 1.0),
    "sanctions relief": (0.30, 1.0), "sanctions lifted": (0.35, 1.0),
    "sanctions eased": (0.30, 1.0), "sanctions exemption": (0.25, 0.9),
    "sanctions exemptions": (0.25, 0.9),
    "lift sanctions": (0.30, 1.0), "lifts sanctions": (0.30, 1.0),
    "lifting sanctions": (0.30, 1.0), "ease sanctions": (0.30, 1.0),
    "eases sanctions": (0.30, 1.0), "easing sanctions": (0.30, 1.0),
    "waive sanctions": (0.25, 1.0), "waives sanctions": (0.25, 1.0),
    "conflict": (-0.45, 1.0), "geopolitical": (-0.40, 1.0), "supply shock": (-0.60, 1.2),
    "tensions": (-0.35, 0.9), "tension": (-0.35, 0.9), "tensions ease": (0.40, 1.0),
    "tensions fade": (0.40, 1.0), "fears fade": (0.40, 1.0), "fears ease": (0.40, 1.0),
    "concerns ease": (0.35, 0.9),
    "shortage": (-0.40, 1.0), "safe haven": (-0.30, 0.9), "safe havens": (-0.30, 0.9),
    "safe haven bid": (-0.40, 1.0), "boosts safe havens": (-0.45, 1.0),
    "flight to safety": (-0.50, 1.1),
    # Credit / systemic
    "default": (-0.70, 1.3), "debt ceiling": (-0.40, 1.1), "credit downgrade": (-0.55, 1.2),
    "downgrade": (-0.45, 1.0), "credit crunch": (-0.75, 1.3), "liquidity crunch": (-0.75, 1.3),
    "bank failure": (-0.80, 1.4), "bank run": (-0.80, 1.4), "systemic risk": (-0.80, 1.4),
    "contagion": (-0.70, 1.3),
    # Earnings / corporate
    "earnings beat": (0.70, 1.0), "beats earnings": (0.70, 1.0), "earnings beats": (0.70, 1.0),
    "beats estimates": (0.65, 0.9), "tops estimates": (0.65, 0.9), "tops expectations": (0.60, 0.9),
    "raises guidance": (0.60, 0.9), "raised guidance": (0.60, 0.9), "record profit": (0.60, 0.9),
    "crushes earnings": (0.80, 1.1), "crushes estimates": (0.75, 1.0), "blowout earnings": (0.80, 1.1),
    "smashes estimates": (0.75, 1.0),
    "strong earnings": (0.60, 1.0), "earnings miss": (-0.70, 1.0), "misses earnings": (-0.70, 1.0),
    "earnings misses": (-0.70, 1.0), "misses estimates": (-0.65, 0.9), "cuts guidance": (-0.65, 0.9),
    "lowers guidance": (-0.65, 0.9), "profit warning": (-0.70, 1.0), "layoffs": (-0.50, 1.0),
    "job cuts": (-0.50, 1.0), "mass layoffs": (-0.60, 1.1), "bankruptcy": (-0.70, 1.1),
    # Labor
    "jobs growth": (0.55, 1.2), "strong jobs": (0.60, 1.2), "robust hiring": (0.60, 1.1),
    "hiring": (0.40, 1.0), "labor market strength": (0.55, 1.2), "weak jobs": (-0.50, 1.2),
    "rising unemployment": (-0.55, 1.2),
    # Market tape — subject-scoped movement
    "stocks rally": (0.60, 1.1), "stocks surge": (0.65, 1.1), "stocks soar": (0.70, 1.1),
    "stocks jump": (0.50, 1.0), "stocks climb": (0.40, 1.0), "stocks gain": (0.40, 1.0),
    "stocks rise": (0.40, 1.0), "stocks fall": (-0.40, 1.0), "stocks drop": (-0.45, 1.0),
    "stocks slip": (-0.35, 1.0), "stocks sink": (-0.50, 1.0), "stocks tumble": (-0.55, 1.1),
    "stocks plunge": (-0.65, 1.1), "stocks slide": (-0.40, 1.0), "markets rally": (0.60, 1.1),
    "markets rise": (0.40, 1.0), "markets fall": (-0.40, 1.0), "markets drop": (-0.45, 1.0),
    "s&p 500 drops": (-0.55, 1.2), "s&p drops": (-0.55, 1.2), "s&p 500 falls": (-0.55, 1.2),
    "s&p 500 rises": (0.55, 1.2), "s&p 500 climbs": (0.55, 1.2),
    # Market tape — standalone events
    "rally": (0.55, 1.1), "rebound": (0.55, 1.0), "recovery": (0.45, 0.9),
    "record high": (0.60, 1.1), "all-time high": (0.60, 1.1), "all time high": (0.60, 1.1),
    "risk-on": (0.60, 1.1), "risk on": (0.60, 1.1), "winning streak": (0.50, 0.9),
    "selloff": (-0.65, 1.2), "sell-off": (-0.65, 1.2), "sell off": (-0.65, 1.2),
    "rout": (-0.70, 1.2), "market crash": (-0.85, 1.4), "crash": (-0.75, 1.3),
    "bear market": (-0.75, 1.3), "correction": (-0.50, 1.1), "meltdown": (-0.80, 1.3),
    "bloodbath": (-0.80, 1.2), "risk-off": (-0.60, 1.1), "risk off": (-0.60, 1.1),
    "turmoil": (-0.60, 1.1), "panic": (-0.70, 1.2), "volatility": (-0.35, 0.9),
    # Yields / FX — movement of yields/oil/etc. is handled by the inversion-aware
    # movement layer (see _MOVEMENT); only non-movement structural terms stay here.
    "yield curve inversion": (-0.60, 1.2), "inverted yield curve": (-0.60, 1.2),
    "strong dollar": (-0.30, 0.9), "weak dollar": (0.25, 0.8),
    # Sentiment adjectives
    "optimism": (0.45, 1.0), "upbeat": (0.45, 0.9), "confidence": (0.35, 0.9),
    "cautious": (-0.20, 0.8), "uncertainty": (-0.30, 0.9), "concerns": (-0.30, 0.9),
    "fears": (-0.40, 1.0), "jitters": (-0.35, 0.9), "steady": (0.15, 0.7),
    "holds steady": (0.20, 0.9), "in line": (0.10, 0.7), "in-line": (0.10, 0.7),
    "mixed": (0.0, 0.6),
    "beat": (0.45, 1.0), "beats": (0.45, 1.0), "outperform": (0.40, 1.0),
    "outperforms": (0.40, 1.0), "outperforming": (0.40, 1.0), "betting on": (0.30, 0.8),
}

_NEGATORS: frozenset[str] = frozenset({
    "no", "not", "non", "never", "without", "nor", "avoids", "avoid", "avoided",
    "averts", "avert", "eases", "ease", "eased", "easing", "fades", "fade",
    "faded", "denies", "deny", "denied", "dodges", "dodge", "ruled", "rules",
    # contractions (apostrophes are stripped in _tokenize, so e.g. won't -> wont)
    "wont", "cant", "cannot", "doesnt", "dont", "didnt", "isnt", "arent",
    "wasnt", "werent", "hasnt", "havent", "wouldnt", "shouldnt", "couldnt", "aint",
})
_INTENSIFIERS: frozenset[str] = frozenset({
    "sharply", "sharp", "steeply", "steep", "massively", "massive",
    "dramatically", "dramatic", "deeply", "heavily", "significantly",
})
# Dismissive framing: a headline that calls a bearish concern "overblown" is
# reassuring, not bearish. When any reverser appears, negative contributions are
# flipped to a damped positive (e.g. "inflation fears are overblown").
_REVERSERS: frozenset[str] = frozenset({
    "overblown", "overdone", "unfounded", "exaggerated", "overstated",
    "overrated", "misplaced", "debunked", "dispelled", "myth", "mistaken",
})
_REVERSAL_FACTOR: float = 0.5

# Directional movement verbs: + = the subject's level rises, - = falls. The
# polarity is written for the DEFAULT subject (equities / risk assets). For a
# "bad-up" subject (yields, inflation, the VIX, unemployment, energy, gold) a
# rising level is bearish, so the sign is flipped when such a subject sits just
# before the verb. One mechanism, every inversion ("oil falls"/"yields jump"/
# "unemployment rises" all resolve correctly) instead of hundreds of phrases.
_MOVEMENT: dict[str, float] = {
    "soars": 0.65, "soar": 0.65, "soaring": 0.65, "surge": 0.55, "surges": 0.55, "surging": 0.55,
    "jumps": 0.45, "jump": 0.45, "jumping": 0.45, "rallies": 0.60, "rebounds": 0.55, "rebounding": 0.55,
    "climbs": 0.35, "climb": 0.35, "climbing": 0.35, "gains": 0.30, "rises": 0.30, "rise": 0.30,
    "rising": 0.30, "advances": 0.35, "advance": 0.35, "higher": 0.35, "lifts": 0.40, "buoys": 0.45, "boosts": 0.45,
    "boost": 0.40, "recovers": 0.40, "rebound": 0.50,
    "plummets": -0.70, "plummet": -0.70, "tanks": -0.65, "plunges": -0.65, "plunge": -0.65,
    "plunging": -0.65, "tumbles": -0.60, "tumble": -0.60, "tumbling": -0.60, "slumps": -0.60,
    "slump": -0.55, "sinks": -0.50, "sink": -0.50, "dives": -0.60, "slides": -0.45, "slide": -0.45,
    "sliding": -0.45, "slips": -0.30, "slip": -0.30, "falls": -0.35, "fall": -0.35, "falling": -0.35,
    "drops": -0.35, "drop": -0.35, "declines": -0.40, "decline": -0.40, "retreats": -0.40,
    "lower": -0.35, "weighs": -0.35, "drags": -0.40, "sags": -0.45, "sag": -0.45,
}
_MOVEMENT_SALIENCE = 0.7
# Subjects for which a rising level is bad for equities (flip the movement sign).
_BAD_UP_TOKENS: frozenset[str] = frozenset({
    "yield", "yields", "inflation", "cpi", "ppi", "price", "prices", "cost", "costs",
    "unemployment", "jobless", "claims", "layoff", "layoffs", "vix", "volatility",
    "oil", "crude", "brent", "gas", "gasoline", "gold", "rate", "rates",
    "deficit", "debt", "default", "defaults", "premium", "spread", "spreads",
})
# Subjects whose direction is ambiguous for equities: a falling dollar is not
# bearish for stocks (often the opposite). Movement verbs scoped to these
# subjects are skipped entirely rather than guessed.
_FX_SUBJECT_TOKENS: frozenset[str] = frozenset({
    "dollar", "dxy", "greenback", "usd", "euro", "yen", "yuan", "pound",
    "sterling", "currency", "currencies", "forex", "fx",
})

# ── Rate-expectations repricing ("jobs data lowers Fed hike bets") ────────────
# The market-moving content of these headlines is the DIRECTION of policy
# expectations, not the words around it: fewer expected hikes / more expected
# cuts is dovish and bullish for equities, and vice versa. An object token
# (bets/odds/hopes/...) qualified by hike/cut within 2 tokens is repriced by the
# nearest direction verb before the qualifier or after the object.
_CLAUSE_BREAKS: frozenset[str] = frozenset({
    "as", "after", "on", "amid", "while", "despite", "because", "before", "following",
})

_RATE_OBJ: frozenset[str] = frozenset({
    "bets", "bet", "odds", "wagers", "expectations", "hopes", "chances", "pricing",
    "concerns", "concern", "fears", "fear", "worries", "worry", "jitters", "anxiety",
})
_HIKE_TOKENS: frozenset[str] = frozenset({"hike", "hikes", "hiking", "tightening"})
_CUT_TOKENS: frozenset[str] = frozenset({"cut", "cuts", "cutting", "easing"})
_REPRICE_VERBS: dict[str, float] = {
    **_MOVEMENT,
    "lowers": -0.40, "raises": 0.40, "pares": -0.40, "pare": -0.40, "trims": -0.35,
    "fuels": 0.45, "fuel": 0.45, "dashes": -0.55, "dash": -0.55, "dims": -0.40,
    "cools": -0.35, "revives": 0.40, "cements": 0.35, "firms": 0.30,
    "douses": -0.50, "tempers": -0.35, "curbs": -0.40, "scales": -0.35,
    "ease": -0.45, "eases": -0.45, "easing": -0.45, "eased": -0.45,
    "fade": -0.45, "fades": -0.45, "faded": -0.45, "recede": -0.45, "recedes": -0.45,
    "abate": -0.40, "abates": -0.40, "wane": -0.40, "wanes": -0.40, "lift": 0.40,
}
_REPRICE_SALIENCE = 1.3

_MAX_PHRASE_LEN = max(len(k.split()) for k in _LEXICON)
_TOKEN_RE = re.compile(r"[a-z0-9&]+")
_APOSTROPHES = str.maketrans("", "", "'’ʼ`")


def _tokenize(text: str) -> list[str]:
    # Strip apostrophes first so contractions survive as one token (won't -> wont).
    return _TOKEN_RE.findall(text.lower().translate(_APOSTROPHES))


@dataclass(frozen=True)
class TermHit:
    term: str
    polarity: float       # effective signed polarity after negation/intensifier
    salience: float
    contribution: float   # polarity · salience


@dataclass(frozen=True)
class LexScore:
    score: int
    direction: float
    confidence: float
    macro_tier: int
    sentiment: str
    raw_polarity: float
    matched: tuple[TermHit, ...]


def extract_entities(text: str) -> list[Entity]:
    """Map a headline to canonical financial entities (direct + cross-impact)."""
    upper = text.upper()
    found: dict[str, str] = {}
    for token, (name, asset_class) in _ENTITY_MAP.items():
        if re.search(r'\b' + re.escape(token) + r'\b', upper):
            found[name] = asset_class
    for pattern, implied in _CROSS_IMPACT_RULES:
        if pattern.search(upper):
            for name, asset_class in implied:
                found.setdefault(name, asset_class)
    return [{"name": k, "asset_class": v} for k, v in found.items()]


def is_relevant(title: str, entities: list[Entity]) -> bool:
    """True when the article touches the broad market: it names a recognized
    financial entity (direct or cross-impact) or a broad-market keyword. Articles
    with neither are off-topic noise and are dropped before scoring."""
    return bool(entities) or bool(_BROAD_MARKET_KW.search(title))


def is_single_stock_scoped(title: str, entities: list[Entity]) -> bool:
    """True when the article is about individual companies only — at least one
    single-stock entity, no index/macro/rates/commodity/FX entity, and no
    broad-market keyword."""
    if not entities:
        return False
    names = {e["name"] for e in entities}
    if not (names & _SINGLE_STOCK_ENTITIES):
        return False
    if names - _SINGLE_STOCK_ENTITIES:          # any broader entity present
        return False
    return not _BROAD_MARKET_KW.search(title)


def market_impact_weight(title: str, entities: list[Entity]) -> float:
    """0..1 relevance of this article to broad S&P 500 direction. Single-stock
    stories are capped so an individual name never out-weights a macro/index
    story of the same tier."""
    if _PRIVATE_CO_RE.search(title):
        return 0.05
    if not entities:
        return 0.65 if _BROAD_MARKET_KW.search(title) else 0.15
    impact = max((_SPX_ENTITY_IMPACT.get(e["name"], 0.15) for e in entities), default=0.15)
    if is_single_stock_scoped(title, entities):
        impact = min(impact, config.SINGLE_STOCK_IMPACT_CAP)
    return impact


def derive_tier(title: str, entities: list[Entity]) -> int:
    """Deterministic macro tier 1..5 (replaces the LLM's tier judgement)."""
    if _PRIVATE_CO_RE.search(title):
        return 1
    names = {e["name"] for e in entities}
    if names & {"Fed", "FOMC"} or _TIER5_KW.search(title):
        return 5
    macro = {"CPI", "PCE", "GDP", "NFP", "Trade", "UST", "UST10Y", "UST2Y"}
    if names & macro or _TIER4_KW.search(title) or _BROAD_MARKET_KW.search(title):
        return 4
    if names & _MEGACAP:
        return 3
    if names or re.search(r'\bearnings\b', title, re.IGNORECASE):
        return 2
    return 1


def _match_terms(tokens: list[str], consumed: list[bool]) -> tuple[list[TermHit], list[bool]]:
    """Longest-first, non-overlapping lexicon match with negation + intensifier.

    Skips tokens already claimed by the repricing layer (which resolves
    expectation direction better than the bare phrases) and returns the hits
    plus the consumed-token mask so the movement layer never double-counts.
    """
    n = len(tokens)
    hits: list[TermHit] = []
    for span in range(min(_MAX_PHRASE_LEN, n), 0, -1):
        for i in range(0, n - span + 1):
            if any(consumed[i:i + span]):
                continue
            phrase = " ".join(tokens[i:i + span])
            entry = _LEXICON.get(phrase)
            if entry is None:
                continue
            polarity, salience = entry
            for k in range(i, i + span):
                consumed[k] = True
            sign = -1.0 if any(
                tokens[j] in _NEGATORS and not consumed[j]
                for j in range(max(0, i - config.NEGATION_WINDOW), i)
            ) else 1.0
            intensified = any(
                tokens[j] in _INTENSIFIERS
                for j in range(max(0, i - 2), i)
            ) or any(
                tokens[j] in _INTENSIFIERS
                for j in range(i + span, min(n, i + span + 2))
            )
            factor = config.INTENSIFIER_FACTOR if intensified else 1.0
            eff = max(-1.0, min(1.0, polarity * factor)) * sign
            hits.append(TermHit(phrase, eff, salience, eff * salience))
    return hits, consumed


def _rate_repricing_hits(tokens: list[str], consumed: list[bool]) -> list[TermHit]:
    """Score policy-expectation repricing: 'lowers Fed hike bets' is dovish
    (bullish), 'boosts rate cut odds' is dovish, 'dashes rate cut hopes' is
    hawkish (bearish). Consumes the tokens it uses so the movement layer never
    double-counts the same verb with the wrong subject."""
    n = len(tokens)
    hits: list[TermHit] = []
    for i, tok in enumerate(tokens):
        if consumed[i] or tok not in _RATE_OBJ:
            continue
        kind = 0
        kind_idx = -1
        for j in range(max(0, i - 2), i):
            if tokens[j] in _HIKE_TOKENS:
                kind, kind_idx = -1, j
            elif tokens[j] in _CUT_TOKENS:
                kind, kind_idx = 1, j
        if kind == 0:
            continue
        # Nearest direction verb: up to 4 tokens before the hike/cut qualifier,
        # or up to 4 after the object ("hike concerns begin to ease"). Never
        # cross a clause connective — "Stocks slide as hike fears mount" must
        # not read "slide" as the fears' verb.
        verb_idx, verb_val = -1, 0.0
        for j in range(kind_idx - 1, max(0, kind_idx - 5) - 1, -1):
            if tokens[j] in _CLAUSE_BREAKS:
                break
            if not consumed[j] and tokens[j] in _REPRICE_VERBS:
                verb_idx, verb_val = j, _REPRICE_VERBS[tokens[j]]
                break
        if verb_idx < 0:
            for j in range(i + 1, min(n, i + 5)):
                if tokens[j] in _CLAUSE_BREAKS:
                    break
                if not consumed[j] and tokens[j] in _REPRICE_VERBS:
                    verb_idx, verb_val = j, _REPRICE_VERBS[tokens[j]]
                    break
        # No verb: the bare phrase still carries the expectation's own direction
        # ("rate cut hopes" is dovish on its own). A confirmed verb is a direct
        # policy-expectations statement, so it scores well above the bare phrase.
        if verb_idx >= 0:
            eff = kind * (1.0 if verb_val > 0 else -1.0) * (0.35 + abs(verb_val))
        else:
            eff = kind * 0.35
        eff = max(-1.0, min(1.0, eff))
        consumed[i] = consumed[kind_idx] = True
        if verb_idx >= 0:
            consumed[verb_idx] = True
        label = " ".join(tokens[kind_idx:i + 1])
        hits.append(TermHit(f"reprice:{label}", eff, _REPRICE_SALIENCE, eff * _REPRICE_SALIENCE))
    return hits


def _movement_hits(tokens: list[str], consumed: list[bool]) -> list[TermHit]:
    """Score directional verbs on tokens no lexicon phrase claimed, flipping the
    sign when a bad-up subject (yields, oil, inflation, ...) precedes the verb.
    FX subjects (the dollar, crosses) are skipped: their direction is ambiguous
    for equities."""
    n = len(tokens)
    hits: list[TermHit] = []
    for i, tok in enumerate(tokens):
        if consumed[i]:
            continue
        base = _MOVEMENT.get(tok)
        if base is None:
            continue
        bad_up = any(tokens[j] in _BAD_UP_TOKENS for j in range(max(0, i - 3), i))
        # Wider window than bad-up: FX headlines pad the subject with qualifiers
        # ("Dollar set for biggest weekly drop").
        fx_subject = any(tokens[j] in _FX_SUBJECT_TOKENS for j in range(max(0, i - 6), i))
        if fx_subject and not bad_up:
            continue
        negated = any(tokens[j] in _NEGATORS for j in range(max(0, i - config.NEGATION_WINDOW), i))
        intensified = any(tokens[j] in _INTENSIFIERS for j in range(max(0, i - 2), i)) or any(
            tokens[j] in _INTENSIFIERS for j in range(i + 1, min(n, i + 3)))
        factor = config.INTENSIFIER_FACTOR if intensified else 1.0
        eff = max(-1.0, min(1.0, base * factor)) * (-1.0 if negated else 1.0) * (-1.0 if bad_up else 1.0)
        hits.append(TermHit(tok, eff, _MOVEMENT_SALIENCE, eff * _MOVEMENT_SALIENCE))
    return hits


def score_text(text: str, entities: list[Entity]) -> LexScore:
    """Pure deterministic sentiment score for one headline. See module docstring."""
    tokens = _tokenize(text)
    # Repricing gets first claim: "rate-hike concerns ease" must resolve as
    # dovish before the bare "rate hike" / "concerns" phrases score bearish.
    consumed = [False] * len(tokens)
    reprice_hits = _rate_repricing_hits(tokens, consumed)
    lex_hits, consumed = _match_terms(tokens, consumed)
    hits = lex_hits + reprice_hits + _movement_hits(tokens, consumed)
    tier = derive_tier(text, entities)

    # Dismissive framing ("fears are overblown") flips bearish contributions to a
    # damped positive so the headline does not read as bearish.
    if hits and any(t in _REVERSERS for t in tokens):
        hits = [
            h if h.contribution >= 0 else
            TermHit(h.term, -h.polarity * _REVERSAL_FACTOR, h.salience, -h.contribution * _REVERSAL_FACTOR)
            for h in hits
        ]

    if not hits:
        return LexScore(50, 0.0, config.MIN_CONFIDENCE, tier, "neutral", 0.0, ())

    den = sum(h.salience for h in hits)
    raw = sum(h.contribution for h in hits) / den if den else 0.0
    score = max(0, min(100, round(50 + 50 * math.tanh(config.TANH_GAIN * raw))))
    direction = round((score - 50) / 50.0, 3)

    coverage = min(1.0, len(hits) / config.CONF_COVERAGE_ETA)
    disagreement = statistics.pstdev([h.polarity for h in hits]) if len(hits) > 1 else 0.0
    confidence = round(max(config.MIN_CONFIDENCE, min(1.0,
        config.CONF_BASE
        + config.CONF_COVERAGE_COEF * coverage
        - config.CONF_DISAGREEMENT_COEF * disagreement)), 2)

    sentiment = "bullish" if direction > 0.1 else "bearish" if direction < -0.1 else "neutral"
    return LexScore(score, direction, confidence, tier, sentiment, round(raw, 4), tuple(hits))
