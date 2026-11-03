/**
 * `SDK_VERSION` must be the version that shipped.
 *
 * It was a hand-typed literal for four releases and spent three of them wrong:
 * the constant read `"0.1.0"` while the package published `0.2.0`, `0.3.1`,
 * then `0.4.0`. Nothing failed, because nothing compared them — so a
 * compatibility check, a bug report or a telemetry tag reading `SDK_VERSION`
 * got a version that had not existed for a year, and the wrongness was
 * invisible precisely to the people relying on it.
 *
 * The constant stays a literal rather than reading `package.json` at runtime.
 * Reading it would need `node:module` or a JSON import attribute, and both
 * would undo the work that makes the HTTP tier loadable off Node (see
 * `test/http-standalone`). Instead `release-please-config.json` lists
 * `typescript/src/index.ts` in `extra-files`, so a release rewrites the
 * annotated line the same way it rewrites `package.json`, and this file is
 * what fails if the two ever come apart again.
 *
 * The Python SDK fixed the identical drift in 0.4.0 by reading distribution
 * metadata. Same principle, different mechanism: take the number from the one
 * place a release bumps.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SDK_VERSION } from "../../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};

describe("SDK_VERSION", () => {
  it("is the version this package publishes", () => {
    expect(
      SDK_VERSION,
      "SDK_VERSION and package.json disagree. Do not edit either by hand — a release bumps both.",
    ).toBe(pkg.version);
  });

  it("carries the annotation release-please rewrites", () => {
    // Without the marker the release bumps `package.json` alone and the test
    // above starts failing on the release commit, which is the worst place to
    // find out.
    const src = readFileSync(join(ROOT, "src", "index.ts"), "utf8");
    expect(src).toMatch(/export const SDK_VERSION = "[^"]+"; \/\/ x-release-please-version/);
  });

  it("is a plain semver string", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
