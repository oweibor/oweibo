/**
 * authenticate — JWT Bearer token authentication middleware (§5c.1).
 *
 * Validates JWT from Authorization header. Signing key loaded from Vault.
 * Attaches `userId` and `tenantId` (both required) to the request object.
 *
 * tenantId is REQUIRED in the JWT payload. Tokens without a tenantId claim
 * are rejected with 401 to prevent anonymous cross-tenant access.
 */
import type { Request, Response, NextFunction } from 'express';
export interface AuthConfig {
    readonly jwtSecret: string;
    readonly issuer?: string;
}
/** Augmented request type exposed to downstream handlers. */
export interface AuthenticatedRequest extends Request {
    userId: string;
    tenantId: string;
    scopes: string[];
}
export declare function createAuthMiddleware(config: AuthConfig): (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=authenticate.d.ts.map