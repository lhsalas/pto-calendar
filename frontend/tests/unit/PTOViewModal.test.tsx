import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { PTOViewModal } from '../../src/components/pto/PTOViewModal';
import { STUB_PTO, STUB_PTO_DETAIL, STUB_USER } from '../mocks/handlers';
import { formatRangeLabel } from '../../src/lib/calendar';
import * as api from '../../src/api/client';
import type { PTO } from '../../src/types/api';

type ModalProps = React.ComponentProps<typeof PTOViewModal>;

function preparedExpected(pto: ModalProps['pto'], viewer = STUB_USER) {
  return { ...pto, version: PTO_DETAIL.version, noteLoadedFor: `${viewer.id}:${viewer.role}` };
}

const PTO_DETAIL: PTO = {
  ...STUB_PTO_DETAIL,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderModal(
  props: Partial<ModalProps> = {},
): ReturnType<typeof render> & { rerenderModal: (props: Partial<ModalProps>) => void } {
  const modalProps: ModalProps = {
    pto: STUB_PTO,
    currentUser: STUB_USER,
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(async () => {}),
    ...props,
  };
  const view = render(<PTOViewModal {...modalProps} />);
  return {
    ...view,
    rerenderModal: (nextProps) => view.rerender(<PTOViewModal {...modalProps} {...nextProps} />),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('PTOViewModal', () => {
  it('renders the PTO details and shows the day part label', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/PTO details/i)).toBeInTheDocument();
    expect(screen.getByText(STUB_USER.name)).toBeInTheDocument();
    expect(
      screen.getByText(formatRangeLabel(STUB_PTO.startDate, STUB_PTO.endDate)),
    ).toBeInTheDocument();
    expect(screen.getByText(/morning \(am\)/i)).toBeInTheDocument();
  });

  it('shows Edit and Delete buttons for the owner', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('never loads a note for a member who cannot modify the PTO', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const requestDetail = vi.fn(() => HttpResponse.json(PTO_DETAIL));
    server.use(http.get('/pto/:id', requestDetail));
    const otherMember = {
      id: 'other-member-id',
      name: 'Other',
      role: 'member' as const,
      email: 'other@example.com',
      colorCode: '#000',
    };
    renderModal({
      pto: { ...STUB_PTO, user: { ...STUB_PTO.user, id: 'not-this-user' } },
      currentUser: otherMember,
      onEdit,
    });
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(screen.getByText('(no note)')).toHaveClass(
      'text-ink-muted/70',
      'dark:text-ink-muted-dark/70',
    );
    await user.click(screen.getByText('Note'));
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(requestDetail).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it.each(['team_lead', 'admin'] as const)(
    'shows modification and note-loading buttons for a %s viewing another user PTO',
    (role) => {
      const teamLead = {
        id: 'team-lead-id',
        name: 'Lead',
        role,
        email: 'lead@example.com',
        colorCode: '#000',
      };
      renderModal({
        pto: { ...STUB_PTO, user: { ...STUB_PTO.user, id: 'not-this-user' } },
        currentUser: teamLead,
      });
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /load note/i })).toBeInTheDocument();
    },
  );

  it.each([
    { role: 'member' as const, id: STUB_USER.id },
    { role: 'team_lead' as const, id: 'other-lead-id' },
    { role: 'admin' as const, id: 'admin-id' },
  ])('loads the authorized detail note before editing as $role', async ({ role, id }) => {
    const user = userEvent.setup();
    const response = deferred<PTO>();
    const requestDetail = vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
    const onEdit = vi.fn();
    renderModal({ onEdit, currentUser: { ...STUB_USER, id, role } });
    const editButton = screen.getByRole('button', { name: /^edit$/i });
    editButton.focus();
    await user.keyboard('{Enter}');
    expect(onEdit).not.toHaveBeenCalled();
    expect(requestDetail).toHaveBeenCalledExactlyOnceWith(`/pto/${STUB_PTO.id}`, {
      cache: 'no-store',
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading note…');
    expect(editButton).toHaveAttribute('aria-disabled', 'true');
    expect(editButton).toHaveFocus();

    await act(async () => response.resolve({ ...PTO_DETAIL, note: 'Doctor' }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(
      preparedExpected({ ...STUB_PTO, note: 'Doctor' }, { ...STUB_USER, id, role }),
    );
  });

  it.each([null, 'Loaded private note'])(
    'hands off the cached note %s without fetching again',
    async (note) => {
      const user = userEvent.setup();
      const requestDetail = vi.spyOn(api, 'apiRequest').mockResolvedValue({ ...PTO_DETAIL, note });
      const onEdit = vi.fn();
      renderModal({ onEdit });
      await user.click(screen.getByRole('button', { name: /load note/i }));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /^edit$/i }));
      expect(onEdit).toHaveBeenCalledExactlyOnceWith(preparedExpected({ ...STUB_PTO, note }));
      expect(requestDetail).toHaveBeenCalledTimes(1);
    },
  );

  it('loads the authoritative version even when a summary already contains note text', async () => {
    const user = userEvent.setup();
    const requestDetail = vi
      .spyOn(api, 'apiRequest')
      .mockResolvedValue({ ...PTO_DETAIL, note: 'Current private note' });
    const onEdit = vi.fn();
    const pto = { ...STUB_PTO, note: 'Known private note' };
    renderModal({ pto, onEdit });
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(
      preparedExpected({ ...pto, note: 'Current private note' }),
    );
    expect(requestDetail).toHaveBeenCalledExactlyOnceWith(`/pto/${pto.id}`, {
      cache: 'no-store',
    });
  });

  it('joins an in-flight note load and deduplicates rapid edit requests', async () => {
    const user = userEvent.setup();
    const response = deferred<PTO>();
    const requestDetail = vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
    const onEdit = vi.fn();
    renderModal({ onEdit });
    await user.click(screen.getByRole('button', { name: /load note/i }));
    const editButton = screen.getByRole('button', { name: /^edit$/i });
    act(() => {
      editButton.click();
      editButton.click();
    });
    expect(onEdit).not.toHaveBeenCalled();
    expect(requestDetail).toHaveBeenCalledTimes(1);

    await act(async () => response.resolve({ ...PTO_DETAIL, note: 'Shared detail note' }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(
      preparedExpected({ ...STUB_PTO, note: 'Shared detail note' }),
    );
    expect(requestDetail).toHaveBeenCalledTimes(1);
  });

  it('keeps failed edit preparation closed, focused, and retryable without a blank fallback', async () => {
    const user = userEvent.setup();
    const response = deferred<PTO>();
    const retry = deferred<PTO>();
    const requestDetail = vi
      .spyOn(api, 'apiRequest')
      .mockReturnValueOnce(response.promise)
      .mockReturnValueOnce(retry.promise);
    const onEdit = vi.fn();
    renderModal({ onEdit });
    const editButton = screen.getByRole('button', { name: /^edit$/i });
    await user.click(editButton);
    await act(async () => {
      response.reject(new Error('Cannot load the private note'));
      await response.promise.catch(() => undefined);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot load the private note');
    expect(onEdit).not.toHaveBeenCalled();
    expect(editButton).toHaveTextContent('Edit');
    expect(editButton).toHaveAttribute('aria-disabled', 'false');
    expect(editButton).toHaveFocus();
    expect(screen.getByRole('button', { name: /load note/i })).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => retry.resolve({ ...PTO_DETAIL, note: 'Preserved after retry' }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(
      preparedExpected({ ...STUB_PTO, note: 'Preserved after retry' }),
    );
    expect(requestDetail).toHaveBeenCalledTimes(2);
  });

  it('does not treat a missing detail note as a known empty note', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'apiRequest').mockResolvedValueOnce({ ...PTO_DETAIL, note: undefined });
    const onEdit = vi.fn();
    renderModal({ onEdit });
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load PTO details.');
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^edit$/i })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });

  it.each(['Close', 'Dismiss', 'backdrop', 'Escape'])(
    'cancels a pending edit handoff on %s even before the parent unmounts',
    async (action) => {
      const user = userEvent.setup();
      const response = deferred<PTO>();
      vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
      const onEdit = vi.fn();
      const onClose = vi.fn();
      renderModal({ onEdit, onClose });
      await user.click(screen.getByRole('button', { name: /^edit$/i }));
      if (action === 'Escape') await user.keyboard('{Escape}');
      else if (action === 'backdrop') await user.click(screen.getByRole('dialog'));
      else await user.click(screen.getByRole('button', { name: action }));
      expect(onClose).toHaveBeenCalledTimes(1);
      await act(async () => response.resolve({ ...PTO_DETAIL, note: 'Late private note' }));
      expect(onEdit).not.toHaveBeenCalled();
    },
  );

  it('does not reuse a pending edit from a previous opening of the same PTO', async () => {
    const user = userEvent.setup();
    const oldResponse = deferred<PTO>();
    const newResponse = deferred<PTO>();
    const requestDetail = vi
      .spyOn(api, 'apiRequest')
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const oldEdit = vi.fn();
    const newEdit = vi.fn();
    const { unmount } = renderModal({ onEdit: oldEdit });
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    unmount();
    renderModal({ onEdit: newEdit });
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(requestDetail).toHaveBeenCalledTimes(2);
    await act(async () => oldResponse.resolve({ ...PTO_DETAIL, note: 'Old note' }));
    expect(oldEdit).not.toHaveBeenCalled();
    expect(newEdit).not.toHaveBeenCalled();
    await act(async () => newResponse.resolve({ ...PTO_DETAIL, note: 'Current note' }));
    expect(newEdit).toHaveBeenCalledExactlyOnceWith(
      preparedExpected({ ...STUB_PTO, note: 'Current note' }),
    );
  });

  it.each(['success', 'failure'])(
    'ignores an old edit preparation %s after the PTO changes',
    async (outcome) => {
      const user = userEvent.setup();
      const oldResponse = deferred<PTO>();
      const otherPto = { ...STUB_PTO, id: 'other-pto-id' };
      vi.spyOn(api, 'apiRequest')
        .mockReturnValueOnce(oldResponse.promise)
        .mockResolvedValueOnce({ ...PTO_DETAIL, id: otherPto.id, note: 'Other note' });
      const onEdit = vi.fn();
      const { rerenderModal } = renderModal({ onEdit });
      await user.click(screen.getByRole('button', { name: /^edit$/i }));
      rerenderModal({ pto: otherPto });
      await user.click(screen.getByRole('button', { name: /^edit$/i }));
      expect(onEdit).toHaveBeenCalledExactlyOnceWith(
        preparedExpected({ ...otherPto, note: 'Other note' }),
      );
      await act(async () => {
        if (outcome === 'success') oldResponse.resolve({ ...PTO_DETAIL, note: 'Old note' });
        else oldResponse.reject(new Error('Old detail error'));
        await oldResponse.promise.catch(() => undefined);
      });
      expect(onEdit).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it.each([
    { id: STUB_USER.id, role: 'member' as const },
    { id: 'different-viewer-id', role: 'team_lead' as const },
  ])(
    'discards an old private-note handoff when the viewer changes to $id/$role',
    async (currentUser) => {
      const user = userEvent.setup();
      const response = deferred<PTO>();
      vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
      const onEdit = vi.fn();
      const { rerenderModal } = renderModal({
        onEdit,
        pto: { ...STUB_PTO, user: { ...STUB_PTO.user, id: 'other-owner-id' } },
      });
      await user.click(screen.getByRole('button', { name: /^edit$/i }));
      rerenderModal({
        pto: { ...STUB_PTO, user: { ...STUB_PTO.user, id: 'other-owner-id' } },
        currentUser: { ...STUB_USER, ...currentUser },
      });
      await act(async () =>
        response.resolve({ ...PTO_DETAIL, note: 'Previous viewer private note' }),
      );
      expect(onEdit).not.toHaveBeenCalled();
      expect(screen.queryByText('Previous viewer private note')).not.toBeInTheDocument();
      expect(screen.getByText('(no note)')).toHaveClass('text-ink-muted/70');
    },
  );

  it('prepares the edit note under StrictMode lifecycle replay', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'apiRequest').mockResolvedValue({ ...PTO_DETAIL, note: 'Doctor' });
    const onEdit = vi.fn();
    render(
      <StrictMode>
        <PTOViewModal
          pto={STUB_PTO}
          currentUser={STUB_USER}
          onClose={vi.fn()}
          onEdit={onEdit}
          onDelete={vi.fn(async () => {})}
        />
      </StrictMode>,
    );
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledExactlyOnceWith(
      preparedExpected({ ...STUB_PTO, note: 'Doctor' }),
    );
  });

  it('asks for confirmation before calling onDelete', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {});
    const detail = {
      ...PTO_DETAIL,
      startDate: '2026-05-12',
      endDate: '2026-05-12',
      dayPart: 'evening' as const,
    };
    vi.spyOn(api, 'apiRequest').mockResolvedValue(detail);
    renderModal({ onDelete });
    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(
      screen.getByText(formatRangeLabel(detail.startDate, detail.endDate)),
    ).toBeInTheDocument();
    expect(screen.getByText(/evening \(pm\)/i)).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledExactlyOnceWith(
        preparedExpected({
          ...STUB_PTO,
          startDate: detail.startDate,
          endDate: detail.endDate,
          dayPart: detail.dayPart,
        }),
        detail.version,
      );
    });
  });

  it('surfaces server errors from the delete call', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {
      throw new Error('Cannot delete');
    });
    vi.spyOn(api, 'apiRequest').mockResolvedValue(PTO_DETAIL);
    renderModal({ onDelete });
    await user.click(screen.getByRole('button', { name: /delete/i }));
    await user.click(await screen.findByRole('button', { name: /yes, delete/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot delete/i);
  });

  it('loads the note when the owner clicks "Load note"', async () => {
    const user = userEvent.setup();
    const requestDetail = vi.fn(() => HttpResponse.json({ ...PTO_DETAIL, note: 'Private note' }));
    server.use(http.get('/pto/:id', requestDetail));
    renderModal({ currentUser: { ...STUB_USER, role: 'member' } });
    expect(screen.getByText('(no note)')).toHaveClass(
      'text-ink-muted/70',
      'dark:text-ink-muted-dark/70',
    );
    expect(requestDetail).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByText('Private note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(screen.queryByText('(no note)')).not.toBeInTheDocument();
    expect(requestDetail).toHaveBeenCalledTimes(1);
  });

  it('remembers a loaded empty note until the modal is reopened', async () => {
    const user = userEvent.setup();
    const requestDetail = vi.fn(() => HttpResponse.json(PTO_DETAIL));
    server.use(http.get('/pto/:id', requestDetail));
    const { rerenderModal, unmount } = renderModal();
    await user.click(screen.getByRole('button', { name: /load note/i }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
    expect(screen.getByText('(no note)')).not.toHaveClass('text-ink-muted/70');
    expect(screen.getByText('(no note)')).not.toHaveClass('dark:text-ink-muted-dark/70');
    expect(screen.getByText('(no note)')).toHaveClass('text-ink', 'dark:text-ink-dark');

    // A fresh list object for the same PTO must not make the note unknown again.
    rerenderModal({ pto: { ...STUB_PTO } });
    await user.click(screen.getByText('(no note)'));
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(requestDetail).toHaveBeenCalledTimes(1);

    unmount();
    renderModal();
    expect(screen.getByRole('button', { name: /load note/i })).toBeInTheDocument();
    expect(screen.getByText('(no note)')).toHaveClass('text-ink-muted/70');
    await user.click(screen.getByRole('button', { name: /load note/i }));
    await waitFor(() => expect(requestDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('keeps a failed note load retryable and clears the error on retry', async () => {
    const user = userEvent.setup();
    const requestDetail = vi
      .fn()
      .mockImplementationOnce(() =>
        HttpResponse.json(
          { error: { code: 'UNAVAILABLE', message: 'Cannot load note' } },
          { status: 503 },
        ),
      )
      .mockImplementationOnce(() => HttpResponse.json(PTO_DETAIL));
    server.use(http.get('/pto/:id', requestDetail));
    renderModal();
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load note');
    expect(screen.getByRole('button', { name: /load note/i })).toBeInTheDocument();
    expect(screen.getByText('(no note)')).toHaveClass('text-ink-muted/70');

    await user.click(screen.getByRole('button', { name: /load note/i }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(screen.getByText('(no note)')).toHaveClass('text-ink', 'dark:text-ink-dark');
    expect(requestDetail).toHaveBeenCalledTimes(2);
  });

  it('shows a fallback error when a note load rejects without an Error', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'apiRequest').mockRejectedValueOnce('unavailable');
    renderModal();
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load PTO details.');
    expect(screen.getByRole('button', { name: /load note/i })).toBeInTheDocument();
  });

  it('deduplicates rapid clicks while the note is loading', async () => {
    const response = deferred<PTO>();
    const requestDetail = vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
    renderModal();
    const button = screen.getByRole('button', { name: /load note/i });
    // Both events arrive before React commits the loading state.
    act(() => {
      button.click();
      button.click();
    });
    expect(requestDetail).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Loading note…');
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(screen.getByText('(no note)')).toHaveClass('text-ink-muted/70');

    await act(async () => response.resolve(PTO_DETAIL));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(screen.getByText('(no note)')).toHaveClass('text-ink', 'dark:text-ink-dark');
  });

  it.each([
    { label: 'empty', note: null },
    { label: 'text', note: 'Private note' },
  ])(
    'keeps keyboard focus inside the dialog through a successful $label load',
    async ({ note }) => {
      const user = userEvent.setup();
      const response = deferred<PTO>();
      const requestDetail = vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
      renderModal();
      const button = screen.getByRole('button', { name: /load note/i });
      const noteContent = screen.getByTestId('pto-note-content');
      expect(noteContent.tagName).toBe('DD');
      expect(noteContent).toHaveAccessibleDescription('Note');
      expect(noteContent).not.toHaveAttribute('aria-labelledby');
      button.focus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('status')).toHaveTextContent('Loading note…');
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
      expect(noteContent).toHaveFocus();

      await act(async () => response.resolve({ ...PTO_DETAIL, note }));
      expect(noteContent).toHaveFocus();
      expect(noteContent).toHaveTextContent(note ?? '(no note)');
      expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
      expect(requestDetail).toHaveBeenCalledTimes(1);
    },
  );

  it('returns keyboard focus to the retry button after a failed note load', async () => {
    const user = userEvent.setup();
    const response = deferred<PTO>();
    const retry = deferred<PTO>();
    const requestDetail = vi
      .spyOn(api, 'apiRequest')
      .mockReturnValueOnce(response.promise)
      .mockReturnValueOnce(retry.promise);
    renderModal();
    const button = screen.getByRole('button', { name: /load note/i });
    const noteContent = screen.getByTestId('pto-note-content');
    button.focus();
    await user.keyboard('{Enter}');
    expect(noteContent).toHaveFocus();

    await act(async () => {
      response.reject(new Error('Cannot load note'));
      await response.promise.catch(() => undefined);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot load note');
    expect(screen.getByRole('button', { name: /load note/i })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(noteContent).toHaveFocus();
    await act(async () => retry.resolve(PTO_DETAIL));
    expect(noteContent).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(requestDetail).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'failure'])(
    'does not reclaim focus moved to another control before note load %s',
    async (outcome) => {
      const user = userEvent.setup();
      const response = deferred<PTO>();
      vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
      renderModal();
      const button = screen.getByRole('button', { name: /load note/i });
      const noteContent = screen.getByTestId('pto-note-content');
      button.focus();
      await user.keyboard('{Enter}');
      expect(noteContent).toHaveFocus();

      await user.tab();
      const closeButton = screen.getByRole('button', { name: /^close$/i });
      expect(closeButton).toHaveFocus();
      await act(async () => {
        if (outcome === 'success') response.resolve(PTO_DETAIL);
        else response.reject(new Error('Cannot load note'));
        await response.promise.catch(() => undefined);
      });
      expect(closeButton).toHaveFocus();
      if (outcome === 'failure') {
        expect(screen.getByRole('button', { name: /load note/i })).not.toHaveFocus();
      }
    },
  );

  it.each(['success', 'failure'])(
    'does not move focus for an unfocused note button activation before %s',
    async (outcome) => {
      const response = deferred<PTO>();
      vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
      renderModal();
      const dismissButton = screen.getByRole('button', { name: /dismiss/i });
      expect(dismissButton).toHaveFocus();

      act(() => screen.getByRole('button', { name: /load note/i }).click());
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(dismissButton).toHaveFocus();
      await act(async () => {
        if (outcome === 'success') response.resolve(PTO_DETAIL);
        else response.reject(new Error('Cannot load note'));
        await response.promise.catch(() => undefined);
      });
      expect(dismissButton).toHaveFocus();
    },
  );

  it('does not fetch a note already supplied as text', () => {
    const requestDetail = vi.spyOn(api, 'apiRequest');
    renderModal({ pto: { ...STUB_PTO, note: 'Known note' } });
    expect(screen.getByText('Known note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
    expect(requestDetail).not.toHaveBeenCalled();
  });

  it('resets a loaded note when a different PTO is selected', async () => {
    const user = userEvent.setup();
    const otherPto = { ...STUB_PTO, id: 'other-pto-id' };
    const requestDetail = vi
      .spyOn(api, 'apiRequest')
      .mockResolvedValueOnce({ ...PTO_DETAIL, note: 'First note' })
      .mockResolvedValueOnce({ ...PTO_DETAIL, id: otherPto.id, note: 'Other note' });
    const { rerenderModal } = renderModal();
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByText('First note')).toBeInTheDocument();

    rerenderModal({ pto: otherPto });
    expect(screen.queryByText('First note')).not.toBeInTheDocument();
    expect(screen.getByText('(no note)')).toHaveClass('text-ink-muted/70');
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByText('Other note')).toBeInTheDocument();
    expect(requestDetail).toHaveBeenNthCalledWith(2, `/pto/${otherPto.id}`, { cache: 'no-store' });
  });

  it('resets note errors and delete confirmation when a different PTO is selected', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'apiRequest')
      .mockRejectedValueOnce(new Error('Cannot load note'))
      .mockResolvedValueOnce(PTO_DETAIL);
    const { rerenderModal } = renderModal();
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();

    rerenderModal({ pto: { ...STUB_PTO, id: 'other-pto-id' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load note/i })).toBeInTheDocument();
  });

  it.each(['success', 'failure'])('ignores a late %s from the previous PTO', async (outcome) => {
    const user = userEvent.setup();
    const response = deferred<PTO>();
    vi.spyOn(api, 'apiRequest')
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ ...PTO_DETAIL, id: 'other-pto-id', note: 'Other note' });
    const { rerenderModal } = renderModal();
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(screen.getByRole('status')).toBeInTheDocument();

    rerenderModal({ pto: { ...STUB_PTO, id: 'other-pto-id' } });
    expect(screen.getByText('(no note)')).toHaveClass('text-ink-muted/70');
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByText('Other note')).toBeInTheDocument();

    await act(async () => {
      if (outcome === 'success') response.resolve({ ...PTO_DETAIL, note: 'Stale note' });
      else response.reject(new Error('Stale error'));
      await response.promise.catch(() => undefined);
    });
    expect(screen.getByText('Other note')).toBeInTheDocument();
    expect(screen.queryByText('Stale note')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load note/i })).not.toBeInTheDocument();
  });

  it('calls onClose when the Close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('labels an evening PTO and an all-day PTO', () => {
    const { unmount } = renderModal({ pto: { ...STUB_PTO, dayPart: 'evening' } });
    expect(screen.getByText(/evening \(pm\)/i)).toBeInTheDocument();
    unmount();

    renderModal({ pto: { ...STUB_PTO, dayPart: 'all_day' } });
    expect(screen.getByText(/all day/i)).toBeInTheDocument();
  });

  it('calls onClose when the backdrop is clicked but not when the card is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });

    const backdrop = screen.getByRole('dialog');
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    // A click inside the card must not bubble into the backdrop handler.
    await user.click(screen.getByText(/PTO details/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('PTOViewModal abandoned session', () => {
  it('refuses to load the note after the modal was dismissed', async () => {
    const user = userEvent.setup();
    const requestDetail = vi.spyOn(api, 'apiRequest');
    // The parent keeps the modal mounted, so the dismissal only ends the session.
    renderModal({ onClose: vi.fn() });
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(requestDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a note that was already supplied when a later detail load fails', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    vi.spyOn(api, 'apiRequest').mockRejectedValueOnce(new Error('Cannot load the private note'));
    renderModal({ pto: { ...STUB_PTO, note: 'Doctor' }, onEdit });
    expect(screen.getByText('Doctor')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load the private note');
    // The known note is not thrown away by the failed refresh.
    expect(screen.getByText('Doctor')).toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('does not prepare a delete after the modal was dismissed', async () => {
    const user = userEvent.setup();
    const requestDetail = vi.spyOn(api, 'apiRequest');
    renderModal({ onClose: vi.fn() });
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(requestDetail).not.toHaveBeenCalled();
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
  });

  it('does not offer the delete confirmation when the modal is dismissed while the details load', async () => {
    const user = userEvent.setup();
    const response = deferred<PTO>();
    vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
    renderModal({ onClose: vi.fn() });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    await act(async () => response.resolve({ ...PTO_DETAIL, note: 'Late private note' }));
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
  });

  it('refuses a delete that is confirmed after the modal was dismissed', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {});
    vi.spyOn(api, 'apiRequest').mockResolvedValue(PTO_DETAIL);
    renderModal({ onClose: vi.fn(), onDelete });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await screen.findByRole('button', { name: /yes, delete/i });
    // The session is over, so the pending confirmation no longer deletes anything.
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('does not report a delete failure after the modal was dismissed', async () => {
    const user = userEvent.setup();
    const failure = deferred<void>();
    const onDelete = vi.fn(() => failure.promise);
    vi.spyOn(api, 'apiRequest').mockResolvedValue(PTO_DETAIL);
    renderModal({ onClose: vi.fn(), onDelete });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /yes, delete/i }));
    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    await act(async () => {
      failure.reject(new Error('Cannot delete'));
      await failure.promise.catch(() => undefined);
    });
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a fallback message when the delete fails without an Error', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {
      throw 'server exploded';
    });
    vi.spyOn(api, 'apiRequest').mockResolvedValue(PTO_DETAIL);
    renderModal({ onDelete });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /yes, delete/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete PTO.');
  });

  it('cancels the delete confirmation without deleting anything', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {});
    vi.spyOn(api, 'apiRequest').mockResolvedValue(PTO_DETAIL);
    renderModal({ onDelete });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
