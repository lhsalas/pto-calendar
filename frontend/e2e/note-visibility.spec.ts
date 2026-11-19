import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { PTO } from '../src/types/api';

/**
 * A delete now states the expected record version, so the cleanup reads the
 * current version first and then removes exactly this journey's own record.
 */
async function deleteOwnPto(page: Page, id: string): Promise<number> {
  const detail = await page.request.get(`/pto/${id}`, { maxRedirects: 0 });
  if (detail.status() === 404) return 404;
  expect(detail.status()).toBe(200);
  const current = (await detail.json()) as { version: number };
  const deleted = await page.request.delete(`/pto/${id}`, {
    maxRedirects: 0,
    headers: { 'If-Match': `"${current.version}"` },
  });
  return deleted.status();
}

function nthWeekdayInCurrentMonth(n: number): string {
  const now = new Date();
  let weekdays = 0;
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
    if (date.getUTCMonth() !== now.getUTCMonth()) break;
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    weekdays += 1;
    if (weekdays === n) return date.toISOString().slice(0, 10);
  }
  throw new Error(`No weekday #${n} in the current month`);
}

for (const field of ['day part', 'dates'] as const) {
  test(`direct 90-day list Edit preserves the stored note when changing only ${field}`, async ({
    page,
  }) => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + (field === 'dates' ? 55 : 45));
    while (start.getUTCDay() === 0 || start.getUTCDay() === 6)
      start.setUTCDate(start.getUTCDate() + 1);
    const later = new Date(start);
    later.setUTCDate(later.getUTCDate() + 1);
    while (later.getUTCDay() === 0 || later.getUTCDay() === 6)
      later.setUTCDate(later.getUTCDate() + 1);
    const startDate = start.toISOString().slice(0, 10);
    const editedDate = field === 'dates' ? later.toISOString().slice(0, 10) : startDate;
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev2@example.com');
    await page.getByLabel(/password/i).fill('dev2-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(startDate);
    await page.getByLabel(/end date/i).fill(startDate);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByLabel(/note \(optional\)/i).fill('Doctor');
    const createdResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/pto' && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /save pto/i }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const pto = (await created.json()) as PTO;
    try {
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await page.getByRole('radio', { name: /show upcoming pto list/i }).click();
      const row = page.getByTestId(`upcoming-row-${pto.id}`);
      const detail = page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/pto/${pto.id}` && r.request().method() === 'GET',
      );
      await row.getByRole('button', { name: /^edit$/i }).click();
      expect((await detail).status()).toBe(200);
      const form = page.getByRole('dialog', { name: /^edit pto$/i });
      await expect(form.getByLabel(/note \(optional\)/i)).toHaveValue('Doctor');
      if (field === 'dates') await form.getByLabel(/start date/i).fill(editedDate);
      else await form.getByLabel(/day part/i).selectOption('evening');
      const savedResponse = page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/pto/${pto.id}` && r.request().method() === 'PUT',
      );
      await form.getByRole('button', { name: /save pto/i }).click();
      const saved = await savedResponse;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toEqual({
        startDate: editedDate,
        endDate: editedDate,
        dayPart: field === 'dates' ? 'morning' : 'evening',
        note: 'Doctor',
      });
      await expect(form).not.toBeVisible();
      await row.getByRole('button', { name: /^edit$/i }).click();
      await expect(form.getByLabel(/note \(optional\)/i)).toHaveValue('Doctor');
    } finally {
      expect(await deleteOwnPto(page, pto.id)).toBe(204);
    }
  });
}

test('loading an empty PTO note removes the load button for this opening', async ({ page }) => {
  // The other dev2 journey reserves the second weekday; clean up our own PTO
  // so this regression can also be repeated without resetting shared data.
  const day = nthWeekdayInCurrentMonth(3);
  await page.goto('/');
  await page.getByLabel(/email/i).fill('dev2@example.com');
  await page.getByLabel(/password/i).fill('dev2-dev-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();

  await page.getByRole('button', { name: /^add pto$/i }).click();
  await page.getByLabel(/start date/i).fill(day);
  await page.getByLabel(/end date/i).fill(day);
  await page.getByLabel(/day part/i).selectOption('morning');
  const createdResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/pto' && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /save pto/i }).click();
  const created = await createdResponse;
  expect(created.status()).toBe(201);
  const pto = (await created.json()) as PTO;

  try {
    expect(pto.note).toBeNull();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page
      .getByTestId(`day-cell-${day}`)
      .getByRole('button', { name: /developer two/i })
      .click();
    const dialog = page.getByRole('dialog', { name: /pto details/i });
    const loadNote = dialog.getByRole('button', { name: /^load note$/i });
    // Native definitions have no accessible name; assert focus on the exact persistent target.
    const noteContent = dialog.getByTestId('pto-note-content');
    const noNote = dialog.getByText('(no note)', { exact: true });
    await expect(noteContent).toHaveCount(1);
    await expect(noteContent).toHaveAttribute('tabindex', '-1');
    await expect(noteContent).toHaveAccessibleDescription('Note');
    await expect(loadNote).toBeVisible();
    await expect(noNote).toHaveClass(/text-ink-muted\/70/);

    const detailPath = `/pto/${pto.id}`;
    let detailRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === detailPath) {
        detailRequests += 1;
      }
    });
    let releaseDetail!: () => void;
    const holdDetail = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    await page.route(
      (url) => url.pathname === detailPath,
      async (route) => {
        const response = await route.fetch();
        await holdDetail;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    const detailResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === detailPath && response.request().method() === 'GET',
    );
    await loadNote.focus();
    await expect(loadNote).toBeFocused();
    try {
      await loadNote.press('Enter');
      await expect(dialog.getByRole('status')).toHaveText('Loading note…');
      await expect(noteContent).toBeFocused();
    } finally {
      releaseDetail();
    }
    expect((await detailResponse).status()).toBe(200);
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await expect(loadNote).toHaveCount(0);
    await expect(noNote).toBeVisible();
    await expect(noNote).not.toHaveClass(/text-ink-muted/);
    await expect(noNote).toHaveClass(/text-ink/);
    await expect(noNote).toHaveClass(/dark:text-ink-dark/);
    await expect(noteContent).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: /^close$/i })).toBeFocused();
    await noNote.click();
    expect(detailRequests).toBe(1);
  } finally {
    const deleted = await deleteOwnPto(page, pto.id);
    expect(deleted).toBe(204);
  }
});

for (const scenario of [
  { field: 'day part', startWeekday: 4, editedWeekday: 4, loadFirst: true },
  { field: 'dates', startWeekday: 6, editedWeekday: 7, loadFirst: false },
] as const) {
  test(`editing only ${scenario.field} preserves the private PTO note`, async ({ page }) => {
    // Use distinct dev2 weekdays and remove only this test's own PTO.
    const startDate = nthWeekdayInCurrentMonth(scenario.startWeekday);
    const editedDate = nthWeekdayInCurrentMonth(scenario.editedWeekday);
    const note = 'Doctor appointment';
    await page.goto('/');
    await page.getByLabel(/email/i).fill('dev2@example.com');
    await page.getByLabel(/password/i).fill('dev2-dev-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('heading', { name: /calendar/i })).toBeVisible();
    await page.getByRole('button', { name: /^add pto$/i }).click();
    await page.getByLabel(/start date/i).fill(startDate);
    await page.getByLabel(/end date/i).fill(startDate);
    await page.getByLabel(/day part/i).selectOption('morning');
    await page.getByLabel(/note/i).fill(note);
    const createdResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/pto' && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /save pto/i }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const pto = (await created.json()) as PTO;

    try {
      const detailPath = `/pto/${pto.id}`;
      let detailRequests = 0;
      page.on('request', (request) => {
        if (request.method() === 'GET' && new URL(request.url()).pathname === detailPath) {
          detailRequests += 1;
        }
      });
      const details = page.getByRole('dialog', { name: /pto details/i });
      const form = page.getByRole('dialog', { name: /edit pto/i });
      const chip = (date: string) =>
        page.getByTestId(`day-cell-${date}`).getByRole('button', { name: /developer two/i });
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await chip(startDate).click();
      await expect(details.getByRole('button', { name: /^load note$/i })).toBeVisible();
      if (scenario.loadFirst) {
        await details.getByRole('button', { name: /^load note$/i }).click();
        await expect(details.getByText(note, { exact: true })).toBeVisible();
      }
      await details.getByRole('button', { name: /^edit$/i }).click();
      await expect(form).toBeVisible();
      await expect(form.getByLabel(/note/i)).toHaveValue(note);
      expect(detailRequests).toBe(1);
      if (scenario.field === 'day part') {
        await form.getByLabel(/day part/i).selectOption('evening');
      } else {
        await form.getByLabel(/start date/i).fill(editedDate);
        await expect(form.getByLabel(/end date/i)).toHaveValue(editedDate);
      }
      const savedResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === detailPath && response.request().method() === 'PUT',
      );
      await form.getByRole('button', { name: /save pto/i }).click();
      const saved = await savedResponse;
      expect(saved.status()).toBe(200);
      expect(saved.request().postDataJSON()).toMatchObject({
        startDate: editedDate,
        endDate: editedDate,
        dayPart: scenario.field === 'day part' ? 'evening' : 'morning',
        note,
      });
      expect(((await saved.json()) as PTO).note).toBe(note);
      await expect(form).not.toBeVisible();

      // A fresh details GET proves the stored note survived without relying on form state.
      await chip(editedDate).click();
      await details.getByRole('button', { name: /^load note$/i }).click();
      await expect(details.getByText(note, { exact: true })).toBeVisible();
      expect(detailRequests).toBe(2);

      if (scenario.field === 'day part') {
        await details.getByRole('button', { name: /^edit$/i }).click();
        await expect(form.getByLabel(/note/i)).toHaveValue(note);
        await form.getByLabel(/note/i).fill('');
        const clearedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === detailPath &&
            response.request().method() === 'PUT',
        );
        await form.getByRole('button', { name: /save pto/i }).click();
        const cleared = await clearedResponse;
        expect(cleared.status()).toBe(200);
        expect(cleared.request().postDataJSON()).toHaveProperty('note', '');
        expect(((await cleared.json()) as PTO).note).toBeNull();
        await expect(form).not.toBeVisible();
        await chip(editedDate).click();
        await details.getByRole('button', { name: /^load note$/i }).click();
        await expect(details.getByRole('status')).toHaveCount(0);
        await expect(details.getByRole('button', { name: /^load note$/i })).toHaveCount(0);
        await expect(details.getByText('(no note)', { exact: true })).toBeVisible();
        expect(detailRequests).toBe(3);
      }
    } finally {
      const deleted = await deleteOwnPto(page, pto.id);
      expect(deleted).toBe(204);
    }
  });
}
