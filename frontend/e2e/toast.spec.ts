import { test, expect, type Page } from '@playwright/test';

// Before running this spec locally, run:
//   TRUNCATE pto_requests, audit_logs RESTART IDENTITY CASCADE
// against the dev `pto` database so the seeded users start with a clean slate.

const SEED = { email: 'lead@example.com', password: 'lead-dev-password' };

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(SEED.email);
  await page.getByLabel(/password/i).fill(SEED.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
}

async function setTheme(page: Page, mode: 'light' | 'dark'): Promise<void> {
  const testId = mode === 'dark' ? 'theme-option-dark' : 'theme-option-light';
  await page.getByTestId(testId).click();
  await expect(page.locator('html')).toHaveClass(mode === 'dark' ? /dark/ : /^(?!.*dark).*$/);
}

function nthWeekdayInCurrentMonth(n: number): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      count += 1;
      if (count === n) return d.toISOString().slice(0, 10);
    }
  }
  throw new Error(`No weekday #${n} in the current month`);
}

test.describe('Issue #65 — editorial toast component', () => {
  test.describe.configure({ retries: 0 });

  test('success toast appears top-right with terracotta stripe, CheckCircle2 icon, and matches surface palette', async ({
    page,
  }) => {
    const day = nthWeekdayInCurrentMonth(5);
    await login(page);

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(day);
    await page.getByLabel(/end date/i).fill(day);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).not.toBeVisible();

    const toast = page.getByTestId('toast-success');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/PTO saved/i);
    await expect(toast.getByTestId('toast-icon')).toBeVisible();
    await expect(toast.getByTestId('toast-stripe')).toBeVisible();

    const TERRACOTTA = 'rgb(181, 83, 58)';
    const stripe = toast.getByTestId('toast-stripe');
    expect(await stripe.evaluate((el) => window.getComputedStyle(el).backgroundColor)).toBe(
      TERRACOTTA,
    );

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const surface = theme === 'light' ? 'rgb(254, 252, 248)' : 'rgb(45, 42, 38)';
      const surfaceColor = await toast.evaluate(
        (el) => window.getComputedStyle(el).backgroundColor,
      );
      expect(surfaceColor, `toast surface in ${theme}`).toBe(surface);
    }
  });

  test('success toast auto-dismisses within ~5 seconds', async ({ page }) => {
    const day = nthWeekdayInCurrentMonth(6);
    await login(page);

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(day);
    await page.getByLabel(/end date/i).fill(day);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();

    const toast = page.getByTestId('toast-success');
    await expect(toast).toBeVisible();
    await expect(toast).toBeHidden({ timeout: 6_000 });
  });

  test('error toast appears with danger stripe and Retry action when the list fetch fails', async ({
    page,
  }) => {
    await page.route('**/pto?**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'server down' } }),
      }),
    );

    await login(page);

    const alert = page.getByTestId('toast-error');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/could not load pto/i);
    const stripe = alert.getByTestId('toast-stripe');
    expect(await stripe.evaluate((el) => window.getComputedStyle(el).backgroundColor)).toBe(
      'rgb(165, 61, 42)',
    );
    const action = alert.getByTestId('toast-action');
    await expect(action).toBeVisible();
    await expect(action).toHaveText(/retry/i);
  });
});
