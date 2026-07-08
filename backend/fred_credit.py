"""Real industry delinquency benchmarks from FRED for the Credit Delinquencies tool.

Portfolio-level loan-servicing data (aging buckets, roll rates) has no free public
source, so the tool's portfolios stay modeled. But the industry benchmark each
portfolio is compared against CAN be real: FRED publishes aggregate delinquency
and charge-off rates by loan category, quarterly, for all commercial banks. This
maps each asset class to its closest FRED series so the comparison line is live.

    delinquency = DR*ACBS series (30+ DPD, %) · charge-off = COR*ACBS (annualized, %)
"""
from __future__ import annotations

import fred_client as fred
import credit_delinquencies as cd

AC = cd.AssetClass

# asset class -> (delinquency series, charge-off series), all commercial banks:
#   DRCCLACBS/CORCCACBS      credit card
#   DRCLACBS/CORCLACBS       consumer (all consumer loans)
#   DRSFRMACBS/CORSFRMACBS   single-family residential mortgage
#   DRCRELEXFACBS/CORCREXFACBS  commercial real estate (ex farmland)
#   DRBLACBS/CORBLACBS       business loans
_MAP: dict = {
    AC.CREDIT_CARD:    ("DRCCLACBS", "CORCCACBS"),
    AC.CONSUMER:       ("DRCLACBS", "CORCLACBS"),
    AC.RESIDENTIAL_RE: ("DRSFRMACBS", "CORSFRMACBS"),
    AC.CRE:            ("DRCRELEXFACBS", "CORCREXFACBS"),
    AC.CORPORATE:      ("DRBLACBS", "CORBLACBS"),
}


def benchmarks() -> dict[str, cd.MarketBenchmark] | None:
    """Real per-asset-class benchmarks from FRED, or None if unavailable."""
    if not fred.available():
        return None
    out: dict[str, cd.MarketBenchmark] = {}
    for ac, (d_id, c_id) in _MAP.items():
        d = fred.latest(d_id)
        if not d:
            continue
        c = fred.latest(c_id)
        out[ac.value] = cd.MarketBenchmark(
            asset_class=ac, period=d[0].strftime("%Y-%m"),
            delinquency_rate=round(d[1], 3),
            default_rate=round(c[1], 3) if c else 0.0,
            # FRED has no NPA series; ~90+ DPD is roughly half of 30+ DPD.
            npa_ratio=round(d[1] * 0.55, 3),
            source="FRED · St. Louis Fed",
        )
    return out or None
