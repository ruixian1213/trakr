"""Exercise FubonAdapter against recorded-style fixtures. No broker account, certificate or network.

Field names follow the Fubon Neo docs (Query Filled History, Accounting). The fixture values are
taken from the docs' examples, not from a live account. Replace them with real responses once a
test account exists.
"""

from __future__ import annotations

import sys
import types
from datetime import date
from types import SimpleNamespace as NS

import pytest

from tot_agent.adapters.readonly import ReadOnlyViolation
from tot_agent.adapters.fubon_adapter import SnapshotUnavailable


class FakeStock:
    def __init__(self, calls):
        self.calls = calls
        self.window = None
        self.fills = [
            NS(
                date="2023/09/15",
                branch_no="6460",
                account="26",
                order_no="bA422",
                stock_no="1101",
                buy_sell="Sell",
                filled_no="00000000001",
                filled_avg_price=35.2,
                filled_qty=1000,
                filled_price=35.2,
                order_type="Stock",
                filled_time="10:31:00.931",
                user_def=None,
            )
        ]
        self.ok = True

    def filled_history(self, account, start, end):
        self.calls.append("filled_history")
        self.window = (start, end)
        return NS(is_success=self.ok, message=None if self.ok else "x", data=self.fills)

    def place_order(self, *a, **kw):
        self.calls.append("place_order")


class FakeAccounting:
    def __init__(self, calls):
        self.calls = calls

    def inventories(self, account):
        self.calls.append("inventories")

    def unrealized_gains_and_loses(self, account):
        self.calls.append("unrealized_gains_and_loses")

    def query_settlement(self, account, period):
        self.calls.append("query_settlement")

    def cancel_order(self, *a, **kw):
        self.calls.append("cancel_order")


class FakeSdk:
    instances: list["FakeSdk"] = []

    def __init__(self):
        self.calls: list[str] = []
        self.login_args = None
        self.login_ok = True
        self.stock = FakeStock(self.calls)
        self.accounting = FakeAccounting(self.calls)
        FakeSdk.instances.append(self)

    def login(self, user_id, password, cert_path, cert_password):
        self.calls.append("login")
        self.login_args = (user_id, password, cert_path, cert_password)
        if not self.login_ok:
            return NS(is_success=False, message="帳號 A123456789 密碼錯誤", data=[])
        return NS(is_success=True, message=None, data=[NS(branch_no="6460", account="9974825")])

    def logout(self):
        self.calls.append("logout")

    def place_order(self, *a, **kw):
        self.calls.append("place_order")


@pytest.fixture
def fubon_module(monkeypatch):
    FakeSdk.instances.clear()
    sdk_mod = types.ModuleType("fubon_neo.sdk")
    sdk_mod.FubonSDK = FakeSdk
    pkg = types.ModuleType("fubon_neo")
    pkg.sdk = sdk_mod
    monkeypatch.setitem(sys.modules, "fubon_neo", pkg)
    monkeypatch.setitem(sys.modules, "fubon_neo.sdk", sdk_mod)
    return sdk_mod


@pytest.fixture
def adapter(fubon_module):
    from tot_agent.adapters.fubon_adapter import FubonAdapter

    return FubonAdapter(user_id="A123456789", password="pw-secret", cert_path="C:/certs/me.p12", cert_password="cert-secret")


def test_login_passes_the_certificate_and_nothing_else_is_called(adapter):
    sdk = FakeSdk.instances[0]
    assert sdk.login_args == ("A123456789", "pw-secret", "C:/certs/me.p12", "cert-secret")
    assert sdk.calls == ["login"]


def test_failed_login_does_not_echo_sdk_message(fubon_module):
    from tot_agent.adapters.fubon_adapter import FubonAdapter

    original = FakeSdk.__init__

    def failing_init(self):
        original(self)
        self.login_ok = False

    fubon_module.FubonSDK.__init__ = failing_init
    try:
        with pytest.raises(RuntimeError) as err:
            FubonAdapter("A123456789", "pw-secret", "C:/certs/me.p12", "cert-secret")
    finally:
        fubon_module.FubonSDK.__init__ = original
    msg = str(err.value)
    assert "A123456789" not in msg and "pw-secret" not in msg and "cert-secret" not in msg


def test_fingerprint_is_stable_and_hides_the_account_number(adapter):
    fp = adapter.account_fingerprint()
    assert fp == adapter.account_fingerprint()
    assert len(fp) == 64
    assert "9974825" not in fp and "6460" not in fp


def test_fills_map_to_trades_with_shares_and_taipei_time_converted_to_utc(adapter):
    trades = adapter.fetch_trades(today=date(2023, 9, 20))
    assert len(trades) == 1
    t = trades[0]
    assert t.brokerTradeId == "bA422:00000000001"
    assert t.symbol == "1101"
    assert t.side == "sell"
    assert t.qty == 1000
    assert t.price == 35.2
    assert t.executedAt == "2023-09-15T02:31:00.931Z"  # 10:31 Taipei = 02:31 UTC


def test_history_window_is_30_days_inclusive_in_yyyymmdd(adapter):
    adapter.fetch_trades(today=date(2026, 11, 4))
    assert FakeSdk.instances[0].stock.window == ("20261006", "20261104")


def test_a_failed_fill_query_raises_instead_of_returning_nothing(adapter):
    FakeSdk.instances[0].stock.ok = False
    with pytest.raises(RuntimeError):
        adapter.fetch_trades(today=date(2026, 11, 4))


def test_snapshot_is_disabled_until_a_cash_source_exists(adapter):
    with pytest.raises(SnapshotUnavailable):
        adapter.fetch_snapshot()


def test_order_methods_are_unreachable_through_the_adapter(adapter):
    with pytest.raises(ReadOnlyViolation):
        adapter._stock.place_order()
    with pytest.raises(ReadOnlyViolation):
        adapter._accounting.cancel_order()
    with pytest.raises(ReadOnlyViolation):
        adapter._sdk.place_order()
    with pytest.raises(ReadOnlyViolation):
        adapter._sdk.stock  # the raw stock module is not reachable from the top-level handle
    assert not {"place_order", "cancel_order"} & set(FakeSdk.instances[0].calls)


def test_a_normal_sync_only_calls_allow_listed_methods(adapter):
    adapter.fetch_trades(today=date(2026, 11, 4))
    adapter.close()
    calls = set(FakeSdk.instances[0].calls)
    assert calls <= {"login", "logout", "filled_history"}, calls
