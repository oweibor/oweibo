/**
 * OTel Node SDK initialization.
 * Call initOtel(serviceName) ONCE at process start, before other imports.
 * Uses the no-op tracer when SDK is not initialized — safe to skip in tests.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
export interface OtelOptions {
    otlpEndpoint?: string;
    prometheusPort?: number;
    captureMessages?: boolean;
}
export declare function initOtel(serviceName: string, opts?: OtelOptions): NodeSDK;
export declare function resetSdk(): void;
//# sourceMappingURL=sdk.d.ts.map