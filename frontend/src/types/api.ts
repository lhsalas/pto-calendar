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
}

export interface CreatePTORequest {
  startDate: string;
  endDate: string;
  dayPart?: DayPart;
  note?: string;
}

export interface UpdatePTORequest {
  startDate?: string;
  endDate?: string;
  dayPart?: DayPart;
  note?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
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
  countryCode: 'US' | 'MX';
}

export interface SeedHolidayResponse {
  inserted: number;
  skipped: number;
  errors: string[];
}
