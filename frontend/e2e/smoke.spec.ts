import { test, expect } from '@playwright/test';

test('app boots and shows login or calendar', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/PTO Calendar/i);
});

test('renders the terracotta favicon', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="icon"]').first().getAttribute('href');
  expect(href).toMatch(/\/favicon\.svg$/);
});
