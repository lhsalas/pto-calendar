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

test.describe('Issue #23 — mobile responsiveness + modal a11y', () => {
  test.describe.configure({ retries: 0 });

  test('no document-level horizontal overflow on a mobile viewport', async ({ page }) => {
    await login(page);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });

  test('header buttons meet ≥44px tap target', async ({ page }) => {
    await login(page);
    const rects = await page.evaluate(() => {
      const labels = ['Previous', 'Next', 'Jump to current period'];
      const out: Record<string, { height: number; width: number }> = {};
      for (const label of labels) {
        const el = document.querySelector(`[aria-label="${label}"]`);
        if (el) {
          const r = (el as HTMLElement).getBoundingClientRect();
          out[label] = { height: r.height, width: r.width };
        }
      }
      return out;
    });
    for (const [label, rect] of Object.entries(rects)) {
      expect(rect.height, `${label} height`).toBeGreaterThanOrEqual(44);
      expect(rect.width, `${label} width`).toBeGreaterThanOrEqual(44);
    }
  });

  test('ViewToggle options meet ≥44px tap target', async ({ page }) => {
    await login(page);
    await expect(page.getByTestId('view-toggle')).toBeVisible();
    const heights = await page.evaluate(() => {
      const labels = ['Show month grid', 'Show upcoming PTO list'];
      const out: Record<string, number> = {};
      for (const label of labels) {
        const el = document.querySelector(`[aria-label="${label}"]`);
        out[label] = el ? (el as HTMLElement).getBoundingClientRect().height : 0;
      }
      return out;
    });
    for (const [label, height] of Object.entries(heights)) {
      expect(height, `${label} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('ThemeToggle options meet ≥44px tap target', async ({ page }) => {
    await login(page);
    const heights = await page.evaluate(() => {
      const labels = ['Use light theme', 'Use dark theme', 'Use system theme'];
      const out: Record<string, number> = {};
      for (const label of labels) {
        const el = document.querySelector(`[aria-label="${label}"]`);
        out[label] = el ? (el as HTMLElement).getBoundingClientRect().height : 0;
      }
      return out;
    });
    for (const [label, height] of Object.entries(heights)) {
      expect(height, `${label} height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('Escape closes an open modal', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /add pto/i })).not.toBeVisible();
  });

  test('Backdrop click closes an open modal', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).toBeVisible();
    const overlay = page.getByRole('dialog', { name: /add pto/i });
    const box = await overlay.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 4, box!.y + 4);
    await expect(page.getByRole('dialog', { name: /add pto/i })).not.toBeVisible();
  });

  test('Modal locks body scroll while open', async ({ page }) => {
    await login(page);
    const before = await page.evaluate(() => document.body.style.overflow);
    expect(before).not.toBe('hidden');
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).toBeVisible();
    const open = await page.evaluate(() => document.body.style.overflow);
    expect(open).toBe('hidden');
    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => document.body.style.overflow);
    expect(after).not.toBe('hidden');
  });
});
