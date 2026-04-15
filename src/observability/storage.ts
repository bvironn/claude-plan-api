import { Database } from "bun:sqlite";
import type { TelemetryEvent, RequestRecord } from "./types.ts";
import { mkdirSync } from "node:fs";

let db: Database;

export function initStorage(): void {
  mkdirSync("logs", { recursive: true });
  db = new Database("logs/telemetry.db");
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
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests(timestamp);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
    CREATE INDEX IF NOT EXISTS idx_requests_path ON requests(path);
  `);
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
    number | null, number | null, number | null, string | null, string | null, string | null
  ]>(`
    INSERT OR IGNORE INTO requests
      (trace_id, timestamp, method, path, status, duration_ms, ip, user_agent, model,
       is_stream, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       request_body, response_body, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
  } catch {}
}

export function insertRequest(r: RequestRecord): void {
  if (!db) return;
  try {
    getInsertRequest().run(
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
      r.error ?? null
    );
  } catch {}
}

export function updateRequest(traceId: string, patch: Partial<RequestRecord>): void {
  if (!db) return;
  try {
    const fields = Object.keys(patch).filter((k) => k !== "trace_id");
    if (fields.length === 0) return;
    const set = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => (patch as Record<string, unknown>)[f] ?? null);
    db.prepare(`UPDATE requests SET ${set} WHERE trace_id = ?`).run(...values as never[], traceId);
  } catch {}
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

function buildEventWhere(filters: EventFilters): { where: string; vals: unknown[] } {
  const conds: string[] = [];
  const vals: unknown[] = [];
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
  const row = db.query<{ n: number }, unknown[]>(`SELECT COUNT(*) as n FROM events ${where}`).get(...vals);
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
  const rows = db.query<Record<string, unknown>, unknown[]>(
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
  return db.query<Record<string, unknown>, unknown[]>(
    `SELECT * FROM events ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
  ).all(...vals, limit, offset);
}

export interface RequestFilters {
  status?: number[];
  method?: string;
  path?: string;
  traceId?: string;
  model?: string;
  timeFrom?: string;
  timeTo?: string;
  minDuration?: number;
  maxDuration?: number;
  search?: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

function buildRequestWhere(filters: RequestFilters): { where: string; vals: unknown[] } {
  const conds: string[] = [];
  const vals: unknown[] = [];
  if (filters.status?.length) { conds.push(`status IN (${filters.status.map(() => "?").join(",")})`); vals.push(...filters.status); }
  if (filters.method) { conds.push("method = ?"); vals.push(filters.method.toUpperCase()); }
  if (filters.path) { conds.push("path = ?"); vals.push(filters.path); }
  if (filters.traceId) { conds.push("trace_id = ?"); vals.push(filters.traceId); }
  if (filters.model) { conds.push("model = ?"); vals.push(filters.model); }
  if (filters.timeFrom) { conds.push("timestamp >= ?"); vals.push(filters.timeFrom); }
  if (filters.timeTo) { conds.push("timestamp <= ?"); vals.push(filters.timeTo); }
  if (filters.minDuration != null) { conds.push("duration_ms >= ?"); vals.push(filters.minDuration); }
  if (filters.maxDuration != null) { conds.push("duration_ms <= ?"); vals.push(filters.maxDuration); }
  if (filters.search) { conds.push("(request_body LIKE ? OR response_body LIKE ?)"); vals.push(`%${filters.search}%`, `%${filters.search}%`); }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", vals };
}

export function countRequests(filters: RequestFilters = {}): number {
  if (!db) return 0;
  const { where, vals } = buildRequestWhere(filters);
  const row = db.query<{ n: number }, unknown[]>(`SELECT COUNT(*) as n FROM requests ${where}`).get(...vals);
  return row?.n ?? 0;
}

export function queryRequests(filters: RequestFilters = {}): RequestRecord[] {
  if (!db) return [];
  const { where, vals } = buildRequestWhere(filters);
  const limit = Math.min(filters.limit ?? 100, 1000);
  const offset = filters.offset ?? 0;
  const order = filters.order === "asc" ? "ASC" : "DESC";
  const rows = db.query<RequestRecord, unknown[]>(
    `SELECT * FROM requests ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
  ).all(...vals, limit, offset);
  return rows;
}

export function queryRequestsRaw(filters: RequestFilters = {}): RequestRecord[] {
  if (!db) return [];
  const { where, vals } = buildRequestWhere(filters);
  const limit = Math.min(filters.limit ?? 100, 100_000);
  const offset = filters.offset ?? 0;
  const order = filters.order === "asc" ? "ASC" : "DESC";
  return db.query<RequestRecord, unknown[]>(
    `SELECT * FROM requests ${where} ORDER BY timestamp ${order} LIMIT ? OFFSET ?`
  ).all(...vals, limit, offset);
}

export function getRequestByTrace(traceId: string): RequestRecord | null {
  if (!db) return null;
  return db.query<RequestRecord, [string]>("SELECT * FROM requests WHERE trace_id = ?").get(traceId) ?? null;
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

export function getMetrics(windowMs: number = 60_000): Metrics {
  if (!db) return {
    eventsPerMin: 0, activeErrors: 0, latencyP50: 0, latencyP95: 0, latencyP99: 0,
    requestsTotal: 0, requestsByStatus: {}, tokensIn: 0, tokensOut: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, errorsByRoute: {},
  };
  const since = new Date(Date.now() - windowMs).toISOString();
  const evRow = db.query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM events WHERE timestamp >= ?").get(since);
  const errRow = db.query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM events WHERE level IN ('error','fatal') AND timestamp >= ?").get(since);
  const latRows = db.query<{ duration_ms: number }, [string]>(
    "SELECT duration_ms FROM requests WHERE timestamp >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms"
  ).all(since);
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

  const durations = latRows.map((r) => r.duration_ms);
  const p = (pct: number) => durations.length ? durations[Math.floor(durations.length * pct / 100)] : 0;
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
