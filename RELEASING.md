# Releasing the SDKs

All three packages publish together from one git tag via
`.github/workflows/release.yml`.

| Language   | Package          | Registry  |
|------------|------------------|-----------|
| Rust       | `brain-db-sdk`   | crates.io |
| Python     | `brain-db-sdk`   | PyPI      |
| TypeScript | `@brain-db/sdk`  | npm       |

## One-time setup (repo owner)
Add these in **Settings → Secrets and variables → Actions**:
- `CARGO_REGISTRY_TOKEN` — crates.io API token (scope: *publish-update*).
- `PYPI_API_TOKEN` — PyPI API token (or migrate to Trusted Publishing).
- `NPM_TOKEN` — npm automation token (the package is scoped + public;
  `publishConfig.access = public` is already set).

Optional safety: **Settings → Environments → `release`** → add required
reviewers, so each publish waits for a manual approval after the tag push.

## Cutting a release
1. Bump the version in **all three** package manifests to the same value:
   - `rust/Cargo.toml`        → `version = "X.Y.Z"`
   - `python/pyproject.toml`  → `version = "X.Y.Z"`
   - `typescript/package.json`→ `"version": "X.Y.Z"`
   (and run `npm install` in `typescript/` so `package-lock.json` updates.)
2. Commit on `main`, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
3. The Release workflow verifies each manifest's version equals the tag,
   runs the tests, and publishes. Mismatched versions fail fast (nothing
   is published). Re-running after a partial success skips packages whose
   version is already on the registry (registries reject duplicate versions).

## Local pre-flight (optional, no registry needed)
```bash
( cd rust && cargo package )                       # builds the publishable crate
( cd python && python -m build )                   # sdist + wheel
( cd typescript && npm run build && npm pack --dry-run )
```
