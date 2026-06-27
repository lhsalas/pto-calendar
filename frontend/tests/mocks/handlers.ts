import { http, HttpResponse } from 'msw';
import type { User } from '../../src/types/api';

const stubUser: User = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Team Lead',
  email: 'lead@example.com',
  role: 'team_lead',
  colorCode: '#3B82F6',
};

export const handlers = [
  http.get('/auth/me', () => HttpResponse.json(stubUser)),
  http.post('/auth/login', () => HttpResponse.json({ user: stubUser })),
  http.post('/auth/logout', () => new HttpResponse(null, { status: 204 })),
];
