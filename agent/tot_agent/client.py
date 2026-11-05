from __future__ import annotations

import json
import urllib.error
import urllib.request

from .models import Snapshot, Trade, to_dict


class IngestError(Exception):
    pass


def post_ingest(server: str, token: str, broker: str, fingerprint: str, trades: list[Trade], snapshot: Snapshot) -> dict:
    body = json.dumps(
        {
            "broker": broker,
            "accountFingerprint": fingerprint,
            "trades": [to_dict(t) for t in trades],
            "snapshot": to_dict(snapshot),
        }
    ).encode()
    req = urllib.request.Request(
        server.rstrip("/") + "/api/ingest",
        data=body,
        method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise IngestError(f"{e.code}: {e.read().decode(errors='replace')}") from e
