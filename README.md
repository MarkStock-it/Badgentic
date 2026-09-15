# betterclss-agentic

Standalone executor-of-record for BetterCLSS agentic jobs. Implements
`passby_agentic.md` — a Render-deployed Node/Express + Postgres service that
runs agent jobs against Canvas and BYOK AI (Gemini/Groq), because dcism has
no outbound internet and BetterCLSS's disk is not durable.

**BetterCLSS mirrors, this app is authoritative.** Jobs, runs, logs, artifacts,
and approvals live here; BetterCLSS polls the back-channel for status.

## Quick start (local, no DB)

```bash
npm install
cp .env.example .env          # fill AGENTIC_JWT_SECRET + AGENTIC_TOKEN_AES_KEY
npm start                     # uses in-memory store when AGENTIC_DB_URL is unset
```

- `GET /healthz` — liveness
- `GET /` — minimal UI shell (bootstrap → settings → jobs → approvals)
- Full env var reference: `.env.example`

With a Postgres URL set: `npm run migrate` applies `drizzle/*.sql`
(tracked in `schema_migrations`), then start normally.

## Architecture

One Express app, four internal layers (spec §2.1) plus a minimal UI:

| Layer | Path | Notes |
|---|---|---|
| HTTP | `src/http/` | `createXxxRoutes({ deps })` factories, one error writer (`{ error, message }` + status map) |
| Auth | `src/auth/` | HS256 handoff JWT verify (identity-hash cross-check), AES-256-GCM secret box, server-side sessions |
| Canvas | `src/canvas/` | Link-header pagination, error taxonomy, per-user token bucket, `getOrFetch` cache, live re-verify before writes |
| Agent | `src/agent/` | State machine (`assertTransition`), orchestrator pipeline, versioned prompt templates, approval gate, doc builder |
| Store | `src/store/` | One interface, two drivers: `pg.js` (Drizzle) and `memory.js` (tests) |

### Job pipeline (spec §5.1)

```
DISCOVERED → ANALYZING → CAPABILITY_CHECK → PLANNING → GENERATING
           → REFINING → VALIDATING → READY → EXECUTING → COMPLETED
side states: QUEUED, USER_ACTION_REQUIRED, UNSUPPORTED, FAILED, CANCELLED
```

- Runs decrypt session credentials in memory only (never logged).
- Writes (comment / upload+submit) always pass the approval gate; submission
  permissions default OFF (comment ON).
- Retry layers (§5.4): in-run transient backoff (2s→8s ×3), run retry
  (attempt ≤ 2, parked in `QUEUED`, re-pumped when capacity frees), terminal
  `FAILED`/`UNSUPPORTED` otherwise. `classifyError()` is the single arbiter.
- Concurrency: max 2 jobs/user, 10 global; queue pump starts `QUEUED` jobs.
- Startup sweeps: interrupted jobs → `FAILED (interrupted)`, stale approvals
  → `EXPIRED`, expired sessions deleted.

### Auth handoff (spec §6)

1. BetterCLSS mints a 120s HS256 JWT (`iss=betterclss`,
   `aud=betterclss-agentic`, `sub=<sha256(domain \n canvasUserId)>`).
2. Browser opens `https://<app>/?t=<jwt>`; UI POSTs it to
   `POST /api/v1/auth/session` → httpOnly session cookie; token stripped from
   the URL client-side (`history.replaceState`).
3. Canvas token is **not** in the JWT. Bootstrap is user-paste
   (`POST /api/v1/auth/canvas-token-bootstrap` or
   `/api/v1/auth/canvas-token` when already signed in) — verified live
   against Canvas `/users/self/profile`, stored AES-256-GCM encrypted.
   The server-to-server `/internal/v1/exchange` path is intentionally not
   built until dcism egress exists.

## API surface (spec §7)

Cookie session auth (`X-Agentic-CSRF: 1` required on mutations), errors as
`{ error, message }` with 400/401/403/404/409/422/429/502:

| Group | Endpoints |
|---|---|
| Session | `GET/POST /api/v1/auth/session`, `POST /auth/canvas-token(-bootstrap)`, `POST /auth/ai-keys`, `POST /auth/logout` |
| Jobs | `POST /api/v1/jobs`, `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/cancel`, `POST /jobs/:id/retry` |
| Runs/logs | `GET /jobs/:id/runs`, `GET /runs/:runId/logs?sinceSeq=` |
| Artifacts | `GET /jobs/:id/artifacts`, `GET /artifacts/:id/download` (checksum-verified, ownership-checked) |
| Approvals | `GET /jobs/:id/approvals`, `POST /approvals/:id/approve|deny` |
| Back-channel | `GET /api/v1/users/:userIdHash/jobs?since=`, `.../jobs/:jobId` (Bearer `AGENTIC_BACK_CHANNEL_TOKEN`; safe projection only) |
| Ops | `GET /healthz`, `GET /readyz`, `GET /internal/v1/metrics` |

Capabilities v1: `assignment_document` (docx via approval-gated submission),
`discussion_post` (comment via approval), `study_deck` (md, download only).
Unknown kinds → 400 at creation; AI-unsupported assignments → `UNSUPPORTED`.

## Tests

Fully offline — memory store, fake Canvas service, fake AI client:

```bash
npm test          # vitest, 44 tests across 5 suites
```

Includes the spec's security asks: run-log redaction regression test
(no tokens/keys in `run_logs` or pino output), ownership checks, CSRF,
double-submit guard, retry/cancel/queue semantics.

## Deploy (Render)

- Node 20+, single web service; build `npm ci`, start `npm start`.
- Managed Postgres; run `npm run migrate` as the deploy command's first step.
- Required env: `AGENTIC_DB_URL`, `AGENTIC_JWT_SECRET` (same value as
  BetterCLSS side), `AGENTIC_ALLOWED_AUD`, `AGENTIC_TOKEN_AES_KEY` (32-byte
  hex), `AGENTIC_BACK_CHANNEL_TOKEN`, `AGENTIC_ALLOWED_ORIGINS`.
- Free-tier idle spin-down is expected; the interrupted-job sweep makes
  restarts safe. Phase-2 `pg-boss` worker swap-in is designed for, not built.

## Known deviations from the spec

- Ported modules are faithful reimplementations of the spec'd contracts
  (BetterCLSS source is not in this workspace): same state names, error
  taxonomy, factory style, limits.
- `jobs.session_id` added (spec §3 table has no session linkage; the
  orchestrator needs it to find per-run credentials).
- `sessions.canvas_token_*` columns are nullable: a session can exist before
  the Canvas token is pasted (bootstrap path b).
- Artifacts stored base64 in `TEXT` (spec says `BYTEA`); functionally
  equivalent, avoids Buffer/JSON friction in the client and memory driver.
- `submissions:<course>` cache keys from the spec are implemented as
  `assignment:<course>:<assignment>` / `comments:<course>:<assignment>`
  entries with the same TTL intent; live reads always precede writes.
