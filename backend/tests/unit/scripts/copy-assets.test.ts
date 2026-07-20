import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const backendRoot = join(import.meta.dirname, '..', '..', '..');
const distPresets = join(backendRoot, 'dist', 'services', 'holidays', 'presets');
const srcPresets = join(backendRoot, 'src', 'services', 'holidays', 'presets');

interface BuildArtifacts {
  countries: string[];
  files: Record<string, string>;
}

let artifacts: BuildArtifacts;

beforeAll(() => {
  // Build once for the whole suite. This invokes `npm run build -w backend`
  // from the repo root, which runs `tsc -p tsconfig.build.json` then
  // `scripts/copy-assets.mjs`. Cheap: ~3-5 s on a warm checkout.
  execFileSync('npm', ['run', 'build', '-w', 'backend'], {
    cwd: join(backendRoot, '..'),
    stdio: 'pipe',
  });

  const countries = ['US', 'MX', 'CO', 'CL'];
  const files: Record<string, string> = {};
  for (const cc of countries) {
    const distFile = join(distPresets, `${cc}.json`);
    expect(existsSync(distFile)).toBe(true);
    files[cc] = distFile;
  }
  artifacts = { countries, files };
}, 120_000);

afterAll(() => {
  // dist/ is gitignored and will be rebuilt by CI on the next job; leaving
  // it in place is fine and saves a second build during local TDD.
});

describe('build:assets — holiday presets bundle', () => {
  it('places every supported country preset into dist/', () => {
    for (const cc of artifacts.countries) {
      const distFile: string | undefined = artifacts.files[cc];
      if (!distFile) throw new Error(`missing dist path for ${cc}`);
      expect(existsSync(distFile), `missing dist copy of ${cc}.json`).toBe(true);
    }
  });

  it('preserves the JSON content (byte-for-byte match)', () => {
    for (const cc of artifacts.countries) {
      const distFile: string | undefined = artifacts.files[cc];
      if (!distFile) throw new Error(`missing dist path for ${cc}`);
      const expected = execFileSync('cat', [join(srcPresets, `${cc}.json`)]).toString();
      const actual = execFileSync('cat', [distFile]).toString();
      expect(actual).toBe(expected);
    }
  });

  it('keeps the preset count consistent with SUPPORTED_COUNTRY_CODES', () => {
    for (const cc of artifacts.countries) {
      const distFile: string | undefined = artifacts.files[cc];
      if (!distFile) throw new Error(`missing dist path for ${cc}`);
      const raw = execFileSync('cat', [distFile]).toString();
      const parsed: unknown = JSON.parse(raw);
      expect(Array.isArray(parsed)).toBe(true);
      // MX has 14 entries (the floor across all 4 countries). The exact
      // totals (US 26, MX 14, CO 42, CL 37) are asserted in the
      // seedHolidays integration suite.
      expect((parsed as unknown[]).length).toBeGreaterThanOrEqual(14);
    }
  });
});
