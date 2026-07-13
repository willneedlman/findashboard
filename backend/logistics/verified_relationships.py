"""Small, source-linked ledger of public, first-party supply-chain relationships.

This is intentionally curated rather than inferred. Each record is limited to a
relationship that the named company publicly described, and the raw S&P Capital
IQ exports are never stored or served here.
"""
from __future__ import annotations


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
    {"buyer": "AAPL", "buyer_name": "Apple", "counterparty": "CIRR", "counterparty_name": "Cirrus Logic", "category": "Mixed-signal integrated circuits", "summary": "Apple, Cirrus Logic and GlobalFoundries are establishing process technologies in Malta, New York for Apple applications including Face ID systems.", "source": "Apple", "published": "2026-03-26", "url": "https://www.apple.com/newsroom/2026/03/apple-adds-new-partners-to-its-american-manufacturing-program/"},
    {"buyer": "MSFT", "buyer_name": "Microsoft", "counterparty": "CVX", "counterparty_name": "Chevron", "category": "Dedicated data-center power", "summary": "Chevron's Energy Forge One will provide dedicated electricity to a Microsoft-operated West Texas data center under a 20-year power purchase agreement.", "source": "Chevron", "published": "2026-06-22", "url": _CHEVRON_MICROSOFT},
]


def relationships_for_ticker(ticker: str) -> dict:
    """Return source-backed relationships for one symbol, with direction explicit."""
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
    return {
        "ticker": symbol,
        "company_name": company_name,
        "relationships": records,
        "disclaimer": "Only first-party, public relationship disclosures are shown. Absence of a record does not mean no relationship exists.",
    }
