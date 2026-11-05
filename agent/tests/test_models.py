from tot_agent.adapters.mock import MockAdapter
from tot_agent.models import iso


def test_iso_is_utc_z():
    assert iso(0) == "1970-01-01T00:00:00.000Z"


def test_mock_adapter_roundtrip():
    a = MockAdapter()
    assert len(a.account_fingerprint()) == 64
    trades = a.fetch_trades()
    assert trades[0].side == "buy" and trades[0].qty == 1000
    snap = a.fetch_snapshot()
    assert snap.positions[0].qty == 1000
