// Chain config. Addresses cross-checked against the R2D2 trading-stack
// `uniswap_monitor.py` CHAIN_CONTRACTS table, which is in production use.
//
// Public keyless RPC defaults. The options-page placeholders MUST use this
// map, never CHAINS[k].rpc: a dev build rewrites those to keyed Alchemy
// URLs, and a placeholder sourced from the live value would print the key.
export const PUBLIC_RPC = Object.freeze({
  ethereum: 'https://eth.drpc.org',
  base: 'https://base.drpc.org',
  arbitrum: 'https://1rpc.io/arb',
  polygon: 'https://polygon.drpc.org',
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
});

export const CHAINS = {
  ethereum: {
    label: 'Ethereum',
    nfpm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    rpc: PUBLIC_RPC.ethereum,
    dexscreener: 'ethereum',
    // v4, verified live 2026-08-18: code present at both contracts and
    // poolManager() returns the expected singleton.
    v4PositionManager: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
    v4StateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
    nativeSymbol: 'ETH',
    // USD reference for historical pricing. The pool itself is derived from
    // the factory at runtime, not hardcoded; all four chains independently
    // agree on WETH to within 0.4bp, which is the cross-check.
    usdRef: { stable: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', stableDecimals: 6 },
    etherscanChainId: 1,
    // Keyless getLogs. Host verified live 2026-08-19 (not assumed from a pattern).
    blockscout: 'https://eth.blockscout.com/api',
  },
  base: {
    label: 'Base',
    nfpm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    rpc: PUBLIC_RPC.base,
    dexscreener: 'base',
    // v4, verified live 2026-08-18: code present at both contracts and
    // poolManager() returns the expected singleton.
    v4PositionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
    v4StateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
    nativeSymbol: 'ETH',
    // USD reference for historical pricing. The pool itself is derived from
    // the factory at runtime, not hardcoded; all four chains independently
    // agree on WETH to within 0.4bp, which is the cross-check.
    usdRef: { stable: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006', stableDecimals: 6 },
    etherscanChainId: 8453,
    // Keyless getLogs. Host verified live 2026-08-19. Free Etherscan refuses Base.
    blockscout: 'https://base.blockscout.com/api',
  },
  arbitrum: {
    label: 'Arbitrum',
    nfpm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    rpc: PUBLIC_RPC.arbitrum,
    dexscreener: 'arbitrum',
    // v4, verified live 2026-08-18: code present at both contracts and
    // poolManager() returns the expected singleton.
    v4PositionManager: '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869',
    v4StateView: '0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990',
    nativeSymbol: 'ETH',
    // USD reference for historical pricing. The pool itself is derived from
    // the factory at runtime, not hardcoded; all four chains independently
    // agree on WETH to within 0.4bp, which is the cross-check.
    usdRef: { stable: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', stableDecimals: 6 },
    etherscanChainId: 42161,
    // Keyless getLogs. Host verified live 2026-08-19 (not assumed from a pattern).
    blockscout: 'https://arbitrum.blockscout.com/api',
  },
  polygon: {
    label: 'Polygon',
    nfpm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    rpc: PUBLIC_RPC.polygon,
    dexscreener: 'polygon',
    // v4, verified live 2026-08-18: code present at both contracts and
    // poolManager() returns the expected singleton.
    v4PositionManager: '0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9',
    v4StateView: '0x5eA1bD7974c8A611cBAB0bDCAFcB1D9CC9b3BA5a',
    nativeSymbol: 'POL',
    // USD reference for historical pricing. The pool itself is derived from
    // the factory at runtime, not hardcoded; all four chains independently
    // agree on WETH to within 0.4bp, which is the cross-check.
    usdRef: { stable: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', stableDecimals: 6 },
    etherscanChainId: 137,
    // Keyless getLogs. Host verified live 2026-08-19. This instance has holes in
    // historical blocks (e.g. 45042718 404s while 1 and 48000000 exist);
    // reconciles() is the backstop for an incomplete event set.
    blockscout: 'https://polygon.blockscout.com/api',
  },
  // Robinhood Chain (id 4663). Addresses verified live 2026-08-18 against
  // rpc.mainnet.chain.robinhood.com, not copied: the NFPM is pinned in
  // `PortfolioManager/scripts/robinhood_chain_lp.py`, and `factory()` was
  // read off that NFPM rather than assumed to match the mainnet deployment
  // (it does not). The NFPM answers supportsInterface(0x780e9d63) = true,
  // so the balanceOf + tokenOfOwnerByIndex path works here unchanged.
  //
  // v3 only. This wallet also holds Uniswap v4 positions under a separate
  // PositionManager (0x58daec3116aae6d93017baaea7749052e8a04fa7), which
  // LPLens cannot read. Those are invisible here, not zero.
  robinhood: {
    label: 'Robinhood',
    nfpm: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
    factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    rpc: PUBLIC_RPC.robinhood,
    dexscreener: 'robinhood',
    // v4, verified live 2026-08-18: code present at both contracts and
    // poolManager() returns the expected singleton.
    v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    v4StateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    nativeSymbol: 'ETH',
    // No stablecoin liquidity on this chain: its WETH trades against thirty
    // memecoins and nothing dollar-denominated, so there is no local pool to
    // read a USD price from. The WETH here is bridged, so dollars come from
    // Ethereum at the matching timestamp instead. That assumes the bridged
    // token holds its peg — an assumption the same-chain path does not make,
    // so results carry a `bridged` flag and the UI says so.
    usdRef: {
      weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
      via: 'ethereum',
    },
  },
};


// Hard cap on positions enumerated per address. Surfaced in the UI when hit —
// a silent truncation would read as "you have no other positions".
// A correctness ceiling, not a display limit. The public smoke wallet has 664
// v3 NFTs, and opening one new position must not push an older live position
// out of sight. Positions above this guard are still named explicitly.
export const MAX_POSITIONS = 1000;
