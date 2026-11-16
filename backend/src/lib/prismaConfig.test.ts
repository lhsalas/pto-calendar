import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../prisma.config.js';

describe('Prisma CLI configuration', () => {
  it('keeps the schema, migrations and seed paths relative to the backend config', () => {
    expect(config.schema).toBe('prisma/schema.prisma');
    expect(config.migrations).toMatchObject({
      path: 'prisma/migrations',
    });
    expect(config.datasource?.url).toBe(process.env.DATABASE_URL);
  });

  it('dispatches the config-relative seed from root and backend cwd without executing it', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "prisma seed ' fixture-"));
    try {
      const backend = path.join(fixture, 'backend');
      const schemaDir = path.join(backend, 'prisma');
      const bin = path.join(fixture, 'bin');
      mkdirSync(schemaDir, { recursive: true });
      mkdirSync(bin);
      const seed = path.join(schemaDir, 'seed.ts');
      writeFileSync(seed, "throw new Error('the fixture seed must not run');\n");
      writeFileSync(
        path.join(schemaDir, 'schema.prisma'),
        'datasource db { provider = "postgresql" }\n',
      );
      writeFileSync(
        path.join(backend, 'prisma.config.ts'),
        readFileSync(new URL('../../prisma.config.ts', import.meta.url)),
      );
      const modules = fileURLToPath(new URL('../../../node_modules', import.meta.url));
      symlinkSync(modules, path.join(fixture, 'node_modules'), 'dir');
      const stub = path.join(bin, 'tsx');
      writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$#" "$1" > "$SEED_RECEIPT"\n');
      chmodSync(stub, 0o700);
      symlinkSync(process.execPath, path.join(bin, 'node'));
      const emptyEnv = path.join(fixture, 'empty.env');
      writeFileSync(emptyEnv, '');
      const cli = path.join(modules, 'prisma', 'build', 'index.js');
      for (const [cwd, args] of [
        [fixture, ['db', 'seed', '--config=backend/prisma.config.ts']],
        [backend, ['db', 'seed']],
      ] as const) {
        const receipt = path.join(fixture, cwd === fixture ? 'root.txt' : 'backend.txt');
        const result = spawnSync(process.execPath, [cli, ...args], {
          cwd,
          env: {
            HOME: fixture,
            PATH: bin,
            LANG: 'C.UTF-8',
            DATABASE_URL: 'postgresql://pto:pto@127.0.0.1:1/pto_test?schema=public',
            DOTENV_CONFIG_PATH: emptyEnv,
            CHECKPOINT_DISABLE: '1',
            PRISMA_HIDE_UPDATE_MESSAGE: '1',
            SEED_RECEIPT: receipt,
          },
          encoding: 'utf8',
          timeout: 20_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr + result.stdout).toBe(0);
        expect(readFileSync(receipt, 'utf8').trim().split('\n')).toEqual([cwd, '1', seed]);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 45_000);

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
