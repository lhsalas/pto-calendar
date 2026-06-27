import { http, HttpResponse } from 'msw';
import type { PTOWithUser, User } from '../../src/types/api';

export const STUB_USER: User = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Team Lead',
  email: 'lead@example.com',
  role: 'team_lead',
  colorCode: '#3B82F6',
};

export const STUB_OTHER_USER: User = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Developer One',
  email: 'dev1@example.com',
  role: 'member',
  colorCode: '#10B981',
};

export const STUB_PTO: PTOWithUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  user: { id: STUB_USER.id, name: STUB_USER.name, colorCode: STUB_USER.colorCode },
  startDate: '2026-05-11',
  endDate: '2026-05-11',
  dayPart: 'morning',
  note: null,
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

export const ptoListEmpty = http.get('/pto', () => HttpResponse.json([]));

export const ptoCreateOk = http.post('/pto', () =>
  HttpResponse.json(
    {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      userId: STUB_USER.id,
      startDate: '2026-05-11',
      endDate: '2026-05-11',
      dayPart: 'morning',
      note: null,
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    },
    { status: 201 },
  ),
);

export const ptoConflict = http.post('/pto', () =>
  HttpResponse.json(
    {
      error: {
        code: 'CONFLICT',
        message: 'This PTO overlaps an existing PTO entry for the same user.',
      },
    },
    { status: 409 },
  ),
);

export const ptoUpdateOk = http.put('/pto/:id', () =>
  HttpResponse.json({
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    userId: STUB_USER.id,
    startDate: '2026-05-12',
    endDate: '2026-05-12',
    dayPart: 'evening',
    note: 'Edited',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-02T10:00:00.000Z',
  }),
);

export const ptoDeleteOk = http.delete('/pto/:id', () => new HttpResponse(null, { status: 204 }));

export const ptoGetDetail = http.get('/pto/:id', () =>
  HttpResponse.json({
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    userId: STUB_USER.id,
    startDate: '2026-05-11',
    endDate: '2026-05-11',
    dayPart: 'morning',
    note: 'Doctor',
    user: { id: STUB_USER.id, name: STUB_USER.name, colorCode: STUB_USER.colorCode },
  }),
);

export const handlers = [unauthenticated, loginOk, logoutOk, ptoListEmpty, ptoCreateOk];
