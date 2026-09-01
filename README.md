# LPLens

Read-only concentrated-liquidity position inspector for Uniswap, ProjectX, and UP33,
built as a Manifest V3 Chrome extension. Paste any address; it reads positions
straight off-chain.

**Nothing is signed and no wallet is connected.** LPLens has no signing code and
no wallet capability of any kind. It never asks for a seed phrase, a private
key, or a wallet connection, and it cannot move a token even if you wanted it
to. See [Security](#security) for how that is enforced rather than promised.

**Official distribution:** [Chrome Web Store](https://chromewebstore.google.com/detail/fkddococbokkhmkagkljibomgpckgdkl)
· [immutable releases](https://github.com/Oxxyy13/LPLens/releases)
· extension ID `fkddococbokkhmkagkljibomgpckgdkl`

## Publicly auditable, source-available

The exact extension source is public so users can inspect every permission,
network request, and read-only RPC method, then reproduce the Store package.
LPLens is **source-available, not open source**. It uses the standardized
[PolyForm Shield License 1.0.0](LICENSE.md): inspection, testing, modification,
and sharing are allowed for noncompeting purposes, but the code may not be used
to provide a free or paid product or service that competes with LPLens.

See [SECURITY.md](SECURITY.md) for the official extension identity, data-flow
boundary, reproducible-build steps, and private vulnerability-reporting route.
See [CONTRIBUTING.md](CONTRIBUTING.md) for public bug reports and changes.

## Status: 0.33.0 development candidate

The public Store release remains 0.30.0 while the fast-refresh, v4
ownership-checkpoint, refresh-delta, verified replacement, and UP33 changes below are
tested locally. Do not upload 0.33.0 until the deterministic suite, rendered
harness, machine-local dev mirror, and real-wallet smoke tests all pass.

Version 0.33 adds UP33 concentrated-liquidity positions on Robinhood Chain as a
separate protocol deployment, so equal NFT numbers from different managers can
never collide. It reads direct wallet custody and gauge custody, dynamic pool
fees, current range and token amounts, and pending UP emissions. A pending
reward is the sum of the gauge's stored checkpoint and newly earned amount.
For a direct UP33 NFT, lifetime LP return and vs holding appear only when the
complete lifecycle and exact-token Transfer histories prove one mint directly
to the same wallet, with the first liquidity addition in that mint transaction.
If the NFT is currently staked, was ever staked or transferred, or either
history is incomplete or inconsistent, those metrics are withheld. Pending UP
emissions remain separate from LP return. A staked position's active-liquidity
mark is also labeled incomplete and excluded from portfolio-value totals
because the gauge does not expose the user's trading-fee balance. UP33 v2 LP
and liquidity-locker positions are not read.

The optional UP33 overlay runs only on `up33.xyz/liquidity` and descendants.
The UP33 panel uses the active overlay wallet selected in LPLens, reads positions
from public chain data, and, on the exact liquidity list, reads only each
concentrated-position row's public `data-flow="cl-<NFT ID>"` attribute, matching visible `#ID`, and row geometry so local PnL
cards can align with the matching rows. Those page-derived IDs are matched only
against the active-wallet scan; they are not sent to a network or stored. LPLens
does not read UP33 connected-wallet state, balances, forms, transaction controls,
signing prompts, its wallet provider, or other UP33 page content. The page
receives only a shortened wallet label and the narrow display fields needed for
the panel. The worker coalesces only concurrently in-flight same-wallet scans.
It does not reuse a completed UP33 custody proof, so a reload checks current
ownership again.

Dexscreener chart alignment has a separate, versioned consent control and is
off until the user enables it. Site permission alone shows the existing exact
on-chain range ruler and does not start chart measurement. While a matching
overlay is open with chart alignment enabled, the service worker repeatedly
runs a packaged, short-lived MAIN-world function so the range follows chart
movement and mode changes. Each call receives at most three unlabelled LP range
values for low, current, and high, plus public pair-conversion values. The call
receives no wallet address, token or position ID, PnL, access key, endpoint, or
provider key directly. Unlabelled does not mean anonymous: the pool and
bounds are public on-chain, so Dexscreener could correlate them with a specific
position and owner while each call runs. The function reads chart mode, the
latest public chart close once per measurement, plot geometry, and numeric price
coordinates through Dexscreener's private TradingView interface. The close stays
inside that short-lived MAIN-world call. Only validated chart mode, plot geometry,
and numeric coordinates return to LPLens's isolated overlay for the drawing; the
close is not returned. The returned result is not stored, logged, or transmitted
over the network. The function does not read or call the wallet provider and does
not change chart state. Turning chart alignment off stops the measurement and
removes the chart graphic immediately. Because the interface is private,
alignment is best effort and falls back to LPLens's own range ruler.

On Dexscreener, drag the dotted panel header to move LPLens anywhere in the
viewport. Its position is stored only in `chrome.storage.local` and is clamped
back on-screen after zoom or window-size changes. The minus control collapses
the panel to a small LPLens pill; double-clicking the header restores the default
dock. These layout preferences apply only to Dexscreener and do not change the
Uniswap, ProjectX, or UP33 overlays.

Version 0.30.0 includes the browser-managed portfolio side panel that can stay
open while the user changes
tabs. It restores the most recent rendered portfolio view immediately, then
refreshes only when the user asks. The snapshot stays in
`chrome.storage.local`, is never used as an input to calculations, and is
bounded so a large portfolio cannot exhaust extension storage. Each position's
price unit can be flipped without changing its accounting, and `vs holding`
shows both dollars and percentage when available. Unwanted or unsolicited LP
NFTs can be hidden locally from the side panel; hidden cards are excluded from
portfolio counts and totals and can be restored at any time. The normal panel
keeps only useful state such as the last refresh, a compact chain-change prompt,
or a short refresh or failure message. Routine scan fractions, empty-chain
chatter, wallet counts, position counts, and NFT identifiers stay out of the
main view. Friendly issue summaries, sanitized diagnostics, and the report link
live under `Help & diagnostics`. Portfolio scans still default to all supported
networks, but the popup and side panel expose a profile-local network checklist.
Turning off a network affects portfolio sweeps only, and the saved panel view
records its exact network scope so a changed selection is never mistaken for an
already-refreshed result. Robinhood's public RPC reads are batched in groups of
25 with item retries and a single-call fallback.

The side panel separates two manual actions. **Refresh current** verifies and
re-reads the known open position IDs from the last successful full discovery,
including live ownership, liquidity, fees, prices, and history tails. **Full
rescan** is the authoritative discovery action for new, transferred, or
reopened NFTs. A compact scope selector applies either action to the selected
wallet or every saved wallet. The current-position index is local operational
state, not rendered HTML and not an accounting input. If a Full rescan cannot
prove a wallet and chain completely, Refresh current stays disabled for that
scope until a complete Full rescan succeeds.

Version 0.32 adds consecutive-refresh context to each side-panel card. LPLens
stores one bounded, manager-scoped local sample per position and, after the next
accepted refresh, shows changes in LP return, vs holding, position value,
cumulative token-denominated fees, and range state. Deposits or collections are
called out as cash-flow changes so a larger position value is not mislabeled as
profit. Failed scans, progressive paints, hidden-card changes, and a Current
refresh that preserves the prior dashboard do not advance the baseline. Popup
scans also leave this side-panel-only comparison point unchanged.

The same version can group v3 NFTs only when the replacement is proven from a
successful transaction receipt: one fully closed and paid-out predecessor, one
successor NFT minted to the same owner, and one successor increase, with no
other position-manager lifecycle action in that transaction. The receipt and
canonical block hash are rechecked before the relationship renders. The UI
calls this a **verified same-transaction replacement**, not a rollover, because
the transaction sequence does not prove that the same fungible assets funded
the successor. Initial discovery requires a Full rescan with closed positions
included; v4 and ambiguous receipts stay unlinked.

Portfolio totals now distinguish complete, partial, and unavailable metrics.
Positive and negative return values are colored consistently, while coverage
and the exact unavailable reason remain visible in text. A missing historical
price can therefore never look like a real zero or suppress otherwise valid
current-value and vs-holding totals. Version 0.30 also adds a sanitized
Copy diagnostics control, optional anonymous aggregate scan outcomes, and a
separately optional Dexscreener pair-page overlay. Diagnostics and aggregate
events contain no wallet, token, pool, position, access-code, installation, or
raw-error values.

Access is currently gated:
`lib/license.js` has `GATING_ENABLED = true`, and **there is no trial**, so a
link on its own grants nothing. A key is validated against a Cloudflare Worker
whose registry is `SHA-256 hash -> { label, expires }`. The same Worker provides
an authenticated history relay backed by Blockscout Pro and Etherscan, so a
tester supplies no RPC or explorer key: paste the LPLens access key, paste a
wallet address, and scan. The source is
in this repo at `tools/licence-worker/worker.js`. It stores hashes of access
codes and random browser-installation identifiers plus aggregate request counts;
when enabled in Settings, it also stores anonymous daily scan outcomes and
allowlisted error-category totals in rows that have no access-code or
installation hash. It does not store wallet addresses, log filters, IP
addresses or API responses.
The relay necessarily processes each allowlisted log filter long enough to send
it to Blockscout; v4 ownership filters can contain the public address being read.
The saved access key is masked whenever Options opens and is revealed only when
the user explicitly selects **show**.

This is access control for a private beta, not a paywall. Everything LPLens
computes, it computes locally on your machine. The hosted component supplies a
protected history input; it does not receive present-state RPC reads, USD marks,
or finished portfolio figures.

## Verify this yourself

This repo is published so you do not have to take any of the above on trust.
The shipped build is **byte-identical to this source** — there is no bundler, no
minifier, and no build step that could introduce anything:

```bash
node tools/package.mjs          # produces build/lplens-<version>/ and a zip
diff -r extension build/lplens-0.33.0
```

That diff is empty on a release commit. `tools/package.mjs` also refuses to
produce a package if it finds anything credential-shaped in the output, and
aborts outright if anyone reintroduces a hardcoded key into
`extension/lib/chains.js`. It also rejects the development-fence marker used
during chart prototyping if that marker ever reappears in `extension/`.

Two claims worth checking directly, because they are the ones that matter:

- **The complete set of JSON-RPC methods** is declared in `extension/lib/rpc.js`
  as a frozen allowlist, and `rpcCall()` throws on anything not in it. It is
  `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`,
  `eth_getTransactionReceipt` — four reads. There is no
  code path that can issue `eth_sendTransaction` or `personal_sign`.
- **The permissions** are in `extension/manifest.json`: `storage`, `scripting`,
  and `sidePanel`, plus network access to a named list of RPC, price, explorer,
  and LPLens service hosts. `sidePanel` provides the persistent portfolio
  surface and does not grant access to browsing data or page content. No
  `tabs`, no `cookies`, no `webRequest`, no `<all_urls>`. Note that
  `app.uniswap.org`, `www.prjx.com`, `up33.xyz`, and `dexscreener.com` appear under
  `optional_host_permissions`, not `host_permissions` — LPLens ships with
  **no** access to any of those sites and cannot run there unless you explicitly grant
  each one.

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
  indexed log query per position returns its whole life with no subgraph. A
  licensed Blockscout Pro relay is built in; public Blockscout and RPC fallbacks
  remain fail-closed
- Refreshes a changed v3 history with the latest raw-RPC logs as well as the
  lifetime index, so an explorer that has not indexed a just-mined collect/add/
  remove cannot be cached as the new truth
- Reconstructs exact v4 entry, vs-holding, and LP return for an untouched mint
  and for multiple isolated, hookless additions. The proof matches PoolManager
  `ModifyLiquidity` salt to the token id, checks every receipt, and reads
  Blockscout's execution trace for later adds so principal and previously earned
  fees are separated before PositionManager nets them. Removes, fee-only pokes,
  hooks, and bundled actions remain unavailable rather than approximated
- Values **every liquidity addition at its own block and pool price**. A second
  add is not silently priced at the original mint anymore
- Shows each token's exact USD move in the shared popup/overlay details. A
  one-add position says `since opened`; a supported v3 or v4 multi-add history
  shows both `since first add` and `since latest add`. A capital-addition timeline
  keeps every contribution's date, token quantities, and historical USD value.
  It does not invent one weighted-average entry price that answers neither
  question
- Values every **Collect** when it left the LP. Claiming, partially removing,
  and then reusing those tokens in another NFT no longer counts them as both
  still held and newly deposited
- Solves **entry and exit price** from the event amounts plus the tick range,
  with no archive node, cross-checked by two independent derivations
- Scans Ethereum, Base, Arbitrum, Polygon, HyperEVM and Robinhood Chain (4663)
  together; HyperEVM positions are read through ProjectX;
  every card names its chain, and its wallet when several are saved
- Reads UP33 concentrated-liquidity NFTs on Robinhood Chain in direct or gauge
  custody and shows pending UP emissions separately. A never-transferred direct
  NFT can show lifetime return after its mint and liquidity histories match;
  current or historical gauge custody remains fail-closed. LPLens does not
  treat emissions as fees, LP return, vs holding, or current position value
- Saves multiple addresses locally with optional labels, and can total them.
  Saved addresses live in `chrome.storage.local` and never leave the machine
- Opens a persistent browser side panel from the popup. It can show the last
  portfolio view on any tab without reading that tab, filter cards by range or
  data status, flip every displayed position price into either token direction,
  hide or restore unwanted LP NFTs locally, and refresh either the selected
  wallet or the full local address book. A fast current-position refresh skips
  ownership discovery; Full rescan finds new, transferred, and reopened NFTs.
  Hidden cards do not contribute to portfolio counts
  or totals. Refresh is manual so simply leaving the panel open does not consume
  provider quota. The headline scan status stays short; complete chain outcomes
  and provider failures are kept in an expandable details section
- Shows `vs holding` in both dollars and percentage when history is available,
  including ProjectX positions
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

Historical dollars come from the chain at that block, not from applying today's
rate backwards. A USDC/WETH pool's price then supplies the dollar price of ETH;
the position event or its own pool price supplies the pair price. A collection
paired with DecreaseLiquidity in one transaction uses that decrease's exact
price. Fee-only collections fall back to the pool's historical price.

Those historical pool prices are read from each pool's own **`Swap` events**,
not from a historical `eth_call`. Only a swap moves `sqrtPriceX96`, so the
last `Swap` at or before a block is exactly that block's price — and log
indexes outlive pruned state, so no archive node is needed on any chain. The
`eth_call` form was removed on 2026-08-23 after one chain's public RPC was
found answering historical calls with *present-day* state instead of refusing,
which produced a confidently wrong basis.
When an exact required price is unavailable, LP return is withheld rather than
turning a bound into a point-looking percentage.

**Chains with no stablecoin** are priced through the chain their asset was
bridged from. Robinhood Chain's WETH trades against thirty memecoins and nothing
dollar-denominated, so there is no local pool to read a dollar price from — but
that WETH is bridged, so the price exists on Ethereum. The local block maps to
its timestamp, the timestamp to an Ethereum block, and the reference pool is
read there. The block lookup uses Etherscan when a configured key is available,
then public Blockscout's keyless timestamp index, with the on-chain binary
search retained only as a final fallback. The reference pool price is likewise
read from Blockscout's indexed `Swap` logs before raw RPC logs are attempted.
Still no price API: every path reads chain facts.

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
or stablecoin leg, or an exact historical position-pool `Swap` event, can still
make its dollar flow exact. Otherwise it renders as a bound and LP return is
withheld.

## Install

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder — but read
   [the one real risk](#the-one-real-risk-never-load-unpacked-from-a-synced-or-shared-folder)
   first
5. Pin LPLens, click it, paste an address, hit **Load positions**
6. Choose **Open portfolio panel** to keep the saved overview beside any tab

No build step, no `npm install`, no bundler. After editing any file, hit the
refresh icon on the extension card.

Optional, in **Options → Advanced**: your own per-chain RPC URLs and an
Etherscan API key. Both are optional — no user-supplied provider key is required — and both
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
a read: `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`, and
`eth_getTransactionReceipt` (used to prove token flow for a narrow v4 mint
case). That list is not a promise in
a document — it is a frozen allowlist in `lib/rpc.js` that every call is checked
against, and an unlisted method throws. Chrome also isolates extensions from
each other, so LPLens cannot reach MetaMask's storage or keys even in principle.

**Cannot see your general browsing.** No `tabs`, no `activeTab`, no `cookies`,
no `webRequest`, no `<all_urls>`. The only page permissions are the optional,
user-granted scopes described below.

**All on-page overlays are independently opt-in and off by default.**
`app.uniswap.org`, `www.prjx.com`, `up33.xyz`, and `dexscreener.com` are in
`optional_host_permissions`, not `host_permissions`, so a freshly installed
LPLens has no access to those sites.
The Uniswap toggle registers only the exact
`https://app.uniswap.org/positions` list and its `/positions/*` descendants.
The ProjectX toggle registers only `https://www.prjx.com/portfolio` and its
descendants. The UP33 toggle registers only `https://up33.xyz/liquidity` and its
descendants. The Dexscreener toggle registers only `https://dexscreener.com/*`;
the script acts only on a route containing a supported chain slug and a 20-byte
pool address or 32-byte v4 pool id. Turning any toggle off unregisters only that
site's content script.

Once granted, that is a real widening of the surface, and it is worth
understanding rather than skimming:

- The persistent content script is **write-isolated and append-only**. On Uniswap it reads
  the position-page URL; on the positions list it reads semantic position links
  and the first line of visible row text to discover and label positions. On
  ProjectX it reads no page content: `/portfolio` has no stable NFT links, so
  the panel uses only the active overlay wallet explicitly selected in LPLens.
  On the exact UP33 `/liquidity` list it reads only each concentrated-position
  row's public `data-flow="cl-<NFT ID>"` attribute, matching visible `#ID`, and row geometry so local PnL cards can align with
  matching rows. Those page-derived IDs are matched only against the active-wallet
  scan and are not sent to a network or stored. It does not read UP33
  connected-wallet state, balances, forms, transaction controls, signing prompts,
  wallet-provider objects, or other UP33 page content. The route also triggers a
  public Robinhood Chain read for the same active overlay wallet. Only a shortened
  wallet label and a minimized display model cross into the isolated page script.
  On Dexscreener it reads only the chain and pool identifier in the pair-page
  URL, then checks that same active wallet for a matching position. The service
  worker sends those two route values, without the wallet address, to
  `api.dexscreener.com` to retrieve the pair's base/quote token orientation.
  The popup and side panel always name the active overlay wallet;
  clicking a saved wallet selects it immediately, and scanning every saved
  wallet does not change that selection. It never
  reads balances, forms, connected-wallet state, wallet-provider objects, or
  signing prompts. Its only page writes are its own closed-shadow-root panel and
  optional range graphic; it never moves or rewrites anything either site
  rendered.
- The persistent script runs in Chrome's **isolated world**, so
  `window.ethereum`, the page's JavaScript, and the wallet are unreachable from
  that script by construction. Chart alignment is a separately disclosed and
  versioned opt-in. While a matching overlay is open, the service worker repeats
  a packaged, short-lived MAIN-world function so the graphic follows chart
  changes. Each call receives at most three unlabelled LP range values for low,
  current, and high, plus public pair-conversion values. The call receives no
  wallet address, token or position ID, PnL, access key, custom endpoint, or
  provider key directly. Unlabelled does not mean anonymous: the pool and bounds are
  public on-chain, so Dexscreener could correlate them with a specific position
  and owner while each call runs. It reads only chart mode, the latest public
  chart close once per measurement, plot geometry, and the numeric
  price-to-coordinate mapping from Dexscreener's private TradingView interface.
  Its code does not read or call a wallet provider
  and does not create drawings, change the visible range, alter autoscale, or
  otherwise change chart state. The public chart close stays inside the
  short-lived MAIN-world call. Only validated chart mode, plot geometry, and
  numeric coordinates return to the isolated script for drawing; the close is
  not returned. The returned result is not stored, logged, or transmitted over
  the network. The isolated content script validates every result and draws the SVG itself. Turning the consent
  off removes that SVG and returns to the exact on-chain ruler. Because the
  chart interface is private, alignment is best effort and may stop working
  after a Dexscreener change.
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

**No credentials in this repo.** User-supplied RPC and Etherscan settings live
in `chrome.storage.local`. The shared Blockscout Pro credential is an encrypted
Cloudflare Worker secret and is never returned to the extension.
`tools/package.mjs` scans every packaged file for credential-shaped strings and
aborts the build on a hit.

**Hostile token names are neutralized.** `symbol()` is attacker-controlled —
any ERC-20 can name itself with an HTML payload, and position lists are rendered
with `innerHTML`. Every symbol is escaped, and escaped output lands only in
text-node context, never inside an attribute, so no element or handler can be
constructed. Verified against five injection payloads. MV3's default CSP
(`script-src 'self'`) blocks inline handlers as a second layer.

**Privacy, not security:** the address you paste is sent to the RPC and history
services needed for the scan. Dexscreener receives token contract addresses for
price marks and, for its optional overlay, the URL-derived chain and pool
identifier without the wallet address. Those hosts see ordinary HTTPS metadata,
including your IP address. For v4 ownership enumeration, an address-bearing log
filter also passes through the LPLens Worker to Blockscout Pro; it is processed
but not stored. Point the options page at your own RPC to reduce direct RPC
exposure. If a v4 NFT has
later additions, its public transaction hashes are sent directly to that
chain's public Blockscout trace endpoint; this is what makes the principal/fee
split exact without sending wallet credentials or requesting a signature.
Saved addresses, the separately selected active overlay wallet address, chain
and refresh-scope choices, hidden-position choices, overlay layout,
Dexscreener chart consent, the local current-position ID index, the exact v4
ownership block checkpoint, bounded per-position refresh comparison samples,
receipt-proven v3 replacement links, and the most recently rendered portfolio
view are stored with `chrome.storage.local`, deliberately **not**
`chrome.storage.sync`, so they are never carried into a Google account. The
refresh samples and replacement links are not sent in telemetry and never fill
missing current data. Replacement proofs are rechecked against the transaction
receipt and canonical block before display. The
saved view is local display output, not accounting input, and is replaced after
a successful refresh. The current-position index and ownership checkpoint hold
only public wallet, chain, protocol deployment, manager, position ID, direct or
gauge custody, custodian contract, ownership, and block-checkpoint data.
They are verified against live chain state before reuse and are not price or
accounting inputs. The Copy
diagnostics control saves only version, UI
surface, coarse scan counts,
allowlisted error categories, and local feature state. It excludes wallets,
labels, tokens, pools, positions, keys, custom endpoints, and raw errors, and it
leaves the browser only when the user copies it. If anonymous scan outcomes are
enabled in Settings, the extension sends the same coarse version/surface,
outcome, count bucket, duration bucket, and per-chain error categories. Worker
storage has no access-code hash or installation hash on those aggregate rows.

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

- `MAX_POSITIONS = 1000` per address per chain. **Full rescan** reads every v3
  ownership index below the guard and every corresponding `positions()` record.
  It has no early stop on closed positions: an
  ERC721Enumerable swap-and-pop can change the middle of a list without
  changing either its count or newest token, and an old closed NFT can be
  revived with `increaseLiquidity`. Each unreadable ownership/position record
  and anything beyond the guard is named in diagnostics. **Refresh current**
  instead verifies and reads only known open IDs, so it cannot discover a new
  or reopened NFT. The UI says when Full rescan is required.
- v4 Full rescan may reuse an exact local ownership checkpoint only after its
  block hash is still canonical and `balanceOf` plus `ownerOf` prove the entire
  candidate set at one captured block. A changed owner, count, hash, or
  unreadable proof falls through to a bounded Transfer tail and then full
  reconstruction. Stale checkpoint output is never rendered.
- **Anything held but not rendered is named in the status line**, per wallet and
  per chain. Closed-but-owned NFTs are distinguished from failed reads. A live
  Base wallet that previously read `230 v4 unreadable` now enumerates all 230
  through its configured Alchemy NFT index, verifies every candidate with
  `ownerOf` plus `balanceOf`, and reports `230 closed v4 hidden` because their
  on-chain liquidity is actually zero. The Transfer-log route remains the
  keyless fallback.
- Lifetime history needs a log source that will serve a full-range,
  topic-filtered query. The measured landscape as of 2026-08-21:
  - **Licensed builds use the LPLens Blockscout Pro relay first unless the user
    configured Etherscan.** The Pro credential is an encrypted Cloudflare
    secret and never enters this repo or the extension. The relay accepts only
    the configured Ethereum/Base/Arbitrum/Polygon v3 and v4 position-manager
    contracts and log-filter fields, authenticates every request, and caps each
    licence at 1,000 relayed queries per UTC day. The free Pro tier is currently
    100,000 credits/day and 5 requests/second; clients serialize and retry
    transient capacity responses.
  - **Robinhood Chain's public RPC serves it keylessly.** Nothing to configure.
    For a direct UP33 NFT, the RPC receives an exact lifetime Transfer filter
    for the public manager and token ID. PnL unlocks only when that complete
    result is one mint directly to the selected wallet and its transaction
    matches the first liquidity addition. The Transfer rows stay inside the
    extension and are not sent to LPLens.
  - **No public Ethereum RPC does.** Verified refusals from `eth.drpc.org`
    (10k blocks), `ethereum-rpc.publicnode.com` (archive needs a token),
    `rpc.ankr.com` (key), `rpc.mevblocker.io` (10k), `eth-pokt.nodies.app`,
    `rpc.flashbots.net` (pruned), `cloudflare-eth.com`, `eth.merkle.io`.
  - **Alchemy's free tier caps `eth_getLogs` at a 10-block range**, so a free
    Alchemy key does *not* enable lifetime history — 25M blocks at 10 per
    request is a different order of magnitude, not a rate-limit problem. PAYG
    lifts it.
    LPLens does not require archive `eth_call`; historical pool prices come
    from indexed `Swap` logs. The Alchemy NFT ownership endpoint still enables
    verified v4 enumeration when a user configures Alchemy.
  - **Etherscan's V2 API serves it on the free tier for most chains**, 100k
    calls/day, and `topic1`-only filtering is accepted — so one call returns a
    position's whole lifetime. Put a key from etherscan.io/apis in the options
    page if you want it; it is optional.
  - **Base (8453) is no longer on that free tier.** Etherscan cut free coverage
    to roughly 90% of chain IDs; a free key answers a full-range Base log query
    by refusing and pointing at a paid plan. Measured 2026-08-19 against the v3
    NFPM with a topic1 filter: Ethereum (1), Arbitrum (42161) and Polygon (137)
    all return the full lifetime on a free key; Base does not.
  - **Public Blockscout remains the credential-free fallback.**
    `eth`/`base`/`arbitrum`/`polygon.blockscout.com` answer the same
    Etherscan-compatible full-range `topic1` query with no key at all. Verified
    against Etherscan on the same positions: Ethereum 961877 returns the
    identical 4 events from both. The Etherscan key is **optional everywhere**
    — it is tried first when configured, then the Pro relay, public Blockscout,
    and finally the RPC. The same public index supplies timestamp-to-block
    mapping and historical reference-pool `Swap` events for keyless Robinhood
    dollar returns. This avoids the burst of Ethereum block-header requests
    that previously exhausted an anonymous RPC window on a multi-card overlay.
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
  - Public Base Blockscout rate-limits aggressively, and Blockscout now marks
    the per-instance API family for deprecation. Those are reasons for the Pro
    relay, not reasons to delete the fallback: a relay or Pro-tier failure still
    degrades to public sources and then "unavailable", never to a wrong number.
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
- **v4 lifetime return is deliberately narrow.** `ModifyLiquidity` identifies
  an NFT through `poolId + PositionManager + salt == tokenId`, but does not emit
  token amounts. LPLens 0.28 supports an untouched mint plus multiple positive
  additions only when the pool is hookless, every transaction isolates this NFT,
  and Blockscout exposes PoolManager's returned principal and fee deltas. A
  remove, fee-only action, hook, bundled action, missing trace, or ambiguous
  receipt reports a specific unavailable reason instead of partial cash flow.
- A custom RPC URL only works if that endpoint sends permissive CORS headers.
  Alchemy/Infura/dRPC do; a bare self-hosted node will fail with an opaque fetch
  error. Built-in endpoints are covered by `host_permissions` and are unaffected.

## Layout

```
extension/
  manifest.json      MV3, minimum permissions
  popup.*            UI
  sidepanel.*        persistent, page-independent portfolio UI
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
  lib/histprice.js   USD at any block, from a reference pool's Swap events
  lib/logs.js        log retrieval; Etherscan V2, Blockscout, or eth_getLogs
  lib/cache.js       bounded persistent caches
  lib/current-position-index.js  verified open-ID index for fast refresh
  lib/dashboard-snapshot.js  bounded last-rendered side-panel view
  lib/refresh-deltas.js  bounded consecutive accepted-refresh samples
  lib/position-lineage.js  receipt-verified v3 replacement graph
  lib/scan-preferences.js  local portfolio network selection
  lib/v4-ownership-cache.js  exact block-anchored v4 ownership checkpoint
  lib/diagnostics.js  sanitized local support report and error categories
  lib/telemetry.js    optional anonymous aggregate scan outcomes
  lib/wallets.js     saved addresses; chrome.storage.local only, never sync
  lib/aggregate.js   all-wallets totals, with explicit exclusion reporting
  lib/license.js     beta access gate
  overlay.js         optional Uniswap, ProjectX, UP33, and Dexscreener overlays
  sw.js              service worker; holds all network access for the overlay
tools/
  package.mjs        builds the distributable zip; refuses to ship a credential
  make-icons.mjs     generates the extension icons
  licence-worker/    Cloudflare Worker validating beta keys by SHA-256 hash
```
