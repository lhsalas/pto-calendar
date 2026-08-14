import 'dotenv/config';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { parseSeedHolidaysArgs } from '../scripts/args.js';
import { seedDefaults } from '../src/services/holidays/HolidayService.js';
import {
  SUPPORTED_COUNTRY_CODES,
  type SupportedCountryCode,
} from '../src/services/holidays/schemas.js';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  LEAD_EMAIL: z.string().email().optional(),
});

interface SeedOutcome {
  countryCode: SupportedCountryCode;
  inserted: number;
  skipped: number;
  errors: string[];
}

async function seedOne(
  prisma: PrismaClient,
  actorId: string,
  countryCode: SupportedCountryCode,
): Promise<SeedOutcome> {
  const result = await seedDefaults(countryCode, { id: actorId });
  // eslint-disable-next-line no-console
  console.log(
    `db:seed-holidays (${countryCode}): inserted=${result.inserted} skipped=${result.skipped} errors=${result.errors.length}`,
  );
  if (result.errors.length > 0) {
    console.error(`Errors for ${countryCode}:`);
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
  }
  return { countryCode, ...result };
}

async function main(): Promise<void> {
  // Note: we deliberately do NOT call `loadEnv()` from `src/config/env.js`
  // here. That helper validates the FULL backend env (SESSION_SECRET,
  // COOKIE_SECURE, BCRYPT_ROUNDS, etc.) which only matters when the
  // backend HTTP server is running. This script only needs DATABASE_URL
  // and an optional LEAD_EMAIL; full-env validation would force the
  // docker-compose `migrate` service to inject a SESSION_SECRET it never
  // uses.
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error('Invalid environment for db:seed-holidays: DATABASE_URL is required.');
  }
  const args = parseSeedHolidaysArgs(process.argv.slice(2));
  if (!args.all && !args.countryCode) {
    throw new Error(
      `db:seed-holidays requires either --country=<${SUPPORTED_COUNTRY_CODES.join('|')}> or --all`,
    );
  }
  if (args.all && args.countryCode) {
    throw new Error('db:seed-holidays: --all and --country are mutually exclusive');
  }

  let targets: SupportedCountryCode[];
  if (args.all) {
    targets = [...SUPPORTED_COUNTRY_CODES];
  } else {
    const cc = args.countryCode;
    if (!cc || !(SUPPORTED_COUNTRY_CODES as readonly string[]).includes(cc)) {
      throw new Error(
        `Unsupported country "${cc}". Supported: ${SUPPORTED_COUNTRY_CODES.join(', ')}.`,
      );
    }
    targets = [cc as SupportedCountryCode];
  }

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
    const outcomes: SeedOutcome[] = [];
    for (const cc of targets) {
      outcomes.push(await seedOne(prisma, actor.id, cc));
    }
    if (args.all) {
      const totalInserted = outcomes.reduce((acc, o) => acc + o.inserted, 0);
      const totalSkipped = outcomes.reduce((acc, o) => acc + o.skipped, 0);
      const totalErrors = outcomes.reduce((acc, o) => acc + o.errors.length, 0);
      // eslint-disable-next-line no-console
      console.log(
        `db:seed-holidays --all: ${outcomes.length} countries, inserted=${totalInserted} skipped=${totalSkipped} errors=${totalErrors}`,
      );
    }
    const hadErrors = outcomes.some((o) => o.errors.length > 0);
    if (hadErrors) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('db:seed-holidays failed:', err);
  process.exit(1);
});
