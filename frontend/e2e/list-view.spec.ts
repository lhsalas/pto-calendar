import { test, expect, type Page } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password' },
};

function isoPlusDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function secondWeekdayInCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      count += 1;
      if (count === 2) return d.toISOString().slice(0, 10);
    }
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

test.describe('Sprint 4 — list view', () => {
  test.describe.configure({ retries: 0 });
  test('switching to list shows upcoming PTOs, clicking a row opens the modal, editing updates the row', async ({
    page,
  }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    const day = secondWeekdayInCurrentMonth();
    const newDay = isoPlusDays(day, 1);

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(day);
    await page.getByLabel(/end date/i).fill(day);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await page.getByTestId('view-option-list').click();
    await expect(page.getByRole('radio', { name: /show upcoming pto list/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    const row = page.locator('[data-testid^="upcoming-row-"]').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(day);
    await row.locator('button').first().click();
    await expect(page.getByText(/pto details/i)).toBeVisible();

    await page.getByRole('button', { name: /^edit$/i }).click();
    await expect(page.getByText(/edit pto/i)).toBeVisible();
    await page.getByLabel(/start date/i).fill(newDay);
    await page.getByLabel(/end date/i).fill(newDay);
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByText(/pto updated/i)).toBeVisible();

    await expect(page.locator('[data-testid^="upcoming-row-"]').first()).toContainText(newDay);
  });
});
