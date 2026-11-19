import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ToastProvider } from '../../src/context/ToastProvider';
import { ToastViewport } from '../../src/components/common/ToastViewport';
import { CalendarPage } from '../../src/pages/CalendarPage';
import { RequireAuth } from '../../src/routes/RequireAuth';
import { LoginPage } from '../../src/pages/LoginPage';
import { AdminUsersPage } from '../../src/pages/admin/AdminUsersPage';
import { server } from '../mocks/server';
import type { PTOWithUser, User } from '../../src/types/api';
import { STUB_PTO, STUB_PTO_DETAIL, STUB_USER } from '../mocks/handlers';
import { authenticated } from '../mocks/handlers';

function detailFor(pto: PTOWithUser) {
  return { ...STUB_PTO_DETAIL, ...pto, userId: pto.user.id };
}

function firstWeekdayInCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(year, month, 2)).toISOString().slice(0, 10);
}

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/calendar']}>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/calendar"
                element={
                  <RequireAuth>
                    <CalendarPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/users"
                element={
                  <RequireAuth>
                    <AdminUsersPage />
                  </RequireAuth>
                }
              />
              <Route path="/login" element={<LoginPage />} />
            </Routes>
            <ToastViewport />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

// Keep calendar readiness independent of the user header without a timed delay.
function holdCalendarResponse(): { requested: Promise<void>; release: () => void } {
  let signalRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    signalRequested = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get('/pto', async () => {
      signalRequested();
      await released;
      return HttpResponse.json([]);
    }),
  );
  return { requested, release };
}

describe('CalendarPage', () => {
  it('keeps failed direct-list preparation non-editable and retries without a blank fallback', async () => {
    const user = userEvent.setup();
    const localPto = { ...STUB_PTO, startDate: '2026-06-15', endDate: '2026-06-15' };
    const detail = vi
      .fn()
      .mockImplementationOnce(() =>
        HttpResponse.json(
          { error: { code: 'UNAVAILABLE', message: 'Private detail unavailable' } },
          { status: 503 },
        ),
      )
      .mockImplementationOnce(() => HttpResponse.json({ ...detailFor(localPto), note: 'Doctor' }));
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', detail),
    );
    renderPage();
    await user.click(await screen.findByRole('radio', { name: /show upcoming pto list/i }));
    const row = await screen.findByTestId(`upcoming-row-${localPto.id}`);
    await user.click(within(row).getByRole('button', { name: /^edit$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Private detail unavailable');
    expect(screen.queryByLabelText(/note \(optional\)/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save pto/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^retry$/i }));
    expect(await screen.findByLabelText(/note \(optional\)/i)).toHaveValue('Doctor');
    expect(detail).toHaveBeenCalledTimes(2);
  });
  it.each(['day part', 'dates'])(
    'prepares a direct list edit and preserves the stored note in a %s-only PUT',
    async (field) => {
      const user = userEvent.setup();
      const localPto = { ...STUB_PTO, startDate: '2026-06-15', endDate: '2026-06-15' };
      const detail = vi.fn(() => HttpResponse.json({ ...detailFor(localPto), note: 'Doctor' }));
      let storedNote: string | null = 'Doctor';
      let expectedVersion: string | null = null;
      const put = vi.fn(async ({ request }: { request: Request }) => {
        expectedVersion = request.headers.get('If-Match');
        const payload = (await request.json()) as { note?: string };
        storedNote = payload.note || null;
        return HttpResponse.json({ ...detailFor(localPto), note: storedNote, version: 8 });
      });
      server.use(
        http.get('/pto', () => HttpResponse.json([localPto])),
        http.get('/pto/:id', detail),
        http.put('/pto/:id', put),
      );
      renderPage();
      await user.click(await screen.findByRole('radio', { name: /show upcoming pto list/i }));
      const row = await screen.findByTestId(`upcoming-row-${localPto.id}`);
      await user.click(within(row).getByRole('button', { name: /^edit$/i }));
      expect(await screen.findByLabelText(/note \(optional\)/i)).toHaveValue('Doctor');
      expect(detail).toHaveBeenCalledTimes(1);
      if (field === 'day part')
        await user.selectOptions(screen.getByLabelText(/day part/i), 'evening');
      else {
        const start = screen.getByLabelText(/start date/i);
        await user.clear(start);
        await user.type(start, '2026-06-16');
      }
      await user.click(screen.getByRole('button', { name: /save pto/i }));
      await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
      expect(storedNote).toBe('Doctor');
      expect(expectedVersion).toBe('"7"');
    },
  );

  beforeEach(() => {
    server.use(authenticated);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-14T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the Manage users link for team_lead', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-users-link')).toBeInTheDocument();
    });
    const link = screen.getByTestId('manage-users-link');
    expect(link).toHaveAttribute('href', '/admin/users');
  });

  it('hides the Manage users link for member', async () => {
    const member: User = { ...STUB_USER, role: 'member' };
    server.use(http.get('/auth/me', () => HttpResponse.json(member)));
    server.use(http.get('/pto', () => HttpResponse.json([])));
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /calendar/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('manage-users-link')).not.toBeInTheDocument();
  });

  it('navigates to /admin/users when Manage users is clicked', async () => {
    server.use(
      http.get('/pto', () => HttpResponse.json([])),
      http.get('/users', () => HttpResponse.json([STUB_USER])),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('manage-users-link')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('manage-users-link'));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /manage users/i })).toBeInTheDocument();
    });
  });

  it('shows the signed-in user and an empty grid when no PTOs are returned', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: /calendar/i })).toBeInTheDocument();
    expect(screen.getByTestId('range-label')).toHaveTextContent(/2026/i);
    expect(screen.getByRole('button', { name: /add pto/i })).toBeInTheDocument();
    const dayCells = await screen.findAllByTestId(/^day-cell-/, {}, { timeout: 2000 });
    expect(dayCells).toHaveLength(42);
  });

  it('renders the theme toggle in the header', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('theme-toggle')).toBeInTheDocument();
  });

  it('renders PTO chips on the days they cover', async () => {
    const today = firstWeekdayInCurrentMonth();
    server.use(
      http.get('/pto', () =>
        HttpResponse.json([{ ...STUB_PTO, startDate: today, endDate: today }]),
      ),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
    });
    const cell = screen.getByTestId(`day-cell-${today}`);
    expect(cell).toHaveTextContent(/team lead/i);
  });

  it('moves to the next month when the next button is clicked', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await waitFor(() => {
      expect(screen.getByTestId('header-label')).toHaveTextContent(/july 2026/i);
    });
  });

  it('loads matching PTO and holiday ranges before and after month navigation', async () => {
    const ranges: Record<string, Array<{ start: string | null; end: string | null }>> = {
      '/pto': [],
      '/holidays': [],
    };
    const recordRange = ({ request }: { request: Request }): void => {
      const url = new URL(request.url);
      ranges[url.pathname]?.push({
        start: url.searchParams.get('start'),
        end: url.searchParams.get('end'),
      });
    };
    server.events.on('request:match', recordRange);

    try {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(ranges['/pto']).toEqual([{ start: '2026-06-01', end: '2026-07-12' }]);
        expect(ranges['/holidays']).toEqual([{ start: '2026-06-01', end: '2026-07-12' }]);
        expect(screen.getAllByTestId(/^day-cell-/)).toHaveLength(42);
      });

      await user.click(screen.getByRole('button', { name: /^next$/i }));
      await waitFor(() => {
        const expectedRanges = [
          { start: '2026-06-01', end: '2026-07-12' },
          { start: '2026-06-29', end: '2026-08-09' },
        ];
        expect(ranges['/pto']).toEqual(expectedRanges);
        expect(ranges['/holidays']).toEqual(expectedRanges);
        expect(screen.getAllByTestId(/^day-cell-/)).toHaveLength(42);
        expect(screen.getByTestId('header-label')).toHaveTextContent('July 2026');
      });
    } finally {
      server.events.removeListener('request:match', recordRange);
    }
  });

  it('returns to the current month when the Today button is clicked from another month', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await waitFor(() => {
      expect(screen.getByTestId('header-label')).toHaveTextContent(/august 2026/i);
    });
    await user.click(screen.getByTestId('today-button'));
    await waitFor(() => {
      expect(screen.getByTestId('header-label')).toHaveTextContent(/june 2026/i);
    });
    expect(screen.getByTestId('today-button')).toBeDisabled();
  });

  it('switches to the list view and shows the default 90-day window', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('view-option-list'));
    await waitFor(() => {
      expect(screen.getByTestId('view-toggle')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /show upcoming pto list/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
    expect(screen.getByTestId('upcoming-empty')).toHaveTextContent(/no ptos in the next 3 months/i);
  });

  it('shifts the 3-month list window forward when Next is clicked', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('view-option-list'));
    const initialLabel = screen.getByTestId('header-label').textContent ?? '';
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    const shiftedLabel = screen.getByTestId('header-label').textContent ?? '';
    expect(shiftedLabel).not.toBe(initialLabel);
  });

  it('returns to the default list window when Today is clicked after a shift', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('view-option-list'));
    const initialLabel = screen.getByTestId('header-label').textContent ?? '';
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(screen.getByTestId('today-button'));
    expect(screen.getByTestId('header-label').textContent).toBe(initialLabel);
    expect(screen.getByTestId('today-button')).toBeDisabled();
  });

  it('renders PTO rows in the list view, grouped by month', async () => {
    const today = firstWeekdayInCurrentMonth();
    const later = new Date(today);
    later.setUTCDate(later.getUTCDate() + 14);
    const laterIso = later.toISOString().slice(0, 10);
    server.use(
      http.get('/pto', () =>
        HttpResponse.json([
          { ...STUB_PTO, startDate: today, endDate: today },
          { ...STUB_PTO, id: 'pto-2', startDate: laterIso, endDate: laterIso },
        ]),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('view-option-list'));
    await waitFor(() => {
      expect(screen.getByTestId('upcoming-list')).toBeInTheDocument();
    });
    const rows = screen.getAllByTestId(/^upcoming-row-/);
    expect(rows).toHaveLength(2);
  });

  it('opens the view modal when a list row is clicked', async () => {
    const today = firstWeekdayInCurrentMonth();
    const localPto = { ...STUB_PTO, startDate: today, endDate: today };
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', () =>
        HttpResponse.json({
          id: localPto.id,
          userId: localPto.user.id,
          startDate: localPto.startDate,
          endDate: localPto.endDate,
          dayPart: localPto.dayPart,
          note: 'Doctor',
          user: localPto.user,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
          version: 7,
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('view-option-list'));
    await waitFor(() => {
      expect(screen.getByTestId('upcoming-list')).toBeInTheDocument();
    });
    const row = screen.getByTestId(`upcoming-row-${localPto.id}`);
    await user.click(row.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText(/pto details/i)).toBeInTheDocument();
    });
  });

  it('switches back to the grid view and preserves the grid state', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await waitFor(() => {
      expect(screen.getByTestId('header-label')).toHaveTextContent(/july 2026/i);
    });
    await user.click(screen.getByTestId('view-option-list'));
    await user.click(screen.getByTestId('view-option-grid'));
    expect(screen.getByTestId('header-label')).toHaveTextContent(/july 2026/i);
  });

  it('opens the PTOViewModal when a chip is clicked and the user is the owner', async () => {
    const today = firstWeekdayInCurrentMonth();
    const localPto = { ...STUB_PTO, startDate: today, endDate: today };
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', () =>
        HttpResponse.json({
          id: localPto.id,
          userId: localPto.user.id,
          startDate: localPto.startDate,
          endDate: localPto.endDate,
          dayPart: localPto.dayPart,
          note: 'Doctor',
          user: localPto.user,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
          version: 7,
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /team lead/i }));
    await waitFor(() => {
      expect(screen.getByText(/pto details/i)).toBeInTheDocument();
    });
  });

  it('surfaces the error toast with a Retry action when the list fetch fails', async () => {
    server.use(
      http.get('/pto', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL_ERROR', message: 'server down' } },
          { status: 500 },
        ),
      ),
    );
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load pto/i);
    expect(screen.getByTestId('toast-action')).toBeInTheDocument();
  });

  it('logs the user out when Sign out is clicked', async () => {
    server.use(
      http.get('/pto', () => HttpResponse.json([])),
      http.post('/auth/logout', () => new HttpResponse(null, { status: 204 })),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /pto calendar/i })).toBeInTheDocument();
    });
  });

  it('opens the edit form with the authorized detail note when Edit is clicked', async () => {
    const today = firstWeekdayInCurrentMonth();
    const localPto = { ...STUB_PTO, startDate: today, endDate: today };
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', () =>
        HttpResponse.json({
          id: localPto.id,
          userId: localPto.user.id,
          startDate: localPto.startDate,
          endDate: localPto.endDate,
          dayPart: localPto.dayPart,
          note: 'Doctor',
          user: localPto.user,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
          version: 7,
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /team lead/i }));
    await waitFor(() => {
      expect(screen.getByText(/pto details/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    await waitFor(() => {
      expect(screen.getByText(/edit pto/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/note/i)).toHaveValue('Doctor');
  });

  it('deletes a PTO and shows the success toast', async () => {
    const today = firstWeekdayInCurrentMonth();
    const localPto = { ...STUB_PTO, startDate: today, endDate: today };
    const remove = vi.fn(({ request }: { request: Request }) => {
      expect(request.headers.get('If-Match')).toBe('"7"');
      return new HttpResponse(null, { status: 204 });
    });
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', () => HttpResponse.json(detailFor(localPto))),
      http.delete('/pto/:id', remove),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /team lead/i }));
    await waitFor(() => {
      expect(screen.getByText(/pto details/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const confirm = await screen.findByRole('button', { name: /yes, delete/i });
    expect(remove).not.toHaveBeenCalled();
    await user.click(confirm);
    const toast = await screen.findByTestId('toast-success');
    expect(toast).toHaveTextContent(/pto deleted/i);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does not send a DELETE from the list or an incomplete loaded detail', async () => {
    const localPto = { ...STUB_PTO, startDate: '2026-06-15', endDate: '2026-06-15' };
    const remove = vi.fn(() => new HttpResponse(null, { status: 204 }));
    const detail = vi.fn(() => HttpResponse.json({ ...detailFor(localPto), version: undefined }));
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', detail),
      http.delete('/pto/:id', remove),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('radio', { name: /show upcoming pto list/i }));
    const row = await screen.findByTestId(`upcoming-row-${localPto.id}`);
    await user.click(within(row).getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog', { name: /pto details/i });
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Could not load PTO details.',
    );
    expect(within(dialog).queryByRole('button', { name: /yes, delete/i })).not.toBeInTheDocument();
    expect(detail).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([412, 428])(
    'locks a refused edit (%d) until the user reopens the current detail',
    async (status) => {
      const localPto = { ...STUB_PTO, startDate: '2026-06-15', endDate: '2026-06-15' };
      const current = {
        ...detailFor(localPto),
        startDate: '2026-06-16',
        endDate: '2026-06-16',
        note: 'Reviewed note',
      };
      let version = 7;
      const put = vi.fn(async ({ request }: { request: Request }) => {
        const header = request.headers.get('If-Match');
        const payload = await request.json();
        expect(payload).toMatchObject({
          startDate: current.startDate,
          endDate: current.endDate,
          note: 'Reviewed note',
        });
        if (header === '"7"') {
          version += 1;
          return HttpResponse.json(
            {
              error: {
                code: status === 412 ? 'STALE_WRITE' : 'PRECONDITION_REQUIRED',
                message: 'Refused',
              },
            },
            { status },
          );
        }
        expect(header).toBe('"8"');
        return HttpResponse.json({ ...current, version: 9 });
      });
      server.use(
        http.get('/pto', () => HttpResponse.json([localPto])),
        http.get('/pto/:id', () => HttpResponse.json({ ...current, version })),
        http.put('/pto/:id', put),
      );
      const user = userEvent.setup();
      renderPage();
      await user.click(await screen.findByRole('radio', { name: /show upcoming pto list/i }));
      const row = await screen.findByTestId(`upcoming-row-${localPto.id}`);
      const open = async () => {
        await user.click(within(row).getByRole('button', { name: /^edit$/i }));
        expect(await screen.findByLabelText(/start date/i)).toHaveValue(current.startDate);
        expect(screen.getByLabelText(/end date/i)).toHaveValue(current.endDate);
      };
      await open();
      const save = screen.getByRole('button', { name: /save pto/i });
      await user.click(save);
      expect(await screen.findByTestId('pto-write-conflict')).toHaveTextContent(
        /open the pto again/i,
      );
      expect(save).toBeDisabled();
      await user.click(save);
      expect(put).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      await open();
      await user.click(screen.getByRole('button', { name: /save pto/i }));
      expect(await screen.findByTestId('toast-success')).toHaveTextContent('PTO updated.');
      expect(put).toHaveBeenCalledTimes(2);
    },
  );

  it('refuses a stale deletion and requires a fresh confirmation', async () => {
    const localPto = { ...STUB_PTO, startDate: '2026-06-15', endDate: '2026-06-15' };
    let version = 7;
    const remove = vi.fn(({ request }: { request: Request }) => {
      const header = request.headers.get('If-Match');
      if (header === '"7"') {
        version = 8;
        return HttpResponse.json(
          { error: { code: 'STALE_WRITE', message: 'Refused' } },
          { status: 412 },
        );
      }
      expect(header).toBe('"8"');
      return new HttpResponse(null, { status: 204 });
    });
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', () =>
        HttpResponse.json({ ...detailFor(localPto), version, note: `Revision ${version}` }),
      ),
      http.delete('/pto/:id', remove),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('radio', { name: /show upcoming pto list/i }));
    const row = await screen.findByTestId(`upcoming-row-${localPto.id}`);
    const openConfirmation = async () => {
      await user.click(within(row).getByRole('button', { name: /^delete$/i }));
      const dialog = await screen.findByRole('dialog', { name: /pto details/i });
      await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
      return await within(dialog).findByRole('button', { name: /yes, delete/i });
    };
    await user.click(await openConfirmation());
    expect(await screen.findByTestId('pto-delete-conflict')).toHaveTextContent(
      /open the pto again/i,
    );
    expect(screen.queryByRole('button', { name: /yes, delete/i })).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    const confirm = await openConfirmation();
    expect(screen.getByText('Revision 8')).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
    await user.click(confirm);
    expect(await screen.findByTestId('toast-success')).toHaveTextContent('PTO deleted.');
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it('pushes an error toast with Retry when the list fetch fails, and Retry triggers refetch', async () => {
    let attempt = 0;
    server.use(
      http.get('/pto', () => {
        attempt += 1;
        return HttpResponse.json({ error: { code: 'INTERNAL', message: 'boom' } }, { status: 500 });
      }),
    );
    const user = userEvent.setup();
    renderPage();
    const toast = await screen.findByTestId('toast-error');
    expect(toast).toHaveTextContent(/could not load pto/i);
    const retry = await screen.findByTestId('toast-action');
    await user.click(retry);
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it('defaults the create-modal start date to today when viewing the current month', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^add pto$/i }));
    const startInput = await screen.findByLabelText(/start date/i);
    const today = new Date().toISOString().slice(0, 10);
    expect((startInput as HTMLInputElement).value).toBe(today);
  });

  it('defaults the create-modal start date to the 1st of the viewed future month', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await waitFor(() => {
      expect(screen.getByTestId('header-label')).toHaveTextContent(/july 2026/i);
    });
    await user.click(screen.getByRole('button', { name: /^add pto$/i }));
    const startInput = await screen.findByLabelText(/start date/i);
    expect((startInput as HTMLInputElement).value).toBe('2026-07-01');
  });

  it('keeps the default at today when viewing a past month', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^previous$/i }));
    await user.click(screen.getByRole('button', { name: /^add pto$/i }));
    const startInput = await screen.findByLabelText(/start date/i);
    const today = new Date().toISOString().slice(0, 10);
    expect((startInput as HTMLInputElement).value).toBe(today);
  });

  it('keeps the default at today in list view regardless of the window', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('view-option-list'));
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await user.click(screen.getByRole('button', { name: /^add pto$/i }));
    const startInput = await screen.findByLabelText(/start date/i);
    const today = new Date().toISOString().slice(0, 10);
    expect((startInput as HTMLInputElement).value).toBe(today);
  });

  it('opens the create modal with the clicked weekday as the start date', async () => {
    const calendar = holdCalendarResponse();
    try {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByText(/team lead/i)).toBeInTheDocument();
      });
      await calendar.requested;
      expect(screen.queryByTestId('day-cell-2026-06-15')).not.toBeInTheDocument();
      const cellReady = screen.findByTestId('day-cell-2026-06-15');
      calendar.release();
      const cell = await cellReady;
      await user.click(cell);
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /add pto/i })).toBeVisible();
      });
      const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
      const endInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
      expect(startInput.value).toBe('2026-06-15');
      expect(endInput.value).toBe('2026-06-15');
    } finally {
      calendar.release();
    }
  });

  it('does not open the create modal when a Saturday cell is clicked', async () => {
    const calendar = holdCalendarResponse();
    try {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByText(/team lead/i)).toBeInTheDocument();
      });
      await calendar.requested;
      expect(screen.queryByTestId('day-cell-2026-06-20')).not.toBeInTheDocument();
      expect(screen.queryByTestId('day-cell-2026-06-21')).not.toBeInTheDocument();
      const saturdayReady = screen.findByTestId('day-cell-2026-06-20');
      calendar.release();
      const sat = await saturdayReady;
      const sun = await screen.findByTestId('day-cell-2026-06-21');
      await user.click(sat);
      expect(screen.queryByRole('dialog', { name: /add pto/i })).not.toBeInTheDocument();
      await user.click(sun);
      expect(screen.queryByRole('dialog', { name: /add pto/i })).not.toBeInTheDocument();
    } finally {
      calendar.release();
    }
  });

  it('does not open the create modal when a chip is clicked (stopPropagation)', async () => {
    const today = firstWeekdayInCurrentMonth();
    const localPto = { ...STUB_PTO, startDate: today, endDate: today };
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.get('/pto/:id', () =>
        HttpResponse.json({
          id: localPto.id,
          userId: localPto.user.id,
          startDate: localPto.startDate,
          endDate: localPto.endDate,
          dayPart: localPto.dayPart,
          note: null,
          user: localPto.user,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
        }),
      ),
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /team lead/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /team lead/i }));
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /pto details/i })).toBeVisible();
    });
    expect(screen.queryByRole('dialog', { name: /add pto/i })).not.toBeInTheDocument();
  });

  it('reverts to the default start date after closing a cell-driven modal', async () => {
    const calendar = holdCalendarResponse();
    try {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByText(/team lead/i)).toBeInTheDocument();
      });
      await calendar.requested;
      expect(screen.queryByTestId('day-cell-2026-06-15')).not.toBeInTheDocument();
      const cellReady = screen.findByTestId('day-cell-2026-06-15');
      calendar.release();
      const cell = await cellReady;
      await user.click(cell);
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /add pto/i })).toBeVisible();
      });
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      await user.click(screen.getByRole('button', { name: /^add pto$/i }));
      const today = new Date().toISOString().slice(0, 10);
      const startInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
      expect(startInput.value).toBe(today);
    } finally {
      calendar.release();
    }
  });

  it('shows the loading state while the current user is still being resolved', async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releaseMe!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    server.use(
      http.get('/auth/me', async () => {
        signalEntered();
        await released;
        return HttpResponse.json(STUB_USER);
      }),
    );

    const { unmount } = render(
      <MemoryRouter initialEntries={['/calendar']}>
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <CalendarPage />
              <ToastViewport />
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
    );

    await act(async () => {
      await entered;
    });
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');

    unmount();
    releaseMe();
  });
});
