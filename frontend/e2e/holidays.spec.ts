import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
};

const E2E_HOLIDAY_PREFIX = 'e2e-holiday-';

// Pick a weekday in the current month so the test is independent of the CI
// date. The calendar starts on the current month, so the holiday badge is
// guaranteed to be visible after creation.
function weekdayInCurrentMonth(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month) break;
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
  }
  throw new Error('No weekday in the current month');
}
const E2E_HOLIDAY_DATE = weekdayInCurrentMonth();

async function loginAsLead(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(SEED.lead.email);
  await page.getByLabel(/password/i).fill(SEED.lead.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /^calendar$/i })).toBeVisible();
}

async function cleanupCreatedHolidays(): Promise<void> {
  const url =
    process.env.DATABASE_URL ?? 'postgresql://pto:pto@localhost:5432/pto_test?schema=public';
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.holiday.deleteMany({
      where: { name: { startsWith: E2E_HOLIDAY_PREFIX } },
    });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Public holiday overlay', () => {
  test.afterAll(async () => {
    await cleanupCreatedHolidays();
  });

  test('a team_lead can reach /admin/holidays from the calendar, add a holiday, and see it on the calendar', async ({
    page,
  }) => {
    await loginAsLead(page);
    await page.getByTestId('manage-holidays-link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^holidays$/i })).toBeVisible();

    const name = `${E2E_HOLIDAY_PREFIX}${Date.now()}`;
    await page.getByTestId('add-holiday-date').fill(E2E_HOLIDAY_DATE);
    await page.getByTestId('add-holiday-name').fill(name);
    await page.getByTestId('add-holiday-country').selectOption('US');
    await page.getByTestId('add-holiday-submit').click();

    await expect(page.getByTestId(`holiday-row-${E2E_HOLIDAY_DATE}-US`)).toBeVisible();

    await page.getByTestId('back-link').click();
    await expect(page.getByRole('heading', { name: /^calendar$/i })).toBeVisible();

    await expect(page.getByTestId(`holiday-badge-${E2E_HOLIDAY_DATE}-US`)).toBeVisible();
  });

  test('a non-team_lead sees no /admin/holidays nav link and gets 403 if they hit the API', async ({
    page,
    request,
  }) => {
    // Sign out the lead, sign in as a member.
    await loginAsLead(page);
    await page.getByRole('button', { name: /sign out/i }).click();
    await page.getByLabel(/email/i).fill('dev1@example.com');
    await page.getByLabel(/password/i).fill('dev1-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /^calendar$/i })).toBeVisible();

    await expect(page.getByTestId('manage-holidays-link')).toHaveCount(0);

    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await request.post('/holidays', {
      headers: { cookie: cookieHeader },
      data: { date: '2026-08-15', name: 'Member-attempt' },
    });
    expect(res.status()).toBe(403);
  });

  test('the admin page exposes a seed button for every supported country (US, MX, CO, CL)', async ({
    page,
  }) => {
    await loginAsLead(page);
    await page.getByTestId('manage-holidays-link').click();
    await expect(page.getByRole('heading', { level: 1, name: /^holidays$/i })).toBeVisible();
    for (const cc of ['US', 'MX', 'CO', 'CL']) {
      await expect(page.getByTestId(`seed-${cc}`)).toBeVisible();
    }
  });
});
