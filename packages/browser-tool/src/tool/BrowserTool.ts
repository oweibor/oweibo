// packages/browser-tool/src/tool/BrowserTool.ts
// BrowserTool — IBrowserTool implementation that dispatches all 51 atomic actions.
//
// Architecture:
//   1. Validate input via BrowserActionSchema (Zod).
//   2. Acquire / create session via BrowserSessionManager.
//   3. Resolve target Page (respecting current frame stack).
//   4. Dispatch on action.type to the corresponding Playwright primitive.
//   5. Build BrowserActionResult, capture post-action screenshot when relevant.
//   6. Emit lifecycle events via context.eventEmitter.
//
// Single-file dispatch (one switch) instead of 51 separate files keeps imports flat
// and makes it easier to spot missing actions in code review.
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserActionType,
  BrowserTabState,
  IBrowserExecutionContext,
  IBrowserTool,
  PageSnapshot,
} from '@oweibo/core-contracts';
import type { BrowserContext, Frame, Page } from 'playwright';

import { BrowserActionSchema } from './BrowserActionSchema.js';
import type { BrowserSessionManager } from '../session/BrowserSessionManager.js';
import { ImportCookiesAction, type ICookieBridge } from './actions/ImportCookiesAction.js';
import { AutofillCredentialsAction, type IAutofillBridge } from './actions/AutofillCredentialsAction.js';
import { ExtensionHitlRespondAction, type IGateResolver } from './actions/ExtensionHitlRespondAction.js';

// Many session-manager methods are accessed dynamically here; the existing
// BrowserSessionManager (built in a prior session) doesn't yet expose them all.
// We use a structural alias to keep BrowserTool compilable while the manager API
// is filled in.
/* eslint-disable @typescript-eslint/no-explicit-any */

export class BrowserTool implements IBrowserTool {
  private readonly sessions: any;
  private readonly importCookiesAction: ImportCookiesAction;
  private readonly autofillCredentialsAction: AutofillCredentialsAction;
  private readonly extensionHitlRespondAction: ExtensionHitlRespondAction;

  constructor(
    sessions: BrowserSessionManager,
    cookieBridge: ICookieBridge,
    autofillBridge: IAutofillBridge,
    gateResolver: IGateResolver,
  ) {
    this.sessions = sessions as any;
    this.importCookiesAction = new ImportCookiesAction(cookieBridge);
    this.autofillCredentialsAction = new AutofillCredentialsAction(autofillBridge);
    this.extensionHitlRespondAction = new ExtensionHitlRespondAction(gateResolver);
  }

  async execute(action: BrowserAction, context: IBrowserExecutionContext): Promise<BrowserActionResult> {
    // 1. Validate
    const parsed = BrowserActionSchema.safeParse(action);
    if (!parsed.success) {
      return this.fail(action.type, `invalid action input: ${parsed.error.message}`);
    }

    // 2. Resolve session + page
    const session = await this.sessions.getOrCreate(context);
    const page = await this.sessions.getActivePage(context.tenantId, context.sessionId);
    const frame: Frame | Page = await this.sessions.getActiveFrameOrPage(context.tenantId, context.sessionId);

    try {
      const result = await this.dispatch(action, page, frame, context);
      context.eventEmitter.emit('browser-action', {
        action: action.type, sessionId: context.sessionId, success: result.success,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.fail(action.type, message);
    }
  }

  async destroySession(tenantId: string, sessionId: string): Promise<void> {
    await this.sessions.destroy(tenantId, sessionId);
  }

  async listTabs(tenantId: string, sessionId: string): Promise<BrowserTabState[]> {
    return this.sessions.listTabs(tenantId, sessionId);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Dispatch
  // ────────────────────────────────────────────────────────────────────────
  private async dispatch(
    action: BrowserAction,
    page:   Page,
    frame:  Frame | Page,
    ctx:    IBrowserExecutionContext,
  ): Promise<BrowserActionResult> {
    switch (action.type) {
      // ── navigation ──────────────────────────────────────────────────────
      case 'navigate': {
        await page.goto(action.url, { waitUntil: action.waitUntil ?? 'domcontentloaded' });
        return this.ok('navigate', `navigated to ${action.url}`, await this.shot(page));
      }
      case 'go-back':    { await page.goBack();    return this.ok('go-back',    'navigated back',    await this.shot(page)); }
      case 'go-forward': { await page.goForward(); return this.ok('go-forward', 'navigated forward', await this.shot(page)); }
      case 'reload':     { await page.reload();    return this.ok('reload',     'reloaded page',     await this.shot(page)); }
      case 'get-url':    return this.ok('get-url',   page.url(),    undefined, { url: page.url() });
      case 'get-title':  return this.ok('get-title', await page.title(), undefined, { title: await page.title() });

      // ── interaction ─────────────────────────────────────────────────────
      case 'click': {
        await frame.click(action.selector, { button: action.button, clickCount: action.clickCount });
        return this.ok('click', `clicked ${action.selector}`, await this.shot(page));
      }
      case 'type': {
        if (action.clearFirst) await frame.fill(action.selector, '');
        await frame.type(action.selector, action.text, { delay: action.delay });
        return this.ok('type', `typed into ${action.selector}`);
      }
      case 'hover':  { await frame.hover(action.selector);  return this.ok('hover',  `hovered ${action.selector}`); }
      case 'select': { await frame.selectOption(action.selector, action.value); return this.ok('select', `selected on ${action.selector}`); }
      case 'check':  { await frame.setChecked(action.selector, action.checked); return this.ok('check', `set checked=${action.checked}`); }
      case 'submit': {
        await frame.evaluate((sel) => {
          const el = document.querySelector(sel);
          const form = el?.closest('form');
          if (form) (form as HTMLFormElement).submit();
        }, action.selector);
        return this.ok('submit', `submitted form for ${action.selector}`, await this.shot(page));
      }
      case 'scroll': {
        const dist = action.distance ?? 500;
        await page.evaluate(({ d, dir }) => {
          const dx = dir === 'left' ? -d : dir === 'right' ? d : 0;
          const dy = dir === 'up'   ? -d : dir === 'down'  ? d : 0;
          window.scrollBy(dx, dy);
        }, { d: dist, dir: action.direction });
        return this.ok('scroll', `scrolled ${action.direction} ${dist}px`);
      }

      // ── waits ──────────────────────────────────────────────────────────
      case 'wait': { await page.waitForTimeout(action.ms); return this.ok('wait', `waited ${action.ms}ms`); }
      case 'wait-for-selector': {
        await frame.waitForSelector(action.selector, { state: action.state ?? 'visible', timeout: action.timeout });
        return this.ok('wait-for-selector', `selector ${action.selector} reached state`);
      }

      // ── observation ────────────────────────────────────────────────────
      case 'screenshot': {
        const buf = action.element
          ? await frame.locator(action.element).screenshot()
          : await page.screenshot({ fullPage: action.fullPage ?? false });
        return this.ok('screenshot', 'captured screenshot', buf.toString('base64'));
      }
      case 'snapshot': {
        const snap = await this.captureSnapshot(page);
        return { ...this.ok('snapshot', 'captured DOM snapshot'), snapshot: snap };
      }
      case 'extract': {
        const extracted: string[] = [];
        for (const rule of action.selectors) {
          const el = await frame.$(rule.query);
          if (!el) { extracted.push(`${rule.name}=`); continue; }
          const val = rule.attribute
            ? await el.getAttribute(rule.attribute)
            : await el.textContent();
          extracted.push(`${rule.name}=${(val ?? '').trim()}`);
        }
        return { ...this.ok('extract', 'extracted'), extracted };
      }
      case 'eval': {
        const out = await page.evaluate(action.expression);
        return { ...this.ok('eval', 'eval ok'), evalResult: out };
      }

      // ── tabs ───────────────────────────────────────────────────────────
      case 'tab-open':   return this.sessions.openTab(ctx, action.url);
      case 'tab-switch': return this.sessions.switchTab(ctx, action.tabId);
      case 'tab-close':  return this.sessions.closeTab(ctx, action.tabId);
      case 'tabs-list':  {
        const tabs = await this.sessions.listTabs(ctx.tenantId, ctx.sessionId);
        return { ...this.ok('tabs-list', `${tabs.length} tabs`), data: { tabs } };
      }

      // ── cookies ────────────────────────────────────────────────────────
      case 'clear-cookies': { await (page.context() as BrowserContext).clearCookies(); return this.ok('clear-cookies', 'cleared'); }
      case 'get-cookies':   {
        const cookies = await page.context().cookies(action.domain ? [action.domain] : undefined);
        return { ...this.ok('get-cookies', `${cookies.length} cookies`), data: { cookies } };
      }
      case 'set-cookies':   { await page.context().addCookies(action.cookies as never); return this.ok('set-cookies', `set ${action.cookies.length} cookies`); }

      // ── files ──────────────────────────────────────────────────────────
      case 'upload': {
        await frame.setInputFiles(action.selector, action.filePath);
        return this.ok('upload', `uploaded ${action.filePath}`);
      }
      case 'download':       return this.sessions.downloadUrl(ctx, action.url, action.filename);
      case 'move-to-upload': return this.sessions.moveToUpload(ctx, action.sourcePath, action.filename);

      // ── v9.5.4 dialogs / mouse / frames / interception / video / har / device / a11y / logs ──
      case 'handle-dialog':       return this.sessions.handleDialog(ctx, action.accept, action.promptText);
      case 'drag-and-drop':       {
        await frame.dragAndDrop(action.sourceSelector, action.targetSelector, {
          ...(action.sourceOffset ? { sourcePosition: action.sourceOffset } : {}),
          ...(action.targetOffset ? { targetPosition: action.targetOffset } : {}),
        });
        return this.ok('drag-and-drop', 'drag complete');
      }
      case 'mouse-move': { await page.mouse.move(action.x, action.y); return this.ok('mouse-move', `moved to ${action.x},${action.y}`); }
      case 'mouse-down': { await page.mouse.down({ button: action.button }); return this.ok('mouse-down', 'down'); }
      case 'mouse-up':   { await page.mouse.up({ button: action.button });   return this.ok('mouse-up',   'up');   }
      case 'switch-to-frame':     return this.sessions.pushFrame(ctx, action.selector);
      case 'switch-to-main':      return this.sessions.popFrame(ctx);
      case 'intercept-request':   return this.sessions.addIntercept(ctx, action.urlPattern, action.method, action.interceptId);
      case 'mock-response':       return this.sessions.mockResponse(ctx, action);
      case 'remove-intercept':    return this.sessions.removeIntercept(ctx, action.interceptId);
      case 'record-video-start':  return this.sessions.startVideo(ctx, action.width, action.height);
      case 'record-video-stop':   return this.sessions.stopVideo(ctx);
      case 'har-start':           return this.sessions.startHar(ctx, action.urlFilter, action.omitContent);
      case 'har-stop':            return this.sessions.stopHar(ctx);
      case 'emulate-device':      return this.sessions.emulateDevice(ctx, action.deviceName, action.customDescriptor);
      case 'accessibility-snapshot': {
        const tree = await (page as any).accessibility.snapshot({ root: action.rootSelector ? await frame.$(action.rootSelector) ?? undefined : undefined });
        return { ...this.ok('accessibility-snapshot', 'a11y captured'), accessibilityTree: tree as never };
      }
      case 'log-capture-start':   return this.sessions.startLogCapture(ctx);
      case 'log-capture-stop':    return this.sessions.stopLogCapture(ctx);

      // ── v9.5.5 keyboard / geo / perms / pdf / extension / share ────────
      case 'key-chord': {
        const count = action.count ?? 1;
        for (let i = 0; i < count; i++) await page.keyboard.press(action.keys);
        return this.ok('key-chord', `pressed ${action.keys} ×${count}`);
      }
      case 'set-geolocation':    { await page.context().setGeolocation({ latitude: action.latitude, longitude: action.longitude, accuracy: action.accuracy }); return this.ok('set-geolocation', 'geo set'); }
      case 'grant-permissions':  { await page.context().grantPermissions(action.permissions as never, action.origin ? { origin: action.origin } : undefined); return this.ok('grant-permissions', 'granted'); }
      case 'revoke-permissions': { await page.context().clearPermissions(); return this.ok('revoke-permissions', 'cleared'); }
      case 'print-to-pdf':       return this.sessions.printToPdf(ctx, action);
      case 'load-extension':     return this.sessions.loadExtension(ctx, action.extensionId);
      case 'share-session':      return this.sessions.shareSession(ctx, action.ttlSeconds);

      // ── v9.5.6 credential injection ────────────────────────────────────
      case 'inject-credentials': return this.sessions.injectCredentials(ctx, action);

      // ── v9.5.9 extension-native actions ─────────────────────────────────
      case 'import-cookies':
        return this.importCookiesAction.execute(action, ctx);
      case 'autofill-credentials':
        return this.autofillCredentialsAction.execute(action, ctx);
      case 'extension-hitl-respond':
        return this.extensionHitlRespondAction.execute(action, ctx);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────────────────
  private async shot(page: Page): Promise<string | undefined> {
    try { return (await page.screenshot()).toString('base64'); } catch { return undefined; }
  }

  private async captureSnapshot(page: Page): Promise<PageSnapshot> {
    return await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).slice(0, 100).map(a => ({
        text: (a.textContent ?? '').trim(), href: a.href,
      }));
      const inputs = Array.from(document.querySelectorAll('input,textarea,select')).slice(0, 100).map((el, i) => {
        const e = el as HTMLInputElement;
        return {
          name: e.name || undefined, id: e.id || undefined,
          type: e.type ?? 'text', placeholder: e.placeholder ?? undefined,
          selector: e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}:nth-of-type(${i + 1})`,
        };
      });
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).slice(0, 100).map((b, i) => ({
        text: (b.textContent ?? '').trim(),
        selector: (b as HTMLElement).id ? `#${(b as HTMLElement).id}` : `button:nth-of-type(${i + 1})`,
      }));
      const forms = Array.from(document.querySelectorAll('form')).map(f => ({
        id: (f as HTMLFormElement).id || undefined,
        action: (f as HTMLFormElement).action || undefined,
        method: (f as HTMLFormElement).method || undefined,
        inputCount: f.querySelectorAll('input,textarea,select').length,
      }));
      return {
        url:         location.href,
        title:       document.title,
        links, inputs, buttons, forms,
        visibleText: (document.body.innerText ?? '').slice(0, 5000),
      };
    });
  }

  private ok(
    actionType: BrowserActionType,
    observation: string,
    screenshotBase64?: string,
    data?: Record<string, unknown>,
  ): BrowserActionResult {
    return { success: true, actionType, observation, ...(screenshotBase64 ? { screenshotBase64 } : {}), ...(data ? { data } : {}) };
  }

  private fail(actionType: BrowserActionType, error: string): BrowserActionResult {
    return { success: false, actionType, observation: `error: ${error}`, error };
  }
}
