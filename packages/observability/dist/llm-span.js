"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withLLMSpan = withLLMSpan;
const api_1 = require("@opentelemetry/api");
const genai_js_1 = require("./genai.js");
const tracer = api_1.trace.getTracer('oweibo', '0.6.0');
/**
 * Wraps a chat or embeddings call in a gen_ai OTel span.
 * Optionally accepts a getResult() extractor to record token counts
 * and other response metadata after the call completes.
 */
async function withLLMSpan(opts, taskCtx, fn, getResult) {
    return tracer.startActiveSpan(opts.operation, { kind: api_1.SpanKind.CLIENT }, async (span) => {
        span.setAttributes({
            [genai_js_1.GENAI.SYSTEM]: opts.system,
            [genai_js_1.GENAI.OPERATION_NAME]: opts.operation,
            [genai_js_1.GENAI.REQUEST_MODEL]: opts.model,
            [genai_js_1.OWEIBO.TENANT_ID]: taskCtx.tenantId,
            [genai_js_1.OWEIBO.USER_ID]: taskCtx.userId,
            [genai_js_1.OWEIBO.TASK_ID]: taskCtx.taskId,
            ...(opts.temperature != null ? { [genai_js_1.GENAI.REQUEST_TEMPERATURE]: opts.temperature } : {}),
            ...(opts.maxTokens != null ? { [genai_js_1.GENAI.REQUEST_MAX_TOKENS]: opts.maxTokens } : {}),
            ...(opts.topP != null ? { [genai_js_1.GENAI.REQUEST_TOP_P]: opts.topP } : {}),
        });
        try {
            const result = await fn();
            if (getResult) {
                const meta = getResult(result);
                if (meta.inputTokens != null)
                    span.setAttribute(genai_js_1.GENAI.USAGE_INPUT_TOKENS, meta.inputTokens);
                if (meta.outputTokens != null)
                    span.setAttribute(genai_js_1.GENAI.USAGE_OUTPUT_TOKENS, meta.outputTokens);
                if (meta.responseModel)
                    span.setAttribute(genai_js_1.GENAI.RESPONSE_MODEL, meta.responseModel);
                if (meta.responseId)
                    span.setAttribute(genai_js_1.GENAI.RESPONSE_ID, meta.responseId);
                if (meta.finishReasons)
                    span.setAttribute(genai_js_1.GENAI.RESPONSE_FINISH_REASONS, meta.finishReasons);
            }
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
//# sourceMappingURL=llm-span.js.map