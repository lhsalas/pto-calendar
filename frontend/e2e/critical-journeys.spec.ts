import { test, expect, type Page } from '@playwright/test';
import type { PTO } from '../src/types/api';

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

// Returns the second-to-last weekday in the current month that is today or in
// the future. Earlier critical journeys reserve the first several weekdays,
// while list-view.spec.ts uses the last weekday in common CI dates.
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
  if (weekdays.length > 1) return weekdays[weekdays.length - 2]!;
  if (weekdays.length > 0) return weekdays[0]!;
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

/**
 * Issue #256 — versioned PTO writes.
 *
 * Every write now states the expected record version in one canonical quoted
 * strong `If-Match` value. These journeys drive the real browser against the
 * disposable development database: the browser sends the precondition, and a
 * record that changed underneath it is refused instead of overwritten.
 */
interface VersionedPTO extends PTO {
  version: number;
}

const VERSIONED_SEED = {
  dev2: { email: 'dev2@example.com', password: 'dev2-dev-password' },
};

/** A weekday far enough ahead that no other journey reserves the date. */
function weekdayFromNow(daysAhead: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * The direct fixture requests below talk to the app origin itself, so the
 * journey refuses to run anywhere but a loopback origin.
 */
function loopbackOrigin(): string {
  function isLoopback(url: URL): boolean {
    return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  }
  const app = new URL(test.info().project.use.baseURL!);
  const api = new URL(process.env.VITE_API_BASE_URL ?? app.origin);
  const database = new URL(process.env.DATABASE_URL!);
  if (
    [app, api].some(
      (url) =>
        !isLoopback(url) ||
        !/^https?:$/.test(url.protocol) ||
        !!(url.username || url.password || url.search || url.hash) ||
        url.pathname !== '/',
    ) ||
    !isLoopback(database) ||
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['/pto', '/pto_test'].includes(database.pathname) ||
    [...database.searchParams].some(([name, value]) => name !== 'schema' || value !== 'public')
  ) {
    throw new Error(
      'Versioned-write tests require a loopback app, API and disposable PTO database.',
    );
  }
  return app.origin;
}

async function createPtoAndCapture(
  page: Page,
  date: string,
  dayPart: string,
): Promise<VersionedPTO> {
  await page.getByRole('button', { name: /^add pto$/i }).click();
  await page.getByLabel(/start date/i).fill(date);
  await page.getByLabel(/end date/i).fill(date);
  await page.getByLabel(/day part/i).selectOption(dayPart);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/pto' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /save pto/i }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  return (await response.json()) as VersionedPTO;
}

async function openUpcomingList(page: Page): Promise<void> {
  await page.getByRole('radio', { name: /show upcoming pto list/i }).click();
  await expect(page.getByTestId('upcoming-list')).toBeVisible();
}

/**
 * A controlled own request: the same signed-in member changes the record
 * behind the browser's back, always with the expected version.
 */
async function controlledUpdate(
  page: Page,
  pto: VersionedPTO,
  version: number,
  dayPart: string,
  origin: string,
): Promise<number> {
  const response = await page.request.put(`/pto/${pto.id}`, {
    maxRedirects: 0,
    headers: { 'If-Match': `"${version}"`, Origin: origin },
    data: { startDate: pto.startDate, endDate: pto.endDate, dayPart },
  });
  expect(response.status(), 'the controlled update was refused').toBe(200);
  const body = (await response.json()) as VersionedPTO;
  return body.version;
}

async function readStoredPto(page: Page, id: string): Promise<VersionedPTO | null> {
  const response = await page.request.get(`/pto/${id}`, { maxRedirects: 0 });
  if (response.status() === 404) return null;
  expect(response.status()).toBe(200);
  return (await response.json()) as VersionedPTO;
}

/** Removes exactly this journey's own record, whatever version it has now. */
async function deleteOwnPto(page: Page, id: string, origin: string): Promise<number> {
  const current = await readStoredPto(page, id);
  if (!current) return 404;
  const response = await page.request.delete(`/pto/${id}`, {
    maxRedirects: 0,
    headers: { 'If-Match': `"${current.version}"`, Origin: origin },
  });
  return response.status();
}

test.describe('Issue #256 — versioned PTO writes', () => {
  test.describe.configure({ retries: 0 });

  test('a fresh edit and a fresh delete send the expected version', async ({ page }) => {
    const origin = loopbackOrigin();
    const date = weekdayFromNow(70);
    await login(page, VERSIONED_SEED.dev2.email, VERSIONED_SEED.dev2.password);
    const created = await createPtoAndCapture(page, date, 'morning');

    try {
      expect(created.version).toBe(1);
      await openUpcomingList(page);
      const row = page.getByTestId(`upcoming-row-${created.id}`);
      await expect(row).toBeVisible();

      await row.getByRole('button', { name: /^edit$/i }).click();
      const form = page.getByRole('dialog', { name: /^edit pto$/i });
      await expect(form).toBeVisible();
      await form.getByLabel(/day part/i).selectOption('evening');

      const write = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/pto/${created.id}` &&
          ['PUT', 'PATCH'].includes(response.request().method()),
      );
      await form.getByRole('button', { name: /save pto/i }).click();
      const updated = await write;
      expect(updated.status()).toBe(200);
      expect(updated.request().headers()['if-match']).toBe(`"${created.version}"`);
      const updatedBody = (await updated.json()) as VersionedPTO;
      expect(updatedBody.version).toBe(created.version + 1);
      await expect(form).not.toBeVisible();

      // The delete path states the version it loaded and removes the record.
      await row.getByRole('button', { name: /developer two/i }).click();
      const details = page.getByRole('dialog', { name: /pto details/i });
      await expect(details).toBeVisible();
      await details.getByRole('button', { name: /^delete$/i }).click();
      await expect(details.getByText(/cannot be undone/i)).toBeVisible();
      const deletion = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/pto/${created.id}` &&
          response.request().method() === 'DELETE',
      );
      await details.getByRole('button', { name: /yes, delete/i }).click();
      const deleted = await deletion;
      expect(deleted.status()).toBe(204);
      expect(deleted.request().headers()['if-match']).toBe(`"${updatedBody.version}"`);
      await expect(page.getByTestId(`upcoming-row-${created.id}`)).toHaveCount(0);
    } finally {
      // The journey already removed the record; the cleanup is idempotent.
      expect([204, 404]).toContain(await deleteOwnPto(page, created.id, origin));
    }
  });

  test('a stale update is refused and never overwrites the newer record', async ({ page }) => {
    const origin = loopbackOrigin();
    const date = weekdayFromNow(76);
    await login(page, VERSIONED_SEED.dev2.email, VERSIONED_SEED.dev2.password);
    const created = await createPtoAndCapture(page, date, 'morning');

    try {
      await openUpcomingList(page);
      const row = page.getByTestId(`upcoming-row-${created.id}`);
      await expect(row).toBeVisible();

      await row.getByRole('button', { name: /^edit$/i }).click();
      const form = page.getByRole('dialog', { name: /^edit pto$/i });
      await expect(form).toBeVisible();
      await form.getByLabel(/day part/i).selectOption('evening');

      // The record changes after the browser read it: the write that is
      // already on its way must still be refused.
      let writes = 0;
      let bumping = false;
      await page.route(
        (url) => url.pathname === `/pto/${created.id}`,
        async (route) => {
          const method = route.request().method();
          if (!bumping && (method === 'PUT' || method === 'PATCH')) {
            writes += 1;
            bumping = true;
            try {
              await controlledUpdate(page, created, created.version, 'all_day', origin);
            } finally {
              bumping = false;
            }
          }
          await route.continue();
        },
      );

      const write = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/pto/${created.id}` &&
          ['PUT', 'PATCH'].includes(response.request().method()),
      );
      await form.getByRole('button', { name: /save pto/i }).click();
      const response = await write;
      expect(response.status()).toBe(412);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('STALE_WRITE');
      await expect(page.getByRole('alert').first()).toBeVisible();
      expect(writes, 'the refused write was attempted more than once').toBe(1);

      // The newer record survives untouched.
      const stored = await readStoredPto(page, created.id);
      expect(stored).not.toBeNull();
      expect(stored!.dayPart).toBe('all_day');
      expect(stored!.version).toBe(created.version + 1);

      // Recovery is explicit: reopening the form loads the current record.
      await page.keyboard.press('Escape');
      await expect(form).not.toBeVisible();
      await row.getByRole('button', { name: /^edit$/i }).click();
      const reopened = page.getByRole('dialog', { name: /^edit pto$/i });
      await expect(reopened).toBeVisible();
      await expect(reopened.getByLabel(/day part/i)).toHaveValue('all_day');
    } finally {
      expect(await deleteOwnPto(page, created.id, origin)).toBe(204);
    }
  });

  test('a stale delete is refused and the record survives', async ({ page }) => {
    const origin = loopbackOrigin();
    const date = weekdayFromNow(82);
    await login(page, VERSIONED_SEED.dev2.email, VERSIONED_SEED.dev2.password);
    const created = await createPtoAndCapture(page, date, 'morning');

    try {
      await openUpcomingList(page);
      const row = page.getByTestId(`upcoming-row-${created.id}`);
      await expect(row).toBeVisible();

      // The record changes after the browser read it, so the delete that is
      // already on its way must not remove the newer revision.
      let deletes = 0;
      let bumping = false;
      await page.route(
        (url) => url.pathname === `/pto/${created.id}`,
        async (route) => {
          if (!bumping && route.request().method() === 'DELETE') {
            deletes += 1;
            bumping = true;
            try {
              await controlledUpdate(page, created, created.version, 'all_day', origin);
            } finally {
              bumping = false;
            }
          }
          await route.continue();
        },
      );

      await row.getByRole('button', { name: /developer two/i }).click();
      const details = page.getByRole('dialog', { name: /pto details/i });
      await expect(details).toBeVisible();
      await details.getByRole('button', { name: /^delete$/i }).click();
      await expect(details.getByText(/cannot be undone/i)).toBeVisible();
      const deletion = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/pto/${created.id}` &&
          response.request().method() === 'DELETE',
      );
      await details.getByRole('button', { name: /yes, delete/i }).click();
      const response = await deletion;
      expect(response.status()).toBe(412);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('STALE_WRITE');
      await expect(page.getByRole('alert').first()).toBeVisible();
      expect(deletes, 'the refused delete was attempted more than once').toBe(1);

      // Nothing was deleted.
      const stored = await readStoredPto(page, created.id);
      expect(stored).not.toBeNull();
      expect(stored!.dayPart).toBe('all_day');
      expect(stored!.version).toBe(created.version + 1);
    } finally {
      expect(await deleteOwnPto(page, created.id, origin)).toBe(204);
    }
  });
});
