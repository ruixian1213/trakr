from __future__ import annotations

import hashlib
import time

from ..models import Position, Snapshot, Trade, iso
from .base import BrokerAdapter


class MockAdapter(BrokerAdapter):
    """Fake broker for local development. Every trade it reports is synthetic."""

    name = "mock"

    def __init__(self, seed: str = "dev"):
        self.seed = seed
        self.cash = 1_000_000.0
        self.qty = 0
        self.trades: list[Trade] = []
        self.n = 0

    def account_fingerprint(self) -> str:
        return hashlib.sha256(f"mock:{self.seed}".encode()).hexdigest()

    def _step(self) -> None:
        self.n += 1
        price = 600 + (self.n % 7) * 3
        side = "buy" if self.qty == 0 else "sell"
        qty = 1000
        t = Trade(f"mock-{self.seed}-{self.n}", "2330", side, qty, float(price), iso(time.time()))
        self.trades.append(t)
        if side == "buy":
            self.qty += qty
            self.cash -= qty * price
        else:
            self.qty -= qty
            self.cash += qty * price * (1 - 0.003)

    def fetch_trades(self) -> list[Trade]:
        self._step()
        return list(self.trades)

    def fetch_snapshot(self) -> Snapshot:
        positions = [Position("2330", self.qty, 600.0, 610.0)] if self.qty else []
        return Snapshot(takenAt=iso(time.time()), cash=self.cash, positions=positions)
