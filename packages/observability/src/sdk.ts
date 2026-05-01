/**
 * OTel Node SDK initialization.
 * Call initOtel(serviceName) ONCE at process start, before other imports.
 * Uses the no-op tracer when SDK is not initialized — safe to skip in tests.
 */
import { NodeSDK }           from '@opentelemetry/sdk-node';
import { Resource }           from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter }  from '@opentelemetry/exporter-trace-otlp-grpc';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

let _sdk: NodeSDK | null = null;

export interface OtelOptions {
  otlpEndpoint?:    string;
  prometheusPort?:  number;
  captureMessages?: boolean;
}

export function initOtel(serviceName: string, opts: OtelOptions = {}): NodeSDK {
  if (_sdk) return _sdk;

  const endpoint    = opts.otlpEndpoint   ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317';
  const promPort    = opts.prometheusPort  ?? parseInt(process.env['OTEL_PROMETHEUS_PORT'] ?? '9464');
  const captureMsg  = opts.captureMessages ?? process.env['NODE_ENV'] !== 'production';

  // Policy: never log message bodies in production traces (PII safety)
  process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] =
    captureMsg ? 'true' : 'false';

  const sdk = new NodeSDK({
    resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    metricReader:  new PrometheusExporter({ port: promPort }),
  });

  sdk.start();
  process.on('SIGTERM', () => sdk.shutdown().catch(() => undefined));
  _sdk = sdk;
  return sdk;
}

// Exposed for test teardown only
export function resetSdk(): void { _sdk = null; }
