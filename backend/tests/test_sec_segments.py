import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sec_segments as S

PROD = "productorserviceaxis"
GEO = "statementgeographicalaxis"


def _seg(name):
    return ({PROD: name}, 0.0)


def test_split_runs_keeps_two_cuts_of_the_same_axis_apart():
    """Microsoft tags product-vs-service AND its named product lines against the
    same axis. Merging them double-counts revenue (the FY2026 bug)."""
    facts = [
        ({PROD: "ProductMember"}, 64.70),
        ({PROD: "ServiceOtherMember"}, 267.14),
        ({}, 331.84),
        ({PROD: "ServerProductsAndCloudServicesMember"}, 129.43),
        ({PROD: "XBOXMember"}, 21.79),
        ({PROD: "OtherProductsAndServicesMember"}, 0.11),
        ({}, 331.84),
    ]
    runs = S._split_runs(facts, S._segment_member)
    assert [len(items) for _, items in runs] == [2, 3]


def test_leading_parent_dropped_children_kept():
    """Nvidia prints Data Center then its Compute/Networking children."""
    items = [("DataCenterMember", 193.74), ("ComputeMember", 162.36),
             ("NetworkingMember", 31.38), ("GamingMember", 16.04)]
    kept = S._drop_rollups(items)
    assert [m for m, _ in kept] == ["ComputeMember", "NetworkingMember", "GamingMember"]


def test_trailing_subtotal_dropped():
    """JPMorgan prints EMEA/APAC/LatAm then a Total International subtotal."""
    items = [("EMEAMember", 24.48), ("AsiaPacificMember", 14.06),
             ("LatinAmericaMember", 4.21), ("TotalInternationalMember", 42.75),
             ("NorthAmericaMember", 139.69)]
    kept = S._drop_rollups(items)
    assert [m for m, _ in kept] == ["EMEAMember", "AsiaPacificMember",
                                    "LatinAmericaMember", "NorthAmericaMember"]


def test_non_adjacent_coincidental_sums_are_not_rollups():
    """A free subset search deletes real segments whose value happens to match
    some combination of the others: here A == B + D and D == C + E, but neither
    is a contiguous block, so neither is a real parent."""
    items = [("A", 90.0), ("B", 50.0), ("C", 25.0), ("D", 40.0), ("E", 15.0)]
    assert len(S._drop_rollups(items)) == 5


def test_largest_reconciling_cut_wins_and_pct_is_of_reported_revenue():
    facts = [
        ("2026-06-30", {PROD: "ProductMember"}, 64.70),
        ("2026-06-30", {PROD: "ServiceOtherMember"}, 267.14),
        ("2026-06-30", {}, 331.84),
        ("2026-06-30", {PROD: "ServerProductsAndCloudServicesMember"}, 129.43),
        ("2026-06-30", {PROD: "MicrosoftThreeSixFiveCommercialProductsAndCloudServicesMember"}, 102.00),
        ("2026-06-30", {PROD: "XBOXMember"}, 100.41),
        ("2026-06-30", {}, 331.84),
    ]
    period = [(m, v) for _, m, v in facts]
    runs = S._split_runs(period, S._segment_member)
    assert max(len(i) for _, i in runs) == 3
    total = next(v for m, v in period if not m)
    assert abs(sum(v for _, v in runs[1][1]) - total) < 0.01 * total


def test_humanize_labels():
    assert S._humanize("MicrosoftThreeSixFiveCommercialProductsAndCloudServicesMember") == \
        "Microsoft 365 Commercial Products and Cloud Services"
    assert S._humanize("LinkedInCorporationMember") == "LinkedIn Corporation"
    assert S._humanize("XBOXMember") == "Xbox"
    assert S._humanize("IPhoneMember") == "iPhone"
    assert S._humanize("WearablesHomeandAccessoriesMember") == "Wearables Home and Accessories"
    assert S._humanize("NonUsMember") == "Non-US"
