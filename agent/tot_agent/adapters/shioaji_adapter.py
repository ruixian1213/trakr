from __future__ import annotations

import hashlib
import time

from ..models import Position, Snapshot, Trade, iso
from .base import BrokerAdapter
from .readonly import ReadOnlyProxy

LOT = 1000

# Everything the agent is allowed to touch on the SDK. Order placement, order changes,
# certificate activation and futures/options accounts are deliberately absent.
ALLOWED_CALLS = (
    "login",
    "logout",
    "stock_account",
    "update_status",
    "list_trades",
    "list_positions",
    "account_balance",
    "settlements",
)


class ShioajiAdapter(BrokerAdapter):
    """Sinotrade (Shioaji). Read-only: logs in with an API key, never activates a CA, never places orders.

    Create the API key in the Sinotrade console with trading permission turned OFF if the
    console offers that option; the agent does not need it.

    NOTE: written against the public Shioaji docs, not yet exercised against a live account.
    Verify `account_balance` / `settlements` semantics in simulation before trusting `cash`.
    """

    name = "shioaji"

    def __init__(self, api_key: str, secret_key: str, simulation: bool = False):
        import shioaji as sj  # imported lazily so the mock adapter works without it

        self._sj = sj
        self.api = ReadOnlyProxy(sj.Shioaji(simulation=simulation), ALLOWED_CALLS)
        self.api.login(api_key=api_key, secret_key=secret_key)
        self.account = self.api.stock_account

    def account_fingerprint(self) -> str:
        raw = f"tot:v1:{self.account.broker_id}:{self.account.account_id}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def fetch_trades(self) -> list[Trade]:
        self.api.update_status(self.account)
        out: list[Trade] = []
        for tr in self.api.list_trades():
            deals = getattr(tr.status, "deals", None) or []
            lot_mult = LOT if "Common" in str(tr.order.order_lot) else 1
            side = "buy" if "Buy" in str(tr.order.action) else "sell"
            for d in deals:
                out.append(
                    Trade(
                        brokerTradeId=f"{tr.order.id}:{d.seq}",
                        symbol=tr.contract.code,
                        side=side,
                        qty=int(d.quantity) * lot_mult,
                        price=float(d.price),
                        executedAt=iso(float(d.ts)),
                    )
                )
        return out

    def fetch_snapshot(self) -> Snapshot:
        sj = self._sj
        positions = [
            Position(
                symbol=p.code,
                qty=int(p.quantity),
                avgPrice=float(p.price),
                lastPrice=float(p.last_price),
            )
            for p in self.api.list_positions(self.account, unit=sj.constant.Unit.Share)
            if int(p.quantity) > 0
        ]
        cash = float(self.api.account_balance().acc_balance)
        # Settlements (T+1/T+2 receivables and payables) count as cash for equity purposes.
        try:
            for s in self.api.settlements(self.account):
                cash += float(s.t_money)
        except Exception:
            pass
        return Snapshot(takenAt=iso(time.time()), cash=cash, positions=positions)

    def close(self) -> None:
        try:
            self.api.logout()
        except Exception:
            pass
