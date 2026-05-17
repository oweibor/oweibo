/**
 * OpenTelemetry GenAI semantic convention attribute names.
 * Pinned to CONVENTIONS_VERSION (../CONVENTIONS_VERSION); update both together.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export declare const GENAI: {
    readonly SYSTEM: "gen_ai.system";
    readonly OPERATION_NAME: "gen_ai.operation.name";
    readonly REQUEST_MODEL: "gen_ai.request.model";
    readonly RESPONSE_MODEL: "gen_ai.response.model";
    readonly REQUEST_TEMPERATURE: "gen_ai.request.temperature";
    readonly REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens";
    readonly REQUEST_TOP_P: "gen_ai.request.top_p";
    readonly RESPONSE_ID: "gen_ai.response.id";
    readonly RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons";
    readonly USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens";
    readonly USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens";
    readonly AGENT_ID: "gen_ai.agent.id";
    readonly AGENT_NAME: "gen_ai.agent.name";
    readonly AGENT_DESCRIPTION: "gen_ai.agent.description";
    readonly TOOL_NAME: "gen_ai.tool.name";
    readonly TOOL_CALL_ID: "gen_ai.tool.call.id";
    readonly TOOL_TYPE: "gen_ai.tool.type";
};
export declare const OWEIBO: {
    readonly TENANT_ID: "oweibo.tenant.id";
    readonly USER_ID: "oweibo.user.id";
    readonly TASK_ID: "oweibo.task.id";
    readonly RUN_ID: "oweibo.run.id";
    readonly TRUST_MODE: "oweibo.trust.mode";
    readonly PRINCIPAL_KIND: "oweibo.principal.kind";
};
export declare const OPERATION: {
    readonly CHAT: "chat";
    readonly EMBEDDINGS: "embeddings";
    readonly INVOKE_AGENT: "invoke_agent";
    readonly EXECUTE_TOOL: "execute_tool";
};
//# sourceMappingURL=genai.d.ts.map