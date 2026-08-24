# Contributing to LPLens

Bug reports, reproducible accounting cases, provider compatibility findings,
and focused code improvements are welcome.

## Before opening an issue

- Use the latest Chrome Web Store or tagged GitHub release.
- Remove access codes, provider keys, private RPC URLs, and unrelated personal
  information.
- Include the chain, public transaction or position identifier, expected result,
  actual result, and LPLens version when relevant.
- Send security vulnerabilities privately according to `SECURITY.md`.

## Pull requests

- Keep changes narrowly scoped and explain the user-visible outcome.
- Preserve fail-closed accounting: missing evidence must produce an explicit
  unavailable result, never a plausible estimate presented as exact.
- Add or update a deterministic regression for behavioral changes.
- Render UI changes through `docs/design/popup-live.html`; syntax checks alone
  are not UI verification.
- Never commit credentials. `node tools/check-repo-secrets.mjs` must pass.
- Run the relevant tests and `node tools/package.mjs` before requesting review.
- `extension/` and `build/lplens-<version>/` must remain byte-identical.

By submitting a contribution, you confirm that you have the right to provide it
and agree that it will be distributed under the repository's PolyForm Shield
License 1.0.0. Contributions do not grant permission to use LPLens to provide a
competing product or service.
