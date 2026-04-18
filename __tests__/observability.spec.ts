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


