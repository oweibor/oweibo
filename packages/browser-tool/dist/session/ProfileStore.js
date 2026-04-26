"use strict";
/**
 * ProfileStore — IProfileStore + S3ProfileStore + LocalProfileStore.
 * (NEW v9.5.7)
 *
 * Abstraction over object storage for Chromium user-data-dir archives.
 * Compression: tar + zstd (level 3 default).
 */
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
exports.LocalProfileStore = exports.S3ProfileStore = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const path = __importStar(require("path"));
const fs = __importStar(require("fs/promises"));
const errors_js_1 = require("../contracts/errors.js");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
let GetObjectCommand;
let PutObjectCommand;
let DeleteObjectCommand;
let HeadObjectCommand;
async function lazyLoadS3Commands() {
    if (GetObjectCommand)
        return;
    try {
        const mod = await import('@aws-sdk/client-s3');
        GetObjectCommand = mod.GetObjectCommand;
        PutObjectCommand = mod.PutObjectCommand;
        DeleteObjectCommand = mod.DeleteObjectCommand;
        HeadObjectCommand = mod.HeadObjectCommand;
    }
    catch {
        throw new Error('@aws-sdk/client-s3 is required for S3ProfileStore. Install it with: pnpm add @aws-sdk/client-s3');
    }
}
class S3ProfileStore {
    s3;
    bucket;
    maxSizeBytes;
    logger;
    constructor(s3, bucket, maxSizeBytes, // default 200 MB
    logger) {
        this.s3 = s3;
        this.bucket = bucket;
        this.maxSizeBytes = maxSizeBytes;
        this.logger = logger;
    }
    async restore(profileKey, targetDir) {
        await lazyLoadS3Commands();
        const key = this.s3Key(profileKey);
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { Body } = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            if (!Body)
                return false;
            await fs.mkdir(targetDir, { recursive: true });
            await this.extractStream(Body, targetDir);
            this.logger.info({ profileKey, targetDir }, 'Profile restored from S3.');
            return true;
        }
        catch (err) {
            if (err.name === 'NoSuchKey')
                return false;
            throw err;
        }
    }
    async snapshot(profileKey, sourceDir) {
        await lazyLoadS3Commands();
        const archive = await this.compress(sourceDir);
        if (archive.byteLength > this.maxSizeBytes) {
            throw new errors_js_1.BrowserPolicyViolationError(`Profile snapshot aborted: ${archive.byteLength} bytes exceeds limit of ${this.maxSizeBytes}.`);
        }
        await this.s3.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.s3Key(profileKey),
            Body: archive,
            ContentType: 'application/zstd',
            ContentLength: archive.byteLength,
        }));
        this.logger.info({ profileKey, sizeBytes: archive.byteLength }, 'Profile snapshotted to S3.');
        return { sizeBytes: archive.byteLength };
    }
    async delete(profileKey) {
        await lazyLoadS3Commands();
        await this.s3.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this.s3Key(profileKey),
        }));
    }
    async exists(profileKey) {
        await lazyLoadS3Commands();
        try {
            await this.s3.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: this.s3Key(profileKey),
            }));
            return true;
        }
        catch {
            return false;
        }
    }
    s3Key(profileKey) {
        return `profiles/${profileKey.replace(/[:/\\]/g, '-')}.tar.zst`;
    }
    async compress(sourceDir) {
        return new Promise((resolve, reject) => {
            (0, child_process_1.execFile)('sh', ['-c', `tar -C "${sourceDir}" -cf - . | zstd -3 -`], { maxBuffer: 300 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async extractStream(stream, targetDir) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)('sh', ['-c', `zstd -d | tar -xf - -C "${targetDir}"`]);
            stream.pipe(child.stdin);
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`extract exited ${code}`)));
        });
    }
}
exports.S3ProfileStore = S3ProfileStore;
// ── LocalProfileStore ──────────────────────────────────────────────────────────
class LocalProfileStore {
    baseDir;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    archivePath(profileKey) {
        return path.join(this.baseDir, profileKey.replace(/[:/\\]/g, '-') + '.tar.zst');
    }
    async restore(profileKey, targetDir) {
        const archive = this.archivePath(profileKey);
        try {
            await fs.access(archive);
        }
        catch {
            return false;
        }
        await fs.mkdir(targetDir, { recursive: true });
        await execFileAsync('sh', ['-c', `zstd -d < "${archive}" | tar -xf - -C "${targetDir}"`]);
        return true;
    }
    async snapshot(profileKey, sourceDir) {
        await fs.mkdir(this.baseDir, { recursive: true });
        const archive = this.archivePath(profileKey);
        await execFileAsync('sh', ['-c', `tar -C "${sourceDir}" -cf - . | zstd -3 > "${archive}"`]);
        const { size } = await fs.stat(archive);
        return { sizeBytes: size };
    }
    async delete(profileKey) {
        await fs.rm(this.archivePath(profileKey), { force: true });
    }
    async exists(profileKey) {
        try {
            await fs.access(this.archivePath(profileKey));
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.LocalProfileStore = LocalProfileStore;
//# sourceMappingURL=ProfileStore.js.map