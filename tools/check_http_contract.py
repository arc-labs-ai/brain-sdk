#!/usr/bin/env python3
"""Check the three SDK HTTP clients against brain-edge's vendored contract.

The wire boundary has `protocol.json` plus the corpus. This is the same idea for
the HTTP boundary: `contract/http-routes.json` is generated from brain-edge's
own DTOs and router, and every SDK is checked against it.

Without this, the two sides were independent hand transcriptions of the same
JSON with nothing in between — the setup that produced `session_filter` and
`RetrieverWire` on the wire side. It had already produced two instances here:
`whoami` documented as returning `agent_id` when the edge returns `space_id`,
and the clients covering 10 of the edge's 25 method+path combos, so an HTTP-tier
user could not reach entities, statements, relations, graph or schema at all.

What this checks: that every route the edge exposes is reachable from every SDK.
That is the gate that catches a route being added to the edge and never reaching
a client — the failure that leaves a whole feature unusable over HTTP.

What it does NOT check: response field shapes. Those are named differently per
language (camelCase in TypeScript) and mapped through each SDK's own result
types, so comparing them here reproduces the false-positive problem that made
the first three attempts at `compare_bindings.py` useless. Field-level checking
belongs in each SDK's own tests, against the same manifest.

Usage: check_http_contract.py [contract/http-routes.json]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Where each SDK's HTTP client lives, and how a route literal appears in it.
# Only path string literals are parsed — the most reliable thing in any of the
# three languages — and the method is read from the surrounding call.
CLIENTS = {
    "rust": ROOT / "rust" / "src" / "http" / "client.rs",
    "python": ROOT / "python" / "src" / "brain_db_sdk" / "http" / "client.py",
    "typescript": ROOT / "typescript" / "src" / "http" / "client.ts",
}

# All three clients pass the method and the path as adjacent arguments to one
# call:
#     rust    self.request(Method::POST, "/v1/memories", Some(input), true)
#     python  self._request("POST", "/v1/memories", body, idempotent=True)
#     ts      this.request("POST", "/v1/memories", input)
#
# So the two are matched together rather than by looking for a method somewhere
# near a path. A window-based search reported DELETE /v1/plan, GET /v1/reason
# and POST /v1/whoami — each of them the *neighbouring* verb's method paired
# with this verb's path.
ROUTE_CALL = re.compile(
    r"""(?:Method::)?["']?\b(GET|POST|PUT|DELETE|PATCH)\b["']?\s*,\s*"""
    # A string prefix or wrapper may sit between the comma and the quote:
    #   python  f"/v1/entities/{id}"        f-string
    #   rust    format!("/v1/entities/{}")  macro
    #   rust    &format!(...)               borrowed
    # Missing the f-string prefix made all six parameterized Python routes
    # invisible, and the SDK author worked around the tool by writing
    # `"...{}".format(...)` instead — the tool distorting the code it checks.
    r"""(?:&?\s*format!\(\s*)?[a-zA-Z]{0,2}["'`](/v1/[^"'`]*)["'`]""",
    re.I,
)


def normalize(path: str) -> str:
    """Collapse every interpolation form to the manifest's `{id}` placeholder."""
    path = re.sub(r"\$\{[^}]*\}", "{id}", path)  # TS template
    path = re.sub(r"\{[^}]*\}", "{id}", path)  # Rust/Python format braces
    path = path.replace("{}", "{id}")  # bare Rust positional
    return path.rstrip("/") or "/"


def routes_in(source: str) -> set[tuple[str, str]]:
    """`(METHOD, path)` pairs a client source declares."""
    return {
        (meth.upper(), normalize(path)) for meth, path in ROUTE_CALL.findall(source)
    }


def main() -> int:
    manifest_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "contract" / "http-routes.json"
    manifest = json.loads(manifest_path.read_text())

    if manifest.get("unparsed"):
        print(f"contract manifest has {len(manifest['unparsed'])} unparsed items — not trustworthy:")
        for u in manifest["unparsed"][:10]:
            print(f"  ! {u}")
        return 1

    expected = {(r["method"], normalize(r["path"])) for r in manifest["routes"]}
    print(f"brain-edge exposes {len(expected)} method+path combos "
          f"across {len({p for _, p in expected})} paths\n")

    failed = False
    for lang, path in CLIENTS.items():
        if not path.exists():
            print(f"{lang:11} SOURCE NOT FOUND: {path}")
            failed = True
            continue
        have = routes_in(path.read_text())
        missing = sorted(expected - have)
        # A client route the edge does not serve is a 404 waiting to happen.
        extra = sorted({r for r in have if r[1].startswith("/v1/")} - expected)

        status = "ok" if not missing and not extra else "FAIL"
        print(f"{lang:11} {len(expected) - len(missing):2}/{len(expected)} routes   [{status}]")
        for meth, p in missing:
            print(f"              missing  {meth:6} {p}")
        for meth, p in extra:
            print(f"              not on the edge  {meth:6} {p}")
        if missing or extra:
            failed = True

    print()
    if failed:
        print("HTTP contract drift. Either the SDK is missing a route the edge serves,", file=sys.stderr)
        print("or the vendored manifest is stale — refresh it per contract/SOURCE.txt.", file=sys.stderr)
        return 1
    print("All three SDKs cover the edge's HTTP surface.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
