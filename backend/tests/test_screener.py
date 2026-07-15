from routers import screener


def test_us_index_seeds_meet_their_expected_constituent_counts():
    assert len(screener._INDEX_SETS["sp500"]) >= 500
    assert len(screener._INDEX_SETS["sp400"]) == 400
    assert len(screener._INDEX_SETS["nasdaq100"]) >= 100
    assert {"AAPL", "MSFT", "JPM"} <= screener._INDEX_SETS["sp500"]
    assert {"ALV", "FIVE", "WING"} <= screener._INDEX_SETS["sp400"]
    assert {"NVDA", "MSFT", "AMZN"} <= screener._INDEX_SETS["nasdaq100"]


def test_us_seed_has_a_representative_name_in_every_screener_sector():
    expected = set(screener.SECTORS)
    seeded_sectors = {row.get("sector") for row in screener._US_FUND.values()}

    assert expected <= seeded_sectors


def test_international_coverage_states_are_explicit_and_honest():
    coverage = screener._COVERAGE_CONTRACT["universes"]

    assert coverage["dax40"]["available"] == coverage["dax40"]["expected"] == 40
    assert coverage["dax40"]["status"] == "count_complete_unvalidated"
    assert coverage["ftse100"]["available"] == 52
    assert coverage["ftse100"]["available"] < coverage["ftse100"]["expected"] == 100
    assert coverage["ftse100"]["status"] == "partial"
    assert coverage["nikkei225"]["available"] == 64
    assert coverage["nikkei225"]["available"] < coverage["nikkei225"]["expected"] == 225
    assert coverage["nikkei225"]["status"] == "partial"
    assert screener._COVERAGE_CONTRACT["regions"]["Asia-Pacific"]["status"] == "partial"


def test_international_seeds_have_representative_names_and_deterministic_metadata():
    expected = {
        "dax40": {"SAP.DE", "ALV.DE", "RHM.DE"},
        "ftse100": {"AZN.L", "HSBA.L", "SHEL.L", "BTRW.L"},
        "nikkei225": {"7203.T", "6758.T", "8630.T"},
    }
    listing = {
        "dax40": ("Germany", "Europe", "XETRA"),
        "ftse100": ("United Kingdom", "Europe", "LSE"),
        "nikkei225": ("Japan", "Asia-Pacific", "TSE"),
    }

    for universe, tickers in expected.items():
        assert tickers <= screener._INTL_SETS[universe]
        country, region, exchange = listing[universe]
        for ticker in tickers:
            metadata = screener._INTL_TICKER_METADATA[ticker]
            assert metadata == {"country": country, "region": region, "exchange": exchange}
            assert screener._COUNTRY_REGION[metadata["country"]] == region


def test_nikkei_financial_constituents_are_seeded_and_classified():
    expected = {
        "5831.T", "7186.T", "8304.T", "8306.T", "8308.T", "8309.T", "8316.T", "8331.T", "8354.T", "8411.T",
        "8253.T", "8591.T", "8697.T", "8601.T", "8604.T", "8630.T", "8725.T", "8750.T", "8766.T", "8795.T",
    }

    assert expected <= screener._INTL_SETS["nikkei225"]
    assert all(screener._INTL_NAMES[ticker] for ticker in expected)
    assert {screener._INTL_SECTOR_OVERRIDES[ticker] for ticker in expected} == {"Financial Services"}


def test_metadata_and_picker_do_not_claim_global_or_incomplete_coverage_is_full():
    labels = {item["value"]: item["label"] for item in screener.UNIVERSE_OPTIONS}

    assert labels[""] == "Bundled Universes"
    assert labels["nikkei225"] == "Japan Large Caps"
    assert labels["ftse100"] == "UK Large Caps"
    assert "curated" in screener.INTERNATIONAL_COVERAGE_NOTE.lower()
    assert {"LSE", "XETRA", "TSE"} <= set(screener.EXCHANGES)


def test_country_aliases_do_not_silently_drop_valid_international_names():
    assert screener._COUNTRY_REGION["GB"] == "Europe"
    assert screener._COUNTRY_REGION["DE"] == "Europe"
    assert screener._COUNTRY_REGION["JP"] == "Asia-Pacific"


def test_region_and_exchange_filters_keep_a_valid_bundled_international_name(monkeypatch):
    row = {
        "ticker": "8630.T", "companyName": "Sompo Holdings", "price": 10.0,
        "marketCap": 50.0, "sector": "Financial Services", "exchange": "TSE",
        "country": "Japan", "change1d": 0.0, "beta": None, "volume": None,
    }
    monkeypatch.setattr(screener.fmp, "available", lambda: False)
    monkeypatch.setattr(screener, "_intl_snapshot", lambda: [row])
    monkeypatch.setattr(screener, "_enrich", lambda ticker, base, claim, need_fastinfo: base)
    screener._screen_cache.clear()

    result = screener.run_screen(screener.ScreenRequest(
        universe="nikkei225", region="Asia-Pacific", exchange="TSE", sector="Financial Services",
    ))

    assert [item["ticker"] for item in result["results"]] == ["8630.T"]
    assert result["coverage"]["status"] == "partial"
