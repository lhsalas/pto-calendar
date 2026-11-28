import { test, expect, type Page } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
  member: { email: 'dev1@example.com', password: 'dev1-dev-password' },
};

/**
 * A name without spaces: the worst case for the header, because the word
 * cannot break on a space and the line has to break inside the word.
 */
const LONG_NAME = 'Bartholomewkonstantinopolouswhitfieldvandenberghe';

/** The signed-in routes, and the heading each one carries. */
const SIGNED_IN_ROUTES = [
  { path: '/calendar', heading: /^calendar$/i },
  { path: '/admin/holidays', heading: /^holidays$/i },
  { path: '/admin/users', heading: /^manage users$/i },
  { path: '/settings/tokens', heading: /^personal access tokens$/i },
];

async function login(page: Page, account: { email: string; password: string }): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).fill(account.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^calendar$/i })).toBeVisible();
}

/**
 * Shows a longer name for the signed-in identity.
 *
 * This is a read-only fixture: the exact `GET /auth/me` read is intercepted,
 * the real request is still made with the real session, and only the name the
 * header displays is replaced. The identity, its role and the session stay
 * the real ones, nothing is written and no account is created.
 */
async function showLongIdentity(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/auth/me',
    async (route) => {
      const request = route.request();
      // Only the identity read is replaced, and only as a data read.
      if (request.method() !== 'GET' || request.isNavigationRequest()) {
        await route.continue();
        return;
      }
      const response = await route.fetch({ maxRedirects: 0 });
      const headers = { ...response.headers() };
      // The body changes length and encoding, so the old framing is dropped.
      delete headers['content-length'];
      delete headers['content-encoding'];
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        await route.fulfill({ response });
        return;
      }
      if (typeof body !== 'object' || body === null) {
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({
        status: response.status(),
        headers,
        json: { ...(body as Record<string, unknown>), name: LONG_NAME },
      });
    },
  );
}

/** The names of the header controls, in DOM order. */
async function headerControlNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return [];
    return Array.from(header.querySelectorAll('a[href], button, [role="radio"]')).map((el) =>
      (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
    );
  });
}

/** The name of the element that has the focus, or an empty string. */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return '';
    return (active.getAttribute('aria-label') ?? active.textContent ?? '').trim();
  });
}

interface HeaderMetrics {
  /** The viewport width the header has to fit into. */
  viewportWidth: number;
  /** The header's own content width against the box it may use. */
  scrollWidth: number;
  clientWidth: number;
  /** The header children that reach outside the viewport. */
  offenders: string[];
  /** Whether the theme switcher or the identity is cut off. */
  switcherClipped: boolean;
  identityClipped: boolean;
}

/**
 * Measures the header on its own.
 *
 * The page bodies keep their own widths (#319); the header is measured
 * separately, so a body that is wider than the viewport does not hide a
 * header that is not.
 */
async function headerMetrics(page: Page): Promise<HeaderMetrics> {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) {
      return {
        viewportWidth: 0,
        scrollWidth: 0,
        clientWidth: 0,
        offenders: ['no header'],
        switcherClipped: false,
        identityClipped: false,
      };
    }
    const viewportWidth = document.documentElement.clientWidth;
    const offenders: string[] = [];
    for (const el of header.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > viewportWidth + 1 || rect.left < -1) {
        offenders.push(
          `${el.tagName.toLowerCase()}: ${(el.textContent ?? '').trim().slice(0, 40)}`,
        );
      }
    }
    const switcher = header.querySelector('[data-testid="theme-toggle"]');
    const identity = header.querySelector('[data-testid="signed-in-user"]');
    return {
      viewportWidth,
      scrollWidth: header.scrollWidth,
      clientWidth: header.clientWidth,
      offenders,
      switcherClipped: switcher ? switcher.scrollWidth > switcher.clientWidth + 1 : false,
      identityClipped: identity ? identity.scrollWidth > identity.clientWidth + 1 : false,
    };
  });
}

test.describe('Signed-in header', () => {
  test('a member sees only the API access destination', async ({ page }) => {
    await login(page, SEED.member);
    await expect(page.getByTestId('api-access-link')).toBeVisible();
    await expect(page.getByTestId('manage-holidays-link')).toHaveCount(0);
    await expect(page.getByTestId('manage-users-link')).toHaveCount(0);
    await expect(page.getByTestId('signed-in-user')).toContainText('Developer One');
  });

  test('a team lead reaches every destination and the current one is marked', async ({ page }) => {
    await login(page, SEED.lead);

    await page.getByTestId('manage-holidays-link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^holidays$/i })).toBeVisible();
    await expect(page.getByTestId('manage-holidays-link')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('api-access-link')).not.toHaveAttribute('aria-current', 'page');

    await page.getByTestId('manage-users-link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^manage users$/i })).toBeVisible();
    await expect(page.getByTestId('manage-users-link')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('manage-holidays-link')).not.toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByTestId('api-access-link').click();
    await expect(
      page.getByRole('heading', { level: 1, name: /^personal access tokens$/i }),
    ).toBeVisible();
    await expect(page.getByTestId('api-access-link')).toHaveAttribute('aria-current', 'page');
  });

  test('a direct visit to a secondary route still offers the way back to the calendar', async ({
    page,
  }) => {
    await login(page, SEED.lead);
    for (const route of SIGNED_IN_ROUTES.slice(1)) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeVisible();
      const back = page.getByTestId('back-to-calendar-link');
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute('href', '/calendar');
      await back.click();
      await expect(page.getByRole('heading', { level: 1, name: /^calendar$/i })).toBeVisible();
    }
  });

  test('the calendar itself has no way back to itself', async ({ page }) => {
    await login(page, SEED.lead);
    await expect(page.getByTestId('back-to-calendar-link')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: /^calendar$/i })).toBeVisible();
  });

  test('sign out returns to the sign-in form from every signed-in route', async ({ page }) => {
    for (const route of SIGNED_IN_ROUTES) {
      await login(page, SEED.lead);
      await page.goto(route.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.getByRole('button', { name: /sign out/i }).click();
      await expect(page.getByRole('heading', { level: 1, name: /pto calendar/i })).toBeVisible();
      await expect(page.getByLabel(/email/i)).toBeVisible();
    }
  });

  test('the theme survives the navigation between the signed-in routes', async ({ page }) => {
    await login(page, SEED.lead);
    await page.getByTestId('theme-option-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('manage-holidays-link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^holidays$/i })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('manage-users-link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^manage users$/i })).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('api-access-link').click();
    await expect(
      page.getByRole('heading', { level: 1, name: /^personal access tokens$/i }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });

  test('the header keeps the documented control order and the 44px touch targets', async ({
    page,
  }) => {
    await login(page, SEED.lead);
    expect(await headerControlNames(page)).toEqual([
      'Use light theme',
      'Use dark theme',
      'Use system theme',
      'API access',
      'Holidays',
      'Manage users',
      'Sign out',
    ]);

    const controls = await page.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return [];
      return Array.from(header.querySelectorAll('a[href], button, [role="radio"]')).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          height: rect.height,
          width: rect.width,
          className: el.getAttribute('class') ?? '',
        };
      });
    });
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.height, `${control.name} height`).toBeGreaterThanOrEqual(44);
      expect(control.width, `${control.name} width`).toBeGreaterThanOrEqual(44);
      expect(control.className, `${control.name} focus ring`).toMatch(/focus-visible:ring-2/);
    }
  });

  test('the header is reachable by keyboard in its visual order', async ({ page }) => {
    await login(page, SEED.lead);
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { level: 1, name: /^manage users$/i })).toBeVisible();

    await page.getByTestId('back-to-calendar-link').focus();
    const order: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      await page.keyboard.press('Tab');
      order.push(await focusedName(page));
    }
    expect(order).toEqual([
      'Use light theme',
      'Use dark theme',
      'Use system theme',
      'API access',
      'Holidays',
      'Manage users',
      'Sign out',
    ]);

    // The control the keyboard reached shows the shared focus ring.
    const ring = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active ? window.getComputedStyle(active).boxShadow : 'none';
    });
    expect(ring, 'the focused control has no focus ring').toMatch(/rgb\(181,\s*83,\s*58\)/);

    // A focused link is activated by the keyboard alone.
    await page.getByTestId('back-to-calendar-link').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/calendar$/);
    await expect(page.getByRole('heading', { level: 1, name: /^calendar$/i })).toBeVisible();
  });

  test('a long signed-in name wraps at 360px without clipping the header', async ({ page }) => {
    await login(page, SEED.lead);
    await page.setViewportSize({ width: 360, height: 800 });
    // The identity read is the only thing that changes: the account, its role
    // and the session stay the real ones.
    await showLongIdentity(page);

    for (const route of SIGNED_IN_ROUTES) {
      // A direct load makes the app read the identity again.
      await page.goto(route.path);
      const identity = page.getByTestId('signed-in-user');
      await expect(identity).toBeVisible();
      await expect(identity).toContainText(LONG_NAME);

      for (const mode of ['light', 'dark'] as const) {
        await page.getByTestId(`theme-option-${mode}`).click();

        const metrics = await headerMetrics(page);
        expect(
          metrics.offenders,
          `the header reaches outside the viewport in ${mode} mode on ${route.path}`,
        ).toEqual([]);
        expect(
          metrics.scrollWidth,
          `the header content overflows in ${mode} mode on ${route.path}`,
        ).toBeLessThanOrEqual(metrics.clientWidth + 1);
        expect(
          metrics.switcherClipped,
          `the theme switcher is clipped in ${mode} mode on ${route.path}`,
        ).toBe(false);
        expect(
          metrics.identityClipped,
          `the identity is clipped in ${mode} mode on ${route.path}`,
        ).toBe(false);

        const box = await identity.boundingBox();
        expect(box, 'the identity has no box').not.toBeNull();
        expect(box!.x, 'the identity starts left of the viewport').toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, 'the identity reaches past the viewport').toBeLessThanOrEqual(
          metrics.viewportWidth,
        );
      }
    }
  });
});
