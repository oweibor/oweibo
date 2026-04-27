/**
 * RS256 keypair management and JWKS serving.
 *
 * Private key signs tokens; public key is served at /.well-known/jwks.json.
 * All downstream gateways verify against the JWKS endpoint using jose's
 * createRemoteJWKSet() — no shared secrets.
 */
import {
  importPKCS8,
  importSPKI,
  exportJWK,
  type KeyLike,
} from 'jose';
import { config } from '../config.js';

let privateKey: KeyLike;
let publicKey: KeyLike;
let jwks: { keys: object[] };

export async function initKeys(): Promise<void> {
  privateKey = await importPKCS8(config.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'), 'RS256');
  publicKey = await importSPKI(config.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'), 'RS256');
  const jwk = await exportJWK(publicKey);
  jwks = {
    keys: [{ ...jwk, kid: config.JWT_KEY_ID, use: 'sig', alg: 'RS256' }],
  };
}

export function getPrivateKey(): KeyLike {
  if (!privateKey) throw new Error('JWKS not initialized — call initKeys() first');
  return privateKey;
}

export function getPublicKey(): KeyLike {
  if (!publicKey) throw new Error('JWKS not initialized — call initKeys() first');
  return publicKey;
}

export function getJwks(): { keys: object[] } {
  if (!jwks) throw new Error('JWKS not initialized — call initKeys() first');
  return jwks;
}
