import type { JSX, RefObject } from 'react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastProvider } from '../../src/context/ToastProvider';
import { TokenCard } from '../../src/components/tokens/TokenCard';
import { TokenCreateDialog } from '../../src/components/tokens/TokenCreateDialog';
import { TokenRevealDialog } from '../../src/components/tokens/TokenRevealDialog';
import { useTokenDialog } from '../../src/hooks/useTokenDialog';
import type { TokenCreateValues } from '../../src/components/tokens/TokenCreateDialog';
import type { TokenMetadata, TokenScope } from '../../src/types/api';

const RAW_TOKEN = 'pto_pat_cccccccc-cccc-cccc-cccc-cccccccccccc.' + 'a'.repeat(64);

const TOKEN: TokenMetadata = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  name: 'Laptop',
  displayPrefix: 'pto_pat_cccccccc-cccc-cccc-cccc-cccccccccccc',
  scopes: ['pto:read'],
  createdAt: '2026-06-01T10:00:00.000Z',
  expiresAt: '2026-09-01T10:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  status: 'active',
};

function tokenWith(overrides: Partial<TokenMetadata>): TokenMetadata {
  return { ...TOKEN, ...overrides };
}

function noop(): void {
  // Intentionally empty: the assertions are about what the dialog did.
}

function renderWithToasts(node: JSX.Element): ReturnType<typeof render> {
  return render(<ToastProvider>{node}</ToastProvider>);
}

/**
 * The clipboard is a global of the browser, so the state it had before any
 * test could touch it is captured once, while this module is evaluated, and
 * restored exactly after every test.
 *
 * Capturing it when the test ends would capture the stub the test just
 * installed, and that stub would leak into the next test. The capture keeps
 * the original navigator and the original own descriptor of `clipboard`, so a
 * navigator that had no own clipboard property (the browser inherits one, or
 * has none at all) is restored by dropping the stub instead.
 */
const ORIGINAL_NAVIGATOR = globalThis.navigator;
const ORIGINAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  ORIGINAL_NAVIGATOR,
  'clipboard',
);
const ORIGINAL_CLIPBOARD_VALUE = ORIGINAL_NAVIGATOR.clipboard;

function stubClipboard(value: unknown): void {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreClipboard(): void {
  // The stubbed globals are gone by now, so the real navigator is back.
  if (globalThis.navigator !== ORIGINAL_NAVIGATOR) return;
  if (ORIGINAL_CLIPBOARD_DESCRIPTOR) {
    Object.defineProperty(globalThis.navigator, 'clipboard', ORIGINAL_CLIPBOARD_DESCRIPTOR);
    return;
  }
  // The navigator had no own clipboard property, so the stub is dropped and
  // the inherited (or absent) one shows through again.
  Reflect.deleteProperty(globalThis.navigator, 'clipboard');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
});

afterEach(() => {
  // The stubbed globals go first, so the clipboard is restored on the real
  // navigator.
  vi.unstubAllGlobals();
  restoreClipboard();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TokenRevealDialog', () => {
  it('copies nothing when there is no secret to copy', () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard({ writeText });
    renderWithToasts(<TokenRevealDialog token={TOKEN} rawToken="" role="member" onClose={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    // Without a secret there is nothing to copy, and nothing is claimed.
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByTestId('token-copy-status')).not.toBeInTheDocument();
  });

  it('falls back to a manual copy on a page without a navigator', async () => {
    // A runtime without a navigator has no clipboard at all.
    vi.stubGlobal('navigator', undefined);
    renderWithToasts(
      <TokenRevealDialog token={TOKEN} rawToken={RAW_TOKEN} role="member" onClose={noop} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }));
    expect(await screen.findByTestId('token-copy-status')).toHaveTextContent(
      /copying was blocked/i,
    );
    expect(screen.getByLabelText(/new token/i)).toHaveValue(RAW_TOKEN);
  });

  it('restores the original clipboard after stubbing it', () => {
    const stub = { writeText: vi.fn(async () => undefined) };
    stubClipboard(stub);
    expect(globalThis.navigator.clipboard).toBe(stub);
    restoreClipboard();
    expect(globalThis.navigator).toBe(ORIGINAL_NAVIGATOR);
    expect(Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')).toEqual(
      ORIGINAL_CLIPBOARD_DESCRIPTOR,
    );
    expect(globalThis.navigator.clipboard).toBe(ORIGINAL_CLIPBOARD_VALUE);
  });

  it('shows no metadata when the token itself is unknown', () => {
    renderWithToasts(
      <TokenRevealDialog token={null} rawToken={RAW_TOKEN} role="member" onClose={noop} />,
    );
    expect(screen.getByRole('dialog', { name: /copy your token/i })).toBeInTheDocument();
    expect(screen.queryByTestId('token-reveal-expiry')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Scopes$/)).not.toBeInTheDocument();
  });

  it('says that a token has no scopes when the server granted none', () => {
    renderWithToasts(
      <TokenRevealDialog
        token={tokenWith({ scopes: [] })}
        rawToken={RAW_TOKEN}
        role="member"
        onClose={noop}
      />,
    );
    expect(screen.getByTestId('token-reveal-expiry')).toBeInTheDocument();
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('shows the raw scope when the server sent one that is not known', () => {
    renderWithToasts(
      <TokenRevealDialog
        token={tokenWith({ scopes: ['pto:mystery' as TokenScope] })}
        rawToken={RAW_TOKEN}
        role="member"
        onClose={noop}
      />,
    );
    // An unknown scope is shown verbatim instead of being dropped.
    expect(screen.getByText('pto:mystery')).toBeInTheDocument();
  });

  it('explains whose notes a note scope can read', () => {
    renderWithToasts(
      <TokenRevealDialog
        token={tokenWith({ scopes: ['pto:read', 'pto:notes:read'] })}
        rawToken={RAW_TOKEN}
        role="team_lead"
        onClose={noop}
      />,
    );
    expect(screen.getByText(/notes of teammates/i)).toBeInTheDocument();
  });
});

describe('TokenCreateDialog', () => {
  it('empties the password field when the page is frozen', async () => {
    const user = userEvent.setup();
    renderWithToasts(
      <TokenCreateDialog
        role="member"
        submitting={false}
        error={null}
        onSubmit={noop}
        onClose={noop}
      />,
    );
    const password = screen.getByLabelText(/current password/i) as HTMLInputElement;
    await user.type(password, 'correct horse');
    expect(password.value).toBe('correct horse');
    fireEvent(window, new Event('pagehide'));
    // The password is dropped synchronously, so a frozen page cannot replay it.
    expect(password.value).toBe('');
  });

  it('closes the form when the backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithToasts(
      <TokenCreateDialog
        role="member"
        submitting={false}
        error={null}
        onSubmit={noop}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: /new personal access token/i });
    await user.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends the entered values when the form is submitted', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((_values: TokenCreateValues) => undefined);
    renderWithToasts(
      <TokenCreateDialog
        role="member"
        submitting={false}
        error={null}
        onSubmit={onSubmit}
        onClose={noop}
      />,
    );
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    const dialog = screen.getByRole('dialog', { name: /new personal access token/i });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Laptop',
      password: 'correct horse',
      scopes: ['pto:read'],
      expiresInDays: 90,
    });
  });

  it('refuses a second submit while the request is running', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((_values: TokenCreateValues) => undefined);
    renderWithToasts(
      <TokenCreateDialog
        role="member"
        submitting={true}
        error={null}
        onSubmit={onSubmit}
        onClose={noop}
      />,
    );
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    const dialog = screen.getByRole('dialog', { name: /new personal access token/i });
    fireEvent.submit(dialog.querySelector('form')!);
    // The form is complete, but the dialog is busy, so no new request starts.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a submit while the account is blocked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((_values: TokenCreateValues) => undefined);
    renderWithToasts(
      <TokenCreateDialog
        role="member"
        submitting={false}
        error={null}
        blocked={true}
        onSubmit={onSubmit}
        onClose={noop}
      />,
    );
    await user.type(screen.getByLabelText(/token name/i), 'Laptop');
    await user.type(screen.getByLabelText(/current password/i), 'correct horse');
    const dialog = screen.getByRole('dialog', { name: /new personal access token/i });
    fireEvent.submit(dialog.querySelector('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/creating a token is blocked/i)).toBeInTheDocument();
  });
});

describe('TokenCard', () => {
  it('says that a token has no scopes when the server granted none', () => {
    render(
      <ul>
        <TokenCard token={tokenWith({ scopes: [] })} role="member" onRevoke={noop} />
      </ul>,
    );
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('shows the raw scope when the server sent one that is not known', () => {
    render(
      <ul>
        <TokenCard
          token={tokenWith({ scopes: ['pto:mystery' as TokenScope] })}
          role="member"
          onRevoke={noop}
        />
      </ul>,
    );
    const scopeList = screen.getByRole('heading', { name: /scopes/i }).nextElementSibling;
    // An unknown scope is shown verbatim instead of being dropped.
    expect(scopeList).toHaveTextContent('pto:mystery');
  });

  it('explains whose notes a note scope can read', () => {
    render(
      <ul>
        <TokenCard
          token={tokenWith({ scopes: ['pto:read', 'pto:notes:read'] })}
          role="member"
          onRevoke={noop}
        />
      </ul>,
    );
    expect(screen.getByText(/your own notes only/i)).toBeInTheDocument();
  });
});

interface DialogHarnessProps {
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * A minimal owner of the dialog hook, so the focus behaviour of the hook can
 * be observed without a route around it.
 */
function DialogHarness({ returnFocusRef }: DialogHarnessProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open the form
      </button>
      {open ? (
        <TokenCreateDialog
          role="member"
          submitting={false}
          error={null}
          returnFocusRef={returnFocusRef}
          onSubmit={noop}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe('useTokenDialog', () => {
  it('renders where there is no document at all', () => {
    // A runtime without a document has no focus to capture and no trap.
    vi.stubGlobal('document', undefined);
    const html = renderToStaticMarkup(
      <ToastProvider>
        <TokenCreateDialog
          role="member"
          submitting={false}
          error={null}
          onSubmit={noop}
          onClose={noop}
        />
      </ToastProvider>,
    );
    expect(html).toContain('New personal access token');
  });

  it('does not restore the focus to an element that is not an HTML element', async () => {
    const user = userEvent.setup();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('tabindex', '-1');
    document.body.appendChild(svg);
    svg.focus();
    expect(document.activeElement).toBe(svg);
    expect(document.activeElement instanceof HTMLElement).toBe(false);

    const onClose = vi.fn();
    renderWithToasts(
      <TokenCreateDialog
        role="member"
        submitting={false}
        error={null}
        onSubmit={noop}
        onClose={onClose}
      />,
    );
    expect(
      await screen.findByRole('dialog', { name: /new personal access token/i }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    // The element that had the focus is not an HTML element, so the dialog
    // does not try to move the focus back to it.
    expect(document.activeElement).not.toBe(svg);
    svg.remove();
  });

  it('installs no trap while the dialog is closed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function ClosedDialog(): JSX.Element {
      useTokenDialog<HTMLDivElement>(false, onClose);
      return <div>closed</div>;
    }
    render(<ClosedDialog />);
    expect(document.body.style.overflow).toBe('');
    await user.keyboard('{Escape}');
    // A closed dialog neither traps the keyboard nor locks the page.
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.style.overflow).toBe('');
  });

  it('returns the focus to the control that opened it when no trigger is given', async () => {
    const user = userEvent.setup();
    const emptyTrigger: RefObject<HTMLElement | null> = { current: null };
    render(
      <ToastProvider>
        <DialogHarness returnFocusRef={emptyTrigger} />
      </ToastProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'open the form' });
    await user.click(trigger);
    expect(
      await screen.findByRole('dialog', { name: /new personal access token/i }),
    ).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /new personal access token/i }),
      ).not.toBeInTheDocument();
    });
    // Without an explicit trigger the control that had the focus is used.
    expect(trigger).toHaveFocus();
  });
});
