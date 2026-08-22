# Deferred GCP/Firebase Custom-Domain Plan

Tracking issue: [#163](https://github.com/lhsalas/pto-calendar/issues/163)

This work is **not required for the OCI single-host deployment**. OCI serves
the SPA and API behind one hostname, so the session cookie is first-party and
does not need the Firebase/Cloud Run split-origin arrangement.

Keep this document if production later returns to Firebase Hosting and Cloud
Run.

## Target topology

```text
Browser -> Firebase Hosting: app.<domain>
        -> Cloud Run: api.<domain>
        -> Supabase PostgreSQL
```

Both application hosts share the same parent domain. The Cloud Run service
remains public because application authentication is handled by the API.

## Required configuration

- `FIREBASE_SITE_ORIGIN=https://app.<domain>`.
- `APP_API_ORIGIN=https://api.<domain>`.
- `VITE_API_BASE_URL=https://api.<domain>` at frontend build time.
- `CORS_ORIGIN=https://app.<domain>`.
- `COOKIE_SAME_SITE=lax`.
- `COOKIE_SECURE=true`.
- Empty `COOKIE_DOMAIN` so the API cookie remains host-only.
- Firebase CSP `connect-src` contains exactly `https://api.<domain>`.
- `TRUST_PROXY_HOPS=1` for the Cloud Run ingress path.
- `RATE_LIMIT_REDIS_URL` points to the shared TLS Redis/Valkey store.

## Rollout steps

1. Add `app.<domain>` as a Firebase Hosting custom domain and publish the
   records Firebase provides.
2. Add `api.<domain>` as a Cloud Run domain mapping and publish its records.
3. Wait for both managed TLS certificates to become active.
4. Change the GCP fallback workflow variables to the exact custom origins.
5. Build the frontend with `VITE_API_BASE_URL=https://api.<domain>`.
6. Render Firebase configuration with the exact API origin and reject wildcard
   CSP values.
7. Deploy the GCP fallback workflows manually from a tested commit.
8. Test login and a state-changing request with third-party cookies blocked.
9. Test Safari/iOS, private browsing, Firefox Total Cookie Protection, and
   Chromium third-party-cookie blocking.
10. Keep the origin/CSRF rejection tests in the backend and E2E suites.

## Acceptance criteria

- Login from `app.<domain>` sets a `Secure`, `HttpOnly`, `SameSite=Lax` cookie.
- The next state-changing request carries the cookie without third-party-cookie
  exceptions.
- A different `Origin` receives `403 CSRF_REJECTED`.
- Firebase CSP contains the exact API origin and no wildcard.
- Cloud Run `/health` and `/ready` pass from the Firebase origin.
- GCP deploy, backup, and rollback documentation is validated before switching
  production back.

The current OCI release should not implement these steps or enable the GCP
tag-triggered deployment path. The GCP workflows remain manual-only until this
plan is deliberately resumed.
