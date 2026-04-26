/**
 * openapi.ts — OpenAPI 3.1 specification for the oweibo core-engine REST API (§18).
 *
 * The spec is defined programmatically (no JSDoc scanning at runtime) so that
 * it is always in sync with the Zod schemas in each route file and can be
 * tested as a plain object without spinning up a server.
 *
 * Served by server.ts at GET /api/v1/docs (swagger-ui-express).
 */

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'oweibo API',
    version: '1.0.0',
    description:
      'REST API for the oweibo autonomous multi-tenant app factory. ' +
      'All endpoints under /api/v1 require a Bearer JWT unless otherwise noted.',
    contact: { name: 'oweibo platform team' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: '/api/v1', description: 'Current version' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      // ── Shared error responses ─────────────────────────────────────────────
      ValidationError: {
        type: 'object',
        required: ['error', 'details'],
        properties: {
          error: { type: 'string', example: 'validation_error' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path:    { type: 'array', items: { type: 'string' } },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      InternalError: {
        type: 'object',
        required: ['error', 'message'],
        properties: {
          error:   { type: 'string', example: 'internal_error' },
          message: { type: 'string', example: 'An internal error occurred' },
        },
      },

      // ── Tasks ──────────────────────────────────────────────────────────────
      SubmitTaskRequest: {
        type: 'object',
        required: ['instruction'],
        properties: {
          instruction: {
            type: 'string',
            minLength: 1,
            maxLength: 10000,
            description: 'Natural-language task description for the oweibo engine.',
            example: 'Build a REST API for a todo application with PostgreSQL storage.',
          },
          sessionId: {
            type: 'string',
            format: 'uuid',
            description: 'Optional session UUID. Auto-generated if omitted.',
          },
          tenantId: {
            type: 'string',
            description: 'Tenant identifier. Determines budget limits and file-classifier rules.',
          },
          repoPath: {
            type: 'string',
            description: 'Absolute path to an existing local repository.',
          },
          deliveryMode: {
            type: 'string',
            enum: ['download-link', 'git-push', 'webhook', 'channel-reply'],
            description: 'How generated artifacts are delivered after the pipeline completes.',
          },
          gitRepoUrl: {
            type: 'string',
            format: 'uri',
            description: 'Remote git repository URL (required when deliveryMode = git-push).',
          },
          gitBranch: {
            type: 'string',
            description: 'Target branch for git-push delivery.',
          },
          webhookUrl: {
            type: 'string',
            format: 'uri',
            description: 'Webhook URL to POST artifacts to (required when deliveryMode = webhook).',
          },
        },
      },
      SubmitTaskResponse: {
        type: 'object',
        required: ['taskId', 'status'],
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          status: {
            type: 'string',
            enum: ['queued', 'running', 'needs_clarification'],
          },
        },
      },
      NeedsClarificationResponse: {
        type: 'object',
        required: ['taskId', 'status', 'questions'],
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['needs_clarification'] },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'question'],
              properties: {
                id:       { type: 'string' },
                question: { type: 'string' },
              },
            },
          },
        },
      },
      ClarifyRequest: {
        type: 'object',
        required: ['answers'],
        properties: {
          answers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Map of question id → answer string.',
            example: { 'q1': 'PostgreSQL', 'q2': 'JWT authentication' },
          },
        },
      },
      TaskStatusResponse: {
        type: 'object',
        required: ['taskId', 'status'],
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          status: {
            type: 'string',
            enum: ['queued', 'running', 'needs_clarification', 'completed', 'failed', 'unknown'],
          },
        },
      },
      InterventionRequest: {
        type: 'object',
        required: ['type'],
        properties: {
          type: {
            type: 'string',
            enum: ['redirect', 'pause', 'cancel', 'add-constraint'],
            description: 'Type of mid-task intervention to apply.',
          },
          payload: {
            type: 'string',
            description: 'Optional instruction or constraint text (required for redirect and add-constraint).',
          },
        },
      },
      InterventionResponse: {
        type: 'object',
        required: ['taskId', 'intervention', 'status'],
        properties: {
          taskId:       { type: 'string', format: 'uuid' },
          intervention: { type: 'string' },
          status:       { type: 'string', example: 'applied' },
        },
      },
      TaskEvent: {
        type: 'object',
        description: 'Server-Sent Event payload emitted over the /tasks/:id/events SSE stream.',
        properties: {
          type: {
            type: 'string',
            description: 'TaskEventType string (e.g. plan-ready, plan-node-complete, task-complete).',
          },
          taskId:  { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
        },
      },

      // ── HITL ──────────────────────────────────────────────────────────────
      HITLDecisionRequest: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Human-readable reason for the approval or rejection.',
          },
          modifications: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional key-value overrides to apply to the pending proposal (approve only).',
          },
        },
      },
      HITLDecisionResponse: {
        type: 'object',
        required: ['requestId', 'decision'],
        properties: {
          requestId: { type: 'string' },
          decision:  { type: 'string', enum: ['approved', 'rejected'] },
        },
      },
      HITLPendingResponse: {
        type: 'object',
        required: ['count', 'requests'],
        properties: {
          count: { type: 'integer' },
          requests: {
            type: 'array',
            items: {
              type: 'object',
              required: ['requestId', 'taskId', 'agentId', 'reason', 'escalatedAt'],
              properties: {
                requestId:   { type: 'string' },
                taskId:      { type: 'string' },
                agentId:     { type: 'string' },
                reason:      { type: 'string' },
                escalatedAt: { type: 'integer', description: 'Unix timestamp (ms).' },
              },
            },
          },
        },
      },

      // ── Skills ─────────────────────────────────────────────────────────────
      SkillSource: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name:      { type: 'string' },
          url:       { type: 'string', format: 'uri' },
          ref:       { type: 'string', description: 'Git ref / tag / branch.' },
          integrity: { type: 'string', description: 'SHA-256 integrity hash.' },
        },
      },
      SkillLockEntry: {
        type: 'object',
        required: ['source', 'version', 'resolvedAt', 'integrity'],
        properties: {
          source:     { type: 'string' },
          version:    { type: 'string' },
          resolvedAt: { type: 'string', format: 'date-time' },
          integrity:  { type: 'string' },
        },
      },
      SkillsListResponse: {
        type: 'object',
        required: ['sources', 'locked'],
        properties: {
          sources: { type: 'array', items: { $ref: '#/components/schemas/SkillSource' } },
          locked: {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/SkillLockEntry' },
          },
        },
      },
      SkillsPullResponse: {
        type: 'object',
        required: ['pulled', 'skills'],
        properties: {
          pulled: { type: 'integer' },
          skills: {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/SkillLockEntry' },
          },
        },
      },
    },
  },

  security: [{ bearerAuth: [] }],

  paths: {
    // ── Tasks ────────────────────────────────────────────────────────────────
    '/tasks': {
      post: {
        summary: 'Submit a new task',
        operationId: 'submitTask',
        tags: ['Tasks'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitTaskRequest' } } },
        },
        responses: {
          '201': {
            description: 'Task accepted and queued.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmitTaskResponse' } } },
          },
          '202': {
            description: 'Task requires clarification before it can be queued.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NeedsClarificationResponse' } } },
          },
          '400': {
            description: 'Invalid request body.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } },
          },
          '500': {
            description: 'Internal server error.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InternalError' } } },
          },
        },
      },
    },
    '/tasks/{taskId}': {
      get: {
        summary: 'Get task status',
        operationId: 'getTask',
        tags: ['Tasks'],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'Current task status.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskStatusResponse' } } },
          },
        },
      },
    },
    '/tasks/{taskId}/clarify': {
      post: {
        summary: 'Submit clarification answers',
        operationId: 'clarifyTask',
        tags: ['Tasks'],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ClarifyRequest' } } },
        },
        responses: {
          '200': {
            description: 'Clarification accepted.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskStatusResponse' } } },
          },
          '400': {
            description: 'Invalid request body.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } },
          },
        },
      },
    },
    '/tasks/{taskId}/events': {
      get: {
        summary: 'Stream task events (Server-Sent Events)',
        operationId: 'streamTaskEvents',
        tags: ['Tasks'],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description:
              'SSE stream. Each `data:` line is a JSON-encoded TaskEvent. ' +
              'A `: heartbeat` comment is sent every 15 seconds to keep the connection alive.',
            content: {
              'text/event-stream': {
                schema: { $ref: '#/components/schemas/TaskEvent' },
              },
            },
          },
        },
      },
    },
    '/tasks/{taskId}/redirect': {
      post: {
        summary: 'Apply a mid-task intervention (redirect / pause / cancel)',
        operationId: 'redirectTask',
        tags: ['Tasks'],
        parameters: [{ name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InterventionRequest' } } },
        },
        responses: {
          '200': {
            description: 'Intervention applied.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InterventionResponse' } } },
          },
          '400': {
            description: 'Invalid request body.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } },
          },
        },
      },
    },

    // ── HITL ─────────────────────────────────────────────────────────────────
    '/hitl/pending': {
      get: {
        summary: 'List pending HITL escalation requests',
        operationId: 'listHITLPending',
        tags: ['HITL'],
        parameters: [
          { name: 'tenantId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'List of pending HITL requests.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HITLPendingResponse' } } },
          },
        },
      },
    },
    '/hitl/{requestId}/approve': {
      post: {
        summary: 'Approve a HITL escalation',
        operationId: 'approveHITL',
        tags: ['HITL'],
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/HITLDecisionRequest' } } },
        },
        responses: {
          '200': {
            description: 'Request approved.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HITLDecisionResponse' } } },
          },
          '400': {
            description: 'Invalid request body.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } },
          },
        },
      },
    },
    '/hitl/{requestId}/reject': {
      post: {
        summary: 'Reject a HITL escalation',
        operationId: 'rejectHITL',
        tags: ['HITL'],
        parameters: [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/HITLDecisionRequest' } } },
        },
        responses: {
          '200': {
            description: 'Request rejected.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HITLDecisionResponse' } } },
          },
          '400': {
            description: 'Invalid request body.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } },
          },
        },
      },
    },

    // ── Skills ───────────────────────────────────────────────────────────────
    '/skills': {
      get: {
        summary: 'List configured skill sources and their locked state',
        operationId: 'listSkills',
        tags: ['Skills'],
        responses: {
          '200': {
            description: 'Sources manifest and lockfile contents.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SkillsListResponse' } } },
          },
        },
      },
    },
    '/skills/{name}': {
      get: {
        summary: 'Retrieve a single resolved skill lock entry',
        operationId: 'getSkill',
        tags: ['Skills'],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Skill lock entry.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SkillLockEntry' } } },
          },
          '404': {
            description: 'Skill not found.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string', example: 'skill_not_found' },
                    name:  { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/skills/pull': {
      post: {
        summary: 'Resolve skill sources into skills.lock',
        operationId: 'pullSkills',
        tags: ['Skills'],
        responses: {
          '200': {
            description: 'Lock file updated.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/SkillsPullResponse' } } },
          },
        },
      },
    },
  },
} as const;
