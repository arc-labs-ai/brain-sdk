"""Golden test for space-id derivation — must agree with the server's frozen seed."""

import uuid

from brain_db_sdk import derive_space_id


def test_derive_space_id_matches_server_golden():
    # The same vector brain-core pins: client and server must agree, or a space
    # string would resolve to different storage ids on each side.
    got = derive_space_id("acme", "support-bot:user123")
    assert str(uuid.UUID(bytes=got)) == "119061cc-b6db-5cde-8edd-0cefa33452eb"


def test_same_space_diverges_across_namespaces():
    assert derive_space_id("ns_a", "u1") != derive_space_id("ns_b", "u1")
