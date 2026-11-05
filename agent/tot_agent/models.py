from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone


def iso(ts: float | datetime) -> str:
    """ISO-8601 UTC with a trailing Z, the only timestamp format the server accepts."""
    if isinstance(ts, (int, float)):
        ts = datetime.fromtimestamp(ts, tz=timezone.utc)
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


@dataclass
class Trade:
    """One execution. Quantities are shares (1 lot = 1000 shares)."""

    brokerTradeId: str
    symbol: str
    side: str  # "buy" | "sell"
    qty: int
    price: float
    executedAt: str
    fee: float = 0.0


@dataclass
class Position:
    symbol: str
    qty: int
    avgPrice: float
    lastPrice: float


@dataclass
class Snapshot:
    takenAt: str
    cash: float  # including unsettled receivables/payables
    positions: list[Position] = field(default_factory=list)


def to_dict(obj) -> dict:
    return asdict(obj)
