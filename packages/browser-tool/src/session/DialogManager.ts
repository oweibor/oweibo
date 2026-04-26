/**
 * DialogManager — attaches to a BrowserContext and handles native browser dialogs.
 * (NEW v9.5.4)
 *
 * - Automatically handles dialogs per DialogAutoPolicy.
 * - For HITL dialogs, parks them in a pending map and emits browser-dialog-pending.
 * - A 60-second safety timeout dismisses any unhandled dialog to prevent page lock.
 */

import type {
  BrowserDialogEvent,
  BrowserDialogType,
  DialogAnswer,
  IBrowserEventEmitter,
  PendingDialog,
} from '@oweibo/core-contracts';
import type { DialogAutoPolicy } from './DialogAutoPolicy.js';

export class DialogManager {
  private readonly pending = new Map<string, PendingDialog>();

  /**
   * Attach dialog listeners to a Playwright BrowserContext.
   * context is typed as `any` to avoid importing Playwright in the contract layer.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachToContext(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: any,
    sessionId: string,
    tenantId: string,
    taskId: string,
    emitter: IBrowserEventEmitter,
    policy: DialogAutoPolicy,
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context.on('dialog', async (dialog: any) => {
      const event: BrowserDialogEvent = {
        type: dialog.type() as BrowserDialogType,
        message: dialog.message(),
        defaultValue: dialog.type() === 'prompt' ? dialog.defaultValue() : undefined,
        sessionId,
        tenantId,
        taskId,
      };

      if (policy.shouldAutoHandle(event)) {
        const answer = policy.resolve(event);
        if (answer.accept) {
          await dialog.accept(answer.promptText ?? '');
        } else {
          await dialog.dismiss();
        }
        emitter.emit('browser-dialog-auto-handled', { event, answer });
        return;
      }

      const dialogId = crypto.randomUUID();
      emitter.emit('browser-dialog-pending', { dialogId, event });

      await new Promise<void>((resolve) => {
        const pending: PendingDialog = {
          dialogId,
          event,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          resolve: async (answer: DialogAnswer) => {
            if (answer.accept) {
              await dialog.accept(answer.promptText ?? '');
            } else {
              await dialog.dismiss();
            }
            resolve();
          },
        };
        this.pending.set(sessionId, pending);

        // 60-second safety timeout — prevents permanent page lock on missed handle-dialog
        setTimeout(async () => {
          if (this.pending.has(sessionId)) {
            try { await dialog.dismiss(); } catch { /* already dismissed */ }
            this.pending.delete(sessionId);
            emitter.emit('browser-dialog-timeout', { dialogId, event });
            resolve();
          }
        }, 60_000);
      });
    });
  }

  async resolve(sessionId: string, answer: DialogAnswer): Promise<boolean> {
    const pending = this.pending.get(sessionId);
    if (!pending) return false;
    this.pending.delete(sessionId);
    await (pending.resolve as (a: DialogAnswer) => Promise<void>)(answer);
    return true;
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  getPending(sessionId: string): PendingDialog | undefined {
    return this.pending.get(sessionId);
  }
}
