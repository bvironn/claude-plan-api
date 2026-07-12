import { describe, it, expect, beforeEach } from "bun:test";
import { initStorage, insertRequest } from "../src/observability/storage.ts";
import { handleTelemetryRequests, handleTelemetryRequestById } from "../src/http/routes/telemetry/requests.ts";

/**
 * Slim default list projection (spec `telemetry-list-projection`, tasks 1.4/1.9).
 * By default `/api/telemetry/requests` omits the three body fields and adds a
 * server-derived `firstUserPreview`; `?bodies=full` opts back into the full
 * bodies. The by-id transcript endpoint is ALWAYS full.
 *
 * Each test runs against an isolated in-memory DB (design comment in
 * storage.ts: pass ":memory:" for deterministic, isolated tests).
 */

const CHAT_BODY = JSON.stringify({
  model: "claude-x",
  messages: [{ role: "user", content: "What is a monad?" }],
});

beforeEach(() => {
  initStorage(":memory:");
  insertRequest({
    trace_id: "t-slim-1",
    timestamp: "2026-01-01T00:00:00Z",
    method: "POST",
    path: "/v1/chat/completions",
    status: 200,
    duration_ms: 42,
    model: "claude-x",
    input_tokens: 10,
    output_tokens: 20,
    request_body: CHAT_BODY,
    response_body: JSON.stringify({ choices: [{ message: { content: "an endofunctor" } }] }),
    upstream_request_body: CHAT_BODY,
  });
});

async function firstRecord(url: string): Promise<Record<string, unknown>> {
  const res = await handleTelemetryRequests(new Request(url));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { requests: Array<Record<string, unknown>> };
  const rec = body.requests.find((r) => r.traceId === "t-slim-1");
  expect(rec).toBeDefined();
  return rec!;
}

describe("telemetry/requests — slim default projection", () => {
  it("omits the three body fields but keeps all metadata + firstUserPreview", async () => {
    const rec = await firstRecord("http://localhost/api/telemetry/requests");

    // Body fields are structurally ABSENT (not just null).
    expect("requestBody" in rec).toBe(false);
    expect("responseBody" in rec).toBe(false);
    expect("upstreamRequestBody" in rec).toBe(false);

    // Metadata is unchanged.
    expect(rec.traceId).toBe("t-slim-1");
    expect(rec.status).toBe(200);
    expect(rec.model).toBe("claude-x");
    expect(rec.duration).toBe(42);
    expect(rec.inputTokens).toBe(10);
    expect(rec.outputTokens).toBe(20);
    expect(rec.totalTokens).toBe(30);

    // Server-derived preview replaces the body as the grouping input.
    expect(rec.firstUserPreview).toBe("What is a monad?");
  });
});

describe("telemetry/requests — ?bodies=full opt-in", () => {
  it("includes the three body fields AND firstUserPreview", async () => {
    const rec = await firstRecord("http://localhost/api/telemetry/requests?bodies=full");

    expect(typeof rec.requestBody).toBe("string");
    expect(typeof rec.responseBody).toBe("string");
    expect(typeof rec.upstreamRequestBody).toBe("string");
    expect(JSON.parse(rec.requestBody as string)).toEqual(JSON.parse(CHAT_BODY));

    // Full shape is a byte-superset: it still carries the preview.
    expect(rec.firstUserPreview).toBe("What is a monad?");
  });

  it("treats any other bodies value as slim (only bodies=full opts in)", async () => {
    const rec = await firstRecord("http://localhost/api/telemetry/requests?bodies=1");
    expect("requestBody" in rec).toBe(false);
    expect(rec.firstUserPreview).toBe("What is a monad?");
  });
});

describe("telemetry/requests/:traceId — transcript endpoint stays full", () => {
  it("always returns the full bodies regardless of the slim list default", async () => {
    const res = await handleTelemetryRequestById(
      new Request("http://localhost/api/telemetry/requests/t-slim-1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { request: Record<string, unknown> };
    expect(typeof body.request.requestBody).toBe("string");
    expect(typeof body.request.upstreamRequestBody).toBe("string");
    expect(typeof body.request.responseBody).toBe("string");
    expect(body.request.firstUserPreview).toBe("What is a monad?");
  });
});
