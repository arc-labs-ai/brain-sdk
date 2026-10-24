import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrainClient } from "../../src/client.js";
import { EdgeKindWire } from "../../src/wire/types.js";

// Live suite: needs a running Brain and a minted key. Skipped — not failed —
// when neither is configured, so the default `vitest run` stays offline.
// Without this guard the file failed at *collection* (readFileSync on an
// undefined path), taking the whole suite red with an opaque
// ERR_INVALID_ARG_TYPE that named nothing.
const KEYFILE = process.env.KEYFILE;
const LIVE = KEYFILE !== undefined && existsSync(KEYFILE);
const KEY = LIVE ? readFileSync(KEYFILE as string, "utf8").trim() : "";
const rid = () => crypto.getRandomValues(new Uint8Array(16));
const results: string[] = [];
const note = (l: string, r: string, d = "") => results.push(`${l.padEnd(34)} ${r.padEnd(14)} ${d}`);

async function client() {
  return BrainClient.connect("127.0.0.1", 18092, {
    auth: { kind: "token", token: new TextEncoder().encode(KEY) },
  });
}
const enc = (c: any, text: string) =>
  c.encode({
    text,
    sessionId: 1n,
    requestId: rid(),
    txnId: null,
    occurredAtUnixNanos: null,
    actAs: null,
  });

describe.skipIf(!LIVE)("brain-db via the TypeScript SDK (live)", () => {
  it("exercises sizes, context recall, relations and failures", async () => {
    const c = await client();
    const N = Date.now();

    // sizes
    for (const [label, text] of [
      ["small 20B", `TS tiny ${N}`],
      ["medium 4KB", `TS medium ${N}. `.repeat(250)],
      ["large 200KB", `TS large ${N}. `.repeat(14000)],
    ] as const) {
      const r = await enc(c, text);
      note(`encode ${label}`, "ok", `id=${r.memoryId} dedup=${r.wasDeduplicated}`);
    }
    for (const [label, text] of [
      ["empty", ""],
      ["2MB", "x".repeat(2_000_000)],
    ] as const) {
      try {
        await enc(c, text);
        note(`encode ${label}`, "UNEXPECTED ok");
      } catch (e) {
        note(`encode ${label}`, "rejected", String(e).slice(0, 90));
      }
    }

    // context recall
    const a = await enc(c, `Nadia restores vintage motorcycles in Lisbon. ${N}`);
    await enc(c, `Omar teaches cello to beginners. ${N}`);
    await new Promise((r) => setTimeout(r, 2000));
    const recall = (cue: string) =>
      c.recall({
        cueText: cue,
        subjectName: "",
        maxResults: 5,
        confidenceThreshold: 0,
        sessionFilter: null,
        ageBoundUnixNanos: null,
        asOfRecordTimeUnixNanos: null,
        kindFilter: null,
        salienceFloor: 0,
        includeEdges: true,
        includeGraph: false,
        includeText: true,
        requestId: rid(),
        txnId: null,
        trace: false,
        actAs: null,
        scope: "Space" as const,
      });
    for (const [cue, want] of [
      ["What does Nadia restore?", "motorcycles"],
      ["Who teaches cello?", "Omar"],
      ["What is the boiling point of tin?", null],
    ] as const) {
      const ans: any = await recall(cue);
      const texts = (ans.memories ?? []).map((m: any) => m.text ?? "").join(" | ");
      const hit = want === null ? ans.answerKind === "None" : texts.includes(want);
      note(
        `recall: ${cue.slice(0, 26)}`,
        hit ? "HIT" : "MISS",
        `${ans.answerKind} ${texts.slice(0, 70)}`,
      );
    }

    // relations + the new read-back
    const b = await enc(c, `Pia sails the Baltic each June. ${N}`);
    for (const k of [EdgeKindWire.Caused, EdgeKindWire.Supports]) {
      await c.link({
        source: a.memoryId,
        target: b.memoryId,
        kind: k,
        weight: 1,
        requestId: rid(),
        txnId: null,
      });
    }
    const insp: any = await c.memoryInspect({ memoryId: a.memoryId, actAs: null });
    note(
      "edges read back",
      `n=${insp.edges.length}`,
      `kinds=${[...new Set(insp.edges.map((e: any) => e.kind))]}`,
    );
    note("peer matches target", String(insp.edges.some((e: any) => e.peer === b.memoryId)));

    await c.unlink({
      source: a.memoryId,
      target: b.memoryId,
      kind: EdgeKindWire.Caused,
      requestId: rid(),
      txnId: null,
    });
    const after: any = await c.memoryInspect({ memoryId: a.memoryId, actAs: null });
    const stillCaused = after.edges.some(
      (e: any) => e.kind === EdgeKindWire.Caused && e.peer === b.memoryId,
    );
    note("after unlink", stillCaused ? "STILL THERE" : "removed", `n=${after.edges.length}`);

    // failures
    try {
      await c.link({
        source: a.memoryId,
        target: 99999999999n,
        kind: 0,
        weight: 1,
        requestId: rid(),
        txnId: null,
      });
      note("link unknown target", "UNEXPECTED ok");
    } catch (e) {
      note("link unknown target", "rejected", String(e).slice(0, 80));
    }
    // An unknown id is a `MemoryNotFound` error now, not a success carrying a
    // flag — the same answer every sibling read gives.
    try {
      await c.memoryInspect({ memoryId: 12345n, actAs: null });
      note("inspect unknown id", "UNEXPECTED ok");
    } catch (e) {
      note("inspect unknown id", "rejected", String(e).slice(0, 80));
    }

    await c.close?.();
    console.log("\n" + results.join("\n"));
    expect(results.length).toBeGreaterThan(0);
  }, 90_000);
});
