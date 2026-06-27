import { test, expect } from '@playwright/test';

test('app boots and shows login or calendar', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/PTO Calendar/i);
});
