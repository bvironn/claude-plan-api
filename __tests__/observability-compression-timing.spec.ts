import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { handleRequest } from "../src/http/server.ts";
import * as storage from "../src/observability/storage.ts";

/**
 * Regression coverage for RESIL-002: the compression step introduced by the
 * `http-compression` gate is CPU-bound work on the hot path, but it used to
 * run in `handleRequest` AFTER `withObservability` had already computed and
 * persisted `duration_ms` (compression happened outside the timed window).
 * That made the compression cost invisible to the app's own latency metrics.
 *
 * These tests assert `duration_ms` persisted via `updateRequest` reflects a
 * duration measured AFTER compression completes for observed routes.
 */

const savedRequire = Bun.env.REQUIRE_API_KEY;
let spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
  if (savedRequire === undefined) delete Bun.env.REQUIRE_API_KEY;
  else Bun.env.REQUIRE_API_KEY = savedRequire;
});

function push<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

describe("withObservability — RESIL-002: duration_ms includes compression cost", () => {
  it("persisted duration_ms for a compressed response is at least the artificial compression delay", async () => {
    delete Bun.env.REQUIRE_API_KEY; // /health is ungated regardless

    const ARTIFICIAL_DELAY_MS = 40;
    const originalGzipSync = Bun.gzipSync.bind(Bun);

    push(
      spyOn(Bun, "gzipSync").mockImplementation((...args: Parameters<typeof Bun.gzipSync>) => {
        const start = performance.now();
        while (performance.now() - start < ARTIFICIAL_DELAY_MS) {
          // busy-wait: gzipSync is synchronous, so an async delay wouldn't be
          // observed by a synchronous compression call site.
        }
        return originalGzipSync(...args);
      }),
    );

    let capturedDuration: number | undefined;
    push(
      spyOn(storage, "updateRequest").mockImplementation((traceId: string, patch: Record<string, unknown>) => {
        capturedDuration = patch.duration_ms as number | undefined;
      }),
    );

    const res = await handleRequest(
      new Request("http://localhost/health", { headers: { "Accept-Encoding": "gzip" } }),
    );

    // Sanity: compression actually ran on this response.
    expect(res.headers.get("Content-Encoding")).toBe("gzip");

    expect(capturedDuration).toBeDefined();
    expect(capturedDuration as number).toBeGreaterThanOrEqual(ARTIFICIAL_DELAY_MS);
  });

  it("uncompressed (identity) responses are unaffected — duration_ms still reflects real handler time", async () => {
    delete Bun.env.REQUIRE_API_KEY;

    let capturedDuration: number | undefined;
    push(
      spyOn(storage, "updateRequest").mockImplementation((traceId: string, patch: Record<string, unknown>) => {
        capturedDuration = patch.duration_ms as number | undefined;
      }),
    );

    const res = await handleRequest(
      new Request("http://localhost/health", { headers: { "Accept-Encoding": "deflate" } }),
    );

    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(capturedDuration).toBeDefined();
    expect(capturedDuration as number).toBeGreaterThanOrEqual(0);
  });
});
