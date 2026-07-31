import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers.corporate import _get_peers_for_ticker


def test_jpm_uses_money_center_bank_cohort():
    peers = _get_peers_for_ticker("JPM", "Financial Services")

    assert peers == ["BAC", "WFC", "C", "USB", "PNC"]
    assert not {"BEN", "FIS", "FISV", "IVZ"} & set(peers)


def test_hban_uses_regional_bank_cohort():
    peers = _get_peers_for_ticker("HBAN", "Financial Services")

    assert peers == ["KEY", "RF", "FITB", "CFG", "MTB", "PNC", "USB"]
    assert not {"BEN", "FIS", "FISV", "IVZ"} & set(peers)
