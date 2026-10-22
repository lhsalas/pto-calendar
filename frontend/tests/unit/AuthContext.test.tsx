import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { AuthProvider } from '../../src/context/AuthContext';
import { useAuth } from '../../src/context/useAuth';
import { server } from '../mocks/server';
import { authenticated, STUB_USER } from '../mocks/handlers';

interface ProbeState {
  status: string;
  email: string | null;
  error: string | null;
}

function Probe({ onChange }: { onChange: (s: ProbeState) => void }): JSX.Element {
  const { user, status, error, login, logout } = useAuth();
  onChange({ status, email: user?.email ?? null, error });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="email">{user?.email ?? 'none'}</span>
      <span data-testid="error">{error ?? 'none'}</span>
      <button
        type="button"
        onClick={() => void login({ email: 'lead@example.com', password: 'lead-dev-password' })}
      >
        login
      </button>
      <button type="button" onClick={() => void logout()}>
        logout
      </button>
    </div>
  );
}

describe('AuthContext', () => {
  it('starts in loading state and transitions to authenticated when /auth/me returns a user', async () => {
    server.use(authenticated);
    const states: ProbeState[] = [];
    render(
      <AuthProvider>
        <Probe onChange={(s) => states.push({ ...s })} />
      </AuthProvider>,
    );
    expect(screen.getByTestId('status').textContent).toBe('loading');

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('email').textContent).toBe(STUB_USER.email);

    expect(states.some((s) => s.status === 'loading')).toBe(true);
    expect(states.some((s) => s.status === 'authenticated')).toBe(true);
  });

  it('transitions to unauthenticated when /auth/me returns 401', async () => {
    render(
      <AuthProvider>
        <Probe onChange={() => {}} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });
    expect(screen.getByTestId('email').textContent).toBe('none');
  });

  it('transitions to unauthenticated with a server error when /auth/me fails non-401', async () => {
    server.use(http.get('/auth/me', () => HttpResponse.json({ message: 'down' }, { status: 500 })));

    render(
      <AuthProvider>
        <Probe onChange={() => {}} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });
    expect(screen.getByTestId('error').textContent).toBe('Could not reach server');
  });

  it('login() sets the user and authenticated state on success', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <Probe onChange={() => {}} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /login/ }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('email').textContent).toBe(STUB_USER.email);
    });
    expect(screen.getByTestId('status').textContent).toBe('authenticated');
  });

  it('login() surfaces the error and rethrows on failure', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/login', () =>
        HttpResponse.json(
          { error: { code: 'UNAUTHENTICATED', message: 'Invalid email or password.' } },
          { status: 401 },
        ),
      ),
    );

    const LoginCatcher = (): JSX.Element => {
      const { login, error } = useAuth();
      const [thrown, setThrown] = useState<string | null>(null);
      return (
        <div>
          <span data-testid="error">{error ?? 'none'}</span>
          <span data-testid="thrown">{thrown ?? 'none'}</span>
          <button
            type="button"
            onClick={() => {
              login({ email: 'lead@example.com', password: 'wrong' }).catch((e: Error) =>
                setThrown(e.message),
              );
            }}
          >
            try
          </button>
        </div>
      );
    };

    render(
      <AuthProvider>
        <LoginCatcher />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('none');
    });

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /try/ }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('Invalid email or password.');
    });
    expect(screen.getByTestId('thrown').textContent).toBe('Invalid email or password.');
  });

  it('ignores the /auth/me response when the provider unmounts first', async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseMe!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    server.use(
      http.get('/auth/me', async () => {
        signalEntered();
        await released;
        return HttpResponse.json(STUB_USER);
      }),
    );

    const states: ProbeState[] = [];
    const { unmount } = render(
      <AuthProvider>
        <Probe onChange={(s) => states.push({ ...s })} />
      </AuthProvider>,
    );

    // Wait until the request is in flight, then unmount before it resolves.
    await entered;
    unmount();
    releaseMe();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states.some((s) => s.status === 'authenticated')).toBe(false);
  });

  it('ignores a failed /auth/me response when the provider unmounts first', async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseMe!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    server.use(
      http.get('/auth/me', async () => {
        signalEntered();
        await released;
        return HttpResponse.json({ message: 'down' }, { status: 500 });
      }),
    );

    const states: ProbeState[] = [];
    const { unmount } = render(
      <AuthProvider>
        <Probe onChange={(s) => states.push({ ...s })} />
      </AuthProvider>,
    );

    await entered;
    unmount();
    releaseMe();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states.some((s) => s.status === 'unauthenticated')).toBe(false);
  });

  it('setupAccount() surfaces the API error message and rethrows on failure', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/auth/setup-account', () =>
        HttpResponse.json(
          { error: { code: 'VALIDATION_ERROR', message: 'Token is invalid.' } },
          { status: 400 },
        ),
      ),
    );

    const SetupCatcher = (): JSX.Element => {
      const { setupAccount, error } = useAuth();
      const [thrown, setThrown] = useState<string | null>(null);
      return (
        <div>
          <span data-testid="error">{error ?? 'none'}</span>
          <span data-testid="thrown">{thrown ?? 'none'}</span>
          <button
            type="button"
            onClick={() => {
              setupAccount({
                token: 'a'.repeat(64),
                password: 'new-password',
              }).catch((e: Error) => setThrown(e.message));
            }}
          >
            try
          </button>
        </div>
      );
    };

    render(
      <AuthProvider>
        <SetupCatcher />
      </AuthProvider>,
    );

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /try/ }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('Token is invalid.');
    });
    expect(screen.getByTestId('thrown').textContent).toBe('Token is invalid.');
  });

  it('logout() clears the user and returns to unauthenticated', async () => {
    server.use(authenticated);
    const user = userEvent.setup();

    render(
      <AuthProvider>
        <Probe onChange={() => {}} />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /logout/ }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
    });
    expect(screen.getByTestId('email').textContent).toBe('none');
  });
});
