"""Pure-play peer P/S reference for the SOTP tab.

A sum-of-the-parts is only as good as the comp you hang on each segment, and a
17-bucket sector list cannot tell Azure from Office from the consulting arm — all
three used to land on "Software / Cloud" or, worse, on "Internet / Media" because
the segment name happened to contain the word "services".

This module holds a curated snapshot of US median EV-free price/sales by narrow
peer group, plus the classifier that maps a filer's segment label onto one. The
multiples are anchors for a judgement call, not quotes: they are the level a
pure-play in that niche has typically traded at, rounded to the precision the
input deserves. Refresh annually alongside data/damodaran.json.
"""
from __future__ import annotations
import re

# family -> ordered [(group, price/sales, one-line basis shown in the UI)]
PEER_FAMILIES: dict[str, list[tuple[str, float, str]]] = {
    "Software & Cloud": [
        ("Hyperscale Cloud / IaaS",        12.0, "Azure/AWS-class infrastructure, consumption-priced"),
        ("Data & Analytics Platforms",     12.0, "Warehouse and lakehouse platforms, usage-based"),
        ("Cybersecurity",                  11.0, "Security platforms, high net retention"),
        ("Developer Tools / DevOps",        9.0, "Seat plus consumption, bottom-up adoption"),
        ("Enterprise SaaS / Productivity",  8.0, "Seat-based suites, near-flat churn"),
        ("ERP / Business Applications",     7.5, "Systems of record, long replacement cycles"),
        ("Vertical SaaS",                   7.0, "Industry-specific workflow software"),
        ("Client OS / PC Software",         4.0, "OEM licensing tied to device volumes"),
        ("Legacy / On-Prem Software",       4.0, "Maintenance-heavy, low growth"),
    ],
    "Internet & Media": [
        ("Social Platforms",                7.0, "Owned audience, first-party ad inventory"),
        ("Search Advertising",              6.5, "Intent-driven, highest-yield ad format"),
        ("Professional Network / Hiring",   6.0, "Recruiting and B2B audience monetisation"),
        ("Online Marketplaces",             5.0, "Take-rate on third-party GMV"),
        ("Travel / Booking Platforms",      5.5, "Asset-light commission model"),
        ("Information Services / Ratings",  7.0, "Subscription data and index franchises"),
        ("Streaming / Subscription Media",  3.5, "Content-cost heavy, subscriber-driven"),
        ("Digital Advertising / AdTech",    3.5, "Intermediary take-rate, cyclical"),
        ("Ride-hail / Delivery",            2.0, "Gross-bookings model, thin contribution"),
        ("E-commerce (1P retail)",          1.5, "Owned inventory, retail-like margins"),
    ],
    "Semiconductors & Hardware": [
        ("AI Accelerators / DC Silicon",   22.0, "Scarce compute, supply-constrained pricing"),
        ("Fabless Semiconductors",          9.0, "Design-led, outsourced manufacturing"),
        ("Semicap Equipment",               8.5, "Tool oligopoly, capex-cycle exposed"),
        ("Analog / Embedded Semis",         7.0, "Long product lives, broad SKU base"),
        ("Foundry / IDM",                   5.5, "Owned fabs, heavy fixed cost"),
        ("Memory",                          3.5, "Commodity cycle, price-taker"),
        ("Networking Equipment",            3.5, "Refresh-cycle hardware plus attach software"),
        ("Consumer Electronics (premium)",  2.5, "Brand pricing power, ecosystem pull"),
        ("Gaming Hardware / Consoles",      1.5, "Razor-and-blade, hardware near cost"),
        ("Enterprise Servers / Storage",    1.3, "Commoditised, competitive bidding"),
        ("PCs / Consumer Devices",          1.0, "Volume OEM, thin margins"),
    ],
    "Gaming & Entertainment": [
        ("Music / Rights Catalogues",       4.5, "Annuity royalties on owned catalogue"),
        ("Video Game Publishing",           4.0, "Owned IP, release-slate driven"),
        ("Interactive / Live-Service",      3.5, "Recurring in-game spend"),
        ("Film & TV Studios",               2.0, "Hit-driven, heavy content amortisation"),
    ],
    "Payments & Financials": [
        ("Card Networks",                  15.0, "Toll on payment volume, near-zero credit risk"),
        ("Exchanges / Market Infra",        9.0, "Volume-linked, regulated moat"),
        ("Digital Wallets",                 4.5, "Consumer balances plus merchant take-rate"),
        ("Merchant Acquiring / PayFac",     4.0, "Spread on processed volume"),
        ("Asset & Wealth Management",       4.0, "Fee on AUM, market-beta revenue"),
        ("Banks (money centre)",            2.5, "Net interest income plus fee businesses"),
        ("Consumer Lending / Cards",        2.2, "Credit-cycle exposed spread lending"),
        ("Regional Banks",                  2.2, "Deposit-funded, rate-sensitive"),
        ("P&C Insurance",                   1.5, "Underwriting plus float"),
        ("Life Insurance",                  0.9, "Spread and mortality risk, capital heavy"),
    ],
    "Healthcare": [
        ("Biotech (commercial stage)",      6.0, "Patent-protected, high gross margin"),
        ("Life-Science Tools",              5.0, "Instruments plus consumable annuity"),
        ("Big Pharma",                      4.5, "Diversified portfolio, patent-cliff exposed"),
        ("Medical Devices",                 4.5, "Procedure-linked, regulated"),
        ("Managed Care",                    0.7, "Premium pass-through, thin underwriting margin"),
        ("Healthcare Distribution",         0.3, "Pass-through logistics economics"),
    ],
    "Industrials & Energy": [
        ("Rail",                            5.0, "Franchise networks, pricing power"),
        ("Electrical Equipment",            3.0, "Grid and electrification demand"),
        ("Utilities",                       2.5, "Rate-base regulated returns"),
        ("Oil & Gas E&P",                   2.5, "Reserve-driven, commodity price taker"),
        ("Aerospace & Defense",             2.2, "Long-cycle programme backlogs"),
        ("Machinery",                       2.0, "Capex-cycle exposed"),
        ("Renewables / Clean Energy",       2.0, "Project pipeline, policy-linked"),
        ("Mining / Metals",                 1.8, "Commodity price taker, high fixed cost"),
        ("Chemicals",                       1.4, "Feedstock spread, cyclical"),
        ("Trucking / Logistics",            1.3, "Freight-cycle exposed"),
        ("Oilfield Services",               1.3, "Activity-linked, capex-derivative"),
        ("Parcel / Delivery",               1.2, "Network density economics"),
        ("Integrated Oil",                  1.0, "Upstream and downstream blend"),
        ("Airlines",                        0.8, "Capital intensive, fuel and labour exposed"),
        ("Refining",                        0.4, "Crack-spread margins on huge revenue"),
    ],
    "Consumer": [
        ("Luxury Goods",                    4.0, "Brand scarcity, pricing power"),
        ("Beverages",                       4.0, "Brand annuity, distribution moat"),
        ("Tobacco",                         4.0, "Declining volume, extreme margins"),
        ("Household Products",              3.5, "Staples with brand pricing"),
        ("Restaurants",                     3.0, "Franchised royalty models"),
        ("Athletic / Branded Apparel",      2.2, "Brand-led, wholesale plus DTC"),
        ("Packaged Food",                   1.6, "Low growth, private-label pressure"),
        ("Specialty Retail",                1.2, "Store-footprint dependent"),
        ("Auto Parts / Suppliers",          0.9, "OEM-dependent, contract pricing"),
        ("Mass Retail / Grocery",           0.6, "Volume model, low single-digit margin"),
    ],
    "Autos & Mobility": [
        ("EV / Emerging Auto",              4.0, "Growth-rated, scaling manufacturing"),
        ("Automotive OEM",                  0.6, "Capital heavy, cyclical volumes"),
    ],
    "Real Estate & Telecom": [
        ("Towers / Infrastructure REIT",    9.0, "Long leases with escalators"),
        ("REITs (equity)",                  7.0, "Rent-backed, rate sensitive"),
        ("Telecom Carriers",                1.3, "Capex heavy, subscriber annuity"),
        ("Homebuilders",                    1.3, "Cyclical, rate driven"),
        ("Cable / Broadband",               1.2, "Infrastructure annuity, competitive pressure"),
    ],
    "Business Services": [
        ("Payroll / HR Services",           5.0, "Recurring plus float income"),
        ("Education",                       2.5, "Enrolment-driven subscriptions"),
        ("IT Services / Consulting",        1.7, "People-based delivery, utilisation capped"),
        ("Staffing",                        0.5, "Pass-through wage economics"),
    ],
}

PEER_PS: dict[str, float] = {g: ps for fam in PEER_FAMILIES.values() for g, ps, _ in fam}
PEER_NOTE: dict[str, str] = {g: n for fam in PEER_FAMILIES.values() for g, _, n in fam}
PEER_FAMILY: dict[str, str] = {g: f for f, rows in PEER_FAMILIES.items() for g, _, _ in rows}

# Ordered patterns, most specific first — the first hit wins. Matched against the
# segment label lowercased. Generic words that used to swallow everything ("service",
# "product", "other") appear only inside longer phrases.
_RULES: list[tuple[str, str]] = [
    # Named franchises, so the big filers classify exactly rather than by luck.
    (r"\bazure\b|\bserver products\b|\baws\b|amazon web services|google cloud|\boci\b", "Hyperscale Cloud / IaaS"),
    (r"microsoft 365|\boffice\b|productivity and business|google workspace", "Enterprise SaaS / Productivity"),
    (r"\bdynamics\b|\berp\b|business applications|netsuite|\bs/4hana\b", "ERP / Business Applications"),
    (r"\bwindows\b|client operating|personal computing", "Client OS / PC Software"),
    (r"linkedin|professional network|recruit|talent solutions|\bhiring\b", "Professional Network / Hiring"),
    (r"search (and news )?advertis|\bsearch\b.*\bads?\b|bing", "Search Advertising"),
    (r"youtube|instagram|\bfamily of apps\b|social", "Social Platforms"),
    (r"google services", "Search Advertising"),
    # Xbox and PlayStation are majority content and subscription revenue; console
    # hardware sells near cost and only gets the hardware comp when named as such.
    (r"console hardware|gaming hardware", "Gaming Hardware / Consoles"),
    (r"\bxbox\b|playstation|live service|in-game|mobile gaming|interactive entertainment",
     "Interactive / Live-Service"),
    (r"game|gaming|\bstudios? gaming\b", "Video Game Publishing"),
    (r"\biphone\b|smartphone|wearable|accessor|\bairpods?\b|\bwatch\b|home and accessor",
     "Consumer Electronics (premium)"),
    (r"\bipad\b|\bmac\b|\bpcs?\b|personal comput|notebook", "PCs / Consumer Devices"),
    (r"data cent(er|re) (silicon|gpu|compute)|\bgpu\b|accelerat|\bai (chips?|silicon)\b", "AI Accelerators / DC Silicon"),
    (r"\bcompute (and|&) network|\bdata cent(er|re)\b", "AI Accelerators / DC Silicon"),
    # Sector-level fallbacks.
    (r"cyber|security software|endpoint|threat", "Cybersecurity"),
    (r"developer|devops|\bapi platform\b|observabilit", "Developer Tools / DevOps"),
    (r"analytics|data platform|data warehouse|business intelligence", "Data & Analytics Platforms"),
    (r"\bsaas\b|\bcloud\b|subscription software", "Enterprise SaaS / Productivity"),
    (r"licen[cs]e|on-?prem|legacy software|maintenance revenue", "Legacy / On-Prem Software"),
    (r"\bsoftware\b", "Enterprise SaaS / Productivity"),
    (r"advertis|\bad(s| revenue| sales)\b|marketing services", "Digital Advertising / AdTech"),
    (r"stream|subscription (video|media)|\bcontent\b", "Streaming / Subscription Media"),
    (r"marketplace|third-?party seller|\bgmv\b", "Online Marketplaces"),
    (r"booking|travel|lodging", "Travel / Booking Platforms"),
    (r"ride|delivery platform|mobility services", "Ride-hail / Delivery"),
    (r"e-?commerce|online (store|retail)|\bdirect to consumer\b", "E-commerce (1P retail)"),
    (r"rating|index|market data|information services", "Information Services / Ratings"),
    (r"semiconduct|\bchip\b|silicon|foundry|wafer", "Fabless Semiconductors"),
    (r"memory|\bdram\b|\bnand\b", "Memory"),
    (r"network(ing)? (equipment|hardware)|\brouter|switching|\bnetworking\b", "Networking Equipment"),
    (r"server|storage systems|infrastructure hardware", "Enterprise Servers / Storage"),
    (r"card network|interchange", "Card Networks"),
    (r"acquiring|merchant services|payment process|\bpayfac\b", "Merchant Acquiring / PayFac"),
    (r"wallet|peer-to-peer payment|\bvenmo\b|\bcash app\b", "Digital Wallets"),
    (r"payment|\bfintech\b", "Merchant Acquiring / PayFac"),
    (r"exchange|clearing|market infrastructure", "Exchanges / Market Infra"),
    (r"asset management|wealth management|\baum\b", "Asset & Wealth Management"),
    (r"consumer lending|credit card|\bcards?\b.*lending", "Consumer Lending / Cards"),
    (r"regional bank|community bank", "Regional Banks"),
    (r"\bbank|deposit|net interest", "Banks (money centre)"),
    (r"property (and|&) casualt|\bp&c\b|reinsuranc", "P&C Insurance"),
    (r"life insuranc|annuit", "Life Insurance"),
    (r"insuranc", "P&C Insurance"),
    (r"managed care|health plan|\bhmo\b", "Managed Care"),
    (r"biotech|therapeut|\boncolog", "Biotech (commercial stage)"),
    (r"life scienc|laborator|diagnostic", "Life-Science Tools"),
    (r"medical device|surgical|implant", "Medical Devices"),
    (r"pharma|\bdrug\b|medicine", "Big Pharma"),
    (r"distribution.*health|health.*distribut", "Healthcare Distribution"),
    (r"aerospace|defen[cs]e|space systems", "Aerospace & Defense"),
    (r"\brail\b|railroad|freight rail", "Rail"),
    (r"airline|passenger air", "Airlines"),
    (r"parcel|package delivery|\bcourier\b", "Parcel / Delivery"),
    (r"truck|freight|logistics|supply chain services", "Trucking / Logistics"),
    (r"oilfield|drilling services|well services", "Oilfield Services"),
    (r"refin(e|ing)|downstream", "Refining"),
    (r"exploration|upstream|\be&p\b", "Oil & Gas E&P"),
    (r"renewable|solar|wind power|clean energy", "Renewables / Clean Energy"),
    (r"utilit|regulated electric|\bgrid\b", "Utilities"),
    (r"\boil\b|\bgas\b|petroleum|energy", "Integrated Oil"),
    (r"mining|\bmetals?\b|\bcopper\b|\bgold\b", "Mining / Metals"),
    (r"chemical|petrochemical|specialty materials", "Chemicals"),
    (r"electrical equipment|power systems|automation", "Electrical Equipment"),
    (r"machiner|industrial equipment|construction equipment", "Machinery"),
    (r"luxury|couture|\bjewel", "Luxury Goods"),
    (r"beverage|\bdrinks?\b|bottling", "Beverages"),
    (r"tobacco|cigarette|\bvap", "Tobacco"),
    (r"household products|home care|personal care", "Household Products"),
    (r"restaurant|quick service|\bqsr\b", "Restaurants"),
    (r"apparel|footwear|athletic|sportswear", "Athletic / Branded Apparel"),
    (r"packaged food|\bsnack|\bfood\b|grocery products", "Packaged Food"),
    (r"grocery|supercenter|mass retail|club stores", "Mass Retail / Grocery"),
    (r"specialty retail|\bstores?\b|retail segment", "Specialty Retail"),
    (r"electric vehicle|\bev\b(?! charging)|battery electric", "EV / Emerging Auto"),
    (r"auto parts|components|aftermarket", "Auto Parts / Suppliers"),
    (r"automotive|\bvehicles?\b", "Automotive OEM"),
    (r"tower|\bcell sites?\b", "Towers / Infrastructure REIT"),
    (r"\breit\b|real estate|rental propert", "REITs (equity)"),
    (r"homebuild|residential construction", "Homebuilders"),
    (r"broadband|\bcable\b|\bisp\b", "Cable / Broadband"),
    (r"telecom|wireless|mobile network|connectivity services", "Telecom Carriers"),
    (r"payroll|\bhr\b|human capital", "Payroll / HR Services"),
    (r"education|learning|courseware", "Education"),
    (r"staffing|temporary labo(u)?r", "Staffing"),
    # Deliberately last: "…and partner services", "consulting", "professional
    # services" are integration and support businesses, not the product they
    # support, and must not inherit a software multiple.
    (r"consult|professional services|partner services|support services|\bimplementation\b",
     "IT Services / Consulting"),
]
_COMPILED = [(re.compile(p), g) for p, g in _RULES]

# The same segment label means different businesses at different filers: "Gaming"
# is GeForce silicon at Nvidia and a release slate at EA; "Compute" is an
# accelerator line at Nvidia and nothing in particular elsewhere. When the issuer's
# own industry is known, these overlays are consulted before the generic rules.
_CONTEXT_RULES: dict[str, list[tuple[str, str]]] = {
    "semis": [
        (r"gaming|geforce|graphics", "Fabless Semiconductors"),
        (r"compute|accelerat|data cent(er|re)", "AI Accelerators / DC Silicon"),
        (r"professional visuali[sz]ation|workstation", "Fabless Semiconductors"),
        (r"automotive|\bauto\b", "Fabless Semiconductors"),
        (r"\boem\b|embedded", "Analog / Embedded Semis"),
    ],
    "banks": [
        (r"consumer|retail banking|card", "Consumer Lending / Cards"),
        (r"markets|trading|investment bank", "Exchanges / Market Infra"),
        (r"wealth|asset management", "Asset & Wealth Management"),
    ],
}
_CONTEXT_COMPILED = {k: [(re.compile(p), g) for p, g in v] for k, v in _CONTEXT_RULES.items()}

_CONTEXT_MATCH = [
    ("semis", r"semiconduct|electronic components"),
    ("banks", r"bank|capital markets|financial services|credit services"),
]


def context_for(industry: str | None, sector: str | None = None) -> str | None:
    """Map an issuer's yfinance industry/sector onto a context overlay key."""
    blob = f"{industry or ''} {sector or ''}".lower()
    for key, pattern in _CONTEXT_MATCH:
        if re.search(pattern, blob):
            return key
    return None


def classify(segment_name: str, context: str | None = None) -> str | None:
    """Best-effort peer group for a reported segment label. None when nothing
    matches confidently — the UI then leaves that segment on the blended multiple
    rather than inventing a comp for it ("Other products and services")."""
    low = " " + (segment_name or "").lower().strip() + " "
    if re.search(r"\bother\b|\bcorporate\b|\ball other\b|\beliminations?\b", low):
        return None
    for rx, group in _CONTEXT_COMPILED.get(context or "", []):
        if rx.search(low):
            return group
    for rx, group in _COMPILED:
        if rx.search(low):
            return group
    return None


def catalogue() -> list[dict]:
    """Flat peer list for the client, grouped for the picker."""
    return [{"name": g, "ps": ps, "family": fam, "note": note}
            for fam, rows in PEER_FAMILIES.items() for g, ps, note in rows]
