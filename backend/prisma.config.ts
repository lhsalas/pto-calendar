import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { fileURLToPath } from 'node:url';

// Prisma runs seeds in the caller's cwd and splits the command on whitespace
// without shell quote handling. Encode the config-relative path so that spaces
// and quotes survive that split, then pass it to tsx as one argument.
const seedPath = fileURLToPath(new URL('./prisma/seed.ts', import.meta.url));
const encodedSeedPath = Buffer.from(seedPath).toString('base64');
const seedLauncher = `process.exit(require('node:child_process').spawnSync('tsx',[Buffer.from('${encodedSeedPath}','base64').toString(),...process.argv.slice(1)],{stdio:'inherit'}).status??1)`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: `node -e ${seedLauncher}`,
  },
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
