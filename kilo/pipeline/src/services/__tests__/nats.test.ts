/**
 * Unit tests for NATS client — smoke tests only (no live NATS required).
 * Tests that publish degrades gracefully when disconnected.
 */

import { describe, it, expect } from 'vitest';
import { isConnected, publish } from '../nats.js';

describe('nats client', () => {
    it('isConnected returns false before initNats is called', () => {
        expect(isConnected()).toBe(false);
    });

    it('publish is a no-op and does not throw when disconnected', async () => {
        await expect(publish('tasks.tenant-1.submit', { type: 'task-queued' })).resolves.toBeUndefined();
    });
});
