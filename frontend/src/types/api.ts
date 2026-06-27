export type Role = 'member' | 'team_lead';

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
