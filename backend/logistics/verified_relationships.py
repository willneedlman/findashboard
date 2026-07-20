"""Small, source-linked ledger of public, first-party supply-chain relationships,
plus two programmatic additions: SEC Exhibit 21 significant subsidiaries and
USAspending.gov federal contract awards. All three fold into the same VERIFIED
tier the Supply Chain Map already exposes — the hand-curated ledger below is
intentionally curated rather than inferred, and the EDGAR/USASpending records
are deterministic (the company's own filing, or an actual government award),
so none of the three is the Veridion tag-similarity a "verified" label would
otherwise be misleading against. The raw S&P Capital IQ exports the curated
ledger was originally scoped from are never stored or served here.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


_APPLE_AMP = "https://www.apple.com/newsroom/2025/08/apple-increases-us-commitment-to-600-billion-usd-announces-ambitious-program/"
_APPLE_MAC_MINI = "https://www.apple.com/newsroom/2026/02/apple-accelerates-us-manufacturing-with-mac-mini-production/"
_CHEVRON_MICROSOFT = "https://www.chevron.com/newsroom/2026/q2/chevron-signs-20-year-power-agreement-with-microsoft-for-west-texas-data-center"


# buyer -> supplier / operating partner. The reverse representation is generated
# at request time so a company is never presented as a buyer when the evidence
# actually establishes it as the supplier or partner.
_RELATIONSHIPS = [
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "AMKR", "counterparty_name": "Amkor Technology", "category": "Advanced chip packaging and test", "summary": "Apple will be the first and largest customer at Amkor's Arizona packaging and test facility, which will package and test Apple silicon from TSMC Arizona.", "source": "Apple", "published": "2025-08-06", "url": _APPLE_AMP},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "GLW", "counterparty_name": "Corning", "category": "Cover glass", "summary": "Corning's Harrodsburg, Kentucky facility is dedicated to cover glass for iPhone and Apple Watch shipped globally.", "source": "Apple", "published": "2026-02-24", "url": _APPLE_MAC_MINI},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "TSM", "counterparty_name": "TSMC", "category": "Semiconductor fabrication", "summary": "Apple plans to purchase more than 100 million advanced chips from TSMC's Arizona facility in 2026.", "source": "Apple", "published": "2026-02-24", "url": _APPLE_MAC_MINI},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "TXN", "counterparty_name": "Texas Instruments", "category": "Foundational semiconductors", "summary": "Apple and Texas Instruments are expanding their partnership for U.S. capacity producing semiconductors used in Apple products.", "source": "Apple", "published": "2025-08-06", "url": _APPLE_AMP},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "AVGO", "counterparty_name": "Broadcom", "category": "Cellular semiconductor components", "summary": "Apple is working with Broadcom to develop and manufacture additional cellular semiconductor components in the U.S.", "source": "Apple", "published": "2025-08-06", "url": _APPLE_AMP},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "GFS", "counterparty_name": "GlobalFoundries", "category": "Wireless and power-management semiconductors", "summary": "Apple and GlobalFoundries agreed to expand U.S. semiconductor manufacturing for wireless technologies and advanced power management.", "source": "Apple", "published": "2025-08-06", "url": _APPLE_AMP},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "MP", "counterparty_name": "MP Materials", "category": "Rare-earth magnets", "summary": "MP Materials will manufacture rare-earth magnets in Texas on lines designed for Apple products.", "source": "Apple", "published": "2025-08-06", "url": _APPLE_AMP},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "AMAT", "counterparty_name": "Applied Materials", "category": "Semiconductor manufacturing equipment", "summary": "Apple is partnering directly with Applied Materials to increase U.S. semiconductor-manufacturing equipment production.", "source": "Apple", "published": "2025-08-06", "url": _APPLE_AMP},
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "CRUS", "counterparty_name": "Cirrus Logic", "category": "Mixed-signal integrated circuits", "summary": "Apple, Cirrus Logic and GlobalFoundries are establishing process technologies in Malta, New York for Apple applications including Face ID systems.", "source": "Apple", "published": "2026-03-26", "url": "https://www.apple.com/newsroom/2026/03/apple-adds-new-partners-to-its-american-manufacturing-program/"},
    {"buyer": "MSFT", "buyer_name": "Microsoft", "counterparty": "CVX", "counterparty_name": "Chevron", "category": "Dedicated data-center power", "summary": "Chevron's Energy Forge One will provide dedicated electricity to a Microsoft-operated West Texas data center under a 20-year power purchase agreement.", "source": "Chevron", "published": "2026-06-22", "url": _CHEVRON_MICROSOFT},
]


def _edgar_subsidiary_records(symbol: str, company_name: str) -> list[dict]:
    """Significant-subsidiary edges from the company's own Exhibit 21."""
    try:
        from logistics.edgar_exhibit21 import subsidiaries_for_ticker
        data = subsidiaries_for_ticker(symbol)
    except Exception as exc:
        logger.warning("edgar subsidiary lookup failed for %s: %s", symbol, exc)
        return []
    if not data.get("available"):
        return []
    out = []
    for sub in data["subsidiaries"]:
        name, jurisdiction = sub["name"], sub.get("jurisdiction")
        out.append({
            "counterparty": name.upper()[:40],
            "counterparty_name": name,
            "role": "SUBSIDIARY",
            "flow": f"{company_name} -> {name}",
            "category": f"Significant subsidiary ({jurisdiction})" if jurisdiction else "Significant subsidiary",
            "summary": f"{name} is disclosed as a significant subsidiary of {company_name} in its Exhibit 21 "
                       f"filing dated {data['filing_date']}.",
            "source": "SEC EDGAR",
            "published": data["filing_date"],
            "url": data["url"],
        })
    return out


def _usaspending_agency_records(symbol: str, company_name: str) -> list[dict]:
    """Federal-contract edges from USAspending.gov's agency-award breakdown."""
    try:
        from logistics.public_enrichment import usaspending_agency_awards
        awards = usaspending_agency_awards(company_name)
    except Exception as exc:
        logger.warning("usaspending relationship lookup failed for %s: %s", symbol, exc)
        return []
    out = []
    for a in awards:
        fy_label = a["fiscal_year_end"][:4]
        out.append({
            "counterparty": (a["agency_code"] or a["agency"] or "")[:40],
            "counterparty_name": a["agency"],
            "role": "GOVERNMENT CUSTOMER",
            "flow": f"{a['agency']} -> {company_name}",
            "category": f"Federal contract awards, FY{fy_label}",
            "summary": f"{company_name} received ${a['amount']:,.0f} in net federal contract obligations from "
                       f"{a['agency']} in fiscal year {fy_label} (Oct {a['fiscal_year_start'][:4]} - "
                       f"Sep {a['fiscal_year_end'][:4]}), per USAspending.gov. Keyword-matched, not UEI-verified — "
                       f"directional, not a confirmed award to this specific entity.",
            "source": "USAspending.gov",
            "published": a["fiscal_year_end"],
            "url": "https://www.usaspending.gov/search",
        })
    return out


def _usaspending_subcontract_records(symbol: str, company_name: str) -> list[dict]:
    """Private-sector subcontract edges: primes that hired this company as a
    subcontractor on a federal contract. Role does NOT start with "BUYER" so
    it routes to BUYERS/END MARKETS, same as GOVERNMENT CUSTOMER above — the
    prime is a customer of this company's work, just not the government
    agency directly."""
    try:
        from logistics.public_enrichment import usaspending_subcontracts
        subs = usaspending_subcontracts(company_name)
    except Exception as exc:
        logger.warning("usaspending subcontract relationship lookup failed for %s: %s", symbol, exc)
        return []
    out = []
    for s in subs:
        fy_label = s["fiscal_year_end"][:4]
        prime = s["prime"]
        times = f" ({s['count']} sub-awards)" if s["count"] > 1 else ""
        out.append({
            "counterparty": prime[:40],
            "counterparty_name": prime,
            "role": "SUBCONTRACT CUSTOMER",
            "flow": f"{prime} -> {company_name}",
            "category": f"Federal subcontract, FY{fy_label}",
            "summary": f"{company_name} was subcontracted ${s['total_amount']:,.0f}{times} by {prime} on federal "
                       f"work ({s.get('agency') or 'agency unspecified'}) in fiscal year {fy_label}, per "
                       f"USAspending.gov subaward data. Keyword-matched, not UEI-verified, and subaward reporting "
                       f"compliance is uneven — absence of a row does not mean no relationship exists.",
            "source": "USAspending.gov",
            "published": s["fiscal_year_end"],
            "url": "https://www.usaspending.gov/search",
        })
    return out


def _facility_records(symbol: str, company_name: str) -> list[dict]:
    """Physical-facility edges from the Open Supply Hub CSV ingest. A facility
    contributed against this ticker is a real manufacturing/sourcing site
    doing business with the company, so it's a supplier relationship — role
    "BUYER / SOURCING COMPANY" (the ticker is the buyer/sourcer here) puts it
    on the correct SUPPLIERS/SOURCING side of the graph, same convention the
    curated ledger uses. Capped at 60 so the graph stays legible; the page's
    separate Facilities table still shows the full list regardless of this cap."""
    try:
        from logistics.company_fundamentals import facilities_for_ticker
        data = facilities_for_ticker(symbol, limit=60)
    except Exception as exc:
        logger.warning("facility relationship lookup failed for %s: %s", symbol, exc)
        return []
    if not data.get("available"):
        return []
    out = []
    for f in data["facilities"]:
        name = f.get("name") or "Unnamed facility"
        location = ", ".join(x for x in [f.get("address"), f.get("country")] if x)
        operator = f.get("parent_company")
        summary = f"{name}{f' ({location})' if location else ''} is contributed to Open Supply Hub as a facility " \
                  f"in {company_name}'s supply chain"
        if operator and operator.strip().upper() not in (company_name.strip().upper(), "", "NO GROUP (AP)"):
            summary += f", operated by {operator}"
        summary += "."
        out.append({
            "counterparty": (f.get("os_id") or name)[:40],
            "counterparty_name": name,
            "role": "BUYER / SOURCING COMPANY",
            "flow": f"{name} -> {company_name}",
            "category": f.get("sector") or "Supply chain facility",
            "summary": summary,
            "source": "Open Supply Hub",
            "published": f.get("contribution_date") or "",
            "url": "https://opensupplyhub.org/",
        })
    return out


def relationships_for_ticker(ticker: str) -> dict:
    """Return source-backed relationships for one symbol, with direction explicit.

    Five sources feed the same VERIFIED tier: the hand-curated ledger above
    (first-party disclosures), SEC Exhibit 21 (significant subsidiaries),
    USAspending.gov prime awards (direct federal contracts) and subawards
    (private-sector primes that subcontracted work to this company), and Open
    Supply Hub (physical facilities) — folded together per product decision
    rather than split into separate filter tiers, since all five are
    deterministic/first-party rather than inferred.
    """
    symbol = (ticker or "").strip().upper()
    records = []
    company_name = symbol
    for relation in _RELATIONSHIPS:
        if symbol == relation["buyer"]:
            company_name = relation["buyer_name"]
            records.append({
                "counterparty": relation["counterparty"],
                "counterparty_name": relation["counterparty_name"],
                "role": "BUYER / SOURCING COMPANY",
                "flow": f"{relation['counterparty_name']} -> {relation['buyer_name']}",
                "category": relation["category"],
                "summary": relation["summary"],
                "source": relation["source"],
                "published": relation["published"],
                "url": relation["url"],
            })
        elif symbol == relation["counterparty"]:
            company_name = relation["counterparty_name"]
            records.append({
                "counterparty": relation["buyer"],
                "counterparty_name": relation["buyer_name"],
                "role": "SUPPLIER / OPERATING PARTNER",
                "flow": f"{relation['counterparty_name']} -> {relation['buyer_name']}",
                "category": relation["category"],
                "summary": relation["summary"],
                "source": relation["source"],
                "published": relation["published"],
                "url": relation["url"],
            })

    # SEC's registrant name for this ticker (cached) — a better display name
    # than the raw symbol for tickers the curated ledger above doesn't cover,
    # and the anchor both programmatic sources below key their lookup off.
    resolved_name = company_name
    try:
        from logistics.public_enrichment import _sec_record
        sec = _sec_record(symbol)
        resolved_name = sec.get("facts", {}).get("registrant") or company_name
    except Exception as exc:
        logger.warning("sec registrant lookup failed for %s: %s", symbol, exc)
    if resolved_name and resolved_name != symbol:
        company_name = resolved_name

    records.extend(_edgar_subsidiary_records(symbol, company_name))
    records.extend(_usaspending_agency_records(symbol, company_name))
    records.extend(_usaspending_subcontract_records(symbol, company_name))
    records.extend(_facility_records(symbol, company_name))

    return {
        "ticker": symbol,
        "company_name": company_name,
        "relationships": records,
        "disclaimer": "Only first-party, public relationship disclosures are shown. Absence of a record does not mean no relationship exists.",
    }
