"""The two clients must stay the same client.

``AsyncBrainClient`` is a hand-written mirror of ``BrainClient``: 71 verbs
whose bodies differ only by ``await``. That is a deliberate trade — it keeps
full static typing and real docstrings, where generating one from the other at
build time would hand users a file no editor can see into — but it only holds
if nothing drifts. A verb added to one and forgotten on the other, a parameter
renamed, a default changed: each is invisible at review time and silent at
runtime, because the two files are never read together.

These tests are the thing that makes the trade safe. They compare the two
surfaces by reflection, so a new verb on either side fails the build until it
exists on both with the same signature.

Three differences are legitimate and are the only ones allowed, each listed
explicitly below rather than tolerated by a loose comparison: the teardown is
named ``aclose``, the subscription type is the async one, and every verb is a
coroutine.
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest

from brain_db_sdk.aio import AsyncBrainClient
from brain_db_sdk.aio.mux import AsyncSubscription
from brain_db_sdk.client import BrainClient
from brain_db_sdk.mux import Subscription

# Teardown is spelled differently on purpose: the async one suspends (the BYE
# has to reach the wire and the reader task has to be awaited), and PEP 525
# names such a method `aclose`.
RENAMED = {"close": "aclose"}
# Types that legitimately differ between the tiers, async on the left.
TYPE_EQUIVALENTS = {
    AsyncSubscription: Subscription,
    "AsyncSubscription": "Subscription",
    "AsyncBrainClient": "BrainClient",
}


def _names(cls: type) -> set[str]:
    return {
        name
        for name, member in inspect.getmembers(cls)
        if not name.startswith("_") and (inspect.isfunction(member) or inspect.ismethod(member))
    }


def _sync_name(async_name: str) -> str:
    reverse = {v: k for k, v in RENAMED.items()}
    return reverse.get(async_name, async_name)


def _normalise(annotation: Any) -> Any:
    """Collapse the two tiers' equivalent types onto one name so a comparison
    is about shape, not spelling."""
    if annotation in TYPE_EQUIVALENTS:
        return TYPE_EQUIVALENTS[annotation]
    if isinstance(annotation, str):
        out = annotation
        for async_name, sync_name in TYPE_EQUIVALENTS.items():
            if isinstance(async_name, str):
                out = out.replace(async_name, sync_name)
        return out
    return annotation


ASYNC_NAMES = _names(AsyncBrainClient)
SYNC_NAMES = _names(BrainClient)


def test_the_two_clients_expose_the_same_verbs() -> None:
    translated = {_sync_name(n) for n in ASYNC_NAMES}
    missing_on_async = SYNC_NAMES - translated
    extra_on_async = translated - SYNC_NAMES
    assert not missing_on_async, (
        f"BrainClient has verbs AsyncBrainClient does not: {sorted(missing_on_async)}. "
        "Add them to brain_db_sdk/aio/client.py."
    )
    assert not extra_on_async, (
        f"AsyncBrainClient has verbs BrainClient does not: {sorted(extra_on_async)}. "
        "Add them to brain_db_sdk/client.py."
    )


def test_the_surface_is_not_trivially_small() -> None:
    """A guard on the guard: if reflection ever stops finding methods, every
    other test here passes vacuously."""
    assert len(SYNC_NAMES) >= 70, f"only found {len(SYNC_NAMES)} verbs; reflection is broken"


def test_every_async_verb_is_a_coroutine() -> None:
    """A verb that forgot its ``async`` returns a value where callers await
    one — which works, silently, until the caller awaits it."""
    not_coroutines = [
        name
        for name in sorted(ASYNC_NAMES)
        if not inspect.iscoroutinefunction(getattr(AsyncBrainClient, name))
    ]
    assert not not_coroutines, f"not coroutines on AsyncBrainClient: {not_coroutines}"


def test_no_sync_verb_is_a_coroutine() -> None:
    coroutines = [
        name
        for name in sorted(SYNC_NAMES)
        if inspect.iscoroutinefunction(getattr(BrainClient, name))
    ]
    assert not coroutines, f"coroutines on the synchronous BrainClient: {coroutines}"


@pytest.mark.parametrize("async_name", sorted(ASYNC_NAMES))
def test_signatures_match_verb_for_verb(async_name: str) -> None:
    """Parameter names, order, defaults and annotations, one verb at a time —
    parametrized so a failure names the verb rather than dumping 71 of them."""
    sync_name = _sync_name(async_name)
    if sync_name not in SYNC_NAMES:
        pytest.skip(f"{sync_name} is covered by the surface test")

    async_sig = inspect.signature(getattr(AsyncBrainClient, async_name))
    sync_sig = inspect.signature(getattr(BrainClient, sync_name))

    assert list(async_sig.parameters) == list(sync_sig.parameters), (
        f"{async_name}: parameter names or order differ"
    )
    for name, async_param in async_sig.parameters.items():
        sync_param = sync_sig.parameters[name]
        assert async_param.default == sync_param.default, f"{async_name}.{name}: default differs"
        assert async_param.kind == sync_param.kind, f"{async_name}.{name}: kind differs"
        assert _normalise(async_param.annotation) == _normalise(sync_param.annotation), (
            f"{async_name}.{name}: annotation differs"
        )
    assert _normalise(async_sig.return_annotation) == _normalise(sync_sig.return_annotation), (
        f"{async_name}: return annotation differs"
    )


@pytest.mark.parametrize("async_name", sorted(ASYNC_NAMES))
def test_every_verb_is_documented(async_name: str) -> None:
    doc = inspect.getdoc(getattr(AsyncBrainClient, async_name))
    assert doc, (
        f"{async_name} has no docstring. The async client is hand-written "
        "precisely so that editors can show these."
    )


def test_the_configuration_types_are_shared_not_copied() -> None:
    """``Auth`` / ``ClientConfig`` / ``ConnectionInfo`` carry no transport, so
    both tiers import the same objects. Two copies would mean a connect
    timeout or a credential could come to mean different things."""
    import brain_db_sdk.aio.client as aio_client
    import brain_db_sdk.client as sync_client

    for name in ("Auth", "ClientConfig", "ConnectionInfo"):
        assert getattr(aio_client, name) is getattr(sync_client, name), (
            f"{name} has been duplicated into the aio tier"
        )


def test_the_builders_are_shared_too() -> None:
    """The request builders mint the ``request_id`` that makes a retry
    idempotent; a second copy would be a second source of that truth."""
    from brain_db_sdk import verbs

    assert not hasattr(__import__("brain_db_sdk.aio", fromlist=["x"]), "EncodeBuilder")
    assert verbs.EncodeBuilder.__module__ == "brain_db_sdk.verbs"


def test_the_subscriptions_offer_the_same_operations() -> None:
    sync_ops = set(_names(Subscription))
    async_ops = {_sync_name(n) for n in _names(AsyncSubscription)}
    assert sync_ops == async_ops, (
        f"subscription surfaces differ: sync-only {sorted(sync_ops - async_ops)}, "
        f"async-only {sorted(async_ops - sync_ops)}"
    )
