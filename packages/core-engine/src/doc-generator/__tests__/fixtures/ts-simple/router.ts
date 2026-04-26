import express, { Router, Request, Response } from 'express';
import type { UserService } from './UserService.js';

/**
 * Mount user-management HTTP routes onto the provided Express router.
 * All routes are scoped under the caller's base path.
 */
export function createUserRouter(svc: UserService): Router {
  const router = Router();

  /** GET /users/:id — fetch a single user by ID */
  router.get('/users/:id', async (req: Request, res: Response) => {
    const user = await svc.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    return res.json(user);
  });

  /** POST /users — create a new user */
  router.post('/users', async (req: Request, res: Response) => {
    const user = await svc.create(req.body);
    return res.status(201).json(user);
  });

  /** DELETE /users/:id — soft-delete a user */
  router.delete('/users/:id', async (req: Request, res: Response) => {
    await svc.delete(req.params.id);
    return res.status(204).send();
  });

  return router;
}
