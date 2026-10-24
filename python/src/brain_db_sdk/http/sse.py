"""The change feed over Server-Sent Events.

:class:`Subscription` is iterated, which is what a Python caller expects and
what makes ``for item in sub:`` the whole loop. The wire client's subscription
is drained with ``next()``; here the iterator protocol IS that, so moving
between the two tiers rewrites the construction and not the loop.

Unsubscribing is closing the subscription — the edge tears the Brain-side
subscription down when the HTTP response closes. Use it as a context manager
and that happens on the way out, including on an exception.

Zero third-party dependencies, like the rest of this tier.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from http.client import HTTPResponse
from typing import Any, Optional, Union

from .errors import BrainHttpError
from .types import SubscriptionClosed, SubscriptionEvent

#: What arrives on the feed: a change, or the terminal close.
FeedItem = Union[SubscriptionEvent, SubscriptionClosed]


@dataclass
class _Frame:
    """One dispatched SSE frame, before it is decoded."""

    event: Optional[str]
    data: str


class Subscription:
    """A live change feed.

    Holds the HTTP response open, so a caller that stops iterating
    backpressures the edge — which backpressures Brain — rather than letting
    events pile up unbounded.
    """

    def __init__(self, response: HTTPResponse) -> None:
        self._resp = response
        self._buf = b""
        self._event: Optional[str] = None
        self._data: list[str] = []
        self._last_id: Optional[str] = None
        self._closed = False

    @property
    def last_event_id(self) -> Optional[str]:
        """The id of the most recent event — its LSN.

        Pass it as ``from_lsn`` on a reconnect to resume after it. Kept here
        so a caller that loses the connection mid-loop still has it; the
        alternative is tracking every event's lsn yourself purely to know
        where you were.
        """
        return self._last_id

    def close(self) -> None:
        """Close the feed. The edge unsubscribes from Brain when this lands."""
        if not self._closed:
            self._closed = True
            self._resp.close()

    def __enter__(self) -> Subscription:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def __iter__(self) -> Iterator[FeedItem]:
        return self

    def __next__(self) -> FeedItem:
        while True:
            frame = self._take_frame()
            if frame is not None:
                return self._decode(frame)
            # Anything already buffered may complete a frame without another
            # read — one TCP segment often carries several events.
            chunk = self._resp.read(4096)
            if not chunk:
                self.close()
                # A clean close with nothing pending ends the iteration: the
                # edge closes after its terminal event, which the caller has
                # already seen.
                raise StopIteration
            self._buf += chunk

    def _take_frame(self) -> Optional[_Frame]:
        """Pull one complete frame out of the buffer, if there is one."""
        while b"\n" in self._buf:
            raw, self._buf = self._buf.split(b"\n", 1)
            # `\r\n` is as legal as `\n`; servers and proxies differ.
            line = raw.rstrip(b"\r").decode("utf-8", "replace")

            if not line:
                # Blank line dispatches the frame.
                if not self._data:
                    # A keep-alive comment produces no data; nothing to
                    # dispatch, keep reading.
                    self._event = None
                    continue
                frame = _Frame(event=self._event, data="\n".join(self._data))
                self._event = None
                self._data = []
                return frame

            # A comment — the keep-alive the edge sends on an idle feed.
            if line.startswith(":"):
                continue

            field, _, value = line.partition(":")
            value = value.removeprefix(" ")
            if field == "event":
                self._event = value
            elif field == "id":
                self._last_id = value
            elif field == "data":
                self._data.append(value)
            # `retry` and anything unknown are ignored, per the SSE spec.
        return None

    @staticmethod
    def _decode(frame: _Frame) -> FeedItem:
        try:
            payload: dict[str, Any] = json.loads(frame.data)
        except ValueError as exc:
            # `BrainHttpError(0, "transport", ...)` is how every other transport
            # failure in this tier is raised; there is no `.transport`
            # constructor, and calling one turned a malformed frame into an
            # AttributeError from inside the error path itself.
            raise BrainHttpError(0, "transport", f"decode subscription frame: {exc}") from exc
        if frame.event == "closed":
            return SubscriptionClosed.from_dict(payload)
        return SubscriptionEvent.from_dict(payload)
