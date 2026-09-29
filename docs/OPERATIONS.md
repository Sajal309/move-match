# Operations and release setup

This is a deployment runbook for a future service owner. No production service, domain, database, Redis instance, mobile signing profile or store submission has been created by this build.

## Required configuration

### Mobile build-time values

Set `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_APP_ENV` and `EXPO_PUBLIC_PROTOCOL_VERSION` in each app build environment. These are public client values. Never put a database password, Redis credential, Supabase service-role key, HMAC secret or signing password in the mobile bundle.

### API private environment

Set `DATABASE_URL`, `DATABASE_SSL=require`, `REDIS_URL`, `SUPABASE_URL`, optional `SUPABASE_JWKS_URL`, `SUPABASE_ISSUER`, `SUPABASE_AUDIENCE=authenticated`, `SUPABASE_SERVICE_ROLE_KEY`, a random `INVITE_CODE_SECRET` of at least 32 characters, `OPS_ADMIN_USER_IDS`, `PUBLIC_SUPPORT_EMAIL`, `PORT`, `HOST` and an appropriate `LOG_LEVEL`. Use a restricted server database identity, TLS, secret-manager storage and network rules that prevent direct public database access.

Supabase also needs adult-account email OTP enabled, a real SMTP sender, the `movematch` application link/scheme configured, and correct production redirect URLs. The service-role key is needed for verified account deletion and stays only in the API secret store.

## Local development setup

- A local Valkey 7.2.14 Redis-protocol service is installed at `/Users/sajalrai/.local/share/movematch/valkey`. It listens only on `127.0.0.1:6379` and runs without disk persistence because it is a development cache. Start it with `/Users/sajalrai/.local/share/movematch/valkey/start.sh`; stop it with `/Users/sajalrai/.local/share/movematch/valkey/stop.sh`. The root `.env` already has `REDIS_URL=redis://127.0.0.1:6379`.
- The root `.env` is mode 600 and contains the Supabase database URL, the existing project service key, and `DATABASE_SSL_CA_FILE`. The project root CA is stored under the ignored `apps/api/.local` directory and PostgreSQL certificate verification remains enabled. TLS validated successfully, but Supabase rejected the saved database password; reset it in the dashboard and update `DATABASE_URL` before running `pnpm db:migrate` or starting the API. The schema migration has already been applied in Supabase SQL Editor and verified. Do not work around an authentication or certificate error by disabling verification.
- `SUPABASE_SERVICE_ROLE_KEY` is configured only in the ignored server `.env`. `OPS_ADMIN_USER_IDS` and `PUBLIC_SUPPORT_EMAIL` are still unset; add only trusted operator UUIDs and a real support address to the server `.env`. Never put server values in the mobile app or commit them.
- `apps/mobile/.env` has the Supabase public client values and `EXPO_PUBLIC_API_URL=http://localhost:8080`. The app maps that host to `10.0.2.2` on Android emulators; iOS Simulator uses `localhost`. Restart Metro after changing the value. Physical phones need the Mac’s reachable LAN address or an HTTPS API URL.
- Supabase Auth email OTP still needs a custom SMTP provider and redirect configuration. Valkey, the root CA, the service key, simulator API URL, and database schema are configured locally; the API remains stopped until its database password authenticates successfully.

## First deployment sequence

1. Provision private Postgres, Redis, Supabase Auth and the API host. Add TLS and the owned API domain; verify WebSocket pass-through and `GET /health/ready`.
2. Review the SQL migration and apply with `pnpm db:migrate` using the server migration connection. Configure backups and test provider restore procedures before real user data exists.
3. Configure all server/mobile environment values and `PUBLIC_SUPPORT_EMAIL`; open the deployed `/account-deletion` page and verify the support link and publisher wording.
4. Add stable Supabase user UUIDs for trusted operators to `OPS_ADMIN_USER_IDS`. Admin API calls are unavailable to ordinary accounts and every report/status/feature-flag mutation requires a reason that is recorded in `moderation_actions`.
5. Keep all `feature_flags` and `exercise_rules.enabled` values false until app versions, accounts, match settlement and exercise release criteria have been evaluated. Use `PATCH /v1/admin/feature-flags/:key` to disable or enable friend/quick/ranked entry and use a reason for each change. Enabling a feature does not replace accuracy or operations gates.
6. The initial migration seeds one eight-week season. Provision the next non-overlapping season before the active season ends. The schema rejects overlapping ranges.
7. Observe redacted API logs, database errors, Redis health, queue waits, void/forfeit rates, settlement backlog, deletion-job failures and moderation backlog. Assign an on-call owner and a feature-switch operator before opening access.

Feature switches are server-read on `/v1/config`. Offline practice remains available if online services or ranked switches are unavailable. The app must never substitute bots or simulated opponents.

## Privacy and retention behavior in source

- Camera frames and complete pose packets stay on device. The match protocol sends a small numeric repetition summary.
- Accepted/rejected per-rep rows are removed by the API retention worker after seven days. Resolved/dismissed reports are removed after 90 days; open/reviewing reports are retained for manual review.
- API request logs redact authorization, cookies, email and report description fields. Configure the hosting provider’s log retention to 30 days and confirm that socket/exception logs do not capture sensitive payloads.
- Crash reporting, OpenTelemetry export, alert delivery and an admin dashboard are not configured in this repository. Do not add camera, pose, email, invite-code or free-text report content to a telemetry product.
- Account export currently returns a private authenticated JSON response for the client to share. It is not an expiring download link.
- In-app deletion requires recent authentication, cancels queue/invites, anonymizes opponent snapshots, removes per-rep summaries and queues Supabase Auth deletion. The worker retries and clears the job’s user ID on success. Reconcile stuck/failed rows using a documented support procedure.
- The public `/account-deletion` page explains authenticated deletion and the email fallback. The publisher must own the domain, set a real support email, staff ownership verification, publish the actual response timeline and document backup expiry before listing the URL publicly.
- Legal review is still needed for privacy policy, terms, community standards, store disclosures, report-text retention, data residency and backup/deletion claims.

## Incident and recovery notes

- Use the audited feature-flag endpoint to stop new friend/ranked entries. Do not edit historical ratings or results directly; corrections need an audited compensating ledger entry.
- The match sweeper promotes ready countdowns, cancels expired readiness, expires abandoned queues/invites, settles due matches, and the outbox publisher retries undelivered settled events.
- Database unique constraints protect active reservations, event IDs/sequences, match results, rating ledgers, reward ledgers and badge keys. Confirm the actual managed database isolation and connection-pool behavior before launch.
- Redis supports rate limits and Socket.IO fanout; durable result state remains in Postgres. A Redis outage should stop new matchmaking/rep ingress with recoverable service errors, not fabricate a result.
- Practice or live match runtime errors should be investigated without requesting camera clips. If consented research video is required for a separate accuracy study, define a separate collection and deletion process.

## Platform delivery gates

Native compiler/signing requirements, OS targets, package versions and the current native validation status are listed in [COMPATIBILITY.md](COMPATIBILITY.md). Store release also needs owned signing credentials, privacy manifests, screenshots, content/age declarations, final legal URLs and independent push-up/pull-up accuracy evidence. Production deployment and store submission are separate owner-approved actions.
