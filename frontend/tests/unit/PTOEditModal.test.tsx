import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PTOEditModal } from '../../src/components/pto/PTOEditModal';
import { preparePtoForEdit } from '../../src/lib/ptoEdit';
import * as api from '../../src/api/client';
import { STUB_PTO, STUB_USER } from '../mocks/handlers';

afterEach(() => vi.restoreAllMocks());
function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe('PTOEditModal', () => {
  it('does not open a form after pending preparation is unmounted', async () => {
    const response = deferred();
    vi.spyOn(api, 'apiRequest').mockReturnValue(response.promise);
    const { unmount } = render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    unmount();
    await act(async () => response.resolve({ note: 'Late private note' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('rejects a malformed detail note rather than enabling an empty edit', async () => {
    vi.spyOn(api, 'apiRequest').mockResolvedValue({});
    render(
      <PTOEditModal pto={STUB_PTO} currentUser={STUB_USER} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load PTO details.');
    expect(screen.queryByLabelText(/note \(optional\)/i)).not.toBeInTheDocument();
  });
  it('keeps failed preparation non-editable and retries the authorized detail load', async () => {
    const user = userEvent.setup();
    const request = vi
      .spyOn(api, 'apiRequest')
      .mockRejectedValueOnce(new Error('Private detail unavailable'))
      .mockResolvedValueOnce({ note: 'Doctor' });
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
        pto={preparePtoForEdit(STUB_PTO, STUB_USER, note)}
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
    await act(async () => response.resolve({ note: 'Doctor' }));
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue('Doctor');
  });
  it('ignores the old PTO response after selection changes', async () => {
    const response = deferred();
    vi.spyOn(api, 'apiRequest')
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce({ note: 'Current note' });
    const props = { currentUser: STUB_USER, onSubmit: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<PTOEditModal {...props} pto={STUB_PTO} />);
    rerender(<PTOEditModal {...props} pto={{ ...STUB_PTO, id: 'other-pto' }} />);
    expect(await screen.findByLabelText(/note \(optional\)/i)).toHaveValue('Current note');
    await act(async () => response.resolve({ note: 'Stale private note' }));
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
    await act(async () => response.resolve({ note: 'Stale private note' }));
    expect(screen.queryByLabelText(/note \(optional\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Stale private note')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not reuse prepared data from a different authorized viewer', async () => {
    const request = vi.spyOn(api, 'apiRequest').mockResolvedValue({ note: 'Fresh detail' });
    render(
      <PTOEditModal
        pto={preparePtoForEdit(STUB_PTO, STUB_USER, 'Old detail')}
        currentUser={{ ...STUB_USER, id: 'new-lead' }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByLabelText(/note \(optional\)/i)).toHaveValue('Fresh detail');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
