# passby_agentic.md — Standalone Agentic App: Technical Specification

> **Status:** Design document. Backend/API focus; frontend out of scope.
> **Companion to:** `PASSBY.md` (BetterCLSS system handoff — read that first).
> **Deploy target:** Render (dedicated service), separate from BetterCLSS on
> `betterclss.onrender.com`. Working name: **betterclss-agentic**.

---

## 1. Why a standalone app (context & constraints recap)

The existing Agentic Helper lives inside BetterCLSS's Node backend. Two facts
make a standalone deployment the right call:

1. **dcism has zero outbound internet.** Agent jobs need Canvas + Gemini/Groq
   egress. The dcism backend cannot ever run agent execution; Render can.
2. **Render has an ephemeral disk.** The current agent stores jobs/manifests in
   per-user JSON files (`user-storage.js` working set) — on Render those die on
   every redeploy. A standalone app with its **own managed database** solves
   durability without touching BetterCLSS's MariaDB (which is localhost-only on
   dcism and unreachable from Render).

So: BetterCLSS stays the identity provider and the UI host. The agentic app is
the **executor of record** for agent work: it owns its jobs, runs, logs, and
artifacts, and is the only component that talks to Canvas and AI providers.

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│ BetterCLSS (dcism domain)   │        │ betterclss-agentic (Render)      │
│  UI (desktop + StudentHub)  │        │  Node/Express + Postgres         │
│  DATA backend + MariaDB     │        │                                  │
│         │                   │        │  ┌────────────┐  ┌────────────┐  │
│         │ handoff (JWT) ────┼───────▶│  │ Orchestr.  │─▶│ Gemini/    │  │
│         │                   │  HTTPS │  │ (ported)   │  │ Groq (BYOK)│  │
│         ▼                   │        │  └─────┬──────┘  └────────────┘  │
│  user prefs/jobs index      │◀───────┼────────┘ Canvas API (direct)     │
│  (mirrors job status)       │ status │  ┌────────────┐                  │
└─────────────────────────────┘  poll  │  │ Postgres   │ jobs/runs/logs/  │
                                       │  └────────────┘ artifacts        │
                                       └──────────────────────────────────┘
```

Key principle: **BetterCLSS mirrors, the agentic app is authoritative.**
BetterCLSS may cache job status for display, but the truth lives in the agentic
app's database. This avoids the drift problem identified in the earlier
dual-backend discussion (two files-of-truth diverging after redeploys).

---

## 2. Architecture

### 2.1 Service composition (single Render service, internally modular)

One Express app, four internal layers — mirroring BetterCLSS's `server/` layout
style (plain modules, factory functions, no framework magic):

| Layer | Module | Responsibility |
|---|---|---|
| HTTP | `src/http/` — routes, middleware, error writer | Auth verification, request parsing, JSON responses. Copy the `createXxxRoute({ deps })` factory pattern from `server/routes/agent-routes.js`. |
| Auth | `src/auth/` — JWT verify + Canvas re-verify | Handoff-token verification; optional live Canvas re-check for sensitive ops. |
| Orchestrator | `src/agent/` — ported from `server/agent/` | Job state machine, planning, tool execution, approvals, artifacts, refinement pipeline. |
| Store | `src/store/` — Postgres repositories | Jobs, runs, logs, artifacts. Async by design (unlike BetterCLSS's sync file store — new code, no legacy constraint). |

### 2.2 Request lifecycle

```
1. User clicks "Open Agentic Helper" in BetterCLSS.
2. BetterCLSS backend mints a short-lived JWT (see §6) containing the
   verified Canvas identity + BYOK keys (encrypted).
3. Browser redirects to https://betterclss-agentic.onrender.com/?t=<jwt>.
4. Agentic app verifies JWT → establishes its own session cookie
   (httpOnly, Secure, SameSite=Lax, 8h TTL) → strips token from URL
   (history.replaceState) → renders UI shell (out of scope here).
5. All subsequent calls are cookie-authenticated. The Canvas token is NOT
   kept in the JWT after session establishment — it is stored server-side
   (encrypted at rest, see §6.3) keyed by session ID.
6. Jobs are created, executed in-process (async), state written to Postgres.
7. BetterCLSS polls the status endpoint (§4.4) to mirror job progress.
```

### 2.3 Job execution model

Render free/standard instances are **not** reliable long-running workers. Two
execution strategies, chosen by tier:

- **Phase 1 (in-process):** jobs execute as tracked async tasks in the web
  process, with an in-memory run registry. Restart mid-job → job marked
  `FAILED (interrupted)` on boot (a startup sweep transitions any
  non-terminal jobs). Acceptable: jobs are bounded (§5.4) and take < 5 min.
- **Phase 2 (optional):** Render Background Worker + a `pg-boss` queue using
  the same Postgres instance. The HTTP service only enqueues; the worker
  executes. The store/queue interface is designed now so this swap is
  additive, not a rewrite (`enqueue(job)` vs `runInProcess(job)`).

Concurrency limits (in-process): max 2 concurrent jobs per user, max 10
globally; queue others in `QUEUED` state (new state added for this app).

### 2.4 Startup behavior

On boot: schema ensure (drizzle migrations), interrupted-job sweep, artifact
blob rehydration check. Mirrors `restoreAllFromDb()`'s philosophy in
BetterCLSS but against its own DB (which is durable, so restore is really
just a consistency check).

---

## 3. Data model (Postgres)

Chosen over MariaDB because Render's managed Postgres is first-class (free
tier, automatic failover, daily backups) and the app has no legacy MariaDB
constraint. ORM: **Drizzle** (typed, SQL-first, lightweight — fits the
codebase's no-magic style; no Prisma engine binary).

```sql
-- 1. Users: one row per verified Canvas identity. Keyed by the SAME
--    SHA-256(domain \n canvasUserId) hash BetterCLSS uses — keeps the two
--    systems' identifiers aligned without sharing a database.
users (
  id              CHAR(64) PRIMARY KEY,          -- shared hash convention
  canvas_domain   VARCHAR(255) NOT NULL,
  canvas_user_id  VARCHAR(64)  NOT NULL,         -- raw id OK here: internal-only
  display_name    VARCHAR(255) NOT NULL DEFAULT '',
  email           VARCHAR(255) NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (canvas_domain, canvas_user_id)
)

-- 2. Sessions: server-side session store (cookie → user). Canvas token is
--    encrypted at rest in this table ONLY (see §6.3).
sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         CHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  canvas_token_enc BYTEA NOT NULL,               -- AES-256-GCM ciphertext
  token_iv        BYTEA  NOT NULL,
  token_tag       BYTEA  NOT NULL,
  ai_keys_enc     JSONB   NULL,                  -- {gemini?, groq?} encrypted same scheme
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_sessions_user (user_id)
)

-- 3. Jobs: state machine states per §5.1. One row per user-initiated task.
jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         CHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            VARCHAR(32) NOT NULL,          -- 'assignment' | 'study_deck' | ...
  state           VARCHAR(32) NOT NULL DEFAULT 'DISCOVERED',
  title           VARCHAR(500) NOT NULL DEFAULT '',
  canvas_course_id      BIGINT  NULL,
  canvas_assignment_id  BIGINT  NULL,
  manifest        JSONB  NULL,                   -- capability manifest snapshot
  plan            JSONB  NULL,                   -- execution plan snapshot
  result          JSONB  NULL,                   -- final result summary
  failure_reason  TEXT   NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_jobs_user_state (user_id, state, created_at DESC)
)

-- 4. Runs: one attempt to execute a job (retries create new runs).
runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt         SMALLINT NOT NULL DEFAULT 1,
  state           VARCHAR(32) NOT NULL DEFAULT 'RUNNING',   -- RUNNING|COMPLETED|FAILED|CANCELLED
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ NULL,
  error           TEXT NULL,
  INDEX idx_runs_job (job_id, attempt)
)

-- 5. Logs: append-only event stream per run (replaces emitEvent console
--    logging in the current orchestrator).
run_logs (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq             INT NOT NULL,
  type            VARCHAR(64) NOT NULL,          -- STEP_START, AI_CALL, TOOL_CALL, ERROR, ...
  detail          JSONB NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_logs_run (run_id, seq)
)

-- 6. Artifacts: generated files (docx/txt/pdf…). Bytes in DB (BYTEA) keeps
--    single-store durability; Render disk is ephemeral so files can't live
--    on it. Cap artifact size at 10 MB (typical docx ≪ this).
artifacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  filename        VARCHAR(255) NOT NULL,
  mime_type       VARCHAR(128) NOT NULL,
  size_bytes      INT NOT NULL,
  content         BYTEA NOT NULL,
  checksum        CHAR(64) NOT NULL,             -- sha256
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_artifacts_job (job_id)
)

-- 7. Approvals: ported approval-model (submission/comment/file gates).
approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES runs(id),
  type            VARCHAR(32) NOT NULL,          -- SUBMISSION | COMMENT | FILE_UPLOAD
  artifact_id     UUID NULL REFERENCES artifacts(id),
  payload         JSONB NULL,                    -- what will be sent to Canvas
  state           VARCHAR(16) NOT NULL DEFAULT 'PENDING',  -- PENDING|APPROVED|DENIED|EXPIRED
  decided_at      TIMESTAMPTZ NULL,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  INDEX idx_approvals_job (job_id, state)
)

-- 8. Canvas cache (see §4.2 canvas integration caching)
canvas_cache (
  user_id         CHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource        VARCHAR(32) NOT NULL,          -- 'courses' | 'assignments:<courseId>' | 'profile'
  payload         JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, resource)
)
```

---

## 4. Canvas integration

### 4.1 Client

Port `canvas-service.js` wholesale (it's dependency-free, factory-based) with
one change: the `auth` object is built from the decrypted session token rather
than request headers. Keep `fetchAll` pagination via Link headers, `fetchOne`,
domain normalization, and the error taxonomy (`UNAUTHORIZED`, `HTTP_xxx`).

### 4.2 Caching strategy (`canvas_cache` table)

Canvas reads dominate job cost (courses → assignments → submissions). Cache with
per-resource TTLs, keyed by user:

| Resource | TTL | Notes |
|---|---|---|
| `profile` | 1 h | Also re-fetched live for sensitive ops |
| `courses` | 15 min | Same include set as BetterCLSS (`total_scores`, `term`) |
| `assignments:<courseId>` | 15 min | Includes `submission` — TTL shorter than BetterCLSS's because submission state changes |
| `submissions:<courseId>:<assignmentId>` | 5 min | Live fetch before any submission action, regardless of cache |

Rules:
- Reads populate cache; **any write path (comment, upload, submit) always
  re-verifies live state first** (fetch the submission fresh, check it isn't
  already submitted — mirrors `canvas-integrity.js` intent).
- Cache is invalidated (deleted) after a successful write to the affected
  resource.
- All reads go through a `getOrFetch(user, resource, ttl, fetcher)` helper —
  one implementation, no ad-hoc caching.

### 4.3 Writes

Same operations as today: comments (`post`), file upload, submission
(`uploadAndSubmit` — ported as-is). All writes are gated behind the approval
model (§5.3). `canvas_submission` permission defaults OFF, same as BetterCLSS.

### 4.4 Canvas rate limits

Canvas API allows ~600 req/10s per token in practice, but be conservative:
- Per-user token bucket: 100 Canvas requests/min (in-memory, per process).
- `fetchAll` for a 6-course student ≈ 8–15 requests — a job stays well under.

---

## 5. AI orchestration

### 5.1 State machine (ported, extended)

Reuse `job-state-machine.js` states verbatim — BetterCLSS UI already renders
them — plus one addition:

```
DISCOVERED → ANALYZING → CAPABILITY_CHECK → PLANNING → GENERATING
           → REFINING → VALIDATING → READY → EXECUTING → COMPLETED
side states: QUEUED (new), USER_ACTION_REQUIRED, UNSUPPORTED,
             FAILED, CANCELLED (terminal)
```

The transition table stays code-enforced (`assertTransition`) exactly as in
`server/agent/job-state-machine.js`.

### 5.2 Prompt templates

Move prompts into versioned template files, not inline strings (current
orchestrator has them inline in step functions):

```
src/agent/prompts/
  analyze.md.tmpl          — assignment understanding
  plan.md.tmpl             — step planning
  generate/<capability>.md.tmpl  — per-capability generation
  refine.md.tmpl           — refinement pass
  validate.md.tmpl         — requirement validation
```

Templates take a context object (assignment, rubric, requirements, prior step
results) and are rendered with a tiny `{{key}}` interpolator. Each template
has a `version` header logged in `run_logs` on every AI call — so a bad prompt
rollout is diagnosable ("this run used analyze@3").

### 5.3 Approvals & permissions

Port `approval-model.js` and `agent-permissions.js` as-is (pure logic, already
tested). Permission defaults match BetterCLSS. Approval expiry (24h) is new —
pending approvals older than that auto-expire via the startup sweep.

### 5.4 Limits & retry logic

Carry over the existing hard limits (they're good):

| Limit | Value | Source |
|---|---|---|
| maxToolCalls | 8 | `agent-orchestrator.js:97` |
| maxAiCalls | 10 | `agent-orchestrator.js:98` |
| max job wall time | 5 min | new, enforced with AbortSignal |
| bounded history | same as `getBoundedHistory` | port unchanged |

Retry policy — three layers, distinguished deliberately:

1. **Transient AI/HTTP errors (auto-retry, in-run):** 429/5xx/network on
   Gemini/Groq/Canvas. Exponential backoff 2s→8s, max 3 attempts. Port
   `fetchWithTransientRetry` from `assistant-service.js`.
2. **Step failure (auto-retry, new run):** a step that throws after its
   in-run retries marks the run FAILED and schedules `attempt+1` if
   `attempt ≤ 2` and the job state is retriable (not `UNSUPPORTED`). Backoff
   30s. Cancellation is respected across attempts.
3. **Job-level failure (terminal):** after 2 run attempts, or any
   `UNSUPPORTED` verdict → `FAILED`/`UNSUPPORTED` with `failure_reason`.

Error classification happens once, in a `classifyError(err)` helper —
`TRANSIENT | PERMANENT | UNAUTHORIZED | RATE_LIMITED` — instead of the
scattered string matching in the current orchestrator.

BYOK error handling mirrors `dashboard-data.js`'s `executeAgentJob` behavior:
a missing/invalid Gemini key returns a structured 4xx with a `hint` the UI can
show — never a bare 500.

### 5.5 AI client

One `createAiClient({ geminiKey?, groqKey? })` per run (keys come from the
session's encrypted store), exposing:

```js
ai.generate({ capability, templateId, context }) → { text, usage }
ai.generateStructured({ templateId, context, schema }) → { json, usage }
```

Gemini first (matches BetterCLSS's primary), Groq as structured-output fallback.
Usage (tokens, latency) logged to `run_logs` per call — feeds a future
per-user usage meter (the `ai-usage-metering.test.js` in BetterCLSS shows this
was already a concern).

---

## 6. Auth handoff (BetterCLSS → Agentic)

### 6.1 Handoff token: JWT, HS256, 120s TTL

BetterCLSS (dcism data backend) mints; the agentic app verifies. Shared secret
via environment variables on both sides:

```
AGENTIC_JWT_SECRET      # 32+ random bytes, same value both sides
AGENTIC_ALLOWED_AUD     # "betterclss-agentic"
```

Claims:

```json
{
  "iss": "betterclss",
  "aud": "betterclss-agentic",
  "sub": "<sha256 identity hash>",
  "iat": 1730000000,
  "exp": 1730000120,
  "canvasUserId": "12345",
  "canvasDomain": "usc.instructure.com",
  "name": "Mark Elsalinas",
  "byok": { "g": "<encrypted-blob>" }   // optional
}
```

Design decisions:
- **JWE would be nicer** (encrypted claims) but adds library weight; instead
  BYOK keys inside the JWT are encrypted with a BetterCLSS-side key and
  re-encrypted into `sessions.ai_keys_enc` on first use. The JWT is short-
  lived and appears only in a redirect URL — acceptable, but it MUST be
  stripped from the URL immediately on load (§2.2 step 4).
- **Why not share the raw Canvas token via JWT body:** tokens in URLs leak via
  Referer/browser history even with 120s TTL. Instead the agentic app does its
  own token bootstrap (§6.2).

### 6.2 Canvas token bootstrap — the one open design point

The agentic app needs the Canvas token to call Canvas, but BetterCLSS should
not ship it in a URL. Two mechanisms, **both supported**:

- **(a) Preferred — token exchange endpoint:** BetterCLSS POSTs the verified
  token (server-to-server, over HTTPS, in the body) to
  `POST /internal/v1/exchange` with the JWT in the header. The agentic app
  re-verifies the token against Canvas `/users/self/profile`, stores it
  encrypted in the session row, and returns the session cookie.
  ⚠️ Requires dcism → Render egress, which is **currently blocked**.
- **(b) Fallback — user-paste:** the agentic app shows its own "paste Canvas
  token" step pre-filled contextually (same UX as BetterCLSS today). Works
  today, zero egress needed. The JWT pre-authenticates *who* the user is; the
  token re-proves *access to Canvas*.

Ship (b) now; implement (a) when/if dcism egress is unblocked. The session
model is identical either way.

### 6.3 Secret storage on the agentic app

- `AGENTIC_DB_URL`, `AGENTIC_JWT_SECRET`, `AGENTIC_TOKEN_AES_KEY` (32-byte
  key for AES-256-GCM) — Render environment variables, never in git.
- Canvas tokens/AI keys encrypted with AES-256-GCM at rest in Postgres.
- Plaintext keys live only in process memory, scoped per run, zeroized after.
- Logs NEVER contain tokens, keys, or full JWTs (log the `sub` hash only) —
  same rule as BetterCLSS's `user-identity.js` documentation.

### 6.4 Back-channel (BetterCLSS polls agentic)

BetterCLSS never writes to the agentic app. For status mirroring it calls:

```
GET /api/v1/users/:userIdHash/jobs?since=<iso>
Header: Authorization: Bearer <AGENTIC_BACK_CHANNEL_TOKEN>
```

A separate long-lived opaque token (not JWT) stored in Render env on both
sides. `userIdHash` is the shared identity hash — BetterCLSS can compute it
locally (`user-identity.js`), so no id mapping is needed. Response contains
only non-sensitive projection (id, state, title, updatedAt, result summary).

---

## 7. API surface

All under `/api/v1`. Cookie session auth except where noted. Errors follow
BetterCLSS's shape: `{ "error": "<code>", "message": "..." }` with proper
status codes (400/401/403/404/409/429/502).

### 7.1 Session

| Method | Path | Notes |
|---|---|---|
| GET | `/auth/session` | Who am I: `{ userIdHash, name, email, canvasConnected, hasGeminiKey, hasGroqKey }` |
| POST | `/auth/canvas-token` | Fallback bootstrap (b): body `{ token, domain }`; verifies live against Canvas |
| POST | `/internal/v1/exchange` | Back-channel bootstrap (a) when egress exists |
| POST | `/auth/logout` | Deletes session + encrypted material |

### 7.2 Jobs

| Method | Path | Notes |
|---|---|---|
| POST | `/jobs` | Create + queue. Body: `{ kind, canvasCourseId, canvasAssignmentId, options? }`. Enforces per-user concurrency → `QUEUED` if at limit. Returns full job. |
| GET | `/jobs?state=&limit=&cursor=` | List own jobs (cursor pagination, newest first) |
| GET | `/jobs/:jobId` | Full job incl. plan/manifest/result projections |
| POST | `/jobs/:jobId/cancel` | Only from non-terminal states; aborts in-flight AI calls via AbortController (ported) |
| POST | `/jobs/:jobId/retry` | New run for a FAILED job (respects attempt cap) |

### 7.3 Runs, logs, artifacts, approvals

| Method | Path | Notes |
|---|---|---|
| GET | `/jobs/:jobId/runs` | Run attempts, newest first |
| GET | `/runs/:runId/logs?sinceSeq=` | Incremental log tail (long-poll friendly) |
| GET | `/jobs/:jobId/artifacts` | List artifacts (metadata only) |
| GET | `/artifacts/:artifactId/download` | Streams content; checksum verified |
| GET | `/jobs/:jobId/approvals` | Pending + history |
| POST | `/approvals/:approvalId/approve` | Triggers the gated Canvas write |
| POST | `/approvals/:approvalId/deny` | Body `{ reason? }` |

### 7.4 Back-channel (Bearer token auth — for BetterCLSS only)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/users/:userIdHash/jobs?since=` | Status mirror projection |
| GET | `/api/v1/users/:userIdHash/jobs/:jobId` | Single-job mirror |

### 7.5 Ops

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | Liveness (no DB) |
| GET | `/readyz` | DB reachable, migrations current |
| GET | `/internal/v1/metrics` | JSON counters: jobs by state, AI calls, Canvas errors |

---

## 8. Tech stack (with justification)

| Choice | Rationale |
|---|---|
| **Node 20 + Express 5** | Same runtime as BetterCLSS → `server/agent/` modules port with zero language friction. Express over Fastify because the existing code is plain `req,res` handlers; no benefit converting. |
| **Plain JS modules (ESM), factory functions** | Matches `createCanvasService({...})` / `createUserRoutes({...})` style. Tests import factories the same way. |
| **Drizzle ORM + node-postgres** | Typed SQL, no engine binary (Prisma), migrations checked into repo (`drizzle-kit generate`). |
| **Render managed Postgres** | Only managed DB reachable from Render; free tier sufficient for phase 1; backups on paid tier. MariaDB is impossible (localhost-only on dcism). |
| **Vitest** | The existing test style (per-module `__tests__` folders, e.g. `job-state-machine.test.js`) ports directly; Vitest is the least-configured runner for ESM. |
| **No job queue (phase 1)** | Jobs are bounded (<5 min, hard limits); in-process with an interrupted-job sweep is simpler. `pg-boss` swap-in is designed for (§2.3), not built yet. |
| **Pino for logging** | Structured JSON to stdout (Render log drain), redaction paths configured once. |

---

## 9. Gaps, risks, open questions

### Blockers / decisions needed

1. **dcism → Render egress is blocked today** → token exchange (a) can't ship;
   fallback (b) means users paste their Canvas token a second time once. Is
   that acceptable UX, or do we wait for the admin whitelist?
2. **JWT secret distribution:** the shared `AGENTIC_JWT_SECRET` must be set on
   the dcism BetterCLSS backend AND on Render. Requires one manual step on
   dcism (fine — `~/BetterCLSS/.env`) — decide the secret's rotation story
   (suggest: rotate quarterly, both sides same window).
3. **Artifact size:** BYTEA blobs capped at 10 MB. If video/image generation
   capabilities (already in the registry) become real, artifacts need object
   storage (Render Blob / S3) — flagged, not built.

### Risks

4. **Render free tier idles** (spins down after ~15 min inactivity) → first
   job after idle pays ~30s cold start, and the in-memory run registry is
   empty after wake (DB-backed states make this safe, but a job executing at
   spin-down is lost → the interrupted sweep marks it FAILED). Mitigation:
   keep-warm ping from BetterCLSS, or paid tier, or phase-2 worker.
5. **Two identity sources of truth:** the hash convention is shared but
   nothing enforces it. If BetterCLSS ever changes `user-identity.js`
   salting, the back-channel silently returns empty. Mitigation: a
   `GET /internal/v1/whoami/:userIdHash` sanity endpoint both sides can test.
6. **Canvas token scope:** tokens are user-created PATs; if a token lacks
   submission scopes, write paths fail at Canvas with 403 mid-job. The
   capability analyzer should pre-check scopes (assignment-manifest already
   surfaces submission types) and route to `USER_ACTION_REQUIRED` early.
7. **Prompt-template regressions:** versioned templates mitigate, but there's
   no eval harness yet. Recommend a small golden-set test (5 known
   assignments → expected capability verdicts) before changing any prompt.
8. **Rate-limit asymmetry:** Gemini free tier (BYOK) is tight (15 RPM for
   some models). With maxAiCalls=10 per job, two concurrent jobs can 429.
   The classifier maps 429 → RATE_LIMITED → run retry with longer backoff.
9. **Security review pending:** before launch, re-run the BetterCLSS-style
   security checklist against this app: no tokens in logs (assert in a test
   that logs of a full run match a redaction regex), session fixation
   (regenerate session id at bootstrap), artifact download authorization
   (artifact → job → user join check), CORS locked to the BetterCLSS origins,
   CSRF defense (SameSite=Lax + custom header check on mutations).

### Explicitly out of scope for v1

- Frontend/UI of the agentic app (a minimal shell only).
- Notifications/webhooks push to BetterCLSS (polling only).
- Multi-provider AI routing beyond Gemini/Groq.
- Team/shared jobs, scheduling, recurring jobs.
