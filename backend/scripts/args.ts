import { parseArgs } from 'node:util';

export interface SeedHolidaysArgs {
  countryCode?: string;
  all: boolean;
}

export function parseSeedHolidaysArgs(argv: string[]): SeedHolidaysArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      country: { type: 'string' },
      all: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  return { countryCode: values.country, all: values.all === true };
}

export interface BootstrapArgs {
  baseUrl?: string;
}

export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  return { baseUrl: values['base-url'] };
}
