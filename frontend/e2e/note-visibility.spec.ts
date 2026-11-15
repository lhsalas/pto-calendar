import { test, expect } from '@playwright/test';
import type { PTO } from '../src/types/api';

function thirdWeekdayInCurrentMonth(): string {
  const now = new Date();
  let weekdays = 0;
  for (let day = 1; day <= 7; day += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    weekdays += 1;
    if (weekdays === 3) return date.toISOString().slice(0, 10);
  }
  throw new Error('No third weekday in the current month');
}

test('loading an empty PTO note removes the load button for this opening', async ({ page }) => {
  // The other dev2 journey reserves the second weekday; clean up our own PTO
  // so this regression can also be repeated without resetting shared data.
  const day = thirdWeekdayInCurrentMonth();
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
    const deleted = await page.request.delete(`/pto/${pto.id}`);
    expect(deleted.status()).toBe(204);
  }
});
