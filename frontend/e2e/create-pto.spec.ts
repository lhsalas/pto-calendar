import { test, expect } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
};

function firstWeekdayInCurrentMonth(): { start: string; end: string; iso: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const iso = d.toISOString().slice(0, 10);
      return { start: iso, end: iso, iso };
    }
  }
  const fallback = new Date(Date.UTC(year, month, 2));
  const iso = fallback.toISOString().slice(0, 10);
  return { start: iso, end: iso, iso };
}

test.describe('Sprint 1 critical journey', () => {
  test.describe.configure({ retries: 0 });
  test('seeded team lead can log in and create a single-day morning PTO', async ({ page }) => {
    const { start, end, iso } = firstWeekdayInCurrentMonth();

    await page.goto('/');
    await expect(page).toHaveTitle(/PTO Calendar/i);

    await page.getByLabel(/email/i).fill(SEED.lead.email);
    await page.getByLabel(/password/i).fill(SEED.lead.password);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await expect(page.getByText(/Team Lead/i)).toBeVisible();

    await page.getByRole('button', { name: /add pto/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel(/start date/i).fill(start);
    await page.getByLabel(/end date/i).fill(end);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText(/PTO saved/i)).toBeVisible();
    await expect(page.getByText(/Team Lead/).first()).toBeVisible();
    await expect(page.getByText(iso).first()).toBeVisible();
  });
});
