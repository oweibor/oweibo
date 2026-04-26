import { createTasksRouter } from './routes/tasks.routes.js';
import { createHITLRouter } from './routes/hitl.routes.js';
import type { SecretsManager } from '../secrets/SecretsManager.js';
export interface ServerConfig {
    readonly port: number;
    readonly corsOrigins: string[];
    readonly rateLimitWindowMs: number;
    readonly rateLimitMax: number;
}
export declare function createServer(deps: {
    secrets: SecretsManager;
    intentPipeline: Parameters<typeof createTasksRouter>[0]['intentPipeline'];
    taskEventBus: Parameters<typeof createTasksRouter>[0]['taskEventBus'];
    interventionGateway: Parameters<typeof createTasksRouter>[0]['interventionGateway'];
    hitlGateway: Parameters<typeof createHITLRouter>[0]['hitlGateway'];
}, config?: Partial<ServerConfig>): Promise<{
    app: import('express').Application;
    port: number;
}>;
export declare function startServer(...args: Parameters<typeof createServer>): Promise<void>;
//# sourceMappingURL=server.d.ts.map