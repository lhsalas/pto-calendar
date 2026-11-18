import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createPrismaClient } from '../../backend/src/lib/prismaClient';

type TestPrismaClient = ReturnType<typeof createPrismaClient>;

const DISPOSABLE_EMAIL_PREFIX = 'e2e-token-settings-';
const DISPOSABLE_PASSWORD = 'e2e-token-settings-password';
const DISPLAY_COLOR = '#10B981';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Only these literal hosts are local targets. */
const APPROVED_HOSTS = ['127.0.0.1', '::1', 'localhost'];
/** The two disposable databases the suite is allowed to touch. */
const APPROVED_DATABASES = ['pto', 'pto_test'];
const WRITE_SCOPES = [
  'pto:create',
  'pto:update:self',
  'pto:delete:self',
  'pto:update:team',
  'pto:delete:team',
];
const TOKEN_SHAPE =
  /^pto_pat_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/;

interface DisposableMember {
  id: string;
  email: string;
  password: string;
}

interface TokenListEntry {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

let apiBaseUrl = '';
/** Standalone API context: no browser context, no browser cookie jar. */
let patApi: APIRequestContext;
let newApiContext: (options: { baseURL: string }) => Promise<APIRequestContext>;
let prisma: TestPrismaClient;
let member: DisposableMember | undefined;

/**
 * Only the literal approved hosts pass. A name such as `127.example.com` is a
 * DNS name, not a loopback address, so a prefix match would be wrong.
 */
function assertApprovedHost(hostname: string, label: string): void {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!APPROVED_HOSTS.includes(host)) {
    throw new Error(
      `${label} must use one of the approved local hosts: ${APPROVED_HOSTS.join(', ')}.`,
    );
  }
}

/**
 * The disposable suite may only touch the designated local database, and only
 * when the environment says so explicitly. There is no fallback: an unset or
 * unexpected value refuses the run instead of guessing a target.
 */
function approvedDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('DATABASE_URL is required; the suite refuses to guess a database.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must be an absolute URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql scheme.');
  }
  assertApprovedHost(url.hostname, 'DATABASE_URL');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!APPROVED_DATABASES.includes(database)) {
    throw new Error('DATABASE_URL must target the disposable /pto or /pto_test database.');
  }
  const extra = [...url.searchParams.keys()].filter((key) => key !== 'schema');
  if (extra.length > 0) {
    throw new Error(
      'DATABASE_URL must not carry extra query parameters (no host or port overrides).',
    );
  }
  const schema = url.searchParams.get('schema');
  if (schema !== null && schema !== 'public') {
    throw new Error('DATABASE_URL may only set ?schema=public.');
  }
  return raw;
}

/** The API target must be named explicitly and must stay local and credential-free. */
function approvedApiBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('VITE_API_BASE_URL is required; the suite refuses to guess an API.');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('VITE_API_BASE_URL must be an absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('VITE_API_BASE_URL must use http or https.');
  }
  assertApprovedHost(url.hostname, 'VITE_API_BASE_URL');
  if (url.username !== '' || url.password !== '') {
    throw new Error('VITE_API_BASE_URL must not carry URL credentials.');
  }
  return url.origin;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function currentMember(): DisposableMember {
  if (!member) throw new Error('The disposable member fixture is missing.');
  return member;
}

async function createDisposableMember(): Promise<DisposableMember> {
  const email = `${DISPOSABLE_EMAIL_PREFIX}${randomUUID()}@example.com`;
  const passwordHash = await bcrypt.hash(DISPOSABLE_PASSWORD, 4);
  const created = await prisma.user.create({
    data: {
      name: 'E2E Token Member',
      email,
      role: 'member',
      colorCode: DISPLAY_COLOR,
      passwordHash,
    },
    select: { id: true },
  });
  return { id: created.id, email, password: DISPOSABLE_PASSWORD };
}

/** Exact, scoped cleanup: only the rows this disposable member owns. */
async function deleteDisposableMember(account: DisposableMember): Promise<void> {
  await prisma.personalAccessToken.deleteMany({ where: { ownerId: account.id } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: account.id } });
  await prisma.user.deleteMany({ where: { id: account.id } });
}

async function readControlValue(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const control = element as HTMLInputElement | HTMLTextAreaElement;
    if (typeof control.value === 'string') return control.value;
    return (element.textContent ?? '').trim();
  });
}

async function isReadOnlyControl(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const control = element as HTMLInputElement | HTMLTextAreaElement;
    return control.readOnly === true;
  });
}

/** Reads the selected expiry, whether it is a select, a radio group or an input. */
async function readExpirySelection(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const control = element as HTMLInputElement | HTMLSelectElement;
    if (control instanceof HTMLSelectElement) {
      const option = control.options[control.selectedIndex];
      return `${option?.value ?? ''} ${option?.textContent ?? ''}`.trim();
    }
    if (control.type === 'radio') {
      const group = Array.from(
        document.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${CSS.escape(control.name)}"]`,
        ),
      );
      const checked = group.find((radio) => radio.checked);
      return checked ? `${checked.value} ${checked.textContent ?? ''}`.trim() : '';
    }
    return control.value ?? '';
  });
}

async function loginAsMember(page: Page, account: DisposableMember): Promise<void> {
  await page.goto('/');
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).fill(account.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /^calendar$/i })).toBeVisible();
}

async function openTokenSettings(page: Page): Promise<void> {
  const entry = page
    .getByRole('link', { name: /api access/i })
    .or(page.getByRole('button', { name: /api access/i }));
  await entry.first().click();
  await expect(page).toHaveURL(/\/settings\/tokens$/);
  await expect(page.getByRole('heading', { name: /personal access tokens/i })).toBeVisible();
}

function revealDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: /copy your token/i });
}

/**
 * Runs the issue form and returns the raw token exactly once.
 *
 * The expiry default is read after the form is open: `Expires after` only
 * exists inside the issue dialog.
 */
async function createTokenThroughUi(
  page: Page,
  account: DisposableMember,
  name: string,
): Promise<string> {
  await page.getByRole('button', { name: /generate token/i }).click();

  const expiry = page.getByLabel('Expires after');
  await expect(expiry).toBeVisible();
  expect(await readExpirySelection(expiry), 'the expiry default is not 90 days').toMatch(/90/);

  const nameField = page.getByLabel('Token name');
  await expect(nameField).toBeVisible();
  await nameField.fill(name);
  await page.getByLabel('Current password').fill(account.password);
  await page.getByRole('button', { name: /^create token$/i }).click();

  const dialog = revealDialog(page);
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel('New token');
  await expect(field).toBeVisible();
  expect(await isReadOnlyControl(field), 'the issued token field is not read-only').toBe(true);
  const rawToken = await readControlValue(field);
  expect(TOKEN_SHAPE.test(rawToken), 'the issued token does not have the expected format').toBe(
    true,
  );
  return rawToken;
}

async function dismissRevealDialog(page: Page): Promise<void> {
  const dialog = revealDialog(page);
  await dialog.getByRole('button', { name: /^done$/i }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Compares the clipboard with the issued token inside the page, through the
 * real Clipboard API. Only the boolean result leaves the page, so the secret
 * never reaches an assertion message or a test report.
 */
async function clipboardHoldsToken(page: Page, rawToken: string): Promise<boolean> {
  return page.evaluate(async (expected) => {
    try {
      return (await navigator.clipboard.readText()) === expected;
    } catch {
      return false;
    }
  }, rawToken);
}

function copyAnnouncement(page: Page): Locator {
  return page
    .getByRole('status')
    .or(page.getByRole('alert'))
    .or(page.locator('[aria-live]'))
    .or(page.getByRole('button', { name: /copied/i }))
    .filter({ hasText: /copied/i })
    .first();
}

/** Reads the owned token metadata through a separate, session-authenticated API context. */
async function findOwnedToken(account: DisposableMember, name: string): Promise<TokenListEntry> {
  const session = await newApiContext({ baseURL: apiBaseUrl });
  try {
    const login = await session.post('/auth/login', {
      data: { email: account.email, password: account.password },
    });
    expect(login.status(), 'the disposable member could not open an API session').toBe(200);
    const list = await session.get('/auth/tokens');
    expect(list.status(), 'the owned token list could not be read').toBe(200);
    const body = (await list.json()) as { tokens: TokenListEntry[] };
    const entry = body.tokens.find((token) => token.name === name);
    expect(entry, `the issued token "${name}" is missing from the owned list`).toBeTruthy();
    return entry!;
  } finally {
    await session.dispose();
  }
}

/** Probes the identity route with the bearer token only: no browser cookies. */
async function probeIdentity(rawToken: string): Promise<{ status: number; method: string | null }> {
  const response = await patApi.get('/auth/me', {
    headers: { Authorization: `Bearer ${rawToken}` },
  });
  if (!response.ok()) return { status: response.status(), method: null };
  const body = (await response.json()) as { auth?: { method?: string } };
  return { status: response.status(), method: body.auth?.method ?? null };
}

async function tabTo(page: Page, target: Locator, maxPresses = 60): Promise<boolean> {
  for (let index = 0; index < maxPresses; index += 1) {
    await page.keyboard.press('Tab');
    const focused = await target
      .evaluate((element) => element === document.activeElement)
      .catch(() => false);
    if (focused) return true;
  }
  return false;
}

async function focusIndicatorPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return false;
    const style = window.getComputedStyle(active);
    const hasRing = style.boxShadow !== 'none' && style.boxShadow !== '';
    const hasOutline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
    return hasRing || hasOutline;
  });
}

test.beforeAll(async ({ playwright }) => {
  const databaseUrl = approvedDatabaseUrl(process.env.DATABASE_URL);
  apiBaseUrl = approvedApiBaseUrl(process.env.VITE_API_BASE_URL);
  // A synthetic credential probe never follows a redirect: the answer has to
  // come from the endpoint that was addressed.
  newApiContext = (options) => playwright.request.newContext({ ...options, maxRedirects: 0 });
  patApi = await newApiContext({ baseURL: apiBaseUrl });
  prisma = createPrismaClient(databaseUrl);
});

test.afterAll(async () => {
  await patApi?.dispose();
  await prisma?.$disconnect();
});

test.beforeEach(async () => {
  // Drop any earlier reference first: a failed setup must not leave a stale
  // member behind for the cleanup hook to act on.
  member = undefined;
  member = await createDisposableMember();
});

test.afterEach(async () => {
  const created = member;
  member = undefined;
  if (created) await deleteDisposableMember(created);
});

test.describe('Issue #254 — own personal access tokens', () => {
  test.describe.configure({ retries: 0 });

  test('the token settings route stays behind the signed-in member guard', async ({ page }) => {
    await page.goto('/settings/tokens');
    await expect(page).toHaveURL(/\/login$/);

    await loginAsMember(page, currentMember());
    await openTokenSettings(page);

    await test.step('the local-target guards refuse anything but the approved targets', () => {
      expect(() => approvedDatabaseUrl(undefined)).toThrow();
      expect(() => approvedApiBaseUrl(undefined)).toThrow();
      // A DNS name that looks like a loopback address is not a loopback address.
      expect(() =>
        approvedDatabaseUrl('postgresql://pto:pto@127.example.com:5432/pto_test?schema=public'),
      ).toThrow();
      expect(() => approvedApiBaseUrl('http://localhost.example.com:3000')).toThrow();
      expect(() =>
        approvedDatabaseUrl('postgresql://pto:pto@127.0.0.1:5432/production?schema=public'),
      ).toThrow();
      expect(() =>
        approvedDatabaseUrl('postgresql://pto:pto@127.0.0.1:5432/pto_test?schema=other'),
      ).toThrow();
      expect(() =>
        approvedDatabaseUrl('postgresql://pto:pto@127.0.0.1:5432/pto_test?host=db.internal'),
      ).toThrow();
      expect(() => approvedDatabaseUrl('mysql://pto:pto@127.0.0.1:3306/pto_test')).toThrow();
      expect(() => approvedApiBaseUrl('http://user:secret@127.0.0.1:3000')).toThrow();
      expect(() => approvedApiBaseUrl('ftp://127.0.0.1:3000')).toThrow();
      // The approved targets still pass.
      expect(
        approvedDatabaseUrl('postgresql://pto:pto@127.0.0.1:5432/pto_test?schema=public'),
      ).toContain('pto_test');
      expect(approvedApiBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    });
  });

  test('a member issues a read-only 90-day token and can copy it exactly once', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await loginAsMember(page, currentMember());
    await openTokenSettings(page);

    const tokenName = `e2e-issue-${randomUUID().slice(0, 8)}`;
    const rawToken = await createTokenThroughUi(page, currentMember(), tokenName);

    const entry = await findOwnedToken(currentMember(), tokenName);
    expect(entry.scopes, 'the issued token is not read-only').toContain('pto:read');
    expect(entry.scopes, 'note reading must stay an explicit opt-in').not.toContain(
      'pto:notes:read',
    );
    expect(
      entry.scopes.filter((scope) => WRITE_SCOPES.includes(scope)),
      'the issued token carries a write scope',
    ).toEqual([]);
    expect(
      Math.round((Date.parse(entry.expiresAt) - Date.parse(entry.createdAt)) / DAY_MS),
      'the issued token does not expire after 90 days',
    ).toBe(90);

    await expect(page.getByText(tokenName, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/pto_pat_/).first()).toBeVisible();

    await revealDialog(page)
      .getByRole('button', { name: /^copy token$/i })
      .click();
    await page.bringToFront();
    await expect
      .poll(async () => clipboardHoldsToken(page, rawToken), {
        message: 'the copy action did not place the issued token on the clipboard',
        timeout: 10_000,
      })
      .toBe(true);
    await expect(copyAnnouncement(page)).toBeVisible();

    await dismissRevealDialog(page);
    await expect(page.getByLabel('New token')).toHaveCount(0);

    await page.getByRole('link', { name: /back to calendar/i }).click();
    await expect(page.getByRole('heading', { name: /^calendar$/i })).toBeVisible();
    await page.getByRole('link', { name: /api access/i }).click();
    await expect(page.getByRole('heading', { name: /personal access tokens/i })).toBeVisible();
    await expect(page.getByLabel('New token'), 'the one-time token came back').toHaveCount(0);
  });

  test('a fresh token authorizes the identity route without cookies and is denied after revocation', async ({
    page,
  }) => {
    await loginAsMember(page, currentMember());
    await openTokenSettings(page);

    const tokenName = `e2e-revoke-${randomUUID().slice(0, 8)}`;
    const rawToken = await createTokenThroughUi(page, currentMember(), tokenName);
    await dismissRevealDialog(page);

    expect((await patApi.storageState()).cookies, 'the probe context carried cookies').toHaveLength(
      0,
    );
    const before = await probeIdentity(rawToken);
    expect(before.status, 'the fresh token did not authorize the identity route').toBe(200);
    expect(before.method, 'the identity route was not served by the personal token').toBe('pat');

    await page
      .getByRole('button', { name: new RegExp(`Revoke ${escapeRegExp(tokenName)}`, 'i') })
      .click();
    const dialog = page.getByRole('dialog').filter({ hasText: /revoke token/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/password/i), 'revocation asked for a password').toHaveCount(0);
    await dialog.getByRole('button', { name: /^confirm revocation$/i }).click();

    const card = page.getByRole('listitem').filter({ hasText: tokenName });
    await expect(card, 'the revoked token is still listed as active').toContainText(/revoked/i);
    const after = await probeIdentity(rawToken);
    expect(after.status, 'the revoked token still authorized the identity route').toBe(401);

    const entry = await findOwnedToken(currentMember(), tokenName);
    expect(entry.revokedAt, 'the revoked token is still listed as active').not.toBeNull();
  });

  test('revoke all denies every token the member owns', async ({ page }) => {
    await loginAsMember(page, currentMember());
    await openTokenSettings(page);

    const firstName = `e2e-all-a-${randomUUID().slice(0, 8)}`;
    const secondName = `e2e-all-b-${randomUUID().slice(0, 8)}`;
    const first = await createTokenThroughUi(page, currentMember(), firstName);
    await dismissRevealDialog(page);
    const second = await createTokenThroughUi(page, currentMember(), secondName);
    await dismissRevealDialog(page);

    expect((await probeIdentity(first)).status).toBe(200);
    expect((await probeIdentity(second)).status).toBe(200);

    await page.getByRole('button', { name: /revoke all tokens/i }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: /revoke all tokens/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/password/i), 'revocation asked for a password').toHaveCount(0);
    await dialog.getByRole('button', { name: /^confirm revocation$/i }).click();

    for (const name of [firstName, secondName]) {
      const card = page.getByRole('listitem').filter({ hasText: name });
      await expect(card, `the token "${name}" is still listed as active`).toContainText(/revoked/i);
    }

    expect((await probeIdentity(first)).status, 'a revoked token still authorized the route').toBe(
      401,
    );
    expect((await probeIdentity(second)).status, 'a revoked token still authorized the route').toBe(
      401,
    );
  });

  test('the revoke dialog is keyboard operable and returns focus to its trigger', async ({
    page,
  }) => {
    await loginAsMember(page, currentMember());
    await openTokenSettings(page);

    const tokenName = `e2e-keyboard-${randomUUID().slice(0, 8)}`;
    await createTokenThroughUi(page, currentMember(), tokenName);
    await dismissRevealDialog(page);

    const revokeButton = page.getByRole('button', {
      name: new RegExp(`Revoke ${escapeRegExp(tokenName)}`, 'i'),
    });
    await expect(revokeButton).toBeVisible();
    expect(
      await tabTo(page, revokeButton),
      'the revoke control was not reachable with the keyboard',
    ).toBe(true);
    expect(await focusIndicatorPresent(page), 'the focused control showed no focus indicator').toBe(
      true,
    );

    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog').filter({ hasText: /revoke token/i });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(revokeButton, 'focus did not return to the revoke control').toBeFocused();
  });

  test('the settings page stays usable in dark mode at a narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await loginAsMember(page, currentMember());
    await page.getByTestId('theme-option-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await openTokenSettings(page);
    await expect(page.locator('html')).toHaveClass(/dark/);

    // A real token card carries the widest content on the page (the display
    // prefix), so the responsive check runs against a populated list.
    await createTokenThroughUi(page, currentMember(), `e2e-narrow-${randomUUID().slice(0, 8)}`);
    await dismissRevealDialog(page);
    await expect(page.getByText(/pto_pat_/).first()).toBeVisible();

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      overflow.scrollWidth,
      'the settings page overflows horizontally at a 360px viewport',
    ).toBeLessThanOrEqual(overflow.clientWidth + 1);
  });
});
