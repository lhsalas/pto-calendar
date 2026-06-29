import { test, expect, type Page } from '@playwright/test';

const SEED = { email: 'dev1@example.com', password: 'dev1-dev-password' };

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(SEED.email);
  await page.getByLabel(/password/i).fill(SEED.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
}

async function setTheme(page: Page, mode: 'light' | 'dark'): Promise<void> {
  const testId = mode === 'dark' ? 'theme-option-dark' : 'theme-option-light';
  await page.getByTestId(testId).click();
  if (mode === 'dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
}

async function backgroundOf(page: Page, locator: ReturnType<Page['locator']>): Promise<string> {
  return locator.evaluate((el: Element) => window.getComputedStyle(el).backgroundColor);
}

function nthWeekdayInCurrentMonth(n: number, weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 1): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    if (d.getUTCDay() === weekday) {
      count += 1;
      if (count === n) return d.toISOString().slice(0, 10);
    }
  }
  throw new Error(`No weekday ${weekday} #${n} in the current month`);
}

test.describe('Issue #53 — primary button + today-bg have a visible terracotta fill', () => {
  test.describe.configure({ retries: 0 });

  test('Add PTO / Save PTO / Edit / today badge render with #b5533a background in light + dark', async ({
    page,
  }) => {
    await login(page);
    const day = nthWeekdayInCurrentMonth(1, 2);

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(day);
    await page.getByLabel(/end date/i).fill(day);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog', { name: /add pto/i })).not.toBeVisible();

    const TERRACOTTA = 'rgb(181, 83, 58)';

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);

      const addBtn = page.getByRole('button', { name: /^add pto$/i });
      await expect(addBtn, `Add PTO visible (${theme})`).toBeVisible();
      expect(await backgroundOf(page, addBtn), `Add PTO bg (${theme})`).toBe(TERRACOTTA);

      await addBtn.click();
      const saveBtn = page.getByRole('button', { name: /save pto/i });
      await expect(saveBtn, `Save PTO visible (${theme})`).toBeVisible();
      expect(await backgroundOf(page, saveBtn), `Save PTO bg (${theme})`).toBe(TERRACOTTA);
      await page.getByRole('button', { name: /cancel/i }).click();

      const chip = page
        .getByTestId(`day-cell-${day}`)
        .getByRole('button', { name: /developer one/i });
      await expect(chip, `chip visible (${theme})`).toBeVisible();
      await chip.click();
      const editBtn = page.getByRole('button', { name: /^edit$/i });
      await expect(editBtn, `Edit visible (${theme})`).toBeVisible();
      expect(await backgroundOf(page, editBtn), `Edit bg (${theme})`).toBe(TERRACOTTA);
      await page.getByRole('button', { name: /^close$/i }).click();

      const todayBadge = page.locator('.bg-accent.rounded-full').first();
      await expect(todayBadge, `today badge visible (${theme})`).toBeVisible();
      expect(await backgroundOf(page, todayBadge), `today badge bg (${theme})`).toBe(TERRACOTTA);
    }
  });

  test('Add PTO button darkens to #a04c32 on hover (accent-hover token is wired)', async ({
    page,
  }) => {
    await login(page);
    const addBtn = page.getByRole('button', { name: /^add pto$/i });
    await expect(addBtn).toBeVisible();
    await addBtn.hover();
    const HOVER_TERRACOTTA = 'rgb(160, 76, 50)';
    await expect
      .poll(() => addBtn.evaluate((el: Element) => window.getComputedStyle(el).backgroundColor), {
        timeout: 1_000,
      })
      .toBe(HOVER_TERRACOTTA);
  });
});
