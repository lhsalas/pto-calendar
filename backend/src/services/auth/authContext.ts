import type { ActorContext } from '../authorization/AuthorizationService.js';
import type { TokenScope } from '../tokens/tokenDomain.js';

/** Shared authorization deliberately contains no browser credential version. */
export type AuthContext = {
  actor: ActorContext;
  requestId: string;
} & (
  | { method: 'session' }
  | {
      method: 'pat';
      tokenId: string;
      scopes: readonly TokenScope[];
      expiresAt: Date;
    }
);

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}
