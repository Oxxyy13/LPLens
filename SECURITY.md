# LPLens security and verification

LPLens is a read-only browser extension. It does not connect a wallet, request
an account, ask for a signature, or submit a transaction. This document explains
how to verify those claims and how to report a security problem privately.

## Official distribution

- Chrome Web Store item:
  <https://chromewebstore.google.com/detail/fkddococbokkhmkagkljibomgpckgdkl>
- Extension ID: `fkddococbokkhmkagkljibomgpckgdkl`
- Public source: <https://github.com/Oxxyy13/LPLens>
- Immutable source and package snapshots:
  <https://github.com/Oxxyy13/LPLens/releases>

Treat a package using another extension ID or distributed from another account
as unofficial. The Chrome Web Store and this repository are the only official
distribution points.

## Wallet boundary

The extension has no wallet-provider or signing integration. It does not call
`eth_requestAccounts`, `eth_sendTransaction`, `personal_sign`, or
`window.ethereum`. Every JSON-RPC request passes through the frozen
`RPC_METHODS` allowlist in `extension/lib/rpc.js`, which permits only:

- `eth_call`
- `eth_getLogs`
- `eth_getBlockByNumber`
- `eth_getTransactionReceipt`

The optional Uniswap, ProjectX, and Dexscreener page scripts run in Chrome's
isolated world. Their site permissions are separately granted, off at install,
and revocable. None can access another extension's storage or wallet keys.

## Permissions and data flow

The complete permission list is in `extension/manifest.json`. LPLens requests
`storage`, `scripting`, and `sidePanel`, plus named hosts used for public-chain
RPC reads, public explorer history, token-price marks, and the LPLens
access/history service. `sidePanel` provides a browser-managed extension page;
it does not grant access to the active tab or its content. LPLens does not
request `tabs`, `cookies`, `webRequest`, or `<all_urls>`.

Addresses, contract filters, token IDs, and transaction hashes are public chain
identifiers. Providers necessarily receive the identifiers needed for a query
and ordinary HTTPS metadata. Wallet addresses and completed portfolio results
are not stored by the LPLens service. The access service stores hashes of issued
access codes and random installation identifiers plus operational request
counts. See the live policy for the complete disclosure:
<https://lplens-beta.licence-worker.workers.dev/privacy>.

When enabled in Settings, anonymous scan telemetry is limited to extension
version, popup or side-panel surface, coarse outcome/count/duration buckets,
and allowlisted per-chain error categories. Those aggregate database rows have
no access-code hash, installation hash, wallet, token, pool, position, custom
endpoint, provider key, or raw error. The local Copy diagnostics report follows
the same exclusion boundary and leaves the browser only by explicit user action.

## Reproduce the Store package

Each release identifies the exact source commit, Store ZIP, size, and SHA-256
digest. There is no bundler or minifier: the packaged extension tree must be
byte-identical to `extension/`.

```bash
git checkout v0.30.0
node tools/check-repo-secrets.mjs
node tools/package.mjs
diff -r extension build/lplens-0.30.0
```

The final `diff` must print nothing. `tools/package.mjs` also parses every
JavaScript file, runs a live public-history probe, and aborts if it detects a
credential-shaped value or a development-key fence.

## Secrets

Provider credentials never belong in `extension/`, a release ZIP, an issue, or
a pull request. Hosted provider keys are Cloudflare secrets. Developer copies
may exist in a gitignored, machine-local `.env` only; release tooling compares
every such value against every publishable text file before packaging.

If you accidentally expose an access code or provider credential, revoke it
before reporting the incident.

## Report a vulnerability

Email `oxxyy13@gmail.com` with the subject `LPLens security report`. Include the
affected version, impact, reproduction steps, and any suggested mitigation. Do
not put a working exploit, access code, provider credential, or private user
information in a public GitHub issue.

Ordinary bugs and accounting discrepancies can use GitHub Issues. A specific
`unavailable` result is normally LPLens failing closed because it could not
prove a required chain fact; it should still be reported if the data ought to
be available.

The latest Chrome Web Store version and latest tagged GitHub release receive
security fixes during the invite-only beta.
