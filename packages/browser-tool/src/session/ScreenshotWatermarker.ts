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

import { createHmac } from 'crypto';
import type { ScreenshotWatermarkMetadata } from '@oweibo/core-contracts';
import type { ILogger } from './SessionReaper.js';

interface IVaultClient {
  read(path: string): Promise<unknown>;
  readOptional(path: string): Promise<unknown>;
}

export class ScreenshotWatermarker {
  constructor(
    private readonly vault: IVaultClient,
    private readonly logger: ILogger,
  ) {}

  async watermark(
    pngBase64: string,
    ctx: {
      tenantId: string;
      sessionId: string;
      taskId: string;
      actionType: string;
    },
  ): Promise<string> {
    if (!(await this.isEnabled(ctx.tenantId))) return pngBase64;
    const secret = await this.vault.read(
      'oweibo/infra/browser/screenshot-hmac-secret',
    ) as string;
    const timestamp = Date.now().toString();
    const payload = `${ctx.tenantId}:${ctx.sessionId}:${ctx.taskId}:${ctx.actionType}:${timestamp}`;
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    const meta: ScreenshotWatermarkMetadata = { v: '1', payload, signature };
    this.logger.debug(
      { tenantId: ctx.tenantId, taskId: ctx.taskId },
      'Screenshot watermarked.',
    );
    return this.embedPngText(pngBase64, meta);
  }

  private async isEnabled(tenantId: string): Promise<boolean> {
    const flag = await this.vault.readOptional(
      `oweibo/tenants/${tenantId}/browser/audit-watermark-enabled`,
    );
    return flag === true;
  }

  /**
   * Inserts a tEXt chunk after the PNG IHDR chunk (offset 33).
   * Layout: 8-byte PNG sig | 25-byte IHDR chunk | [tEXt chunk] | remaining chunks.
   * CRC-32 is computed per PNG spec (ISO/IEC 15948).
   */
  private embedPngText(pngBase64: string, meta: ScreenshotWatermarkMetadata): string {
    const buf = Buffer.from(pngBase64, 'base64');
    const keyword = Buffer.from('oweibo-audit\0');
    const text = Buffer.from(JSON.stringify(meta));
    const chunkData = Buffer.concat([keyword, text]);
    const chunkType = Buffer.from('tEXt');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunkData.length, 0);
    const crcInput = Buffer.concat([chunkType, chunkData]);
    const crcVal = this.crc32(crcInput);
    const crcOut = Buffer.alloc(4);
    crcOut.writeUInt32BE(crcVal, 0);
    const chunk = Buffer.concat([length, chunkType, chunkData, crcOut]);
    const result = Buffer.concat([buf.slice(0, 33), chunk, buf.slice(33)]);
    return result.toString('base64');
  }

  private crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of buf) {
      crc ^= byte;
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
}
