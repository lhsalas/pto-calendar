import bcrypt from 'bcryptjs';
import { HttpError } from '../../middleware/errorHandler.js';
import { getUserById, getUserWithCredentialsByEmail, type ApiUser } from '../users/UserService.js';

export async function login(email: string, password: string): Promise<ApiUser> {
  if (password.length === 0) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid email or password.');
  }

  const user = await getUserWithCredentialsByEmail(email);
  if (!user) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid email or password.');
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid email or password.');
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    colorCode: user.colorCode,
  };
}

export async function getCurrentUser(userId: string): Promise<ApiUser> {
  const user = await getUserById(userId);
  if (!user) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Session is no longer valid.');
  }
  return user;
}
