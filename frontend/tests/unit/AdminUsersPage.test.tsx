import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { AdminUsersPage } from '../../src/pages/admin/AdminUsersPage';
import { server } from '../mocks/server';
import { authenticated, createUserOk, resetPasswordOk, usersList } from '../mocks/handlers';

function renderWithProviders(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <AdminUsersPage />
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('AdminUsersPage', () => {
  it('lists the existing users', async () => {
    server.use(authenticated, usersList);
    renderWithProviders();
    expect(await screen.findByText(/Team Lead/)).toBeInTheDocument();
    expect(screen.getByText(/Developer One/)).toBeInTheDocument();
  });

  it('creates a user and shows the one-time setup link', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup();
    renderWithProviders();
    await screen.findByText(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    expect(await screen.findByText(/Setup link for/)).toBeInTheDocument();
  });
});
