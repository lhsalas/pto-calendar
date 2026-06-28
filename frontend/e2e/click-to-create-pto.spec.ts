import { test, expect } from '@playwright/test';

test.describe('Issue #19 — click a weekday to start a PTO', () => {
  test.describe.configure({ retries: 0 });
  test('clicking a weekday cell opens the create modal pre-filled with that day', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByTestId('day-cell-2026-06-15').click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).toBeVisible();
    await expect(page.getByLabel(/start date/i)).toHaveValue('2026-06-15');
    await expect(page.getByLabel(/end date/i)).toHaveValue('2026-06-15');
  });

  test('clicking a Saturday does not open the create modal', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByTestId('day-cell-2026-06-20').click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).not.toBeVisible();
  });

  test('Add PTO button still opens the modal with the default start date after a cell-driven open/close', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByTestId('day-cell-2026-06-15').click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).toBeVisible();
    await expect(page.getByLabel(/start date/i)).toHaveValue('2026-06-15');

    await page.getByRole('button', { name: /cancel/i }).click();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    const today = new Date().toISOString().slice(0, 10);
    await expect(page.getByLabel(/start date/i)).toHaveValue(today);
  });
});
