import { test, expect, type Page } from '@playwright/test';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
  dev1: { email: 'dev1@example.com', password: 'dev1-dev-password' },
  dev2: { email: 'dev2@example.com', password: 'dev2-dev-password' },
};

function nthWeekdayInCurrentMonth(n: number, weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 1): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow === weekday) {
      count += 1;
      if (count === n) return d.toISOString().slice(0, 10);
    }
  }
  throw new Error(`No ${weekday} #${n} in the current month`);
}

// Returns the 4th weekday in the current month that is today or in the
// future. The choice of the 4th weekday (not the 1st) is deliberate:
// create-pto.spec.ts already creates a PTO for dev1 on the 1st weekday
// of the current month, and tests run in worker-1 mode, so a Journey 8b
// run would otherwise hit a 409 CONFLICT on overlap. Falls back to the
// last weekday of the month when fewer than 4 weekdays remain.
function futureOrTodayWeekdayInCurrentMonth(): string {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const weekdays: string[] = [];
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (d.getTime() >= today) weekdays.push(iso);
  }
  if (weekdays.length >= 4) return weekdays[3]!;
  if (weekdays.length > 0) return weekdays[weekdays.length - 1]!;
  throw new Error('No future-or-today weekday in the current month');
}

function nextSaturday(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let day = 1; day <= 7; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCDay() === 6) return d.toISOString().slice(0, 10);
  }
  throw new Error('no Saturday in the first week');
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
    const monday = nthWeekdayInCurrentMonth(2, 1);
    const friday = new Date(monday);
    friday.setUTCDate(friday.getUTCDate() + 4);
    const fridayIso = friday.toISOString().slice(0, 10);
    await page.getByLabel(/start date/i).fill(monday);
    await page.getByLabel(/end date/i).fill(fridayIso);
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText(/pto saved/i)).toBeVisible();
    expect(await page.getByTestId(`day-cell-${monday}`).textContent()).toMatch(/developer one/i);
    expect(await page.getByTestId(`day-cell-${fridayIso}`).textContent()).toMatch(/developer one/i);
  });

  test('Journey 4: rejects a weekend start with an inline error', async ({ page }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    await page.getByRole('button', { name: /^add pto$/i }).click();
    const saturday = nextSaturday();
    await page.getByLabel(/start date/i).fill(saturday);
    await page.getByLabel(/end date/i).fill(saturday);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('alert')).toContainText(/weekend/i);
  });

  test('Journey 5: rejects a PTO that overlaps an existing entry', async ({ page }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    const day = nthWeekdayInCurrentMonth(3, 1);

    async function fillDay(): Promise<void> {
      const startInput = page.getByLabel(/start date/i);
      const endInput = page.getByLabel(/end date/i);
      await startInput.fill('');
      await startInput.fill(day);
      await endInput.fill('');
      await endInput.fill(day);
      await expect(startInput).toHaveValue(day);
      await expect(endInput).toHaveValue(day);
    }

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await fillDay();
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();

    await page.getByRole('button', { name: /^add pto$/i }).click();
    await fillDay();
    await page.getByLabel(/day part/i).selectOption('evening');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('alert')).toContainText(/overlap/i);
  });

  test('Journey 8a: a member does not see Edit or Delete on a team lead PTO', async ({ page }) => {
    await login(page, SEED.lead.email, SEED.lead.password);
    const day = nthWeekdayInCurrentMonth(3, 2);
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(day);
    await page.getByLabel(/end date/i).fill(day);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('heading', { name: /pto calendar/i })).toBeVisible();

    await page.getByLabel(/email/i).fill(SEED.dev1.email);
    await page.getByLabel(/password/i).fill(SEED.dev1.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await page
      .getByRole('button', { name: /team lead/i })
      .first()
      .click();
    await expect(page.getByText(/pto details/i)).toBeVisible();
    expect(page.getByRole('button', { name: /^edit$/i })).toHaveCount(0);
    expect(page.getByRole('button', { name: /^delete$/i })).toHaveCount(0);
  });

  test('Journey 8b: a team lead can edit a member PTO', async ({ page }) => {
    await login(page, SEED.dev1.email, SEED.dev1.password);
    // Use a weekday in the current month that is today or in the future so
    // the PTO creation succeeds and the chip is visible on the current-month
    // calendar. The previous `nthWeekdayInCurrentMonth(5, 3)` (5th Wednesday)
    // broke in months that only have 4 Wednesdays (e.g. August 2026), and a
    // hard-coded 3rd Monday broke when the CI ran on the last day of a month
    // (every Monday in that month is in the past).
    const day = futureOrTodayWeekdayInCurrentMonth();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(day);
    await page.getByLabel(/end date/i).fill(day);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByRole('button', { name: /save pto/i }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByRole('heading', { name: /pto calendar/i })).toBeVisible();

    await page.getByLabel(/email/i).fill(SEED.lead.email);
    await page.getByLabel(/password/i).fill(SEED.lead.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await page
      .getByRole('button', { name: /developer one/i })
      .first()
      .click();
    await expect(page.getByText(/pto details/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^edit$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^delete$/i })).toBeVisible();
  });
});
