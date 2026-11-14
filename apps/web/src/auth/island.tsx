// Privy, mounted as a small React island beside the vanilla game. The game
// talks to it only through the AuthApi it resolves. Privy's React SDK is used
// (not its low-level vanilla SDK) because embedded wallet key export is only
// available through the React SDK's exportWallet.

import { Component, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  PrivyProvider, usePrivy, useLogin, useLinkAccount, useExportWallet, useWallets, getAccessToken, getIdentityToken,
  type ConnectedWallet,
} from '@privy-io/react-auth';
import type { EIP1193Provider } from 'viem';
import { SUPPORTED_CHAINS, robinhoodTestnet } from './chains.ts';
import type { AuthApi, AuthState, AuthWallet } from './types.ts';

export function mountAuth(cfg: { appId: string; clientId: string | null }): Promise<AuthApi> {
  const host = document.createElement('div');
  host.id = 'privy-island';
  document.body.appendChild(host);
  return new Promise((resolve, reject) => {
    const root = createRoot(host);
    // Privy can refuse to start (a bad app id, a blocked network). The game must not wait forever.
    const fail = (e: unknown) => { clearTimeout(timer); root.unmount(); host.remove(); reject(e instanceof Error ? e : new Error(String(e))) };
    const timer = setTimeout(() => fail(new Error('login did not start in time')), 20_000);
    const done = (api: AuthApi) => { clearTimeout(timer); resolve(api) };
    root.render(
      <Guard onError={fail}>
      <PrivyProvider
        appId={cfg.appId}
        {...(cfg.clientId ? { clientId: cfg.clientId } : {})}
        config={{
          // Email, social logins and external wallets.
          loginMethods: ['email', 'google', 'twitter', 'discord', 'wallet'],
          // Players who log in without a wallet get an embedded one, on Robinhood Chain testnet.
          embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
          defaultChain: robinhoodTestnet,
          supportedChains: [...SUPPORTED_CHAINS],
          appearance: { theme: 'dark', accentColor: '#3aa0ff', walletChainType: 'ethereum-only' },
        }}
      >
        <Bridge onReady={done} />
      </PrivyProvider>
      </Guard>,
    );
  });
}

class Guard extends Component<{ onError: (e: unknown) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(e: unknown) { this.props.onError(e) }
  render() { return this.state.failed ? null : this.props.children }
}

function Bridge({ onReady }: { onReady: (api: AuthApi) => void }) {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const { exportWallet } = useExportWallet();
  const listeners = useRef(new Set<(s: AuthState) => void>());
  const pendingLogin = useRef<((ok: boolean) => void) | null>(null);
  const pendingLink = useRef<((ok: boolean) => void) | null>(null);
  const latest = useRef<{ state: AuthState; wallets: ConnectedWallet[] }>({ state: emptyState(), wallets: [] });
  const resolved = useRef(false);

  const { login } = useLogin({
    onComplete: () => { pendingLogin.current?.(true); pendingLogin.current = null },
    onError: () => { pendingLogin.current?.(false); pendingLogin.current = null },
  });
  const { linkWallet } = useLinkAccount({
    onSuccess: () => { pendingLink.current?.(true); pendingLink.current = null },
    onError: () => { pendingLink.current?.(false); pendingLink.current = null },
  });

  // Publish state on every change.
  useEffect(() => {
    const linked: AuthWallet[] = (user?.linkedAccounts ?? [])
      .filter((a) => a.type === 'wallet' && (a as { chainType?: string }).chainType === 'ethereum')
      .map((a) => {
        const w = a as unknown as { address: string; walletClientType?: string; connectorType?: string };
        return { address: w.address, embedded: w.walletClientType === 'privy' || w.connectorType === 'embedded', client: w.walletClientType ?? null };
      });
    const email = (user?.linkedAccounts ?? []).find((a) => a.type === 'email') as { address?: string } | undefined;
    const state: AuthState = {
      ready, authenticated, userId: user?.id ?? null, email: email?.address ?? null, wallets: linked,
      hasEmbedded: linked.some((w) => w.embedded),
    };
    latest.current = { state, wallets };
    for (const l of listeners.current) l(state);
  }, [ready, authenticated, user, wallets]);

  // Hand the API to the game once Privy has initialized.
  useEffect(() => {
    if (!ready || resolved.current) return;
    resolved.current = true;
    const api: AuthApi = {
      state: () => latest.current.state,
      onChange(cb) { listeners.current.add(cb); return () => listeners.current.delete(cb) },
      login: () => new Promise<boolean>((done) => { pendingLogin.current = done; login() }),
      logout: () => logout(),
      linkWallet: () => new Promise<boolean>((done) => { pendingLink.current = done; linkWallet() }),
      exportWallet: () => exportWallet(),
      accessToken: () => getAccessToken(),
      identityToken: () => getIdentityToken(),
      async provider(address: string): Promise<EIP1193Provider> {
        const w = latest.current.wallets.find((x) => x.address.toLowerCase() === address.toLowerCase());
        if (!w) throw new Error('That wallet is not connected in this browser. Reconnect it from your account.');
        await w.switchChain(robinhoodTestnet.id);
        return (await w.getEthereumProvider()) as EIP1193Provider;
      },
    };
    onReady(api);
  }, [ready]);

  return null;
}

function emptyState(): AuthState {
  return { ready: false, authenticated: false, userId: null, email: null, wallets: [], hasEmbedded: false };
}
