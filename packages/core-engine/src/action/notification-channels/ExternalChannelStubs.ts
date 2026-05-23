/**
 * S.1: Slack, Email, and Webhook channel stubs.
 *
 * These ship as no-op stubs that always report 'failed' so the router's
 * in-app fallback fires every time. Real implementations come online once
 * the per-tenant connector wiring (Slack T.2.f, email connectors, webhook
 * sinks) is in place — at which point each stub is swapped for the real
 * adapter. The interface stays stable.
 *
 * Each stub is constructible without any external dependency so the
 * router can be instantiated in tests / dev environments.
 */
import type {
  DispatchResult,
  INotificationChannel,
  NotificationDispatchRequest,
} from '@oweibo/core-contracts';

abstract class StubChannel implements INotificationChannel {
  abstract readonly kind: 'slack' | 'email' | 'webhook';
  async dispatch(_req: NotificationDispatchRequest): Promise<DispatchResult> {
    return { status: 'failed', error: `${this.kind} channel not wired (S.1 stub)` };
  }
}

export class SlackChannel extends StubChannel {
  readonly kind = 'slack' as const;
}

export class EmailChannel extends StubChannel {
  readonly kind = 'email' as const;
}

export class WebhookChannel extends StubChannel {
  readonly kind = 'webhook' as const;
}
