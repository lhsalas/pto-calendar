import { test, expect } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
};

test.describe('Sprint 4 — dark mode', () => {
  test.describe.configure({ retries: 0 });
  test('the theme toggle sets the dark class on <html> and persists across reloads', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(SEED.lead.email);
    await page.getByLabel(/password/i).fill(SEED.lead.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByTestId('theme-option-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => window.localStorage.getItem('pto-calendar-theme'))).toBe(
      'dark',
    );

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByTestId('theme-option-light').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    expect(await page.evaluate(() => window.localStorage.getItem('pto-calendar-theme'))).toBe(
      'light',
    );
  });
});
