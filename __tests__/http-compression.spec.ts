import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { maybeCompress } from "../src/http/compression.ts";
import { handleRequest } from "../src/http/server.ts";
import * as storage from "../src/observability/storage.ts";

/**
 * Unit + dispatch-integration coverage for the response-compression gate
 * (design decision #1, spec `http-compression`). The gate is a single tail
 * `maybeCompress(req, res)` in `handleRequest`:
 *   - negotiates br → gzip → identity from `Accept-Encoding`
 *   - compresses only allowlisted, buffered, not-yet-encoded bodies
 *   - sets `Content-Encoding` + `Vary: Accept-Encoding`
 *   - excludes SSE (`text/event-stream`), downloads/exports (`Content-Disposition`),
 *     CSV, and already-compressed responses
 *   - runs AFTER `enforceApiKey`, so it can never bypass auth
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(payload: unknown): Response {
  // A normal buffered API JSON response (what routes return).
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}

function reqWith(acceptEncoding?: string): Request {
  const headers: Record<string, string> = {};
  if (acceptEncoding !== undefined) headers["Accept-Encoding"] = acceptEncoding;
  return new Request("http://localhost/api/telemetry/requests", { headers });
}

async function bodyBytes(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Negotiation + round-trip fidelity (task 1.8)
// ---------------------------------------------------------------------------

describe("maybeCompress — content negotiation", () => {
  it("br negotiated for JSON: sets Content-Encoding: br + Vary, decodes byte-identical", async () => {
    const payload = { message: "hello world", nums: [1, 2, 3, 4, 5], nested: { a: true } };
    const original = new Uint8Array(await jsonResponse(payload).arrayBuffer());

    const out = await maybeCompress(reqWith("br, gzip"), jsonResponse(payload));

    expect(out.headers.get("Content-Encoding")).toBe("br");
    expect(out.headers.get("Vary")).toBe("Accept-Encoding");
    const decoded = new Uint8Array(brotliDecompressSync(await bodyBytes(out)));
    expect(Buffer.from(decoded).equals(Buffer.from(original))).toBe(true);
    // And the decoded JSON parses back to the exact payload.
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual(payload);
  });

  it("gzip chosen when the client offers gzip but not br: decodes byte-identical", async () => {
    const payload = { only: "gzip here", list: ["x", "y", "z"] };
    const original = new Uint8Array(await jsonResponse(payload).arrayBuffer());

    const out = await maybeCompress(reqWith("gzip, deflate"), jsonResponse(payload));

    expect(out.headers.get("Content-Encoding")).toBe("gzip");
    expect(out.headers.get("Vary")).toBe("Accept-Encoding");
    const decoded = new Uint8Array(gunzipSync(await bodyBytes(out)));
    expect(Buffer.from(decoded).equals(Buffer.from(original))).toBe(true);
  });

  it("prefers br over gzip when both are offered", async () => {
    const out = await maybeCompress(reqWith("gzip, br"), jsonResponse({ pick: "br" }));
    expect(out.headers.get("Content-Encoding")).toBe("br");
  });

  it("identity when no supported encoding is offered: no Content-Encoding, Vary still set, body unchanged", async () => {
    const payload = { untouched: true, big: "x".repeat(100) };
    const original = new Uint8Array(await jsonResponse(payload).arrayBuffer());

    const out = await maybeCompress(reqWith("deflate"), jsonResponse(payload));

    expect(out.headers.get("Content-Encoding")).toBeNull();
    // Vary is still required so shared caches key on Accept-Encoding.
    expect(out.headers.get("Vary")).toBe("Accept-Encoding");
    expect(Buffer.from(await bodyBytes(out)).equals(Buffer.from(original))).toBe(true);
  });

  it("identity when Accept-Encoding is absent entirely", async () => {
    const out = await maybeCompress(reqWith(undefined), jsonResponse({ a: 1 }));
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(out.headers.get("Vary")).toBe("Accept-Encoding");
  });

  it("compresses a large payload smaller than the original (real compression happened)", async () => {
    const payload = { blob: "the quick brown fox ".repeat(500) };
    const original = new Uint8Array(await jsonResponse(payload).arrayBuffer());

    const out = await maybeCompress(reqWith("br"), jsonResponse(payload));
    const compressed = await bodyBytes(out);

    expect(out.headers.get("Content-Encoding")).toBe("br");
    expect(compressed.length).toBeLessThan(original.length);
    const decoded = new Uint8Array(brotliDecompressSync(compressed));
    expect(Buffer.from(decoded).equals(Buffer.from(original))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exclusions (task 1.8 + 1.12)
// ---------------------------------------------------------------------------

describe("maybeCompress — exclusions", () => {
  it("does NOT double-compress a response that already has Content-Encoding", async () => {
    const pre = new Response("already-encoded-bytes", {
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    });
    const out = await maybeCompress(reqWith("br"), pre);
    // Returned untouched — still gzip, never re-wrapped to br.
    expect(out).toBe(pre);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
  });

  it("excludes SSE (text/event-stream) and passes the stream through untouched", async () => {
    const sse = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(": connected\n\n"));
          c.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );

    const out = await maybeCompress(reqWith("br"), sse);

    // Same object reference → the live stream was never buffered or re-wrapped.
    expect(out).toBe(sse);
    expect(out.headers.get("Content-Encoding")).toBeNull();
    // SSE is never negotiable, so no Vary is added.
    expect(out.headers.get("Vary")).toBeNull();
    // Framing preserved end-to-end.
    expect(await out.text()).toBe(": connected\n\n");
  });

  it("excludes streaming JSON export (Content-Disposition attachment) without buffering the stream", async () => {
    const exportRes = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("[\n{}\n]"));
          c.close();
        },
      }),
      {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="telemetry.json"',
        },
      },
    );

    const out = await maybeCompress(reqWith("br"), exportRes);

    // Attachment/download → excluded by nature (streamed, must stay unbuffered).
    expect(out).toBe(exportRes);
    expect(out.headers.get("Content-Encoding")).toBeNull();
    expect(await out.text()).toBe("[\n{}\n]");
  });

  it("excludes CSV export (text/csv not allowlisted)", async () => {
    const csv = new Response("a,b\n1,2\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="t.csv"',
      },
    });
    const out = await maybeCompress(reqWith("br, gzip"), csv);
    expect(out.headers.get("Content-Encoding")).toBeNull();
  });

  it("excludes already-compressed binary content types (image/png)", async () => {
    const png = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { "Content-Type": "image/png" },
    });
    const out = await maybeCompress(reqWith("br, gzip"), png);
    expect(out.headers.get("Content-Encoding")).toBeNull();
  });

  it("compresses allowlisted static text types (text/html)", async () => {
    const html = new Response("<!doctype html><title>hi</title>".repeat(20), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const out = await maybeCompress(reqWith("gzip"), html);
    expect(out.headers.get("Content-Encoding")).toBe("gzip");
  });
});

// ---------------------------------------------------------------------------
// Dispatch integration — tail gate wired into handleRequest
// ---------------------------------------------------------------------------

const savedRequire = Bun.env.REQUIRE_API_KEY;
const savedPepper = Bun.env.API_KEY_PEPPER;
let spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
  if (savedRequire === undefined) delete Bun.env.REQUIRE_API_KEY;
  else Bun.env.REQUIRE_API_KEY = savedRequire;
  if (savedPepper === undefined) delete Bun.env.API_KEY_PEPPER;
  else Bun.env.API_KEY_PEPPER = savedPepper;
});

function push<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

describe("handleRequest — compression is wired as the response tail gate", () => {
  it("compresses GET /health JSON when the client sends Accept-Encoding: br", async () => {
    delete Bun.env.REQUIRE_API_KEY; // /health is ungated regardless, keep enforcement off
    const res = await handleRequest(
      new Request("http://localhost/health", { headers: { "Accept-Encoding": "br" } }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("br");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    const decoded = brotliDecompressSync(new Uint8Array(await res.arrayBuffer()));
    expect(JSON.parse(new TextDecoder().decode(decoded))).toEqual({ status: "ok" });
  });

  it("auth precedes compression: a gated route with NO key returns 401 uncompressed, even with Accept-Encoding: br (task 1.11)", async () => {
    Bun.env.REQUIRE_API_KEY = "true";
    Bun.env.API_KEY_PEPPER = "test-pepper";
    push(spyOn(storage, "getApiKeyByHash").mockReturnValue(null));

    const res = await handleRequest(
      new Request("http://localhost/api/telemetry/metrics", {
        headers: { "Accept-Encoding": "br, gzip" },
      }),
    );

    // The enforceApiKey gate short-circuits BEFORE dispatch + the tail gate:
    // the 401 body is returned directly, never compressed.
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(401);
  });

  it("SSE endpoint stays uncompressed and unbuffered through the server (task 1.12)", async () => {
    delete Bun.env.REQUIRE_API_KEY; // enforcement off → dispatch reaches the SSE handler
    const res = await handleRequest(
      new Request("http://localhost/api/telemetry/stream", {
        headers: { "Accept-Encoding": "br, gzip" },
      }),
    );

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Content-Encoding")).toBeNull();
    // The body is still a live stream whose framing is intact.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const firstChunk = new TextDecoder().decode(value);
    expect(firstChunk).toContain(": connected");
    await reader.cancel();
  });
});
