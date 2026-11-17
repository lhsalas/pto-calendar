import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('token persistence diagnostics', () => {
  it.each(['prisma:client', '*'])(
    'does not expose digests with DEBUG=%s on success or failure',
    (debug) => {
      for (const fail of [false, true]) {
        // The transport is synthetic and cannot open a socket. The actual service,
        // native transaction wrapper and crypto run unchanged in the subprocess.
        const source = `
        import { tokenDatabaseFromPool } from ${JSON.stringify(new URL('./tokenDatabase.ts', import.meta.url).href)};
        import { issueToken } from ${JSON.stringify(new URL('./tokenService.ts', import.meta.url).href)};
        let digest;
        const client = {
          async query(sql, values) {
            if (sql.includes('FOR UPDATE')) return { rows: [{ id: 'owner', role: 'member', passwordHash: 'synthetic', sessionVersion: 0 }] };
            if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
            if (sql.trimStart().startsWith('INSERT')) {
              digest = values[4];
              if (${JSON.stringify(fail)}) throw new Error('synthetic failing row: ' + digest);
              return { rows: [{ id: values[0], name: values[2], displayPrefix: values[3], scopes: values[5],
                createdAt: new Date(values[7].replace(' ', 'T') + 'Z'),
                expiresAt: new Date(values[8].replace(' ', 'T') + 'Z'), lastUsedAt: null, revokedAt: null }] };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {}
        };
        const db = tokenDatabaseFromPool({ connect: async () => client });
        let output;
        try {
          const issued = await issueToken(db, 'owner', 0, { name: 'synthetic' });
          output = { ok: true, rawToken: issued.rawToken, token: issued.token };
        } catch (error) {
          output = { ok: false, error: String(error), hasCause: 'cause' in error };
        }
        await db.close();
        // Private test protocol, not application diagnostics or persisted data.
        process.stdout.write(JSON.stringify({ ...output, digest }));
      `;
        const child = spawnSync(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', source],
          {
            encoding: 'utf8',
            env: { ...process.env, DEBUG: debug },
            timeout: 15000,
          },
        );
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        const packet = JSON.parse(child.stdout) as {
          digest: string;
          ok: boolean;
          rawToken?: string;
          token?: Record<string, unknown>;
          error?: string;
          hasCause?: boolean;
        };
        expect(packet.digest).toMatch(/^[a-f0-9]{64}$/);
        expect(packet.ok).toBe(!fail);
        expect(child.stderr).not.toContain(packet.digest);
        expect(child.stderr).not.toMatch(/pto_pat_[a-f0-9-]{36}\.[a-f0-9]{64}/);
        if (fail) {
          expect(packet.error).toBe('TokenOperationError: Token operation failed');
          expect(packet.error).not.toContain(packet.digest);
          expect(packet.hasCause).toBe(false);
        } else {
          expect(packet.token).not.toHaveProperty('secretDigest');
          expect(child.stderr).not.toContain(packet.rawToken);
        }
      }
    },
  );
});
