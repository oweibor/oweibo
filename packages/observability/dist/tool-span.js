"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withToolSpan = withToolSpan;
const api_1 = require("@opentelemetry/api");
const crypto_1 = require("crypto");
const genai_js_1 = require("./genai.js");
const tracer = api_1.trace.getTracer('oweibo', '0.6.0');
/**
 * Wraps a ToolRegistry.invoke() call in an execute_tool OTel span.
 * A unique callId is generated if not provided.
 */
async function withToolSpan(opts, taskCtx, fn) {
    return tracer.startActiveSpan(genai_js_1.OPERATION.EXECUTE_TOOL, { kind: api_1.SpanKind.INTERNAL }, async (span) => {
        span.setAttributes({
            [genai_js_1.GENAI.OPERATION_NAME]: genai_js_1.OPERATION.EXECUTE_TOOL,
            [genai_js_1.GENAI.TOOL_NAME]: opts.toolName,
            [genai_js_1.GENAI.TOOL_CALL_ID]: opts.callId ?? (0, crypto_1.randomUUID)(),
            [genai_js_1.GENAI.TOOL_TYPE]: opts.toolType,
            [genai_js_1.OWEIBO.TENANT_ID]: taskCtx.tenantId,
            [genai_js_1.OWEIBO.USER_ID]: taskCtx.userId,
            [genai_js_1.OWEIBO.TASK_ID]: taskCtx.taskId,
        });
        try {
            const result = await fn();
            span.setStatus({ code: api_1.SpanStatusCode.OK });
            return result;
        }
        catch (err) {
            span.recordException(err);
            span.setStatus({ code: api_1.SpanStatusCode.ERROR, message: String(err) });
            throw err;
        }
        finally {
            span.end();
        }
    });
}
//# sourceMappingURL=tool-span.js.map