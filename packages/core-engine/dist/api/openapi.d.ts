/**
 * openapi.ts — OpenAPI 3.1 specification for the oweibo core-engine REST API (§18).
 *
 * The spec is defined programmatically (no JSDoc scanning at runtime) so that
 * it is always in sync with the Zod schemas in each route file and can be
 * tested as a plain object without spinning up a server.
 *
 * Served by server.ts at GET /api/v1/docs (swagger-ui-express).
 */
export declare const openapiSpec: {
    readonly openapi: "3.1.0";
    readonly info: {
        readonly title: "oweibo API";
        readonly version: "1.0.0";
        readonly description: string;
        readonly contact: {
            readonly name: "oweibo platform team";
        };
        readonly license: {
            readonly name: "MIT";
        };
    };
    readonly servers: readonly [{
        readonly url: "/api/v1";
        readonly description: "Current version";
    }];
    readonly components: {
        readonly securitySchemes: {
            readonly bearerAuth: {
                readonly type: "http";
                readonly scheme: "bearer";
                readonly bearerFormat: "JWT";
            };
        };
        readonly schemas: {
            readonly ValidationError: {
                readonly type: "object";
                readonly required: readonly ["error", "details"];
                readonly properties: {
                    readonly error: {
                        readonly type: "string";
                        readonly example: "validation_error";
                    };
                    readonly details: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly properties: {
                                readonly path: {
                                    readonly type: "array";
                                    readonly items: {
                                        readonly type: "string";
                                    };
                                };
                                readonly message: {
                                    readonly type: "string";
                                };
                            };
                        };
                    };
                };
            };
            readonly InternalError: {
                readonly type: "object";
                readonly required: readonly ["error", "message"];
                readonly properties: {
                    readonly error: {
                        readonly type: "string";
                        readonly example: "internal_error";
                    };
                    readonly message: {
                        readonly type: "string";
                        readonly example: "An internal error occurred";
                    };
                };
            };
            readonly SubmitTaskRequest: {
                readonly type: "object";
                readonly required: readonly ["instruction"];
                readonly properties: {
                    readonly instruction: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly maxLength: 10000;
                        readonly description: "Natural-language task description for the oweibo engine.";
                        readonly example: "Build a REST API for a todo application with PostgreSQL storage.";
                    };
                    readonly sessionId: {
                        readonly type: "string";
                        readonly format: "uuid";
                        readonly description: "Optional session UUID. Auto-generated if omitted.";
                    };
                    readonly tenantId: {
                        readonly type: "string";
                        readonly description: "Tenant identifier. Determines budget limits and file-classifier rules.";
                    };
                    readonly repoPath: {
                        readonly type: "string";
                        readonly description: "Absolute path to an existing local repository.";
                    };
                    readonly deliveryMode: {
                        readonly type: "string";
                        readonly enum: readonly ["download-link", "git-push", "webhook", "channel-reply"];
                        readonly description: "How generated artifacts are delivered after the pipeline completes.";
                    };
                    readonly gitRepoUrl: {
                        readonly type: "string";
                        readonly format: "uri";
                        readonly description: "Remote git repository URL (required when deliveryMode = git-push).";
                    };
                    readonly gitBranch: {
                        readonly type: "string";
                        readonly description: "Target branch for git-push delivery.";
                    };
                    readonly webhookUrl: {
                        readonly type: "string";
                        readonly format: "uri";
                        readonly description: "Webhook URL to POST artifacts to (required when deliveryMode = webhook).";
                    };
                };
            };
            readonly SubmitTaskResponse: {
                readonly type: "object";
                readonly required: readonly ["taskId", "status"];
                readonly properties: {
                    readonly taskId: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["queued", "running", "needs_clarification"];
                    };
                };
            };
            readonly NeedsClarificationResponse: {
                readonly type: "object";
                readonly required: readonly ["taskId", "status", "questions"];
                readonly properties: {
                    readonly taskId: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["needs_clarification"];
                    };
                    readonly questions: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly required: readonly ["id", "question"];
                            readonly properties: {
                                readonly id: {
                                    readonly type: "string";
                                };
                                readonly question: {
                                    readonly type: "string";
                                };
                            };
                        };
                    };
                };
            };
            readonly ClarifyRequest: {
                readonly type: "object";
                readonly required: readonly ["answers"];
                readonly properties: {
                    readonly answers: {
                        readonly type: "object";
                        readonly additionalProperties: {
                            readonly type: "string";
                        };
                        readonly description: "Map of question id → answer string.";
                        readonly example: {
                            readonly q1: "PostgreSQL";
                            readonly q2: "JWT authentication";
                        };
                    };
                };
            };
            readonly TaskStatusResponse: {
                readonly type: "object";
                readonly required: readonly ["taskId", "status"];
                readonly properties: {
                    readonly taskId: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["queued", "running", "needs_clarification", "completed", "failed", "unknown"];
                    };
                };
            };
            readonly InterventionRequest: {
                readonly type: "object";
                readonly required: readonly ["type"];
                readonly properties: {
                    readonly type: {
                        readonly type: "string";
                        readonly enum: readonly ["redirect", "pause", "cancel", "add-constraint"];
                        readonly description: "Type of mid-task intervention to apply.";
                    };
                    readonly payload: {
                        readonly type: "string";
                        readonly description: "Optional instruction or constraint text (required for redirect and add-constraint).";
                    };
                };
            };
            readonly InterventionResponse: {
                readonly type: "object";
                readonly required: readonly ["taskId", "intervention", "status"];
                readonly properties: {
                    readonly taskId: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                    readonly intervention: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly example: "applied";
                    };
                };
            };
            readonly TaskEvent: {
                readonly type: "object";
                readonly description: "Server-Sent Event payload emitted over the /tasks/:id/events SSE stream.";
                readonly properties: {
                    readonly type: {
                        readonly type: "string";
                        readonly description: "TaskEventType string (e.g. plan-ready, plan-node-complete, task-complete).";
                    };
                    readonly taskId: {
                        readonly type: "string";
                    };
                    readonly payload: {
                        readonly type: "object";
                        readonly additionalProperties: true;
                    };
                };
            };
            readonly HITLDecisionRequest: {
                readonly type: "object";
                readonly properties: {
                    readonly reason: {
                        readonly type: "string";
                        readonly description: "Human-readable reason for the approval or rejection.";
                    };
                    readonly modifications: {
                        readonly type: "object";
                        readonly additionalProperties: true;
                        readonly description: "Optional key-value overrides to apply to the pending proposal (approve only).";
                    };
                };
            };
            readonly HITLDecisionResponse: {
                readonly type: "object";
                readonly required: readonly ["requestId", "decision"];
                readonly properties: {
                    readonly requestId: {
                        readonly type: "string";
                    };
                    readonly decision: {
                        readonly type: "string";
                        readonly enum: readonly ["approved", "rejected"];
                    };
                };
            };
            readonly HITLPendingResponse: {
                readonly type: "object";
                readonly required: readonly ["count", "requests"];
                readonly properties: {
                    readonly count: {
                        readonly type: "integer";
                    };
                    readonly requests: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly required: readonly ["requestId", "taskId", "agentId", "reason", "escalatedAt"];
                            readonly properties: {
                                readonly requestId: {
                                    readonly type: "string";
                                };
                                readonly taskId: {
                                    readonly type: "string";
                                };
                                readonly agentId: {
                                    readonly type: "string";
                                };
                                readonly reason: {
                                    readonly type: "string";
                                };
                                readonly escalatedAt: {
                                    readonly type: "integer";
                                    readonly description: "Unix timestamp (ms).";
                                };
                            };
                        };
                    };
                };
            };
            readonly SkillSource: {
                readonly type: "object";
                readonly required: readonly ["name", "url"];
                readonly properties: {
                    readonly name: {
                        readonly type: "string";
                    };
                    readonly url: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly ref: {
                        readonly type: "string";
                        readonly description: "Git ref / tag / branch.";
                    };
                    readonly integrity: {
                        readonly type: "string";
                        readonly description: "SHA-256 integrity hash.";
                    };
                };
            };
            readonly SkillLockEntry: {
                readonly type: "object";
                readonly required: readonly ["source", "version", "resolvedAt", "integrity"];
                readonly properties: {
                    readonly source: {
                        readonly type: "string";
                    };
                    readonly version: {
                        readonly type: "string";
                    };
                    readonly resolvedAt: {
                        readonly type: "string";
                        readonly format: "date-time";
                    };
                    readonly integrity: {
                        readonly type: "string";
                    };
                };
            };
            readonly SkillsListResponse: {
                readonly type: "object";
                readonly required: readonly ["sources", "locked"];
                readonly properties: {
                    readonly sources: {
                        readonly type: "array";
                        readonly items: {
                            readonly $ref: "#/components/schemas/SkillSource";
                        };
                    };
                    readonly locked: {
                        readonly type: "object";
                        readonly additionalProperties: {
                            readonly $ref: "#/components/schemas/SkillLockEntry";
                        };
                    };
                };
            };
            readonly SkillsPullResponse: {
                readonly type: "object";
                readonly required: readonly ["pulled", "skills"];
                readonly properties: {
                    readonly pulled: {
                        readonly type: "integer";
                    };
                    readonly skills: {
                        readonly type: "object";
                        readonly additionalProperties: {
                            readonly $ref: "#/components/schemas/SkillLockEntry";
                        };
                    };
                };
            };
        };
    };
    readonly security: readonly [{
        readonly bearerAuth: readonly [];
    }];
    readonly paths: {
        readonly '/tasks': {
            readonly post: {
                readonly summary: "Submit a new task";
                readonly operationId: "submitTask";
                readonly tags: readonly ["Tasks"];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/SubmitTaskRequest";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '201': {
                        readonly description: "Task accepted and queued.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/SubmitTaskResponse";
                                };
                            };
                        };
                    };
                    readonly '202': {
                        readonly description: "Task requires clarification before it can be queued.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/NeedsClarificationResponse";
                                };
                            };
                        };
                    };
                    readonly '400': {
                        readonly description: "Invalid request body.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/ValidationError";
                                };
                            };
                        };
                    };
                    readonly '500': {
                        readonly description: "Internal server error.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/InternalError";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/tasks/{taskId}': {
            readonly get: {
                readonly summary: "Get task status";
                readonly operationId: "getTask";
                readonly tags: readonly ["Tasks"];
                readonly parameters: readonly [{
                    readonly name: "taskId";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        readonly description: "Current task status.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/TaskStatusResponse";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/tasks/{taskId}/clarify': {
            readonly post: {
                readonly summary: "Submit clarification answers";
                readonly operationId: "clarifyTask";
                readonly tags: readonly ["Tasks"];
                readonly parameters: readonly [{
                    readonly name: "taskId";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/ClarifyRequest";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        readonly description: "Clarification accepted.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/TaskStatusResponse";
                                };
                            };
                        };
                    };
                    readonly '400': {
                        readonly description: "Invalid request body.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/ValidationError";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/tasks/{taskId}/events': {
            readonly get: {
                readonly summary: "Stream task events (Server-Sent Events)";
                readonly operationId: "streamTaskEvents";
                readonly tags: readonly ["Tasks"];
                readonly parameters: readonly [{
                    readonly name: "taskId";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        readonly description: string;
                        readonly content: {
                            readonly 'text/event-stream': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/TaskEvent";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/tasks/{taskId}/redirect': {
            readonly post: {
                readonly summary: "Apply a mid-task intervention (redirect / pause / cancel)";
                readonly operationId: "redirectTask";
                readonly tags: readonly ["Tasks"];
                readonly parameters: readonly [{
                    readonly name: "taskId";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                        readonly format: "uuid";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/InterventionRequest";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        readonly description: "Intervention applied.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/InterventionResponse";
                                };
                            };
                        };
                    };
                    readonly '400': {
                        readonly description: "Invalid request body.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/ValidationError";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/hitl/pending': {
            readonly get: {
                readonly summary: "List pending HITL escalation requests";
                readonly operationId: "listHITLPending";
                readonly tags: readonly ["HITL"];
                readonly parameters: readonly [{
                    readonly name: "tenantId";
                    readonly in: "query";
                    readonly required: false;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        readonly description: "List of pending HITL requests.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/HITLPendingResponse";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/hitl/{requestId}/approve': {
            readonly post: {
                readonly summary: "Approve a HITL escalation";
                readonly operationId: "approveHITL";
                readonly tags: readonly ["HITL"];
                readonly parameters: readonly [{
                    readonly name: "requestId";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly requestBody: {
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/HITLDecisionRequest";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        readonly description: "Request approved.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/HITLDecisionResponse";
                                };
                            };
                        };
                    };
                    readonly '400': {
                        readonly description: "Invalid request body.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/ValidationError";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/hitl/{requestId}/reject': {
            readonly post: {
                readonly summary: "Reject a HITL escalation";
                readonly operationId: "rejectHITL";
                readonly tags: readonly ["HITL"];
                readonly parameters: readonly [{
                    readonly name: "requestId";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly requestBody: {
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/HITLDecisionRequest";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly '200': {
                        readonly description: "Request rejected.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/HITLDecisionResponse";
                                };
                            };
                        };
                    };
                    readonly '400': {
                        readonly description: "Invalid request body.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/ValidationError";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/skills': {
            readonly get: {
                readonly summary: "List configured skill sources and their locked state";
                readonly operationId: "listSkills";
                readonly tags: readonly ["Skills"];
                readonly responses: {
                    readonly '200': {
                        readonly description: "Sources manifest and lockfile contents.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/SkillsListResponse";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/skills/{name}': {
            readonly get: {
                readonly summary: "Retrieve a single resolved skill lock entry";
                readonly operationId: "getSkill";
                readonly tags: readonly ["Skills"];
                readonly parameters: readonly [{
                    readonly name: "name";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly '200': {
                        readonly description: "Skill lock entry.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/SkillLockEntry";
                                };
                            };
                        };
                    };
                    readonly '404': {
                        readonly description: "Skill not found.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly error: {
                                            readonly type: "string";
                                            readonly example: "skill_not_found";
                                        };
                                        readonly name: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/skills/pull': {
            readonly post: {
                readonly summary: "Resolve skill sources into skills.lock";
                readonly operationId: "pullSkills";
                readonly tags: readonly ["Skills"];
                readonly responses: {
                    readonly '200': {
                        readonly description: "Lock file updated.";
                        readonly content: {
                            readonly 'application/json': {
                                readonly schema: {
                                    readonly $ref: "#/components/schemas/SkillsPullResponse";
                                };
                            };
                        };
                    };
                };
            };
        };
    };
};
//# sourceMappingURL=openapi.d.ts.map