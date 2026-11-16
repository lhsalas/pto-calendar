import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '../services/users/UserService.js';

const { input, getUserById, resetUserPassword, record } = vi.hoisted(() => ({
  input: { id: 'target-user' as string | string[] | undefined },
  getUserById: vi.fn(),
  resetUserPassword: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../middleware/requireAuth.js', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 'actor', role: 'team_lead', sessionVersion: 1 };
    // Exercise the widened Express 5 type; the real non-wildcard route supplies a string.
    if (input.id === undefined) delete req.params.id;
    else req.params.id = input.id;
    next();
  },
}));
vi.mock('../services/users/UserService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserById,
  resetUserPassword,
}));
vi.mock('../services/audit/AuditLogService.js', () => ({ record }));
vi.mock('../lib/prisma.js', () => ({ prisma: {} }));

import { createUsersRouter } from './users.js';
import { errorHandler } from '../middleware/errorHandler.js';

describe('reset-password parameter compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserById.mockResolvedValue({
      id: 'target-user',
      email: 'target@example.test',
      role: 'member',
    });
    resetUserPassword.mockResolvedValue({
      setupToken: { plaintext: 'test-only-token', expiresAt: new Date('2026-12-01T00:00:00Z') },
    });
    record.mockResolvedValue(undefined);
  });

  function reset(id: string | string[] | undefined) {
    input.id = id;
    const app = express();
    app.use('/users', createUsersRouter());
    app.use(errorHandler);
    return request(app).post('/users/target-user/reset-password');
  }

  it.each([{ id: 'target-user' }, { id: ['target-user', 'unused-value'] }])(
    'uses the first string value from $id',
    async ({ id }) => {
      const response = await reset(id);
      expect(response.status).toBe(200);
      expect(getUserById).toHaveBeenCalledExactlyOnceWith('target-user');
      expect(resetUserPassword).toHaveBeenCalledExactlyOnceWith('target-user');
      expect(record).toHaveBeenCalledExactlyOnceWith({
        actorUserId: 'actor',
        action: 'reset_user_password',
        entityType: 'user',
        entityId: 'target-user',
        details: { email: 'target@example.test' },
      });
    },
  );

  it.each([{ id: undefined }, { id: [] }])(
    'rejects missing parameter value $id before lookup',
    async ({ id }) => {
      const response = await reset(id);
      expect(response.status).toBe(400);
      expect(response.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'User id is required.',
      });
      expect(getUserById).not.toHaveBeenCalled();
      expect(resetUserPassword).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    },
  );

  it('retains self-reset denial after narrowing', async () => {
    const response = await reset(['actor']);
    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('You cannot reset your own password here.');
    expect(getUserById).not.toHaveBeenCalled();
    expect(resetUserPassword).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
