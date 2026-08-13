import 'dotenv/config';
import { z } from 'zod';
import { PrismaClient, Role } from '@prisma/client';
import {
  createUser,
  generateSetupToken,
  hashSetupToken,
} from '../src/services/users/UserService.js';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  LEAD_EMAIL: z.string().email(),
  LEAD_NAME: z.string().min(1).max(120).default('Team Lead'),
  LEAD_COLOR_CODE: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#3B82F6'),
  APP_PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
});

type BootstrapEnv = z.infer<typeof EnvSchema>;

function parseArgs(argv: string[]): { baseUrl?: string } {
  const args: { baseUrl?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url' && i + 1 < argv.length) {
      args.baseUrl = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment for db:bootstrap:\n${issues}\n` +
        `Required env: LEAD_EMAIL, DATABASE_URL. Optional: LEAD_NAME, LEAD_COLOR_CODE, APP_PUBLIC_BASE_URL.`,
    );
  }
  const env: BootstrapEnv = parsed.data;
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args.baseUrl ?? env.APP_PUBLIC_BASE_URL).replace(/\/$/, '');

  const prisma = new PrismaClient();
  try {
    const email = env.LEAD_EMAIL.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && existing.passwordHash) {
      // eslint-disable-next-line no-console
      console.log(`Lead already set up (${existing.email}, id=${existing.id}). Nothing to do.`);
      return;
    }
    if (existing && !existing.passwordHash) {
      // Existing lead with no password — regenerate the setup token and print the link.
      const { plaintext, hash, expiresAt } = generateSetupToken();
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          setupTokenHash: hash,
          setupTokenExpiresAt: expiresAt,
        },
      });
      // eslint-disable-next-line no-console
      console.log(
        `Lead already exists with no password (${existing.email}). ` +
          `Issued a fresh setup token. The link is valid until ${expiresAt.toISOString()}:`,
      );
      // eslint-disable-next-line no-console
      console.log(`${baseUrl}/setup-account#token=${plaintext}`);
      return;
    }
    const setupToken = generateSetupToken();
    const lead = await createUser({
      email,
      name: env.LEAD_NAME,
      role: Role.team_lead,
      colorCode: env.LEAD_COLOR_CODE,
      setupToken,
    });
    // eslint-disable-next-line no-console
    console.log(`Created team lead ${lead.email} (id=${lead.id}).`);
    // eslint-disable-next-line no-console
    console.log(`Setup link (valid until ${setupToken.expiresAt.toISOString()}):`);
    // eslint-disable-next-line no-console
    console.log(`${baseUrl}/setup-account#token=${setupToken.plaintext}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('db:bootstrap failed:', err);
  process.exit(1);
});

// hashSetupToken is re-exported from UserService; importing it here keeps
// the export surface stable for future expansion (e.g. a CLI that accepts
// a plaintext token and prints a hash). Tree-shake-safe.
void hashSetupToken;
