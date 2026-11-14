import type { EIP1193Provider } from 'viem';

export interface AuthWallet { address: string; embedded: boolean; client: string | null }

export interface AuthState {
  ready: boolean;
  authenticated: boolean;
  userId: string | null;
  email: string | null;
  /** Ethereum wallets linked to the account (embedded and external). */
  wallets: AuthWallet[];
  hasEmbedded: boolean;
}

/** What the Privy island gives the game. */
export interface AuthApi {
  state(): AuthState;
  onChange(cb: (s: AuthState) => void): () => void;
  /** Opens Privy's login modal. True once logged in. */
  login(): Promise<boolean>;
  logout(): Promise<void>;
  /** Opens Privy's modal to link another wallet to the account. */
  linkWallet(): Promise<boolean>;
  /** Opens Privy's key export modal for the embedded wallet. */
  exportWallet(): Promise<void>;
  accessToken(): Promise<string | null>;
  identityToken(): Promise<string | null>;
  /** An EIP-1193 provider for one of the account's wallets, switched to the app's chain. */
  provider(address: string): Promise<EIP1193Provider>;
}
