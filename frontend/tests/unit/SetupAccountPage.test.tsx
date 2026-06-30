import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SetupAccountPage } from '../../src/pages/SetupAccountPage';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { server } from '../mocks/server';
import { setupAccountBadToken, setupAccountOk, authenticated, STUB_USER } from '../mocks/handlers';

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
  it('renders the password + confirm form', () => {
    renderWithProviders('/setup-account?token=abc');
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set password/i })).toBeInTheDocument();
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
});
