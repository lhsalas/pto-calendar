import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUserByEmail,
  getUserById,
  getUserWithCredentialsByEmail,
  type ApiUser,
} from './UserService.js';

vi.mock('../../lib/prisma.js', () => {
  const user = {
    findUnique: vi.fn(),
  };
  return { prisma: { user } };
});

import { prisma } from '../../lib/prisma.js';

const mockFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;

const PUBLIC_USER: ApiUser = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Alice',
  email: 'alice@example.com',
  role: 'member',
  colorCode: '#3B82F6',
};

const FULL_USER = {
  ...PUBLIC_USER,
  passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('UserService', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getUserById', () => {
    it('returns the public user fields when found', async () => {
      mockFindUnique.mockResolvedValueOnce(PUBLIC_USER);
      const result = await getUserById(PUBLIC_USER.id);
      expect(result).toEqual(PUBLIC_USER);
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: PUBLIC_USER.id },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          colorCode: true,
        },
      });
    });

    it('returns null when not found', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      const result = await getUserById('not-a-real-id');
      expect(result).toBeNull();
    });
  });

  describe('getUserByEmail', () => {
    it('lowercases the email before querying', async () => {
      mockFindUnique.mockResolvedValueOnce(PUBLIC_USER);
      const result = await getUserByEmail('Alice@Example.COM');
      expect(result).toEqual(PUBLIC_USER);
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { email: 'alice@example.com' },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          colorCode: true,
        },
      });
    });

    it('returns null when no user matches', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      const result = await getUserByEmail('ghost@example.com');
      expect(result).toBeNull();
    });
  });

  describe('getUserWithCredentialsByEmail', () => {
    it('returns the full Prisma user including passwordHash', async () => {
      mockFindUnique.mockResolvedValueOnce(FULL_USER);
      const result = await getUserWithCredentialsByEmail('Alice@Example.COM');
      expect(result).toEqual(FULL_USER);
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { email: 'alice@example.com' },
      });
    });

    it('returns null when not found', async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      const result = await getUserWithCredentialsByEmail('nobody@example.com');
      expect(result).toBeNull();
    });
  });
});
