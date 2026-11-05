from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Snapshot, Trade


class BrokerAdapter(ABC):
    """Read-only view of one broker account.

    Adapters must never place, modify or cancel orders, and must never load a signing
    certificate (CA). Reviewers should be able to confirm that by reading this directory.
    """

    name: str

    @abstractmethod
    def account_fingerprint(self) -> str:
        """Stable, non-reversible id of the broker account (so it can be bound to one user)."""

    @abstractmethod
    def fetch_trades(self) -> list[Trade]:
        """Executions known to the broker for the current session. May repeat across calls; the server dedupes."""

    @abstractmethod
    def fetch_snapshot(self) -> Snapshot:
        """Current cash and positions."""

    def close(self) -> None:
        pass
