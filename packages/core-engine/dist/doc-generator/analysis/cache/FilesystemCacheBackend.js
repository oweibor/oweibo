"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FilesystemCacheBackend = void 0;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const CACHE_SCHEMA = 'oweibo.doc-analyzer-cache/v1';
/**
 * Filesystem backend for DocAnalyzerCache (C5, v10.5).
 *
 * Writes via write-to-temp → rename (atomic on POSIX).
 * Concurrent-writer serialisation via a simple in-process mutex (advisory).
 * On EROFS or any persistent write failure, the caller should fall back to
 * RedisCacheBackend or NullCacheBackend and emit CACHE_BACKEND_FALLBACK.
 */
class FilesystemCacheBackend {
    cachePath;
    logger;
    writing = false;
    writeQueue = [];
    constructor(cachePath, logger) {
        this.cachePath = cachePath;
        this.logger = logger;
    }
    async transaction(_key, fn) {
        await this.acquireLock();
        try {
            const current = await this.readSafe();
            const updated = fn(current);
            await this.writeSafe(updated);
        }
        finally {
            this.releaseLock();
        }
    }
    async get(key) {
        const all = await this.readSafe();
        return all[key];
    }
    async getAll() {
        return this.readSafe();
    }
    async clear() {
        await this.acquireLock();
        try {
            await this.writeSafe({});
        }
        finally {
            this.releaseLock();
        }
    }
    async readSafe() {
        try {
            const raw = await promises_1.default.readFile(this.cachePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.$schema !== CACHE_SCHEMA) {
                this.logger.warn({ schema: parsed.$schema }, 'CACHE_SCHEMA_MISMATCH: treating as empty');
                return {};
            }
            return parsed.entries ?? {};
        }
        catch {
            return {};
        }
    }
    async writeSafe(entries) {
        const dir = node_path_1.default.dirname(this.cachePath);
        await promises_1.default.mkdir(dir, { recursive: true });
        const tmp = `${this.cachePath}.tmp.${process.pid}.${node_crypto_1.default.randomBytes(4).toString('hex')}`;
        const payload = JSON.stringify({ $schema: CACHE_SCHEMA, entries }, null, 2);
        await promises_1.default.writeFile(tmp, payload, 'utf-8');
        await promises_1.default.rename(tmp, this.cachePath);
    }
    acquireLock() {
        if (!this.writing) {
            this.writing = true;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.writeQueue.push(resolve));
    }
    releaseLock() {
        const next = this.writeQueue.shift();
        if (next) {
            next();
        }
        else {
            this.writing = false;
        }
    }
}
exports.FilesystemCacheBackend = FilesystemCacheBackend;
//# sourceMappingURL=FilesystemCacheBackend.js.map