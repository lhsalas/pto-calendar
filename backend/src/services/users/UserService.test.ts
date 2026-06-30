import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { resetEnvForTests } from '../../config/env.js';
import {
  createUser,
  setupAccount,
  resetUserPassword,
  generateSetupToken,
  hashSetupToken,
  PasswordSchema,
  SetupAccountSchema,
} from './UserService.js';
import { HttpError } from '../../middleware/errorHandler.js';

vi.mock('../../lib/prisma.js', () => {
  const user = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  };
  return { prisma: { user } };
});

import { prisma } from '../../lib/prisma.js';

const mockFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.user.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockFindMany = prisma.user.findMany as unknown as ReturnType<typeof vi.fn>;
const mockCreate = prisma.user.create as unknown as ReturnType<typeof vi.fn>;
const mockUpdate = prisma.user.update as unknown as ReturnType<typeof vi.fn>;
const mockCount = prisma.user.count as unknown as ReturnType<typeof vi.fn>;

const SEED_EMAILS = ['lead@example.com', 'dev1@example.com', 'dev2@example.com'];

beforeEach(() => {
  process.env.SESSION_SECRET = 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgresql://pto:pto@localhost:5432/pto_test';
  process.env.SETUP_TOKEN_TTL_MS = '60000';
  process.env.BCRYPT_ROUNDS = '4';
  resetEnvForTests();
  mockFindUnique.mockReset();
  mockFindFirst.mockReset();
  mockFindMany.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCount.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('UserService setup token helpers', () => {
  it('generates a 64-char hex token and a sha256 hash', () => {
    const { plaintext, hash, expiresAt } = generateSetupToken();
    expect(plaintext).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashSetupToken(plaintext));
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('PasswordSchema rejects short and over-72-char passwords', () => {
    expect(PasswordSchema.safeParse('short').success).toBe(false);
    expect(PasswordSchema.safeParse('a'.repeat(73)).success).toBe(false);
    expect(PasswordSchema.safeParse('a'.repeat(8)).success).toBe(true);
    expect(PasswordSchema.safeParse('a'.repeat(72)).success).toBe(true);
  });

  it('SetupAccountSchema validates the token + password', () => {
    const r = SetupAccountSchema.safeParse({ token: 'a'.repeat(32), password: 'a'.repeat(8) });
    expect(r.success).toBe(true);
    const r2 = SetupAccountSchema.safeParse({ token: 'a'.repeat(31), password: 'a'.repeat(8) });
    expect(r2.success).toBe(false);
  });
});

describe('createUser', () => {
  it('creates a member with a setup token, no password', async () => {
    mockFindUnique.mockResolvedValueOnce(null); // no duplicate
    mockFindMany.mockResolvedValueOnce([]); // colorCode palette
    mockCreate.mockImplementationOnce(({ data }) =>
      Promise.resolve({ id: 'u-new', ...data, createdAt: new Date(), updatedAt: new Date() }),
    );
    const token = generateSetupToken();
    const user = await createUser({
      email: 'newmember@example.com',
      name: 'New Member',
      role: 'member',
      setupToken: token,
    });
    expect(user.email).toBe('newmember@example.com');
    expect(user.role).toBe('member');
    expect(user.passwordHash).toBeNull();
    expect(user.setupTokenHash).toBe(token.hash);
    expect(user.setupTokenExpiresAt).toEqual(token.expiresAt);
  });

  it('returns 409 on duplicate email', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'existing' });
    let caught: unknown;
    try {
      await createUser({ email: 'lead@example.com', name: 'dup', role: 'member' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });

  it('lowercases the email before the duplicate check', async () => {
    mockFindUnique.mockImplementationOnce(({ where }) => {
      expect(where.email).toBe('mixed@example.com');
      return Promise.resolve(null);
    });
    mockFindMany.mockResolvedValueOnce([]);
    mockCreate.mockImplementationOnce(({ data }) =>
      Promise.resolve({ id: 'u-mixed', ...data, createdAt: new Date(), updatedAt: new Date() }),
    );
    const user = await createUser({
      email: 'MIXED@Example.COM',
      name: 'Mixed',
      role: 'member',
    });
    expect(user.email).toBe('mixed@example.com');
  });

  it('assigns a colorCode from the palette that is a 6-digit hex', async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    mockFindMany.mockResolvedValueOnce([]); // no existing users
    mockCreate.mockImplementationOnce(({ data }) =>
      Promise.resolve({ id: 'u-a', ...data, createdAt: new Date(), updatedAt: new Date() }),
    );
    const u1 = await createUser({ email: 'a@example.com', name: 'A', role: 'member' });
    expect(u1.colorCode).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('skips colors already in use when picking the colorCode', async () => {
    // Mark the first 3 palette colors as taken.
    mockFindUnique.mockResolvedValueOnce(null);
    mockFindMany.mockResolvedValueOnce([
      { colorCode: '#3B82F6' },
      { colorCode: '#10B981' },
      { colorCode: '#F59E0B' },
    ]);
    mockCreate.mockImplementationOnce(({ data }) =>
      Promise.resolve({ id: 'u-b', ...data, createdAt: new Date(), updatedAt: new Date() }),
    );
    const u = await createUser({ email: 'b@example.com', name: 'B', role: 'member' });
    expect(u.colorCode).not.toBe('#3B82F6');
    expect(u.colorCode).not.toBe('#10B981');
    expect(u.colorCode).not.toBe('#F59E0B');
  });
});

describe('setupAccount', () => {
  it('sets the password, clears the token, and returns the user', async () => {
    const token = generateSetupToken();
    mockFindFirst.mockResolvedValueOnce({
      id: 'u1',
      email: 'newcomer@example.com',
      role: 'member',
      name: 'Newcomer',
      colorCode: '#3B82F6',
      passwordHash: null,
      setupTokenHash: token.hash,
      setupTokenExpiresAt: token.expiresAt,
    });
    mockUpdate.mockImplementationOnce(({ data }) => Promise.resolve({ id: 'u1', ...data }));
    const result = await setupAccount({ token: token.plaintext, password: 'correct-horse' });
    expect(result.user.id).toBe('u1');
    expect(result.user.passwordHash).not.toBeNull();
    expect(result.user.setupTokenHash).toBeNull();
    expect(result.user.setupTokenExpiresAt).toBeNull();
    const matches = await bcrypt.compare('correct-horse', result.user.passwordHash!);
    expect(matches).toBe(true);
  });

  it('rejects a reused/spent token with the same 401 as an unknown one (no enumeration)', async () => {
    const token = generateSetupToken();
    mockFindFirst.mockResolvedValueOnce({
      id: 'u1',
      email: 'r@example.com',
      name: 'R',
      role: 'member',
      colorCode: '#3B82F6',
      passwordHash: null,
      setupTokenHash: token.hash,
      setupTokenExpiresAt: token.expiresAt,
    });
    mockUpdate.mockImplementationOnce(({ data }) => Promise.resolve({ id: 'u1', ...data }));
    await setupAccount({ token: token.plaintext, password: 'first-password' });
    // second redemption of the same token — findFirst returns null because
    // the token columns are now cleared.
    mockFindFirst.mockResolvedValueOnce(null);
    let caught: unknown;
    try {
      await setupAccount({ token: token.plaintext, password: 'second-password' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown token with 401', async () => {
    mockFindFirst.mockResolvedValueOnce(null);
    let caught: unknown;
    try {
      await setupAccount({ token: 'a'.repeat(64), password: 'whatever123' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired token with 401 and clears it', async () => {
    const token = generateSetupToken();
    const past = new Date(Date.now() - 1000);
    mockFindFirst.mockResolvedValueOnce({
      id: 'u1',
      email: 'e@example.com',
      name: 'E',
      role: 'member',
      colorCode: '#3B82F6',
      passwordHash: null,
      setupTokenHash: token.hash,
      setupTokenExpiresAt: past,
    });
    mockUpdate.mockResolvedValueOnce({ id: 'u1' });
    let caught: unknown;
    try {
      await setupAccount({ token: token.plaintext, password: 'whatever123' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(401);
    expect(err.code).toBe('UNAUTHENTICATED');
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          setupTokenHash: null,
          setupTokenExpiresAt: null,
        }),
      }),
    );
  });
});

describe('resetUserPassword', () => {
  it('clears the password and issues a fresh token', async () => {
    mockFindUnique.mockResolvedValueOnce({ id: 'u1' });
    mockUpdate.mockImplementationOnce(({ data }) => Promise.resolve({ id: 'u1', ...data }));
    const result = await resetUserPassword('u1');
    expect(result.setupToken.plaintext).toMatch(/^[a-f0-9]{64}$/);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({
          passwordHash: null,
          setupTokenHash: result.setupToken.hash,
        }),
      }),
    );
  });

  it('returns 404 for an unknown user id', async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    let caught: unknown;
    try {
      await resetUserPassword('00000000-0000-0000-0000-000000000000');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});

// SEED_EMAILS retained to keep the test file structure consistent with
// future test cases (e.g. a real-DB integration test).
void SEED_EMAILS;
