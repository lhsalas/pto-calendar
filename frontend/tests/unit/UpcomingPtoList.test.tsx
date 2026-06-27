import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpcomingPtoList } from '../../src/components/pto/UpcomingPtoList';
import type { PTOWithUser, User } from '../../src/types/api';

const LEAD: User = {
  id: 'lead-1',
  name: 'Team Lead',
  email: 'lead@example.com',
  role: 'team_lead',
  colorCode: '#3B82F6',
};

const MEMBER: User = {
  id: 'member-1',
  name: 'Dev One',
  email: 'dev1@example.com',
  role: 'member',
  colorCode: '#10B981',
};

function makePto(overrides: Partial<PTOWithUser> = {}): PTOWithUser {
  return {
    id: 'pto-1',
    startDate: '2026-06-10',
    endDate: '2026-06-10',
    dayPart: 'morning',
    note: null,
    user: { id: LEAD.id, name: LEAD.name, colorCode: LEAD.colorCode },
    ...overrides,
  };
}

describe('UpcomingPtoList', () => {
  it('shows the empty state when no PTOs are provided', () => {
    render(
      <UpcomingPtoList
        ptoList={[]}
        currentUser={LEAD}
        onRowClick={() => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );
    expect(screen.getByTestId('upcoming-empty')).toHaveTextContent(/no ptos in the next 3 months/i);
  });

  it('renders a single month group with one row', () => {
    render(
      <UpcomingPtoList
        ptoList={[makePto()]}
        currentUser={LEAD}
        onRowClick={() => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );
    expect(screen.getByTestId('upcoming-list')).toBeInTheDocument();
    expect(screen.getByTestId('upcoming-group-2026-06')).toBeInTheDocument();
    expect(screen.getByTestId('upcoming-row-pto-1')).toBeInTheDocument();
  });

  it('groups PTOs by month and sorts them ascending', () => {
    render(
      <UpcomingPtoList
        ptoList={[
          makePto({ id: 'p2', startDate: '2026-08-15', endDate: '2026-08-15' }),
          makePto({ id: 'p1', startDate: '2026-06-10', endDate: '2026-06-10' }),
          makePto({ id: 'p3', startDate: '2026-06-20', endDate: '2026-06-20' }),
        ]}
        currentUser={LEAD}
        onRowClick={() => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );
    const groups = screen.getAllByTestId(/^upcoming-group-/);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute('data-testid', 'upcoming-group-2026-06');
    expect(groups[1]).toHaveAttribute('data-testid', 'upcoming-group-2026-08');
    const juneGroup = screen.getByTestId('upcoming-group-2026-06');
    const juneRows = juneGroup.querySelectorAll('[data-testid^="upcoming-row-"]');
    expect(juneRows).toHaveLength(2);
    expect(juneRows[0]).toHaveAttribute('data-testid', 'upcoming-row-p1');
    expect(juneRows[1]).toHaveAttribute('data-testid', 'upcoming-row-p3');
  });

  it('invokes onRowClick when the row body is clicked', async () => {
    const onRowClick = vi.fn();
    render(
      <UpcomingPtoList
        ptoList={[makePto()]}
        currentUser={LEAD}
        onRowClick={onRowClick}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );
    const row = screen.getByTestId('upcoming-row-pto-1');
    await userEvent.setup().click(row.querySelector('button')!);
    expect(onRowClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'pto-1' }));
  });

  it('shows Edit and Delete for the owner of a PTO', () => {
    const memberPto = makePto({
      user: { id: MEMBER.id, name: MEMBER.name, colorCode: MEMBER.colorCode },
    });
    render(
      <UpcomingPtoList
        ptoList={[memberPto]}
        currentUser={MEMBER}
        onRowClick={() => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('hides Edit and Delete when the viewer is not the owner and not a team lead', () => {
    const otherMember: User = { ...MEMBER, id: 'member-2' };
    render(
      <UpcomingPtoList
        ptoList={[makePto()]}
        currentUser={otherMember}
        onRowClick={() => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('shows Edit and Delete for a team lead viewing a member PTO', () => {
    const memberPto = makePto({
      user: { id: MEMBER.id, name: MEMBER.name, colorCode: MEMBER.colorCode },
    });
    render(
      <UpcomingPtoList
        ptoList={[memberPto]}
        currentUser={LEAD}
        onRowClick={() => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('invokes onEdit and onDelete when their buttons are clicked', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn(async () => {});
    render(
      <UpcomingPtoList
        ptoList={[makePto()]}
        currentUser={LEAD}
        onRowClick={() => {}}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'pto-1' }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'pto-1' }));
  });
});
