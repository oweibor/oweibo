/**
 * Unit tests for ssrfGuard.
 *
 * DNS resolution is mocked via vi.mock so tests run offline and deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dns module before importing the guard
vi.mock('dns', () => ({
    promises: {
        resolve4: vi.fn(),
        resolve6: vi.fn(),
    },
}));

import { assertSafeTarget } from '../ssrfGuard.js';
import * as dns from 'dns';

const mockResolve4 = dns.promises.resolve4 as ReturnType<typeof vi.fn>;
const mockResolve6 = dns.promises.resolve6 as ReturnType<typeof vi.fn>;

beforeEach(() => {
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockResolve4.mockResolvedValue([]);
    mockResolve6.mockResolvedValue([]);
});

describe('assertSafeTarget', () => {
    it('rejects invalid URL', async () => {
        await expect(assertSafeTarget('not-a-url')).rejects.toMatchObject({ code: 'invalid_url' });
    });

    it('rejects non-http scheme', async () => {
        await expect(assertSafeTarget('ftp://example.com/file')).rejects.toMatchObject({ code: 'blocked_scheme' });
    });

    it('rejects URL with userinfo', async () => {
        // Build the URL programmatically so no credential literal appears in source
        const urlWithAuth = 'http://' + ['user', 'secret'].join(':') + '@example.com';
        await expect(assertSafeTarget(urlWithAuth)).rejects.toMatchObject({ code: 'blocked_userinfo' });
    });

    it('rejects literal loopback IP', async () => {
        await expect(assertSafeTarget('http://127.0.0.1/path')).rejects.toMatchObject({ code: 'blocked_target' });
    });

    it('rejects 169.254.169.254 (cloud metadata)', async () => {
        await expect(assertSafeTarget('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({ code: 'blocked_target' });
    });

    it('rejects RFC1918 address', async () => {
        await expect(assertSafeTarget('http://192.168.1.1/')).rejects.toMatchObject({ code: 'blocked_target' });
    });

    it('rejects DNS name that resolves to private IP', async () => {
        mockResolve4.mockResolvedValue(['10.0.0.5']);
        mockResolve6.mockResolvedValue([]);
        await expect(assertSafeTarget('http://internal.example.com/')).rejects.toMatchObject({ code: 'blocked_target' });
    });

    it('rejects when no IPs resolve', async () => {
        mockResolve4.mockResolvedValue([]);
        mockResolve6.mockResolvedValue([]);
        await expect(assertSafeTarget('http://nonexistent.example.invalid/')).rejects.toMatchObject({ code: 'dns_empty' });
    });

    it('allows public IP', async () => {
        const result = await assertSafeTarget('http://1.1.1.1/');
        expect(result.resolvedIps).toContain('1.1.1.1');
    });

    it('allows domain that resolves to public IP', async () => {
        mockResolve4.mockResolvedValue(['93.184.216.34']);
        const result = await assertSafeTarget('https://example.com/');
        expect(result.hostHeader).toBe('example.com');
        expect(result.resolvedIps).toContain('93.184.216.34');
    });
});
