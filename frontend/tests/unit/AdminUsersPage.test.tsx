import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { AdminUsersPage } from '../../src/pages/admin/AdminUsersPage';
import type * as ApiClientModule from '../../src/api/client';
import { server } from '../mocks/server';
import {
  authenticated,
  createUserConflict,
  createUserOk,
  resetPasswordOk,
  resetPasswordSelf,
  STUB_USER,
  usersList,
  usersListForbidden,
} from '../mocks/handlers';

interface RequestOptionsLike {
  method?: string;
}

/**
 * Per-request transport overrides, keyed by `"<METHOD> <path>"`. The api
 * client stays the real implementation (so typed `ApiError`s still travel
 * through the normal response handling), but a test can replace a single
 * request with a controlled failure, e.g. a rejection that is not an
 * `ApiError`.
 */
const { requestOverrides } = vi.hoisted(() => ({
  requestOverrides: new Map<
    string,
    (options: RequestOptionsLike | undefined) => Promise<unknown>
  >(),
}));

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  const actualApiRequest = actual.apiRequest as unknown as (
    path: string,
    options?: unknown,
  ) => Promise<unknown>;
  return {
    ...actual,
    apiRequest: (path: string, options?: unknown): Promise<unknown> => {
      const method = (options as RequestOptionsLike | undefined)?.method ?? 'GET';
      const override = requestOverrides.get(`${method} ${path}`);
      if (override) return override(options as RequestOptionsLike | undefined);
      return actualApiRequest(path, options);
    },
  };
});

function renderWithProviders(initialPath: string = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<AdminUsersPage />} />
            <Route path="/admin/users" element={<AdminUsersPage />} />
            <Route path="/calendar" element={<h1>Calendar Page</h1>} />
            <Route path="/login" element={<h1>Login Page</h1>} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/**
 * The signed-in identity is in the page header, so a listed user is looked up
 * inside the user list instead of anywhere on the page.
 */
async function findListedUser(name: RegExp): Promise<HTMLElement> {
  const list = await screen.findByRole('list');
  return within(list).findByText(name);
}

function stubClipboard(writeText: (text: string) => Promise<void>): {
  writeText: ReturnType<typeof vi.fn>;
} {
  const writeTextMock = vi.fn(writeText);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });
  return { writeText: writeTextMock };
}

function unstubClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  requestOverrides.clear();
  unstubClipboard();
  vi.useRealTimers();
});

describe('AdminUsersPage', () => {
  it('lists the existing users', async () => {
    server.use(authenticated, usersList);
    renderWithProviders();
    expect(await findListedUser(/Team Lead/)).toBeInTheDocument();
    expect(screen.getByText(/Developer One/)).toBeInTheDocument();
  });

  it('creates a user and shows the one-time setup link', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    expect(await screen.findByText(/Setup link for/)).toBeInTheDocument();
  });

  it('renders a Back to calendar link that points to /calendar', async () => {
    server.use(authenticated, usersList);
    renderWithProviders();
    await findListedUser(/Team Lead/);
    const link = screen.getByTestId('back-to-calendar-link');
    expect(link).toHaveAttribute('href', '/calendar');
  });

  it('shows the shared navigation and marks the current destination', async () => {
    server.use(authenticated, usersList);
    renderWithProviders('/admin/users');
    await screen.findByTestId('signed-in-user');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByTestId('api-access-link')).toHaveAttribute('href', '/settings/tokens');
    expect(screen.getByTestId('manage-holidays-link')).toHaveAttribute('href', '/admin/holidays');
    expect(screen.getByTestId('manage-users-link')).toHaveAttribute('aria-current', 'page');
  });

  it('navigates to /calendar when the Back to calendar link is clicked', async () => {
    server.use(authenticated, usersList);
    const user = userEvent.setup();
    renderWithProviders('/');
    await findListedUser(/Team Lead/);
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
    await findListedUser(/Team Lead/);
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('signs the user out when the Sign out button is clicked', async () => {
    let loggedOut = 0;
    server.use(
      authenticated,
      usersList,
      http.post('/auth/logout', () => {
        loggedOut += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => {
      expect(loggedOut).toBe(1);
    });
  });

  it('copies the full setup URL (not just the token) to the clipboard', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    const { writeText } = stubClipboard(async () => undefined);
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    const input = await screen.findByTestId('setup-url-input');
    const copyButton = screen.getByTestId('copy-setup-url-button');
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    const [written] = writeText.mock.calls[0] ?? [];
    expect(written).toMatch(/^http:\/\/[^/]+\/setup-account#token=/);
    expect(written).toBe((input as HTMLInputElement).value);
    expect(written).toContain('a'.repeat(64));
    expect(written).not.toBe('a'.repeat(64));
  });

  it('flips the copy button to Copied after success and back to Copy after the feedback window', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(async () => undefined);
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    const copyButton = await screen.findByTestId('copy-setup-url-button');

    await user.click(copyButton);
    expect(copyButton).toHaveTextContent(/^Copied$/);

    await waitFor(
      () => {
        expect(copyButton).toHaveTextContent(/^Copy$/);
      },
      { timeout: 3000 },
    );
  });

  it('falls back to selecting the input and shows Copy failed when clipboard rejects', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(async () => {
      throw new Error('not allowed');
    });
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    const input = await screen.findByTestId('setup-url-input');
    const copyButton = screen.getByTestId('copy-setup-url-button');
    await user.click(copyButton);

    expect(document.activeElement).toBe(input);
    expect(copyButton).toHaveTextContent(/Copy failed/);
  });

  it('shows Copy failed when the clipboard API is unavailable', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    // No clipboard API at all: the copy has to fall back to a manual copy.
    unstubClipboard();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    const input = await screen.findByTestId('setup-url-input');
    const copyButton = screen.getByTestId('copy-setup-url-button');
    await user.click(copyButton);

    expect(document.activeElement).toBe(input);
    expect(copyButton).toHaveTextContent(/Copy failed/);
  });

  it('returns the copy button to Copy after a failed copy', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(async () => {
      throw new Error('not allowed');
    });
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    const copyButton = await screen.findByTestId('copy-setup-url-button');

    await user.click(copyButton);
    expect(copyButton).toHaveTextContent(/Copy failed/);

    await waitFor(
      () => {
        expect(copyButton).toHaveTextContent(/^Copy$/);
      },
      { timeout: 3000 },
    );
  });

  it('keeps the copy button idle when a later reset finds no pending copy state', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(async () => undefined);
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    const copyButton = await screen.findByTestId('copy-setup-url-button');

    // Two copies inside the same feedback window: the first scheduled reset
    // finds a pending "Copied" state and clears it, the second one finds
    // nothing pending and leaves the button idle.
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(copyButton).toHaveTextContent(/^Copied$/);
    await act(async () => {
      fireEvent.click(copyButton);
    });
    expect(copyButton).toHaveTextContent(/^Copied$/);

    await act(async () => {
      await vi.advanceTimersByTime(2000);
    });

    expect(copyButton).toHaveTextContent(/^Copy$/);
  });

  it('selects the read-only input on focus so manual copy works even on clipboard success', async () => {
    server.use(authenticated, usersList, createUserOk);
    stubClipboard(async () => undefined);
    const user = userEvent.setup({ writeToClipboard: false });
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    const input = await screen.findByTestId('setup-url-input');
    await user.click(input);
    expect(document.activeElement).toBe(input);
  });

  it('dismisses the one-time setup link card', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    expect(await screen.findByText(/Setup link for/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByText(/Setup link for/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('setup-url-input')).not.toBeInTheDocument();
  });

  it('dismisses the reset password setup link card', async () => {
    server.use(authenticated, usersList, resetPasswordOk);
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    const resetButtons = await screen.findAllByRole('button', { name: /reset password/i });
    await user.click(resetButtons[0]!);
    expect(await screen.findByText(/New password setup link/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByText(/New password setup link/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('setup-url-input')).not.toBeInTheDocument();
  });

  it('selects the reset setup URL on focus so manual copy works', async () => {
    server.use(authenticated, usersList, resetPasswordOk);
    const user = userEvent.setup({ writeToClipboard: false });
    renderWithProviders();
    await findListedUser(/Team Lead/);
    const resetButtons = await screen.findAllByRole('button', { name: /reset password/i });
    await user.click(resetButtons[0]!);
    const input = (await screen.findByTestId('setup-url-input')) as HTMLInputElement;

    await user.click(input);

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('copies the full setup URL from the Reset password card', async () => {
    server.use(authenticated, usersList, createUserOk, resetPasswordOk);
    const user = userEvent.setup({ writeToClipboard: false });
    const { writeText } = stubClipboard(async () => undefined);
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await screen.findByText(/Developer One/);

    const resetButtons = screen.getAllByRole('button', { name: /reset password/i });
    await user.click(resetButtons[0]!);

    const inputs = await screen.findAllByTestId('setup-url-input');
    const resetInput = inputs[inputs.length - 1]!;
    const copyButtons = screen.getAllByTestId('copy-setup-url-button');
    const resetCopy = copyButtons[copyButtons.length - 1]!;
    await user.click(resetCopy);

    expect(writeText).toHaveBeenCalledTimes(1);
    const [written] = writeText.mock.calls[0] ?? [];
    expect(written).toBe((resetInput as HTMLInputElement).value);
    expect(written).toContain('b'.repeat(64));
  });

  it('keeps the create and reset copy states independent', async () => {
    server.use(authenticated, usersList, createUserOk, resetPasswordOk);
    stubClipboard(async () => undefined);
    const user = userEvent.setup({ writeToClipboard: false });
    renderWithProviders();
    await findListedUser(/Team Lead/);

    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    const copyButtonsAfterCreate = await screen.findAllByTestId('copy-setup-url-button');
    expect(copyButtonsAfterCreate).toHaveLength(1);
    await user.click(copyButtonsAfterCreate[0]!);

    const resetButtons = screen.getAllByRole('button', { name: /reset password/i });
    await user.click(resetButtons[0]!);

    const allCopyButtons = await screen.findAllByTestId('copy-setup-url-button');
    expect(allCopyButtons).toHaveLength(2);
    expect(allCopyButtons[0]).toHaveTextContent(/^Copied$/);
    expect(allCopyButtons[1]).toHaveTextContent(/^Copy$/);

    await user.click(allCopyButtons[1]!);
    expect(allCopyButtons[0]).toHaveTextContent(/^Copied$/);
    expect(allCopyButtons[1]).toHaveTextContent(/^Copied$/);
  });

  it('shows the API error message when the user list request fails', async () => {
    server.use(authenticated, usersListForbidden);
    renderWithProviders();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to manage users.',
    );
  });

  it('shows a generic message when the user list request fails with a non-Error', async () => {
    server.use(authenticated);
    requestOverrides.set('GET /users', () => Promise.reject('not an error'));
    renderWithProviders();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load users.');
  });

  it('shows the API error message when creating a user fails', async () => {
    server.use(authenticated, usersList, createUserConflict);
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A user with that email already exists.',
    );
    // The typed values survive so the request can be corrected and retried.
    expect(screen.getByLabelText(/email/i)).toHaveValue('newmember@example.com');
  });

  it('shows a generic message when creating a user fails with a non-API error', async () => {
    server.use(authenticated, usersList);
    requestOverrides.set('POST /users', () => Promise.reject(new Error('boom')));
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create user.');
  });

  it('shows the API error message when resetting a password fails', async () => {
    server.use(authenticated, usersList, resetPasswordSelf);
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    const resetButtons = await screen.findAllByRole('button', { name: /reset password/i });
    await user.click(resetButtons[0]!);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You cannot reset your own password here.',
    );
  });

  it('shows a generic message when resetting a password fails with a non-API error', async () => {
    server.use(authenticated, usersList);
    requestOverrides.set(`POST /users/${STUB_USER.id}/reset-password`, () =>
      Promise.reject(new Error('boom')),
    );
    const user = userEvent.setup();
    renderWithProviders();
    await findListedUser(/Team Lead/);
    const resetButtons = await screen.findAllByRole('button', { name: /reset password/i });
    await user.click(resetButtons[0]!);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reset password.');
  });
});
