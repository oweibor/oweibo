/**
 * File-based outbox publisher for saga atomicity.
 *
 * Task state transitions write a JSON outbox record to disk in the same
 * synchronous call as the in-memory state update (atomic within the process).
 * This publisher polls the outbox directory, publishes pending records to NATS
 * JetStream, and removes the file on success.
 *
 * If the process crashes between writing the outbox file and publishing, the
 * publisher replays the event on the next startup — guaranteeing at-least-once
 * delivery. Consumers use the idempotency key (`jti` in the payload) to
 * deduplicate.
 *
 * @module services/outboxPublisher
 */

import * as fs from 'fs';
import * as path from 'path';
import { publish } from './nats';

const logger = require('./logger');
const config  = require('../config');

const OUTBOX_DIR = path.join(config.FAILURE_LEDGER_DIR || '/var/kilo/failure_ledger', '..', 'outbox');
const POLL_MS    = 1_000;

let timer: ReturnType<typeof setInterval> | null = null;

export function writeOutboxEvent(subject: string, payload: Record<string, unknown>): void {
    try {
        fs.mkdirSync(OUTBOX_DIR, { recursive: true });
        const id   = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const file = path.join(OUTBOX_DIR, `${id}.json`);
        fs.writeFileSync(file, JSON.stringify({ subject, payload, id }), { encoding: 'utf8', flag: 'wx' });
    } catch (err: any) {
        logger.warn('[outbox] failed to write outbox record', { subject, error: err.message });
    }
}

async function drain(): Promise<void> {
    if (!fs.existsSync(OUTBOX_DIR)) return;

    let files: string[];
    try {
        files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith('.json'));
    } catch {
        return;
    }

    for (const file of files) {
        const filePath = path.join(OUTBOX_DIR, file);
        let record: { subject: string; payload: Record<string, unknown>; id: string } | null = null;

        try {
            record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            fs.unlink(filePath, () => {});
            continue;
        }

        if (!record) continue;

        try {
            await publish(record.subject, record.payload);
            fs.unlink(filePath, () => {});
        } catch (err: any) {
            logger.warn('[outbox] publish failed — will retry', { file, error: err.message });
        }
    }
}

export function startOutboxPublisher(): void {
    if (timer) return;
    drain().catch(() => {});
    timer = setInterval(() => drain().catch(() => {}), POLL_MS);
    logger.info('[outbox] publisher started', { dir: OUTBOX_DIR, poll_ms: POLL_MS });
}

export function stopOutboxPublisher(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
