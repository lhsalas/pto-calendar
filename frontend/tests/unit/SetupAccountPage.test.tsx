import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SetupAccountPage } from '../../src/pages/SetupAccountPage';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { server } from '../mocks/server';
import { setupAccountBadToken, setupAccountOk } from '../mocks/handlers';

function renderWithProviders(initialPath: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/setup-account" element={<SetupAccountPage />} />
            <Route path="/calendar" element={<div data-testid="calendar">calendar</div>} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('SetupAccountPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the password + confirm form', () => {
    renderWithProviders('/setup-account?token=abc');
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set password/i })).toBeInTheDocument();
  });

  it('scrubs a token from the browser URL after reading it', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderWithProviders('/setup-account?token=abc');

    expect(replaceState).toHaveBeenCalled();
    const lastCall = replaceState.mock.calls.at(-1);
    expect(String(lastCall?.[2])).not.toContain('token=');
  });

  it('accepts a token in the URL fragment', () => {
    renderWithProviders('/setup-account#token=abc');
    expect(screen.getByRole('button', { name: /set password/i })).not.toBeDisabled();
  });

  it('rejects passwords shorter than 8 characters', async () => {
    const user = userEvent.setup();
    renderWithProviders('/setup-account?token=abc');
    await user.type(screen.getByLabelText(/^password$/i), 'short');
    await user.type(screen.getByLabelText(/confirm password/i), 'short');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 8/i);
  });

  it('rejects mismatched confirm', async () => {
    const user = userEvent.setup();
    renderWithProviders('/setup-account?token=abc');
    await user.type(screen.getByLabelText(/^password$/i), 'goodpassword');
    await user.type(screen.getByLabelText(/confirm password/i), 'differentpassword');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
  });

  it('redeems a valid token, sets a session, and navigates to /calendar', async () => {
    server.use(setupAccountOk);
    const user = userEvent.setup();
    renderWithProviders('/setup-account?token=abc');
    await user.type(screen.getByLabelText(/^password$/i), 'goodpassword');
    await user.type(screen.getByLabelText(/confirm password/i), 'goodpassword');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    await waitFor(() => {
      expect(screen.getByTestId('calendar')).toBeInTheDocument();
    });
  });

  it('shows the right error message on a 401 (bad/spent token)', async () => {
    server.use(setupAccountBadToken);
    const user = userEvent.setup();
    renderWithProviders('/setup-account?token=abc');
    await user.type(screen.getByLabelText(/^password$/i), 'goodpassword');
    await user.type(screen.getByLabelText(/confirm password/i), 'goodpassword');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid or has already been used/i);
  });

  it('disables the submit button and keeps the URL when no setup token is present', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderWithProviders('/setup-account');
    expect(screen.getByRole('button', { name: /set password/i })).toBeDisabled();
    // There is no token to scrub, so the URL is left untouched.
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('keeps the other query parameters when the token is scrubbed from the URL', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderWithProviders('/setup-account?token=abc&next=calendar');
    expect(replaceState).toHaveBeenCalled();
    const lastCall = replaceState.mock.calls.at(-1);
    expect(String(lastCall?.[2])).toBe('/setup-account?next=calendar');
  });

  it('shows the server message when the setup fails with a non-401 error', async () => {
    server.use(
      http.post('/auth/setup-account', () =>
        HttpResponse.json(
          { error: { code: 'UNAVAILABLE', message: 'Setup service is down.' } },
          { status: 503 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders('/setup-account?token=abc');
    await user.type(screen.getByLabelText(/^password$/i), 'goodpassword');
    await user.type(screen.getByLabelText(/confirm password/i), 'goodpassword');
    await user.click(screen.getByRole('button', { name: /set password/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Setup service is down.');
  });

  it('shows a generic message when the setup fails without an Error', async () => {
    // A response that fails while the body is read rejects with the raw
    // transport failure instead of a typed API error.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/auth/setup-account')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: () => Promise.reject('connection reset'),
        } as unknown as Response);
      }
      return originalFetch(input, init);
    }) as unknown as typeof fetch;
    try {
      const user = userEvent.setup();
      renderWithProviders('/setup-account?token=abc');
      await user.type(screen.getByLabelText(/^password$/i), 'goodpassword');
      await user.type(screen.getByLabelText(/confirm password/i), 'goodpassword');
      await user.click(screen.getByRole('button', { name: /set password/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/could not set password/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
