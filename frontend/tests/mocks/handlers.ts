import { http, HttpResponse } from 'msw';
import type { User } from '../../src/types/api';

export const STUB_USER: User = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Team Lead',
  email: 'lead@example.com',
  role: 'team_lead',
  colorCode: '#3B82F6',
};

export const unauthenticated = http.get('/auth/me', () =>
  HttpResponse.json(
    { error: { code: 'UNAUTHENTICATED', message: 'Not authenticated' } },
    { status: 401 },
  ),
);

export const authenticated = http.get('/auth/me', () => HttpResponse.json(STUB_USER));

export const loginOk = http.post('/auth/login', () => HttpResponse.json({ user: STUB_USER }));

export const loginUnauthorized = http.post('/auth/login', () =>
  HttpResponse.json(
    { error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' } },
    { status: 401 },
  ),
);

export const logoutOk = http.post('/auth/logout', () => new HttpResponse(null, { status: 204 }));

export const handlers = [unauthenticated, loginOk, logoutOk];
