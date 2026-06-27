import { test, expect } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password' },
};

function nthWeekdayInCurrentMonth(n: number): { start: string; end: string; iso: string } {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      count += 1;
      if (count === n) {
        const iso = d.toISOString().slice(0, 10);
        return { start: iso, end: iso, iso };
      }
    }
  }
  const fallback = new Date(Date.UTC(year, month, 2));
  const iso = fallback.toISOString().slice(0, 10);
  return { start: iso, end: iso, iso };
}

function firstWeekdayInCurrentMonth(): { start: string; end: string; iso: string } {
  return nthWeekdayInCurrentMonth(1);
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

test.describe('Sprint 2 critical journey', () => {
  test.describe.configure({ retries: 0 });
  test('dev1 can edit and then delete their own PTO with confirm', async ({ page }) => {
    const { start, end, iso } = nthWeekdayInCurrentMonth(2);

    await page.goto('/');
    await page.getByLabel(/email/i).fill(SEED.dev1.email);
    await page.getByLabel(/password/i).fill(SEED.dev1.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(start);
    await page.getByLabel(/end date/i).fill(end);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await page.getByRole('button', { name: /developer one/i }).click();
    await expect(page.getByRole('dialog', { name: /pto details/i })).toBeVisible();
    await page.getByRole('button', { name: /^edit$/i }).click();
    await expect(page.getByText(/edit pto/i)).toBeVisible();
    await page.getByLabel(/day part/i).selectOption('evening');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByText(/PTO updated/i)).toBeVisible();

    await page.getByRole('button', { name: /developer one/i }).click();
    await page.getByRole('button', { name: /^delete$/i }).click();
    await expect(page.getByText(/cannot be undone/i)).toBeVisible();
    await page.getByRole('button', { name: /yes, delete/i }).click();
    await expect(page.getByText(/PTO deleted/i)).toBeVisible();
    await expect(page.getByText(iso)).not.toBeVisible();
  });
});

test.describe('Sprint 3 critical journey', () => {
  test.describe.configure({ retries: 0 });
  test('navigating months updates the grid heading and visible range', async ({ page }) => {
    const { iso: todayIso } = firstWeekdayInCurrentMonth();
    await page.goto('/');
    await page.getByLabel(/email/i).fill(SEED.dev1.email);
    await page.getByLabel(/password/i).fill(SEED.dev1.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await expect(page.getByText(todayIso).first()).toBeVisible();

    await page.getByRole('button', { name: /add pto/i }).click();
    await page.getByLabel(/start date/i).fill(todayIso);
    await page.getByLabel(/end date/i).fill(todayIso);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await page.getByRole('button', { name: /^next$/i }).click();
    const nextMonth = new Date(todayIso);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const nextLabel = nextMonth.toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    await expect(page.getByRole('heading', { name: nextLabel })).toBeVisible();
    await expect(page.getByText(todayIso)).not.toBeVisible();

    await page.getByRole('button', { name: /^previous$/i }).click();
    const currentLabel = new Date(todayIso).toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    await expect(page.getByRole('heading', { name: currentLabel })).toBeVisible();
    await expect(page.getByText(todayIso).first()).toBeVisible();
  });
});

test.describe('Sprint 4 — auto-sync end date', () => {
  test.describe.configure({ retries: 0 });
  test('changing the start date auto-fills the end date and the min attribute prevents earlier picks', async ({
    page,
  }) => {
    const { iso: todayIso } = firstWeekdayInCurrentMonth();
    const laterIso = new Date(todayIso);
    laterIso.setUTCDate(laterIso.getUTCDate() + 2);
    const later = laterIso.toISOString().slice(0, 10);

    await page.goto('/');
    await page.getByLabel(/email/i).fill(SEED.dev1.email);
    await page.getByLabel(/password/i).fill(SEED.dev1.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel(/start date/i).fill(todayIso);
    const endInput = page.getByLabel(/end date/i);
    await expect(endInput).toHaveValue(todayIso);
    await expect(endInput).toHaveAttribute('min', todayIso);

    await page.getByLabel(/start date/i).fill(later);
    await expect(endInput).toHaveValue(later);
    await expect(endInput).toHaveAttribute('min', later);

    await endInput.fill(later);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText(/PTO saved/i)).toBeVisible();
  });
});
