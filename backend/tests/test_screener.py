from routers import screener


def test_nikkei_financial_constituents_are_seeded_and_classified():
    expected = {
        "5831.T", "7186.T", "8304.T", "8306.T", "8308.T", "8309.T", "8316.T", "8331.T", "8354.T", "8411.T",
        "8253.T", "8591.T", "8697.T", "8601.T", "8604.T", "8630.T", "8725.T", "8750.T", "8766.T", "8795.T",
    }

    assert expected <= screener._INTL_SETS["nikkei225"]
    assert all(screener._INTL_NAMES[ticker] for ticker in expected)
    assert {screener._INTL_SECTOR_OVERRIDES[ticker] for ticker in expected} == {"Financial Services"}


def test_international_scope_metadata_does_not_claim_incomplete_indexes_are_full():
    labels = {item["value"]: item["label"] for item in screener.UNIVERSE_OPTIONS}

    assert labels["nikkei225"] == "Japan Large Caps"
    assert labels["ftse100"] == "UK Large Caps"
    assert "curated" in screener.INTERNATIONAL_COVERAGE_NOTE.lower()
