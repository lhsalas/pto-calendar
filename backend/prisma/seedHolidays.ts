import 'dotenv/config';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env.js';
import { seedDefaults } from '../src/services/holidays/HolidayService.js';
import {
  SUPPORTED_COUNTRY_CODES,
  type SupportedCountryCode,
} from '../src/services/holidays/schemas.js';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  LEAD_EMAIL: z.string().email().optional(),
});

function parseArgs(argv: string[]): { countryCode?: string } {
  const args: { countryCode?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--country' && i + 1 < argv.length) {
      args.countryCode = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  loadEnv();
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error('Invalid environment for db:seed-holidays: DATABASE_URL is required.');
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.countryCode) {
    throw new Error(`db:seed-holidays requires --country=<${SUPPORTED_COUNTRY_CODES.join('|')}>`);
  }
  if (!(SUPPORTED_COUNTRY_CODES as readonly string[]).includes(args.countryCode)) {
    throw new Error(
      `Unsupported country "${args.countryCode}". Supported: ${SUPPORTED_COUNTRY_CODES.join(', ')}.`,
    );
  }
  const countryCode = args.countryCode as SupportedCountryCode;

  const prisma = new PrismaClient();
  try {
    const actor = parsed.data.LEAD_EMAIL
      ? await prisma.user.findUnique({ where: { email: parsed.data.LEAD_EMAIL.toLowerCase() } })
      : await prisma.user.findFirst({
          where: { role: 'team_lead' },
          orderBy: { createdAt: 'asc' },
        });
    if (!actor) {
      throw new Error(
        'No team_lead user found. Run `npm run db:bootstrap` first or pass LEAD_EMAIL=...',
      );
    }
    const result = await seedDefaults(countryCode, { id: actor.id });
    // eslint-disable-next-line no-console
    console.log(
      `db:seed-holidays (${countryCode}): inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors.length}`,
    );
    if (result.errors.length > 0) {
      console.error('Errors:');
      for (const e of result.errors) {
        console.error(`  - ${e}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('db:seed-holidays failed:', err);
  process.exit(1);
});
