"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthMiddleware = createAuthMiddleware;
const crypto_1 = require("crypto");
function createAuthMiddleware(config) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            res.status(401).json({
                error: 'missing_token',
                message: 'Authorization header with Bearer token required',
            });
            return;
        }
        const token = authHeader.slice(7);
        try {
            const payload = verifyJWT(token, config.jwtSecret);
            if (config.issuer && payload.iss !== config.issuer) {
                res.status(401).json({ error: 'invalid_issuer' });
                return;
            }
            if (payload.exp && payload.exp * 1000 < Date.now()) {
                res.status(401).json({ error: 'token_expired' });
                return;
            }
            // tenantId is mandatory — reject tokens that omit it entirely or supply blank
            if (!payload.tenantId || typeof payload.tenantId !== 'string') {
                res.status(401).json({
                    error: 'missing_tenant',
                    message: 'JWT must contain a non-empty tenantId claim',
                });
                return;
            }
            // Attach to request for downstream handlers
            const authedReq = req;
            authedReq.userId = payload.sub;
            authedReq.tenantId = payload.tenantId;
            next();
        }
        catch {
            res.status(401).json({ error: 'invalid_token' });
        }
    };
}
function verifyJWT(token, secret) {
    const parts = token.split('.');
    if (parts.length !== 3)
        throw new Error('Invalid JWT format');
    // parts.length === 3 is guaranteed by the check above; non-null assertions are safe.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [headerB64, payloadB64, signatureB64] = [parts[0], parts[1], parts[2]];
    const data = `${headerB64}.${payloadB64}`;
    const expectedSig = (0, crypto_1.createHmac)('sha256', secret)
        .update(data)
        .digest('base64url');
    if (expectedSig !== signatureB64) {
        throw new Error('Invalid signature');
    }
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    return payload;
}
//# sourceMappingURL=authenticate.js.map