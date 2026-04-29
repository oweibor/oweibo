/**
 * Shared SSRF guard for outbound fetch targets supplied by clients.
 *
 * Rejects URLs that resolve to private / loopback / link-local / cloud-metadata
 * IPs. DNS is resolved once — the resolved IP is what the caller connects to so
 * DNS-rebinding cannot swap a public IP at validation time for a private one at
 * fetch time.
 *
 * @module ssrfGuard
 */

import * as dns from 'dns';
import * as net from 'net';

const dnsPromises = dns.promises;

function isPrivateIp(ip: string): boolean {
    if (typeof ip !== 'string') return true;
    const v = net.isIP(ip);
    if (v === 0) return true;

    if (v === 4) {
        const parts = ip.split('.').map(p => parseInt(p, 10));
        if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return true;
        const [a, b] = parts as [number, number, number, number];
        if (a === 10)                              return true; // 10.0.0.0/8
        if (a === 127)                             return true; // loopback
        if (a === 0)                               return true; // 0.0.0.0/8
        if (a === 169 && b === 254)                return true; // link-local / cloud metadata
        if (a === 172 && b >= 16 && b <= 31)       return true; // 172.16.0.0/12
        if (a === 192 && b === 168)                return true; // 192.168.0.0/16
        if (a >= 224)                              return true; // multicast / reserved
        return false;
    }

    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd'))   return true; // fc00::/7
    if (lower.startsWith('::ffff:')) {
        const mapped = lower.slice(7);
        if (net.isIP(mapped) === 4) return isPrivateIp(mapped);
    }
    return false;
}

export interface SafeTarget {
    url: URL;
    hostHeader: string;
    resolvedIps: string[];
}

export async function assertSafeTarget(raw: string): Promise<SafeTarget> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        const err: any = new Error('Invalid URL');
        err.statusCode = 400; err.code = 'invalid_url';
        throw err;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        const err: any = new Error(`Scheme not allowed: ${url.protocol}`);
        err.statusCode = 400; err.code = 'blocked_scheme';
        throw err;
    }

    if (url.username || url.password) {
        const err: any = new Error('URL must not contain userinfo');
        err.statusCode = 400; err.code = 'blocked_userinfo';
        throw err;
    }

    if (net.isIP(url.hostname)) {
        if (isPrivateIp(url.hostname)) {
            const err: any = new Error(`Target IP is private: ${url.hostname}`);
            err.statusCode = 400; err.code = 'blocked_target';
            throw err;
        }
        return { url, hostHeader: url.hostname, resolvedIps: [url.hostname] };
    }

    let ips: string[] = [];
    try {
        const [v4, v6] = await Promise.all([
            dnsPromises.resolve4(url.hostname).catch((): string[] => []),
            dnsPromises.resolve6(url.hostname).catch((): string[] => []),
        ]);
        ips = [...v4, ...v6];
    } catch {
        const err: any = new Error('DNS resolution failed');
        err.statusCode = 400; err.code = 'dns_failed';
        throw err;
    }

    if (ips.length === 0) {
        const err: any = new Error(`No IPs resolved for ${url.hostname}`);
        err.statusCode = 400; err.code = 'dns_empty';
        throw err;
    }

    for (const ip of ips) {
        if (isPrivateIp(ip)) {
            const err: any = new Error(`Target resolves to private IP: ${ip}`);
            err.statusCode = 400; err.code = 'blocked_target';
            throw err;
        }
    }

    return { url, hostHeader: url.hostname, resolvedIps: ips };
}
