import pg, { type Pool, type QueryResult, type QueryResultRow } from 'pg';

export class TokenDatabaseError extends Error {
  constructor() {
    super('Token database operation failed');
    this.name = 'TokenDatabaseError';
  }
}

export interface TokenConnection {
  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export interface TokenDatabase extends TokenConnection {
  readonly tables: { readonly users: string; readonly tokens: string; readonly audit: string };
  transaction<T>(operation: (client: TokenConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function tableNames(schema: string): TokenDatabase['tables'] {
  if (!schema || schema.includes('\0') || Buffer.byteLength(schema, 'utf8') > 63) {
    throw new TokenDatabaseError();
  }
  const namespace = `"${schema.replaceAll('"', '""')}"`;
  return Object.freeze({
    users: `${namespace}."users"`,
    tokens: `${namespace}."personal_access_tokens"`,
    audit: `${namespace}."audit_logs"`,
  });
}

/**
 * A borrowed pool remains the caller's responsibility. No connection is opened
 * by constructing the wrapper. This boundary deliberately never uses Prisma:
 * Prisma's diagnostic argument logger can disclose persisted token digests.
 */
export function tokenDatabaseFromPool(
  pool: Pool,
  schema = 'public',
  ownsPool = false,
): TokenDatabase {
  const tables = tableNames(schema);
  let closing: Promise<void> | undefined;
  let failed = false;
  const idleError = (): void => {
    // Do not forward driver errors, which can contain failing-row credentials.
    failed = true;
  };
  if (ownsPool) pool.on('error', idleError);

  function ensureOpen(): void {
    if (closing || failed) throw new TokenDatabaseError();
  }

  return {
    tables,
    async query<T extends QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<T>> {
      ensureOpen();
      try {
        return await pool.query<T>(text, values);
      } catch {
        throw new TokenDatabaseError();
      }
    },
    async transaction<T>(operation: (client: TokenConnection) => Promise<T>): Promise<T> {
      ensureOpen();
      const client = await pool.connect().catch(() => {
        throw new TokenDatabaseError();
      });
      let begun = false;
      let discard = false;
      try {
        // The count after waiting for the owner lock needs a fresh snapshot.
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        begun = true;
        const value = await operation({
          async query<R extends QueryResultRow>(
            text: string,
            values?: unknown[],
          ): Promise<QueryResult<R>> {
            try {
              return await client.query<R>(text, values);
            } catch {
              throw new TokenDatabaseError();
            }
          },
        });
        await client.query('COMMIT');
        return value;
      } catch {
        if (begun) {
          try {
            await client.query('ROLLBACK');
          } catch {
            discard = true;
          }
        } else {
          discard = true;
        }
        throw new TokenDatabaseError();
      } finally {
        try {
          client.release(discard);
        } catch {
          throw new TokenDatabaseError();
        }
      }
    },
    close(): Promise<void> {
      if (!closing) {
        closing = ownsPool
          ? Promise.resolve()
              .then(() => pool.end())
              .then(() => {
                pool.removeListener('error', idleError);
              })
              .catch(() => {
                throw new TokenDatabaseError();
              })
          : Promise.resolve();
      }
      return closing;
    },
  };
}

/** Creates one lazy, owned pool; the owner must await close() during shutdown. */
export function createTokenDatabase(connectionString: string): TokenDatabase {
  try {
    const url = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.searchParams.getAll('schema').length > 1
    ) {
      throw new TokenDatabaseError();
    }
    const schema = url.searchParams.get('schema') ?? 'public';
    // Validate identifiers before allocating a pool; data always uses bindings.
    tableNames(schema);
    return tokenDatabaseFromPool(new pg.Pool({ connectionString }), schema, true);
  } catch {
    throw new TokenDatabaseError();
  }
}
