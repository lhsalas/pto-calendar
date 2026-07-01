import { test, expect } from '@playwright/test';

function currentMonthWeekday(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let day = 1; day <= 28; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) return d.toISOString().slice(0, 10);
  }
  throw new Error('no weekday in the first 4 weeks of the current month');
}

function currentMonthSaturday(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let day = 1; day <= 28; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    if (d.getUTCDay() === 6) return d.toISOString().slice(0, 10);
  }
  throw new Error('no Saturday in the first 4 weeks of the current month');
}

test.describe('Issue #19 — click a weekday to start a PTO', () => {
  test.describe.configure({ retries: 0 });
  test('clicking a weekday cell opens the create modal pre-filled with that day', async ({
    page,
  }) => {
    const weekday = currentMonthWeekday();
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByTestId(`day-cell-${weekday}`).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).toBeVisible();
    await expect(page.getByLabel(/start date/i)).toHaveValue(weekday);
    await expect(page.getByLabel(/end date/i)).toHaveValue(weekday);
  });

  test('clicking a Saturday does not open the create modal', async ({ page }) => {
    const saturday = currentMonthSaturday();
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByTestId(`day-cell-${saturday}`).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).not.toBeVisible();
  });

  test('Add PTO button still opens the modal with the default start date after a cell-driven open/close', async ({
    page,
  }) => {
    const weekday = currentMonthWeekday();
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByTestId(`day-cell-${weekday}`).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).toBeVisible();
    await expect(page.getByLabel(/start date/i)).toHaveValue(weekday);

    await page.getByRole('button', { name: /cancel/i }).click();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    const today = new Date().toISOString().slice(0, 10);
    await expect(page.getByLabel(/start date/i)).toHaveValue(today);
  });
});
