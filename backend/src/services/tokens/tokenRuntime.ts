import { createTokenDatabase, TokenDatabaseError, type TokenDatabase } from './tokenDatabase.js';

export interface TokenRuntime {
  get(): TokenDatabase;
  close(): Promise<void>;
}

/** One lazy owned pool per application, never per request or module import. */
export function createTokenRuntime(connectionString: string): TokenRuntime {
  let database: TokenDatabase | undefined;
  let closing: Promise<void> | undefined;
  return {
    get() {
      if (closing) throw new TokenDatabaseError();
      database ??= createTokenDatabase(connectionString);
      return database;
    },
    close() {
      closing ??= database ? database.close() : Promise.resolve();
      return closing;
    },
  };
}
