import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { CalendarPage } from '../../src/pages/CalendarPage';
import { RequireAuth } from '../../src/routes/RequireAuth';
import { LoginPage } from '../../src/pages/LoginPage';
import { server } from '../mocks/server';
import { STUB_PTO } from '../mocks/handlers';
import { authenticated } from '../mocks/handlers';

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
          <Routes>
            <Route
              path="/calendar"
              element={
                <RequireAuth>
                  <CalendarPage />
                </RequireAuth>
              }
            />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('CalendarPage', () => {
  beforeEach(() => {
    server.use(authenticated);
  });

  it('shows the signed-in user and an empty grid when no PTOs are returned', async () => {
    server.use(http.get('/pto', () => HttpResponse.json([])));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/team lead/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: /calendar/i })).toBeInTheDocument();
    expect(screen.getByText(/showing 2026/i)).toBeInTheDocument();
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

  it('surfaces the error message and a retry button when the list fetch fails', async () => {
    server.use(
      http.get('/pto', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL_ERROR', message: 'server down' } },
          { status: 500 },
        ),
      ),
    );
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/server down/i);
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
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

  it('opens the edit form when Edit is clicked in the view modal', async () => {
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
  });

  it('deletes a PTO and shows the success toast', async () => {
    const today = firstWeekdayInCurrentMonth();
    const localPto = { ...STUB_PTO, startDate: today, endDate: today };
    server.use(
      http.get('/pto', () => HttpResponse.json([localPto])),
      http.delete('/pto/:id', () => new HttpResponse(null, { status: 204 })),
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
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));
    await waitFor(() => {
      expect(screen.getByText(/pto deleted/i)).toBeInTheDocument();
    });
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
});
