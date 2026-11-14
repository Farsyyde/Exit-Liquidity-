// The pass in the browser: wallet, mint, the gated card, pass-bound ranked
// runs, settle. Loaded only when someone opens MY PASS, so the game itself
// never pulls in viem. Testnet only: the server refuses mainnet chain ids.
//
// Reads go through this site's /api/rpc (a read-only proxy), so the page
// itself talks to no third party. Transactions and signatures go through the
// visitor's own wallet, which uses whatever RPC it is configured with.

import {
  createPublicClient, createWalletClient, custom, http, parseAbi, formatEther, numberToHex,
  type Address, type Chain, type EIP1193Provider, type Hex,
} from 'viem';
import { createWalletPassClient, fromWalletClient, WalletPassClientError } from '@erc8426/client';
import type { PassContent } from '@erc8426/core';
import type { Settlement } from '@exit-liquidity/engine';

export interface ChainInfo {
  chainId: number; chainName: string; explorer: string | null; walletRpcUrl: string;
  playPass: Address; runRegistry: Address; price: string; paymentToken: Address;
  sale: 'not_started' | 'open' | 'closed'; minted: number; supply: number; maxPerWallet: number; revealed: boolean;
}

export type Card = PassContent & { owner: Address };

const passAbi = parseAbi([
  'function mint(uint256 quantity, uint256 expectedUnitPrice) payable',
  'function price() view returns (uint256)',
  'function foundersMintedBy(address) view returns (uint256)',
]);
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address, address) view returns (uint256)']);
const registryAbi = parseAbi([
  'struct RunResult { uint256 passId; uint32 day; uint8 attempt; bytes32 receiptHash; uint8 layers; uint64 bankCents; }',
  'function settle(RunResult r, bytes signature) returns (bool)',
]);

export async function chainInfo(): Promise<ChainInfo | null> {
  try {
    const r = await fetch('/api/chain');
    return r.ok ? ((await r.json()) as ChainInfo) : null;
  } catch { return null }
}

function provider(): EIP1193Provider | null {
  return ((window as unknown as { ethereum?: EIP1193Provider }).ethereum) ?? null;
}

export class PassWallet {
  readonly chain: Chain;
  readonly pub;
  private walletClient: ReturnType<typeof createWalletClient> | null = null;
  address: Address | null = null;

  constructor(readonly info: ChainInfo) {
    this.chain = {
      id: info.chainId, name: info.chainName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [info.walletRpcUrl] } },
      ...(info.explorer ? { blockExplorers: { default: { name: 'Explorer', url: info.explorer } } } : {}),
      testnet: true,
    };
    this.pub = createPublicClient({ chain: this.chain, transport: http('/api/rpc') });
  }

  static available(): boolean { return !!provider() }

  /** A wallet from the Privy account (embedded or linked external), already on the app's chain. */
  static async withProvider(info: ChainInfo, eth: EIP1193Provider, address: Address): Promise<PassWallet> {
    const w = new PassWallet(info);
    await w.ensureChain(eth);
    w.address = address;
    w.walletClient = createWalletClient({ account: address, chain: w.chain, transport: custom(eth) });
    return w;
  }

  /** Takes over another instance's connected wallet (used after re-reading sale info). */
  adopt(other: PassWallet): PassWallet { this.walletClient = other.walletClient; this.address = other.address; return this }

  async connect(): Promise<Address> {
    const eth = provider();
    if (!eth) throw new Error('No browser wallet found. Install one (for example MetaMask) or open this page in a wallet app.');
    const [addr] = (await eth.request({ method: 'eth_requestAccounts' })) as Address[];
    if (!addr) throw new Error('The wallet shared no account.');
    await this.ensureChain(eth);
    this.address = addr;
    this.walletClient = createWalletClient({ account: addr, chain: this.chain, transport: custom(eth) });
    return addr;
  }

  async ensureChain(eth: EIP1193Provider): Promise<void> {
    const want = numberToHex(this.info.chainId);
    const have = (await eth.request({ method: 'eth_chainId' })) as string;
    if (have.toLowerCase() === want) return;
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) throw e;
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: want, chainName: this.info.chainName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [this.info.walletRpcUrl], ...(this.info.explorer ? { blockExplorerUrls: [this.info.explorer] } : {}),
        }],
      });
    }
  }

  private wc() { if (!this.walletClient || !this.address) throw new Error('Connect a wallet first.'); return this.walletClient }

  priceText(): string { return BigInt(this.info.paymentToken) === 0n ? formatEther(BigInt(this.info.price)) + ' ETH' : this.info.price + ' token units' }

  async mintedBy(): Promise<number> {
    if (!this.address) return 0;
    return Number(await this.pub.readContract({ address: this.info.playPass, abi: passAbi, functionName: 'foundersMintedBy', args: [this.address] }));
  }

  /** Mint founder passes. Reads the price fresh and passes it as the agreed price, so a price change makes the mint fail instead of costing more. */
  async mint(quantity: number): Promise<Hex> {
    const wc = this.wc();
    const price = await this.pub.readContract({ address: this.info.playPass, abi: passAbi, functionName: 'price' });
    const total = price * BigInt(quantity);
    const token = this.info.paymentToken;
    if (BigInt(token) !== 0n) {
      const allowance = await this.pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [this.address!, this.info.playPass] });
      if (allowance < total) await this.wait(await wc.writeContract({ account: this.address!, chain: this.chain, address: token, abi: erc20Abi, functionName: 'approve', args: [this.info.playPass, total] }));
    }
    const hash = await wc.writeContract({
      account: this.address!, chain: this.chain, address: this.info.playPass, abi: passAbi, functionName: 'mint',
      args: [BigInt(quantity), price], value: BigInt(token) === 0n ? total : 0n,
    });
    await this.wait(hash);
    return hash;
  }

  async wait(hash: Hex): Promise<void> {
    const r = await this.pub.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
    if (r.status !== 'success') throw new Error('The transaction failed on chain.');
  }

  async passes(): Promise<{ id: string; style: number; founder: boolean }[]> {
    if (!this.address) return [];
    const r = await fetch('/api/passes/' + this.address);
    return r.ok ? ((await r.json()) as { passes: { id: string; style: number; founder: boolean }[] }).passes : [];
  }

  /**
   * The card, through the ERC-8426 gated flow: the client reads passURI,
   * meets the 401, checks the challenge is scoped to this site, this token
   * and this account, has the wallet sign it, then downloads the `preview`
   * format the manifest lists. Kept in memory only.
   */
  async card(tokenId: string): Promise<Card> {
    const client = createWalletPassClient({ publicClient: this.pub as never });
    try {
      const r = await client.getManifest({ contract: this.info.playPass, tokenId: BigInt(tokenId) }, { signer: fromWalletClient(this.wc() as never) });
      const url = r.manifest.formats.preview;
      if (!url) throw new Error('The pass manifest has no preview.');
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('The card download answered ' + res.status + '.');
      return (await res.json()) as Card;
    } catch (e) {
      if (e instanceof WalletPassClientError && e.code === 'not_owner') throw new Error('This wallet does not own pass #' + tokenId + '.');
      throw e;
    }
  }

  /** A signed proof that this wallet holds `tokenId`, for binding a ranked run. */
  async bindProof(tokenId: string): Promise<{ id: string; message: string; signature: string }> {
    const wc = this.wc();
    const r = await fetch(`/api/pass-challenge?pass=${encodeURIComponent(tokenId)}&address=${this.address}`);
    if (!r.ok) throw new Error('The server would not issue a pass challenge.');
    const { message } = (await r.json()) as { message: string };
    const signature = await wc.signMessage({ account: this.address!, message });
    return { id: tokenId, message, signature };
  }

  async settle(s: Settlement): Promise<Hex> {
    const wc = this.wc();
    const r = s.result;
    const hash = await wc.writeContract({
      account: this.address!, chain: this.chain, address: s.registry, abi: registryAbi, functionName: 'settle',
      args: [{ passId: BigInt(r.passId), day: r.day, attempt: r.attempt, receiptHash: r.receiptHash, layers: r.layers, bankCents: BigInt(r.bankCents) }, s.signature],
    });
    await this.wait(hash);
    return hash;
  }

  explorerTx(hash: string): string | null { return this.info.explorer ? `${this.info.explorer}/tx/${hash}` : null }
}

/** Renders a card from PassContent: the same content every wallet format is built from. */
export function cardHtml(c: Card, side: 'front' | 'back' = 'front'): string {
  const e = (s: unknown) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
  const bg = c.colors?.background ?? '#2b2f38', fg = c.colors?.foreground ?? '#fff', lab = c.colors?.label ?? fg;
  const fields = (list: PassContent['primary'], big = false) => (list ?? []).map((f) =>
    `<div class="pf"><div class="pl" style="color:${e(lab)}">${e(f.label)}</div><div class="${big ? 'pv big' : 'pv'}">${e(f.value)}</div></div>`).join('');
  if (side === 'back') {
    return `<div class="passcard" style="background:${e(bg)};color:${e(fg)}">` +
      (c.back ?? []).map((f) => `<div class="pb"><div class="pl" style="color:${e(lab)}">${e(f.label)}</div><div>${e(f.value)}</div></div>`).join('') +
      (c.links ?? []).map((l) => `<div class="pb"><a href="${e(l.url)}" rel="noreferrer" style="color:${e(lab)}">${e(l.label)}</a></div>`).join('') + '</div>';
  }
  return `<div class="passcard${c.voided ? ' voided' : ''}" style="background:${e(bg)};color:${e(fg)}">` +
    `<div class="ptop"><span class="porg">${e(c.title)}</span>${fields(c.header)}</div>` +
    (c.headline ? `<div class="phead" style="color:${e(lab)}">${e(c.headline)}</div>` : '') +
    `<div class="prow">${fields(c.primary, true)}</div><div class="prow">${fields(c.secondary)}</div><div class="prow">${fields(c.auxiliary)}</div>` +
    (c.voided ? '<div class="pvoid">SUPERSEDED</div>' : '') + '</div>';
}
