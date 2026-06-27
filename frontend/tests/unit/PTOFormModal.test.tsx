import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { PTOFormModal } from '../../src/components/pto/PTOFormModal';
import { STUB_PTO } from '../mocks/handlers';

interface RenderArgs {
  onSubmit?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  open?: boolean;
  initialPto?: typeof STUB_PTO;
}

function renderModal({
  onSubmit = vi.fn(),
  onClose = vi.fn(),
  open = true,
  initialPto,
}: RenderArgs = {}): void {
  render(
    <PTOFormModal
      open={open}
      onSubmit={onSubmit}
      onClose={onClose}
      {...(initialPto ? { initialPto } : {})}
    />,
  );
}

async function setDate(
  label: RegExp,
  value: string,
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  await user.clear(input);
  await user.type(input, value);
}

describe('PTOFormModal', () => {
  it('renders nothing when closed', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the form when open with default dates and day part selector visible for single day', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/add pto/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/start date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/end date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/day part/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save pto/i })).toBeInTheDocument();
  });

  it('hides the day-part selector for multi-day ranges', async () => {
    const user = userEvent.setup();
    renderModal();
    await setDate(/start date/i, '2026-05-11', user);
    await setDate(/end date/i, '2026-05-15', user);
    expect(screen.queryByLabelText(/day part/i)).not.toBeInTheDocument();
  });

  it('rejects weekend start with an inline error', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderModal({ onSubmit });
    await setDate(/start date/i, '2026-05-09', user);
    await setDate(/end date/i, '2026-05-11', user);
    await user.click(screen.getByRole('button', { name: /save pto/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /start date cannot fall on a weekend/i,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('auto-syncs the end date to the start date when the start date is changed', async () => {
    const user = userEvent.setup();
    renderModal();
    await setDate(/start date/i, '2026-05-13', user);
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(endInput.value).toBe('2026-05-13');
  });

  it('re-syncs the end date when the start date is changed again', async () => {
    const user = userEvent.setup();
    renderModal();
    await setDate(/start date/i, '2026-05-13', user);
    await setDate(/end date/i, '2026-05-15', user);
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(endInput.value).toBe('2026-05-15');
    await setDate(/start date/i, '2026-05-18', user);
    expect(endInput.value).toBe('2026-05-18');
  });

  it('sets min={startDate} on the end-date input so earlier dates are disabled', () => {
    renderModal();
    const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(endInput.getAttribute('min')).toBe(startInput.value);
  });

  it('does not auto-snap the end date when the modal opens with an initialPto', () => {
    const multiDayPto = {
      ...STUB_PTO,
      startDate: '2026-05-11',
      endDate: '2026-05-15',
    };
    renderModal({ initialPto: multiDayPto });
    const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(startInput.value).toBe('2026-05-11');
    expect(endInput.value).toBe('2026-05-15');
  });

  it('submits a valid single-day PTO with the day-part included', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSubmit });
    await setDate(/start date/i, '2026-05-11', user);
    await setDate(/end date/i, '2026-05-11', user);
    await user.selectOptions(screen.getByLabelText(/day part/i), 'morning');
    await user.click(screen.getByRole('button', { name: /save pto/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'morning',
      });
    });
  });

  it('omits dayPart from the payload for multi-day ranges', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSubmit });
    await setDate(/start date/i, '2026-05-11', user);
    await setDate(/end date/i, '2026-05-15', user);
    await user.click(screen.getByRole('button', { name: /save pto/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        startDate: '2026-05-11',
        endDate: '2026-05-15',
      });
    });
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty('dayPart');
  });

  it('includes the note when present', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderModal({ onSubmit });
    await setDate(/start date/i, '2026-05-11', user);
    await setDate(/end date/i, '2026-05-11', user);
    await user.type(screen.getByLabelText(/note/i), 'Doctor appointment');
    await user.click(screen.getByRole('button', { name: /save pto/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        startDate: '2026-05-11',
        endDate: '2026-05-11',
        dayPart: 'all_day',
        note: 'Doctor appointment',
      });
    });
  });

  it('surfaces server errors via the alert', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/pto', () =>
        HttpResponse.json(
          {
            error: {
              code: 'CONFLICT',
              message: 'This PTO overlaps an existing PTO entry for the same user.',
            },
          },
          { status: 409 },
        ),
      ),
    );

    const onSubmit = vi.fn(async () => {
      const res = await fetch('/pto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          startDate: '2026-05-11',
          endDate: '2026-05-11',
          dayPart: 'morning',
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error: { message: string } };
        throw new Error(body.error.message);
      }
    });

    renderModal({ onSubmit });
    await setDate(/start date/i, '2026-05-11', user);
    await setDate(/end date/i, '2026-05-11', user);
    await user.click(screen.getByRole('button', { name: /save pto/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/overlaps an existing pto/i);
  });

  it('calls onClose when the Cancel button is clicked', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal({ onClose });
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the "Edit PTO" title and prefills fields when initialPto is provided', async () => {
    renderModal({ initialPto: STUB_PTO });
    expect(screen.getByText(/edit pto/i)).toBeInTheDocument();
    const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(startInput.value).toBe(STUB_PTO.startDate);
    expect(endInput.value).toBe(STUB_PTO.endDate);
  });

  it('rejects weekend endDate when startDate is a weekday', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderModal({ onSubmit });
    await setDate(/start date/i, '2026-05-11', user);
    await setDate(/end date/i, '2026-05-16', user);
    await user.click(screen.getByRole('button', { name: /save pto/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /end date cannot fall on a weekend/i,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
