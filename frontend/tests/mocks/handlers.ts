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

export const setupAccountOk = http.post('/auth/setup-account', () =>
  HttpResponse.json({ user: STUB_USER }),
);

export const setupAccountBadToken = http.post('/auth/setup-account', () =>
  HttpResponse.json(
    {
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Setup link is invalid or has already been used.',
      },
    },
    { status: 401 },
  ),
);

export const usersList = http.get('/users', () => HttpResponse.json([STUB_USER, STUB_OTHER_USER]));

export const usersListForbidden = http.get('/users', () =>
  HttpResponse.json(
    { error: { code: 'FORBIDDEN', message: 'You do not have permission to manage users.' } },
    { status: 403 },
  ),
);

export const createUserOk = http.post('/users', () =>
  HttpResponse.json(
    {
      user: {
        id: '33333333-3333-3333-3333-333333333333',
        name: 'New Member',
        email: 'newmember@example.com',
        role: 'member',
        colorCode: '#8B5CF6',
      },
      setupToken: 'a'.repeat(64),
      expiresAt: '2026-07-01T00:00:00.000Z',
    },
    { status: 201 },
  ),
);

export const createUserConflict = http.post('/users', () =>
  HttpResponse.json(
    { error: { code: 'CONFLICT', message: 'A user with that email already exists.' } },
    { status: 409 },
  ),
);

export const resetPasswordOk = http.post(/\/users\/[^/]+\/reset-password$/, () =>
  HttpResponse.json({
    setupToken: 'b'.repeat(64),
    expiresAt: '2026-07-01T00:00:00.000Z',
  }),
);

export const resetPasswordSelf = http.post(/\/users\/[^/]+\/reset-password$/, () =>
  HttpResponse.json(
    { error: { code: 'VALIDATION_ERROR', message: 'You cannot reset your own password here.' } },
    { status: 400 },
  ),
);

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

export const holidaysListAll = http.get('/holidays/all', () =>
  HttpResponse.json([
    { id: 'h-1', date: '2026-07-04', name: 'Independence Day', countryCode: 'US' },
    { id: 'h-2', date: '2026-12-25', name: 'Christmas Day', countryCode: null },
  ]),
);

export const holidaysListEmpty = http.get('/holidays/all', () => HttpResponse.json([]));

export const holidaysCreateOk = http.post('/holidays', () =>
  HttpResponse.json(
    { id: 'h-new', date: '2026-11-11', name: 'Veterans Day', countryCode: 'US' },
    { status: 201 },
  ),
);

export const holidaysDeleteOk = http.delete(
  '/holidays/:id',
  () => new HttpResponse(null, { status: 204 }),
);

export const holidaysSeedOk = http.post('/holidays/seed', () =>
  HttpResponse.json({ inserted: 14, skipped: 0, errors: [] }),
);

export const holidaysRange = http.get(/\/holidays\?/, () => HttpResponse.json([]));

export const handlers = [
  unauthenticated,
  loginOk,
  logoutOk,
  ptoListEmpty,
  ptoCreateOk,
  holidaysRange,
];
