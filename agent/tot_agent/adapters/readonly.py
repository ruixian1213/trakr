from __future__ import annotations

from typing import Any, Iterable


class ReadOnlyViolation(Exception):
    """Raised when code reaches for a broker function outside the read-only allow-list."""


class ReadOnlyProxy:
    """Wraps a broker SDK object so that only allow-listed attributes can be reached.

    Anything not named in `allowed` (placing, changing or cancelling orders, activating a
    signing certificate, subscribing to anything we do not need) raises before the call is
    made. This is an allow-list on purpose: a new SDK release that adds a trading method
    stays blocked until someone adds it here and a reviewer sees the diff.
    """

    def __init__(self, target: Any, allowed: Iterable[str]):
        object.__setattr__(self, "_target", target)
        object.__setattr__(self, "_allowed", frozenset(allowed))

    def __getattr__(self, name: str) -> Any:
        if name not in self._allowed:
            raise ReadOnlyViolation(f"'{name}' is not allowed: this agent is read-only")
        return getattr(self._target, name)

    def __setattr__(self, name: str, value: Any) -> None:
        raise ReadOnlyViolation("the broker handle cannot be modified")
