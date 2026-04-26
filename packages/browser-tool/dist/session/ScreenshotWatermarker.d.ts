/**
 * ScreenshotWatermarker — embeds HMAC-SHA256 signature into PNG tEXt chunk.
 * (NEW v9.5.5)
 *
 * Embeds a tamper-evident HMAC-SHA256 signature into every screenshot PNG.
 * The watermark is a standard PNG tEXt chunk (keyword "oweibo-audit") inserted
 * after the IHDR chunk. Pixel data is completely unchanged.
 *
 * Enabled per-tenant via Vault: oweibo/tenants/{tenantId}/browser/audit-watermark-enabled
 */
import type { ILogger } from './SessionReaper.js';
interface IVaultClient {
    read(path: string): Promise<unknown>;
    readOptional(path: string): Promise<unknown>;
}
export declare class ScreenshotWatermarker {
    private readonly vault;
    private readonly logger;
    constructor(vault: IVaultClient, logger: ILogger);
    watermark(pngBase64: string, ctx: {
        tenantId: string;
        sessionId: string;
        taskId: string;
        actionType: string;
    }): Promise<string>;
    private isEnabled;
    /**
     * Inserts a tEXt chunk after the PNG IHDR chunk (offset 33).
     * Layout: 8-byte PNG sig | 25-byte IHDR chunk | [tEXt chunk] | remaining chunks.
     * CRC-32 is computed per PNG spec (ISO/IEC 15948).
     */
    private embedPngText;
    private crc32;
}
export {};
//# sourceMappingURL=ScreenshotWatermarker.d.ts.map