import { describe, it, expect } from 'vitest';
import { createLogger } from '../logger.js';

describe('createLogger', () => {
  it('creates a usable pino logger', () => {
    const log = createLogger('test-service');
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('returns distinct instances per service', () => {
    const a = createLogger('service-a');
    const b = createLogger('service-b');
    expect(a).not.toBe(b);
  });

  it('captures log level from LOG_LEVEL env', () => {
    const original = process.env['LOG_LEVEL'];
    process.env['LOG_LEVEL'] = 'debug';
    const log = createLogger('debug-service');
    expect(log.level).toBe('debug');
    process.env['LOG_LEVEL'] = original;
  });
});
