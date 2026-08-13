import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const nodeScript = `
  import { assertStrongEncryptionKey } from './bin/backupSecurity.mjs';
  assertStrongEncryptionKey(process.env.TEST_ENCRYPTION_KEY ?? '');
`;

function validateKey(key: string): number {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', nodeScript], {
    cwd: repoRoot,
    env: { ...process.env, TEST_ENCRYPTION_KEY: key },
    encoding: 'utf8',
  });
  return result.status ?? 1;
}

describe('backup security helpers', () => {
  it('accepts a random-looking key', () => {
    expect(validateKey('aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+nN9?xY0z')).toBe(0);
  });

  it('rejects short, low-diversity, and placeholder keys', () => {
    expect(validateKey('short-key')).not.toBe(0);
    expect(validateKey('a'.repeat(64))).not.toBe(0);
    expect(validateKey('password-' + 'a'.repeat(64))).not.toBe(0);
  });

  it('rejects unsafe restore archive paths before invoking external tools', () => {
    const result = spawnSync(
      process.execPath,
      ['bin/restore-backup.mjs', '--archive', '../../etc/passwd', '--allow-disposable-target'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BACKUP_BUCKET: 'backup-bucket',
          TARGET_DATABASE_URL: 'postgresql://target.example.test/target',
          ENCRYPTION_KEY: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+nN9?xY0z',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('archive name must be a generated');
  });

  it('requires explicit disposable-target confirmation', () => {
    const result = spawnSync(
      process.execPath,
      ['bin/restore-backup.mjs', '--archive', 'pto-20260810T030000Z.tar.gz.gpg'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BACKUP_BUCKET: 'backup-bucket',
          TARGET_DATABASE_URL: 'postgresql://target.example.test/target',
          ENCRYPTION_KEY: 'aB1!cD2@eF3#gH4$iJ5%kL6&mN7*oP8+nN9?xY0z',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'refusing restore without --allow-disposable-target confirmation',
    );
  });
});
