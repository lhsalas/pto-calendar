import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../lib/prisma.js';
import {
  parseTokenEmptyBody,
  parseTokenIssue,
  parseTokenQuery,
  verifyTokenIssuancePassword,
} from './tokenManagement.js';

vi.mock('../../lib/prisma.js', () => ({ prisma: { user: { findUnique: vi.fn() } } }));

const password = 'synthetic-current-password';
const owner = {
  id: 'owner',
  role: 'member' as const,
  sessionVersion: 4,
  passwordHash: bcrypt.hashSync(password, 4),
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(prisma.user.findUnique).mockReset();
});

describe('token management input and password proof', () => {
  it('validates strict input, defaults read scope and never accepts owner fields', () => {
    expect(parseTokenIssue({ name: 'Laptop', password })).toEqual({
      name: 'Laptop',
      password,
      scopes: ['pto:read'],
    });
    expect(
      parseTokenIssue({ name: 'Laptop', password, expiresInDays: 365, scopes: ['pto:create'] }),
    ).toMatchObject({ expiresInDays: 365, scopes: ['pto:create'] });
    for (const input of [
      { name: 'Laptop', password, userId: 'other' },
      { name: 'Laptop', password, role: 'admin' },
      { name: ' Laptop', password },
      { name: 'Laptop', password, scopes: ['unknown'] },
      { name: 'Laptop', password, scopes: ['pto:notes:read'] },
      { name: 'Laptop', password, expiresInDays: 0 },
      { name: 'Laptop', password, expiresInDays: 366 },
      { name: 'Laptop', password, expiresInDays: 1.5 },
      { name: 'Laptop', password: '' },
      { name: 'Laptop', password: 'x'.repeat(73) },
    ])
      expect(() => parseTokenIssue(input)).toThrow();
    parseTokenQuery({});
    parseTokenEmptyBody(undefined);
    parseTokenEmptyBody({});
    expect(() => parseTokenQuery({ userId: 'other' })).toThrow();
    expect(() => parseTokenEmptyBody({ userId: 'other' })).toThrow();
  });

  it('reads current credentials by session ID and returns only safe proof', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(owner as never);
    await expect(verifyTokenIssuancePassword('owner', 4, password)).resolves.toEqual({
      id: 'owner',
      role: 'member',
      sessionVersion: 4,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'owner' },
      select: { id: true, role: true, sessionVersion: true, passwordHash: true },
    });
  });

  it('uses the same credential failure for missing, passwordless, stale and wrong-password owners', async () => {
    for (const current of [
      null,
      { ...owner, passwordHash: null },
      { ...owner, sessionVersion: 5 },
      owner,
    ]) {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(current as never);
      await expect(verifyTokenIssuancePassword('owner', 4, 'incorrect')).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
        message: 'Current credentials are not valid.',
      });
    }
  });

  it('replaces database and bcrypt failures without retaining sensitive causes', async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(new Error(password));
    const databaseError = await verifyTokenIssuancePassword('owner', 4, password).catch(
      (e: unknown) => e,
    );
    expect(databaseError).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(String(databaseError)).not.toContain(password);
    expect(databaseError).not.toHaveProperty('cause');
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(owner as never);
    vi.spyOn(bcrypt, 'compare').mockImplementationOnce(() => {
      throw new Error(owner.passwordHash);
    });
    const compareError = await verifyTokenIssuancePassword('owner', 4, password).catch(
      (e: unknown) => e,
    );
    expect(compareError).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(String(compareError)).not.toContain(owner.passwordHash);
    expect(compareError).not.toHaveProperty('cause');
  });
});
