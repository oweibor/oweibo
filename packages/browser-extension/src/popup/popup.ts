// packages/browser-extension/src/popup/popup.ts
// Renders pending HITL gate cards alongside the manual pairing form. Polls
// the background coordinator every 500ms while the popup is open. Resolves
// gates by sending { cmd: 'hitl-resolve', ... } back to the background.

import type { HITLGate } from '../shared/actions.js';
import { isValidPairCode } from '../shared/pairing.js';

const gatesEl  = document.getElementById('gates')   as HTMLDivElement;
const codeInput = document.getElementById('code')   as HTMLInputElement;
const button    = document.getElementById('connect') as HTMLButtonElement;
const status    = document.getElementById('status') as HTMLDivElement;

// ── Pairing form ─────────────────────────────────────────────────────────────
button.addEventListener('click', () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!isValidPairCode(code)) {
    status.textContent = 'Invalid code. Codes are 6 letters/digits.';
    return;
  }
  status.textContent = 'Connecting…';
  chrome.runtime.sendMessage({ cmd: 'pair', pairCode: code }, (resp: { ok: boolean }) => {
    status.textContent = resp?.ok ? 'Paired. You can close this window.' : 'Pairing failed.';
  });
});

// ── Gate list ────────────────────────────────────────────────────────────────
function renderGates(gates: HITLGate[]): void {
  gatesEl.replaceChildren();
  if (gates.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No pending gates.';
    gatesEl.appendChild(empty);
    return;
  }
  for (const gate of gates) {
    const card = document.createElement('div');
    card.className = 'gate';
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = gate.message;
    const row = document.createElement('div');
    row.className = 'row';
    const dismiss = document.createElement('button');
    dismiss.className = 'dismiss';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => respond(gate.gateId, false));
    const accept = document.createElement('button');
    accept.className = 'accept';
    accept.textContent = 'Accept';
    accept.addEventListener('click', () => respond(gate.gateId, true));
    row.append(dismiss, accept);
    card.append(msg, row);
    gatesEl.appendChild(card);
  }
}

function respond(gateId: string, accept: boolean): void {
  chrome.runtime.sendMessage({ cmd: 'hitl-resolve', gateId, accept });
  // Optimistic — remove the card immediately; the next poll will rectify if
  // the background did not actually resolve.
  document.querySelectorAll('.gate').forEach((el) => {
    if (el.querySelector('.msg')) (el as HTMLElement).style.opacity = '0.4';
  });
}

async function poll(): Promise<void> {
  chrome.runtime.sendMessage({ cmd: 'hitl-list' }, (resp: { ok: boolean; gates?: HITLGate[] }) => {
    if (resp?.ok) renderGates(resp.gates ?? []);
  });
}

void poll();
const intervalId = setInterval(() => void poll(), 500);
window.addEventListener('unload', () => clearInterval(intervalId));
