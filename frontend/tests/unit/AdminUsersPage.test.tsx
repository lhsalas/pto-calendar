import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { AdminUsersPage } from '../../src/pages/admin/AdminUsersPage';
import { server } from '../mocks/server';
import { authenticated, createUserOk, usersList } from '../mocks/handlers';

function renderWithProviders(initialPath: string = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<AdminUsersPage />} />
            <Route path="/calendar" element={<h1>Calendar Page</h1>} />
            <Route path="/login" element={<h1>Login Page</h1>} />
          </Routes>
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

  it('renders a Back to calendar link that points to /calendar', async () => {
    server.use(authenticated, usersList);
    renderWithProviders();
    await screen.findByText(/Team Lead/);
    const link = screen.getByTestId('back-to-calendar-link');
    expect(link).toHaveAttribute('href', '/calendar');
  });

  it('navigates to /calendar when the Back to calendar link is clicked', async () => {
    server.use(authenticated, usersList);
    const user = userEvent.setup();
    renderWithProviders('/');
    await screen.findByText(/Team Lead/);
    await user.click(screen.getByTestId('back-to-calendar-link'));
    expect(await screen.findByRole('heading', { name: /calendar page/i })).toBeInTheDocument();
  });

  it('renders a Sign out button', async () => {
    server.use(
      authenticated,
      usersList,
      http.post('/auth/logout', () => new HttpResponse(null, { status: 204 })),
    );
    renderWithProviders();
    await screen.findByText(/Team Lead/);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
