from dataclasses import dataclass, field


@dataclass
class PriceLevel:
    price: float
    size: float = 0.0
    order_ids: set = field(default_factory=set)

    def add(self, order_id: str, size: float) -> None:
        self.order_ids.add(order_id)
        self.size += size

    def remove(self, order_id: str, size: float) -> None:
        self.order_ids.discard(order_id)
        self.size = max(0.0, self.size - size)

    @property
    def is_empty(self) -> bool:
        return self.size <= 0.0
