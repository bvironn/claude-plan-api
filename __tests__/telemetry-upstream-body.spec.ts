import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  initStorage,
  insertRequest,
  updateRequest,
  getRequestByTrace,
  queryRequests,
} from "../src/observability/storage.ts";
import { handleTelemetryRequests } from "../src/http/routes/telemetry/requests.ts";

// Each test runs in an isolated tmp CWD so `initStorage` creates a fresh DB
// under `logs/telemetry.db` without interfering with other test files or
// with the dev/production DB.
let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "claude-plan-api-telem-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Schema / migration
// ---------------------------------------------------------------------------

describe("storage — upstream_request_body column", () => {
  it("REQ-1: fresh DB contains upstream_request_body column after initStorage", () => {
    initStorage();
    const db = new Database(join(tmpDir, "logs/telemetry.db"), { readonly: true });
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(requests)`).all();
    db.close();
    expect(cols.map((c) => c.name)).toContain("upstream_request_body");
  });

  it("REQ-2: ensureColumn migration is idempotent on a pre-existing DB without the column", () => {
    // Build a DB with the PREVIOUS full schema (every column except the new
    // `upstream_request_body`) so the migration has a realistic starting point.
    const logsDir = join(tmpDir, "logs");
    Bun.spawnSync(["mkdir", "-p", logsDir]);
    const dbPath = join(logsDir, "telemetry.db");
    const pre = new Database(dbPath);
    pre.exec(`
      CREATE TABLE events (
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
      CREATE TABLE requests (
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
    `);
    // Seed a row so we can prove it survives the migration.
    pre.exec(`INSERT INTO requests (trace_id, timestamp, request_body) VALUES ('pre-existing-trace', '2026-01-01T00:00:00Z', '{"foo":"bar"}')`);
    pre.close();

    // Run the real init: should ALTER TABLE ADD COLUMN without throwing
    initStorage();

    // Verify the column exists now
    const db = new Database(dbPath, { readonly: true });
    const cols = db.query<{ name: string }, []>(`PRAGMA table_info(requests)`).all();
    expect(cols.map((c) => c.name)).toContain("upstream_request_body");

    // Old row still there, with NULL for the new column
    const row = db.query<{ trace_id: string; upstream_request_body: string | null }, []>(
      `SELECT trace_id, upstream_request_body FROM requests WHERE trace_id = 'pre-existing-trace'`
    ).get();
    expect(row?.trace_id).toBe("pre-existing-trace");
    expect(row?.upstream_request_body).toBeNull();
    db.close();

    // Calling initStorage again must NOT throw (idempotency) — table already has column
    expect(() => initStorage()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Insert / update / query round-trip
// ---------------------------------------------------------------------------

describe("storage — upstream_request_body persistence", () => {
  it("REQ-3: insertRequest stores upstream_request_body verbatim", () => {
    initStorage();
    const upstreamJson = JSON.stringify({
      model: "claude-opus-4-7",
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    });
    insertRequest({
      trace_id: "trace-insert-1",
      timestamp: "2026-04-18T00:00:00Z",
      upstream_request_body: upstreamJson,
    });

    const row = getRequestByTrace("trace-insert-1");
    expect(row).not.toBeNull();
    expect((row as unknown as Record<string, unknown>).upstream_request_body).toBe(upstreamJson);
  });

  it("REQ-4: updateRequest can patch upstream_request_body on an existing row", () => {
    initStorage();
    insertRequest({ trace_id: "trace-update-1", timestamp: "2026-04-18T00:00:00Z" });

    // Initially null
    const before = getRequestByTrace("trace-update-1") as unknown as Record<string, unknown>;
    expect(before.upstream_request_body).toBeNull();

    const upstreamJson = '{"model":"claude-opus-4-7","thinking":{"type":"adaptive"}}';
    updateRequest("trace-update-1", { upstream_request_body: upstreamJson });

    const after = getRequestByTrace("trace-update-1") as unknown as Record<string, unknown>;
    expect(after.upstream_request_body).toBe(upstreamJson);
  });

  it("REQ-5: queryRequests returns upstream_request_body in the result rows", () => {
    initStorage();
    insertRequest({
      trace_id: "trace-query-1",
      timestamp: "2026-04-18T00:00:01Z",
      upstream_request_body: '{"a":1}',
    });
    insertRequest({
      trace_id: "trace-query-2",
      timestamp: "2026-04-18T00:00:02Z",
      // omit upstream_request_body → stays NULL
    });

    const rows = queryRequests({ limit: 100 });
    const byTrace: Record<string, Record<string, unknown>> = {};
    for (const r of rows) byTrace[r.trace_id] = r as unknown as Record<string, unknown>;

    expect(byTrace["trace-query-1"]!.upstream_request_body).toBe('{"a":1}');
    expect(byTrace["trace-query-2"]!.upstream_request_body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API camelCase mapping (thin coverage — the route layer)
// ---------------------------------------------------------------------------

describe("telemetry/requests — toCamel mapping", () => {
  it("REQ-6: the API response surfaces upstream_request_body as upstreamRequestBody", async () => {
    initStorage();
    insertRequest({
      trace_id: "trace-api-1",
      timestamp: "2026-04-18T00:00:00Z",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      upstream_request_body: '{"model":"claude-opus-4-7","thinking":{"type":"adaptive"},"output_config":{"effort":"max"}}',
    });

    // handleTelemetryRequests uses the module-level `db` from storage.ts,
    // which was reset by initStorage() in beforeEach — same DB, same tests.
    const req = new Request("http://localhost/api/telemetry/requests?limit=10");
    const res = await handleTelemetryRequests(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { requests: Array<Record<string, unknown>> };
    const found = body.requests.find((r) => r.traceId === "trace-api-1");
    expect(found).toBeDefined();
    expect(typeof found!.upstreamRequestBody).toBe("string");
    const parsed = JSON.parse(found!.upstreamRequestBody as string);
    expect(parsed.thinking).toEqual({ type: "adaptive" });
    expect(parsed.output_config).toEqual({ effort: "max" });
  });
});
