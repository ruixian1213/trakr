from __future__ import annotations

import argparse
import os
import sys
import time

from .adapters.base import BrokerAdapter
from .client import IngestError, post_ingest


def build_adapter(kind: str) -> BrokerAdapter:
    if kind == "mock":
        from .adapters.mock import MockAdapter

        return MockAdapter()
    if kind == "shioaji":
        from .adapters.shioaji_adapter import ShioajiAdapter

        return ShioajiAdapter(
            api_key=os.environ["SHIOAJI_API_KEY"],
            secret_key=os.environ["SHIOAJI_SECRET_KEY"],
            simulation=os.environ.get("SHIOAJI_SIMULATION") == "1",
        )
    sys.exit(f"unknown broker: {kind}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Trakr read-only broker sync agent")
    ap.add_argument("--broker", choices=["shioaji", "mock"], default="shioaji")
    ap.add_argument("--server", default=os.environ.get("TOT_SERVER", "http://127.0.0.1:3000"))
    ap.add_argument("--interval", type=int, default=60, help="seconds between syncs")
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()

    token = os.environ.get("TOT_AGENT_KEY")
    if not token:
        sys.exit("set TOT_AGENT_KEY to a sync key created on the account page (it is not your login password)")

    adapter = build_adapter(args.broker)
    fingerprint = adapter.account_fingerprint()
    try:
        while True:
            try:
                res = post_ingest(
                    args.server, token, adapter.name, fingerprint, adapter.fetch_trades(), adapter.fetch_snapshot()
                )
                print(f"synced: {res}", flush=True)
            except IngestError as e:
                print(f"server rejected sync: {e}", file=sys.stderr, flush=True)
            except Exception as e:  # network or broker hiccup; keep running, the server records any gap
                print(f"sync failed: {e}", file=sys.stderr, flush=True)
            if args.once:
                break
            time.sleep(args.interval)
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
