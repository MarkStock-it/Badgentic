import {
  bigint,
  bigserial,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Schema mirrors spec §3. Kept as plain Drizzle table defs; the checked-in
 * SQL in ./drizzle is the migration of record.
 */

export const users = pgTable(
  'users',
  {
    id: char('id', { length: 64 }).primaryKey(),
    canvasDomain: varchar('canvas_domain', { length: 255 }).notNull(),
    canvasUserId: varchar('canvas_user_id', { length: 64 }).notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull().default(''),
    email: varchar('email', { length: 255 }).notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_users_domain_user').on(t.canvasDomain, t.canvasUserId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: char('user_id', { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Nullable: a session can exist before the Canvas token is pasted (bootstrap b).
    canvasTokenEnc: text('canvas_token_enc'),
    tokenIv: text('token_iv'),
    tokenTag: text('token_tag'),
    aiKeysEnc: jsonb('ai_keys_enc'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_sessions_user').on(t.userId)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: char('user_id', { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    state: varchar('state', { length: 32 }).notNull().default('DISCOVERED'),
    title: varchar('title', { length: 500 }).notNull().default(''),
    canvasCourseId: bigint('canvas_course_id', { mode: 'number' }),
    canvasAssignmentId: bigint('canvas_assignment_id', { mode: 'number' }),
    sessionId: uuid('session_id'),
    manifest: jsonb('manifest'),
    plan: jsonb('plan'),
    result: jsonb('result'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_jobs_user_state').on(t.userId, t.state, t.createdAt)],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    attempt: smallint('attempt').notNull().default(1),
    state: varchar('state', { length: 32 }).notNull().default('RUNNING'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [index('idx_runs_job').on(t.jobId, t.attempt)],
);

export const runLogs = pgTable(
  'run_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_logs_run').on(t.runId, t.seq)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    filename: varchar('filename', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    content: text('content').notNull(), // base64
    checksum: char('checksum', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_artifacts_job').on(t.jobId)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(), // SUBMISSION | COMMENT | FILE_UPLOAD
    artifactId: uuid('artifact_id').references(() => artifacts.id, { onDelete: 'set null' }),
    payload: jsonb('payload'),
    state: varchar('state', { length: 16 }).notNull().default('PENDING'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_approvals_job').on(t.jobId, t.state)],
);

export const canvasCache = pgTable(
  'canvas_cache',
  {
    userId: char('user_id', { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resource: varchar('resource', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.resource] })],
);
