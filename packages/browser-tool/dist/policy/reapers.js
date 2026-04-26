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
exports.ClamAvFreshnessJob = exports.PdfReaper = exports.HarReaper = exports.VideoReaper = void 0;
// packages/browser-tool/src/policy/reapers.ts
// Periodic janitors (§7.4) — delete videos / HARs / PDFs older than the retention
// window. Wired into the SessionReaper schedule.
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const DAY_MS = 24 * 60 * 60 * 1000;
async function reapDir(dir, maxAgeMs) {
    let removed = 0;
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const e of entries) {
        if (!e.isFile())
            continue;
        const full = path.join(dir, e.name);
        try {
            const st = await fs.stat(full);
            if (Date.now() - st.mtimeMs > maxAgeMs) {
                await fs.unlink(full);
                removed++;
            }
        }
        catch { /* ignore */ }
    }
    return removed;
}
class VideoReaper {
    dir;
    retentionDays;
    constructor(dir, retentionDays = 7) {
        this.dir = dir;
        this.retentionDays = retentionDays;
    }
    reap() { return reapDir(this.dir, this.retentionDays * DAY_MS); }
}
exports.VideoReaper = VideoReaper;
class HarReaper {
    dir;
    retentionDays;
    constructor(dir, retentionDays = 7) {
        this.dir = dir;
        this.retentionDays = retentionDays;
    }
    reap() { return reapDir(this.dir, this.retentionDays * DAY_MS); }
}
exports.HarReaper = HarReaper;
class PdfReaper {
    dir;
    retentionDays;
    constructor(dir, retentionDays = 14) {
        this.dir = dir;
        this.retentionDays = retentionDays;
    }
    reap() { return reapDir(this.dir, this.retentionDays * DAY_MS); }
}
exports.PdfReaper = PdfReaper;
class ClamAvFreshnessJob {
    clamAvSocketPath;
    constructor(clamAvSocketPath) {
        this.clamAvSocketPath = clamAvSocketPath;
    }
    async run() {
        // Stub: ping ClamAV daemon and check signature db timestamp.
        return { ok: true, freshness: new Date().toISOString() };
    }
}
exports.ClamAvFreshnessJob = ClamAvFreshnessJob;
//# sourceMappingURL=reapers.js.map