from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta, timezone

from ..models import Snapshot, Trade, iso
from .base import BrokerAdapter
from .readonly import ReadOnlyProxy

# This is the ONLY adapter allowed to load a signing certificate (憑證 / CA). Fubon's login needs
# the certificate file and its password. The certificate can sign orders, so this adapter is built
# to make that the only thing it does with it:
#   - the SDK object exposes only login/logout at the top level;
#   - the stock and accounting modules are wrapped separately, each with a read-only allow-list;
#   - no order, cancel, modify or futures method is reachable through this class.
# The certificate path and password are read by the caller and never printed or stored here.

TAIPEI = timezone(timedelta(hours=8))
MAX_DAYS = 30  # Fubon's filled_history accepts at most 30 days per request

SDK_CALLS = ("login", "logout")
STOCK_CALLS = ("filled_history",)
ACCOUNTING_CALLS = ("inventories", "unrealized_gains_and_loses")


class SnapshotUnavailable(RuntimeError):
    """A complete snapshot cannot be built from the read-only API yet (see agent/README.md)."""


class FubonAdapter(BrokerAdapter):
    """Fubon Neo, read-only. Logs in with a certificate, reads filled records, never orders.

    Status: written against the public Fubon Neo docs (filled_history, inventories,
    unrealized_gains_and_loses). Not yet exercised against a live account.
    fetch_snapshot is disabled because the docs reviewed have no cash-balance query.
    """

    name = "fubon"

    def __init__(self, user_id: str, password: str, cert_path: str, cert_password: str):
        from fubon_neo.sdk import FubonSDK  # imported lazily so other adapters work without it

        sdk = FubonSDK()
        self._sdk = ReadOnlyProxy(sdk, SDK_CALLS)
        res = self._sdk.login(user_id, password, cert_path, cert_password)
        if not getattr(res, "is_success", False):
            # Do not echo the SDK message: it can contain account details.
            raise RuntimeError("富邦登入失敗，請確認帳號、密碼與憑證")
        self.account = res.data[0]
        self._stock = ReadOnlyProxy(sdk.stock, STOCK_CALLS)
        self._accounting = ReadOnlyProxy(sdk.accounting, ACCOUNTING_CALLS)

    def account_fingerprint(self) -> str:
        raw = f"tot:v1:fubon:{self.account.branch_no}:{self.account.account}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def fetch_trades(self, today: date | None = None) -> list[Trade]:
        end = today or datetime.now(TAIPEI).date()
        start = end - timedelta(days=MAX_DAYS - 1)
        res = self._stock.filled_history(self.account, start.strftime("%Y%m%d"), end.strftime("%Y%m%d"))
        if not getattr(res, "is_success", False):
            raise RuntimeError("富邦成交紀錄查詢失敗")
        return [_to_trade(r) for r in res.data]

    def fetch_snapshot(self) -> Snapshot:
        raise SnapshotUnavailable("富邦 API 文件中沒有現金餘額查詢，暫不產生完整快照，因此不同步")

    def close(self) -> None:
        try:
            self._sdk.logout()
        except Exception:
            pass


def _to_trade(r) -> Trade:
    return Trade(
        brokerTradeId=f"{r.order_no}:{r.filled_no}",
        symbol=str(r.stock_no),
        side="buy" if "Buy" in str(r.buy_sell) else "sell",
        qty=int(r.filled_qty),  # shares: the docs example shows 1000 shares = one board lot
        price=float(r.filled_price),
        executedAt=_taipei(str(r.date), str(r.filled_time)),
    )


def _taipei(day: str, clock: str) -> str:
    d = datetime.strptime(day, "%Y/%m/%d")
    t = datetime.strptime(clock, "%H:%M:%S.%f" if "." in clock else "%H:%M:%S")
    local = d.replace(hour=t.hour, minute=t.minute, second=t.second, microsecond=t.microsecond, tzinfo=TAIPEI)
    return iso(local)
