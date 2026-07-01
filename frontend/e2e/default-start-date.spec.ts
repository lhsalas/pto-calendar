import { test, expect } from '@playwright/test';

function firstOfMonth(year: number, month: number): string {
  const mm = String(month + 1).padStart(2, '0');
  return `${year}-${mm}-01`;
}

function nextMonthLabel(): { label: string; year: number; month: number } {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    label: next.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    year: next.getUTCFullYear(),
    month: next.getUTCMonth(),
  };
}

test.describe('Issue #18 — default start date in a future month', () => {
  test.describe.configure({ retries: 0 });
  test('Add PTO in a future month pre-fills start = 1st of that month', async ({ page }) => {
    const next = nextMonthLabel();
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByRole('button', { name: /^next$/i }).click();
    await expect(page.getByTestId('header-label')).toHaveText(new RegExp(next.label, 'i'));

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const startInput = page.getByLabel(/start date/i);
    await expect(startInput).toHaveValue(firstOfMonth(next.year, next.month));
    const endInput = page.getByLabel(/end date/i);
    await expect(endInput).toHaveValue(firstOfMonth(next.year, next.month));
  });

  test('Add PTO in the current month still defaults to today', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const today = new Date().toISOString().slice(0, 10);
    await expect(page.getByLabel(/start date/i)).toHaveValue(today);
  });
});
