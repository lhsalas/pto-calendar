import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

const SEED = {
  lead: { email: 'lead@example.com', password: 'lead-dev-password' },
};

const E2E_EMAIL_PREFIX = 'e2e-admin-users-';

async function loginAsLead(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(SEED.lead.email);
  await page.getByLabel(/password/i).fill(SEED.lead.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /^calendar$/i })).toBeVisible();
}

async function cleanupCreatedUsers(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgresql://pto:pto@localhost:5432/pto?schema=public';
  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    await prisma.user.deleteMany({
      where: { email: { startsWith: E2E_EMAIL_PREFIX } },
    });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe.configure({ mode: 'serial' });

test.describe('Admin users surface', () => {
  test.afterAll(async () => {
    await cleanupCreatedUsers();
  });

  test('lead can reach /admin/users from the calendar, create a user, and return', async ({
    page,
  }) => {
    await loginAsLead(page);

    await page.getByTestId('manage-users-link').click();
    await expect(page.getByRole('heading', { name: /manage users/i })).toBeVisible();
    await expect(page.getByText(/Team Lead/)).toBeVisible();

    const email = `${E2E_EMAIL_PREFIX}${Date.now()}@example.com`;
    await page.getByLabel(/name/i).fill('E2E New Member');
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole('button', { name: /create user/i }).click();
    await expect(page.getByText(/setup link for/i)).toBeVisible();

    await page.getByTestId('back-to-calendar-link').click();
    await expect(page.getByRole('heading', { name: /^calendar$/i })).toBeVisible();
  });

  test('admin/users page exposes the sign-out button so leads can end the session', async ({
    page,
  }) => {
    await loginAsLead(page);
    await page.getByTestId('manage-users-link').click();
    expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
  });
});
