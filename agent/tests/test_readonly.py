from pathlib import Path

from tot_agent.adapters.readonly import ReadOnlyProxy, ReadOnlyViolation
from tot_agent.adapters.shioaji_adapter import ALLOWED_CALLS


class FakeSdk:
    """Stands in for a broker SDK. Records anything that gets called."""

    def __init__(self):
        self.calls = []
        self.stock_account = "acct"

    def login(self, **kw):
        self.calls.append("login")

    def list_positions(self, *a, **kw):
        self.calls.append("list_positions")
        return []

    def place_order(self, *a, **kw):
        self.calls.append("place_order")

    def activate_ca(self, *a, **kw):
        self.calls.append("activate_ca")

    def cancel_order(self, *a, **kw):
        self.calls.append("cancel_order")


def raises(fn):
    try:
        fn()
    except ReadOnlyViolation:
        return True
    return False


def test_allowed_calls_pass_through():
    sdk = FakeSdk()
    api = ReadOnlyProxy(sdk, ALLOWED_CALLS)
    api.login(api_key="k", secret_key="s")
    assert api.list_positions() == []
    assert api.stock_account == "acct"
    assert sdk.calls == ["login", "list_positions"]


def test_trading_calls_are_blocked_before_reaching_the_sdk():
    sdk = FakeSdk()
    api = ReadOnlyProxy(sdk, ALLOWED_CALLS)
    for name in ("place_order", "activate_ca", "cancel_order", "update_order", "futopt_account"):
        assert raises(lambda n=name: getattr(api, n)), name
    assert sdk.calls == [], "a blocked call must never reach the SDK"


def test_unknown_future_sdk_methods_are_blocked_by_default():
    api = ReadOnlyProxy(FakeSdk(), ALLOWED_CALLS)
    assert raises(lambda: api.some_new_trading_method_in_v9)


def test_handle_cannot_be_modified():
    api = ReadOnlyProxy(FakeSdk(), ALLOWED_CALLS)
    assert raises(lambda: setattr(api, "place_order", lambda: None))


def test_allow_list_contains_no_trading_names():
    forbidden = ("order", "ca", "cancel", "futopt", "buy", "sell", "trade_")
    for name in ALLOWED_CALLS:
        if name == "list_trades":  # reading executions, not placing them
            continue
        assert not any(f in name for f in forbidden), name


ORDER_TOKENS = ("place_order", "cancel_order", "update_order", "activate_ca")
CERT_TOKENS = ("ca_passwd", "ca_path", "person_id")
# Only the Fubon adapter may handle a certificate, and only for login. Every other adapter stays
# certificate-free, and no adapter may name an order or CA-activation call.
CERT_OWNERS = {"fubon_adapter.py"}


def test_adapter_sources_never_mention_trading_calls():
    """Cheap tripwire: a reviewer should never see these names in adapter code."""
    adapters = Path(__file__).resolve().parents[1] / "tot_agent" / "adapters"
    for path in adapters.glob("*.py"):
        if path.name == "readonly.py":
            continue
        text = path.read_text(encoding="utf-8")
        banned = ORDER_TOKENS if path.name in CERT_OWNERS else ORDER_TOKENS + CERT_TOKENS
        for token in banned:
            assert token not in text, f"{path.name} mentions {token}"


def test_certificate_handling_is_limited_to_the_fubon_adapter():
    adapters = Path(__file__).resolve().parents[1] / "tot_agent" / "adapters"
    assert {p.name for p in adapters.glob("*.py") if any(t in p.read_text(encoding="utf-8") for t in CERT_TOKENS)} <= CERT_OWNERS
