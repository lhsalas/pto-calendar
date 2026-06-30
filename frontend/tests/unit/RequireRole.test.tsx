import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequireRole } from '../../src/components/guards/RequireRole';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { server } from '../mocks/server';
import { authenticated } from '../mocks/handlers';

function renderWithProviders(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route
              path="/admin"
              element={
                <RequireRole role="team_lead">
                  <div data-testid="admin-child">admin</div>
                </RequireRole>
              }
            />
            <Route path="/calendar" element={<div data-testid="calendar">calendar</div>} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('RequireRole', () => {
  it('renders the children when the authenticated user is a team_lead', async () => {
    server.use(authenticated);
    renderWithProviders();
    expect(await screen.findByTestId('admin-child')).toBeInTheDocument();
  });
});
