"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initOtel = initOtel;
exports.resetSdk = resetSdk;
/**
 * OTel Node SDK initialization.
 * Call initOtel(serviceName) ONCE at process start, before other imports.
 * Uses the no-op tracer when SDK is not initialized — safe to skip in tests.
 */
const sdk_node_1 = require("@opentelemetry/sdk-node");
const resources_1 = require("@opentelemetry/resources");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const exporter_trace_otlp_grpc_1 = require("@opentelemetry/exporter-trace-otlp-grpc");
const exporter_prometheus_1 = require("@opentelemetry/exporter-prometheus");
let _sdk = null;
function initOtel(serviceName, opts = {}) {
    if (_sdk)
        return _sdk;
    const endpoint = opts.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4317';
    const promPort = opts.prometheusPort ?? parseInt(process.env['OTEL_PROMETHEUS_PORT'] ?? '9464');
    const captureMsg = opts.captureMessages ?? process.env['NODE_ENV'] !== 'production';
    // Policy: never log message bodies in production traces (PII safety)
    process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] =
        captureMsg ? 'true' : 'false';
    const sdk = new sdk_node_1.NodeSDK({
        resource: new resources_1.Resource({ [semantic_conventions_1.SEMRESATTRS_SERVICE_NAME]: serviceName }),
        traceExporter: new exporter_trace_otlp_grpc_1.OTLPTraceExporter({ url: endpoint }),
        metricReader: new exporter_prometheus_1.PrometheusExporter({ port: promPort }),
    });
    sdk.start();
    process.on('SIGTERM', () => sdk.shutdown().catch(() => undefined));
    _sdk = sdk;
    return sdk;
}
// Exposed for test teardown only
function resetSdk() { _sdk = null; }
//# sourceMappingURL=sdk.js.map