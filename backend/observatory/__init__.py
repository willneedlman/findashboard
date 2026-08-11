"""Observation boards: sparse-feed series described without interpolation."""
from . import copernicus, eia, firms
from .grammar import (
    GRAMMAR_VERSION,
    Kind,
    State,
    StationSpec,
    WindowMode,
    build_board,
    find_gaps,
    read_station,
    regional_read,
    trailing_series,
)

__all__ = [
    "copernicus",
    "eia",
    "firms",
    "GRAMMAR_VERSION",
    "Kind",
    "State",
    "StationSpec",
    "WindowMode",
    "build_board",
    "find_gaps",
    "read_station",
    "regional_read",
    "trailing_series",
]
