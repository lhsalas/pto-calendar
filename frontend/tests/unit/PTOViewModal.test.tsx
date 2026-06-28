import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { PTOViewModal } from '../../src/components/pto/PTOViewModal';
import { STUB_PTO, STUB_USER } from '../mocks/handlers';
import { formatRangeLabel } from '../../src/lib/calendar';

function renderModal(
  props: Partial<React.ComponentProps<typeof PTOViewModal>> = {},
): ReturnType<typeof render> {
  const onClose = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn(async () => {});
  return render(
    <PTOViewModal
      pto={STUB_PTO}
      currentUser={STUB_USER}
      onClose={onClose}
      onEdit={onEdit}
      onDelete={onDelete}
      {...props}
    />,
  );
}

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

  it('hides Edit and Delete buttons for a member viewing another user PTO', () => {
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
    });
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('shows Edit and Delete buttons for a team lead viewing another user PTO', () => {
    const teamLead = {
      id: 'team-lead-id',
      name: 'Lead',
      role: 'team_lead' as const,
      email: 'lead@example.com',
      colorCode: '#000',
    };
    renderModal({
      pto: { ...STUB_PTO, user: { ...STUB_PTO.user, id: 'not-this-user' } },
      currentUser: teamLead,
    });
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('calls onEdit when Edit is clicked', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    renderModal({ onEdit });
    await user.click(screen.getByRole('button', { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(STUB_PTO);
  });

  it('asks for confirmation before calling onDelete', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {});
    renderModal({ onDelete });
    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(await screen.findByText(/cannot be undone/i)).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));
    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith(STUB_PTO);
    });
  });

  it('surfaces server errors from the delete call', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {
      throw new Error('Cannot delete');
    });
    renderModal({ onDelete });
    await user.click(screen.getByRole('button', { name: /delete/i }));
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot delete/i);
  });

  it('loads the note when the owner clicks "Load note"', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/pto/:id', () =>
        HttpResponse.json({
          id: STUB_PTO.id,
          userId: STUB_USER.id,
          startDate: STUB_PTO.startDate,
          endDate: STUB_PTO.endDate,
          dayPart: 'morning',
          note: 'Private note',
          user: STUB_PTO.user,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
        }),
      ),
    );
    renderModal({ pto: { ...STUB_PTO, note: null } });
    await user.click(screen.getByRole('button', { name: /load note/i }));
    expect(await screen.findByText('Private note')).toBeInTheDocument();
  });

  it('calls onClose when the Close button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
