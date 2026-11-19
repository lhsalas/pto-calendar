import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PTOEditModal } from '../../src/components/pto/PTOEditModal';
import { preparePtoForEdit } from '../../src/lib/ptoEdit';
import * as api from '../../src/api/client';
import { STUB_PTO, STUB_PTO_DETAIL, STUB_USER } from '../mocks/handlers';

afterEach(() => vi.restoreAllMocks());
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
describe('PTOEditModal', () => {
  it('keeps keyboard retry focus inside preparation and restores Retry after another failure', async () => {
    const user = userEvent.setup();
    const retry = deferred();
    const request = vi
      .spyOn(api, 'apiRequest')
      .mockRejectedValueOnce(new Error('First failure'))
      .mockReturnValueOnce(retry.promise);
    render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('First failure');
    screen.getByRole('button', { name: /^retry$/i }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('heading', { name: /prepare pto edit/i })).toHaveFocus();
    await act(async () => {
      retry.reject(new Error('Second failure'));
      await retry.promise.catch(() => undefined);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Second failure');
    expect(screen.getByRole('button', { name: /^retry$/i })).toHaveFocus();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not reclaim retry focus after the user moves to Cancel while waiting', async () => {
    const user = userEvent.setup();
    const retry = deferred();
    vi.spyOn(api, 'apiRequest')
      .mockRejectedValueOnce(new Error('First failure'))
      .mockReturnValueOnce(retry.promise);
    render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole('alert');
    screen.getByRole('button', { name: /^retry$/i }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: /prepare pto edit/i })).toHaveFocus();
    await user.tab();
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    expect(cancel).toHaveFocus();
    await act(async () => {
      retry.reject(new Error('Second failure'));
      await retry.promise.catch(() => undefined);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Second failure');
    expect(cancel).toHaveFocus();
  });

  it('does not move focus for an unfocused retry activation', async () => {
    const retry = deferred();
    vi.spyOn(api, 'apiRequest')
      .mockRejectedValueOnce(new Error('First failure'))
      .mockReturnValueOnce(retry.promise);
    render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    await screen.findByRole('alert');
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    expect(cancel).toHaveFocus();
    act(() => screen.getByRole('button', { name: /^retry$/i }).click());
    expect(cancel).toHaveFocus();
    await act(async () => {
      retry.reject(new Error('Second failure'));
      await retry.promise.catch(() => undefined);
    });
    expect(cancel).toHaveFocus();
  });

  it('does not restore stale retry focus after a PTO session change', async () => {
    const user = userEvent.setup();
    const retry = deferred();
    const current = deferred();
    vi.spyOn(api, 'apiRequest')
      .mockRejectedValueOnce(new Error('First failure'))
      .mockReturnValueOnce(retry.promise)
      .mockReturnValueOnce(current.promise);
    const props = { currentUser: STUB_USER, onSubmit: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<PTOEditModal {...props} pto={STUB_PTO} />);
    await screen.findByRole('alert');
    screen.getByRole('button', { name: /^retry$/i }).focus();
    await user.keyboard('{Enter}');
    rerender(<PTOEditModal {...props} pto={{ ...STUB_PTO, id: 'new-session' }} />);
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    expect(cancel).toHaveFocus();
    await act(async () => {
      retry.reject(new Error('Stale failure'));
      await retry.promise.catch(() => undefined);
    });
    expect(cancel).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () =>
      current.resolve({ ...STUB_PTO_DETAIL, id: 'new-session', note: 'Current note' }),
    );
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue('Current note');
  });

  it('does not open a form after pending preparation is unmounted', async () => {
    const response = deferred();
    vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
    const { unmount } = render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    unmount();
    await act(async () => response.resolve({ ...STUB_PTO_DETAIL, note: 'Late private note' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('rejects a malformed detail note rather than enabling an empty edit', async () => {
    vi.spyOn(api, 'apiRequest').mockResolvedValue({ ...STUB_PTO_DETAIL, note: undefined });
    render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load PTO details.');
    expect(screen.queryByLabelText(/note \(optional\)/i)).not.toBeInTheDocument();
  });
  it.each([
    { version: undefined },
    { version: 0 },
    { version: 1.5 },
    { version: 2_147_483_648 },
    { id: 'different-pto' },
    { userId: 'different-owner' },
    { startDate: 'today' },
    { endDate: null },
    { dayPart: 'night' },
  ])('keeps an inconsistent loaded detail non-editable (%j)', async (invalid) => {
    vi.spyOn(api, 'apiRequest').mockResolvedValue({ ...STUB_PTO_DETAIL, ...invalid });
    render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load PTO details.');
    expect(screen.queryByRole('button', { name: /save pto/i })).not.toBeInTheDocument();
  });
  it('keeps failed preparation non-editable and retries the authorized detail load', async () => {
    const user = userEvent.setup();
    const request = vi
      .spyOn(api, 'apiRequest')
      .mockRejectedValueOnce(new Error('Private detail unavailable'))
      .mockResolvedValueOnce({ ...STUB_PTO_DETAIL, note: 'Doctor' });
    render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Private detail unavailable');
    expect(screen.queryByLabelText(/note \(optional\)/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save pto/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByLabelText(/note \(optional\)/i)).toHaveValue('Doctor');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([null, 'Doctor'])('reuses a prepared known note %s for the same viewer', async (note) => {
    const request = vi.spyOn(api, 'apiRequest');
    render(
      <PTOEditModal
        pto={preparePtoForEdit(STUB_PTO, STUB_USER, { ...STUB_PTO_DETAIL, note })}
        currentUser={STUB_USER}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue(note ?? '');
    expect(request).not.toHaveBeenCalled();
  });
  it('deduplicates StrictMode preparation', async () => {
    const response = deferred();
    const request = vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
    render(
      <StrictMode>
        <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />
      </StrictMode>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => response.resolve({ ...STUB_PTO_DETAIL, note: 'Doctor' }));
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue('Doctor');
  });
  it('ignores the old PTO response after selection changes', async () => {
    const response = deferred();
    vi.spyOn(api, 'apiRequest')
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ ...STUB_PTO_DETAIL, id: 'other-pto', note: 'Current note' });
    const props = { currentUser: STUB_USER, onSubmit: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<PTOEditModal {...props} pto={STUB_PTO} />);
    rerender(<PTOEditModal {...props} pto={{ ...STUB_PTO, id: 'other-pto' }} />);
    expect(await screen.findByLabelText(/note \(optional\)/i)).toHaveValue('Current note');
    await act(async () => response.resolve({ ...STUB_PTO_DETAIL, note: 'Stale private note' }));
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue('Current note');
  });
  it('discards a prior viewer request and never fetches or edits without permission', async () => {
    const response = deferred();
    const request = vi.spyOn(api, 'apiRequest').mockReturnValueOnce(response.promise);
    const props = { pto: STUB_PTO, onSubmit: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<PTOEditModal {...props} currentUser={STUB_USER} />);
    rerender(
      <PTOEditModal
        {...props}
        currentUser={{ ...STUB_USER, id: 'other-member', role: 'member' }}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot edit this PTO.');
    await act(async () => response.resolve({ ...STUB_PTO_DETAIL, note: 'Stale private note' }));
    expect(screen.queryByLabelText(/note \(optional\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Stale private note')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not reuse prepared data from a different authorized viewer', async () => {
    const request = vi
      .spyOn(api, 'apiRequest')
      .mockResolvedValue({ ...STUB_PTO_DETAIL, note: 'Fresh detail' });
    render(
      <PTOEditModal
        pto={preparePtoForEdit(STUB_PTO, STUB_USER, { ...STUB_PTO_DETAIL, note: 'Old detail' })}
        currentUser={{ ...STUB_USER, id: 'new-lead' }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByLabelText(/note \(optional\)/i)).toHaveValue('Fresh detail');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
