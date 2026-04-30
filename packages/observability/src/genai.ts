/**
 * OpenTelemetry GenAI semantic convention attribute names.
 * Pinned to CONVENTIONS_VERSION (../CONVENTIONS_VERSION); update both together.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

export const GENAI = {
  // All gen_ai.* spans
  SYSTEM:                  'gen_ai.system',
  OPERATION_NAME:          'gen_ai.operation.name',
  REQUEST_MODEL:           'gen_ai.request.model',
  RESPONSE_MODEL:          'gen_ai.response.model',
  REQUEST_TEMPERATURE:     'gen_ai.request.temperature',
  REQUEST_MAX_TOKENS:      'gen_ai.request.max_tokens',
  REQUEST_TOP_P:           'gen_ai.request.top_p',
  RESPONSE_ID:             'gen_ai.response.id',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  USAGE_INPUT_TOKENS:      'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS:     'gen_ai.usage.output_tokens',

  // invoke_agent spans
  AGENT_ID:          'gen_ai.agent.id',
  AGENT_NAME:        'gen_ai.agent.name',
  AGENT_DESCRIPTION: 'gen_ai.agent.description',

  // execute_tool spans
  TOOL_NAME:    'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call.id',
  TOOL_TYPE:    'gen_ai.tool.type',
} as const;

// oweibo.* attributes — multi-tenancy dimension absent from the GenAI spec
export const OWEIBO = {
  TENANT_ID:      'oweibo.tenant.id',
  USER_ID:        'oweibo.user.id',
  TASK_ID:        'oweibo.task.id',
  RUN_ID:         'oweibo.run.id',
  TRUST_MODE:     'oweibo.trust.mode',
  PRINCIPAL_KIND: 'oweibo.principal.kind',
} as const;

// gen_ai.operation.name values
export const OPERATION = {
  CHAT:         'chat',
  EMBEDDINGS:   'embeddings',
  INVOKE_AGENT: 'invoke_agent',
  EXECUTE_TOOL: 'execute_tool',
} as const;
