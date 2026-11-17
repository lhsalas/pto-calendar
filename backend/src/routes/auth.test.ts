import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patFixture } from '../../tests/unit/helpers/patFixture.js';
import { resetEnvForTests } from '../config/env.js';
import { __resetAuthUserCacheForTests } from '../middleware/requireAuth.js';
import { prisma } from '../lib/prisma.js';
import { getCurrentUser, login } from '../services/auth/AuthService.js';
import { setupAccount } from '../services/users/UserService.js';
import { createAuthRouter } from './auth.js';

vi.mock('../lib/prisma.js', () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock('../services/auth/AuthService.js', () => ({ login: vi.fn(), getCurrentUser: vi.fn() }));
vi.mock('../services/users/UserService.js', async () => ({
  ...(await vi.importActual('../services/users/UserService.js')),
  setupAccount: vi.fn(),
}));
const user = {
  id: 'owner',
  name: 'Owner',
  email: 'owner@example.test',
  role: 'member' as const,
  colorCode: '#123456',
};
const authenticated = { ...user, sessionVersion: 4 };

function fixture() {
  const f = patFixture();
  f.app.use(
    '/auth',
    createAuthRouter((_req, _res, next) => next()),
  );
  f.finish();
  return f;
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetAuthUserCacheForTests();
  vi.mocked(prisma.user.findUnique).mockImplementation(
    () => Promise.resolve(authenticated) as never,
  );
  vi.mocked(login).mockResolvedValue(authenticated);
  vi.mocked(getCurrentUser).mockResolvedValue(user);
  vi.mocked(setupAccount).mockResolvedValue({ user: authenticated } as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvForTests();
});

describe('auth HTTP alternatives without expanding PAT privileges', () => {
  it('preserves session login/setup/logout and public identity response shapes', async () => {
    const f = fixture();
    const loggedIn = await request(f.app)
      .post('/auth/login')
      .send({ email: user.email, password: 'password' })
      .expect(200);
    expect(loggedIn.body).toEqual({ user });
    const setup = await request(f.app)
      .post('/auth/setup-account')
      .send({ token: 'x'.repeat(64), password: 'new-password' })
      .expect(200);
    expect(setup.body).toEqual({ user });
    f.setSession({ id: user.id, role: user.role, sessionVersion: 4 });
    const me = await request(f.app).get('/auth/me').expect(200);
    expect(me.body).toEqual(user);
    expect(me.body).not.toHaveProperty('sessionVersion');
    await request(f.app).post('/auth/logout').expect(204);
  });

  it('returns only safe PAT identity/status metadata without running session identity lookup', async () => {
    const f = fixture();
    const res = await request(f.app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${f.material.rawToken}`)
      .expect(200);
    expect(res.body).toEqual({
      id: f.owner.id,
      role: 'member',
      auth: {
        method: 'pat',
        tokenId: f.token.id,
        scopes: ['pto:read'],
        expiresAt: f.token.expiresAt.toISOString(),
      },
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(f.material.rawToken);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('forwards login/setup/session-identity failures and does not return credential versions', async () => {
    const f = fixture();
    await request(f.app).post('/auth/login').send({}).expect(400);
    await request(f.app).post('/auth/setup-account').send({}).expect(400);
    f.setSession({ id: user.id, role: user.role, sessionVersion: 4 });
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error('identity failed'));
    await request(f.app).get('/auth/me').expect(500);
  });
});
