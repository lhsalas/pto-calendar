# `@pto-calendar/api-client`

Shared, runtime-neutral typed HTTP client for the PTO Calendar REST API
(issue [#259]). It is the single place where the REST contract is encoded, so
the future CLI and local MCP adapters can share one tested implementation
instead of shelling out to each other.

> **Private and unpublished.** This package is `private: true` in an npm
> workspace. It is **not** published to any registry, it has no release
> schedule, and no public SDK support, semantic-versioning or stability promise
> is made for it. Consumers inside this repository use it from the local
> workspace source.

## Boundaries

- **Runtime-neutral Node ESM.** No Vite, no browser globals, no DOM, no cookie
  jar and no database driver. The only runtime dependency is the platform
  `fetch` provided by the supported Node.js baseline.
- **Explicit base origin and credential injection.** The caller supplies the
  base URL, the credential origin and the token. The client never discovers a
  credential, never reads an ambient environment variable for one and never
  stores one.
- **Trusted HTTPS origin.** HTTPS is required; plain HTTP is accepted only for
  an explicit loopback development opt-in with `127.0.0.1`, `[::1]` or
  `localhost`. Alternate IP spellings and non-root URL paths are refused.
- **No arbitrary request surface.** Callers cannot supply a request URL, a
  header map or a redirect target. The client constructs every request
  internally against the frozen origin.
- **Bounded reads.** Single requests default to a 15-second deadline. A
  trusted caller can opt in to at most two retries after the first read
  attempt. Request deadlines include reading the body and waiting between
  attempts. An excessive or unrecognized `Retry-After` suppresses the retry.
- **No automatic write retry.** To explicitly replay a create within its
  deadline, submit the same key and payload with the same credential. The
  client never mints a key. An expired or uncertain result needs reconciliation,
  not another write with a fresh key. PATCH and DELETE do not have replay keys.

## Supported Node.js baseline

`>=24.22.3`, the same floor as the repository root `engines.node` and the
`.nvmrc` pin. The package is built and consumed as ESM with type declarations.

## Layout

| Path                | Owner          | Purpose                                         |
| ------------------- | -------------- | ----------------------------------------------- |
| `src/transport.ts`  | transport lane | Origin-bound HTTP transport, retries and aborts |
| `src/errors.ts`     | transport lane | Sanitized `PtoApiError` envelope                |
| `src/origin.ts`     | transport lane | Trusted-origin normalization and validation     |
| `src/index.ts`      | domain lane    | Public entry point                              |
| `src/wire.ts`       | domain lane    | Response/request wire parsing                   |
| `src/client.ts`     | domain lane    | Typed client operations                         |
| `src/pagination.ts` | domain lane    | Bounded paged traversal                         |

Relative imports inside `src/` use the explicit `.js` extension required by
the `NodeNext` module resolution used here, matching the backend convention.

## Usage (vetted, placeholder-only)

The snippet below shows the intended call shape for a **local source
consumer**. Every secret is a placeholder: no real token, origin or personal
data appears here, and there is deliberately no shell command that would put a
credential on a command line.

```ts
import { createPtoClient } from '@pto-calendar/api-client';

const client = createPtoClient({
  // Explicit trusted base URL. HTTPS is required outside loopback development.
  baseUrl: '<trusted-https-origin-placeholder>',
  // The credential origin is bound explicitly and must normalize to the same
  // origin as the base URL.
  credential: {
    origin: '<trusted-https-origin-placeholder>',
    token: '<personal-token-placeholder>',
  },
});

const identity = await client.getIdentity();
const page = await client.listPage({ start: '<start-date>', end: '<end-date>' });
```

`listAll` includes `complete`, `reason` and `pages` alongside `items`. If
`complete` is false, the rows are partial and must not be treated as the
whole result. Even when traversal completes, it isn't a snapshot.

Errors are always reported through the sanitized `PtoApiError` envelope
(`code`, `status`, `requestId`, `retryAfterMs`, `unknownWriteOutcome`). The
upstream message, body, URL, headers and token are never copied into an error.

## Scripts

Run from the repository root with `-w packages/api-client`:

| Command                                        | Effect                                     |
| ---------------------------------------------- | ------------------------------------------ |
| `npm run build -w packages/api-client`         | Emit `dist/` ESM plus `.d.ts` declarations |
| `npm run lint -w packages/api-client`          | ESLint over the package                    |
| `npm run typecheck -w packages/api-client`     | `tsc --noEmit` over sources and tests      |
| `npm run test -w packages/api-client`          | Vitest unit suite                          |
| `npm run test:coverage -w packages/api-client` | Vitest unit suite with the coverage gate   |

The root `lint`, `typecheck`, `test`, `test:coverage` and `build` scripts
include this package.

## Coverage policy

`vitest.config.ts` is the real gate. Package totals require at least **90%**
lines, statements and functions and at least **80%** branches. The
security-sensitive surfaces (origin binding, the error envelope, the transport
and retry policy, the wire parser and input validation) require **100%** on
every metric. Only test files are excluded from the report; no source file is
exempt.

## Related

- [`docs/openapi.yaml`](../../docs/openapi.yaml) — the REST contract the
  client is typed against.
- [`docs/agent-access-delivery-plan.md`](../../docs/agent-access-delivery-plan.md)
  — the approved delivery plan and the shared security contract.
