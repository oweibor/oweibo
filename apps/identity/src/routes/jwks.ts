import { Router } from 'express';
import { getJwks } from '../services/jwks.js';

const router = Router();

// GET /.well-known/jwks.json
// Downstream gateways fetch this to verify RS256 tokens.
// Cache-Control: 10 min — allows fast JWKS rotation without cache-busting issues.
router.get('/.well-known/jwks.json', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  res.json(getJwks());
});

export default router;
