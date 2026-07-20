import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { SupportedCountryCode } from './schemas.js';

export interface PresetEntry {
  date: string;
  name: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_DIR = join(__dirname, 'presets');

export async function loadPreset(countryCode: SupportedCountryCode): Promise<PresetEntry[]> {
  const path = join(PRESETS_DIR, `${countryCode}.json`);
  const raw = await readFile(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid preset file at ${path}: not an array`);
  }
  return parsed.map((entry, idx) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as PresetEntry).date !== 'string' ||
      typeof (entry as PresetEntry).name !== 'string'
    ) {
      throw new Error(`Invalid preset entry at ${path} index ${idx}`);
    }
    return entry as PresetEntry;
  });
}
