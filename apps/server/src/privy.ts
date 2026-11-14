// Privy login, server side.
//
// - Access tokens are verified locally against the app's verification key
//   (ES256; from the Privy dashboard, Configuration > App settings), with
//   @privy-io/node's verifyAccessToken: issuer privy.io, audience = app id.
// - A user's linked wallets are read from Privy every time they are needed
//   (users()._get with the app secret), so a wallet unlinked a moment ago no
//   longer counts. Without an app secret (development) the signed identity
//   token is used instead; it can be up to an hour old.
// - Pass ownership is never cached here: callers read ownerOf on chain for
//   every wallet this returns.
// - Deleting a user deletes the Privy user too. Privy then disassociates the
//   embedded wallet from the login for good, so the client warns and offers
//   key export first.

import { PrivyClient, verifyAccessToken, verifyIdentityToken } from '@privy-io/node';
import { getAddress, isAddress, type Address } from 'viem';

export interface PrivyOptions {
  appId: string;
  /** SPKI PEM verification key from the Privy dashboard. */
  verificationKey: string;
  /** Needed for fresh linked accounts and for deleting users. Never sent to browsers. */
  appSecret?: string | null;
  /** Optional app client id, shown to the browser SDK. */
  clientId?: string | null;
  /** Tests only: stand-ins for the Privy REST calls. */
  api?: { getUser(id: string): Promise<PrivyUserLike>; deleteUser(id: string): Promise<void> };
}

export interface PrivyUserLike {
  id: string;
  linked_accounts: { type: string; address?: string; chain_type?: string; connector_type?: string; wallet_client_type?: string }[];
}

export interface LinkedWallet { address: Address; embedded: boolean; client: string | null }

export function createPrivyAuth(o: PrivyOptions) {
  const client = !o.api && o.appSecret ? new PrivyClient({ appId: o.appId, appSecret: o.appSecret, jwtVerificationKey: o.verificationKey }) : null;
  const api = o.api ?? (client ? {
    getUser: (id: string) => client.users()._get(id) as unknown as Promise<PrivyUserLike>,
    deleteUser: (id: string) => client.users().delete(id) as unknown as Promise<void>,
  } : null);

  /** The Privy user id (did:privy:...) a valid access token belongs to, or null. */
  async function verify(accessToken: string | null | undefined): Promise<string | null> {
    if (!accessToken || accessToken.length > 4096) return null;
    try {
      const claims = await verifyAccessToken({ access_token: accessToken, app_id: o.appId, verification_key: o.verificationKey });
      return claims.user_id;
    } catch {
      return null;
    }
  }

  function walletsOf(u: PrivyUserLike): LinkedWallet[] {
    const out = new Map<string, LinkedWallet>();
    for (const a of u.linked_accounts ?? []) {
      if (a.type !== 'wallet' || a.chain_type !== 'ethereum' || !a.address || !isAddress(a.address)) continue;
      const address = getAddress(a.address);
      out.set(address, { address, embedded: a.connector_type === 'embedded' || a.wallet_client_type === 'privy', client: a.wallet_client_type ?? null });
    }
    return [...out.values()];
  }

  /**
   * Every Ethereum wallet linked to the user right now: from Privy's API when
   * the app secret is set, otherwise from a signed identity token that must
   * belong to the same user.
   */
  async function linkedWallets(userId: string, identityToken?: string | null): Promise<LinkedWallet[]> {
    if (api) return walletsOf(await api.getUser(userId));
    if (!identityToken) throw new Error('no identity token and no app secret: cannot list linked wallets');
    const u = await verifyIdentityToken({ identity_token: identityToken, app_id: o.appId, verification_key: o.verificationKey });
    if (u.id !== userId) throw new Error('identity token belongs to another user');
    return walletsOf(u as unknown as PrivyUserLike);
  }

  async function deleteUser(userId: string): Promise<boolean> {
    if (!api) return false;
    await api.deleteUser(userId);
    return true;
  }

  return {
    appId: o.appId, clientId: o.clientId ?? null, canDelete: !!api, freshWallets: !!api,
    verify, linkedWallets, deleteUser,
  };
}

export type PrivyAuth = ReturnType<typeof createPrivyAuth>;
