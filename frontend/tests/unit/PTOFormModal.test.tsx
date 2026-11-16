import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { PTOFormModal } from '../../src/components/pto/PTOFormModal';
import { STUB_PTO } from '../mocks/handlers';
import type { CreatePTORequest } from '../../src/types/api';

type SubmitSpy = (payload: CreatePTORequest) => Promise<void> | void;
type CloseSpy = () => void;

interface RenderArgs {
  onSubmit?: SubmitSpy;
  onClose?: CloseSpy;
  open?: boolean;
  initialPto?: typeof STUB_PTO;
  initialNoteLoaded?: boolean;
  defaultStartDate?: string;
}

function renderModal({
  onSubmit = vi.fn<SubmitSpy>(),
  onClose = vi.fn<CloseSpy>(),
  open = true,
  initialPto,
  initialNoteLoaded = initialPto !== undefined,
  defaultStartDate,
}: RenderArgs = {}): void {
  render(
    <PTOFormModal
      open={open}
      onSubmit={onSubmit}
      onClose={onClose}
      initialNoteLoaded={initialNoteLoaded}
      {...(initialPto ? { initialPto } : {})}
      {...(defaultStartDate ? { defaultStartDate } : {})}
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
  it('resets edits on reopen and when the edit source changes', () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const first = { ...STUB_PTO, note: 'first note' };
    const second = { ...STUB_PTO, id: 'other', note: 'second note' };
    const { rerender } = render(
      <PTOFormModal
        open
        initialPto={first}
        initialNoteLoaded
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/note \(optional\)/i), { target: { value: 'draft' } });
    rerender(
      <PTOFormModal
        open={false}
        initialPto={first}
        initialNoteLoaded
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    rerender(
      <PTOFormModal
        open
        initialPto={first}
        initialNoteLoaded
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue('first note');
    fireEvent.change(screen.getByLabelText(/note \(optional\)/i), {
      target: { value: 'new draft' },
    });
    rerender(
      <PTOFormModal
        open
        initialPto={second}
        initialNoteLoaded
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByLabelText(/note \(optional\)/i)).toHaveValue('second note');
  });

  it.each(['programmatic', 'keyboard'])(
    'rejects an unknown/redacted edit source on %s submit',
    async (action) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const onClose = vi.fn();
      renderModal({ initialPto: STUB_PTO, initialNoteLoaded: false, onSubmit, onClose });
      expect(screen.getByLabelText(/note \(optional\)/i)).toBeDisabled();
      expect(screen.getByRole('button', { name: /save pto/i })).toBeDisabled();
      if (action === 'programmatic')
        fireEvent.submit(screen.getByRole('button', { name: /save pto/i }).closest('form')!);
      else {
        screen.getByRole('button', { name: /save pto/i }).focus();
        await user.keyboard('{Enter}');
      }
      expect(onSubmit).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onClose).toHaveBeenCalled();
    },
  );
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

  it.each(['day part', 'dates'])(
    'preserves the loaded note in a %s-only edit payload',
    async (field) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      renderModal({ initialPto: { ...STUB_PTO, note: 'Doctor' }, onSubmit });
      expect(screen.getByLabelText(/note/i)).toHaveValue('Doctor');
      if (field === 'day part')
        await user.selectOptions(screen.getByLabelText(/day part/i), 'evening');
      else await setDate(/start date/i, '2026-05-12', user);
      await user.click(screen.getByRole('button', { name: /save pto/i }));
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        startDate: field === 'dates' ? '2026-05-12' : STUB_PTO.startDate,
        endDate: field === 'dates' ? '2026-05-12' : STUB_PTO.endDate,
        dayPart: field === 'day part' ? 'evening' : STUB_PTO.dayPart,
        note: 'Doctor',
      });
    },
  );

  it.each([null, 'Doctor'])(
    'always sends an explicit empty note on update after initial note %s',
    async (initialNote) => {
      const user = userEvent.setup();
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      renderModal({ initialPto: { ...STUB_PTO, note: initialNote }, onSubmit });
      await user.clear(screen.getByLabelText(/note/i));
      await user.click(screen.getByRole('button', { name: /save pto/i }));
      expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
        startDate: STUB_PTO.startDate,
        endDate: STUB_PTO.endDate,
        dayPart: STUB_PTO.dayPart,
        note: '',
      });
    },
  );

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
      const { apiRequest } = await import('../../src/api/client');
      try {
        await apiRequest('/pto', {
          method: 'POST',
          body: {
            startDate: '2026-05-11',
            endDate: '2026-05-11',
            dayPart: 'morning',
          },
        });
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
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

  it('has a visible focus ring on the primary Save button', () => {
    renderModal();
    const save = screen.getByRole('button', { name: /save pto/i });
    expect(save.className).toMatch(/focus-visible:ring-2/);
    expect(save.className).toMatch(/focus-visible:ring-accent-500/);
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

  it('prefills start and end dates from defaultStartDate when no initialPto is provided', () => {
    renderModal({ defaultStartDate: '2026-09-01' });
    const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(startInput.value).toBe('2026-09-01');
    expect(endInput.value).toBe('2026-09-01');
  });

  it('ignores defaultStartDate when initialPto is provided', () => {
    renderModal({
      defaultStartDate: '2026-09-01',
      initialPto: { ...STUB_PTO, startDate: '2026-05-11', endDate: '2026-05-15' },
    });
    const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(startInput.value).toBe('2026-05-11');
    expect(endInput.value).toBe('2026-05-15');
  });

  it('renders the date inputs with color-scheme:dark in dark mode so the picker indicator is visible', () => {
    document.documentElement.classList.add('dark');
    renderModal();
    const startInput = screen.getByTestId('pto-form-start-date');
    const endInput = screen.getByTestId('pto-form-end-date');
    expect(startInput.className).toMatch(/\[color-scheme:dark\]/);
    expect(endInput.className).toMatch(/\[color-scheme:dark\]/);
    document.documentElement.classList.remove('dark');
  });

  it('renders the date inputs with color-scheme:light in light mode so the picker indicator stays dark', () => {
    renderModal();
    const startInput = screen.getByTestId('pto-form-start-date');
    const endInput = screen.getByTestId('pto-form-end-date');
    expect(startInput.className).toMatch(/\[color-scheme:light\]/);
    expect(endInput.className).toMatch(/\[color-scheme:light\]/);
  });

  it('resets to the latest defaultStartDate when reopened after the parent updates it', () => {
    const { rerender } = render(
      <PTOFormModal
        open={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
        defaultStartDate="2026-09-01"
      />,
    );
    rerender(
      <PTOFormModal open onSubmit={vi.fn()} onClose={vi.fn()} defaultStartDate="2026-12-15" />,
    );
    const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    expect(startInput.value).toBe('2026-12-15');
    expect(endInput.value).toBe('2026-12-15');
  });
});
