import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routers.options import _gex_levels


def test_gex_levels_interpolate_flip_and_find_walls():
    profile = pd.DataFrame([
        {"strike": 90.0, "net_gex": -30.0},
        {"strike": 100.0, "net_gex": -10.0},
        {"strike": 110.0, "net_gex": 30.0},
        {"strike": 120.0, "net_gex": 20.0},
    ])

    levels = _gex_levels(profile, spot=106.0)

    assert levels["flip"] == 102.5
    assert levels["max_positive_gex"] == {"strike": 110.0, "gex_m": 30.0}
    assert levels["max_negative_gex"] == {"strike": 90.0, "gex_m": -30.0}
    assert levels["total_net_gex"] == 10.0
