/**
 * NATS JetStream client for kilo-pipeline.
 *
 * Provides a single shared JetStream context for all task event publishing.
 * Streams are created on first use if they do not already exist.
 *
 * Subjects:
 *   tasks.<tenantId>.submit   — new task accepted
 *   tasks.<tenantId>.events.* — task state transitions (running, completed, failed, blocked)
 *
 * @module services/nats
 */

import type { NatsConnection, JetStreamClient, JetStreamManager } from 'nats';

const { connect, StringCodec, RetentionPolicy, StorageType, AckPolicy, DeliverPolicy } = require('nats');
const logger = require('./logger');
const config = require('../config');

const sc = StringCodec();

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let jsm: JetStreamManager | null = null;

const TASK_STREAM = 'tasks';

async function ensureStream(): Promise<void> {
    if (!jsm) throw new Error('NATS not initialised');
    try {
        await jsm.streams.info(TASK_STREAM);
    } catch {
        await jsm.streams.add({
            name: TASK_STREAM,
            subjects: [`tasks.>`],
            retention: RetentionPolicy.Limits,
            storage: StorageType.File,
            max_age: 86_400_000_000_000, // 24h in nanoseconds for events
            num_replicas: 1,
        });
        logger.info('[nats] created stream', { stream: TASK_STREAM });
    }
}

export async function initNats(): Promise<void> {
    const url = config.NATS_URL || 'nats://localhost:4222';
    nc = await connect({ servers: url });
    js  = nc.jetstream();
    jsm = await nc.jetstreamManager();
    await ensureStream();
    logger.info('[nats] connected', { url });
}

export async function publish(subject: string, payload: Record<string, unknown>): Promise<void> {
    if (!js) {
        logger.warn('[nats] publish skipped — not connected', { subject });
        return;
    }
    try {
        await js.publish(subject, sc.encode(JSON.stringify(payload)));
    } catch (err: any) {
        logger.warn('[nats] publish failed', { subject, error: err.message });
    }
}

export async function drainNats(): Promise<void> {
    if (nc) {
        await nc.drain();
        nc = null; js = null; jsm = null;
    }
}

export function isConnected(): boolean {
    return nc !== null && !nc.isClosed();
}
