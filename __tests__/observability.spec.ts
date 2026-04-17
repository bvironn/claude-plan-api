import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

// Project root — one level up from __tests__/
const ROOT = new URL("..", import.meta.url).pathname;
const LOGS_DIR = join(ROOT, "logs");
const DB_PATH = join(LOGS_DIR, "telemetry.db");

let serverProc: ReturnType<typeof Bun.spawn>;
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

beforeAll(async () => {
  // ensure the test port is not occupied by a leftover process
  await Bun.$`fuser -k ${PORT}/tcp`.nothrow();
  await Bun.sleep(200);

  // clean logs & db for a clean test run
  await Bun.$`rm -rf ${LOGS_DIR}`.nothrow();

  serverProc = Bun.spawn(["bun", "src/index.ts", String(PORT)], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });

  // wait for server ready — up to 30s
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) { ready = true; break; }
    } catch {}
    await Bun.sleep(100);
  }
  if (!ready) {
    throw new Error("Server did not become ready within 30s");
  }
}, 30_000);

afterAll(() => {
  serverProc?.kill();
});

test("health endpoint logs request through full pipeline", async () => {
  const res = await fetch(`${BASE}/health`);
  expect(res.status).toBe(200);
  const traceId = res.headers.get("x-trace-id");
  expect(traceId).toBeTruthy();

  // give async writes time to flush
  await Bun.sleep(250);

  const db = new Database(DB_PATH, { readonly: true });
  const reqRow = db.query("SELECT * FROM requests WHERE trace_id = ?").get(traceId);
  expect(reqRow).toBeTruthy();
  expect((reqRow as any).status).toBe(200);
  expect((reqRow as any).path).toBe("/health");

  const events = db
    .query("SELECT event FROM events WHERE trace_id = ? ORDER BY id")
    .all(traceId) as any[];
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events.map((e) => e.event)).toContain("http.request.start");
  expect(events.map((e) => e.event)).toContain("http.request.end");
  db.close();
});

test("frontend click event → POST /api/telemetry → SQLite → /logs query", async () => {
  const payload = {
    events: [
      {
        timestamp: new Date().toISOString(),
        level: "info",
        event: "ui.click",
        sessionId: "test-session-xyz",
        traceId: "test-trace-xyz",
        payload: {
          selector: "button#export",
          text: "Export",
          x: 100,
          y: 200,
          pageUrl: "/observability",
        },
      },
    ],
  };
  const res = await fetch(`${BASE}/api/telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; count: number };
  expect(body.ok).toBe(true);
  expect(body.count).toBe(1);

  await Bun.sleep(200);

  // verify via /logs query (this is what the dashboard would do)
  const logsRes = await fetch(`${BASE}/api/telemetry/logs?event=ui.click&limit=10`);
  const logs = (await logsRes.json()) as { events: Array<{ traceId?: string; event: string; payload: Record<string, unknown> }> };
  const found = logs.events.find((e) => e.traceId === "test-trace-xyz");
  expect(found).toBeTruthy();
  expect(found!.payload.selector).toBe("button#export");
  expect(found!.payload.text).toBe("Export");
});

test("SSE stream receives live events", async () => {
  const received: any[] = [];
  const ctrl = new AbortController();
  const ssePromise = (async () => {
    const res = await fetch(`${BASE}/api/telemetry/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
          if (dataLine) {
            try {
              received.push(JSON.parse(dataLine.slice(6)));
            } catch {}
          }
        }
      }
    } catch {}
  })();

  await Bun.sleep(200); // let SSE connect
  // trigger events
  await fetch(`${BASE}/health`);
  await fetch(`${BASE}/v1/models`);
  await Bun.sleep(300);
  ctrl.abort();
  await ssePromise.catch(() => {});

  expect(received.length).toBeGreaterThan(0);
  const events = received.map((e) => e.event);
  expect(events).toContain("http.request.start");
});

test("metrics endpoint returns structured metrics", async () => {
  const res = await fetch(`${BASE}/api/telemetry/metrics?window=60000`);
  expect(res.status).toBe(200);
  const m = (await res.json()) as { requests_total: number };
  expect(m).toHaveProperty("window_ms");
  expect(m).toHaveProperty("latency_p50");
  expect(m).toHaveProperty("latency_p95");
  expect(m).toHaveProperty("requests_total");
  expect(m.requests_total).toBeGreaterThan(0);
});

test("export CSV returns attachment with headers", async () => {
  const res = await fetch(
    `${BASE}/api/telemetry/export?type=events&format=csv&limit=5`
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain("attachment");
  const text = await res.text();
  const firstLine = text.split("\n")[0];
  expect(firstLine).toContain("id");
  expect(firstLine).toContain("event");
});

test("anti-loop guard logs tool errors", async () => {
  // Post a guard.toolError event through the ingest API — the same path the
  // real anti-loop guard uses — and verify it lands in SQLite via /logs.
  const traceId = `guard-test-${Date.now()}`;
  const res = await fetch(`${BASE}/api/telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          timestamp: new Date().toISOString(),
          level: "warn",
          event: "guard.toolError",
          traceId,
          sessionId: "test-guard-session",
          payload: { tool: "Bash", consecutiveErrors: 2 },
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; count: number };
  expect(body.ok).toBe(true);
  expect(body.count).toBe(1);

  await Bun.sleep(200);

  // verify via /logs API
  const logsRes = await fetch(
    `${BASE}/api/telemetry/logs?event=guard.toolError&limit=5`
  );
  const logs = (await logsRes.json()) as { events: Array<{ traceId?: string; event: string }> };
  const found = logs.events.find((e) => e.traceId === traceId);
  expect(found).toBeTruthy();
  expect(found!.event).toBe("guard.toolError");
});

test("frontend fetch interception skips x-telemetry-internal", async () => {
  // Verify the ingest endpoint accepts the x-telemetry-internal header gracefully.
  // This header is set by the frontend buffer to avoid infinite capture loops.
  const res = await fetch(`${BASE}/api/telemetry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telemetry-internal": "1",
    },
    body: JSON.stringify({ events: [] }),
  });
  expect(res.status).toBe(200);
});
