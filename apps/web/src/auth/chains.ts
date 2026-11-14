// Robinhood Chain for viem and Privy. viem ships no definition for it, so
// both are custom chains (Privy: "Other networks", defineChain). Values from
// docs.robinhood.com/chain/connecting; the testnet RPC answers eth_chainId
// 0xb626 (46630).

import { defineChain } from 'viem';

export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  network: 'robinhood-testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood Chain Testnet Explorer', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

/** Mainnet is defined so the configuration is ready, but it is not in the supported chains: no mainnet until approved. */
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  network: 'robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood Chain Explorer', url: 'https://robinhoodchain.blockscout.com' } },
});

/** Chains Privy wallets may use in this app. Testnet only. */
export const SUPPORTED_CHAINS = [robinhoodTestnet] as const;
