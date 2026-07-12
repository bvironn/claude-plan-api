import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { TelemetryEvent, RequestRecord, ApiKeyRecord, ApiKeyMeta, UsageByKey } from "./types.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getTelemetryDbPath } from "../config.ts";
// NOTE: two-file cycle — logger.ts imports insertEvent() from here, and we
// import emit() from there. This is safe because both are hoisted function
// declarations (initialised during ESM linking) and emit() is only referenced
// inside call-time function bodies below, never at module-eval time. Do NOT
// call emit() from insertEvent() — that would recurse (emit → insertEvent → …).
import { emit } from "./logger.ts";

let db: Database;

// Whether the external-content FTS5 index for request/response bodies is live.
// Set by initStorage(); when false the search filter falls back to a LIKE scan.
let ftsAvailable = false;

/**
 * Open (or create) the telemetry SQLite database and ensure the schema.
 *
 * `dbPath` defaults to `getTelemetryDbPath()` — the shared resolver used by the
 * server AND the CLI scripts, so they never open different databases. It reads
 * `TELEMETRY_DB_PATH` (set OUTSIDE the deploy tree in production, e.g.
 * `/var/lib/claude-plan-api/telemetry.db`) or falls back to `logs/telemetry.db`.
 * Pass `":memory:"` for deterministic, isolated tests (no disk I/O). Any other
 * path is treated as a file and its parent directory is created.
 */
export function initStorage(dbPath: string = getTelemetryDbPath()): void {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      trace_id TEXT,
      span_id TEXT,
      parent_span_id TEXT,
      session_id TEXT,
      user_session_id TEXT,
      event TEXT NOT NULL,
      stream TEXT,
      payload TEXT,
      duration_ms REAL,
      stack TEXT,
      http_method TEXT,
      http_path TEXT,
      http_status INTEGER,
      ip TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
    CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream);
    CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      timestamp TEXT NOT NULL,
      method TEXT,
      path TEXT,
      status INTEGER,
      duration_ms REAL,
      ip TEXT,
      user_agent TEXT,
      model TEXT,
      is_stream INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      request_body TEXT,
      response_body TEXT,
      upstream_request_body TEXT,
      error TEXT,
      api_key_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_path ON requests(path);

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      rotated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(prefix);
  `);

  // Idempotent additive migrations for DBs created before a column existed.
  // Pattern: check PRAGMA table_info, ALTER TABLE ADD COLUMN if missing.
  // Safe to call on every startup — no-op on fresh DBs (column already in CREATE).
  ensureColumn("requests", "upstream_request_body", "TEXT");
  ensureColumn("requests", "api_key_id", "INTEGER");
  // NOT NULL DEFAULT 0 backfills existing rows to non-admin — pre-admin keys stay
  // dashboard-locked until a new admin key is minted by the CLI.
  ensureColumn("api_keys", "is_admin", "INTEGER NOT NULL DEFAULT 0");
  // Additive nullable TEXT: NULL means "never rotated" (rotate-api-key change).
  ensureColumn("api_keys", "rotated_at", "TEXT");
  // Index must be created AFTER ensureColumn so pre-existing DBs have the column.
  db.exec("CREATE INDEX IF NOT EXISTS idx_requests_api_key ON requests(api_key_id)");

  initRequestsFts();
}

/**
 * Stand up the full-text search index for `requests(request_body, response_body)`
 * (finding #6). The `search` filter used to run an unindexed `LIKE '%term%'`
 * scan over those large TEXT columns; this backs it with an FTS5 index instead.
 *
 * The index is an EXTERNAL-CONTENT FTS5 table (`content='requests'`): the base
 * `requests` table stays the single source of truth and the FTS table only holds
 * the inverted index. AFTER INSERT/UPDATE/DELETE triggers keep it in sync, and a
 * one-time `rebuild` backfills rows that predate the index on an upgraded DB.
 *
 * Everything here is ADDITIVE and drop-safe — no column is altered or removed.
 * If FTS5 is unavailable (a SQLite build without the module, or any setup
 * failure) `ftsAvailable` stays false and search transparently uses the LIKE
 * scan, so this can never break search or startup.
 */
function initRequestsFts(): void {
  ftsAvailable = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS requests_fts USING fts5(
        request_body,
        response_body,
        content='requests',
        content_rowid='id'
      );
      -- INSERT/UPDATE indexing used to be synced via AFTER triggers that ran
      -- in the SAME statement/transaction as the base write (requests_ai /
      -- requests_au). That coupling meant a single bad FTS5 write (corrupt
      -- index, disk full, an error inside the vtable) aborted the WHOLE
      -- triggering statement, silently dropping the actual telemetry row
      -- along with the index update (RESIL-002). insertRequest/updateRequest
      -- now perform this sync as an explicit, separate, best-effort step
      -- (see syncFtsRow) AFTER the base write has already committed, so an
      -- index failure can never lose real data. Drop any triggers a
      -- pre-existing (already-deployed) DB may still carry from before this
      -- change — leaving them in place would double-index every write (once
      -- via the stale trigger, once via the new app-level sync).
      DROP TRIGGER IF EXISTS requests_ai;
      DROP TRIGGER IF EXISTS requests_au;
      CREATE TRIGGER IF NOT EXISTS requests_ad AFTER DELETE ON requests BEGIN
        INSERT INTO requests_fts(requests_fts, rowid, request_body, response_body)
        VALUES ('delete', old.id, old.request_body, old.response_body);
      END;
    `);

    // Reconciliation-based backfill (self-healing on EVERY startup, not just
    // once): compare the number of actually-INDEXED documents against the
    // real `requests` row count, and rebuild whenever they differ.
    //
    // `count(*) FROM requests_fts` cannot be used for this: SQLite optimizes
    // a column-less count(*) on an external-content FTS5 table by reading the
    // CONTENT table's row count directly, so it returns the same number
    // whether the index is populated or completely empty (verified
    // empirically). `requests_fts_docsize` is a shadow table with exactly one
    // row per rowid that has actually been INDEXED, so its count is the real
    // signal.
    //
    // A mismatch means either: this is the first run against a pre-existing
    // DB (index never built), or a crash happened between the CREATE VIRTUAL
    // TABLE above committing and a previous rebuild completing. Running this
    // check on every startup — instead of only when `sqlite_master` said the
    // table didn't previously exist — makes the backfill correct regardless
    // of crash timing. Two COUNT(*) queries are cheap even for a large
    // `requests` table.
    const indexedCount =
      db.query<{ n: number }, []>("SELECT count(*) as n FROM requests_fts_docsize").get()?.n ?? 0;
    const contentCount =
      db.query<{ n: number }, []>("SELECT count(*) as n FROM requests").get()?.n ?? 0;

    if (indexedCount !== contentCount) {
      db.exec("INSERT INTO requests_fts(requests_fts) VALUES('rebuild')");
    }

    ftsAvailable = true;
  } catch (err) {
    // Do NOT emit() here: this runs during initStorage, before the store is
    // guaranteed usable for logging. A direct console.error mirrors the
    // non-recursive fallback used elsewhere in this module.
    ftsAvailable = false;
    console.error(
      "[storage.initRequestsFts] FTS5 unavailable — search will use the LIKE fallback:",
      (err as Error).message
    );
  }
}

/**
 * Add a column to `table` if it does not already exist. Use for additive
 * schema migrations on previously-created SQLite files. Call from inside
 * `initStorage()` after the `CREATE TABLE IF NOT EXISTS` block.
 *
 * Idempotent: rows retain their values; no data loss. Fresh DBs skip the
 * ALTER because the column is already present from `CREATE TABLE`.
 */
function ensureColumn(table: string, column: string, type: string): void {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * Fold the write-ahead log into the durable database file WITHOUT closing the
 * connection. Call periodically while running: in WAL mode committed rows sit in
 * the `-wal` sidecar until a checkpoint moves them into the main `.db`, and
 * SQLite's automatic checkpoint only fires once the WAL passes ~1000 pages. A
 * passive checkpoint keeps the durable file current so an abrupt kill (OOM,
 * SIGKILL) loses at most the most recent writes instead of everything.
 */
export function checkpointStorage(): void {
  if (!db) return;
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

/**
 * Checkpoint the WAL into the durable file and close the connection. MUST run on
 * graceful shutdown. Without it the process exits with all data still in the
 * transient `-wal`/`-shm` sidecars; losing those (a redeploy cleaning the
 * gitignored `logs/`, or a backup that copies only `telemetry.db`) resets the
 * store to an empty schema. `TRUNCATE` also resets the WAL file so it does not
 * grow unbounded across the process lifetime.
 */
export function closeStorage(): void {
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
    // Idempotent: a second closeStorage() (e.g. from the shutdown force path)
    // must be a no-op rather than exec on a closed handle.
    db = undefined as unknown as Database;
  }
}

// Prepared statements — initialised lazily after initStorage() is called
function getInsertEvent() {
  return db.prepare<void, [
    string, string, string | null, string | null, string | null,
    string | null, string | null, string, string | null, string | null,
    number | null, string | null, string | null, string | null, number | null,
    string | null, string | null
  ]>(`
    INSERT INTO events
      (timestamp, level, trace_id, span_id, parent_span_id, session_id, user_session_id,
       event, stream, payload, duration_ms, stack, http_method, http_path, http_status, ip, user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
}

function getInsertRequest() {
  return db.prepare<void, [
    string, string, string | null, string | null, number | null, number | null,
    string | null, string | null, string | null, number | null, number | null,
    number | null, number | null, number | null, string | null, string | null,
    string | null, string | null, number | null
  ]>(`
    INSERT OR IGNORE INTO requests
      (trace_id, timestamp, method, path, status, duration_ms, ip, user_agent, model,
       is_stream, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       request_body, response_body, upstream_request_body, error, api_key_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
}

export function insertEvent(e: TelemetryEvent): void {
  if (!db) return;
  try {
    getInsertEvent().run(
      e.timestamp,
      e.level,
      e.traceId ?? null,
      e.spanId ?? null,
      e.parentSpanId ?? null,
      e.sessionId ?? null,
      e.userSessionId ?? null,
      e.event,
      e.stream ?? null,
      e.payload ? JSON.stringify(e.payload) : null,
      e.duration ?? null,
      e.stack ?? null,
      e.httpMethod ?? null,
      e.httpPath ?? null,
      e.httpStatus ?? null,
      e.ip ?? null,
      e.userAgent ?? null
    );
  } catch (err) {
    // Do NOT use emit() here: emit() calls insertEvent(), so routing this
    // failure back through emit() would recurse. Fall back to a direct,
    // non-recursive console.error (captured by systemd/journalctl in prod).
    console.error("[storage.insertEvent] failed:", (err as Error).message);
  }
}

/**
 * Synchronize one row's indexed content into `requests_fts`. Called AFTER the
 * base `requests` write (insert or update) has already committed, in its own
 * try/catch — a failure here is logged via emit() and swallowed, NEVER
 * re-thrown, so an FTS5 write failure (corrupt index, an error inside the
 * vtable, disk full) can never cause the actual telemetry row to be rolled
 * back or lost. This replaces the old AFTER INSERT / AFTER UPDATE triggers,
 * which ran in the SAME statement as the base write and could therefore abort
 * it (RESIL-002).
 *
 * `previous` must be the content column values as they were indexed BEFORE
 * this write (omit for a fresh INSERT) — FTS5's external-content 'delete'
 * command needs the OLD values to correctly remove the old terms before the
 * new ones are inserted, mirroring what the AFTER UPDATE trigger used to do.
 */
function syncFtsRow(
  id: number,
  next: { request_body: string | null; response_body: string | null },
  previous?: { request_body: string | null; response_body: string | null }
): void {
  if (!ftsAvailable) return;
  try {
    if (previous) {
      db.prepare(
        "INSERT INTO requests_fts(requests_fts, rowid, request_body, response_body) VALUES ('delete', ?, ?, ?)"
      ).run(id, previous.request_body, previous.response_body);
    }
    db.prepare(
      "INSERT INTO requests_fts(rowid, request_body, response_body) VALUES (?, ?, ?)"
    ).run(id, next.request_body, next.response_body);
  } catch (err) {
    emit("warn", "storage.fts.syncFailed", { id, error: (err as Error).message });
  }
}

export function insertRequest(r: RequestRecord): void {
  if (!db) return;
  let insertedId: number | undefined;
  try {
    const result = getInsertRequest().run(
      r.trace_id,
      r.timestamp,
      r.method ?? null,
      r.path ?? null,
      r.status ?? null,
      r.duration_ms ?? null,
      r.ip ?? null,
      r.user_agent ?? null,
      r.model ?? null,
      r.is_stream ?? null,
      r.input_tokens ?? null,
      r.output_tokens ?? null,
      r.cache_read_tokens ?? null,
      r.cache_creation_tokens ?? null,
      r.request_body ?? null,
      r.response_body ?? null,
      r.upstream_request_body ?? null,
      r.error ?? null,
      r.api_key_id ?? null
    );
    // `INSERT OR IGNORE` skips silently on a duplicate trace_id — `changes` is
    // 0 in that case and `lastInsertRowid` still points at the PREVIOUS
    // insert, so it must only be used when a row was actually written.
    if (result.changes > 0) {
      insertedId = Number(result.lastInsertRowid);
    }
  } catch (err) {
    emit("error", "storage.insertRequest.failed", { traceId: r.trace_id, error: (err as Error).message });
    return;
  }

  // FTS sync is a separate, best-effort step (see syncFtsRow) — a failure
  // here must never hide the fact that the `requests` row above was already
  // committed successfully (RESIL-002).
  if (insertedId != null) {
    syncFtsRow(insertedId, {
      request_body: r.request_body ?? null,
      response_body: r.response_body ?? null,
    });
  }
}

export function updateRequest(traceId: string, patch: Partial<RequestRecord>): void {
  if (!db) return;
  const touchesBody = "request_body" in patch || "response_body" in patch;
  let ftsSync:
    | {
        id: number;
        next: { request_body: string | null; response_body: string | null };
        previous: { request_body: string | null; response_body: string | null };
      }
    | undefined;

  try {
    const fields = Object.keys(patch).filter((k) => k !== "trace_id");
    if (fields.length === 0) return;

    // Only the FTS index columns (request_body/response_body) need a resync;
    // read the pre-update values first so syncFtsRow can issue the matching
    // delete+insert FTS5 requires (see its doc comment) — but only pay this
    // extra query when the patch actually touches one of those columns.
    let before: { id: number; request_body: string | null; response_body: string | null } | null =
      null;
    if (touchesBody) {
      before =
        db
          .query<
            { id: number; request_body: string | null; response_body: string | null },
            [string]
          >("SELECT id, request_body, response_body FROM requests WHERE trace_id = ?")
          .get(traceId) ?? null;
    }

    const set = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => (patch as Record<string, unknown>)[f] ?? null);
    db.prepare(`UPDATE requests SET ${set} WHERE trace_id = ?`).run(...values as never[], traceId);

    if (before) {
      ftsSync = {
        id: before.id,
        previous: { request_body: before.request_body, response_body: before.response_body },
        next: {
          request_body: "request_body" in patch ? (patch.request_body ?? null) : before.request_body,
          response_body:
            "response_body" in patch ? (patch.response_body ?? null) : before.response_body,
        },
      };
    }
  } catch (err) {
    emit("error", "storage.updateRequest.failed", { traceId, error: (err as Error).message });
    return;
  }

  // See syncFtsRow: runs after the base UPDATE has committed, in its own
  // failure domain (RESIL-002).
  if (ftsSync) {
    syncFtsRow(ftsSync.id, ftsSync.next, ftsSync.previous);
  }
}

export interface EventFilters {
  level?: string[];
  stream?: string[];
  event?: string[];
  traceId?: string;
  sessionId?: string;
  timeFrom?: string;
  timeTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

function buildEventWhere(filters: EventFilters): { where: string; vals: SQLQueryBindings[] } {
  const conds: string[] = [];
  const vals: SQLQueryBindings[] = [];
  if (filters.level?.length) { conds.push(`level IN (${filters.level.map(() => "?").join(",")})`); vals.push(...filters.level); }
  if (filters.stream?.length) { conds.push(`stream IN (${filters.stream.map(() => "?").join(",")})`); vals.push(...filters.stream); }
  if (filters.event?.length) { conds.push(`event IN (${filters.event.map(() => "?").join(",")})`); vals.push(...filters.event); }
  if (filters.traceId) { conds.push("trace_id = ?"); vals.push(filters.traceId); }
  if (filters.sessionId) { conds.push("session_id = ?"); vals.push(filters.sessionId); }
  if (filters.timeFrom) { conds.push("timestamp >= ?"); vals.push(filters.timeFrom); }
  if (filters.timeTo) { conds.push("timestamp <= ?"); vals.push(filters.timeTo); }
  if (filters.search) { conds.push("(event LIKE ? OR payload LIKE ? OR stack LIKE ?)"); vals.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`); }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", vals };
}

export function countEvents(filters: EventFilters = {}): number {
  if (!db) return 0;
  const { where, vals } = buildEventWhere(filters);
  const row = db.query<{ n: number }, SQLQueryBindings[]>(`SELECT COUNT(*) as n FROM events ${where}`).get(...vals);
  return row?.n ?? 0;
}

function rowToEvent(r: Record<string, unknown>): TelemetryEvent {
  return {
    timestamp: r.timestamp as string,
    level: r.level as TelemetryEvent["level"],
    traceId: (r.trace_id as string) || undefined,
    spanId: (r.span_id as string) || undefined,
    parentSpanId: (r.parent_span_id as string) || null,
    sessionId: (r.session_id as string) || undefined,
    userSessionId: (r.user_session_id as string) || undefined,
    event: r.event as string,
    stream: (r.stream as TelemetryEvent["stream"]) || undefined,
    payload: r.payload ? JSON.parse(r.payload as string) : undefined,
    duration: (r.duration_ms as number) || undefined,
    stack: (r.stack as string) || undefined,
    httpMethod: (r.http_method as string) || undefined,
    httpPath: (r.http_path as string) || undefined,
    httpStatus: (r.http_status as number) || undefined,
    ip: (r.ip as string) || undefined,
    userAgent: (r.user_agent as string) || undefined,
  };
}

export function queryEvents(filters: EventFilters = {}): TelemetryEvent[] {
  if (!db) return [];
  const { where, vals } = buildEventWhere(filters);
  const limit = Math.min(filters.limit ?? 100, 1000);
  const offset = filters.offset ?? 0;
  const order = filters.order === "asc" ? "ASC" : "DESC";
  const rows = db.query<Record<string, unknown>, SQLQueryBindings[]>(
    `SELECT * FROM events ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
  ).all(...vals, limit, offset);
  return rows.map(rowToEvent);
}

export function queryEventsRaw(filters: EventFilters = {}): Record<string, unknown>[] {
  if (!db) return [];
  const { where, vals } = buildEventWhere(filters);
  const limit = Math.min(filters.limit ?? 100, 100_000);
  const offset = filters.offset ?? 0;
  const order = filters.order === "asc" ? "ASC" : "DESC";
  return db.query<Record<string, unknown>, SQLQueryBindings[]>(
    `SELECT * FROM events ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
  ).all(...vals, limit, offset);
}

export interface RequestFilters {
  status?: number[];
  method?: string;
  path?: string;
  traceId?: string;
  model?: string;
  apiKeyId?: number;
  timeFrom?: string;
  timeTo?: string;
  minDuration?: number;
  maxDuration?: number;
  search?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

/** Whether the FTS5 request-body search index is live (see initRequestsFts). */
export function isFtsAvailable(): boolean {
  return ftsAvailable;
}

/**
 * Fault-injection seam for tests: force the FTS-availability flag so the LIKE
 * fallback path can be exercised deterministically on builds that DO ship FTS5.
 * Not part of the runtime contract — never call from production code.
 */
export function setFtsAvailableForTests(available: boolean): void {
  ftsAvailable = available;
}

/**
 * Fault-injection seam for tests: drop `requests_fts` (and its shadow tables,
 * e.g. `requests_fts_docsize`) out from under the live connection, while
 * leaving `ftsAvailable` untouched. Used to simulate either (a) a crash that
 * left the index missing/unpopulated ahead of `reinitFtsForTests()`, or (b) a
 * runtime FTS5 write failure (`no such table`) ahead of insertRequest /
 * updateRequest, to prove the base `requests` write survives independent of
 * the FTS sync (RESIL-001, RESIL-002). Not part of the runtime contract —
 * never call from production code.
 */
export function dropFtsTableForTests(): void {
  db.exec("DROP TABLE IF EXISTS requests_fts");
}

/**
 * Fault-injection seam for tests: re-run the FTS init/reconciliation logic on
 * the CURRENT connection, without recreating the whole database (unlike
 * calling initStorage() again, which would open a brand-new `:memory:`
 * database and lose any seeded rows). Used to simulate "restart after a
 * crash" against data that already exists in `requests` (RESIL-001 /
 * REL-001). Not part of the runtime contract — never call from production
 * code.
 */
export function reinitFtsForTests(): void {
  initRequestsFts();
}

/**
 * Turn a raw user search term into a safe FTS5 MATCH query. The whole term is
 * wrapped as one double-quoted phrase (embedded quotes doubled) so FTS5 reads it
 * as literal text — never as operators, column filters, or the AND/OR/NOT/NEAR
 * keywords — and a trailing `*` makes the final token a prefix match.
 *
 * Behavior note (documented, not silent): this is TOKEN/prefix matching, which
 * differs from the previous `LIKE '%term%'` substring scan — e.g. searching
 * "laude" no longer matches inside "claude". The UI search field is labelled as
 * full-text search to disclose this, and the LIKE scan remains the transparent
 * fallback whenever FTS is unavailable.
 */
export function sanitizeFtsQuery(term: string): string {
  return `"${term.replace(/"/g, '""')}"*`;
}

/**
 * Build the SQL condition + bind values for the body-search filter. Uses an
 * indexed FTS5 MATCH subquery when `useFts` is true (the FTS rowid equals
 * `requests.id` via `content_rowid`), otherwise the original unindexed LIKE
 * substring scan that FTS transparently falls back to.
 */
export function buildRequestSearchClause(
  search: string,
  useFts: boolean
): { cond: string; vals: SQLQueryBindings[] } {
  if (useFts) {
    return {
      cond: "id IN (SELECT rowid FROM requests_fts WHERE requests_fts MATCH ?)",
      vals: [sanitizeFtsQuery(search)],
    };
  }
  return {
    cond: "(request_body LIKE ? OR response_body LIKE ?)",
    vals: [`%${search}%`, `%${search}%`],
  };
}

function buildRequestWhere(
  filters: RequestFilters,
  useFts: boolean = ftsAvailable
): { where: string; vals: SQLQueryBindings[] } {
  const conds: string[] = [];
  const vals: SQLQueryBindings[] = [];
  if (filters.status?.length) { conds.push(`status IN (${filters.status.map(() => "?").join(",")})`); vals.push(...filters.status); }
  if (filters.method) { conds.push("method = ?"); vals.push(filters.method.toUpperCase()); }
  if (filters.path) { conds.push("path = ?"); vals.push(filters.path); }
  if (filters.traceId) { conds.push("trace_id = ?"); vals.push(filters.traceId); }
  if (filters.model) { conds.push("model = ?"); vals.push(filters.model); }
  if (filters.apiKeyId != null) { conds.push("api_key_id = ?"); vals.push(filters.apiKeyId); }
  if (filters.timeFrom) { conds.push("timestamp >= ?"); vals.push(filters.timeFrom); }
  if (filters.timeTo) { conds.push("timestamp <= ?"); vals.push(filters.timeTo); }
  if (filters.minDuration != null) { conds.push("duration_ms >= ?"); vals.push(filters.minDuration); }
  if (filters.maxDuration != null) { conds.push("duration_ms <= ?"); vals.push(filters.maxDuration); }
  if (filters.search) {
    const { cond, vals: searchVals } = buildRequestSearchClause(filters.search, useFts);
    conds.push(cond);
    vals.push(...searchVals);
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", vals };
}

/**
 * Run a request query using the indexed FTS search path, transparently retrying
 * with the LIKE substring scan if an FTS MATCH throws at runtime (design: "LIKE
 * fallback on missing index / MATCH throw"). When there is no search term, or
 * FTS is unavailable, the LIKE path is used directly with no retry cost.
 */
function withRequestSearch<T>(filters: RequestFilters, run: (useFts: boolean) => T): T {
  const useFts = ftsAvailable && filters.search != null && filters.search !== "";
  if (!useFts) return run(false);
  try {
    return run(true);
  } catch (err) {
    emit("warn", "storage.requestSearch.ftsFallback", {
      search: filters.search,
      error: (err as Error).message,
    });
    return run(false);
  }
}

export function countRequests(filters: RequestFilters = {}): number {
  if (!db) return 0;
  return withRequestSearch(filters, (useFts) => {
    const { where, vals } = buildRequestWhere(filters, useFts);
    const row = db.query<{ n: number }, SQLQueryBindings[]>(`SELECT COUNT(*) as n FROM requests ${where}`).get(...vals);
    return row?.n ?? 0;
  });
}

export function queryRequests(filters: RequestFilters = {}): RequestRecord[] {
  if (!db) return [];
  return withRequestSearch(filters, (useFts) => {
    const { where, vals } = buildRequestWhere(filters, useFts);
    const limit = Math.min(filters.limit ?? 100, 1000);
    const offset = filters.offset ?? 0;
    const order = filters.order === "asc" ? "ASC" : "DESC";
    return db.query<RequestRecord, SQLQueryBindings[]>(
      `SELECT * FROM requests ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
    ).all(...vals, limit, offset);
  });
}

export function queryRequestsRaw(filters: RequestFilters = {}): RequestRecord[] {
  if (!db) return [];
  return withRequestSearch(filters, (useFts) => {
    const { where, vals } = buildRequestWhere(filters, useFts);
    const limit = Math.min(filters.limit ?? 100, 100_000);
    const offset = filters.offset ?? 0;
    const order = filters.order === "asc" ? "ASC" : "DESC";
    return db.query<RequestRecord, SQLQueryBindings[]>(
      `SELECT * FROM requests ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
    ).all(...vals, limit, offset);
  });
}

export function getRequestByTrace(traceId: string): RequestRecord | null {
  if (!db) return null;
  return db.query<RequestRecord, [string]>("SELECT * FROM requests WHERE trace_id = ?").get(traceId) ?? null;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * Persist a new API key row. Only the digest (`key_hash`) is stored — the
 * plaintext secret is never written. Returns the generated `id`.
 *
 * Unlike the telemetry inserts, this does NOT swallow errors: a duplicate
 * `key_hash` (UNIQUE) or other failure must surface to the issuing CLI.
 */
export function insertApiKey(rec: ApiKeyRecord): number {
  if (!db) return 0;
  // `is_admin` is bound explicitly (no `?? 0` fallback): callers MUST declare a
  // key's privilege — a security-relevant field is never silently defaulted here.
  const res = db.prepare<void, [string, string, string, string, string | null, number]>(`
    INSERT INTO api_keys (prefix, key_hash, label, created_at, revoked_at, is_admin)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(rec.prefix, rec.key_hash, rec.label, rec.created_at, rec.revoked_at ?? null, rec.is_admin);
  return Number(res.lastInsertRowid);
}

/**
 * Look up an ACTIVE key by its digest. Returns the row only when the hash
 * matches and the key is not revoked (`revoked_at IS NULL`); otherwise null.
 */
export function getApiKeyByHash(hash: string): ApiKeyRecord | null {
  if (!db) return null;
  return db.query<ApiKeyRecord, [string]>(
    "SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL"
  ).get(hash) ?? null;
}

/**
 * List all keys as metadata only, newest first. SELECTs an explicit column
 * allowlist — NEVER `SELECT *` — so `key_hash` (or any future secret column)
 * is structurally impossible to leak through this path. `is_admin` is on the
 * allowlist (not a secret; the admin UI flags master keys with it). Returns
 * both active and revoked keys (the admin UI shows `revoked_at`); `[]` before init.
 */
export function listApiKeys(): ApiKeyMeta[] {
  if (!db) return [];
  // `last_used_at` is an UNWINDOWED correlated MAX(timestamp) over `requests`
  // attributed to this key (`api_key_id = api_keys.id`, index-backed by
  // `idx_requests_api_key`). It is deliberately NOT derived from the 30-day
  // `getUsageByApiKey()` window: a key idle > 30 days must still report its real
  // last-used timestamp, never a false `null`. `MAX(...)` over zero matching
  // rows yields SQL NULL → JS `null` (never used).
  return db.query<ApiKeyMeta, []>(
    `SELECT id, prefix, label, created_at, revoked_at, is_admin, rotated_at,
            (SELECT MAX(timestamp) FROM requests WHERE api_key_id = api_keys.id) AS last_used_at
     FROM api_keys ORDER BY created_at DESC`
  ).all();
}

/**
 * Idempotent soft-revoke: stamp `revoked_at` on an ACTIVE key. Returns `true`
 * iff a row transitioned active→revoked (the `revoked_at IS NULL` guard makes
 * the UPDATE affect exactly the still-active row). A second revoke, or an
 * unknown id, changes nothing and returns `false` — a successful no-op, not an
 * error (spec: revoke is idempotent). A revoked key immediately fails
 * `getApiKeyByHash`'s active-only lookup.
 */
export function revokeApiKey(id: number): boolean {
  if (!db) return false;
  const res = db.prepare<void, [string, number]>(
    `UPDATE api_keys SET revoked_at = ?
     WHERE id = ? AND revoked_at IS NULL`
  ).run(new Date().toISOString(), id);
  return res.changes > 0;
}

/**
 * Rename an ACTIVE key's human-facing `label`. Updates ONLY the `label` column
 * and never touches `key_hash`, `prefix`, `is_admin`, `created_at`, or
 * `revoked_at`. Scoped to `revoked_at IS NULL` so a revoked key — a terminal
 * audit artifact — can never be renamed (mirrors revoke's active-only
 * semantics). Returns `true` iff a row changed; `false` for a revoked or
 * nonexistent id (the route maps `false` to 409/404 via a preliminary lookup).
 */
export function updateApiKeyLabel(id: number, label: string): boolean {
  if (!db) return false;
  const res = db.prepare<void, [string, number]>(
    `UPDATE api_keys SET label = ?
     WHERE id = ? AND revoked_at IS NULL`
  ).run(label, id);
  return res.changes > 0;
}

/**
 * In-place secret swap on an ACTIVE key: atomically replaces `prefix` +
 * `key_hash` and stamps `rotated_at`, but never touches `id`, `label`,
 * `created_at`, or `is_admin` — the SAME row keeps its `requests.api_key_id`
 * attribution history and privilege level (mirrors `updateApiKeyLabel`'s
 * active-only scoping and column discipline). `is_admin` is deliberately NOT
 * in the SET clause: it is structurally impossible for a rotation to change a
 * key's privilege.
 *
 * Unlike the telemetry inserts, this does NOT swallow errors: a `key_hash`
 * UNIQUE collision (astronomically unlikely with 256-bit entropy, but a
 * defense-in-depth guard) must surface to the caller rather than being
 * silently absorbed — the atomic UPDATE leaves the original row untouched on
 * failure (mirrors `insertApiKey`'s no-swallow discipline).
 *
 * Returns `true` iff a row changed; `false` for a revoked or nonexistent id
 * (the route maps `false` to 409/404 via a preliminary lookup, identical to
 * `updateApiKeyLabel`).
 */
export function rotateApiKey(id: number, prefix: string, keyHash: string, rotatedAt: string): boolean {
  if (!db) return false;
  const res = db.prepare<void, [string, string, string, number]>(
    `UPDATE api_keys SET prefix = ?, key_hash = ?, rotated_at = ?
     WHERE id = ? AND revoked_at IS NULL`
  ).run(prefix, keyHash, rotatedAt, id);
  return res.changes > 0;
}

export interface UsageFilters {
  timeFrom?: string;
  timeTo?: string;
}

/**
 * Default lookback window `getUsageByApiKey()` applies when the caller supplies
 * no `timeFrom`. This is a storage-layer chokepoint: the /api/telemetry/usage
 * route is polled roughly every 15s by the keys dashboard with no window, so
 * without this bound every poll would aggregate the ENTIRE `requests` history.
 * 30 days matches a typical usage/billing period while keeping the scan bounded.
 *
 * The default only fills in for an ABSENT lower bound — a caller can widen or
 * narrow the window with an explicit `timeFrom` (e.g. `"1970-01-01T00:00:00Z"`
 * for full history).
 */
export const DEFAULT_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Resolve the effective `timeFrom` a {@link getUsageByApiKey} call will apply:
 * the caller-supplied value verbatim, or the `DEFAULT_USAGE_WINDOW_MS`
 * lookback boundary when omitted. Exported so callers outside this module
 * (the `/api/telemetry/usage` route's DTO) can report the ACTUAL window that
 * was applied instead of masking a silently-imposed default behind `null`
 * (REL-001) — without duplicating the default-window arithmetic.
 */
export function resolveUsageTimeFrom(timeFrom?: string): string {
  return timeFrom ?? new Date(Date.now() - DEFAULT_USAGE_WINDOW_MS).toISOString();
}

/**
 * Aggregate per-key usage from the `requests` table: request count and summed
 * token columns grouped by `api_key_id`, joined to `api_keys` for prefix/label.
 * Only attributed rows (`api_key_id IS NOT NULL`) are included. An optional
 * `timeFrom`/`timeTo` window bounds the rows; when `timeFrom` is omitted the
 * storage layer enforces `DEFAULT_USAGE_WINDOW_MS` so aggregation never scans
 * the full history. Mirrors the `getMetrics()` `SUM(...)` idiom; returns `[]`
 * (not an error) when nothing matches.
 *
 * The `requests` table is a FULL audit log: `withObservability` inserts a row
 * for EVERY call to a gated route, including zero-token admin traffic like
 * `GET/POST /api/keys` (list, create, rename, revoke, rotate) — those rows
 * never reach an upstream model call, so `input_tokens` stays SQL NULL. This
 * aggregate deliberately narrows to `r.input_tokens IS NOT NULL` (only rows
 * that actually recorded token usage — currently `/v1/chat/completions` and
 * `/v1/completions`) so the dashboard's "requests" count and token sums
 * reflect real inference cost, not dashboard/admin traffic. This condition is
 * path-agnostic: it automatically covers any future token-consuming endpoint
 * without a hardcoded route allowlist.
 */
export function getUsageByApiKey(filters: UsageFilters = {}): UsageByKey[] {
  if (!db) return [];
  // Chokepoint: an absent lower bound defaults to a bounded lookback window
  // rather than the full `requests` history.
  const timeFrom = resolveUsageTimeFrom(filters.timeFrom);
  const conds: string[] = ["r.api_key_id IS NOT NULL", "r.input_tokens IS NOT NULL", "r.timestamp >= ?"];
  const vals: SQLQueryBindings[] = [timeFrom];
  if (filters.timeTo) { conds.push("r.timestamp <= ?"); vals.push(filters.timeTo); }
  const where = `WHERE ${conds.join(" AND ")}`;
  return db.query<UsageByKey, SQLQueryBindings[]>(`
    SELECT
      r.api_key_id AS api_key_id,
      k.prefix AS prefix,
      k.label AS label,
      COUNT(*) AS requests,
      COALESCE(SUM(r.input_tokens), 0) AS tokens_in,
      COALESCE(SUM(r.output_tokens), 0) AS tokens_out,
      COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(r.cache_creation_tokens), 0) AS cache_creation_tokens
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.api_key_id
    ${where}
    GROUP BY r.api_key_id
    ORDER BY r.api_key_id
  `).all(...vals);
}

export interface Metrics {
  eventsPerMin: number;
  activeErrors: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  requestsTotal: number;
  requestsByStatus: Record<number, number>;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  errorsByRoute: Record<string, number>;
}

/**
 * Upper bound on the latency sample `getMetrics()` sorts for percentile
 * computation. Instead of scanning every `duration_ms` row in the window
 * (unbounded memory + sort cost under load), we take the most-recent
 * SAMPLE_CAP rows (`ORDER BY timestamp DESC LIMIT SAMPLE_CAP`) and compute
 * p50/p95/p99 over that sample in JS.
 *
 * Tolerance / approximation: when the window holds MORE than SAMPLE_CAP
 * requests, the reported percentiles describe the most-recent SAMPLE_CAP
 * requests (a recency-biased sample), not the entire window — a burst of old
 * outliers no longer skews the tail. When the window holds SAMPLE_CAP or fewer
 * requests, the result is EXACT (identical to the prior unbounded scan). A
 * deterministic recency cap (NOT reservoir sampling) is used on purpose so the
 * values are reproducible and tests never depend on an RNG seed.
 */
export const SAMPLE_CAP = 10_000;

export function getMetrics(windowMs: number = 60_000): Metrics {
  if (!db) return {
    eventsPerMin: 0, activeErrors: 0, latencyP50: 0, latencyP95: 0, latencyP99: 0,
    requestsTotal: 0, requestsByStatus: {}, tokensIn: 0, tokensOut: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, errorsByRoute: {},
  };
  const since = new Date(Date.now() - windowMs).toISOString();
  const evRow = db.query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM events WHERE timestamp >= ?").get(since);
  const errRow = db.query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM events WHERE level IN ('error','fatal') AND timestamp >= ?").get(since);
  const latRows = db.query<{ duration_ms: number }, [string, number]>(
    "SELECT duration_ms FROM requests WHERE timestamp >= ? AND duration_ms IS NOT NULL ORDER BY timestamp DESC LIMIT ?"
  ).all(since, SAMPLE_CAP);
  const totRow = db.query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM requests WHERE timestamp >= ?").get(since);
  const statusRows = db.query<{ status: number; n: number }, [string]>(
    "SELECT status, COUNT(*) as n FROM requests WHERE timestamp >= ? GROUP BY status"
  ).all(since);
  const tokenRow = db.query<{ ti: number; tout: number; cr: number; cc: number }, [string]>(
    "SELECT SUM(input_tokens) as ti, SUM(output_tokens) as tout, SUM(cache_read_tokens) as cr, SUM(cache_creation_tokens) as cc FROM requests WHERE timestamp >= ?"
  ).get(since);
  const errByRoute = db.query<{ path: string; n: number }, [string]>(
    "SELECT path, COUNT(*) as n FROM requests WHERE timestamp >= ? AND status >= 500 GROUP BY path"
  ).all(since);

  // The capped sample comes back ordered by recency (timestamp DESC); sort it
  // ascending by duration so the nearest-rank percentile index is meaningful.
  const durations = latRows.map((r) => r.duration_ms).sort((a, b) => a - b);
  const p = (pct: number): number =>
    durations.length ? (durations[Math.floor(durations.length * pct / 100)] ?? 0) : 0;
  const byStatus: Record<number, number> = {};
  for (const r of statusRows) byStatus[r.status] = r.n;
  const byRoute: Record<string, number> = {};
  for (const r of errByRoute) if (r.path) byRoute[r.path] = r.n;

  return {
    eventsPerMin: Math.round((evRow?.n ?? 0) / (windowMs / 60_000)),
    activeErrors: errRow?.n ?? 0,
    latencyP50: p(50),
    latencyP95: p(95),
    latencyP99: p(99),
    requestsTotal: totRow?.n ?? 0,
    requestsByStatus: byStatus,
    tokensIn: tokenRow?.ti ?? 0,
    tokensOut: tokenRow?.tout ?? 0,
    cacheReadTokens: tokenRow?.cr ?? 0,
    cacheCreationTokens: tokenRow?.cc ?? 0,
    errorsByRoute: byRoute,
  };
}
