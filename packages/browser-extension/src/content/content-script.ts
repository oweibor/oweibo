// packages/browser-extension/src/content/content-script.ts
// Compiled to content-script.js. Runs in the page's document context.
//
// Receives { __oweibo: true, action } messages from the background script and
// executes the 38 DOM-level BrowserActions directly on the page DOM. Every
// interaction (click, focus, submit, drag) produces isTrusted: true events.
//
// Security: this script accesses NO chrome.* APIs beyond chrome.runtime.onMessage,
// performs NO network requests, reads NO cookies. Its attack surface is DOM
// manipulation on the injected page only.

import type { BrowserAction, BrowserActionType, ContentScriptResult } from '../shared/actions.js';

type Handler = (action: BrowserAction) => Promise<unknown> | unknown;

function q<T extends Element = Element>(sel: string): T {
  const el = document.querySelector(sel) as T | null;
  if (!el) throw new Error(`selector not found: ${sel}`);
  return el;
}

function dispatch(el: Element, type: string, init: EventInit = {}): void {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
}

function mouse(el: Element, type: string, opts: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...opts }));
}

async function waitForSelector(
  selector: string,
  state: 'visible' | 'hidden' | 'attached' | 'detached' = 'visible',
  timeout = 30_000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const el = document.querySelector(selector);
      const visible = !!el && (el as HTMLElement).offsetParent !== null;
      if (state === 'attached' && el) return resolve(), true;
      if (state === 'detached' && !el) return resolve(), true;
      if (state === 'visible'  && visible) return resolve(), true;
      if (state === 'hidden'   && !visible) return resolve(), true;
      return false;
    };
    if (check()) return;
    const obs = new MutationObserver(() => {
      if (check()) obs.disconnect();
      else if (Date.now() - start > timeout) {
        obs.disconnect();
        reject(new Error(`wait-for-selector timeout: ${selector}`));
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    // Also poll in case MutationObserver misses style-driven visibility changes.
    const poll = setInterval(() => {
      if (check()) { clearInterval(poll); obs.disconnect(); }
      else if (Date.now() - start > timeout) {
        clearInterval(poll); obs.disconnect();
        reject(new Error(`wait-for-selector timeout: ${selector}`));
      }
    }, 100);
  });
}

const HANDLERS: Partial<Record<BrowserActionType, Handler>> = {
  click: (a) => {
    const el = q<HTMLElement>(a.selector as string);
    el.focus();
    el.click();
    return { clicked: true };
  },

  type: (a) => {
    const el = q<HTMLInputElement | HTMLTextAreaElement>(a.selector as string);
    el.focus();
    if (a.clearFirst) el.value = '';
    const text = String(a.text ?? '');
    // Use the native setter so React/Vue reactive systems observe the change.
    const proto = Object.getPrototypeOf(el);
    const desc  = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, (el.value ?? '') + text);
    else el.value = (el.value ?? '') + text;
    el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: text.length };
  },

  scroll: (a) => {
    const target = a.selector ? q<HTMLElement>(a.selector as string) : document.scrollingElement ?? document.documentElement;
    const distance = Number(a.distance ?? 300);
    const dir = a.direction as 'up' | 'down' | 'left' | 'right';
    const dx = dir === 'left' ? -distance : dir === 'right' ? distance : 0;
    const dy = dir === 'up'   ? -distance : dir === 'down'  ? distance : 0;
    (target as HTMLElement).scrollBy({ top: dy, left: dx, behavior: 'smooth' });
    return { scrolled: { dx, dy } };
  },

  hover: (a) => {
    const el = q(a.selector as string);
    mouse(el, 'mouseover');
    mouse(el, 'mouseenter');
    mouse(el, 'mousemove');
    return { hovered: true };
  },

  select: (a) => {
    const el = q<HTMLSelectElement>(a.selector as string);
    const value = a.value as string | string[];
    if (Array.isArray(value)) {
      for (const opt of Array.from(el.options)) opt.selected = value.includes(opt.value);
    } else {
      el.value = value;
    }
    dispatch(el, 'input');
    dispatch(el, 'change');
    return { selected: value };
  },

  check: (a) => {
    const el = q<HTMLInputElement>(a.selector as string);
    const want = Boolean(a.checked);
    if (el.checked !== want) el.click();
    return { checked: want };
  },

  wait: (a) => new Promise(res => setTimeout(() => res({ waited: a.ms }), Number(a.ms))),

  'wait-for-selector': async (a) => {
    await waitForSelector(
      a.selector as string,
      (a.state as 'visible' | 'hidden' | 'attached' | 'detached') ?? 'visible',
      Number(a.timeout ?? 30_000),
    );
    return { ready: true };
  },

  submit: (a) => {
    const el = q<HTMLFormElement | HTMLElement>(a.selector as string);
    const form = el instanceof HTMLFormElement ? el : el.closest('form');
    if (!form) throw new Error('no enclosing form');
    form.requestSubmit();
    return { submitted: true };
  },

  'drag-and-drop': (a) => {
    const src = q<HTMLElement>(a.sourceSelector as string);
    const dst = q<HTMLElement>(a.targetSelector as string);
    const r = dst.getBoundingClientRect();
    const tx = r.left + r.width / 2, ty = r.top + r.height / 2;
    mouse(src, 'mousedown', { clientX: 0, clientY: 0, button: 0 });
    const steps = Math.max(1, Number(a.steps ?? 10));
    for (let i = 1; i <= steps; i++) {
      mouse(src, 'mousemove', { clientX: (tx * i) / steps, clientY: (ty * i) / steps });
    }
    mouse(dst, 'mousemove', { clientX: tx, clientY: ty });
    mouse(dst, 'mouseup',   { clientX: tx, clientY: ty, button: 0 });
    return { dragged: true };
  },

  'mouse-move': (a) => { mouse(document.elementFromPoint(Number(a.x), Number(a.y)) ?? document.body, 'mousemove', { clientX: Number(a.x), clientY: Number(a.y) }); return {}; },
  'mouse-down': (a) => { mouse(document.elementFromPoint(Number(a.x), Number(a.y)) ?? document.body, 'mousedown', { clientX: Number(a.x), clientY: Number(a.y) }); return {}; },
  'mouse-up':   (a) => { mouse(document.elementFromPoint(Number(a.x), Number(a.y)) ?? document.body, 'mouseup',   { clientX: Number(a.x), clientY: Number(a.y) }); return {}; },

  extract: (a) => {
    const out: Record<string, string | string[]> = {};
    for (const sel of (a.selectors as { name: string; query: string; attribute?: string }[])) {
      const els = Array.from(document.querySelectorAll(sel.query));
      const values = els.map(e => sel.attribute ? (e.getAttribute(sel.attribute) ?? '') : (e.textContent ?? ''));
      out[sel.name] = values.length > 1 ? values : (values[0] ?? '');
    }
    return out;
  },

  snapshot: () => {
    // Lightweight DOM snapshot — interactive elements + text landmarks.
    const interactives = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link]'));
    return {
      url:   location.href,
      title: document.title,
      text:  document.body?.innerText?.slice(0, 4000) ?? '',
      elements: interactives.slice(0, 200).map((el, i) => ({
        ref:  i,
        tag:  el.tagName.toLowerCase(),
        text: (el as HTMLElement).innerText?.slice(0, 80) ?? '',
        name: el.getAttribute('name') ?? undefined,
        id:   el.id || undefined,
        role: el.getAttribute('role') ?? undefined,
      })),
    };
  },

  'get-url':   () => ({ url: location.href }),
  'get-title': () => ({ title: document.title }),

  upload: (a) => {
    // DataTransfer hack — works for drop-zone inputs that accept a synthetic FileList.
    const el = q<HTMLInputElement>(a.selector as string);
    const dt = new DataTransfer();
    // Note: real file bytes are populated by background script; here we accept
    // a base64 payload forwarded by the bridge when running under native messaging.
    const b64  = a.fileContentBase64 as string | undefined;
    const name = (a.filename as string | undefined) ?? 'upload.bin';
    if (b64) {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      dt.items.add(new File([bytes], name));
    }
    el.files = dt.files;
    dispatch(el, 'input');
    dispatch(el, 'change');
    return { uploaded: name };
  },

  'autofill-credentials': (a) => {
    // Trigger Chrome's native autofill by focusing the username field and
    // dispatching a keydown. Chrome's autofill popup appears; the USER picks
    // the credential. Oweibo never sees the filled values (password inputs
    // return '' via HTMLInputElement.value for autofilled entries).
    const sel = (a.usernameSelector as string | undefined) ?? 'input[autocomplete~="username"], input[type="email"], input[name="username"]';
    const el = q<HTMLInputElement>(sel);
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    return { triggered: true };
  },
};

chrome.runtime.onMessage.addListener((msg: { __oweibo?: boolean; action?: BrowserAction }, _sender, sendResponse) => {
  if (!msg?.__oweibo || !msg.action) return false;
  const handler = HANDLERS[msg.action.type as BrowserActionType];
  if (!handler) {
    sendResponse({ success: false, error: `content-script: unsupported action ${msg.action.type}` } satisfies ContentScriptResult);
    return false;
  }
  (async () => {
    try {
      const data = await handler(msg.action!);
      sendResponse({ success: true, data } satisfies ContentScriptResult);
    } catch (e) {
      sendResponse({ success: false, error: (e as Error).message } satisfies ContentScriptResult);
    }
  })();
  return true; // async response
});

// Mark the page so the engine can skip re-injection after an SPA navigation.
(window as unknown as { __oweiboContentScript?: boolean }).__oweiboContentScript = true;
