"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withAgentSpan = withAgentSpan;
const api_1 = require("@opentelemetry/api");
const genai_js_1 = require("./genai.js");
const tracer = api_1.trace.getTracer('oweibo', '0.6.0');
/**
 * Wraps a pipeline stage function in an invoke_agent OTel span.
 * All required GenAI + oweibo.* attributes are set automatically.
 * Uses no-op spans when no SDK is initialized (safe in tests).
 */
async function withAgentSpan(agentId, taskCtx, fn) {
    return tracer.startActiveSpan(genai_js_1.OPERATION.INVOKE_AGENT, { kind: api_1.SpanKind.INTERNAL }, async (span) => {
        span.setAttributes({
            [genai_js_1.GENAI.OPERATION_NAME]: genai_js_1.OPERATION.INVOKE_AGENT,
            [genai_js_1.GENAI.AGENT_ID]: agentId,
            [genai_js_1.OWEIBO.TENANT_ID]: taskCtx.tenantId,
            [genai_js_1.OWEIBO.USER_ID]: taskCtx.userId,
            [genai_js_1.OWEIBO.TASK_ID]: taskCtx.taskId,
            ...(taskCtx.runId ? { [genai_js_1.OWEIBO.RUN_ID]: taskCtx.runId } : {}),
            ...(taskCtx.trust ? { [genai_js_1.OWEIBO.TRUST_MODE]: taskCtx.trust } : {}),
            ...(taskCtx.principal ? { [genai_js_1.OWEIBO.PRINCIPAL_KIND]: taskCtx.principal } : {}),
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
//# sourceMappingURL=agent-span.js.map