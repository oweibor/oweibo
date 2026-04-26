"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.S3StorageAdapter = exports.LocalStorageAdapter = void 0;
// packages/core-engine/src/infra/adapters/StorageAdapter.ts
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class LocalStorageAdapter {
    basePath;
    constructor(basePath) {
        this.basePath = basePath;
    }
    async put(key, data) {
        const fullPath = path.join(this.basePath, key);
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, data);
    }
    async get(key) {
        try {
            return await fs.promises.readFile(path.join(this.basePath, key));
        }
        catch {
            return null;
        }
    }
    async delete(key) {
        await fs.promises.unlink(path.join(this.basePath, key)).catch(() => { });
    }
    async list(prefix) {
        try {
            const dir = await fs.promises.readdir(this.basePath);
            return dir.filter(f => f.startsWith(prefix));
        }
        catch {
            return [];
        }
    }
}
exports.LocalStorageAdapter = LocalStorageAdapter;
// S3StorageAdapter — production cloud storage backend
class S3StorageAdapter {
    client;
    bucket;
    commandFactory;
    constructor(client, bucket, commandFactory) {
        this.client = client;
        this.bucket = bucket;
        this.commandFactory = commandFactory;
    }
    async put(key, data, meta) {
        await this.client.send(this.commandFactory.put(this.bucket, key, data, meta));
    }
    async get(key) {
        try {
            const res = await this.client.send(this.commandFactory.get(this.bucket, key));
            if (!res.Body)
                return null;
            return Buffer.from(await res.Body.transformToByteArray());
        }
        catch {
            return null;
        }
    }
    async delete(key) {
        await this.client.send(this.commandFactory.delete(this.bucket, key));
    }
    async list(prefix) {
        const res = await this.client.send(this.commandFactory.list(this.bucket, prefix));
        return (res.Contents ?? []).map(o => o.Key).filter(Boolean);
    }
}
exports.S3StorageAdapter = S3StorageAdapter;
//# sourceMappingURL=StorageAdapter.js.map