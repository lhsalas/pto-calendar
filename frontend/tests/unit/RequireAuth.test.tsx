import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/context/AuthContext';
import { RequireAuth } from '../../src/routes/RequireAuth';
import { server } from '../mocks/server';
import { authenticated } from '../mocks/handlers';

function Protected(): JSX.Element {
  return <div data-testid="protected">protected content</div>;
}

function renderWithAuth(initialPath: string): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<div data-testid="login">login page</div>} />
          <Route
            path="/protected"
            element={
              <RequireAuth>
                <Protected />
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  it('shows a loading indicator while the session is being resolved', async () => {
    server.use(
      http.get('/auth/me', async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Lead',
          email: 'lead@example.com',
          role: 'team_lead',
          colorCode: '#3B82F6',
        });
      }),
    );
    renderWithAuth('/protected');
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('protected')).toBeInTheDocument();
    });
  });

  it('redirects to /login when there is no session', async () => {
    renderWithAuth('/protected');
    await waitFor(() => {
      expect(screen.getByTestId('login')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  it('renders the protected content when authenticated', async () => {
    server.use(authenticated);
    renderWithAuth('/protected');
    await waitFor(() => {
      expect(screen.getByTestId('protected')).toBeInTheDocument();
    });
  });
});
