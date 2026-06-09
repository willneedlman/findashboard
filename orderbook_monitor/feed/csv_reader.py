import csv
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Generator


@dataclass(slots=True)
class Event:
    timestamp: datetime
    side: str       # "B" or "A"
    price: float
    size: float
    order_id: str


def read_events(path: str | Path) -> Generator[Event, None, None]:
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            yield Event(
                timestamp=datetime.fromisoformat(row["timestamp"]),
                side=row["side"].strip().upper(),
                price=float(row["price"]),
                size=float(row["size"]),
                order_id=row["order_id"].strip(),
            )
