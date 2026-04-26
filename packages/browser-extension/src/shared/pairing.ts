// packages/browser-extension/src/shared/pairing.ts
// One-shot pairing helper. The host shows a 6-char code in the Oweibo CLI
// after `oweibo browser pair`; the user types it into the popup, which sends
// a pair-request over the bridge socket. On pair-ack the session token is
// persisted in chrome.storage.local for subsequent reconnects.

export const PAIR_CODE_LENGTH = 6;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars

export function generatePairCode(): string {
  let out = '';
  const buf = new Uint8Array(PAIR_CODE_LENGTH);
  globalThis.crypto.getRandomValues(buf);
  for (const b of buf) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function isValidPairCode(code: string): boolean {
  if (code.length !== PAIR_CODE_LENGTH) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}
