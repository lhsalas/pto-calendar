import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { AdminUsersPage } from '../../src/pages/admin/AdminUsersPage';
import { server } from '../mocks/server';
import { authenticated, createUserOk, resetPasswordOk, usersList } from '../mocks/handlers';

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
  unstubClipboard();
  vi.useRealTimers();
});

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

  it('copies the full setup URL (not just the token) to the clipboard', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    const { writeText } = stubClipboard(async () => undefined);
    renderWithProviders();
    await screen.findByText(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    const input = await screen.findByTestId('setup-url-input');
    const copyButton = screen.getByTestId('copy-setup-url-button');
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    const [written] = writeText.mock.calls[0] ?? [];
    expect(written).toMatch(/^http:\/\/[^/]+\/setup-account\?token=/);
    expect(written).toBe((input as HTMLInputElement).value);
    expect(written).toContain('a'.repeat(64));
    expect(written).not.toBe('a'.repeat(64));
  });

  it('flips the copy button to Copied after success and back to Copy after the feedback window', async () => {
    server.use(authenticated, usersList, createUserOk);
    const user = userEvent.setup({ writeToClipboard: false });
    stubClipboard(async () => undefined);
    renderWithProviders();
    await screen.findByText(/Team Lead/);
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
    await screen.findByText(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    const input = await screen.findByTestId('setup-url-input');
    const copyButton = screen.getByTestId('copy-setup-url-button');
    await user.click(copyButton);

    expect(document.activeElement).toBe(input);
    expect(copyButton).toHaveTextContent(/Copy failed/);
  });

  it('selects the read-only input on focus so manual copy works even on clipboard success', async () => {
    server.use(authenticated, usersList, createUserOk);
    stubClipboard(async () => undefined);
    const user = userEvent.setup({ writeToClipboard: false });
    renderWithProviders();
    await screen.findByText(/Team Lead/);
    await user.type(screen.getByLabelText(/name/i), 'New Member');
    await user.type(screen.getByLabelText(/email/i), 'newmember@example.com');
    await user.click(screen.getByRole('button', { name: /create user/i }));
    const input = await screen.findByTestId('setup-url-input');
    await user.click(input);
    expect(document.activeElement).toBe(input);
  });

  it('copies the full setup URL from the Reset password card', async () => {
    server.use(authenticated, usersList, createUserOk, resetPasswordOk);
    const user = userEvent.setup({ writeToClipboard: false });
    const { writeText } = stubClipboard(async () => undefined);
    renderWithProviders();
    await screen.findByText(/Team Lead/);
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
    await screen.findByText(/Team Lead/);

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
});
