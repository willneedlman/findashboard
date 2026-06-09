from dataclasses import dataclass


@dataclass
class ReplayConfig:
    csv_path: str = "data/sample.csv"
    speed_multiplier: float = 10.0      # 10x faster than real-time
    snapshot_interval: int = 100        # print every N messages
    top_n_levels: int = 5               # levels shown in snapshot
