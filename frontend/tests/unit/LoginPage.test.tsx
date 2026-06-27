import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoginPage } from '../../src/pages/LoginPage';
import { AuthProvider } from '../../src/context/AuthContext';
import { MemoryRouter } from 'react-router-dom';

function renderWithProviders(): void {
  render(
    <MemoryRouter>
      <AuthProvider>
        <LoginPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  it('renders sign in form', () => {
    renderWithProviders();
    expect(screen.getByRole('heading', { name: /pto calendar/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
