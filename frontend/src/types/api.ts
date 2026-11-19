export type Role = 'member' | 'team_lead' | 'admin';

export type DayPart = 'morning' | 'evening' | 'all_day';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  colorCode: string;
}

export interface PTOUserSummary {
  id: string;
  name: string;
  colorCode: string;
}

export interface PTO {
  id: string;
  userId: string;
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Optimistic concurrency version of the record. It is returned with a
   * detail and with every mutation, and it is the only accepted source for
   * the `If-Match` precondition of a write.
   */
  version: number;
}

export interface PTOWithUser {
  id: string;
  user: PTOUserSummary;
  startDate: string;
  endDate: string;
  dayPart: DayPart;
  note: string | null;
}

export interface PTODetail extends PTOWithUser {
  userId: string;
  createdAt: string;
  updatedAt: string;
  /** The version of the loaded record; a write must quote it. */
  version: number;
}

export interface CreatePTORequest {
  startDate: string;
  endDate: string;
  dayPart?: DayPart;
  note?: string;
}

export interface UpdatePTORequest {
  startDate: string;
  endDate: string;
  dayPart?: DayPart;
  note?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Vocabulary of personal access token scopes. The server validates the same
 * set; `pto:notes:read` depends on `pto:read`, and the team scopes are only
 * available to a live team lead or administrator.
 */
export type TokenScope =
  | 'pto:read'
  | 'pto:notes:read'
  | 'pto:create'
  | 'pto:update:self'
  | 'pto:delete:self'
  | 'pto:update:team'
  | 'pto:delete:team';

/** Server-computed lifecycle status of an owned token. */
export type TokenStatus = 'active' | 'expired' | 'revoked' | 'invalidated';

/**
 * Safe metadata for one owned token. The raw secret is never part of this
 * shape; it is returned exactly once, at issuance time.
 */
export interface TokenMetadata {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: TokenScope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: TokenStatus;
}

export interface IssueTokenRequest {
  name: string;
  password: string;
  scopes: TokenScope[];
  expiresInDays: number;
}

export interface TokenListResponse {
  tokens: TokenMetadata[];
}

export interface IssueTokenResponse {
  rawToken: string;
  token: TokenMetadata;
}

export interface LoginResponse {
  user: User;
}

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorResponse {
  error: ErrorBody;
}

export interface CreateUserRequest {
  email: string;
  name: string;
}

export interface CreateUserResponse {
  user: User;
  setupToken: string;
  expiresAt: string;
}

export interface ResetPasswordResponse {
  setupToken: string;
  expiresAt: string;
}

export interface SetupAccountRequest {
  token: string;
  password: string;
}

export interface Holiday {
  id: string;
  date: string;
  name: string;
  countryCode: string | null;
}

export interface CreateHolidayRequest {
  date: string;
  name: string;
  countryCode?: string | null;
}

export interface SeedHolidayRequest {
  countryCode: 'US' | 'MX' | 'CO' | 'CL';
}

export interface SeedHolidayResponse {
  inserted: number;
  skipped: number;
  errors: string[];
}
