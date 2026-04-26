/**
 * oweibo redirect — send a human intervention message to a paused task.
 *
 * Usage:
 *   oweibo redirect <taskId> "use PostgreSQL not SQLite"
 *   oweibo redirect <taskId> --approve <requestId>
 *   oweibo redirect <taskId> --reject <requestId> "not approved"
 */
import { Command } from 'commander';
export declare function makeRedirectCommand(): Command;
//# sourceMappingURL=redirect.d.ts.map