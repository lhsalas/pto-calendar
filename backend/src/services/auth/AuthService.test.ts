import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../middleware/errorHandler.js';
import * as UserService from '../users/UserService.js';
import { getCurrentUser, login } from './AuthService.js';

vi.mock('../users/UserService.js', async () => {
  const actual = await vi.importActual('../users/UserService.js');
  return {
    ...actual,
    getUserWithCredentialsByEmail: vi.fn(),
    getUserById: vi.fn(),
  };
});

const PASSWORD = 'correct-horse-battery-staple';
let passwordHash: string;

const FULL_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Alice',
  email: 'alice@example.com',
  role: 'member' as const,
  colorCode: '#3B82F6',
  passwordHash: '',
  setupTokenHash: null,
  setupTokenExpiresAt: null,
  sessionVersion: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PUBLIC_USER = {
  id: FULL_USER.id,
  name: FULL_USER.name,
  email: FULL_USER.email,
  role: FULL_USER.role,
  colorCode: FULL_USER.colorCode,
};

describe('AuthService', () => {
  beforeEach(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4);
    FULL_USER.passwordHash = passwordHash;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('login', () => {
    it('returns the public user on successful login', async () => {
      vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(FULL_USER);
      const result = await login('alice@example.com', PASSWORD);
      expect(result).toMatchObject(PUBLIC_USER);
      expect(result.sessionVersion).toBe(0);
      expect(UserService.getUserWithCredentialsByEmail).toHaveBeenCalledWith('alice@example.com');
    });

    it("forwards the email to the lookup unchanged (lowercasing is the lookup function's job)", async () => {
      vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(FULL_USER);
      await login('Alice@Example.COM', PASSWORD);
      expect(UserService.getUserWithCredentialsByEmail).toHaveBeenCalledWith('Alice@Example.COM');
    });

    it('throws UNAUTHENTICATED 401 when the user is not found', async () => {
      vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(null);
      await expect(login('ghost@example.com', PASSWORD)).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    });

    it('throws UNAUTHENTICATED 401 on bad password', async () => {
      vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(FULL_USER);
      await expect(login('alice@example.com', 'wrong-password')).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    });

    it('throws UNAUTHENTICATED 401 on empty password without hitting the DB', async () => {
      await expect(login('alice@example.com', '')).rejects.toBeInstanceOf(HttpError);
      expect(UserService.getUserWithCredentialsByEmail).not.toHaveBeenCalled();
    });

    it('uses the same error message for unknown email and bad password', async () => {
      vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(null);
      const unknownEmailError = await login('ghost@example.com', PASSWORD).catch((e) => e);

      vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(FULL_USER);
      const badPasswordError = await login('alice@example.com', 'wrong').catch((e) => e);

      expect(unknownEmailError.message).toBe(badPasswordError.message);
    });

    it('equalizes login timing for the unknown-email and bad-password branches', async () => {
      const REPEAT = 4;
      const timings: { unknown: number; bad: number } = { unknown: 0, bad: 0 };

      for (let i = 0; i < REPEAT; i++) {
        vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(null);
        const t1 = Date.now();
        await login('ghost@example.com', PASSWORD).catch(() => undefined);
        timings.unknown += Date.now() - t1;

        vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(FULL_USER);
        const t2 = Date.now();
        await login('alice@example.com', 'wrong-password').catch(() => undefined);
        timings.bad += Date.now() - t2;
      }

      const unknownAvg = timings.unknown / REPEAT;
      const badAvg = timings.bad / REPEAT;
      const differential = Math.abs(unknownAvg - badAvg);
      // 50ms is generous — bcrypt.compare dominates both paths so the
      // residual differential is the DB lookup time only. The bound is
      // a regression guard, not a tight SLA.
      expect(differential).toBeLessThan(50);
    });

    it('equalizes login timing for the empty-password branch (no DB hit)', async () => {
      const REPEAT = 4;
      const timings: { empty: number; bad: number } = { empty: 0, bad: 0 };

      for (let i = 0; i < REPEAT; i++) {
        const t1 = Date.now();
        await login('alice@example.com', '').catch(() => undefined);
        timings.empty += Date.now() - t1;

        vi.mocked(UserService.getUserWithCredentialsByEmail).mockResolvedValueOnce(FULL_USER);
        const t2 = Date.now();
        await login('alice@example.com', 'wrong-password').catch(() => undefined);
        timings.bad += Date.now() - t2;
      }

      const emptyAvg = timings.empty / REPEAT;
      const badAvg = timings.bad / REPEAT;
      const differential = Math.abs(emptyAvg - badAvg);
      expect(differential).toBeLessThan(50);
    });
  });

  describe('getCurrentUser', () => {
    it('returns the public user when found', async () => {
      vi.mocked(UserService.getUserById).mockResolvedValueOnce(PUBLIC_USER);
      const result = await getCurrentUser(PUBLIC_USER.id);
      expect(result).toEqual(PUBLIC_USER);
    });

    it('throws UNAUTHENTICATED 401 when the user no longer exists', async () => {
      vi.mocked(UserService.getUserById).mockResolvedValueOnce(null);
      await expect(getCurrentUser('stale-id')).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHENTICATED',
      });
    });
  });
});
