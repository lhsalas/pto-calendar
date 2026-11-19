import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import { act, render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Link, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/context/AuthContext';
import { AuthContext } from '../../src/context/authContextValue';
import type { AuthContextValue } from '../../src/context/authContextValue';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ToastProvider } from '../../src/context/ToastProvider';
import { useTokenIssuanceGuard } from '../../src/hooks/useTokenIssuanceGuard';
import { ToastViewport } from '../../src/components/common/ToastViewport';
import { TokenSettingsPage } from '../../src/pages/settings/TokenSettingsPage';
import { AppRoutes } from '../../src/routes/AppRoutes';
import { server } from '../mocks/server';
import { STUB_RAW_TOKEN, STUB_TOKEN, tokensListEmpty } from '../mocks/handlers';
import type { Role, TokenMetadata, TokenScope, User } from '../../src/types/api';

const MEMBER: User = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Developer One',
  email: 'dev1@example.com',
  role: 'member',
  colorCode: '#10B981',
};

const OTHER_MEMBER: User = {
  id: '44444444-4444-4444-4444-444444444444',
  name: 'Developer Two',
  email: 'dev2@example.com',
  role: 'member',
  colorCode: '#8B5CF6',
};

function userWithRole(role: Role): User {
  return { ...MEMBER, role };
}

function authFor(role: Role) {
  return http.get('/auth/me', () => HttpResponse.json(userWithRole(role)));
}

/**
 * The calendar route is stubbed with the same entry point the real calendar
 * offers, so a test can leave the token settings and come back.
 */
function CalendarStub(): JSX.Element {
  return (
    <div>
      <h1>Calendar Page</h1>
      <Link to="/settings/tokens">API access</Link>
    </div>
  );
}

function TokenSettingsRoutes(): JSX.Element {
  const guard = useTokenIssuanceGuard();
  return (
    <Routes>
      <Route path="/settings/tokens" element={<TokenSettingsPage guard={guard} />} />
      <Route path="/calendar" element={<CalendarStub />} />
    </Routes>
  );
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/settings/tokens']}>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <TokenSettingsRoutes />
            <ToastViewport />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function authValueFor(user: User): AuthContextValue {
  return {
    user,
    status: 'authenticated',
    error: null,
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    setupAccount: vi.fn(async () => undefined),
  };
}

function renderWithAccount(user: User): {
  rerender: (next: User) => void;
} {
  function harness(next: User): JSX.Element {
    return (
      <MemoryRouter initialEntries={['/settings/tokens']}>
        <ThemeProvider>
          <AuthContext.Provider value={authValueFor(next)}>
            <ToastProvider>
              <TokenSettingsRoutes />
              <ToastViewport />
            </ToastProvider>
          </AuthContext.Provider>
        </ThemeProvider>
      </MemoryRouter>
    );
  }
  const view = render(harness(user));
  return { rerender: (next: User) => view.rerender(harness(next)) };
}

function stubClipboard(writeText: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const writeTextMock = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });
  return writeTextMock;
}

function unstubClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

function tokenWith(overrides: Partial<TokenMetadata>): TokenMetadata {
  return { ...STUB_TOKEN, ...overrides };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Generate token' }));
  await screen.findByRole('dialog', { name: /new personal access token/i });
}

async function issueToken(
  user: ReturnType<typeof userEvent.setup>,
  name = 'Laptop',
  password = 'correct horse',
): Promise<void> {
  await openCreateDialog(user);
  await user.type(screen.getByLabelText(/token name/i), name);
  await user.type(screen.getByLabelText(/current password/i), password);
  await user.click(screen.getByRole('button', { name: 'Create token' }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
});

afterEach(() => {
  unstubClipboard();
  vi.useRealTimers();
});

describe('TokenSettingsPage', () => {
  it('lets a member open their own token settings and shows the empty state', async () => {
    server.use(authFor('member'), tokensListEmpty);
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Personal access tokens' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('back-to-calendar-link')).toHaveAttribute('href', '/calendar');
    expect(screen.getByRole('button', { name: 'Generate token' })).toBeInTheDocument();
    expect(await screen.findByTestId('tokens-empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CLI and local MCP setup' })).toHaveAttribute(
      'href',
      '#cli-setup',
    );
    expect(screen.getByText(/separate credential/i)).toBeInTheDocument();
    expect(screen.getByText(/rolled out/i)).toBeInTheDocument();
  });

  it('does not mount any credential dialog before one is asked for', async () => {
    server.use(authFor('member'), tokensListEmpty);
    renderPage();
    await screen.findByTestId('tokens-empty');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/new token/i)).not.toBeInTheDocument();
  });

  it('shows a loading state while the list is on its way', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      authFor('member'),
      http.get('/auth/tokens', async () => {
        await released;
        return HttpResponse.json({ tokens: [] });
      }),
    );
    renderPage();
    expect(await screen.findByTestId('tokens-loading')).toHaveAttribute('aria-busy', 'true');
    release();
    expect(await screen.findByTestId('tokens-empty')).toBeInTheDocument();
  });

  it('shows a safe error with a retry that reloads the list', async () => {
    let attempt = 0;
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { error: { code: 'INTERNAL_ERROR', message: 'boom secret detail' } },
            { status: 500 },
          );
        }
        return HttpResponse.json({ tokens: [STUB_TOKEN] });
      }),
    );
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(alert).not.toHaveTextContent(/boom secret detail/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId(`token-card-${STUB_TOKEN.id}`)).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it('lists owned metadata with the server status and the absolute expiry', async () => {
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () =>
        HttpResponse.json({
          tokens: [
            tokenWith({
              name: 'Laptop',
              scopes: ['pto:read', 'pto:create'],
              lastUsedAt: '2026-06-10T08:30:00.000Z',
              status: 'active',
            }),
            tokenWith({
              id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
              name: 'Old script',
              displayPrefix: 'pto_pat_dddddddd-dddd-dddd-dddd-dddddddddddd',
              status: 'expired',
            }),
            tokenWith({
              id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
              name: 'Shared laptop',
              displayPrefix: 'pto_pat_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
              status: 'revoked',
              revokedAt: '2026-06-14T10:00:00.000Z',
            }),
            tokenWith({
              id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
              name: 'Former role',
              displayPrefix: 'pto_pat_ffffffff-ffff-ffff-ffff-ffffffffffff',
              status: 'invalidated',
            }),
          ],
        }),
      ),
    );
    renderPage();
    const card = await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    expect(within(card).getByTestId('token-prefix')).toHaveTextContent(STUB_TOKEN.displayPrefix);
    expect(within(card).getByTestId('token-status')).toHaveTextContent('Active');
    expect(within(card).getByTestId('token-expiry')).toHaveTextContent(/2026/);
    expect(within(card).getByTestId('token-expiry')).toHaveTextContent(/\(.+\)/);
    expect(within(card).getByText(/last used/i)).toBeInTheDocument();
    expect(within(card).getByText(/pto:create/)).toBeInTheDocument();
    expect(screen.getByTestId('token-card-dddddddd-dddd-dddd-dddd-dddddddddddd')).toHaveTextContent(
      'Expired',
    );
    expect(screen.getByTestId('token-card-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')).toHaveTextContent(
      'Revoked',
    );
    expect(screen.getByTestId('token-card-ffffffff-ffff-ffff-ffff-ffffffffffff')).toHaveTextContent(
      'Invalidated',
    );
  });

  it('warns about a live token that lapses within seven days', async () => {
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () =>
        HttpResponse.json({
          tokens: [
            tokenWith({ expiresAt: '2026-06-18T12:00:00.000Z', status: 'active' }),
            tokenWith({
              id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
              name: 'Later token',
              displayPrefix: 'pto_pat_dddddddd-dddd-dddd-dddd-dddddddddddd',
              expiresAt: '2026-09-15T12:00:00.000Z',
              status: 'active',
            }),
          ],
        }),
      ),
    );
    renderPage();
    expect(await screen.findByTestId('token-near-expiry')).toHaveTextContent(/expires in 3 days/i);
    expect(
      screen.getByTestId('token-card-dddddddd-dddd-dddd-dddd-dddddddddddd'),
    ).not.toHaveTextContent(/expires in/i);
  });

  it('starts read-only, expires in 90 days and offers 30, 90, 180 and 365 days', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    const read = screen.getByRole('checkbox', { name: /pto:read/i });
    expect(read).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:create/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:update:self/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:delete:self/i })).not.toBeChecked();
    const expiry = screen.getByLabelText(/expires after/i);
    expect(expiry).toHaveValue('90');
    expect(
      Array.from((expiry as HTMLSelectElement).options).map((option) => option.textContent),
    ).toEqual(['30 days', '90 days', '180 days', '365 days']);
  });

  it('applies the Manage my PTO preset without notes or team writes', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.click(screen.getByRole('button', { name: 'Manage my PTO' }));
    expect(screen.getByRole('checkbox', { name: /pto:read/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:create/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:update:self/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:delete:self/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:notes:read/i })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /pto:update:team/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /pto:delete:team/i })).not.toBeInTheDocument();
  });

  it('keeps note reads dependent on the read scope', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    const read = screen.getByRole('checkbox', { name: /pto:read/i });
    const notes = screen.getByRole('checkbox', { name: /pto:notes:read/i });
    // Read is granted by default, so the note scope is offered.
    expect(read).toBeChecked();
    expect(notes).toBeEnabled();
    await user.click(read);
    expect(notes).toBeDisabled();
    expect(notes).not.toBeChecked();
  });

  it('resets the note scope when the read scope is switched off', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    const read = screen.getByRole('checkbox', { name: /pto:read/i });
    await user.click(read);
    expect(read).not.toBeChecked();
    await user.click(read);
    const notes = screen.getByRole('checkbox', { name: /pto:notes:read/i });
    expect(notes).toBeEnabled();
    await user.click(notes);
    expect(notes).toBeChecked();
    await user.click(read);
    expect(notes).not.toBeChecked();
    expect(notes).toBeDisabled();
  });

  it('offers team writes to a team lead only', async () => {
    server.use(authFor('team_lead'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    expect(screen.getByRole('checkbox', { name: /pto:update:team/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /pto:delete:team/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /pto:update:team/i })).not.toBeChecked();
  });

  it('refuses to send a token without a name', async () => {
    const issue = vi.fn(() => HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }));
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/tokens', issue));
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a name/i);
    expect(issue).not.toHaveBeenCalled();
  });

  it('refuses to send a token without the current password', async () => {
    const issue = vi.fn(() => HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }));
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/tokens', issue));
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/current password/i);
    expect(issue).not.toHaveBeenCalled();
  });

  it('refuses to send a token without any scope', async () => {
    const issue = vi.fn(() => HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }));
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/tokens', issue));
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('checkbox', { name: /pto:read/i }));
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one scope/i);
    expect(issue).not.toHaveBeenCalled();
  });

  it('creates a token and shows the secret exactly once', async () => {
    const issue = vi.fn(async ({ request }: { request: Request }) => {
      const body = (await request.json()) as {
        name: string;
        password: string;
        scopes: string[];
        expiresInDays: number;
      };
      expect(body).toEqual({
        name: 'Laptop',
        password: 'correct horse',
        scopes: ['pto:read'],
        expiresInDays: 90,
      });
      return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
    });
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/tokens', issue));
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    expect(within(dialog).getByLabelText(/new token/i)).toHaveValue(STUB_RAW_TOKEN);
    expect(within(dialog).getByTestId('token-reveal-expiry')).toHaveTextContent(/2026/);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue(STUB_RAW_TOKEN)).toBeInTheDocument();
  });

  it('never echoes the submitted password or the server message on a failure', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json(
          { error: { code: 'UNAUTHENTICATED', message: 'wrong password hunter2' } },
          { status: 401 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/current password or session was not accepted/i);
    expect(alert).not.toHaveTextContent(/hunter2/);
    expect(alert).not.toHaveTextContent(/wrong password/);
    expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
  });

  it('explains a rate limit without echoing anything', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json(
          { error: { code: 'RATE_LIMITED', message: 'too many attempts for hunter2' } },
          { status: 429 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many attempts/i);
    expect(alert).not.toHaveTextContent(/hunter2/);
  });

  it('copies the secret on request and reports the result', async () => {
    const user = userEvent.setup();
    // The clipboard stub has to be installed after userEvent.setup(), which
    // attaches its own clipboard stub to the view.
    const writeText = stubClipboard(async () => undefined);
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    await user.click(within(dialog).getByRole('button', { name: 'Copy token' }));
    expect(writeText).toHaveBeenCalledWith(STUB_RAW_TOKEN);
    expect(await screen.findByTestId('token-copy-status')).toHaveTextContent(
      /copied to your clipboard/i,
    );
    const toast = await screen.findByTestId('toast-success');
    expect(toast).toHaveTextContent(/token copied/i);
    expect(toast).not.toHaveTextContent(STUB_RAW_TOKEN);
  });

  it('falls back to a manual copy when the clipboard is blocked', async () => {
    const user = userEvent.setup();
    stubClipboard(async () => {
      throw new Error('denied');
    });
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    await user.click(within(dialog).getByRole('button', { name: 'Copy token' }));
    expect(await screen.findByTestId('token-copy-status')).toHaveTextContent(
      /copying was blocked/i,
    );
    expect(within(dialog).getByLabelText(/new token/i)).toHaveValue(STUB_RAW_TOKEN);
  });

  it('drops the secret when the reveal dialog is dismissed', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
  });

  it('never shows a secret that arrives after the page was left', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', async () => {
        await released;
        return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await user.click(screen.getByTestId('back-to-calendar-link'));
    await screen.findByRole('heading', { name: 'Calendar Page' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
  });

  it('drops the secret and the pending issuance when the page is frozen', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestSignal: { current: AbortSignal | null } = { current: null };
    const issue = vi.fn(async ({ request }: { request: Request }) => {
      requestSignal.current = request.signal;
      await released;
      return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
    });
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/tokens', issue));
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    const password = screen.getByLabelText(/current password/i) as HTMLInputElement;
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(password, 'correct horse');
    expect(password.value).toBe('correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => {
      expect(issue).toHaveBeenCalledTimes(1);
    });

    fireEvent(window, new Event('pagehide'));
    // The password field is emptied synchronously, so a frozen page cannot
    // replay it from the back/forward cache.
    expect(password.value).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestSignal.current?.aborted).toBe(true);
    expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
    await openCreateDialog(user);
    expect(screen.getByLabelText(/current password/i)).toHaveValue('');
    // The issuance was cancelled mid-flight, so the pane waits for an
    // authoritative refresh before another token may be requested.
    expect(screen.getByTestId('issuance-unknown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(issue).toHaveBeenCalledTimes(1);

    // Only a successful refresh lifts the block.
    server.use(http.get('/auth/tokens', () => HttpResponse.json({ tokens: [] })));
    await user.click(screen.getByTestId('refresh-token-list-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('issuance-unknown')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('drops a pending issuance when the account changes on the same route', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestSignal: { current: AbortSignal | null } = { current: null };
    const issue = vi.fn(async ({ request }: { request: Request }) => {
      requestSignal.current = request.signal;
      await released;
      return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
    });
    let listCalls = 0;
    server.use(
      http.get('/auth/tokens', () => {
        listCalls += 1;
        return HttpResponse.json({ tokens: listCalls === 1 ? [STUB_TOKEN] : [] });
      }),
      http.post('/auth/tokens', issue),
    );
    const user = userEvent.setup();
    const { rerender } = renderWithAccount(MEMBER);
    await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => {
      expect(issue).toHaveBeenCalledTimes(1);
    });

    rerender(OTHER_MEMBER);
    await screen.findByTestId('tokens-empty');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestSignal.current?.aborted).toBe(true);
    expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it('confirms before revoking one token and refreshes the list', async () => {
    const revoke = vi.fn((_args: unknown) => new HttpResponse(null, { status: 204 }));
    let listCalls = 0;
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => {
        listCalls += 1;
        return HttpResponse.json({ tokens: listCalls === 1 ? [STUB_TOKEN] : [] });
      }),
      http.delete('/auth/tokens/:id', revoke),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke token' });
    expect(within(dialog).queryByLabelText(/current password/i)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Revoke token' })).not.toBeInTheDocument();
    });
    expect(revoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Revoke token' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'Confirm revocation' }));
    await waitFor(() => {
      expect(revoke).toHaveBeenCalledTimes(1);
    });
    const call = revoke.mock.calls[0]?.[0] as { params: { id: string } } | undefined;
    expect(call?.params.id).toBe(STUB_TOKEN.id);
    expect(await screen.findByTestId('tokens-empty')).toBeInTheDocument();
  });

  it('confirms before revoking every token and never asks for a password', async () => {
    const revokeAll = vi.fn(() => new HttpResponse(null, { status: 204 }));
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [STUB_TOKEN] })),
      http.post('/auth/tokens/revoke-all', revokeAll),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    await user.click(screen.getByRole('button', { name: 'Revoke all tokens' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke all tokens' });
    expect(within(dialog).queryByLabelText(/current password/i)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm revocation' }));
    await waitFor(() => {
      expect(revokeAll).toHaveBeenCalledTimes(1);
    });
  });

  it('blocks a duplicate revocation while the request is running', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = vi.fn(async () => {
      await released;
      return new HttpResponse(null, { status: 204 });
    });
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [STUB_TOKEN] })),
      http.delete('/auth/tokens/:id', revoke),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke token' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm revocation' });
    await user.click(confirm);
    await waitFor(() => {
      expect(confirm).toBeDisabled();
    });
    await user.click(confirm);
    expect(revoke).toHaveBeenCalledTimes(1);
    release();
  });

  it('returns focus to the trigger when the dialog is closed with Escape', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    const trigger = await screen.findByRole('button', { name: 'Generate token' });
    await user.click(trigger);
    await screen.findByRole('dialog', { name: /new personal access token/i });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /new personal access token/i }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('returns focus to the generate trigger after the reveal dialog is closed', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    const trigger = await screen.findByRole('button', { name: 'Generate token' });
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('keeps the keyboard inside the dialog and closes it with Escape', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    const name = screen.getByLabelText(/token name/i);
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    await user.keyboard('{Tab}');
    expect(screen.getByLabelText(/current password/i)).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /new personal access token/i }),
      ).not.toBeInTheDocument();
    });
  });

  it('reports an unreadable response instead of treating it as an empty list', async () => {
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => HttpResponse.json({})),
    );
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
    expect(screen.queryByTestId('tokens-empty')).not.toBeInTheDocument();
  });

  it('keeps the error visible when a retry also fails', async () => {
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'down' } }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
    });
    expect(screen.queryByTestId('tokens-loading')).not.toBeInTheDocument();
  });

  it('refuses a list with unusable metadata and keeps the reconciliation block', async () => {
    const issue = vi.fn(() =>
      HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
    );
    server.use(
      authFor('member'),
      // A list element the adapter must refuse: the whole answer is
      // rejected, so it never counts as an authoritative list.
      http.get('/auth/tokens', () =>
        HttpResponse.json({ tokens: [tokenWith({ scopes: ['pto:mystery' as TokenScope] })] }),
      ),
      http.post('/auth/tokens', issue),
    );
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);

    await user.click(screen.getByRole('button', { name: 'Generate token' }));
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByTestId('issuance-unknown')).toBeInTheDocument();

    // A refused refresh does not lift the block either.
    await user.click(screen.getByTestId('refresh-token-list-button'));
    expect(await screen.findByTestId('refresh-token-list-failed')).toBeInTheDocument();
    expect(screen.getByTestId('issuance-unknown')).toBeInTheDocument();
  });

  it('warns about a token that lapses in exactly one day', async () => {
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () =>
        HttpResponse.json({
          tokens: [tokenWith({ expiresAt: '2026-06-16T12:00:00.000Z', status: 'active' })],
        }),
      ),
    );
    renderPage();
    expect(await screen.findByTestId('token-near-expiry')).toHaveTextContent(/expires in 1 day\b/i);
  });

  it('falls back to a manual copy when the browser has no clipboard at all', async () => {
    const user = userEvent.setup();
    // The clipboard API is missing entirely, not just refusing the write.
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    await user.click(within(dialog).getByRole('button', { name: 'Copy token' }));
    expect(await screen.findByTestId('token-copy-status')).toHaveTextContent(
      /copying was blocked/i,
    );
    expect(within(dialog).getByLabelText(/new token/i)).toHaveValue(STUB_RAW_TOKEN);
  });

  it('closes the confirmation without revoking when the backdrop is clicked', async () => {
    const revoke = vi.fn((_args: unknown) => new HttpResponse(null, { status: 204 }));
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [STUB_TOKEN] })),
      http.delete('/auth/tokens/:id', revoke),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke token' });
    fireEvent.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Revoke token' })).not.toBeInTheDocument();
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('sends the lifetime that was chosen', async () => {
    const issue = vi.fn(async ({ request }: { request: Request }) => {
      const body = (await request.json()) as { expiresInDays: number };
      expect(body.expiresInDays).toBe(30);
      return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
    });
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/tokens', issue));
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.selectOptions(screen.getByLabelText(/expires after/i), '30');
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => {
      expect(issue).toHaveBeenCalledTimes(1);
    });
  });

  it('reports a failed revocation with safe copy', async () => {
    const revoke = vi.fn((_args: unknown) =>
      HttpResponse.json(
        { error: { code: 'FORBIDDEN', message: 'not allowed for hunter2' } },
        { status: 403 },
      ),
    );
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [STUB_TOKEN] })),
      http.delete('/auth/tokens/:id', revoke),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke token' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm revocation' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/role does not allow those scopes/i);
    expect(alert).not.toHaveTextContent(/hunter2/);
    expect(screen.getByRole('dialog', { name: 'Revoke token' })).toBeInTheDocument();
  });

  it('signs the account out', async () => {
    const logout = vi.fn(() => new HttpResponse(null, { status: 204 }));
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/logout', logout));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(logout).toHaveBeenCalledTimes(1);
    });
  });

  it('returns to the read-only grant with the Read only preset', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.click(screen.getByRole('button', { name: 'Manage my PTO' }));
    expect(screen.getByRole('checkbox', { name: /pto:create/i })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Read only' }));
    expect(screen.getByRole('checkbox', { name: /pto:read/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:create/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:update:self/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /pto:delete:self/i })).not.toBeChecked();
  });

  it('clears the password when the form is cancelled', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    const password = screen.getByLabelText(/current password/i) as HTMLInputElement;
    await user.type(password, 'correct horse');
    expect(password.value).toBe('correct horse');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /new personal access token/i }),
      ).not.toBeInTheDocument();
    });
    await openCreateDialog(user);
    expect((screen.getByLabelText(/current password/i) as HTMLInputElement).value).toBe('');
  });

  it('closes the reveal dialog when the backdrop is clicked', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    fireEvent.click(dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
  });

  it('shows the granted scopes of the new token', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json(
          {
            rawToken: STUB_RAW_TOKEN,
            token: tokenWith({ scopes: ['pto:read', 'pto:create'] }),
          },
          { status: 201 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    expect(within(dialog).getByText(/read the team calendar/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/create your own time off/i)).toBeInTheDocument();
  });

  it('empties the secret from the document when the page is frozen', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    const value = within(dialog).getByLabelText(/new token/i) as HTMLInputElement;
    expect(value.value).toBe(STUB_RAW_TOKEN);
    fireEvent(window, new Event('pagehide'));
    // The field is emptied synchronously, so a frozen page cannot replay the
    // secret from the back/forward cache.
    expect(value.value).toBe('');
    expect(dialog).not.toBeInTheDocument();
  });

  it('lets the reader select the secret for a manual copy', async () => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    const value = within(dialog).getByLabelText(/new token/i) as HTMLInputElement;
    await user.click(value);
    expect(value).toHaveFocus();
  });

  it('falls back to a manual copy when the clipboard cannot write text', async () => {
    const user = userEvent.setup();
    // A clipboard object without a write method is as good as no clipboard.
    Object.defineProperty(navigator, 'clipboard', {
      value: {},
      configurable: true,
      writable: true,
    });
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () =>
        HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 }),
      ),
    );
    renderPage();
    await issueToken(user);
    const dialog = await screen.findByRole('dialog', { name: /copy your token/i });
    await user.click(within(dialog).getByRole('button', { name: 'Copy token' }));
    expect(await screen.findByTestId('token-copy-status')).toHaveTextContent(
      /copying was blocked/i,
    );
  });

  it('stops a revocation that lands after the account page was left', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revokeAll = vi.fn(async () => {
      await released;
      return new HttpResponse(null, { status: 204 });
    });
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [STUB_TOKEN] })),
      http.post('/auth/tokens/revoke-all', revokeAll),
    );
    const user = userEvent.setup();
    const view = renderPage();
    await screen.findByTestId(`token-card-${STUB_TOKEN.id}`);
    await user.click(screen.getByRole('button', { name: 'Revoke all tokens' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke all tokens' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm revocation' }));
    await waitFor(() => {
      expect(revokeAll).toHaveBeenCalledTimes(1);
    });
    view.unmount();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revokeAll).toHaveBeenCalledTimes(1);
  });

  it('keeps a new issuance blocked until the token list has been refreshed', async () => {
    let issueCalls = 0;
    const issue = vi.fn(() => {
      issueCalls += 1;
      return HttpResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: 'boom' } },
        { status: 500 },
      );
    });
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [] })),
      http.post('/auth/tokens', issue),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('tokens-empty');
    await issueToken(user);

    // A server error leaves the outcome unknown: the copy never claims that
    // nothing was created.
    const banner = await screen.findByTestId('issuance-unknown');
    expect(banner).toHaveTextContent(/could not confirm/i);
    expect(banner).toHaveTextContent(/may have reached the server/i);
    expect(banner).not.toHaveTextContent(/creates nothing/i);
    expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    expect(issueCalls).toBe(1);

    // The open form is blocked, and reopening it does not lift the block.
    const dialog = screen.getByRole('dialog', { name: /new personal access token/i });
    expect(within(dialog).getByRole('button', { name: 'Create token' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Create token' }));
    expect(issueCalls).toBe(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /new personal access token/i }),
      ).not.toBeInTheDocument();
    });
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(issueCalls).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // A failed refresh keeps the block in place.
    server.use(
      http.get('/auth/tokens', () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'down' } }, { status: 500 }),
      ),
    );
    await user.click(screen.getByTestId('refresh-token-list-button'));
    expect(await screen.findByTestId('refresh-token-list-failed')).toBeInTheDocument();
    expect(screen.getByTestId('issuance-unknown')).toBeInTheDocument();

    // A 200 response missing the list is also unconfirmed, not an empty list.
    server.use(http.get('/auth/tokens', () => HttpResponse.json({})));
    await user.click(screen.getByTestId('refresh-token-list-button'));
    expect(await screen.findByTestId('refresh-token-list-failed')).toBeInTheDocument();
    expect(screen.getByTestId('issuance-unknown')).toBeInTheDocument();
    expect(screen.queryByTestId('tokens-empty')).not.toBeInTheDocument();

    // An authoritative refresh lifts it and the next intentional submit works.
    server.use(http.get('/auth/tokens', () => HttpResponse.json({ tokens: [] })));
    await user.click(screen.getByTestId('refresh-token-list-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('issuance-unknown')).not.toBeInTheDocument();
    });
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
  });

  it.each([
    {},
    { rawToken: '', token: STUB_TOKEN },
    { rawToken: STUB_RAW_TOKEN },
    { rawToken: STUB_RAW_TOKEN, token: { id: STUB_TOKEN.id } },
    { rawToken: STUB_RAW_TOKEN, token: { id: STUB_TOKEN.id, scopes: ['pto:read'] } },
  ])('never reveals a credential from an incomplete issuance response', async (payload) => {
    server.use(
      authFor('member'),
      tokensListEmpty,
      http.post('/auth/tokens', () => HttpResponse.json(payload, { status: 201 })),
    );
    const user = userEvent.setup();
    renderPage();
    await issueToken(user);
    expect(await screen.findByTestId('issuance-unknown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
  });

  it('never shows a secret when the issuance answer is lost', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestSignal: { current: AbortSignal | null } = { current: null };
    const issue = vi.fn(async ({ request }: { request: Request }) => {
      requestSignal.current = request.signal;
      await released;
      return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
    });
    server.use(authFor('member'), tokensListEmpty, http.post('/auth/tokens', issue));
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => {
      expect(issue).toHaveBeenCalledTimes(1);
    });
    // The request is cancelled, so the late answer is dropped.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestSignal.current?.aborted).toBe(true);
    expect(screen.queryByRole('dialog', { name: /copy your token/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
    expect(screen.getByTestId('issuance-unknown')).toBeInTheDocument();
  });

  it.each([
    ['member', /your own notes only/i],
    ['team_lead', /notes of teammates/i],
    ['admin', /notes of teammates/i],
  ] as const)('explains whose notes a %s token can read', async (role, expected) => {
    server.use(authFor(role), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    expect(screen.getByText(expected)).toBeInTheDocument();
    // The read scope is about the shared calendar, not one person's bookings.
    expect(screen.getByText(/shared team calendar/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /pto:read/i })).toBeChecked();
  });

  it('says that the preset still reads the shared calendar', async () => {
    server.use(authFor('member'), tokensListEmpty);
    const user = userEvent.setup();
    renderPage();
    await openCreateDialog(user);
    expect(screen.getAllByText(/still reads the shared calendar/i).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      screen.getAllByText(/never grants note text or writes on somebody else/i).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('explains that a token can be issued while bearer access is off', async () => {
    server.use(authFor('member'), tokensListEmpty);
    renderPage();
    await screen.findByTestId('tokens-empty');
    expect(screen.getByText(/while bearer access is switched off/i)).toBeInTheDocument();
    expect(
      screen.getByText(/unusable for api calls until bearer access is enabled/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/creates nothing/i)).not.toBeInTheDocument();
  });

  it('keeps a cancelled issuance blocked after the same account leaves and comes back', async () => {
    const release = deferred();
    const replied = deferred();
    const requestSignal: { current: AbortSignal | null } = { current: null };
    const issue = vi.fn(async ({ request }: { request: Request }) => {
      requestSignal.current = request.signal;
      await release.promise;
      replied.resolve();
      return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
    });
    let listCalls = 0;
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => {
        listCalls += 1;
        return HttpResponse.json({ tokens: [] });
      }),
      http.post('/auth/tokens', issue),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('tokens-empty');
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => {
      expect(issue).toHaveBeenCalledTimes(1);
    });

    // Leave the route while the request is in flight.
    await user.click(screen.getByTestId('back-to-calendar-link'));
    await screen.findByRole('heading', { name: 'Calendar Page' });
    expect(requestSignal.current?.aborted).toBe(true);
    await act(async () => {
      release.resolve();
      await replied.promise;
    });
    // The late answer is discarded: no secret and no password reappear.
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();

    // The same account comes back. The initial list succeeds, but the
    // account is still blocked because the attempt was never confirmed.
    await user.click(screen.getByRole('link', { name: 'API access' }));
    await screen.findByTestId('tokens-empty');
    expect(listCalls).toBeGreaterThanOrEqual(2);
    expect(await screen.findByTestId('issuance-unknown')).toBeInTheDocument();
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(issue).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Only an explicit, successful refresh lifts the block.
    await user.click(screen.getByTestId('refresh-token-list-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('issuance-unknown')).not.toBeInTheDocument();
    });
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
    await user.type(screen.getByLabelText(/token name/i), 'Second');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(await screen.findByRole('dialog', { name: /copy your token/i })).toBeInTheDocument();
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('keeps an unknown issuance blocked after the same account leaves and comes back', async () => {
    const issue = vi.fn(() =>
      HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
    );
    let listCalls = 0;
    server.use(
      authFor('member'),
      http.get('/auth/tokens', () => {
        listCalls += 1;
        return HttpResponse.json({ tokens: [] });
      }),
      http.post('/auth/tokens', issue),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('tokens-empty');
    await issueToken(user);
    expect(await screen.findByTestId('issuance-unknown')).toBeInTheDocument();

    await user.click(screen.getByTestId('back-to-calendar-link'));
    await screen.findByRole('heading', { name: 'Calendar Page' });
    await user.click(screen.getByRole('link', { name: 'API access' }));
    await screen.findByTestId('tokens-empty');
    expect(listCalls).toBeGreaterThanOrEqual(2);
    // The initial list succeeded, but the unknown attempt still blocks.
    expect(screen.getByTestId('issuance-unknown')).toBeInTheDocument();
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('keeps the marker across a route change in the real router', async () => {
    const issue = vi.fn(() =>
      HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, { status: 500 }),
    );
    server.use(
      http.get('/auth/me', () => HttpResponse.json(userWithRole('member'))),
      http.get('/pto', () => HttpResponse.json([])),
      http.get('/holidays', () => HttpResponse.json([])),
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [] })),
      http.post('/auth/tokens', issue),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/tokens']}>
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <AppRoutes />
              <ToastViewport />
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Personal access tokens' });
    await issueToken(user);
    expect(await screen.findByTestId('issuance-unknown')).toBeInTheDocument();

    // The real calendar offers the account entry point.
    await user.click(screen.getByTestId('back-to-calendar-link'));
    await screen.findByRole('heading', { name: 'Calendar' });
    await user.click(screen.getByTestId('api-access-link'));
    await screen.findByRole('heading', { name: 'Personal access tokens' });
    // The marker is still there: it belongs to the router, not the page.
    expect(screen.getByTestId('issuance-unknown')).toBeInTheDocument();
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('keeps the marker per account across an account switch and back', async () => {
    const release = deferred();
    const replied = deferred();
    const issue = vi.fn(async () => {
      await release.promise;
      replied.resolve();
      return HttpResponse.json({ rawToken: STUB_RAW_TOKEN, token: STUB_TOKEN }, { status: 201 });
    });
    server.use(
      http.get('/auth/tokens', () => HttpResponse.json({ tokens: [] })),
      http.post('/auth/tokens', issue),
    );
    const user = userEvent.setup();
    const { rerender } = renderWithAccount(MEMBER);
    await screen.findByTestId('tokens-empty');
    await openCreateDialog(user);
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => {
      expect(issue).toHaveBeenCalledTimes(1);
    });

    // Another account is not blocked by the first account's attempt.
    rerender(OTHER_MEMBER);
    await screen.findByTestId('tokens-empty');
    expect(screen.queryByTestId('issuance-unknown')).not.toBeInTheDocument();
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Back to the first account: it is still blocked, and the late answer of
    // its cancelled attempt changes nothing.
    rerender(MEMBER);
    await act(async () => {
      release.resolve();
      await replied.promise;
    });
    expect(await screen.findByTestId('issuance-unknown')).toBeInTheDocument();
    await openCreateDialog(user);
    expect(screen.getByRole('button', { name: 'Create token' })).toBeDisabled();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(screen.queryByDisplayValue(STUB_RAW_TOKEN)).not.toBeInTheDocument();
  });
});
