import bcrypt from 'bcryptjs';
import { HttpError } from '../../middleware/errorHandler.js';
import { getUserById, getUserWithCredentialsByEmail, type ApiUser } from '../users/UserService.js';

const TIMING_EQUALIZATION_TARGET = 'timing-equalization-dummy-target-32+chars';
const DUMMY_HASH = bcrypt.hashSync(TIMING_EQUALIZATION_TARGET, 4);

async function equalizeTiming(): Promise<void> {
  try {
    await bcrypt.compare(TIMING_EQUALIZATION_TARGET, DUMMY_HASH);
  } catch {
    // swallow — this is timing-equalization, not authentication
  }
}

function unauthenticated(): never {
  throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid email or password.');
}

export async function login(email: string, password: string): Promise<ApiUser> {
  if (password.length === 0) {
    await equalizeTiming();
    unauthenticated();
  }

  const user = await getUserWithCredentialsByEmail(email);
  if (!user || !user.passwordHash) {
    await equalizeTiming();
    unauthenticated();
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    unauthenticated();
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
