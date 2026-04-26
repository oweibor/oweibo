// packages/browser-extension/src/pair.ts
// Compiled to pair.js. Deep-link pairing handler.
//
// Flow:
//   1. CLI opens chrome-extension://<id>/pair.html?token=<pairingToken>
//   2. User clicks Connect.
//   3. Page posts { cmd: 'pair', pairToken } to background service worker.
//   4. Background opens the native messaging port, exchanges HMAC, then
//      responds { ok: true } or { ok: false, reason }.

const params = new URLSearchParams(location.search);
const pairToken = params.get('token') ?? '';

const connectBtn = document.getElementById('connect') as HTMLButtonElement;
const cancelBtn  = document.getElementById('cancel')  as HTMLButtonElement;
const statusEl   = document.getElementById('status')  as HTMLDivElement;

function setStatus(kind: 'ok' | 'err', msg: string): void {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = msg;
}

if (!pairToken) {
  setStatus('err', 'Missing pairing token. Re-run the oweibo CLI.');
  connectBtn.disabled = true;
}

connectBtn.addEventListener('click', () => {
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  chrome.runtime.sendMessage(
    { cmd: 'pair-deeplink', pairToken },
    (res: { ok: boolean; reason?: string } | undefined) => {
      if (res?.ok) {
        setStatus('ok', 'Connected. You can close this tab.');
        connectBtn.textContent = 'Connected';
      } else {
        setStatus('err', `Pairing failed: ${res?.reason ?? 'unknown error'}`);
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
      }
    },
  );
});

cancelBtn.addEventListener('click', () => window.close());
