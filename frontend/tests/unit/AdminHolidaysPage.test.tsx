import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { ToastProvider } from '../../src/context/ToastProvider';
import { ToastViewport } from '../../src/components/common/ToastViewport';
import { AdminHolidaysPage } from '../../src/pages/admin/AdminHolidaysPage';
import type * as ApiClientModule from '../../src/api/client';
import { server } from '../mocks/server';
import { authenticated, holidaysListAll, holidaysListEmpty } from '../mocks/handlers';

/**
 * Per-request transport overrides, keyed by `"<METHOD> <path>"`. The api
 * client stays the real implementation (so typed `ApiError`s still travel
 * through the normal response handling), but a test can replace a single
 * request with a controlled failure, e.g. a rejection that is not an
 * `ApiError`.
 */
const { requestOverrides } = vi.hoisted(() => ({
  requestOverrides: new Map<
    string,
    (options: { method?: string } | undefined) => Promise<unknown>
  >(),
}));

vi.mock('../../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  const actualApiRequest = actual.apiRequest as unknown as (
    path: string,
    options?: unknown,
  ) => Promise<unknown>;
  return {
    ...actual,
    apiRequest: (path: string, options?: unknown): Promise<unknown> => {
      const method = (options as { method?: string } | undefined)?.method ?? 'GET';
      const override = requestOverrides.get(`${method} ${path}`);
      if (override) return override(options as { method?: string } | undefined);
      return actualApiRequest(path, options);
    },
  };
});

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
            <ToastViewport />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  requestOverrides.clear();
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

  it('shows the loading state while the holiday list request is pending', async () => {
    server.use(authenticated);
    requestOverrides.set('GET /holidays/all', () => new Promise(() => {}));
    renderWithProviders();
    expect(await screen.findByRole('heading', { level: 1, name: /holidays/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByTestId('holiday-list')).not.toBeInTheDocument();
  });

  it('shows the API error message when the holiday list request fails', async () => {
    server.use(
      authenticated,
      http.get('/holidays/all', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'Holidays are unavailable right now.' } },
          { status: 500 },
        ),
      ),
    );
    renderWithProviders();
    expect(await screen.findByRole('heading', { level: 1, name: /holidays/i })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Holidays are unavailable right now.',
    );
    expect(screen.queryByTestId('holiday-list')).not.toBeInTheDocument();
  });

  it('shows a generic message when the holiday list request fails with a non-API error', async () => {
    server.use(authenticated);
    requestOverrides.set('GET /holidays/all', () => Promise.reject(new Error('socket hang up')));
    renderWithProviders();
    expect(await screen.findByRole('heading', { level: 1, name: /holidays/i })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load holidays.');
  });

  it('POSTs a null country code when no country is selected', async () => {
    let captured: unknown = null;
    server.use(
      authenticated,
      holidaysListEmpty,
      http.post('/holidays', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json(
          { id: 'h-new', date: '2026-11-11', name: 'Veterans Day', countryCode: null },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders();
    await user.type(await screen.findByTestId('add-holiday-date'), '2026-11-11');
    await user.type(screen.getByTestId('add-holiday-name'), 'Veterans Day');
    await user.click(screen.getByTestId('add-holiday-submit'));
    await waitFor(() => {
      expect(captured).toEqual({ date: '2026-11-11', name: 'Veterans Day', countryCode: null });
    });
  });

  it('shows the API error message when adding a holiday fails', async () => {
    server.use(
      authenticated,
      holidaysListEmpty,
      http.post('/holidays', () =>
        HttpResponse.json(
          { error: { code: 'CONFLICT', message: 'A holiday already exists on that date.' } },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders();
    await user.type(await screen.findByTestId('add-holiday-date'), '2026-11-11');
    await user.type(screen.getByTestId('add-holiday-name'), 'Veterans Day');
    await user.click(screen.getByTestId('add-holiday-submit'));

    expect(await screen.findByTestId('add-holiday-error')).toHaveTextContent(
      'A holiday already exists on that date.',
    );
    // The form keeps what was typed so the request can be corrected and retried.
    expect(screen.getByTestId('add-holiday-name')).toHaveValue('Veterans Day');
  });

  it('shows a generic message when adding a holiday fails with a non-API error', async () => {
    server.use(authenticated, holidaysListEmpty);
    requestOverrides.set('POST /holidays', () => Promise.reject(new Error('boom')));
    const user = userEvent.setup();
    renderWithProviders();
    await user.type(await screen.findByTestId('add-holiday-date'), '2026-11-11');
    await user.type(screen.getByTestId('add-holiday-name'), 'Veterans Day');
    await user.click(screen.getByTestId('add-holiday-submit'));

    expect(await screen.findByTestId('add-holiday-error')).toHaveTextContent(
      'Could not add holiday.',
    );
  });

  it('shows an error toast with the API message when removing a holiday fails', async () => {
    server.use(
      authenticated,
      holidaysListAll,
      http.delete('/holidays/:id', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'The holiday could not be removed.' } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders();
    await user.click(await screen.findByTestId('holiday-delete-h-1'));

    const toast = await screen.findByTestId('toast-error');
    expect(toast).toHaveTextContent('Could not remove holiday.');
    expect(toast).toHaveTextContent('The holiday could not be removed.');
  });

  it('shows an unknown error when removing a holiday fails with a non-API error', async () => {
    server.use(authenticated, holidaysListAll);
    requestOverrides.set('DELETE /holidays/h-1', () => Promise.reject(new Error('boom')));
    const user = userEvent.setup();
    renderWithProviders();
    await user.click(await screen.findByTestId('holiday-delete-h-1'));

    const toast = await screen.findByTestId('toast-error');
    expect(toast).toHaveTextContent('Could not remove holiday.');
    expect(toast).toHaveTextContent('Unknown error.');
  });

  it('shows an error toast when seeding reports row errors', async () => {
    server.use(
      authenticated,
      holidaysListEmpty,
      http.post('/holidays/seed', () =>
        HttpResponse.json({ inserted: 3, skipped: 1, errors: ['Unsupported date'] }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders();
    await user.click(await screen.findByTestId('seed-US'));

    const toast = await screen.findByTestId('toast-error');
    expect(toast).toHaveTextContent('Seeded US holidays.');
    expect(toast).toHaveTextContent('Inserted 3, skipped 1, errors 1.');
  });

  it('shows the API error message when seeding fails', async () => {
    server.use(
      authenticated,
      holidaysListEmpty,
      http.post('/holidays/seed', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'The seed service is unavailable.' } },
          { status: 500 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders();
    await user.click(await screen.findByTestId('seed-US'));

    const toast = await screen.findByTestId('toast-error');
    expect(toast).toHaveTextContent('Could not seed US holidays.');
    expect(toast).toHaveTextContent('The seed service is unavailable.');
  });

  it('shows an unknown error when seeding fails with a non-API error', async () => {
    server.use(authenticated, holidaysListEmpty);
    requestOverrides.set('POST /holidays/seed', () => Promise.reject(new Error('boom')));
    const user = userEvent.setup();
    renderWithProviders();
    await user.click(await screen.findByTestId('seed-US'));

    const toast = await screen.findByTestId('toast-error');
    expect(toast).toHaveTextContent('Could not seed US holidays.');
    expect(toast).toHaveTextContent('Unknown error.');
  });

  it('signs the user out from the header', async () => {
    server.use(authenticated, holidaysListEmpty);
    const user = userEvent.setup();
    renderWithProviders();
    await screen.findByRole('heading', { level: 1, name: /holidays/i });

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
  });
});
