import { test, expect } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
};

test.describe('Sprint 1 critical journey', () => {
  test.describe.configure({ retries: 0 });
  test('seeded team lead can log in and create a single-day morning PTO', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/PTO Calendar/i);

    await page.getByLabel(/email/i).fill(SEED.lead.email);
    await page.getByLabel(/password/i).fill(SEED.lead.password);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await expect(page.getByText(/Team Lead/i)).toBeVisible();

    await page.getByRole('button', { name: /add pto/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.getByLabel(/start date/i).fill('2026-05-11');
    await page.getByLabel(/end date/i).fill('2026-05-11');
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();

    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText(/PTO saved/i)).toBeVisible();
    await expect(page.getByText(/Team Lead/).first()).toBeVisible();
    await expect(page.getByText('2026-05-11').first()).toBeVisible();
  });
});
