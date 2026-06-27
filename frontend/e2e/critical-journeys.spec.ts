import { test, expect, type Page } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password' },
  dev2: { email: 'dev2@example.com', password: 'dev2-dev-password' },
};

function firstWeekdayInCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(year, month, 2)).toISOString().slice(0, 10);
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
}

test.describe('Sprint 4 — critical journeys', () => {
  test.describe.configure({ retries: 0 });

  test('Journey 3: create a multi-day PTO (Mon–Fri)', async ({ page }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    await page.getByRole('button', { name: /^add pto$/i }).click();
    const today = firstWeekdayInCurrentMonth();
    const friday = new Date(today);
    friday.setUTCDate(friday.getUTCDate() + 4);
    const fridayIso = friday.toISOString().slice(0, 10);
    await page.getByLabel(/start date/i).fill(today);
    await page.getByLabel(/end date/i).fill(fridayIso);
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText(/pto saved/i)).toBeVisible();
    expect(await page.getByTestId(`day-cell-${today}`).textContent()).toMatch(/developer one/i);
    expect(await page.getByTestId(`day-cell-${fridayIso}`).textContent()).toMatch(/developer one/i);
  });

  test('Journey 4: rejects a weekend start with an inline error', async ({ page }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    await page.getByRole('button', { name: /^add pto$/i }).click();
    const month = new Date().getUTCMonth();
    const year = new Date().getUTCFullYear();
    let saturday = '';
    for (let day = 1; day <= 7; day += 1) {
      const d = new Date(Date.UTC(year, month, day));
      if (d.getUTCDay() === 6) {
        saturday = d.toISOString().slice(0, 10);
        break;
      }
    }
    expect(saturday).not.toBe('');
    await page.getByLabel(/start date/i).fill(saturday);
    await page.getByLabel(/end date/i).fill(saturday);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('alert')).toHaveTextContent(/weekend/i);
  });

  test('Journey 5: rejects a PTO that overlaps an existing entry', async ({ page }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    const today = firstWeekdayInCurrentMonth();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(today);
    await page.getByLabel(/end date/i).fill(today);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(today);
    await page.getByLabel(/end date/i).fill(today);
    await page.getByLabel(/day part/i).selectOption('evening');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('alert')).toHaveTextContent(/overlap/i);
  });

  test('Journey 8a: a member does not see Edit or Delete on a team lead PTO', async ({ page }) => {
    await login(page, SEED.lead.email, SEED.lead.password);
    const today = firstWeekdayInCurrentMonth();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(today);
    await page.getByLabel(/end date/i).fill(today);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('heading', { name: /pto calendar/i })).toBeVisible();

    await page.getByLabel(/email/i).fill(SEED.dev1.email);
    await page.getByLabel(/password/i).fill(SEED.dev1.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await page.getByRole('button', { name: /team lead/i }).click();
    await expect(page.getByText(/pto details/i)).toBeVisible();
    expect(page.getByRole('button', { name: /^edit$/i })).toHaveCount(0);
    expect(page.getByRole('button', { name: /^delete$/i })).toHaveCount(0);
  });

  test('Journey 8b: a team lead can edit a member PTO', async ({ page }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    const today = firstWeekdayInCurrentMonth();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(today);
    await page.getByLabel(/end date/i).fill(today);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('heading', { name: /pto calendar/i })).toBeVisible();

    await page.getByLabel(/email/i).fill(SEED.lead.email);
    await page.getByLabel(/password/i).fill(SEED.lead.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await page.getByRole('button', { name: /developer one/i }).click();
    await expect(page.getByText(/pto details/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^edit$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^delete$/i })).toBeVisible();
  });
});
