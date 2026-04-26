// packages/browser-extension/src/content/hitl-overlay.ts
// Compiled to hitl-overlay.js. Runs in the page document context.
//
// Renders a floating top-right panel with Accept / Dismiss buttons for each
// pending HITL gate. Scoped under a single shadow host so page CSS cannot
// bleed into the overlay. Multiple concurrent gates stack vertically.

import type { HITLGate } from '../shared/actions.js';

interface ShowMsg    { __oweiboHitl: 'show';    gate: HITLGate }
interface DismissMsg { __oweiboHitl: 'dismiss'; gateId: string }
type OverlayMsg = ShowMsg | DismissMsg;

const HOST_ID = '__oweibo_hitl_host__';

function getRoot(): ShadowRoot {
  let host = document.getElementById(HOST_ID);
  if (host?.shadowRoot) return host.shadowRoot;

  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host, .stack { font-family: -apple-system, system-ui, Segoe UI, sans-serif; }
    .stack { display: flex; flex-direction: column; gap: 10px; width: 320px; }
    .card {
      background: #1f2330; color: #f0f2f6; border: 1px solid #3a4256;
      border-radius: 10px; padding: 14px 16px; box-shadow: 0 8px 24px rgba(0,0,0,.3);
      animation: slide-in .18s ease-out;
    }
    .title { font-size: 12px; font-weight: 600; color: #9fb0d6; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 6px; }
    .msg   { font-size: 14px; line-height: 1.4; margin-bottom: 12px; }
    .row   { display: flex; gap: 8px; justify-content: flex-end; }
    button {
      font: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer; border: 0;
    }
    .accept  { background: #3b82f6; color: #fff; }
    .dismiss { background: #2d3444; color: #d9dfef; }
    .accept:hover  { background: #2f6ddb; }
    .dismiss:hover { background: #3a4256; }
    @keyframes slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }
    .leaving { animation: slide-out .18s ease-in forwards; }
    @keyframes slide-out { to { transform: translateX(20px); opacity: 0; } }
  `;
  const stack = document.createElement('div');
  stack.className = 'stack';
  root.append(style, stack);
  return root;
}

function stack(root: ShadowRoot): HTMLElement {
  return root.querySelector('.stack') as HTMLElement;
}

function showCard(gate: HITLGate): void {
  const root = getRoot();
  if (root.querySelector(`[data-gate="${CSS.escape(gate.gateId)}"]`)) return;

  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('data-gate', gate.gateId);
  card.innerHTML = `
    <div class="title">Oweibo — approval required</div>
    <div class="msg"></div>
    <div class="row">
      <button class="dismiss">Dismiss</button>
      <button class="accept">Accept</button>
    </div>
  `;
  (card.querySelector('.msg') as HTMLElement).textContent = gate.message;

  const respond = (accept: boolean): void => {
    chrome.runtime.sendMessage({
      __oweiboHitlResolve: true,
      gateId: gate.gateId,
      accept,
      resolvedBy: 'overlay',
    });
  };
  (card.querySelector('.accept')  as HTMLButtonElement).addEventListener('click', () => respond(true));
  (card.querySelector('.dismiss') as HTMLButtonElement).addEventListener('click', () => respond(false));
  stack(root).appendChild(card);
}

function dismissCard(gateId: string): void {
  const root = getRoot();
  const card = root.querySelector(`[data-gate="${CSS.escape(gateId)}"]`);
  if (!card) return;
  card.classList.add('leaving');
  setTimeout(() => card.remove(), 180);
}

chrome.runtime.onMessage.addListener((msg: OverlayMsg) => {
  if (msg?.__oweiboHitl === 'show')    showCard(msg.gate);
  if (msg?.__oweiboHitl === 'dismiss') dismissCard(msg.gateId);
  return false;
});

(window as unknown as { __oweiboHitlOverlay?: boolean }).__oweiboHitlOverlay = true;
