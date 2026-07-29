/**
 * Feature: ENCODE_VECTOR_DIRECT — write a pre-computed embedding, bypassing the
 * server's owned embedding model (integration, real server).
 *
 * This is the only verb whose payload is not pure CBOR: the vector rides a
 * trailing raw little-endian f32 section after the CBOR map, so the frame
 * carries two differently-encoded regions. Nothing else in the protocol works
 * that way, which makes it the easiest framing to get subtly wrong and the least
 * likely to be noticed — a dropped or truncated trailer still produces a
 * well-formed frame.
 *
 * What actually proves the framing is the *accepting* case, not the rejecting
 * ones. Verified in the Python port by dropping the trailer from the encoder:
 * the wrong-length tests still passed, because zero floats is also a wrong
 * count. Only the round-trip failed. A successful 384-float write is therefore
 * the load-bearing assertion — it can only succeed if the trailer arrived,
 * carried exactly 384 f32s, and was little-endian, since the server checks all
 * three (see the byte-order case, rejected for wrong magnitude once misread).
 *
 * The rejection cases earn their place differently: they prove the server
 * validates rather than accepts anything, without which the accepting case
 * would prove nothing.
 *
 * Gated on `BRAIN_SDK_IT_DATA` (see `scripts/it-server.sh`); skips offline.
 */

import { describe, expect, it } from "vitest";

import { newId } from "../../src/client.js";
import { EncodeBuilder } from "../../src/verbs.js";
import { MemoryKindWire } from "../../src/wire/types.js";
import type { EncodeVectorDirectRequest, WireUuid } from "../../src/wire/types.js";
import { connectFresh, itTarget } from "../common/harness.js";

const T = itTarget();

/** BGE-small-en-v1.5, the model the integration server loads. */
const DIM = 384;

/** A normalized constant vector — a valid unit embedding of `dim` floats. */
function unitVector(dim = DIM): number[] {
  return new Array<number>(dim).fill(1 / Math.sqrt(dim));
}

function request(
  fingerprint: WireUuid,
  vector: number[],
  label: string,
): EncodeVectorDirectRequest {
  return {
    text: `${label} ${Math.random()}`,
    vector,
    modelFingerprint: fingerprint,
    sessionId: 0n,
    kind: MemoryKindWire.Episodic,
    salienceHint: 0.5,
    edges: [],
    requestId: newId(),
    txnId: null,
    deduplicate: false,
  };
}

describe.skipIf(T === null)("encode_vector_direct (integration)", () => {
  const t = T!;

  /**
   * The server's embedding-model fingerprint. A direct-vector write must carry
   * it, so the server knows the pre-computed vector came from the same model it
   * would have used. A normal ENCODE response reports it, so learn it rather
   * than hard-coding a value that changes with the model.
   */
  async function fingerprint(): Promise<WireUuid> {
    const { client } = await connectFresh(t);
    try {
      const probe = await client.encode(new EncodeBuilder("fingerprint probe").build());
      return probe.embeddingModelFp;
    } finally {
      await client.close();
    }
  }

  it("round-trips a client-supplied vector", async () => {
    const fp = await fingerprint();
    const { client } = await connectFresh(t);
    try {
      const resp = await client.encodeVectorDirect(
        request(fp, unitVector(), "client-supplied vector"),
      );
      // Same durability contract as ENCODE: a returned response is WAL-durable.
      expect(resp.lsn > 0n, "a direct-vector encode assigns a durable LSN").toBe(true);
      expect(resp.memoryId, "the write must come back with a memory id").toBeDefined();
    } finally {
      await client.close();
    }
  });

  // The server counts the f32s in the raw section and objects to a wrong one.
  // On its own this does not prove the trailer is well-framed — a dropped
  // trailer is zero floats, which is also wrong. What it establishes is that
  // the server is checking, which is what makes the accepting case meaningful.
  it.each([
    [DIM - 1, "one short"],
    [DIM + 1, "one long"],
    [8, "way off"],
  ])("rejects a %i-float vector (%s)", async (dim) => {
    const fp = await fingerprint();
    const { client } = await connectFresh(t);
    try {
      const err = await client
        .encodeVectorDirect(request(fp, unitVector(dim), `dim ${dim}`))
        .catch((e) => e);
      expect(String(err), `expected a dimension complaint for ${dim} floats`).toContain(
        "dimension",
      );
    } finally {
      await client.close();
    }
  });

  it("rejects a byte-swapped vector", async () => {
    // Pins little-endian byte order. Three independent implementations write
    // these bytes, endianness is the classic thing to get quietly wrong, and a
    // byte-swapped trailer still has the right element count so the dimension
    // check sails past it. The server also requires a roughly unit-magnitude
    // vector, and a unit vector read in the wrong byte order is nowhere near
    // unit — magnitude is what catches it.
    const fp = await fingerprint();
    const { client } = await connectFresh(t);
    try {
      const buf = new DataView(new ArrayBuffer(4));
      const swapped = unitVector().map((x) => {
        buf.setFloat32(0, x, false); // write big-endian
        return buf.getFloat32(0, true); // read little-endian
      });
      const err = await client
        .encodeVectorDirect(request(fp, swapped, "byte-swapped"))
        .catch((e) => e);
      expect(String(err), "the server must reject a mis-ordered vector").toContain("vector");
    } finally {
      await client.close();
    }
  });

  it("rejects a wrong model fingerprint", async () => {
    // The companion proof, for the CBOR half of the payload. That this check
    // fires confirms the CBOR map is read alongside the raw trailer, rather
    // than the payload being treated as one undivided blob.
    const { client } = await connectFresh(t);
    try {
      const err = await client
        .encodeVectorDirect(request(new Uint8Array(16), unitVector(), "wrong fingerprint"))
        .catch((e) => e);
      expect(String(err), "expected a fingerprint complaint").toContain("fingerprint");
    } finally {
      await client.close();
    }
  });
});
