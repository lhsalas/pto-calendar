import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../prisma.config.js';

describe('Prisma CLI configuration', () => {
  it('keeps the schema, migrations and seed paths relative to the backend config', () => {
    expect(config.schema).toBe('prisma/schema.prisma');
    expect(config.migrations).toMatchObject({
      path: 'prisma/migrations',
      seed: 'tsx prisma/seed.ts',
    });
    expect(config.datasource?.url).toBe(process.env.DATABASE_URL);
  });

  it('retains workspace migration and seed entrypoints', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:migrate:deploy']).toBe('prisma migrate deploy');
    expect(pkg.scripts['db:seed']).toBe('tsx prisma/seed.ts');
    expect(pkg.scripts['db:bootstrap']).toBe('tsx prisma/bootstrap.ts');
    expect(pkg.scripts['db:seed-holidays']).toBe('tsx prisma/seedHolidays.ts');
  });

  it('keeps the runtime config available to the production migration command', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    const compose = readFileSync(
      new URL('../../../docker-compose.prod.yml', import.meta.url),
      'utf8',
    );
    expect(dockerfile).toContain(
      'COPY --from=build /app/backend/prisma.config.ts ./backend/prisma.config.ts',
    );
    expect(compose).toContain('--config=backend/prisma.config.ts');
  });
});
