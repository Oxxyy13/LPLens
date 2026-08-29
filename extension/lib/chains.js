// Chain config. Addresses cross-checked against the R2D2 trading-stack
// `uniswap_monitor.py` CHAIN_CONTRACTS table, which is in production use.
//
// Public keyless RPC defaults. The options-page placeholders MUST use this
// map, never CHAINS[k].rpc: a dev build rewrites those to keyed Alchemy
// URLs, and a placeholder sourced from the live value would print the key.
export const PUBLIC_RPC = Object.freeze({
  // dRPC's anonymous Ethereum endpoint repeatedly 429ed a four-card Uniswap
  // overlay after only a handful of present-state reads. PublicNode serves the
  // same read-only calls keylessly; historical logs still come from the
  // indexed Blockscout path, so its archive restriction is irrelevant here.
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base.drpc.org',
  arbitrum: 'https://1rpc.io/arb',
  polygon: 'https://polygon.drpc.org',
  hyperevm: 'https://rpc.hyperliquid.xyz/evm',
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
    v4PoolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    v4StateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
    nativeSymbol: 'ETH',
    // USD reference for historical pricing. The pool itself is derived from
    // the factory at runtime, not hardcoded; all four chains independently
    // agree on WETH to within 0.4bp, which is the cross-check.
    usdRef: { stable: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', stableDecimals: 6, nativeEquivalent: true },
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
    v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    v4StateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
    nativeSymbol: 'ETH',
    // USD reference for historical pricing. The pool itself is derived from
    // the factory at runtime, not hardcoded; all four chains independently
    // agree on WETH to within 0.4bp, which is the cross-check.
    usdRef: { stable: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006', stableDecimals: 6, nativeEquivalent: true },
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
    v4PoolManager: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32',
    v4StateView: '0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990',
    nativeSymbol: 'ETH',
    // USD reference for historical pricing. The pool itself is derived from
    // the factory at runtime, not hardcoded; all four chains independently
    // agree on WETH to within 0.4bp, which is the cross-check.
    usdRef: { stable: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', stableDecimals: 6, nativeEquivalent: true },
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
    v4PoolManager: '0x67366782805870060151383F4BbFF9daB53e5cD6',
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
  // ProjectX on HyperEVM (chain id 999). Verified live 2026-08-21 against
  // wallet 0x946D...c09C and NFT 533076, not inferred from marketing copy:
  // balanceOf/tokenOfOwnerByIndex, positions(uint256), factory.getPool,
  // pool.slot0 and collect all match the Uniswap-v3-family ABI LPLens reads.
  // ProjectX labels this contract "PRJX V3 Positions NFT-V1" on-chain.
  hyperevm: {
    label: 'HyperEVM',
    protocol: 'ProjectX',
    nfpm: '0xeaD19AE861c29bBb2101E834922B2FEee69B9091',
    factory: '0xFf7B3e8C00e57ea31477c32A5B52a58Eea47b072',
    rpc: PUBLIC_RPC.hyperevm,
    dexscreener: 'hyperevm',
    nativeSymbol: 'HYPE',
    // WHYPE/USDC 0.05% pool resolves from this factory and is deep enough to
    // be the historical USD reference. `usdRef.weth` means the 18dp reference
    // asset in the generic pricing code; on this chain that asset is WHYPE.
    usdRef: {
      stable: '0xb88339cb7199b77e23db6e890353e22632ba630f',
      weth: '0x5555555555555555555555555555555555555555',
      stableDecimals: 6,
    },
    // Etherscan V2 serves chain 999. The public RPC caps eth_getLogs at 1,000
    // blocks, so complete lifetime history uses a user key or the hosted relay.
    etherscanChainId: 999,
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
    // This endpoint accepts JSON-RPC batches and is materially faster when a
    // wallet owns many NFTs. Other public endpoints retain bounded singles
    // unless their own chain config opts in.
    rpcBatchSize: 25,
    dexscreener: 'robinhood',
    // Official Blockscout. Besides lifetime logs, its v2 raw trace is the only
    // keyless source that separates v4 addition principal from fees accrued in
    // the same PoolManager balance delta.
    blockscout: 'https://robinhoodchain.blockscout.com/api',
    // v4, verified live 2026-08-18: code present at both contracts and
    // poolManager() returns the expected singleton.
    v4PositionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
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
      nativeEquivalent: true,
    },
  },
};


// Hard cap on positions enumerated per address. Surfaced in the UI when hit —
// a silent truncation would read as "you have no other positions".
// A correctness ceiling, not a display limit. The public smoke wallet has 664
// v3 NFTs, and opening one new position must not push an older live position
// out of sight. Positions above this guard are still named explicitly.
export const MAX_POSITIONS = 1000;
