"""Exercise ShioajiAdapter against recorded-style fixtures. No broker account or network needed.

The fake `shioaji` module below mimics only the attributes the adapter touches. Field shapes
follow the public Shioaji docs as written in the adapter; they are NOT yet confirmed against a
live or simulated account. Once a simulation account exists, record real responses and replace
these literals so the fixtures reflect the SDK's actual output.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace as NS

import pytest

from tot_agent.adapters.readonly import ReadOnlyViolation


class FakeShioaji:
    """Records every call so tests can prove what the adapter did and did not do."""

    instances: list["FakeShioaji"] = []

    def __init__(self, simulation: bool = False):
        self.simulation = simulation
        self.calls: list[str] = []
        self.stock_account = NS(broker_id="9A", account_id="1234567", signed=True)
        self.balance = NS(acc_balance=100_000.0)
        self.positions = [
            NS(code="2330", quantity=2, price=600.0, last_price=620.0),
            NS(code="0050", quantity=0, price=150.0, last_price=151.0),  # closed out: must be skipped
        ]
        self.settle_rows = [NS(t_money=5_000.0)]
        self.settle_error: Exception | None = None
        self.trades = [
            NS(
                order=NS(id="ord1", action="Action.Buy", order_lot="Common", id_=None),
                contract=NS(code="2330"),
                status=NS(deals=[NS(seq="1", quantity=1, price=600.0, ts=1_700_000_000.0)]),
            ),
            NS(
                order=NS(id="ord2", action="Action.Sell", order_lot="IntradayOdd", id_=None),
                contract=NS(code="2330"),
                status=NS(deals=[NS(seq="1", quantity=500, price=610.0, ts=1_700_000_100.0)]),
            ),
        ]
        FakeShioaji.instances.append(self)

    def login(self, **kw):
        self.calls.append("login")

    def logout(self):
        self.calls.append("logout")

    def update_status(self, account=None, **kw):
        self.calls.append("update_status")

    def list_trades(self):
        self.calls.append("list_trades")
        return self.trades

    def list_positions(self, account=None, unit=None, **kw):
        self.calls.append("list_positions")
        return self.positions

    def account_balance(self):
        self.calls.append("account_balance")
        return self.balance

    def settlements(self, account=None):
        self.calls.append("settlements")
        if self.settle_error:
            raise self.settle_error
        return self.settle_rows

    # Trading methods exist on the real SDK. The proxy must stop them before they are reached.
    def place_order(self, *a, **kw):
        self.calls.append("place_order")

    def cancel_order(self, *a, **kw):
        self.calls.append("cancel_order")

    def activate_ca(self, *a, **kw):
        self.calls.append("activate_ca")


@pytest.fixture
def sj_module(monkeypatch):
    FakeShioaji.instances.clear()
    mod = types.ModuleType("shioaji")
    mod.Shioaji = FakeShioaji
    mod.constant = NS(Unit=NS(Share="Share", Common="Common"))
    monkeypatch.setitem(sys.modules, "shioaji", mod)
    return mod


@pytest.fixture
def adapter(sj_module):
    from tot_agent.adapters.shioaji_adapter import ShioajiAdapter

    return ShioajiAdapter(api_key="k", secret_key="s", simulation=True)


def test_login_uses_simulation_flag_and_is_the_only_setup_call(adapter):
    sdk = FakeShioaji.instances[0]
    assert sdk.simulation is True
    assert sdk.calls == ["login"]


def test_fingerprint_is_stable_and_hides_the_raw_account_number(adapter):
    fp = adapter.account_fingerprint()
    assert fp == adapter.account_fingerprint()
    assert len(fp) == 64
    assert "1234567" not in fp and "9A" not in fp


def test_trades_map_lots_and_shares_and_sides(adapter):
    trades = adapter.fetch_trades()
    assert [t.brokerTradeId for t in trades] == ["ord1:1", "ord2:1"]
    board, odd = trades
    assert board.side == "buy" and board.qty == 1000  # Common lot = 1000 shares
    assert odd.side == "sell" and odd.qty == 500  # odd lot = raw shares
    assert board.price == 600.0 and odd.price == 610.0


def test_trade_timestamps_are_utc_z_format(adapter):
    trades = adapter.fetch_trades()
    assert trades[0].executedAt.endswith("Z")
    assert trades[0].executedAt == "2023-11-14T22:13:20.000Z"


def test_snapshot_skips_closed_positions_and_adds_settlements(adapter):
    snap = adapter.fetch_snapshot()
    assert [p.symbol for p in snap.positions] == ["2330"]
    assert snap.positions[0].qty == 2
    assert snap.cash == pytest.approx(105_000.0)  # balance + settlement receivable


def test_settlement_failure_does_not_break_the_snapshot(adapter):
    FakeShioaji.instances[0].settle_error = RuntimeError("settlement endpoint down")
    snap = adapter.fetch_snapshot()
    assert snap.cash == pytest.approx(100_000.0)  # falls back to balance only


def test_order_methods_are_unreachable_through_the_adapter(adapter):
    with pytest.raises(ReadOnlyViolation):
        adapter.api.place_order()
    with pytest.raises(ReadOnlyViolation):
        adapter.api.cancel_order()
    with pytest.raises(ReadOnlyViolation):
        adapter.api.activate_ca()
    sdk = FakeShioaji.instances[0]
    assert not {"place_order", "cancel_order", "activate_ca"} & set(sdk.calls)


def test_full_sync_only_calls_allow_listed_methods(adapter):
    adapter.fetch_trades()
    adapter.fetch_snapshot()
    adapter.close()
    calls = set(FakeShioaji.instances[0].calls)
    allowed = {"login", "logout", "update_status", "list_trades", "list_positions", "account_balance", "settlements"}
    assert calls <= allowed, calls - allowed
