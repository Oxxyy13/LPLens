# LPLens

Read-only Uniswap v3 and v4 LP position inspector, built as a Manifest V3
Chrome extension. Paste any address; it reads positions straight off-chain.

**Nothing is signed and no wallet is connected.** LPLens has no signing code and
no wallet capability of any kind. It never asks for a seed phrase, a private
key, or a wallet connection, and it cannot move a token even if you wanted it
to. See [Security](#security) for how that is enforced rather than promised.

## Status: 0.26.1 — invite-only beta

The extension is complete and in daily use, but access is currently gated:
`lib/license.js` has `GATING_ENABLED = true`, and **there is no trial**, so a
link on its own grants nothing. A key is validated against a Cloudflare Worker
whose registry is `SHA-256 hash -> { label, expires }`. The source of that
Worker is in this repo at `tools/licence-worker/worker.js`, so you can see for
yourself that it stores hashes rather than keys, and that the only thing it ever
receives is the key you were given. It is not told which addresses you look up.

This is access control for a private beta, not a paywall. Everything LPLens
computes, it computes locally on your machine.

## Verify this yourself

This repo is published so you do not have to take any of the above on trust.
The shipped build is **byte-identical to this source** — there is no bundler, no
minifier, and no build step that could introduce anything:

```bash
node tools/package.mjs          # produces build/lplens-<version>/ and a zip
diff -r extension build/lplens-0.26.1
```

That diff is empty. `tools/package.mjs` also refuses to produce a package if it
finds anything credential-shaped in the output, and aborts outright if anyone
reintroduces a hardcoded key into `extension/lib/chains.js`.

Two claims worth checking directly, because they are the ones that matter:

- **The complete set of JSON-RPC methods** is declared in `extension/lib/rpc.js`
  as a frozen allowlist, and `rpcCall()` throws on anything not in it. It is
  `eth_call`, `eth_getLogs`, `eth_getBlockByNumber` — three reads. There is no
  code path that can issue `eth_sendTransaction` or `personal_sign`.
- **The permissions** are in `extension/manifest.json`: `storage` and
  `scripting`, plus network access to a named list of RPC and price hosts. No
  `tabs`, no `cookies`, no `webRequest`, no `<all_urls>`. Note that
  `app.uniswap.org` appears under `optional_host_permissions`, not
  `host_permissions` — LPLens ships with **no** access to Uniswap and cannot
  read that site unless you explicitly grant it.

## What it does

- Enumerates v3 position NFTs via `balanceOf` + `tokenOfOwnerByIndex`
  (NFPM is ERC721Enumerable, so no `eth_getLogs` block-range limits)
- Reads `positions(tokenId)`, resolves the pool via the factory, reads `slot0`
- Computes token composition and in/below/above-range status from tick math
- Reads collectable amounts via an `eth_call` staticcall of `collect()`
- Best-effort USD marks from DexScreener; **unpriced legs render "unpriced",
  never `$0`**
- Reconstructs **lifetime history** from NFPM events — `tokenId` is the first
  indexed parameter of `IncreaseLiquidity`/`DecreaseLiquidity`/`Collect`, so one
  `eth_getLogs` per position returns its whole life with no subgraph and no key
- Refreshes a changed v3 history with the latest raw-RPC logs as well as the
  lifetime index, so an explorer that has not indexed a just-mined collect/add/
  remove cannot be cached as the new truth
- Values **every liquidity addition at its own block and pool price**. A second
  add is not silently priced at the original mint anymore
- Values every **Collect** when it left the LP. Claiming, partially removing,
  and then reusing those tokens in another NFT no longer counts them as both
  still held and newly deposited
- Solves **entry and exit price** from the event amounts plus the tick range,
  with no archive node, cross-checked by two independent derivations
- Scans Ethereum, Base, Arbitrum, Polygon and Robinhood Chain (4663) together;
  every card names its chain, and its wallet when several are saved
- Saves multiple addresses locally with optional labels, and can total them.
  Saved addresses live in `chrome.storage.local` and never leave the machine
- **Uniswap v4** as well as v3. v4 needed four separate mechanisms: pools are
  addressed by `keccak256(abi.encode(PoolKey))` rather than existing as
  contracts (hence `lib/keccak.js`), the PositionManager is *not*
  ERC721Enumerable so holdings come from verified Alchemy NFT ownership when a
  matching custom RPC is configured, or `Transfer` logs otherwise; state is
  read through StateView, and a currency may be native `address(0)` with no
  ERC-20 to query.
  Two independent cross-checks guard it: the derived poolId's top 200 bits must
  match the truncated id v4 stores in `PositionInfo`, and StateView's liquidity
  must equal the PositionManager's.

## The two LP performance numbers

They answer different questions, so LPLens keeps them separate:

- **vs holding** — did LPing beat simply holding the deposit? Fees minus
  impermanent loss, both baskets valued at one price. Exact, no USD needed.
- **LP return** — what the LP strategy made. Current position plus claimable
  amounts, plus collections valued when they left the LP, minus every addition
  valued when it entered.

The second is cash-flow accounting, not wallet tax basis. `gross added` is the
fair value of each LP contribution at its own block; it is not the average price
the wallet originally paid to acquire those tokens. Reconstructing acquisition
lots would require the wallet's swaps, transfers and a chosen lot method, and is
deliberately a separate future ledger.

Event-time valuation is what makes rebalancing behave. A partial remove stays
inside `claimable` until Collect transfers it out. At Collect, the same value
moves to `cash returned`. If it is deposited into another NFT, that new addition
is a new negative cash flow, so the two flows offset at portfolio level. The old
formula marked every historical collection at today's price as though it were
still held, which double-counted recycled capital.

Historical dollars come from chain state, not from applying today's rate
backwards. A USDC/WETH pool's `slot0` at a historical block supplies the dollar
price of ETH; the position event or its own historical `slot0` supplies the pair
price. A collection paired with DecreaseLiquidity in one transaction uses that
decrease's exact price. Fee-only collections fall back to archival `slot0`.
When an exact required price is unavailable, LP return is withheld rather than
turning a bound into a point-looking percentage.

**Chains with no stablecoin** are priced through the chain their asset was
bridged from. Robinhood Chain's WETH trades against thirty memecoins and nothing
dollar-denominated, so there is no local pool to read a dollar price from — but
that WETH is bridged, so the price exists on Ethereum. The local block maps to
its timestamp, the timestamp to an Ethereum block, and the reference pool is
read there. Still no price API: a block-timestamp lookup is a chain fact.

That path carries one assumption the same-chain path does not — that the bridged
token holds its peg. Arbitrage makes it reliable, but it is an assumption rather
than a derivation, so those results are flagged `bridged`.

Still refused: pairs with no leg in WETH or the stablecoin, which would need a
hop through a pool that may not exist. Those report unavailable.

Entry price comes out of the event alone. For a two-sided mint, the two sides
each solve for the same square-root price, so the pair is a self-check rather
than one unverified number — measured agreement is 0.000000% across six
positions, and any disagreement is printed as a band instead of being averaged
away. A single-sided mint is underdetermined from its event alone. A direct WETH
or stablecoin leg, or an archival position-pool read, can still make its dollar
flow exact. Otherwise it renders as a bound and LP return is withheld.

## Install

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder — but read
   [the one real risk](#the-one-real-risk-never-load-unpacked-from-a-synced-or-shared-folder)
   first
5. Pin LPLens, click it, paste an address, hit **Load positions**

No build step, no `npm install`, no bundler. After editing any file, hit the
refresh icon on the extension card.

Optional, in **Options → Advanced**: your own per-chain RPC URLs and an
Etherscan API key. Both are optional — LPLens is keyless by default — and both
are stored in `chrome.storage.local` inside your browser profile. Nothing is
ever written back to this repo.

Two addresses with live mainnet positions, useful for a smoke test:

- `0xc1dc7b8d019275250b1fd8cf6ede1c36db5599e6` — one open WXRP/WETH position
- `0xfd235968e65b0990584585763f837a5b5330e6de` — 664 positions, exercises the
  scan cap and the unpriced-token path

## Security

**Cannot touch your wallet.** There is no signing code and no wallet capability
of any kind — no `eth_sendTransaction`, no `personal_sign`, no
`eth_requestAccounts`, no `window.ethereum`. Every JSON-RPC method it issues is
a read: `eth_call`, `eth_getLogs`, and `eth_getBlockByNumber` (used once, to map
a block to its timestamp for cross-chain pricing). That list is not a promise in
a document — it is a frozen allowlist in `lib/rpc.js` that every call is checked
against, and an unlisted method throws. Chrome also isolates extensions from
each other, so LPLens cannot reach MetaMask's storage or keys even in principle.

**Cannot see your browsing.** No `tabs`, no `activeTab`, no `cookies`, no
`webRequest`, no `<all_urls>`.

**The Uniswap overlay is opt-in and off by default.** `app.uniswap.org` is in
`optional_host_permissions`, not `host_permissions`, so a freshly installed
LPLens has no access to that site at all. Only if you turn the overlay on does
the service worker call `chrome.scripting.registerContentScripts` with
`matches: ['https://app.uniswap.org/positions/*']` — see
`extension/sw.js` — and turning it off unregisters it again.

Once granted, that is a real widening of the surface, and it is worth
understanding rather than skimming:

- The content script is **append-only**. It adds a single node and never reads,
  moves, or rewrites anything Uniswap rendered, so it cannot change what you
  are shown before you sign.
- It runs in Chrome's **isolated world**, so `window.ethereum`, the page's
  JavaScript, and the wallet are unreachable from it by construction — not by
  good behaviour.
- It has **no network access**. MV3 stripped cross-origin privileges from
  content scripts, so every RPC call happens in the service worker and the
  overlay only ever receives finished data.
- It renders into a **closed shadow root** with constructed stylesheets, so the
  page cannot reach into it and its styles cannot leak out.

This makes the "never load unpacked from a shared folder" rule below **more**
important, not less: the code runs on a page where transactions get approved.

**No supply chain.** Zero dependencies, no `node_modules`, no CDN, no remote
code, no build step. Most extension compromises arrive through a dependency or
an auto-updating remote script; there is nothing here to compromise.

**No credentials in this repo.** LPLens's only key store is
`chrome.storage.local`, written by the options page, inside your browser
profile. `tools/package.mjs` scans every packaged file for credential-shaped
strings and aborts the build on a hit.

**Hostile token names are neutralized.** `symbol()` is attacker-controlled —
any ERC-20 can name itself with an HTML payload, and position lists are rendered
with `innerHTML`. Every symbol is escaped, and escaped output lands only in
text-node context, never inside an attribute, so no element or handler can be
constructed. Verified against five injection payloads. MV3's default CSP
(`script-src 'self'`) blocks inline handlers as a second layer.

**Privacy, not security:** the address you paste is sent to the RPC endpoint and
to DexScreener, which learn that your IP is interested in that address. Point
the options page at your own RPC to reduce that. Saved addresses are stored with
`chrome.storage.local`, deliberately **not** `chrome.storage.sync`, so they are
never carried into a Google account.

### The one real risk: never load unpacked from a synced or shared folder

An unpacked extension is read from disk every time Chrome starts, with no
signature and no review. **Anything that can write to that folder is writing
code Chrome will execute** with this extension's host permissions — including a
sync client, a file-sharing tool, a sync conflict, or another machine.

If you edit LPLens inside a synced folder (Dropbox, iCloud, Syncthing, a network
share), keep that as your editing copy and load Chrome from a local, unsynced
one:

```bash
# macOS / Linux
rsync -a --delete ./extension/ "$HOME/.local/share/LPLens/extension/"
```

```powershell
# Windows
robocopy .\extension "$env:LOCALAPPDATA\LPLens\extension" /MIR
```

Then Load unpacked from the local copy, and re-run the copy after edits. This
applies to any unpacked extension, not just this one.

## Known limits

- `MAX_POSITIONS = 1000` per address per chain. Every ownership index below the
  guard and every corresponding `positions()` record is read on every load.
  There is no ownership cache and no early stop on closed positions: an
  ERC721Enumerable swap-and-pop can change the middle of a list without
  changing either its count or newest token, and an old closed NFT can be
  revived with `increaseLiquidity`. Each unreadable ownership/position record
  and anything beyond the guard is named in the status line.
- **Anything held but not rendered is named in the status line**, per wallet and
  per chain. Closed-but-owned NFTs are distinguished from failed reads. A live
  Base wallet that previously read `230 v4 unreadable` now enumerates all 230
  through its configured Alchemy NFT index, verifies every candidate with
  `ownerOf` plus `balanceOf`, and reports `230 closed v4 hidden` because their
  on-chain liquidity is actually zero. The Transfer-log route remains the
  keyless fallback.
- Lifetime history needs a log source that will serve a full-range,
  topic-filtered query. The measured landscape as of 2026-08-19:
  - **Robinhood Chain's public RPC serves it keylessly.** Nothing to configure.
  - **No public Ethereum RPC does.** Verified refusals from `eth.drpc.org`
    (10k blocks), `ethereum-rpc.publicnode.com` (archive needs a token),
    `rpc.ankr.com` (key), `rpc.mevblocker.io` (10k), `eth-pokt.nodies.app`,
    `rpc.flashbots.net` (pruned), `cloudflare-eth.com`, `eth.merkle.io`.
  - **Alchemy's free tier caps `eth_getLogs` at a 10-block range**, so a free
    Alchemy key does *not* enable lifetime history — 25M blocks at 10 per
    request is a different order of magnitude, not a rate-limit problem. PAYG
    lifts it.
    Alchemy free *does* serve archive `eth_call`, which is a usable general RPC,
    and the NFT ownership endpoint enables verified v4 enumeration.
  - **Etherscan's V2 API serves it on the free tier for most chains**, 100k
    calls/day, and `topic1`-only filtering is accepted — so one call returns a
    position's whole lifetime. Put a key from etherscan.io/apis in the options
    page if you want it; it is optional.
  - **Base (8453) is no longer on that free tier.** Etherscan cut free coverage
    to roughly 90% of chain IDs; a free key answers a full-range Base log query
    by refusing and pointing at a paid plan. Measured 2026-08-19 against the v3
    NFPM with a topic1 filter: Ethereum (1), Arbitrum (42161) and Polygon (137)
    all return the full lifetime on a free key; Base does not.
  - **Blockscout serves it keylessly, so no paid plan is needed.**
    `eth`/`base`/`arbitrum`/`polygon.blockscout.com` answer the same
    Etherscan-compatible full-range `topic1` query with no key at all. Verified
    against Etherscan on the same positions: Ethereum 961877 returns the
    identical 4 events from both. The Etherscan key is **optional everywhere**
    — it is tried first when configured, because it is faster and more
    complete, and Blockscout picks up when it is absent or refuses.
  - **But an empty Blockscout answer cannot be trusted, and LPLens encodes
    that.** `polygon.blockscout.com` silently misses positions below roughly
    tokenId 1.2M — measured, Etherscan returns 3 events for tokenIds 100000 /
    400000 / 700000 / 1000000 where Blockscout returns "No logs found", and both
    agree exactly at 1400000 and above. That reply is indistinguishable from a
    genuinely empty position, so LPLens treats **zero lifetime logs as a source
    failure**: a minted position always has at least one `IncreaseLiquidity`, so
    an empty result means an incomplete index, never an empty lifetime. It falls
    through to the next source and reports history unavailable if every source
    yields nothing. Empty results are never cached.
  - Base's Blockscout instance rate-limits aggressively (HTTP 429, roughly 10
    requests per window), so Base history can throttle on a large scan. It
    degrades to "unavailable", never to a wrong number.
- Tick ratios use `1.0001^(tick/2)` in doubles — display-grade. Swap in
  `@uniswap/v3-sdk` TickMath before this ever produces calldata.
- `collect()` staticcall returns fees **plus** any principal pending after a
  `decreaseLiquidity`. Labelled "collectable", never "fees earned". Lifetime
  fees are computed as collected + currently collectable - all decreased
  principal, so a pending partial withdrawal cannot erase old fees or count its
  principal as new fees. If the staticcall fails, return/PnL is withheld rather
  than treating the unknown amount as zero.
- DexScreener misses long-tail tokens; those render "unpriced". Marks are
  guarded by chain and by pool depth, and both guards matter: DexScreener
  returns pairs across every chain it indexes, and querying Ethereum WETH
  returns six **PulseChain** pairs before the real ones. Taking the first pair
  marked WETH at `$0.0000122` instead of `$1,932.99` was a live defect until
  0.12.0. A token whose materially liquid pools disagree by more than 25% is
  left unpriced rather than marked at a number nobody can stand behind.
- **v4 lifetime history is not implemented.** Current v4 ownership, liquidity,
  composition and collectable fees refresh from chain state, but adds/removes/
  claims are not reconstructed as lifetime token flows. v4 emits
  `ModifyLiquidity` from the PoolManager keyed by poolId and salt, not per
  tokenId, so the
  one-query-per-position approach that makes v3 history cheap does not carry
  over. v4 positions report history as unavailable rather than showing a
  partial one.
- A custom RPC URL only works if that endpoint sends permissive CORS headers.
  Alchemy/Infura/dRPC do; a bare self-hosted node will fail with an opaque fetch
  error. Built-in endpoints are covered by `host_permissions` and are unaffected.

## Layout

```
extension/
  manifest.json      MV3, minimum permissions
  popup.*            UI
  options.*          optional custom RPCs and Etherscan key, data disclosure
  render.js          shared renderer, used by both the popup and the overlay
  lib/chains.js      NFPM/factory/RPC per chain — no credentials, ever
  lib/abi.js         hand-rolled encode/decode, keccak-verified selectors
  lib/rpc.js         JSON-RPC, bounded concurrency, and the method allowlist
  lib/v3.js          tick math
  lib/v4.js          Uniswap v4: poolId derivation, StateView reads, fees
  lib/keccak.js      Keccak-256 (v4 poolId); vector-verified, not SHA3
  lib/positions.js   orchestration and valuation
  lib/history.js     lifetime events, entry/exit solve, token-denominated PnL
  lib/histprice.js   USD at any block, from a reference pool via archive eth_call
  lib/logs.js        log retrieval; Etherscan V2, Blockscout, or eth_getLogs
  lib/cache.js       bounded persistent caches
  lib/wallets.js     saved addresses; chrome.storage.local only, never sync
  lib/aggregate.js   all-wallets totals, with explicit exclusion reporting
  lib/license.js     beta access gate
  overlay.js         app.uniswap.org content script — append-only, URL-anchored
  sw.js              service worker; holds all network access for the overlay
tools/
  package.mjs        builds the distributable zip; refuses to ship a credential
  make-icons.mjs     generates the extension icons
  licence-worker/    Cloudflare Worker validating beta keys by SHA-256 hash
```
