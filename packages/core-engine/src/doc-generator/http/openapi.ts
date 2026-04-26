/**
 * openapi.ts — OpenAPI 3.1 specification for the /api/v1/docs/* endpoints (C10, v10.5).
 *
 * Returned from GET /api/v1/docs/openapi.json.
 * Built inline (no zod-to-openapi dependency required) with the same Zod-validated
 * request/response shapes as docsRouter.ts.
 */

export function docsOpenApiSpec(): object {
  return {
    openapi: '3.1.0',
    info: {
      title:       'Oweibo Doc Generator API',
      version:     '1.0.0',
      description: 'Autonomous codebase documentation generator (v10.5)',
      contact: {
        name: 'Oweibo Platform',
      },
    },
    servers: [{ url: '/api/v1/docs' }],
    paths: {
      '/generate': {
        post: {
          summary:     'Enqueue a documentation generation job',
          operationId: 'generateDocs',
          parameters: [
            {
              name:     'Idempotency-Key',
              in:       'header',
              required: false,
              schema:   { type: 'string', format: 'uuid' },
              description: 'UUID per-invocation. If supplied and the key maps to an existing session, returns it without enqueueing a new job.',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type:     'object',
                  required: ['rootPath', 'tenantId'],
                  properties: {
                    rootPath:  { type: 'string', description: 'Absolute path to the repo root' },
                    tenantId:  { type: 'string', description: 'Tenant identifier' },
                    options: {
                      type: 'object',
                      properties: {
                        skipLLM:         { type: 'boolean', default: false },
                        dryRun:          { type: 'boolean', default: false, description: 'Preview scope only — no analysis or output written' },
                        redactAuthors:   { type: 'boolean', default: true },
                        maxFiles:        { type: 'integer', minimum: 1 },
                        outputDir:       { type: 'string' },
                        excludePatterns: { type: 'array', items: { type: 'string' } },
                        only:            { type: 'array', items: { type: 'string' }, description: 'Subset of doc categories to render' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '202': {
              description: 'Job enqueued. Poll /status/:sessionId or stream /stream/:sessionId.',
              content: {
                'application/vnd.oweibo.docs.v1+json': {
                  schema: {
                    type: 'object',
                    properties: {
                      sessionId:     { type: 'string', format: 'uuid' },
                      queued:        { type: 'boolean' },
                      schemaVersion: { type: 'string', enum: ['v1'] },
                    },
                  },
                },
              },
            },
            '200': { description: 'Idempotency hit — existing session returned' },
            '400': { description: 'Invalid request body' },
            '429': { description: 'Daily token quota exceeded', headers: { 'Retry-After': { schema: { type: 'integer' } } } },
          },
        },
      },
      '/status/{sessionId}': {
        get: {
          summary:     'Get session status and paginated warnings',
          operationId: 'getDocStatus',
          parameters: [
            { name: 'sessionId', in: 'path',  required: true,  schema: { type: 'string' } },
            { name: 'tenantId',  in: 'query', required: true,  schema: { type: 'string' } },
            { name: 'page',      in: 'query', required: false, schema: { type: 'integer', default: 1 } },
            { name: 'pageSize',  in: 'query', required: false, schema: { type: 'integer', default: 50, maximum: 50 } },
          ],
          responses: {
            '200': { description: 'Session state and paginated warnings' },
            '404': { description: 'Session not found' },
          },
        },
      },
      '/stream/{sessionId}': {
        get: {
          summary:     'SSE stream of TaskEventBus events for a session',
          operationId: 'streamDocEvents',
          parameters: [
            { name: 'sessionId', in: 'path',  required: true, schema: { type: 'string' } },
            { name: 'tenantId',  in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Server-Sent Events stream',
              content: { 'text/event-stream': { schema: { type: 'string' } } },
            },
          },
        },
      },
      '/cancel/{sessionId}': {
        post: {
          summary:     'Cancel an in-progress session',
          operationId: 'cancelDocSession',
          parameters: [
            { name: 'sessionId', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type:       'object',
                  required:   ['tenantId'],
                  properties: { tenantId: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Session cancelled' },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary:     'This OpenAPI specification',
          operationId: 'getDocsOpenApi',
          responses: {
            '200': {
              description: 'OpenAPI 3.1 document',
              content: { 'application/json': {} },
            },
          },
        },
      },
    },
  };
}
