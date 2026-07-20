import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ToastProvider } from '../../src/context/ToastProvider';
import { AdminHolidaysPage } from '../../src/pages/admin/AdminHolidaysPage';
import { server } from '../mocks/server';
import { authenticated, holidaysListAll, holidaysListEmpty } from '../mocks/handlers';

function renderWithProviders(initialPath: string = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <Routes>
              <Route path="/" element={<AdminHolidaysPage />} />
              <Route path="/calendar" element={<h1>Calendar Page</h1>} />
              <Route path="/admin/users" element={<h1>Users Page</h1>} />
            </Routes>
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AdminHolidaysPage', () => {
  it('renders the page header and a back link', async () => {
    server.use(authenticated, holidaysListAll);
    renderWithProviders();
    expect(await screen.findByRole('heading', { level: 1, name: /holidays/i })).toBeInTheDocument();
    expect(screen.getByTestId('back-link')).toHaveAttribute('href', '/calendar');
  });

  it('lists existing holidays returned by the API', async () => {
    server.use(authenticated, holidaysListAll);
    renderWithProviders();
    expect(await screen.findByText('Independence Day')).toBeInTheDocument();
    expect(screen.getByText('Christmas Day')).toBeInTheDocument();
  });

  it('shows an empty state when the API returns no holidays', async () => {
    server.use(authenticated, holidaysListEmpty);
    renderWithProviders();
    expect(await screen.findByText(/no holidays yet/i)).toBeInTheDocument();
  });

  it('POSTs a new holiday and clears the form on success', async () => {
    let captured: unknown = null;
    server.use(
      authenticated,
      holidaysListEmpty,
      http.post('/holidays', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json(
          { id: 'h-new', date: '2026-11-11', name: 'Veterans Day', countryCode: 'US' },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders();
    const dateInput = await screen.findByTestId('add-holiday-date');
    const nameInput = screen.getByTestId('add-holiday-name');
    const countrySelect = screen.getByTestId('add-holiday-country');
    await user.type(dateInput, '2026-11-11');
    await user.type(nameInput, 'Veterans Day');
    await user.selectOptions(countrySelect, 'US');
    await user.click(screen.getByTestId('add-holiday-submit'));
    await waitFor(() => {
      expect(captured).toEqual({ date: '2026-11-11', name: 'Veterans Day', countryCode: 'US' });
    });
  });

  it('renders seed-default buttons for each supported country', async () => {
    server.use(authenticated, holidaysListEmpty);
    renderWithProviders();
    expect(await screen.findByTestId('seed-US')).toBeInTheDocument();
    expect(screen.getByTestId('seed-MX')).toBeInTheDocument();
  });

  it('DELETEs a holiday when its Remove button is clicked', async () => {
    let deleted: string | null = null;
    server.use(
      authenticated,
      holidaysListAll,
      http.delete('/holidays/:id', ({ params }) => {
        deleted = String(params['id']);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders();
    const removeBtn = await screen.findByTestId('holiday-delete-h-1');
    await user.click(removeBtn);
    await waitFor(() => {
      expect(deleted).toBe('h-1');
    });
  });

  it('POSTs to /holidays/seed when the US button is clicked', async () => {
    let seeded: unknown = null;
    server.use(
      authenticated,
      holidaysListEmpty,
      http.post('/holidays/seed', async ({ request }) => {
        seeded = await request.json();
        return HttpResponse.json({ inserted: 26, skipped: 0, errors: [] });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders();
    const btn = await screen.findByTestId('seed-US');
    await user.click(btn);
    await waitFor(() => {
      expect(seeded).toEqual({ countryCode: 'US' });
    });
  });
});
