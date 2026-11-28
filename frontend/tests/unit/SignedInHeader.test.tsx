import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../src/context/AuthContext';
import { ThemeProvider } from '../../src/context/ThemeContext';
import { SignedInHeader } from '../../src/components/layout/SignedInHeader';
import { server } from '../mocks/server';
import { STUB_USER, authenticated } from '../mocks/handlers';
import type { Role, User } from '../../src/types/api';

function userWithRole(role: Role): User {
  return { ...STUB_USER, role };
}

function authFor(role: Role) {
  return http.get('/auth/me', () => HttpResponse.json(userWithRole(role)));
}

/**
 * The header is rendered on the route it belongs to, so the current
 * destination is the one the router resolves.
 */
function renderHeader(path = '/calendar', title = 'Calendar'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="*" element={<SignedInHeader title={title} />} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function renderHeaderWithBackLink(path = '/admin/users'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="*" element={<SignedInHeader title="Manage users" showBackToCalendar />} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** The interactive controls of the header, in DOM order. */
function controlNames(header: HTMLElement): string[] {
  return Array.from(header.querySelectorAll('a[href], button, [role="radio"]')).map((el) =>
    (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
  );
}

describe('SignedInHeader', () => {
  it('keeps the same control order on every route', async () => {
    server.use(authenticated);
    renderHeader('/calendar');
    await screen.findByTestId('api-access-link');
    const header = screen.getByRole('banner');
    expect(controlNames(header)).toEqual([
      'Use light theme',
      'Use dark theme',
      'Use system theme',
      'API access',
      'Holidays',
      'Manage users',
      'Sign out',
    ]);
  });

  it('puts the signed-in identity between the destinations and the sign-out button', async () => {
    server.use(authenticated);
    renderHeader('/calendar');
    const identity = await screen.findByTestId('signed-in-user');
    expect(identity).toHaveTextContent('Team Lead');
    expect(identity).toHaveTextContent('(team_lead)');
    const signOut = screen.getByRole('button', { name: /sign out/i });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      identity.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('offers only API access to a member', async () => {
    server.use(authFor('member'));
    renderHeader('/calendar');
    // The identity only appears once the session is resolved.
    await screen.findByTestId('signed-in-user');
    expect(screen.getByTestId('api-access-link')).toBeInTheDocument();
    expect(screen.queryByTestId('manage-holidays-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('manage-users-link')).not.toBeInTheDocument();
  });

  it('offers every destination to a team lead', async () => {
    server.use(authFor('team_lead'));
    renderHeader('/calendar');
    await screen.findByTestId('signed-in-user');
    expect(screen.getByTestId('api-access-link')).toBeInTheDocument();
    expect(screen.getByTestId('manage-holidays-link')).toHaveAttribute('href', '/admin/holidays');
    expect(screen.getByTestId('manage-users-link')).toHaveAttribute('href', '/admin/users');
  });

  it('offers every destination to an admin', async () => {
    server.use(authFor('admin'));
    renderHeader('/calendar');
    expect(await screen.findByTestId('signed-in-user')).toHaveTextContent('(admin)');
    expect(screen.getByTestId('api-access-link')).toBeInTheDocument();
    expect(screen.getByTestId('manage-holidays-link')).toHaveAttribute('href', '/admin/holidays');
    expect(screen.getByTestId('manage-users-link')).toHaveAttribute('href', '/admin/users');
  });

  it('marks the current destination with aria-current', async () => {
    server.use(authFor('team_lead'));
    renderHeader('/admin/users');
    await screen.findByTestId('signed-in-user');
    expect(screen.getByTestId('manage-users-link')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('api-access-link')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('manage-holidays-link')).not.toHaveAttribute('aria-current');
  });

  it('marks API access as the current destination on the token route', async () => {
    server.use(authFor('member'));
    renderHeader('/settings/tokens');
    await screen.findByTestId('signed-in-user');
    expect(screen.getByTestId('api-access-link')).toHaveAttribute('aria-current', 'page');
  });

  it('marks the current destination on a route with a trailing slash', async () => {
    server.use(authFor('team_lead'));
    renderHeader('/admin/users/');
    await screen.findByTestId('signed-in-user');
    expect(screen.getByTestId('manage-users-link')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('api-access-link')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('manage-holidays-link')).not.toHaveAttribute('aria-current');
  });

  it('keeps the focus indicator of the theme options inside the switcher', async () => {
    server.use(authenticated);
    renderHeader('/calendar');
    await screen.findByTestId('theme-toggle');
    for (const mode of ['light', 'dark', 'system']) {
      const option = screen.getByTestId(`theme-option-${mode}`);
      // The switcher clips its overflow, so an outside ring would be cut off.
      expect(option.className).toMatch(/focus-visible:ring-inset/);
      expect(option.className).toMatch(/focus-visible:ring-accent-500/);
    }
  });

  it('renders one heading and no back link unless the route asks for one', async () => {
    server.use(authenticated);
    renderHeader('/calendar', 'Calendar');
    expect(await screen.findByRole('heading', { level: 1, name: 'Calendar' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByTestId('back-to-calendar-link')).not.toBeInTheDocument();
  });

  it('links the back link straight to the calendar', async () => {
    server.use(authFor('team_lead'));
    renderHeaderWithBackLink('/admin/users');
    const back = await screen.findByTestId('back-to-calendar-link');
    expect(back).toHaveAttribute('href', '/calendar');
    expect(back).toHaveTextContent(/back to calendar/i);
  });

  it('labels the navigation landmark', async () => {
    server.use(authenticated);
    renderHeader('/calendar');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByTestId('api-access-link')).toBeInTheDocument();
  });

  it('signs the user out', async () => {
    let loggedOut = 0;
    server.use(
      authenticated,
      http.post('/auth/logout', () => {
        loggedOut += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    renderHeader('/calendar');
    await user.click(await screen.findByRole('button', { name: /sign out/i }));
    await waitFor(() => {
      expect(loggedOut).toBe(1);
    });
  });
});
