import { test, expect } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
};

test.describe('Issue #63 — calendar picker indicator visible in dark mode', () => {
  test.describe.configure({ retries: 0 });

  test('start and end date inputs render with color-scheme:dark in dark mode', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(SEED.lead.email);
    await page.getByLabel(/password/i).fill(SEED.lead.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

    await page.getByTestId('theme-option-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.getByRole('button', { name: /add pto/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const startInput = page.getByTestId('pto-form-start-date');
    const endInput = page.getByTestId('pto-form-end-date');

    await expect(startInput).toBeVisible();
    await expect(endInput).toBeVisible();

    const startScheme = await startInput.evaluate((el) => window.getComputedStyle(el).colorScheme);
    const endScheme = await endInput.evaluate((el) => window.getComputedStyle(el).colorScheme);

    expect(startScheme).toBe('dark');
    expect(endScheme).toBe('dark');

    // Close modal without writing data.
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });
});
