import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const SEED = { email: 'dev1@example.com', password: 'dev1-dev-password' };

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(SEED.email);
  await page.getByLabel(/password/i).fill(SEED.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
}

test.describe('Issue #25 — focus rings + a11y audit', () => {
  test.describe.configure({ retries: 0 });

  test('primary buttons render a focus-visible ring class', async ({ page }) => {
    await login(page);
    const selectors = [
      'button[aria-label="Previous"]',
      'button[aria-label="Next"]',
      'button[aria-label="Jump to current period"]',
      'button:has-text("Add PTO")',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel).first();
      await expect(btn, `locator ${sel}`).toBeVisible();
      const cls = await btn.getAttribute('class');
      expect(cls, `${sel} class`).toMatch(/focus-visible:ring-2/);
      expect(cls, `${sel} class`).toMatch(/focus-visible:ring-accent-500/);
    }
  });

  test('keyboard tab brings a visible focus ring on a primary button', async ({ page }) => {
    await login(page);
    // Press Tab a bunch and capture box-shadow of any focused element that has a non-none ring.
    let captured: string | null = null;
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press('Tab');
      const shadow = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return '';
        return window.getComputedStyle(el).boxShadow;
      });
      if (shadow && shadow !== 'none' && shadow.includes('181, 83, 58')) {
        captured = shadow;
        break;
      }
    }
    expect(captured, 'no element gained a focus ring after Tab').not.toBeNull();
    expect(captured!).toMatch(/rgb\(181,\s*83,\s*58\)/);
  });

  test('login page inputs have a focus ring after Tab', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/email/i)).toBeVisible();
    let ring = 'none';
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el ? window.getComputedStyle(el).boxShadow : 'none';
      });
      if (ring.includes('181, 83, 58')) break;
    }
    expect(ring).toMatch(/rgb\(181,\s*83,\s*58\)/);
  });
});
