import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LoginPage } from '../../src/pages/LoginPage';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/useAuth';
import { server } from '../mocks/server';
import { authenticated } from '../mocks/handlers';

function LocationDisplay(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function CalendarProbe(): JSX.Element {
  const { user } = useAuth();
  return <div data-testid="calendar-user">{user?.email ?? 'no-user'}</div>;
}

function renderWithProviders(initialPath = '/login'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <AuthProvider>
          <LocationDisplay />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/calendar"
              element={
                <>
                  <CalendarProbe />
                </>
              }
            />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  it('renders the sign-in form', () => {
    renderWithProviders();
    expect(screen.getByRole('heading', { name: /pto calendar/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('submits credentials and navigates to /calendar on success', async () => {
    const user = userEvent.setup();
    renderWithProviders();

    await user.type(screen.getByLabelText(/email/i), 'lead@example.com');
    await user.type(screen.getByLabelText(/password/i), 'lead-dev-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/calendar');
    });
    expect(screen.getByTestId('calendar-user')).toHaveTextContent('lead@example.com');
  });

  it('shows an inline error message when login fails', async () => {
    server.use(
      http.post('/auth/login', () =>
        HttpResponse.json(
          { error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' } },
          { status: 401 },
        ),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders();
    await user.type(screen.getByLabelText(/email/i), 'lead@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid email or password/i);
    expect(screen.getByTestId('location')).toHaveTextContent('/login');
  });

  it('disables the submit button while the request is in flight', async () => {
    const user = userEvent.setup();
    renderWithProviders();
    const submit = screen.getByRole('button', { name: /sign in/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await user.type(screen.getByLabelText(/email/i), 'lead@example.com');
    await user.type(screen.getByLabelText(/password/i), 'lead-dev-password');
    await user.click(submit);
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/calendar');
    });
  });

  it('redirects to /calendar when already authenticated', async () => {
    server.use(authenticated);
    renderWithProviders('/login');
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/calendar');
    });
  });

  it('caps the email input at 254 chars (RFC 5321 practical max) and the password at 72 (bcrypt cap)', () => {
    renderWithProviders();
    const email = screen.getByLabelText(/email/i) as HTMLInputElement;
    const password = screen.getByLabelText(/password/i) as HTMLInputElement;
    expect(email.maxLength).toBe(254);
    expect(password.maxLength).toBe(72);
    expect(email.getAttribute('autocomplete')).toBe('username');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
  });
});
