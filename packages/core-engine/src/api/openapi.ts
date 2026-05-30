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

      // ── F.4 shared envelopes ───────────────────────────────────────────────
      TenantParamMismatch: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string', example: 'tenant_param_mismatch' },
          message: { type: 'string' },
        },
        description: 'URL :tenantId did not match the JWT tenant claim. Returned with HTTP 403.',
      },
      PolicyBelowFloorError: {
        type: 'object',
        required: ['error', 'violations'],
        properties: {
          error: { type: 'string', example: 'policy_below_platform_floor' },
          policyDomain: { type: 'string', enum: ['sla', 'multiparty', 'ratelimit', 'quota'] },
          actionClass: { type: 'string' },
          violations: {
            type: 'array',
            items: {
              type: 'object',
              required: ['field', 'observed', 'floor'],
              properties: {
                field: { type: 'string' },
                observed: {},
                floor: {},
                message: { type: 'string' },
              },
            },
          },
        },
      },
      CursorPage: {
        type: 'object',
        properties: {
          nextCursor: { type: 'string', nullable: true, description: 'Cursor for the next page; null when exhausted.' },
        },
      },

      // ── F.4.1 forensics ────────────────────────────────────────────────────
      ForensicPacket: {
        type: 'object',
        required: ['id', 'tenantId', 'planId', 'actionId', 'createdAt', 'severity', 'state'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          tenantId: { type: 'string', format: 'uuid' },
          planId: { type: 'string', format: 'uuid' },
          actionId: { type: 'string' },
          severity: { type: 'integer', minimum: 1, maximum: 5 },
          state: { type: 'string', enum: ['open', 'in_review', 'resolved', 'replayed'] },
          summary: { type: 'string' },
          storageRef: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          resolvedAt: { type: 'string', format: 'date-time', nullable: true },
          resolvedBy: { type: 'string', nullable: true },
        },
      },
      ForensicListResponse: {
        type: 'object',
        required: ['packets'],
        properties: {
          packets: { type: 'array', items: { $ref: '#/components/schemas/ForensicPacket' } },
          nextCursor: { type: 'string', nullable: true },
        },
      },
      ForensicResolveRequest: {
        type: 'object',
        required: ['resolution'],
        properties: {
          resolution: { type: 'string', enum: ['rollback', 'accept', 'investigate'] },
          notes: { type: 'string' },
        },
      },
      ReplayMutation: {
        type: 'object',
        required: ['path', 'newValue'],
        properties: {
          path: { type: 'string' },
          newValue: {},
        },
      },
      ReplayRequest: {
        type: 'object',
        properties: {
          mutations: { type: 'array', items: { $ref: '#/components/schemas/ReplayMutation' } },
        },
      },
      ReplayRunSummary: {
        type: 'object',
        required: ['runId', 'state', 'startedAt'],
        properties: {
          runId: { type: 'string', format: 'uuid' },
          packetId: { type: 'string', format: 'uuid' },
          state: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed'] },
          startedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          mutationCount: { type: 'integer' },
        },
      },

      // ── F.4.2 lineage ──────────────────────────────────────────────────────
      LineageNode: {
        type: 'object',
        required: ['id', 'kind', 'producerType', 'producerId', 'summary', 'recordedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          parentNodeId: { type: 'string', format: 'uuid', nullable: true },
          kind: { type: 'string', enum: ['goal_decomposition', 'agent_decision', 'tool_invocation', 'gate_decision', 'execution', 'verification', 'rollback'] },
          producerType: { type: 'string', enum: ['agent', 'gate', 'human'] },
          producerId: { type: 'string' },
          summary: { type: 'string' },
          detail: { type: 'object', additionalProperties: true },
          traceId: { type: 'string', nullable: true },
          recordedAt: { type: 'string', format: 'date-time' },
        },
      },
      LineageTreeResponse: {
        type: 'object',
        required: ['nodes'],
        properties: {
          nodes: { type: 'array', items: { $ref: '#/components/schemas/LineageNode' } },
        },
      },

      // ── F.4.3 rollback + plan reads ────────────────────────────────────────
      RollbackStatus: {
        type: 'object',
        required: ['proposalId', 'state'],
        properties: {
          proposalId: { type: 'string', format: 'uuid' },
          state: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'noop'] },
          adapterKind: { type: 'string', nullable: true },
          startedAt: { type: 'string', format: 'date-time', nullable: true },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          error: { type: 'string', nullable: true },
        },
      },
      RollbackRequest: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
      PlanDetail: {
        type: 'object',
        required: ['id', 'tenantId', 'title', 'atomicity', 'state', 'worstReversibility'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          tenantId: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          atomicity: { type: 'string', enum: ['all_or_nothing', 'best_effort', 'sequential_with_checkpoints'] },
          state: { type: 'string', enum: ['pending', 'running', 'partial', 'succeeded', 'failed', 'rolled_back', 'aborted'] },
          worstReversibility: { type: 'string', enum: ['trivial', 'reversible_with_cost', 'irreversible'] },
          systems: { type: 'array', items: { type: 'string' } },
          dataDomains: { type: 'array', items: { type: 'string' } },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      PlanActions: {
        type: 'object',
        required: ['planId', 'actions'],
        properties: {
          planId: { type: 'string', format: 'uuid' },
          actions: { type: 'array', items: {
            type: 'object',
            required: ['id', 'actionClass', 'state'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              actionClass: { type: 'string' },
              state: { type: 'string' },
              stepNumber: { type: 'integer', nullable: true },
            },
          } },
        },
      },

      // ── F.4.4 policies ─────────────────────────────────────────────────────
      ApprovalSlaPolicy: {
        type: 'object',
        required: ['tenantId', 'actionClass'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          actionClass: { type: 'string' },
          hardExpireAfterSeconds: { type: 'integer', minimum: 3600 },
          initialNotifyAfterSeconds: { type: 'integer' },
          escalationLadder: { type: 'array', items: { type: 'string' } },
        },
      },
      MultiPartyApprovalPolicy: {
        type: 'object',
        required: ['tenantId', 'actionClass', 'quorum'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          actionClass: { type: 'string' },
          quorum: { type: 'integer', minimum: 2 },
          requiredRoles: { type: 'array', items: { type: 'string' } },
          maxGrantDurationSeconds: { type: 'integer' },
        },
      },
      RateLimitPolicy: {
        type: 'object',
        required: ['tenantId', 'actionClass', 'perMinute', 'enforcement'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          actionClass: { type: 'string' },
          perMinute: { type: 'integer', minimum: 1 },
          enforcement: { type: 'string', enum: ['soft', 'hard'] },
          burst: { type: 'integer' },
        },
      },
      QuotaPolicy: {
        type: 'object',
        required: ['tenantId', 'actionClass', 'limitValue'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          actionClass: { type: 'string' },
          limitValue: { type: 'integer', minimum: 1 },
          coldStartLimit: { type: 'integer', minimum: 1 },
          coldStartDurationDays: { type: 'integer', minimum: 0 },
          periodHours: { type: 'integer' },
        },
      },
      PolicyListResponse: {
        type: 'object',
        required: ['policies'],
        properties: {
          policies: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },

      // ── F.4.5 domains ──────────────────────────────────────────────────────
      DomainCatalogEntry: {
        type: 'object',
        required: ['slug', 'displayName', 'registryVersion'],
        properties: {
          slug: { type: 'string' },
          displayName: { type: 'string' },
          registryVersion: { type: 'string' },
          parentSlug: { type: 'string', nullable: true },
        },
      },
      DomainBinding: {
        type: 'object',
        required: ['domainSlug', 'role', 'weight', 'boundByType', 'boundById'],
        properties: {
          domainSlug: { type: 'string' },
          role: { type: 'string', enum: ['primary', 'secondary'] },
          weight: { type: 'number', minimum: 0, maximum: 1 },
          boundByType: { type: 'string', enum: ['classifier', 'admin', 'sme'] },
          boundById: { type: 'string' },
          confidence: { type: 'number', nullable: true },
          boundAt: { type: 'string', format: 'date-time' },
        },
      },
      DomainBindingReplacement: {
        type: 'object',
        required: ['bindings'],
        properties: {
          bindings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['domainSlug', 'role', 'weight'],
              properties: {
                domainSlug: { type: 'string' },
                role: { type: 'string', enum: ['primary', 'secondary'] },
                weight: { type: 'number' },
              },
            },
          },
        },
      },
      SmeQueueItem: {
        type: 'object',
        required: ['id', 'artifactKind', 'state', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          artifactKind: { type: 'string' },
          state: { type: 'string', enum: ['pending', 'assigned', 'voted', 'consensus', 'rejected'] },
          domainSlug: { type: 'string', nullable: true },
          payload: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SmeVoteRequest: {
        type: 'object',
        required: ['overallVerdict'],
        properties: {
          overallVerdict: { type: 'string', enum: ['approve', 'reject', 'needs_revision'] },
          perCriterion: { type: 'object', additionalProperties: { type: 'string' } },
          rationale: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } },
        },
      },
      DomainDepthSnapshot: {
        type: 'object',
        required: ['domainSlug', 'snapshotAt', 'compositeScore', 'coverage'],
        properties: {
          domainSlug: { type: 'string' },
          snapshotAt: { type: 'string', format: 'date-time' },
          compositeScore: { type: 'number' },
          coverage: { type: 'object', additionalProperties: { type: 'number' } },
        },
      },
      ComplianceEvaluation: {
        type: 'object',
        required: ['id', 'ruleId', 'packVersion', 'enforcementPhase', 'verdict', 'evaluatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          proposalId: { type: 'string', format: 'uuid', nullable: true },
          ruleId: { type: 'string' },
          domainSlug: { type: 'string', nullable: true },
          packVersion: { type: 'string' },
          enforcementPhase: { type: 'string', enum: ['action_time', 'artifact_time'] },
          verdict: { type: 'string', enum: ['pass', 'info', 'warn', 'block', 'bypass'] },
          details: { type: 'object', additionalProperties: true },
          bypassPrincipal: { type: 'string', nullable: true },
          bypassReason: { type: 'string', nullable: true },
          evaluatedAt: { type: 'string', format: 'date-time' },
        },
      },

      // ── F.4.6 calibration ──────────────────────────────────────────────────
      CalibrationResponse: {
        type: 'object',
        required: ['tenantId', 'score', 'threshold', 'summary', 'signals', 'gateEnabled', 'meetsAutonomousThreshold'],
        properties: {
          tenantId: { type: 'string', format: 'uuid' },
          score: { type: 'number', minimum: 0, maximum: 1 },
          threshold: { type: 'number', minimum: 0, maximum: 1 },
          summary: { type: 'string' },
          signals: { type: 'object', additionalProperties: true },
          gateEnabled: { type: 'boolean' },
          meetsAutonomousThreshold: { type: 'boolean' },
          actionClassScores: { type: 'object', additionalProperties: { type: 'number' } },
          snapshotAt: { type: 'string', format: 'date-time' },
          sourceSig: { type: 'string' },
        },
      },

      // ── F.4.7 connectors + templates ───────────────────────────────────────
      ConnectorInstance: {
        type: 'object',
        required: ['id', 'connectorId', 'instanceLabel', 'status', 'installedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          connectorId: { type: 'string' },
          catalogVersion: { type: 'string' },
          instanceLabel: { type: 'string' },
          status: { type: 'string', enum: ['recommended', 'pending', 'active', 'suspended', 'revoked'] },
          installedAt: { type: 'string', format: 'date-time' },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          vaultPath: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      ConnectorRecommendation: {
        type: 'object',
        required: ['connectorId', 'displayName'],
        properties: {
          connectorId: { type: 'string' },
          displayName: { type: 'string' },
          category: { type: 'string' },
          certification: { type: 'string', enum: ['experimental', 'community', 'verified', 'enterprise'] },
        },
      },
      InstallConnectorRequest: {
        type: 'object',
        required: ['connectorId', 'instanceLabel'],
        properties: {
          connectorId: { type: 'string' },
          instanceLabel: { type: 'string' },
          catalogVersion: { type: 'string' },
          vaultPath: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      TenantTemplate: {
        type: 'object',
        required: ['slug', 'displayName', 'description', 'active'],
        properties: {
          slug: { type: 'string' },
          displayName: { type: 'string' },
          description: { type: 'string' },
          industries: { type: 'array', items: { type: 'string' } },
          defaultFeatures: { type: 'object', additionalProperties: true },
          defaultQuotas: { type: 'object', additionalProperties: true },
          seedMemoryTags: { type: 'array', items: { type: 'string' } },
          seedSkillSet: { type: 'string' },
          goalTemplateSet: { type: 'string' },
          active: { type: 'boolean' },
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
    '/tasks/{id}': {
      get: {
        summary: 'Get task status',
        operationId: 'getTask',
        tags: ['Tasks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'Current task status.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskStatusResponse' } } },
          },
        },
      },
    },
    '/tasks/{id}/clarify': {
      post: {
        summary: 'Submit clarification answers',
        operationId: 'clarifyTask',
        tags: ['Tasks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
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
    '/tasks/{id}/events': {
      get: {
        summary: 'Stream task events (Server-Sent Events)',
        operationId: 'streamTaskEvents',
        tags: ['Tasks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
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
    '/tasks/{id}/redirect': {
      post: {
        summary: 'Apply a mid-task intervention (redirect / pause / cancel)',
        operationId: 'redirectTask',
        tags: ['Tasks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
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

    '/tasks/{id}/feedback': {
      post: {
        summary: 'Submit user feedback for a completed task',
        operationId: 'submitTaskFeedback',
        tags: ['Tasks'],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Feedback recorded.' },
          '400': { description: 'Invalid request body.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidationError' } } } },
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

    // ── Actions (legacy, JWT-tenant-scoped) ──────────────────────────────────
    // These endpoints predate F.4's tenant-URL convention. The tenant id is
    // read from the JWT claim instead of a URL param. Slated for migration to
    // /tenants/:tenantId/actions/* in a follow-up; marked deprecated to signal
    // operators not to integrate against these.
    '/actions/pending': {
      get: { summary: 'List pending action proposals (deprecated)', operationId: 'listPendingActionsLegacy', tags: ['Actions (legacy)'], deprecated: true, responses: { '200': { description: 'OK' } } },
    },
    '/actions/history': {
      get: { summary: 'List action history (deprecated)', operationId: 'listActionHistoryLegacy', tags: ['Actions (legacy)'], deprecated: true, responses: { '200': { description: 'OK' } } },
    },
    '/actions/trust-matrix': {
      get: { summary: 'Tenant action-class trust matrix (deprecated)', operationId: 'getTrustMatrixLegacy', tags: ['Actions (legacy)'], deprecated: true, responses: { '200': { description: 'OK' } } },
    },
    '/actions/trust-matrix/pin': {
      post: { summary: 'Pin a class mode (deprecated)', operationId: 'pinTrustMatrixLegacy', tags: ['Actions (legacy)'], deprecated: true, responses: { '200': { description: 'OK' } } },
    },
    '/actions/trust-matrix/unpin': {
      post: { summary: 'Unpin a class mode (deprecated)', operationId: 'unpinTrustMatrixLegacy', tags: ['Actions (legacy)'], deprecated: true, responses: { '200': { description: 'OK' } } },
    },
    '/actions/{id}': {
      get: { summary: 'Get an action proposal (deprecated)', operationId: 'getActionLegacy', tags: ['Actions (legacy)'], deprecated: true, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' } } },
    },
    '/actions/{id}/promote': {
      post: { summary: 'Promote a proposal (deprecated)', operationId: 'promoteActionLegacy', tags: ['Actions (legacy)'], deprecated: true, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' } } },
    },
    '/actions/{id}/reject': {
      post: { summary: 'Reject a proposal (deprecated)', operationId: 'rejectActionLegacy', tags: ['Actions (legacy)'], deprecated: true, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' } } },
    },
    '/actions/shadow/outcome': {
      post: { summary: 'Record a shadow-execution outcome (deprecated)', operationId: 'shadowOutcomeLegacy', tags: ['Actions (legacy)'], deprecated: true, responses: { '200': { description: 'OK' } } },
    },

    // ── F.4.0 + S.4 / S.6: extended tenant actions (quotas, grants, votes) ──
    '/tenants/{tenantId}/actions/quotas/usage': {
      get: { summary: 'Tenant quota usage', operationId: 'getTenantQuotaUsage', tags: ['Tenant Actions'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK' }, '403': errorRef('TenantParamMismatch') } },
    },
    '/tenants/{tenantId}/actions/quotas/preflight': {
      post: { summary: 'Quota preflight check', operationId: 'preflightQuota', tags: ['Tenant Actions'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK' }, '403': errorRef('TenantParamMismatch') } },
    },
    '/tenants/{tenantId}/actions/grants': {
      get:  { summary: 'List active grants', operationId: 'listGrants', tags: ['Tenant Actions'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a grant', operationId: 'createGrant', tags: ['Tenant Actions'], parameters: [tenantIdParam()], responses: { '201': { description: 'Created' }, '400': errorRef('ValidationError') } },
    },
    '/tenants/{tenantId}/actions/grants/{id}': {
      delete: { summary: 'Revoke a grant', operationId: 'revokeGrant', tags: ['Tenant Actions'], parameters: [tenantIdParam(), idParam()], responses: { '204': { description: 'Revoked' } } },
    },
    '/tenants/{tenantId}/actions/approvals/{proposalId}/quorum': {
      get: { summary: 'Inspect multi-party quorum state', operationId: 'getApprovalQuorum', tags: ['Tenant Actions'], parameters: [tenantIdParam(), { name: 'proposalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' } } },
    },
    '/tenants/{tenantId}/actions/approvals/{proposalId}/votes': {
      post: { summary: 'Cast a vote on a multi-party proposal', operationId: 'castApprovalVote', tags: ['Tenant Actions'], parameters: [tenantIdParam(), { name: 'proposalId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK' } } },
    },
    '/tenants/{tenantId}/actions/approvals/delegations': {
      post: { summary: 'Create an approval delegation', operationId: 'createApprovalDelegation', tags: ['Tenant Actions'], parameters: [tenantIdParam()], responses: { '201': { description: 'Created' } } },
    },

    // ── F.4.1 forensics ────────────────────────────────────────────────────
    '/tenants/{tenantId}/forensics': {
      get: {
        summary: 'List forensic packets', operationId: 'listForensicPackets', tags: ['Forensics'],
        parameters: [tenantIdParam(), { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } }],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ForensicListResponse' } } } } },
      },
    },
    '/tenants/{tenantId}/forensics/by-plan/{planId}': {
      get: { summary: 'Forensic packets for a plan', operationId: 'listForensicsByPlan', tags: ['Forensics'], parameters: [tenantIdParam(), { name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ForensicListResponse' } } } } } },
    },
    '/tenants/{tenantId}/forensics/{id}': {
      get: { summary: 'Get a forensic packet', operationId: 'getForensicPacket', tags: ['Forensics'], parameters: [tenantIdParam(), idParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ForensicPacket' } } } }, '404': { description: 'Not found' } } },
    },
    '/tenants/{tenantId}/forensics/{id}/download': {
      get: { summary: 'Download packet artifact (S3 redirect)', operationId: 'downloadForensicPacket', tags: ['Forensics'], parameters: [tenantIdParam(), idParam()], responses: { '302': { description: 'Redirect to S3 pre-signed URL' }, '404': { description: 'Not found' } } },
    },
    '/tenants/{tenantId}/forensics/{id}/resolve': {
      post: { summary: 'Resolve a packet (HITL handoff)', operationId: 'resolveForensicPacket', tags: ['Forensics'], parameters: [tenantIdParam(), idParam()], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ForensicResolveRequest' } } } }, responses: { '200': { description: 'Resolved' } } },
    },
    '/tenants/{tenantId}/forensics/{id}/replay': {
      post: { summary: 'Replay a packet (sandboxed)', operationId: 'replayForensicPacket', tags: ['Forensics'], parameters: [tenantIdParam(), idParam()], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplayRequest' } } } }, responses: { '202': { description: 'Replay queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplayRunSummary' } } } } } },
    },
    '/tenants/{tenantId}/forensics/{id}/replay/{runId}': {
      get: { summary: 'Get replay run status', operationId: 'getReplayRun', tags: ['Forensics'], parameters: [tenantIdParam(), idParam(), { name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ReplayRunSummary' } } } } } },
    },

    // ── F.4.2 lineage ──────────────────────────────────────────────────────
    '/tenants/{tenantId}/lineage/plans/{planId}': {
      get: { summary: 'Lineage tree for a plan', operationId: 'getPlanLineage', tags: ['Lineage'], parameters: [tenantIdParam(), { name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LineageTreeResponse' } } } } } },
    },
    '/tenants/{tenantId}/lineage/actions/{actionId}': {
      get: { summary: 'Lineage subtree for an action', operationId: 'getActionLineage', tags: ['Lineage'], parameters: [tenantIdParam(), { name: 'actionId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LineageTreeResponse' } } } } } },
    },
    '/tenants/{tenantId}/lineage/decisions/{decisionId}': {
      get: { summary: 'Lineage subtree from a decision node', operationId: 'getDecisionLineage', tags: ['Lineage'], parameters: [tenantIdParam(), { name: 'decisionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/LineageTreeResponse' } } } } } },
    },

    // ── F.4.3 rollback + plan reads ────────────────────────────────────────
    '/tenants/{tenantId}/actions/plans/{planId}': {
      get: { summary: 'Plan-level proposal detail', operationId: 'getPlan', tags: ['Tenant Actions'], parameters: [tenantIdParam(), { name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/PlanDetail' } } } } } },
    },
    '/tenants/{tenantId}/actions/plans/{planId}/actions': {
      get: { summary: 'List member actions of a plan', operationId: 'listPlanActions', tags: ['Tenant Actions'], parameters: [tenantIdParam(), { name: 'planId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/PlanActions' } } } } } },
    },
    '/tenants/{tenantId}/actions/{id}/rollback': {
      post: { summary: 'Invoke rollback for a proposal', operationId: 'invokeRollback', tags: ['Tenant Actions'], parameters: [tenantIdParam(), idParam()], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/RollbackRequest' } } } }, responses: { '202': { description: 'Rollback queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/RollbackStatus' } } } } } },
    },
    '/tenants/{tenantId}/actions/{id}/rollback/status': {
      get: { summary: 'Poll rollback status', operationId: 'getRollbackStatus', tags: ['Tenant Actions'], parameters: [tenantIdParam(), idParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/RollbackStatus' } } } } } },
    },

    // ── F.4.4 policies (4 domains, 4 verbs each) ───────────────────────────
    '/tenants/{tenantId}/actions/policies/{domain}': {
      get: {
        summary: 'List effective policies for a domain', operationId: 'listPolicies', tags: ['Policies'],
        parameters: [tenantIdParam(), policyDomainParam()],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/PolicyListResponse' } } } } },
      },
    },
    '/tenants/{tenantId}/actions/policies/{domain}/{actionClass}': {
      get: {
        summary: 'Get the effective policy for an action class', operationId: 'getPolicy', tags: ['Policies'],
        parameters: [tenantIdParam(), policyDomainParam(), { name: 'actionClass', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'No override; floor applies' } },
      },
      put: {
        summary: 'Upsert a tenant-side override policy', operationId: 'upsertPolicy', tags: ['Policies'],
        parameters: [tenantIdParam(), policyDomainParam(), { name: 'actionClass', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Upserted' },
          '400': { description: 'Validation error or below floor', content: { 'application/json': { schema: { oneOf: [
            { $ref: '#/components/schemas/ValidationError' },
            { $ref: '#/components/schemas/PolicyBelowFloorError' },
          ] } } } },
        },
      },
      delete: {
        summary: 'Remove an override (revert to floor)', operationId: 'deletePolicy', tags: ['Policies'],
        parameters: [tenantIdParam(), policyDomainParam(), { name: 'actionClass', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '204': { description: 'Removed' } },
      },
    },

    // ── F.4.5 domains ──────────────────────────────────────────────────────
    '/tenants/{tenantId}/domains/registry': {
      get: { summary: 'Canonical domain registry', operationId: 'getDomainRegistry', tags: ['Domains'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DomainCatalogEntry' } } } } } } },
    },
    '/tenants/{tenantId}/domains/bindings': {
      get: { summary: 'Tenant domain bindings', operationId: 'getDomainBindings', tags: ['Domains'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DomainBinding' } } } } } } },
      put: { summary: 'Replace tenant domain bindings', operationId: 'replaceDomainBindings', tags: ['Domains'], parameters: [tenantIdParam()], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DomainBindingReplacement' } } } }, responses: { '200': { description: 'Replaced' } } },
    },
    '/tenants/{tenantId}/domains/sme-review': {
      get: { summary: 'List SME review queue items', operationId: 'listSmeQueue', tags: ['Domains'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/SmeQueueItem' } } } } } } },
    },
    '/tenants/{tenantId}/domains/sme-review/{id}/vote': {
      post: { summary: 'Submit an SME review vote', operationId: 'submitSmeVote', tags: ['Domains'], parameters: [tenantIdParam(), idParam()], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SmeVoteRequest' } } } }, responses: { '200': { description: 'OK' } } },
    },
    '/tenants/{tenantId}/domains/depth': {
      get: { summary: 'Latest depth snapshots per bound domain', operationId: 'getDomainDepth', tags: ['Domains'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/DomainDepthSnapshot' } } } } } } },
    },
    '/tenants/{tenantId}/domains/compliance/evaluations': {
      get: { summary: 'Recent noteworthy compliance verdicts', operationId: 'listComplianceEvaluations', tags: ['Domains'], parameters: [tenantIdParam(), { name: 'verdict', in: 'query', schema: { type: 'string' } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/CursorPage' }, { type: 'object', properties: { evaluations: { type: 'array', items: { $ref: '#/components/schemas/ComplianceEvaluation' } } } }] } } } } } },
    },
    '/tenants/{tenantId}/domains/compliance/refresh': {
      post: { summary: 'Invalidate per-tenant binding lookup cache', operationId: 'refreshComplianceCache', tags: ['Domains'], parameters: [tenantIdParam()], responses: { '204': { description: 'Cache invalidated' } } },
    },

    // ── F.4.6 calibration ──────────────────────────────────────────────────
    '/tenants/{tenantId}/calibration': {
      get: { summary: 'Tenant calibration snapshot', operationId: 'getCalibration', tags: ['Calibration'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/CalibrationResponse' } } } } } },
    },

    // ── F.4.7 connectors + templates ───────────────────────────────────────
    '/tenants/{tenantId}/connectors': {
      get:  { summary: 'List installed connectors', operationId: 'listTenantConnectors', tags: ['Connectors'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ConnectorInstance' } } } } } } },
      post: { summary: 'Install a connector instance', operationId: 'installConnector', tags: ['Connectors'], parameters: [tenantIdParam()], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/InstallConnectorRequest' } } } }, responses: { '201': { description: 'Installed', content: { 'application/json': { schema: { $ref: '#/components/schemas/ConnectorInstance' } } } }, '409': { description: 'Duplicate instance' }, '422': { description: 'Credential not resolvable' } } },
    },
    '/tenants/{tenantId}/connectors/recommendations': {
      get: { summary: 'Recommended connectors for the tenant', operationId: 'recommendConnectors', tags: ['Connectors'], parameters: [tenantIdParam(), { name: 'minTier', in: 'query', schema: { type: 'string', enum: ['experimental', 'community', 'verified', 'enterprise'] } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ConnectorRecommendation' } } } } } } },
    },
    '/tenants/{tenantId}/templates': {
      get: { summary: 'Tenant template catalog', operationId: 'listTemplates', tags: ['Templates'], parameters: [tenantIdParam()], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/TenantTemplate' } } } } } } },
    },
    '/tenants/{tenantId}/templates/{slug}': {
      get: { summary: 'Template detail', operationId: 'getTemplate', tags: ['Templates'], parameters: [tenantIdParam(), { name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/TenantTemplate' } } } } } },
    },
  },
} as const;

// ── Helpers (kept inline so the const-assertion holds on `openapiSpec`) ──
function tenantIdParam() {
  return { name: 'tenantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } } as const;
}
function idParam() {
  return { name: 'id', in: 'path', required: true, schema: { type: 'string' } } as const;
}
function policyDomainParam() {
  return { name: 'domain', in: 'path', required: true, schema: { type: 'string', enum: ['sla', 'multiparty', 'ratelimit', 'quota'] } } as const;
}
function errorRef(schemaName: string) {
  return { description: 'Error', content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } } } as const;
}
